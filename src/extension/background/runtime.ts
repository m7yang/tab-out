import { Effect, Layer, ManagedRuntime } from 'effect'

import { BrowserTabs } from '../browser-tabs-service.js'
import { createDashboardRetainedPagesWireEncodeCache } from '../dashboard-retained-pages-wire.js'
import {
  OPEN_SURFACE_DURABLE_STORAGE_KEY,
  OPEN_SURFACE_SESSION_STORAGE_KEY,
  OpenSurfaceInventoryStorage
} from '../open-surface-inventory-storage.js'
import {
  RETAINED_PAGES_STORAGE_KEY,
  RetainedPageLedgerStorage,
  createRetainedPageLedgerStorageDecodeCache,
  encodeRetainedPageLedgerStorageValue
} from '../retained-pages-storage.js'
import {
  RETENTION_HEALTH_STORAGE_KEY,
  RetentionHealth
} from '../retention-health.js'
import { Badge } from './badge.js'
import type { ChromeApi } from './chrome-api.js'
import {
  readChromeStorageValue,
  removeChromeStorageValue,
  writeChromeStorageValue
} from './chrome-storage.js'
import { NativePlacementBridge } from './native-placement-bridge.js'
import { recoverRetainedPageSnapshot } from './retained-page-recovery.js'
import { RetainedPages } from './retained-pages-service.js'
import { StartupSnapshot } from './startup-snapshot-service.js'
import { TabHistory } from './tab-history-service.js'
import { WorkingSet } from './working-set-service.js'

const dashboardRetainedPagesWireCache =
  createDashboardRetainedPagesWireEncodeCache()

export const captureDashboardServiceStateEffect = Effect.gen(function*() {
  const workingSet = yield* WorkingSet
  const retainedPagesService = yield* RetainedPages
  const retentionHealthService = yield* RetentionHealth
  const tabHistoryService = yield* TabHistory
  const [workingSetActivity, retainedPageLedger] = yield* Effect.all([
    workingSet.getWorkingSetActivity(),
    retainedPagesService.getLedger()
  ] as const, { concurrency: 'unbounded' })
  // Ledger restore/pruning may update the session-only health episode. Read it
  // afterward so this same Startup Frame reports the resulting truth.
  const retainedPages = Object.values(retainedPageLedger.pages)
  const [retainedPagesWire, retentionHealth, { tabHistory, openTabsSnapshot }] =
    yield* Effect.all([
      Effect.tryPromise({
        try: () => dashboardRetainedPagesWireCache.encode(retainedPages),
        catch: (cause) => cause
      }),
      retentionHealthService.getEpisode(),
      tabHistoryService.getTabHistorySnapshotCapture(workingSetActivity)
    ] as const, { concurrency: 'unbounded' })
  return {
    tabHistory,
    workingSetActivity,
    openTabsSnapshot,
    retainedPages,
    retainedPagesWire,
    retentionHealth
  }
})

export function createBackgroundRuntime(chromeApi: ChromeApi) {
  const localStorage = chromeApi.storage?.local
  const sessionStorage = chromeApi.storage?.session
  const storageAccess = localStorage?.setAccessLevel && sessionStorage?.setAccessLevel
    ? Promise.all([
        localStorage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
        sessionStorage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      ]).then(
        () => ({ ok: true as const }),
        (cause: unknown) => ({ ok: false as const, cause })
      )
    : Promise.resolve({
        ok: false as const,
        cause: new Error('Trusted retention storage is unavailable')
      })
  const withTrustedRetentionStorage = async <Value>(
    operation: () => Promise<Value>
  ): Promise<Value> => {
    const access = await storageAccess
    if (!access.ok) throw access.cause
    return operation()
  }

  const retainedPagesDecodeCache = createRetainedPageLedgerStorageDecodeCache()
  const retainedPagesStorage = RetainedPageLedgerStorage.layer({
    read: () => withTrustedRetentionStorage(async () =>
      retainedPagesDecodeCache.decode(await readChromeStorageValue(
        chromeApi.storage.local,
        RETAINED_PAGES_STORAGE_KEY
      ))),
    write: (ledger) => withTrustedRetentionStorage(async () => {
      const encoded = await encodeRetainedPageLedgerStorageValue(ledger)
      await writeChromeStorageValue(
        chromeApi.storage.local,
        RETAINED_PAGES_STORAGE_KEY,
        encoded
      )
    })
  }, {
    reindexExpandedIdentities: true,
    runtimeId: chromeApi.runtime?.id
  })
  const openSurfaceStorage = OpenSurfaceInventoryStorage.layer({
    readSession: () => withTrustedRetentionStorage(() => readChromeStorageValue(
      chromeApi.storage.session,
      OPEN_SURFACE_SESSION_STORAGE_KEY
    )),
    writeSession: (inventory) => withTrustedRetentionStorage(() => writeChromeStorageValue(
      chromeApi.storage.session,
      OPEN_SURFACE_SESSION_STORAGE_KEY,
      inventory
    )),
    readDurable: () => withTrustedRetentionStorage(() => readChromeStorageValue(
      chromeApi.storage.local,
      OPEN_SURFACE_DURABLE_STORAGE_KEY
    )),
    writeDurable: (inventory) => withTrustedRetentionStorage(() => writeChromeStorageValue(
      chromeApi.storage.local,
      OPEN_SURFACE_DURABLE_STORAGE_KEY,
      inventory
    ))
  }, {
    reindexIdentities: true,
    runtimeId: chromeApi.runtime?.id
  })
  const retentionHealth = RetentionHealth.layer({
    read: () => withTrustedRetentionStorage(() => readChromeStorageValue(
      chromeApi.storage.session,
      RETENTION_HEALTH_STORAGE_KEY
    )),
    write: (episode) => withTrustedRetentionStorage(() => writeChromeStorageValue(
      chromeApi.storage.session,
      RETENTION_HEALTH_STORAGE_KEY,
      episode
    )),
    clear: () => withTrustedRetentionStorage(() => removeChromeStorageValue(
      chromeApi.storage.session,
      RETENTION_HEALTH_STORAGE_KEY
    ))
  })
  const retainedPages = RetainedPages.layer({
    now: Date.now,
    // Some focused service tests inject only the Chrome APIs their selected
    // service uses. Retention resolves the runtime id lazily/optionally so
    // constructing the shared runtime does not widen those test seams.
    runtimeId: chromeApi.runtime?.id,
    recoverSnapshot: (page, disposition, currentWindowId) => recoverRetainedPageSnapshot(
      chromeApi,
      page,
      disposition,
      currentWindowId === undefined ? {} : { currentWindowId }
    )
  }).pipe(Layer.provide(Layer.mergeAll(
    retainedPagesStorage,
    openSurfaceStorage,
    retentionHealth
  )))
  const coreServices = Layer.mergeAll(
    BrowserTabs.layer(),
    Badge.layer(chromeApi),
    NativePlacementBridge.layer(chromeApi),
    retainedPages,
    retentionHealth,
    TabHistory.layer(chromeApi),
    WorkingSet.layer(chromeApi)
  )
  const runtimeLayer = StartupSnapshot.layer({
    alarms: chromeApi.alarms,
    getDashboardServiceState: captureDashboardServiceStateEffect
  }).pipe(Layer.provideMerge(coreServices))
  const runtime = ManagedRuntime.make(runtimeLayer)
  // Every worker service layer is synchronously constructed. Build it during
  // module initialization so the first event starts work at the same boundary
  // as Chrome's listener callback rather than waiting on lazy layer startup.
  runtime.runSync(Effect.void)
  return runtime
}
