import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import type { Page, Worker } from '@playwright/test'

import { chromeSupportPolicy } from '../../src/extension/chrome-support.js'
import {
  OPEN_SURFACE_DURABLE_STORAGE_KEY,
  OPEN_SURFACE_SESSION_STORAGE_KEY
} from '../../src/extension/open-surface-inventory-storage.js'
import type {
  OpenSurfaceInventory,
  OpenSurfaceInventoryEntry
} from '../../src/extension/open-surface-inventory.js'
import {
  emptyOpenSurfaceInventory,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION
} from '../../src/extension/open-surface-inventory.js'
import {
  emptyRetainedPageLedger,
  RETAINED_PAGE_CAPACITY,
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageLedger
} from '../../src/extension/retained-pages-ledger.js'
import { RETAINED_PAGE_IDENTITY_VERSION } from '../../src/extension/retained-page-identity.js'
import {
  encodeRetainedPageLedgerStorageValue,
  RETAINED_PAGES_STORAGE_KEY
} from '../../src/extension/retained-pages-storage.js'
import { RETENTION_HEALTH_STORAGE_KEY } from '../../src/extension/retention-health.js'
import {
  CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
  DASHBOARD_SERVICE_STATE_GET_MESSAGE
} from '../../src/extension/runtime-messages.js'
import {
  STARTUP_SNAPSHOT_DEBOUNCE_MS,
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM
} from '../../src/extension/background/startup-snapshot-service.js'
import {
  DASHBOARD_STARTUP_SEED_CACHE_KEY
} from '../../src/extension/startup-snapshot.js'
import { canonicalDedupeKey } from '../../src/extension/url-canonical.js'
import {
  buildRepresentativeDurableInventory,
  buildSaturatedRetainedPageLedger,
  RETAINED_STORAGE_PROFILE_DURABLE_SURFACES,
  RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES
} from '../helpers/retained-storage-profile.js'
import {
  buildCompleteRepresentativeLocalProfileV1,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_STABLE_KEYS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_VERSION
} from '../helpers/complete-local-storage-profile.js'
import {
  expect,
  test,
  type InstalledExtension
} from './installed-extension.js'

const CHROME_LOCAL_QUOTA_BYTES = 10 * 1_024 * 1_024
const RETAINED_LOCAL_BUDGET_BYTES = CHROME_LOCAL_QUOTA_BYTES * 0.5
const COMPLETE_LOCAL_BUDGET_BYTES = CHROME_LOCAL_QUOTA_BYTES * 0.8
const STARTUP_CONTRIBUTION_P95_BUDGET_MS = 100
const WARM_SINGLE_CLOSE_P95_BUDGET_MS = 250
const COLD_SINGLE_CLOSE_P95_BUDGET_MS = 500
const CLOSE_BURST_P95_BUDGET_MS = 1_000
const CLOSE_BURST_MAX_LEDGER_WRITES = 3
const CLOSE_BURST_TEST_TIMEOUT_MS = 2 * 60 * 60_000
const CLOSE_BURST_SETUP_TIMEOUT_MS = 2 * 60_000
const BENCHMARK_TAB_COUNT = 500
const BENCHMARK_TAB_CREATE_BATCH_SIZE = 25
const BENCHMARK_TAB_CREATE_BATCH_TIMEOUT_MS = 30_000
const QUOTA_FILLER_STORAGE_KEY = 'tabOutBenchmarkQuotaFiller'
const STARTUP_SEED_WRITE_LOCK = 'tab-out:startup-snapshot-cache-write'
const SEED_BARRIER_TRACKER_KEY = '__tabOutRetentionBenchmarkSeedBarrier'
const COLD_CLOSE_CONTROLLER_KEY = '__tabOutRetentionBenchmarkColdCloseController'

function benchmarkCount(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

const WARMUP_PAIR_COUNT = benchmarkCount(
  'TAB_OUT_RETENTION_BENCHMARK_WARMUPS',
  5
)
const MEASURED_PAIR_COUNT = benchmarkCount(
  'TAB_OUT_RETENTION_BENCHMARK_RUNS',
  30
)
const SKIP_CLOSE_BURST = process.env.TAB_OUT_RETENTION_BENCHMARK_SKIP_BURST === '1'
const BURST_PREFLIGHT_ONLY =
  process.env.TAB_OUT_RETENTION_BENCHMARK_PREFLIGHT_ONLY === '1'
const BURST_PREFLIGHT_KIND: ProfileKind =
  process.env.TAB_OUT_RETENTION_BENCHMARK_PREFLIGHT_KIND === 'empty'
    ? 'empty'
    : 'saturated'

type ProfileKind = 'empty' | 'saturated'

interface SaturatedProfile {
  readonly durableInventory: OpenSurfaceInventory
  readonly durableInventorySha256: string
  readonly emptyPersistedLedger: unknown
  readonly ledgerSha256: string
  readonly persistedLedger: unknown
  readonly representativeLocal: Readonly<Record<string, unknown>>
  readonly representativeLocalFixtureSha256: string
  readonly representativeLocalStableSha256: string
}

interface InstalledProfileReading {
  readonly probeDecodeAndPruneMs: number
  readonly durableInventorySha256: string | null
  readonly durableSurfaces: number
  readonly ledgerSha256: string | null
  readonly pages: number
  readonly removalBoundaries: number
}

interface InstalledProfileDiagnostic extends InstalledProfileReading {
  readonly observedLocalBytes: number
  readonly representativeLocalKeysPresent: number
  readonly representativeLocalSha256: string
  readonly representativeLocalStableSha256: string
  readonly retainedLocalBytes: number
}

interface InstalledProfileSample {
  readonly preHeaderServiceStateRequestCount: number
  readonly serviceStateRequestMs: number
  readonly serviceStateRequestStartedAtMs: number
  readonly serviceStateToHeaderMs: number
  readonly startupFrameReadyMs: number
  readonly visiblePageChips: number
  readonly wallToHeaderObservationMs: number
}

interface PairedProfileSample {
  readonly empty: InstalledProfileSample
  readonly saturated: InstalledProfileSample
}

interface PairedProfileDiagnostic {
  readonly empty: InstalledProfileDiagnostic
  readonly saturated: InstalledProfileDiagnostic
}

interface InstalledBurstSample {
  readonly candidatePageIdentityTokenSha256: string
  readonly candidatePagesExpected: number
  readonly candidatePagesMatched: number
  readonly completed: boolean
  readonly cleanupMs: number
  readonly durableSurfaces: number
  readonly eventDeliveryMs: number
  readonly expectedCandidatePageIdentityTokenSha256: string
  readonly ledgerAfterLastRemovalMs: number
  readonly ledgerSetCalls: number
  readonly pages: number
  readonly phaseTrace?: readonly {
    readonly area: string
    readonly durationMs: number
    readonly inventory?: { readonly entries: number; readonly markedClosed: number }
    readonly keys?: readonly string[]
    readonly ledger?: { readonly pages: number; readonly removalBoundaries: number }
    readonly operation: string
    readonly startMs: number
  }[]
  readonly removedEvents: number
  readonly removeCallToFinalLedgerSetMs: number
  readonly removeCallToFirstLedgerSetMs: number
  readonly removalBoundaries: number
  readonly sessionSurfaces: number
}

interface PairedBurstSample {
  readonly empty: InstalledBurstSample
  readonly saturated: InstalledBurstSample
}

interface InstalledColdCloseSample {
  readonly candidatePagesMatched: number
  readonly closeCommandToSettlementObservationMs: number
  readonly completed: boolean
  readonly durableSurfaces: number
  readonly ledgerPublicationToSettlementMs: number
  readonly pages: number
  readonly removalBoundaries: number
  readonly removalToLedgerPublicationMs: number
  readonly removalToSettlementMs: number
  readonly sessionSurfaces: number
  readonly workerAbsentBeforeClose: true
}

interface PairedColdCloseSample {
  readonly empty: InstalledColdCloseSample
  readonly saturated: InstalledColdCloseSample
}

function canonicalJson(value: unknown): string {
  function sortKeys(current: unknown): unknown {
    if (Array.isArray(current)) return current.map(sortKeys)
    if (typeof current !== 'object' || current === null) return current
    return Object.fromEntries(Object.keys(current).sort().map((key) => [
      key,
      sortKeys((current as Record<string, unknown>)[key])
    ]))
  }
  return JSON.stringify(sortKeys(value))
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function openSurfaceIdentityV1(
  surfaceKind: OpenSurfaceInventoryEntry['surfaceKind'],
  url: string
): Pick<OpenSurfaceInventoryEntry, 'canonicalKey' | 'identityDigest'> {
  const canonicalKey = canonicalDedupeKey(url)
  const identityMaterial = JSON.stringify([
    RETAINED_PAGE_IDENTITY_VERSION,
    surfaceKind,
    canonicalKey
  ])
  return {
    canonicalKey,
    identityDigest: createHash('sha256').update(identityMaterial).digest('hex')
  }
}

function withOpenSurfaceIdentityV1(
  inventory: OpenSurfaceInventory
): OpenSurfaceInventory {
  return {
    ...inventory,
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
    identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
    entries: Object.fromEntries(Object.entries(inventory.entries).map(([
      tabId,
      entry
    ]) => [tabId, {
      ...entry,
      ...openSurfaceIdentityV1(entry.surfaceKind, entry.url)
    }]))
  }
}

function pickRecordKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, record[key]]))
}

function refreshRepresentativeProfileLiveTimes(
  fixture: Readonly<Record<string, unknown>>,
  now = Date.now()
): Record<string, unknown> {
  const startupSeed = fixture[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  if (
    typeof startupSeed !== 'object' ||
    startupSeed === null ||
    Array.isArray(startupSeed)
  ) throw new Error('Complete representative profile has no valid Startup Seed')
  const workingSetPriority = Reflect.get(startupSeed, 'workingSetPriority')
  if (
    typeof workingSetPriority !== 'object' ||
    workingSetPriority === null ||
    Array.isArray(workingSetPriority)
  ) throw new Error('Complete representative profile has no Startup Seed priority')
  return {
    ...fixture,
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: {
      ...startupSeed,
      savedAt: now,
      captureStartedAt: now,
      workingSetPriority: { ...workingSetPriority, epoch: now }
    }
  }
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) throw new Error('A percentile requires measurements')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

function distribution(values: readonly number[]) {
  return {
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values)
  }
}

function shiftedSaturatedLedger(now: number): RetainedPageLedger {
  const source = buildSaturatedRetainedPageLedger()
  return {
    ...source,
    pages: Object.fromEntries(Object.entries(source.pages).map(([
      identityDigest,
      page
    ], index) => [identityDigest, {
      ...page,
      closedAt: now - (RETAINED_PAGE_CAPACITY - index)
    }])),
    removalBoundaries: Object.fromEntries(
      Object.entries(source.removalBoundaries).map(([
        closureToken,
        boundary
      ], index) => [closureToken, {
        ...boundary,
        expiresAt: now - index + RETAINED_PAGE_LIFETIME_MS
      }])
    )
  }
}

async function saturatedProfile(): Promise<SaturatedProfile> {
  const ledger = shiftedSaturatedLedger(Date.now())
  const [emptyPersistedLedger, persistedLedger] = await Promise.all([
    encodeRetainedPageLedgerStorageValue(emptyRetainedPageLedger()),
    encodeRetainedPageLedgerStorageValue(ledger)
  ])
  const durableInventory = withOpenSurfaceIdentityV1(
    buildRepresentativeDurableInventory()
  )
  const representativeLocal = buildCompleteRepresentativeLocalProfileV1()
  return {
    durableInventory,
    durableInventorySha256: sha256Json(durableInventory),
    emptyPersistedLedger,
    ledgerSha256: sha256Json(persistedLedger),
    persistedLedger,
    representativeLocal,
    representativeLocalFixtureSha256: sha256Json(representativeLocal),
    representativeLocalStableSha256: sha256Json(pickRecordKeys(
      representativeLocal,
      COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_STABLE_KEYS
    ))
  }
}

async function seedRetentionStorageState(
  worker: Worker,
  state: {
    readonly durable: OpenSurfaceInventory
    readonly ledger: unknown
    readonly representativeLocal: Readonly<Record<string, unknown>>
    readonly requireStartupRefresh?: boolean
    readonly session: OpenSurfaceInventory
    readonly timeoutMs?: number
  }
): Promise<void> {
  const timeoutMs = state.timeoutMs ?? 30_000
  const representativeLocal = refreshRepresentativeProfileLiveTimes(
    state.representativeLocal
  )
  try {
    await worker.evaluate(async ({
      durable,
      durableKey,
      ledger,
      ledgerKey,
      representativeLocal,
      quietMs,
      requireStartupRefresh,
      session,
      sessionKey,
      startupCheckpointAlarm,
      startupSeedLock,
      timeoutMs,
      trackerKey
    }) => {
      type StorageGet = (
        keys?: string | readonly string[] | Record<string, unknown> | null
      ) => Promise<Record<string, unknown>>
      type StorageSet = (items: Record<string, unknown>) => Promise<void>
      type InstrumentedStorageArea = { get: StorageGet; set: StorageSet }
      type SeedBarrierTracker = {
        readonly restore: () => void
        readonly seed: () => Promise<void>
        readonly status: () => {
          readonly activeStorageCalls: number
          readonly ledgerChangeEventObserved: boolean
          readonly ledgerChanged: boolean
          readonly ledgerReadObserved: boolean
          readonly ledgerReadbackMatched: boolean
          readonly startupSeedLockObserved: boolean
        }
        readonly waitAndRestore: () => Promise<void>
      }

      const globalScope = globalThis as unknown as Record<string, unknown>
      const existingTracker = globalScope[trackerKey] as
        | { readonly restore?: () => void }
        | undefined
      existingTracker?.restore?.()

      const localArea = chrome.storage.local as unknown as InstrumentedStorageArea
      const sessionArea = chrome.storage.session as unknown as InstrumentedStorageArea
      const originalLocalGet = localArea.get.bind(localArea)
      const originalLocalSet = localArea.set.bind(localArea)
      const originalSessionGet = sessionArea.get.bind(sessionArea)
      const originalSessionSet = sessionArea.set.bind(sessionArea)
      const originalLockRequest = navigator.locks.request.bind(navigator.locks)

      function persistedLedgerValuesEqual(left: unknown, right: unknown): boolean {
        if (
          typeof left !== 'object' || left === null || Array.isArray(left) ||
          typeof right !== 'object' || right === null || Array.isArray(right)
        ) return false
        const leftRecord = left as Record<string, unknown>
        const rightRecord = right as Record<string, unknown>
        const expectedKeys = ['data', 'encoding', 'identityVersion', 'schemaVersion']
        return Object.keys(leftRecord).sort().join('\0') === expectedKeys.join('\0') &&
          Object.keys(rightRecord).sort().join('\0') === expectedKeys.join('\0') &&
          leftRecord.schemaVersion === rightRecord.schemaVersion &&
          leftRecord.identityVersion === rightRecord.identityVersion &&
          leftRecord.encoding === rightRecord.encoding &&
          leftRecord.data === rightRecord.data
      }

      const previousLedger = (await originalLocalGet(ledgerKey))[ledgerKey]
      const ledgerChanged = !persistedLedgerValuesEqual(previousLedger, ledger)
      let activeStorageCalls = 0
      let deadline = 0
      let ledgerChangeEventObserved = false
      let ledgerReadObserved = false
      let ledgerReadbackMatched = false
      let startupSeedLockObserved = false
      let lastActivityAt = performance.now()
      let restored = false
      let seeded = false

      function keyList(keys: unknown): readonly string[] {
        if (Array.isArray(keys)) return keys.map(String)
        if (typeof keys === 'string') return [keys]
        if (typeof keys === 'object' && keys !== null) return Object.keys(keys)
        return []
      }

      function wrapGet(area: 'local' | 'session', original: StorageGet): StorageGet {
        return async (keys) => {
          if (!seeded) return original(keys)
          const keysRead = keyList(keys)
          activeStorageCalls += 1
          lastActivityAt = performance.now()
          if (area === 'local' && keysRead.includes(ledgerKey)) {
            ledgerReadObserved = true
          }
          try {
            return await original(keys)
          } finally {
            activeStorageCalls -= 1
            lastActivityAt = performance.now()
          }
        }
      }

      function wrapSet(original: StorageSet): StorageSet {
        return async (items) => {
          if (!seeded) return original(items)
          activeStorageCalls += 1
          lastActivityAt = performance.now()
          try {
            await original(items)
          } finally {
            activeStorageCalls -= 1
            lastActivityAt = performance.now()
          }
        }
      }

      function delay(durationMs: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, durationMs))
      }

      const onStorageChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string
      ) => {
        if (
          seeded &&
          areaName === 'local' &&
          Object.hasOwn(changes, ledgerKey)
        ) ledgerChangeEventObserved = true
      }

      async function waitUntil(
        predicate: () => boolean,
        message: string
      ): Promise<void> {
        while (performance.now() < deadline) {
          if (predicate()) return
          await delay(10)
        }
        throw new Error(message)
      }

      async function withTimeout<Value>(
        promise: PromiseLike<Value>,
        message: string
      ): Promise<Value> {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            Promise.resolve(promise),
            new Promise<never>((_resolve, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(message)),
                Math.max(0, deadline - performance.now())
              )
            })
          ])
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        }
      }

      const tracker: SeedBarrierTracker = {
        restore() {
          if (restored) return
          restored = true
          localArea.get = originalLocalGet
          localArea.set = originalLocalSet
          sessionArea.get = originalSessionGet
          sessionArea.set = originalSessionSet
          navigator.locks.request = originalLockRequest
          chrome.storage.onChanged.removeListener(onStorageChanged)
          if (globalScope[trackerKey] === tracker) delete globalScope[trackerKey]
        },
        async seed() {
          if (seeded) throw new Error('Retention storage seed already started')
          seeded = true
          deadline = performance.now() + timeoutMs
          // The checked-in Startup Seed is part of the size population, not a
          // request to let an alarm from an earlier sample promote into this
          // sample's timed window.
          await chrome.alarms.clear(startupCheckpointAlarm)
          // One local set produces one coherent retained-ledger/durable-inventory
          // transition. The session mirror is outside the Startup Snapshot trigger.
          await Promise.all([
            originalLocalSet({
              ...representativeLocal,
              [ledgerKey]: ledger,
              [durableKey]: durable
            }),
            originalSessionSet({ [sessionKey]: session })
          ])
          ledgerReadbackMatched = persistedLedgerValuesEqual(
            (await originalLocalGet(ledgerKey))[ledgerKey],
            ledger
          )
        },
        status() {
          return {
            activeStorageCalls,
            ledgerChangeEventObserved,
            ledgerChanged,
            ledgerReadObserved,
            ledgerReadbackMatched,
            startupSeedLockObserved
          }
        },
        async waitAndRestore() {
          try {
            if (!seeded) throw new Error('Retention storage seed has not started')
            if (!ledgerReadbackMatched) {
              throw new Error('Retention storage seed did not survive semantic readback')
            }
            if (ledgerChanged && requireStartupRefresh) {
              if (
                !ledgerChangeEventObserved ||
                !ledgerReadObserved ||
                !startupSeedLockObserved
              ) {
                throw new Error(
                  'Storage-triggered Startup Snapshot refresh was not observed ' +
                  `(ledgerChangeEventObserved=${String(ledgerChangeEventObserved)}, ` +
                  `ledgerReadObserved=${String(ledgerReadObserved)}, ` +
                  `startupSeedLockObserved=${String(startupSeedLockObserved)}, ` +
                  `activeStorageCalls=${activeStorageCalls})`
                )
              }
            }

            // Observing the refresh's lock request and then requesting the same
            // lock makes FIFO acquisition the completion barrier. Later refreshes
            // may skip a seeded cache read, but they always enter this lock.
            await withTimeout(
              originalLockRequest(startupSeedLock, () => undefined),
              'Timed out waiting for the Startup Snapshot write lock'
            )
            await waitUntil(
              () => activeStorageCalls === 0 &&
                performance.now() - lastActivityAt >= quietMs,
              'Timed out waiting for Startup Snapshot storage quiescence'
            )
          } finally {
            tracker.restore()
          }
        }
      }

      localArea.get = wrapGet('local', originalLocalGet)
      localArea.set = wrapSet(originalLocalSet)
      sessionArea.get = wrapGet('session', originalSessionGet)
      sessionArea.set = wrapSet(originalSessionSet)
      chrome.storage.onChanged.addListener(onStorageChanged)
      navigator.locks.request = ((name: string, ...args: unknown[]) => {
        if (seeded && name === startupSeedLock) startupSeedLockObserved = true
        return Reflect.apply(
          originalLockRequest,
          navigator.locks,
          [name, ...args]
        ) as Promise<unknown>
      }) as typeof navigator.locks.request
      globalScope[trackerKey] = tracker
    }, {
      durable: state.durable,
      durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
      ledger: state.ledger,
      ledgerKey: RETAINED_PAGES_STORAGE_KEY,
      quietMs: 250,
      representativeLocal,
      requireStartupRefresh: state.requireStartupRefresh !== false,
      session: state.session,
      sessionKey: OPEN_SURFACE_SESSION_STORAGE_KEY,
      startupCheckpointAlarm: STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM,
      startupSeedLock: STARTUP_SEED_WRITE_LOCK,
      timeoutMs,
      trackerKey: SEED_BARRIER_TRACKER_KEY
    })

    await worker.evaluate(async (trackerKey) => {
      type SeedBarrierTracker = { readonly seed: () => Promise<void> }
      const tracker = (
        globalThis as unknown as Record<string, unknown>
      )[trackerKey] as SeedBarrierTracker | undefined
      if (tracker === undefined) throw new Error('Retention seed barrier is not installed')
      await tracker.seed()
    }, SEED_BARRIER_TRACKER_KEY)

    // Drain tab-event refreshes from fixture setup before timing. The retained
    // storage event itself refreshes immediately, so a changed ledger must also
    // prove that the product read it and entered the Startup Snapshot lock.
    await new Promise((resolve) => setTimeout(
      resolve,
      STARTUP_SNAPSHOT_DEBOUNCE_MS + 1_000
    ))
    if (state.requireStartupRefresh !== false) {
      const signalDeadline = performance.now() + timeoutMs
      let signalStatus = {
        activeStorageCalls: 0,
        ledgerChangeEventObserved: false,
        ledgerChanged: true,
        ledgerReadObserved: false,
        ledgerReadbackMatched: false,
        startupSeedLockObserved: false
      }
      while (performance.now() < signalDeadline) {
        signalStatus = await worker.evaluate((trackerKey) => {
          type SeedBarrierTracker = {
            readonly status: () => {
              readonly activeStorageCalls: number
              readonly ledgerChangeEventObserved: boolean
              readonly ledgerChanged: boolean
              readonly ledgerReadObserved: boolean
              readonly ledgerReadbackMatched: boolean
              readonly startupSeedLockObserved: boolean
            }
          }
          const tracker = (
            globalThis as unknown as Record<string, unknown>
          )[trackerKey] as SeedBarrierTracker | undefined
          if (tracker === undefined) throw new Error('Retention seed barrier is not installed')
          return tracker.status()
        }, SEED_BARRIER_TRACKER_KEY)
        if (
          !signalStatus.ledgerChanged || (
            signalStatus.ledgerChangeEventObserved &&
            signalStatus.ledgerReadObserved &&
            signalStatus.startupSeedLockObserved
          )
        ) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const refreshObserved = signalStatus.ledgerChangeEventObserved &&
        signalStatus.ledgerReadObserved &&
        signalStatus.startupSeedLockObserved
      if (signalStatus.ledgerChanged && !refreshObserved) {
        throw new Error(
          'Timed out waiting for the storage-triggered Startup Snapshot refresh ' +
          `(ledgerReadObserved=${String(signalStatus.ledgerReadObserved)}, ` +
          `ledgerChangeEventObserved=${String(signalStatus.ledgerChangeEventObserved)}, ` +
          `ledgerReadbackMatched=${String(signalStatus.ledgerReadbackMatched)}, ` +
          `startupSeedLockObserved=${String(signalStatus.startupSeedLockObserved)}, ` +
          `activeStorageCalls=${signalStatus.activeStorageCalls})`
        )
      }
    }

    await worker.evaluate(async (trackerKey) => {
      type SeedBarrierTracker = {
        readonly waitAndRestore: () => Promise<void>
      }
      const tracker = (
        globalThis as unknown as Record<string, unknown>
      )[trackerKey] as SeedBarrierTracker | undefined
      if (tracker === undefined) throw new Error('Retention seed barrier is not installed')
      await tracker.waitAndRestore()
    }, SEED_BARRIER_TRACKER_KEY)
  } finally {
    await worker.evaluate((trackerKey) => {
      type SeedBarrierTracker = { readonly restore: () => void }
      const tracker = (
        globalThis as unknown as Record<string, unknown>
      )[trackerKey] as SeedBarrierTracker | undefined
      tracker?.restore()
    }, SEED_BARRIER_TRACKER_KEY).catch(() => undefined)
  }
}

async function seedInstalledProfile(
  worker: Worker,
  kind: ProfileKind,
  profile: SaturatedProfile,
  requireStartupRefresh = true
): Promise<void> {
  const emptyInventory = emptyOpenSurfaceInventory()
  await seedRetentionStorageState(worker, {
    durable: kind === 'saturated' ? profile.durableInventory : emptyInventory,
    ledger: kind === 'saturated'
      ? profile.persistedLedger
      : profile.emptyPersistedLedger,
    representativeLocal: profile.representativeLocal,
    requireStartupRefresh,
    session: emptyInventory
  })
}

async function readInstalledProfile(worker: Worker): Promise<InstalledProfileReading> {
  return worker.evaluate(async ({
    durableKey,
    ledgerKey,
    retentionLifetimeMs
  }) => {
    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    async function digestJson(value: unknown): Promise<string> {
      function sortKeys(current: unknown): unknown {
        if (Array.isArray(current)) return current.map(sortKeys)
        if (!isRecord(current)) return current
        return Object.fromEntries(Object.keys(current).sort().map((key) => [
          key,
          sortKeys(current[key])
        ]))
      }
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(sortKeys(value)))
      )
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }

    async function decodeLedger(value: unknown): Promise<unknown> {
      if (
        !isRecord(value) ||
        value.encoding !== 'gzip-base64-json-v1' ||
        typeof value.data !== 'string'
      ) return value
      const binary = atob(value.data)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      const stream = new Blob([bytes]).stream().pipeThrough(
        new DecompressionStream('gzip')
      )
      return JSON.parse(await new Response(stream).text())
    }

    const startedAt = performance.now()
    const stored = await chrome.storage.local.get([ledgerKey, durableKey])
    const rawLedger = stored[ledgerKey]
    const rawDurable = stored[durableKey]
    const ledger = await decodeLedger(rawLedger)
    const observedAt = Date.now()
    const pages = isRecord(ledger) && isRecord(ledger.pages)
      ? Object.values(ledger.pages).filter((value) => (
        isRecord(value) &&
        typeof value.closedAt === 'number' &&
        value.closedAt + retentionLifetimeMs > observedAt
      )).length
      : 0
    const removalBoundaries = isRecord(ledger) && isRecord(ledger.removalBoundaries)
      ? Object.values(ledger.removalBoundaries).filter((value) => (
        isRecord(value) &&
        typeof value.expiresAt === 'number' &&
        value.expiresAt > observedAt
      )).length
      : 0
    const durableSurfaces = isRecord(rawDurable) && isRecord(rawDurable.entries)
      ? Object.keys(rawDurable.entries).length
      : 0
    const probeDecodeAndPruneMs = performance.now() - startedAt

    return {
      probeDecodeAndPruneMs,
      durableInventorySha256: rawDurable === undefined
        ? null
        : await digestJson(rawDurable),
      durableSurfaces,
      ledgerSha256: rawLedger === undefined ? null : await digestJson(rawLedger),
      pages,
      removalBoundaries
    }
  }, {
    durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
    ledgerKey: RETAINED_PAGES_STORAGE_KEY,
    retentionLifetimeMs: RETAINED_PAGE_LIFETIME_MS
  })
}

async function installedStorageFootprint(worker: Worker): Promise<{
  readonly observedLocalBytes: number
  readonly representativeLocalKeysPresent: number
  readonly representativeLocalSha256: string
  readonly representativeLocalStableSha256: string
  readonly retainedLocalBytes: number
}> {
  return worker.evaluate(async ({
    durableKey,
    ledgerKey,
    representativeLocalKeys,
    representativeLocalStableKeys
  }) => {
    function sortKeys(current: unknown): unknown {
      if (Array.isArray(current)) return current.map(sortKeys)
      if (typeof current !== 'object' || current === null) return current
      const record = current as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map((key) => [
        key,
        sortKeys(record[key])
      ]))
    }

    async function digestJson(value: unknown): Promise<string> {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(sortKeys(value)))
      )
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }

    const representativeLocal = await chrome.storage.local.get(
      [...representativeLocalKeys]
    )
    const stableRepresentativeLocal = Object.fromEntries(
      representativeLocalStableKeys.map((key) => [key, representativeLocal[key]])
    )
    return {
      observedLocalBytes: await chrome.storage.local.getBytesInUse(null),
      representativeLocalKeysPresent: representativeLocalKeys.filter((key) => (
        Object.hasOwn(representativeLocal, key)
      )).length,
      representativeLocalSha256: await digestJson(representativeLocal),
      representativeLocalStableSha256: await digestJson(stableRepresentativeLocal),
      retainedLocalBytes: await chrome.storage.local.getBytesInUse([
        ledgerKey,
        durableKey
      ])
    }
  }, {
    durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
    ledgerKey: RETAINED_PAGES_STORAGE_KEY,
    representativeLocalKeys: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS,
    representativeLocalStableKeys: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_STABLE_KEYS
  })
}

async function closeInstalledTargetWithWorkerTerminated<Value>(
  installedExtension: InstalledExtension,
  page: Page,
  targetUrlPrefix: string,
  observe: () => Promise<Value>
): Promise<{
  readonly closeCommandToObservationMs: number
  readonly observation: Value
}> {
  const session = await installedExtension.context.newCDPSession(page)
  const workerUrl = installedExtension.serviceWorker.url()
  let observationPromise: Promise<Value> | undefined
  try {
    const targets = await session.send('Target.getTargets')
    const workerTarget = targets.targetInfos.find((target) => (
      target.type === 'service_worker' && target.url === workerUrl
    ))
    if (!workerTarget) {
      throw new Error('Installed service-worker target was absent before cold termination')
    }
    const candidateTargets = targets.targetInfos.filter((target) => (
      target.type === 'page' && target.url.startsWith(targetUrlPrefix)
    ))
    if (candidateTargets.length !== 1) {
      throw new Error(
        `Expected one cold-close CDP target, observed ${candidateTargets.length}`
      )
    }
    const candidateTarget = candidateTargets[0]
    if (!candidateTarget) throw new Error('Cold-close CDP target was absent')

    // The controller has already armed its extension events. Start waiting on
    // its page-local promise before terminating the worker so the final absent
    // snapshot can flow directly into the physical target close.
    observationPromise = observe()
    const closed = await session.send('Target.closeTarget', {
      targetId: workerTarget.targetId
    })
    if (!closed.success) {
      throw new Error('Chrome rejected installed service-worker termination')
    }

    const deadline = performance.now() + 5_000
    while (performance.now() < deadline) {
      const observed = await session.send('Target.getTargets')
      const stillRunning = observed.targetInfos.some((target) => (
        target.type === 'service_worker' && target.url === workerUrl
      ))
      if (!stillRunning) {
        const candidateStillPresent = observed.targetInfos.some((target) => (
          target.targetId === candidateTarget.targetId
        ))
        if (!candidateStillPresent) {
          throw new Error('Cold-close target disappeared before the absent-worker proof')
        }
        const closeCommandStartedAt = performance.now()
        const targetClosed = await session.send('Target.closeTarget', {
          targetId: candidateTarget.targetId
        })
        if (!targetClosed.success) {
          throw new Error('Chrome rejected the cold physical target close')
        }
        const observation = await observationPromise
        return {
          closeCommandToObservationMs:
            performance.now() - closeCommandStartedAt,
          observation
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Installed service-worker target remained after termination')
  } catch (error) {
    void observationPromise?.catch(() => undefined)
    throw error
  } finally {
    await session.detach().catch(() => undefined)
  }
}

const startupFrameInstrumentedPages = new WeakSet<Page>()

async function ensureStartupFrameInstrumentation(page: Page): Promise<void> {
  if (startupFrameInstrumentedPages.has(page)) return
  await page.addInitScript(({ serviceStateMessageType }) => {
    type RequestTiming = {
      readonly durationMs: number
      readonly finishedAt: number
      readonly startedAt: number
    }
    type StartupTrace = {
      headerReadyAt: number | null
      latestPreHeaderRequest: RequestTiming | null
      preHeaderRequestCount: number
    }
    type TraceGlobal = typeof globalThis & {
      __tabOutRetentionBenchmarkStartupTrace?: StartupTrace
    }

    const trace: StartupTrace = {
      headerReadyAt: null,
      latestPreHeaderRequest: null,
      preHeaderRequestCount: 0
    }
    ;(globalThis as TraceGlobal).__tabOutRetentionBenchmarkStartupTrace = trace

    const runtime = globalThis.chrome?.runtime
    if (runtime?.sendMessage) {
      const originalSendMessage = runtime.sendMessage.bind(runtime)
      Reflect.set(runtime, 'sendMessage', (...args: unknown[]) => {
        const message = args.find((value) => (
          typeof value === 'object' && value !== null &&
          Reflect.get(value, 'type') === serviceStateMessageType
        ))
        if (!message) return Reflect.apply(originalSendMessage, runtime, args)
        if (trace.headerReadyAt !== null) {
          return Reflect.apply(originalSendMessage, runtime, args)
        }

        const startedAt = performance.now()
        trace.preHeaderRequestCount += 1
        const result = Reflect.apply(originalSendMessage, runtime, args)
        return Promise.resolve(result).then((value) => {
          const finishedAt = performance.now()
          if (
            trace.latestPreHeaderRequest === null ||
            startedAt > trace.latestPreHeaderRequest.startedAt
          ) {
            trace.latestPreHeaderRequest = {
              durationMs: finishedAt - startedAt,
              finishedAt,
              startedAt
            }
          }
          return value
        })
      })
    }

    const recordHeaderReady = () => {
      const stats = document.querySelector('[data-tabout="header-stats"]')
      if (!stats || stats.getAttribute('aria-hidden') === 'true') return
      trace.headerReadyAt ??= performance.now()
      observer.disconnect()
    }
    const observer = new MutationObserver(recordHeaderReady)
    observer.observe(document, {
      attributes: true,
      attributeFilter: ['aria-hidden'],
      childList: true,
      subtree: true
    })
    recordHeaderReady()
  }, { serviceStateMessageType: DASHBOARD_SERVICE_STATE_GET_MESSAGE })
  startupFrameInstrumentedPages.add(page)
}

async function measureStartupFrame(
  installedExtension: InstalledExtension,
  page: Page
): Promise<{
  readonly serviceStateRequestMs: number
  readonly preHeaderServiceStateRequestCount: number
  readonly serviceStateRequestStartedAtMs: number
  readonly serviceStateToHeaderMs: number
  readonly startupFrameReadyMs: number
  readonly visiblePageChips: number
  readonly wallToHeaderObservationMs: number
}> {
  await ensureStartupFrameInstrumentation(page)
  const wallStartedAt = performance.now()
  await page.goto(
    `chrome-extension://${installedExtension.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' }
  )
  const stats = page.locator('[data-tabout="header-stats"]')
  await expect(stats).toBeAttached()
  await expect(stats).not.toHaveAttribute('aria-hidden', 'true')
  const wallToHeaderObservationMs = performance.now() - wallStartedAt
  const diagnostic = await page.evaluate(() => {
    type TraceGlobal = typeof globalThis & {
      __tabOutRetentionBenchmarkStartupTrace?: {
        readonly headerReadyAt: number | null
        readonly latestPreHeaderRequest: {
          readonly durationMs: number
          readonly finishedAt: number
          readonly startedAt: number
        } | null
        readonly preHeaderRequestCount: number
      }
    }
    return (globalThis as TraceGlobal).__tabOutRetentionBenchmarkStartupTrace ?? null
  })
  if (
    diagnostic?.headerReadyAt === null ||
    diagnostic?.latestPreHeaderRequest === null ||
    diagnostic === null
  ) {
    throw new Error('Startup Frame diagnostic did not observe its request and publication')
  }
  await expect(page.getByText('Couldn’t load dashboard')).toHaveCount(0)
  return {
    preHeaderServiceStateRequestCount: diagnostic.preHeaderRequestCount,
    serviceStateRequestMs: diagnostic.latestPreHeaderRequest.durationMs,
    serviceStateRequestStartedAtMs:
      diagnostic.latestPreHeaderRequest.startedAt,
    serviceStateToHeaderMs:
      diagnostic.headerReadyAt - diagnostic.latestPreHeaderRequest.finishedAt,
    startupFrameReadyMs: diagnostic.headerReadyAt,
    visiblePageChips: await page.locator('[data-tabout="page-chip"]').count(),
    wallToHeaderObservationMs
  }
}

async function measureInstalledProfileState(
  installedExtension: InstalledExtension,
  kind: ProfileKind,
  profile: SaturatedProfile
): Promise<InstalledProfileSample> {
  const page = await installedExtension.context.newPage()
  try {
    await page.goto('about:blank')
    await seedInstalledProfile(installedExtension.serviceWorker, kind, profile)
    return await measureStartupFrame(installedExtension, page)
  } finally {
    await page.close().catch(() => undefined)
  }
}

async function readInstalledProfileDiagnostic(
  installedExtension: InstalledExtension,
  kind: ProfileKind,
  profile: SaturatedProfile
): Promise<InstalledProfileDiagnostic> {
  // Diagnostics still wait for the storage/lock quiet barrier, but an
  // identical first profile is allowed to produce no storage-triggered refresh.
  await seedInstalledProfile(
    installedExtension.serviceWorker,
    kind,
    profile,
    false
  )
  const footprint = await installedStorageFootprint(
    installedExtension.serviceWorker
  )
  const reading = await readInstalledProfile(installedExtension.serviceWorker)
  return { ...reading, ...footprint }
}

async function runPairedProfileSample(
  installedExtension: InstalledExtension,
  profile: SaturatedProfile,
  pairIndex: number
): Promise<PairedProfileSample> {
  const order: readonly ProfileKind[] = pairIndex % 2 === 0
    ? ['empty', 'saturated']
    : ['saturated', 'empty']
  const samples = new Map<ProfileKind, InstalledProfileSample>()
  for (const kind of order) {
    samples.set(
      kind,
      await measureInstalledProfileState(installedExtension, kind, profile)
    )
  }
  const empty = samples.get('empty')
  const saturated = samples.get('saturated')
  if (!empty || !saturated) throw new Error('Paired profile sample did not complete')
  return { empty, saturated }
}

async function runPairedProfileDiagnostic(
  installedExtension: InstalledExtension,
  profile: SaturatedProfile,
  pairIndex: number
): Promise<PairedProfileDiagnostic> {
  const order: readonly ProfileKind[] = pairIndex % 2 === 0
    ? ['empty', 'saturated']
    : ['saturated', 'empty']
  const diagnostics = new Map<ProfileKind, InstalledProfileDiagnostic>()
  for (const kind of order) {
    diagnostics.set(
      kind,
      await readInstalledProfileDiagnostic(installedExtension, kind, profile)
    )
  }
  const empty = diagnostics.get('empty')
  const saturated = diagnostics.get('saturated')
  if (!empty || !saturated) throw new Error('Paired profile diagnostic did not complete')
  return { empty, saturated }
}

test('installed minimum-Chrome progressively mounts every dense folded retained target', async ({
  installedExtension
}) => {
  const profile = await saturatedProfile()
  const page = await installedExtension.context.newPage()
  try {
    await page.goto('about:blank')
    await seedInstalledProfile(installedExtension.serviceWorker, 'saturated', profile)
    await page.goto(
      `chrome-extension://${installedExtension.extensionId}/index.html`,
      { waitUntil: 'domcontentloaded' }
    )
    const stats = page.locator('[data-tabout="header-stats"]')
    await expect(stats).not.toHaveAttribute('aria-hidden', 'true')

    const envTargets = page.locator(
      '.chip-env-shell [data-tabout-retained-page-identity]'
    )
    await expect.poll(() => envTargets.count()).toBeGreaterThan(0)
    const firstMountedCount = await envTargets.count()
    expect(firstMountedCount).toBeLessThan(450)

    for (let iteration = 0; iteration < 24; iteration += 1) {
      const previousCount = await envTargets.count()
      const scrolled = await page.evaluate(() => {
        const sentinel = document.querySelector(
          '[data-tabout-part="progressive-env-sentinel"]'
        )
        if (!sentinel) return false
        sentinel.scrollIntoView({ block: 'center' })
        return true
      })
      if (!scrolled) break
      await expect.poll(async () => (
        await envTargets.count() > previousCount ||
        await page.locator(
          '[data-tabout-part="progressive-env-sentinel"]'
        ).count() === 0
      )).toBe(true)
    }

    await expect(envTargets).toHaveCount(450)
    await expect(page.locator(
      '[data-tabout-part="progressive-env-sentinel"]'
    )).toHaveCount(0)
    const identities = await envTargets.evaluateAll((targets) => targets.map((target) => (
      target.getAttribute('data-tabout-retained-page-identity')
    )))
    expect(new Set(identities).size).toBe(450)
  } finally {
    await page.goto('about:blank').catch(() => undefined)
  }
})

function exactLengthUrl(prefix: string, length: number): string {
  if (prefix.length > length) throw new Error('Benchmark URL prefix is too long')
  return `${prefix}${'x'.repeat(length - prefix.length)}`
}

function fixedHex(index: number, length: number): string {
  return index.toString(16).padStart(length, '0')
}

function burstInventory(tabIds: readonly number[]): {
  readonly durable: OpenSurfaceInventory
  readonly session: OpenSurfaceInventory
} {
  if (tabIds.length !== BENCHMARK_TAB_COUNT) {
    throw new Error(`Expected ${BENCHMARK_TAB_COUNT} close targets`)
  }
  const sessionEntries: Record<string, OpenSurfaceInventoryEntry> = {}
  for (const [index, tabId] of tabIds.entries()) {
    const label = String(index).padStart(3, '0')
    const url = exactLengthUrl(
      `https://close-${label}.example.test/article?fixture=`,
      2_048
    )
    const surfaceKind = index < 450 ? 'normal-tab' : 'app'
    sessionEntries[String(tabId)] = {
      tabId,
      closureToken: fixedHex(1_000_000 + index, 32),
      ...openSurfaceIdentityV1(surfaceKind, url),
      surfaceKind,
      url,
      title: '🧪'.repeat(512),
      favIconUrl: exactLengthUrl(
        `https://assets.example.test/close-${label}?fixture=`,
        2_048
      )
    }
  }

  const durableEntries: Record<string, OpenSurfaceInventoryEntry> = {
    ...sessionEntries
  }
  const representative = Object.values(buildRepresentativeDurableInventory().entries)
    .slice(BENCHMARK_TAB_COUNT)
  for (const [index, entry] of representative.entries()) {
    const tabId = 2_000_000 + index
    durableEntries[String(tabId)] = {
      ...entry,
      tabId,
      closureToken: fixedHex(2_000_000 + index, 32),
      ...openSurfaceIdentityV1(entry.surfaceKind, entry.url)
    }
  }

  return {
    session: {
      schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
      identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
      entries: sessionEntries
    },
    durable: {
      schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
      identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
      entries: durableEntries
    }
  }
}

type IdentityTokenPair = readonly [identityDigest: string, closureToken: string]

function candidateIdentityTokens(
  inventory: OpenSurfaceInventory
): readonly IdentityTokenPair[] {
  return Object.values(inventory.entries)
    .map((entry): IdentityTokenPair => [entry.identityDigest, entry.closureToken])
    .sort(([leftIdentity, leftToken], [rightIdentity, rightToken]) => (
      leftIdentity.localeCompare(rightIdentity) || leftToken.localeCompare(rightToken)
    ))
}

function candidateIdentityTokenSha256(
  pairs: readonly IdentityTokenPair[]
): string {
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex')
}

let benchmarkTabRunSequence = 0

function nextBenchmarkTabUrlPrefix(): string {
  benchmarkTabRunSequence += 1
  return `chrome://version/#tab-out-benchmark-${benchmarkTabRunSequence}-`
}

async function createBenchmarkTabs(
  worker: Worker,
  urlPrefix: string,
  count = BENCHMARK_TAB_COUNT
): Promise<{
  readonly failures: readonly string[]
  readonly tabIds: readonly number[]
}> {
  return worker.evaluate(async ({
    batchSize,
    batchTimeoutMs,
    nextCount,
    nextUrlPrefix
  }) => {
    const tabIds: number[] = []
    const failures: string[] = []

    for (let batchStart = 0; batchStart < nextCount; batchStart += batchSize) {
      const failuresBeforeBatch = failures.length
      const batchEnd = Math.min(batchStart + batchSize, nextCount)
      const results = await Promise.allSettled(Array.from(
        { length: batchEnd - batchStart },
        (_, offset) => {
          const index = batchStart + offset
          return chrome.tabs.create({
            active: false,
            url: `${nextUrlPrefix}${index}`
          })
        }
      ))
      const batchTabIds: number[] = []
      for (const [offset, result] of results.entries()) {
        const index = batchStart + offset
        if (result.status === 'rejected') {
          failures.push(`tab ${index}: ${String(result.reason)}`)
        } else if (typeof result.value.id === 'number') {
          batchTabIds.push(result.value.id)
          tabIds.push(result.value.id)
        } else {
          failures.push(`tab ${index}: Chrome returned no tab id`)
        }
      }

      const deadline = performance.now() + batchTimeoutMs
      let batchLoaded = false
      while (batchTabIds.length > 0 && performance.now() < deadline) {
        const statuses = await Promise.all(batchTabIds.map(async (tabId) => {
          try {
            return (await chrome.tabs.get(tabId)).status
          } catch {
            return undefined
          }
        }))
        if (statuses.every((status) => status === 'complete')) {
          batchLoaded = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (!batchLoaded) {
        failures.push(
          `tabs ${batchStart}-${batchEnd - 1}: timed out waiting for page load`
        )
        break
      }
      if (failures.length > failuresBeforeBatch) break
    }
    return { failures, tabIds }
  }, {
    batchSize: BENCHMARK_TAB_CREATE_BATCH_SIZE,
    batchTimeoutMs: BENCHMARK_TAB_CREATE_BATCH_TIMEOUT_MS,
    nextCount: count,
    nextUrlPrefix: urlPrefix
  })
}

async function waitForOpenSurfaceCheckpoint(
  worker: Worker,
  tabIds: readonly number[],
  timeoutMs = 30_000
): Promise<void> {
  await worker.evaluate(async ({
    durableKey,
    sessionKey,
    tabIds: expectedTabIds,
    timeoutMs
  }) => {
    function isRecord(value: unknown): value is Record<string, unknown> {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false
      }
      return true
    }

    function matchesEveryTab(
      value: unknown,
      expectedTabs: readonly chrome.tabs.Tab[]
    ): boolean {
      if (!isRecord(value)) return false
      const entries = Reflect.get(value, 'entries')
      if (!isRecord(entries)) return false
      return expectedTabs.every((tab) => {
        if (typeof tab.id !== 'number') return false
        const entry = Reflect.get(entries, String(tab.id))
        return isRecord(entry) &&
          Reflect.get(entry, 'url') === tab.url &&
          Reflect.get(entry, 'title') === (tab.title || '')
      })
    }

    const expectedTabIdSet = new Set(expectedTabIds)
    const deadline = performance.now() + timeoutMs
    let matchedAt: number | null = null
    while (performance.now() < deadline) {
      const expectedTabs = (await chrome.tabs.query({})).filter((tab) => (
        typeof tab.id === 'number' && expectedTabIdSet.has(tab.id)
      ))
      const [durableStored, sessionStored] = await Promise.all([
        chrome.storage.local.get(durableKey),
        chrome.storage.session.get(sessionKey)
      ])
      const matched = expectedTabs.length === expectedTabIds.length &&
        expectedTabs.every((tab) => tab.status === 'complete') &&
        matchesEveryTab(durableStored[durableKey], expectedTabs) &&
        matchesEveryTab(sessionStored[sessionKey], expectedTabs)
      if (matched) {
        matchedAt ??= performance.now()
        if (performance.now() - matchedAt >= 250) return
      } else {
        matchedAt = null
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      `Timed out waiting for ${expectedTabIds.length} created tabs in both open-surface inventories`
    )
  }, {
    durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
    sessionKey: OPEN_SURFACE_SESSION_STORAGE_KEY,
    tabIds,
    timeoutMs
  })
}

async function openDashboardServiceController(
  installedExtension: InstalledExtension
): Promise<Page> {
  const page = await installedExtension.context.newPage()
  const interceptedScriptPaths = new Set<string>()
  await page.route(
    /\/dist\/(?:app|filter-focus-boot)\.js$/,
    async (route) => {
      interceptedScriptPaths.add(new URL(route.request().url()).pathname)
      await route.fulfill({
        body: '',
        contentType: 'application/javascript',
        status: 200
      })
    }
  )
  await page.goto(
    `chrome-extension://${installedExtension.extensionId}/index.html?retention-benchmark=service-barrier`,
    { waitUntil: 'domcontentloaded' }
  )
  expect([...interceptedScriptPaths].sort()).toEqual([
    '/dist/app.js',
    '/dist/filter-focus-boot.js'
  ])
  return page
}

async function waitForDashboardServiceQueue(page: Page): Promise<void> {
  const ok = await page.evaluate(async ({ messageType, timeoutMs }) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ type: messageType }),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out draining Dashboard service work')),
            timeoutMs
          )
        })
      ])
      return typeof response === 'object' && response !== null &&
        Reflect.get(response, 'ok') === true
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    }
  }, {
    messageType: DASHBOARD_SERVICE_STATE_GET_MESSAGE,
    timeoutMs: 120_000
  })
  if (!ok) throw new Error('Dashboard service queue barrier returned no state')
}

async function waitForClosedSurfaceSettlement(
  worker: Worker,
  tabIds: readonly number[],
  urlPrefix: string
): Promise<void> {
  await worker.evaluate(async ({
    durableKey,
    quietMs,
    sessionKey,
    tabIds: expectedTabIds,
    timeoutMs,
    urlPrefix: expectedUrlPrefix
  }) => {
    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    const expectedTabIdSet = new Set(expectedTabIds)
    const deadline = performance.now() + timeoutMs
    let settledAt: number | null = null
    while (performance.now() < deadline) {
      const [durableStored, sessionStored, tabs] = await Promise.all([
        chrome.storage.local.get(durableKey),
        chrome.storage.session.get(sessionKey),
        chrome.tabs.query({})
      ])
      const durable = durableStored[durableKey]
      const session = sessionStored[sessionKey]
      const durableEntries = isRecord(durable) && isRecord(durable.entries)
        ? durable.entries
        : {}
      const sessionEntries = isRecord(session) && isRecord(session.entries)
        ? session.entries
        : {}
      const tabsAbsent = !tabs.some((tab) => (
        (typeof tab.id === 'number' && expectedTabIdSet.has(tab.id)) ||
        (tab.url || tab.pendingUrl)?.startsWith(expectedUrlPrefix)
      ))
      const inventoryAbsent = expectedTabIds.every((tabId) => (
        !Object.hasOwn(durableEntries, String(tabId)) &&
        !Object.hasOwn(sessionEntries, String(tabId))
      ))
      if (tabsAbsent && inventoryAbsent) {
        settledAt ??= performance.now()
        if (performance.now() - settledAt >= quietMs) return
      } else {
        settledAt = null
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Timed out waiting for benchmark-tab close settlement')
  }, {
    durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
    quietMs: 250,
    sessionKey: OPEN_SURFACE_SESSION_STORAGE_KEY,
    tabIds,
    timeoutMs: 30_000,
    urlPrefix
  })
}

async function cleanupBenchmarkTabs(
  installedExtension: InstalledExtension,
  tabIds: readonly number[],
  urlPrefix: string,
  profile: SaturatedProfile
): Promise<void> {
  const removedIds = await installedExtension.serviceWorker.evaluate(async ({
    candidateTabIds,
    expectedUrlPrefix
  }) => {
    const candidateTabIdSet = new Set(candidateTabIds)
    const remaining = (await chrome.tabs.query({})).filter((tab) => (
      (typeof tab.id === 'number' && candidateTabIdSet.has(tab.id)) ||
      (tab.url || tab.pendingUrl)?.startsWith(expectedUrlPrefix)
    ))
    const remainingIds = remaining.flatMap((tab) => (
      typeof tab.id === 'number' ? [tab.id] : []
    ))
    if (remainingIds.length > 0) await chrome.tabs.remove(remainingIds)
    return remainingIds
  }, { candidateTabIds: tabIds, expectedUrlPrefix: urlPrefix })
  const allTabIds = [...new Set([...tabIds, ...removedIds])]
  await waitForClosedSurfaceSettlement(
    installedExtension.serviceWorker,
    allTabIds,
    urlPrefix
  )

  const emptyInventory = emptyOpenSurfaceInventory()
  await seedRetentionStorageState(installedExtension.serviceWorker, {
    durable: emptyInventory,
    ledger: profile.emptyPersistedLedger,
    representativeLocal: profile.representativeLocal,
    requireStartupRefresh: false,
    session: emptyInventory
  })
  const reset = await readInstalledProfile(installedExtension.serviceWorker)
  const sessionSurfaces = await installedExtension.serviceWorker.evaluate(async (key) => {
    const stored = (await chrome.storage.session.get(key))[key]
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return -1
    const entries = Reflect.get(stored, 'entries')
    return typeof entries === 'object' && entries !== null && !Array.isArray(entries)
      ? Object.keys(entries).length
      : -1
  }, OPEN_SURFACE_SESSION_STORAGE_KEY)
  if (
    reset.pages !== 0 ||
    reset.removalBoundaries !== 0 ||
    reset.durableSurfaces !== 0 ||
    sessionSurfaces !== 0 ||
    reset.ledgerSha256 !== sha256Json(profile.emptyPersistedLedger)
  ) {
    throw new Error('Benchmark cleanup did not restore the empty retention fixture')
  }
}

function singleCloseInventory(tabId: number): {
  readonly durable: OpenSurfaceInventory
  readonly session: OpenSurfaceInventory
} {
  const url = exactLengthUrl(
    'https://single-close.example.test/article?fixture=',
    2_048
  )
  const entry: OpenSurfaceInventoryEntry = {
    tabId,
    closureToken: fixedHex(3_000_000, 32),
    ...openSurfaceIdentityV1('normal-tab', url),
    surfaceKind: 'normal-tab',
    url,
    title: '🧪'.repeat(512),
    favIconUrl: exactLengthUrl(
      'https://assets.example.test/single-close?fixture=',
      2_048
    )
  }
  const inventory: OpenSurfaceInventory = {
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
    identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
    entries: { [String(tabId)]: entry }
  }
  return { durable: inventory, session: inventory }
}

function deterministicNoise(length: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
  let state = seed >>> 0
  let value = ''
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    value += alphabet[(state >>> 0) % alphabet.length]
  }
  return value
}

function overQuotaCandidateInventory(tabId: number): {
  readonly durable: OpenSurfaceInventory
  readonly session: OpenSurfaceInventory
} {
  const urlPrefix = 'https://over-quota.example.test/article?fixture='
  const faviconPrefix = 'https://assets.example.test/over-quota?fixture='
  const url = `${urlPrefix}${deterministicNoise(2_048 - urlPrefix.length, 11)}`
  const entry: OpenSurfaceInventoryEntry = {
    tabId,
    closureToken: fixedHex(4_000_000, 32),
    ...openSurfaceIdentityV1('normal-tab', url),
    surfaceKind: 'normal-tab',
    url,
    title: deterministicNoise(512, 12),
    favIconUrl: `${faviconPrefix}${deterministicNoise(
      2_048 - faviconPrefix.length,
      13
    )}`
  }
  const inventory: OpenSurfaceInventory = {
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
    identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
    entries: { [String(tabId)]: entry }
  }
  return { durable: inventory, session: inventory }
}

async function seedBurstState(
  worker: Worker,
  kind: ProfileKind,
  profile: SaturatedProfile,
  inventory: ReturnType<typeof burstInventory>
): Promise<void> {
  await seedRetentionStorageState(worker, {
    durable: inventory.durable,
    ledger: kind === 'saturated'
      ? profile.persistedLedger
      : profile.emptyPersistedLedger,
    representativeLocal: profile.representativeLocal,
    session: inventory.session,
    timeoutMs: CLOSE_BURST_SETUP_TIMEOUT_MS
  })
}

async function fillInstalledLocalQuota(worker: Worker): Promise<{
  readonly baseBytes: number
  readonly fillerLength: number
  readonly freeBytes: number
  readonly usedBytes: number
}> {
  return worker.evaluate(async ({ fillerKey, quotaBytes }) => {
    await chrome.storage.local.remove(fillerKey)
    const baseBytes = await chrome.storage.local.getBytesInUse(null)
    let fillerLength = Math.max(
      0,
      quotaBytes - baseBytes - fillerKey.length - 256
    )
    let accepted = false
    for (let attempt = 0; attempt < 32 && fillerLength > 0; attempt += 1) {
      try {
        await chrome.storage.local.set({ [fillerKey]: 'q'.repeat(fillerLength) })
        accepted = true
        break
      } catch {
        fillerLength = Math.max(0, fillerLength - 512)
      }
    }
    if (!accepted) throw new Error('Could not establish an accepted quota filler')

    let usedBytes = await chrome.storage.local.getBytesInUse(null)
    const growth = quotaBytes - usedBytes - 64
    if (growth > 0) {
      try {
        await chrome.storage.local.set({
          [fillerKey]: 'q'.repeat(fillerLength + growth)
        })
        fillerLength += growth
        usedBytes = await chrome.storage.local.getBytesInUse(null)
      } catch {
        // The already-accepted filler remains the prior valid state.
      }
    }
    return {
      baseBytes,
      fillerLength,
      freeBytes: quotaBytes - usedBytes,
      usedBytes
    }
  }, {
    fillerKey: QUOTA_FILLER_STORAGE_KEY,
    quotaBytes: CHROME_LOCAL_QUOTA_BYTES
  })
}

async function closeInstalledBurst(
  worker: Worker,
  tabIds: readonly number[],
  expectedCandidates: readonly IdentityTokenPair[],
  instrumentPhases = false
): Promise<InstalledBurstSample> {
  return worker.evaluate(async ({
    durableKey,
    expectedCandidateHash,
    expectedCandidates: candidatePairs,
    instrumentPhases: shouldInstrumentPhases,
    ledgerKey,
    sessionKey,
    startupSeedLock,
    tabIds: closeTabIds
  }) => {
    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    async function decodeLedger(value: unknown): Promise<unknown> {
      if (
        !isRecord(value) ||
        value.encoding !== 'gzip-base64-json-v1' ||
        typeof value.data !== 'string'
      ) return value
      const binary = atob(value.data)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      const stream = new Blob([bytes]).stream().pipeThrough(
        new DecompressionStream('gzip')
      )
      return JSON.parse(await new Response(stream).text())
    }

    async function sha256Text(value: string): Promise<string> {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value)
      )
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }

    type StorageGet = (
      keys?: string | readonly string[] | Record<string, unknown> | null
    ) => Promise<Record<string, unknown>>
    type StorageSet = (items: Record<string, unknown>) => Promise<void>
    type InstrumentedStorageArea = { get: StorageGet; set: StorageSet }
    type RawTrace = {
      area: string
      finishedAt: number
      items?: Record<string, unknown>
      keys?: unknown
      operation: string
      startedAt: number
    }

    const localArea = chrome.storage.local as unknown as InstrumentedStorageArea
    const sessionArea = chrome.storage.session as unknown as InstrumentedStorageArea
    const originalLocalGet = localArea.get.bind(localArea)
    const originalLocalSet = localArea.set.bind(localArea)
    const originalSessionGet = sessionArea.get.bind(sessionArea)
    const originalSessionSet = sessionArea.set.bind(sessionArea)
    const originalAlarmGet = chrome.alarms.get.bind(chrome.alarms)
    const originalAlarmCreate = chrome.alarms.create.bind(chrome.alarms)
    const originalLockRequest = navigator.locks.request.bind(navigator.locks)
    const originalResponseText = Response.prototype.text
    const originalResponseArrayBuffer = Response.prototype.arrayBuffer
    const rawTrace: RawTrace[] = []
    let collectTrace = true
    const ledgerSetCompletionTimes: number[] = []
    const ledgerSetStartedTimes: number[] = []
    let firstLedgerSetAt: number | null = null
    let ledgerSetCalls = 0
    let settleFirstLedgerSet: (() => void) | null = null
    const firstLedgerSet = new Promise<void>((resolve) => {
      settleFirstLedgerSet = resolve
    })
    const startupRefreshLockFlights: Array<{
      readonly completion: Promise<void>
      readonly startedAt: number
    }> = []

    function wrapGet(area: string, original: StorageGet): StorageGet {
      return async (keys) => {
        const startedAt = performance.now()
        try {
          return await original(keys)
        } finally {
          if (shouldInstrumentPhases && collectTrace) rawTrace.push({
            area,
            finishedAt: performance.now(),
            keys,
            operation: 'get',
            startedAt
          })
        }
      }
    }

    function wrapSet(area: 'local' | 'session', original: StorageSet): StorageSet {
      return async (items) => {
        const startedAt = performance.now()
        const writesLedger = area === 'local' && Object.hasOwn(items, ledgerKey)
        if (writesLedger) {
          ledgerSetCalls += 1
          ledgerSetStartedTimes.push(startedAt)
        }
        let succeeded = false
        try {
          await original(items)
          succeeded = true
        } finally {
          const finishedAt = performance.now()
          if (writesLedger && succeeded) {
            ledgerSetCompletionTimes.push(finishedAt)
            if (firstLedgerSetAt === null) {
              firstLedgerSetAt = finishedAt
              settleFirstLedgerSet?.()
            }
          }
          if (shouldInstrumentPhases && collectTrace) rawTrace.push({
            area,
            finishedAt,
            items,
            operation: 'set',
            startedAt
          })
        }
      }
    }

    // The gate always counts actual storage.local.set calls whose payload owns
    // the ledger key. Broader phase instrumentation is failure-diagnostic only.
    localArea.set = wrapSet('local', originalLocalSet)
    if (shouldInstrumentPhases) {
      localArea.get = wrapGet('local', originalLocalGet)
      sessionArea.get = wrapGet('session', originalSessionGet)
      sessionArea.set = wrapSet('session', originalSessionSet)
      chrome.alarms.get = (async (name: string) => {
        const startedAt = performance.now()
        try {
          return await originalAlarmGet(name)
        } finally {
          if (collectTrace) rawTrace.push({
            area: 'alarms',
            finishedAt: performance.now(),
            keys: name,
            operation: 'get',
            startedAt
          })
        }
      }) as typeof chrome.alarms.get
      chrome.alarms.create = (async (
        name: string,
        alarmInfo: chrome.alarms.AlarmCreateInfo
      ) => {
        const startedAt = performance.now()
        try {
          await originalAlarmCreate(name, alarmInfo)
        } finally {
          if (collectTrace) rawTrace.push({
            area: 'alarms',
            finishedAt: performance.now(),
            keys: name,
            operation: 'create',
            startedAt
          })
        }
      }) as typeof chrome.alarms.create
      Response.prototype.text = async function() {
        const startedAt = performance.now()
        try {
          return await originalResponseText.call(this)
        } finally {
          if (collectTrace) rawTrace.push({
            area: 'compression',
            finishedAt: performance.now(),
            operation: 'decompress-text',
            startedAt
          })
        }
      }
      Response.prototype.arrayBuffer = async function() {
        const startedAt = performance.now()
        try {
          return await originalResponseArrayBuffer.call(this)
        } finally {
          if (collectTrace) rawTrace.push({
            area: 'compression',
            finishedAt: performance.now(),
            operation: 'compress-array-buffer',
            startedAt
          })
        }
      }
    }
    navigator.locks.request = ((name: string, ...args: unknown[]) => {
      const startedAt = performance.now()
      const result = Reflect.apply(
        originalLockRequest,
        navigator.locks,
        [name, ...args]
      ) as Promise<unknown>
      if (name === startupSeedLock) {
        startupRefreshLockFlights.push({
          startedAt,
          completion: result.then(
            () => undefined,
            () => undefined
          )
        })
      }
      return result
    }) as typeof navigator.locks.request

    const closeTabIdSet = new Set(closeTabIds)
    let firstRemovalAt: number | null = null
    let lastRemovalAt: number | null = null
    let removedEvents = 0
    let settleAllRemovals: (() => void) | null = null
    const allRemovals = new Promise<void>((resolve) => {
      settleAllRemovals = resolve
    })
    const onTabRemoved = (tabId: number) => {
      if (!closeTabIdSet.has(tabId)) return
      const removedAt = performance.now()
      firstRemovalAt ??= removedAt
      lastRemovalAt = removedAt
      removedEvents += 1
      if (removedEvents === closeTabIds.length) settleAllRemovals?.()
    }
    async function withTimeout<Value>(
      promise: PromiseLike<Value>,
      message: string
    ): Promise<Value> {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          Promise.resolve(promise),
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(message)),
              30_000
            )
          })
        ])
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      }
    }

    chrome.tabs.onRemoved.addListener(onTabRemoved)
    const startedAt = performance.now()

    try {
      await chrome.tabs.remove([...closeTabIds])
      await Promise.all([
        withTimeout(firstLedgerSet, 'Timed out waiting for Retained Page Ledger'),
        withTimeout(allRemovals, 'Timed out waiting for tab removals')
      ])
      const removeCallToFirstLedgerSetMs =
        (firstLedgerSetAt ?? performance.now()) - startedAt

      const cleanupDeadline = performance.now() + 30_000
      let sessionSurfaces = -1
      let durableSurfaces = -1
      let completed = false
      while (performance.now() < cleanupDeadline) {
        const [sessionStored, durableStored] = await Promise.all([
          originalSessionGet(sessionKey),
          originalLocalGet(durableKey)
        ])
        const session = sessionStored[sessionKey]
        const durable = durableStored[durableKey]
        const sessionEntries = isRecord(session) && isRecord(session.entries)
          ? session.entries
          : {}
        const durableEntries = isRecord(durable) && isRecord(durable.entries)
          ? durable.entries
          : {}
        sessionSurfaces = Object.keys(sessionEntries).length
        durableSurfaces = Object.keys(durableEntries).length
        if (closeTabIds.every((tabId) => (
          !Object.hasOwn(sessionEntries, String(tabId)) &&
          !Object.hasOwn(durableEntries, String(tabId))
        ))) {
          completed = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const cleanupMs = performance.now() - startedAt
      await new Promise((resolve) => setTimeout(resolve, 25))
      const finalLedgerSetAt = ledgerSetCompletionTimes.at(-1) ?? firstLedgerSetAt
      const ledgerAfterLastRemovalMs = finalLedgerSetAt === null || lastRemovalAt === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, finalLedgerSetAt - lastRemovalAt)
      const removeCallToFinalLedgerSetMs = finalLedgerSetAt === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, finalLedgerSetAt - startedAt)
      const eventDeliveryMs = firstRemovalAt === null || lastRemovalAt === null
        ? Number.POSITIVE_INFINITY
        : lastRemovalAt - firstRemovalAt
      collectTrace = false

      const finalLedgerSetStartedAt = ledgerSetStartedTimes.at(-1)
      const startupRefreshDeadline = performance.now() + 30_000
      let startupRefreshFlight: (typeof startupRefreshLockFlights)[number] | undefined
      while (
        finalLedgerSetStartedAt !== undefined &&
        startupRefreshFlight === undefined &&
        performance.now() < startupRefreshDeadline
      ) {
        startupRefreshFlight = startupRefreshLockFlights.findLast(
          (flight) => flight.startedAt >= finalLedgerSetStartedAt
        )
        if (!startupRefreshFlight) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (!startupRefreshFlight) {
        throw new Error('Timed out waiting for the ledger-triggered Startup Snapshot refresh')
      }
      await withTimeout(
        startupRefreshFlight.completion,
        'Timed out waiting for the Startup Snapshot write lock to settle'
      )

      const storedLedger = (await originalLocalGet(ledgerKey))[ledgerKey]
      const ledger = await decodeLedger(storedLedger)
      const pages = isRecord(ledger) && isRecord(ledger.pages)
        ? Object.keys(ledger.pages).length
        : 0
      const removalBoundaries = isRecord(ledger) && isRecord(ledger.removalBoundaries)
        ? Object.keys(ledger.removalBoundaries).length
        : 0
      const actualIdentityTokens: Array<readonly [string, string]> = []
      const actualTokenByIdentity = new Map<string, string>()
      if (isRecord(ledger) && isRecord(ledger.pages)) {
        for (const [identityDigest, page] of Object.entries(ledger.pages)) {
          if (!isRecord(page) || typeof page.closureToken !== 'string') continue
          actualIdentityTokens.push([identityDigest, page.closureToken])
          actualTokenByIdentity.set(identityDigest, page.closureToken)
        }
      }
      actualIdentityTokens.sort(([leftIdentity, leftToken], [rightIdentity, rightToken]) => (
        leftIdentity.localeCompare(rightIdentity) || leftToken.localeCompare(rightToken)
      ))
      const candidatePageIdentityTokenSha256 = await sha256Text(
        JSON.stringify(actualIdentityTokens)
      )
      const candidatePagesMatched = candidatePairs.filter(([
        identityDigest,
        closureToken
      ]) => actualTokenByIdentity.get(identityDigest) === closureToken).length
      const phaseTrace = []
      for (const call of rawTrace) {
        const callKeys = call.items
          ? Object.keys(call.items)
          : Array.isArray(call.keys)
            ? call.keys.map(String)
            : call.keys === undefined ? [] : [String(call.keys)]
        if (
          (call.area === 'local' || call.area === 'session') &&
          !callKeys.some((key) => (
            key === ledgerKey ||
            key === durableKey ||
            key === sessionKey ||
            key === 'tabOutRetentionHealthV1'
          ))
        ) continue
        const detail: {
          area: string
          durationMs: number
          inventory?: { entries: number; markedClosed: number }
          keys?: readonly string[]
          ledger?: { pages: number; removalBoundaries: number }
          operation: string
          startMs: number
        } = {
          area: call.area,
          durationMs: call.finishedAt - call.startedAt,
          operation: call.operation,
          startMs: call.startedAt - startedAt
        }
        if (call.items) {
          detail.keys = callKeys
          const inventoryValue = call.items[sessionKey] ?? call.items[durableKey]
          if (isRecord(inventoryValue) && isRecord(inventoryValue.entries)) {
            const entries = Object.values(inventoryValue.entries)
            detail.inventory = {
              entries: entries.length,
              markedClosed: entries.filter((entry) => (
                isRecord(entry) && typeof entry.closedAt === 'number'
              )).length
            }
          }
          if (call.items[ledgerKey] !== undefined) {
            const writtenLedger = await decodeLedger(call.items[ledgerKey])
            detail.ledger = {
              pages: isRecord(writtenLedger) && isRecord(writtenLedger.pages)
                ? Object.keys(writtenLedger.pages).length
                : -1,
              removalBoundaries: isRecord(writtenLedger) &&
                isRecord(writtenLedger.removalBoundaries)
                ? Object.keys(writtenLedger.removalBoundaries).length
                : -1
            }
          }
        } else if (call.keys !== undefined) {
          detail.keys = callKeys
        }
        phaseTrace.push(detail)
      }

      return {
        candidatePageIdentityTokenSha256,
        candidatePagesExpected: candidatePairs.length,
        candidatePagesMatched,
        completed: completed && removedEvents === closeTabIds.length,
        cleanupMs,
        durableSurfaces,
        eventDeliveryMs,
        expectedCandidatePageIdentityTokenSha256: expectedCandidateHash,
        ledgerAfterLastRemovalMs,
        ledgerSetCalls,
        pages,
        ...(shouldInstrumentPhases ? { phaseTrace } : {}),
        removedEvents,
        removeCallToFinalLedgerSetMs,
        removeCallToFirstLedgerSetMs,
        removalBoundaries,
        sessionSurfaces
      }
    } finally {
      chrome.tabs.onRemoved.removeListener(onTabRemoved)
      localArea.set = originalLocalSet
      navigator.locks.request = originalLockRequest
      if (shouldInstrumentPhases) {
        localArea.get = originalLocalGet
        sessionArea.get = originalSessionGet
        sessionArea.set = originalSessionSet
        chrome.alarms.get = originalAlarmGet
        chrome.alarms.create = originalAlarmCreate
        Response.prototype.text = originalResponseText
        Response.prototype.arrayBuffer = originalResponseArrayBuffer
      }
    }
  }, {
    durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
    expectedCandidateHash: candidateIdentityTokenSha256(expectedCandidates),
    expectedCandidates,
    instrumentPhases,
    ledgerKey: RETAINED_PAGES_STORAGE_KEY,
    sessionKey: OPEN_SURFACE_SESSION_STORAGE_KEY,
    startupSeedLock: STARTUP_SEED_WRITE_LOCK,
    tabIds
  })
}

async function measureBurstState(
  installedExtension: InstalledExtension,
  kind: ProfileKind,
  profile: SaturatedProfile,
  instrumentPhases = false
): Promise<InstalledBurstSample> {
  const urlPrefix = nextBenchmarkTabUrlPrefix()
  const controlPage = await openDashboardServiceController(installedExtension)
  let tabIds: readonly number[] = []
  try {
    const creation = await createBenchmarkTabs(
      installedExtension.serviceWorker,
      urlPrefix
    )
    tabIds = creation.tabIds
    if (creation.failures.length > 0 || tabIds.length !== BENCHMARK_TAB_COUNT) {
      throw new Error(
        `Created ${tabIds.length}/${BENCHMARK_TAB_COUNT} benchmark tabs: ` +
        creation.failures.join('; ')
      )
    }
    // The real onCreated checkpoint waits behind initial reconciliation and
    // its expiry-alarm synchronization. Keep that fixture work outside the
    // measured close by requiring both inventories to contain every new tab,
    // then drain Activation History and Dashboard service work queued by those
    // 500 real onCreated events before the storage seed starts.
    await waitForOpenSurfaceCheckpoint(
      installedExtension.serviceWorker,
      tabIds,
      CLOSE_BURST_SETUP_TIMEOUT_MS
    )
    await waitForDashboardServiceQueue(controlPage)
    const inventory = burstInventory(tabIds)
    await seedBurstState(
      installedExtension.serviceWorker,
      kind,
      profile,
      inventory
    )
    return await closeInstalledBurst(
      installedExtension.serviceWorker,
      tabIds,
      candidateIdentityTokens(inventory.session),
      instrumentPhases
    )
  } finally {
    try {
      await cleanupBenchmarkTabs(installedExtension, tabIds, urlPrefix, profile)
    } finally {
      await controlPage.close().catch(() => undefined)
    }
  }
}

async function measureSingleCloseState(
  installedExtension: InstalledExtension,
  kind: ProfileKind,
  profile: SaturatedProfile
): Promise<InstalledBurstSample> {
  const urlPrefix = nextBenchmarkTabUrlPrefix()
  let tabIds: readonly number[] = []
  try {
    const creation = await createBenchmarkTabs(
      installedExtension.serviceWorker,
      urlPrefix,
      1
    )
    tabIds = creation.tabIds
    const tabId = tabIds[0]
    if (creation.failures.length > 0 || tabId === undefined) {
      throw new Error(
        `Chrome did not create the close target: ${creation.failures.join('; ')}`
      )
    }
    await waitForOpenSurfaceCheckpoint(installedExtension.serviceWorker, [tabId])
    const inventory = singleCloseInventory(tabId)
    await seedBurstState(
      installedExtension.serviceWorker,
      kind,
      profile,
      inventory
    )
    return await closeInstalledBurst(
      installedExtension.serviceWorker,
      [tabId],
      candidateIdentityTokens(inventory.session)
    )
  } finally {
    await cleanupBenchmarkTabs(installedExtension, tabIds, urlPrefix, profile)
  }
}

async function runPairedSingleCloseSample(
  installedExtension: InstalledExtension,
  profile: SaturatedProfile,
  pairIndex: number
): Promise<PairedBurstSample> {
  const order: readonly ProfileKind[] = pairIndex % 2 === 0
    ? ['empty', 'saturated']
    : ['saturated', 'empty']
  const samples = new Map<ProfileKind, InstalledBurstSample>()
  for (const kind of order) {
    samples.set(kind, await measureSingleCloseState(installedExtension, kind, profile))
  }
  const empty = samples.get('empty')
  const saturated = samples.get('saturated')
  if (!empty || !saturated) throw new Error('Paired single-close sample did not complete')
  return { empty, saturated }
}

async function measureColdSingleCloseState(
  installedExtension: InstalledExtension,
  kind: ProfileKind,
  profile: SaturatedProfile
): Promise<InstalledColdCloseSample> {
  const urlPrefix = nextBenchmarkTabUrlPrefix()
  const controlPage = await installedExtension.context.newPage()
  const interceptedScriptPaths = new Set<string>()
  let tabIds: readonly number[] = []

  await controlPage.route(
    /\/dist\/(?:app|filter-focus-boot)\.js$/,
    async (route) => {
      interceptedScriptPaths.add(new URL(route.request().url()).pathname)
      await route.fulfill({
      body: '',
      contentType: 'application/javascript',
      status: 200
      })
    }
  )

  try {
    const creation = await createBenchmarkTabs(
      installedExtension.serviceWorker,
      urlPrefix,
      1
    )
    tabIds = creation.tabIds
    const tabId = tabIds[0]
    if (creation.failures.length > 0 || tabId === undefined) {
      throw new Error(
        `Chrome did not create the cold-close target: ${creation.failures.join('; ')}`
      )
    }
    await waitForOpenSurfaceCheckpoint(installedExtension.serviceWorker, [tabId])
    await controlPage.goto(
      `chrome-extension://${installedExtension.extensionId}/index.html?retention-benchmark=cold-close`,
      { waitUntil: 'domcontentloaded' }
    )
    expect([...interceptedScriptPaths].sort()).toEqual([
      '/dist/app.js',
      '/dist/filter-focus-boot.js'
    ])

    const inventory = singleCloseInventory(tabId)
    const candidate = candidateIdentityTokens(inventory.session)[0]
    if (!candidate) {
      throw new Error('Cold-close fixture did not create one exact candidate')
    }
    const [identityDigest, closureToken] = candidate
    const expectedPage = inventory.session.entries[String(tabId)]
    if (!expectedPage) {
      throw new Error('Cold-close fixture omitted its exact persisted snapshot')
    }
    await seedBurstState(
      installedExtension.serviceWorker,
      kind,
      profile,
      inventory
    )

    const capabilities = await controlPage.evaluate(({
      candidateIdentityDigest,
      candidateClosureToken,
      controllerKey,
      expectedCandidate,
      ledgerKey,
      settleMessageType,
      targetTabId,
      timeoutMs
    }) => {
      type Observation = {
        readonly candidatePagesMatched: number
        readonly ledgerPublicationToSettlementMs: number
        readonly pages: number
        readonly removalBoundaries: number
        readonly removalToLedgerPublicationMs: number
        readonly removalToSettlementMs: number
      }
      type Controller = { readonly observation: Promise<Observation> }

      function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      }

      async function decodeLedger(value: unknown): Promise<unknown> {
        if (
          !isRecord(value) ||
          value.encoding !== 'gzip-base64-json-v1' ||
          typeof value.data !== 'string'
        ) return value
        const binary = atob(value.data)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index)
        }
        const stream = new Blob([bytes]).stream().pipeThrough(
          new DecompressionStream('gzip')
        )
        return JSON.parse(await new Response(stream).text())
      }

      let ledgerPublishedAt: number | null = null
      let ledgerCounts: { pages: number; removalBoundaries: number } | null = null
      let removalAt: number | null = null
      let settlementAt: number | null = null

      const observation = new Promise<Observation>((resolve, reject) => {
        let settled = false
        const timeoutHandle = setTimeout(() => {
          fail(new Error('Timed out waiting for cold Retained Page capture'))
        }, timeoutMs)

        const cleanup = () => {
          clearTimeout(timeoutHandle)
          chrome.tabs.onRemoved.removeListener(onRemoved)
          chrome.storage.onChanged.removeListener(onStorageChanged)
        }
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
        const finish = () => {
          if (
            settled ||
            ledgerPublishedAt === null ||
            ledgerCounts === null ||
            removalAt === null ||
            settlementAt === null
          ) return
          settled = true
          cleanup()
          resolve({
            candidatePagesMatched: 1,
            ledgerPublicationToSettlementMs:
              settlementAt - ledgerPublishedAt,
            pages: ledgerCounts.pages,
            removalBoundaries: ledgerCounts.removalBoundaries,
            removalToLedgerPublicationMs: ledgerPublishedAt - removalAt,
            removalToSettlementMs: settlementAt - removalAt
          })
        }
        const onRemoved = (removedTabId: number) => {
          if (removedTabId !== targetTabId || removalAt !== null) return
          removalAt = performance.now()
          void chrome.runtime.sendMessage({
            type: settleMessageType,
            tabId: targetTabId
          }).then((response: unknown) => {
            if (!isRecord(response) || response.ok !== true) {
              fail(new Error('Cold capture settlement was not acknowledged'))
              return
            }
            settlementAt = performance.now()
            finish()
          }, fail)
        }
        const onStorageChanged = (
          changes: Record<string, chrome.storage.StorageChange>,
          areaName: string
        ) => {
          if (areaName !== 'local' || !Object.hasOwn(changes, ledgerKey)) return
          const observedAt = performance.now()
          void decodeLedger(changes[ledgerKey]?.newValue).then((ledger) => {
            if (!isRecord(ledger) || !isRecord(ledger.pages)) return
            const candidate = ledger.pages[candidateIdentityDigest]
            if (
              !isRecord(candidate) ||
              candidate.closureToken !== candidateClosureToken
            ) return
            if (
              candidate.surfaceKind !== expectedCandidate.surfaceKind ||
              candidate.url !== expectedCandidate.url ||
              candidate.title !== expectedCandidate.title ||
              candidate.favIconUrl !== expectedCandidate.favIconUrl ||
              typeof candidate.closedAt !== 'number' ||
              !Number.isSafeInteger(candidate.closedAt)
            ) {
              fail(new Error('Cold capture changed the maximum-sized exact snapshot'))
              return
            }
            ledgerPublishedAt = observedAt
            ledgerCounts = {
              pages: Object.keys(ledger.pages).length,
              removalBoundaries: isRecord(ledger.removalBoundaries)
                ? Object.keys(ledger.removalBoundaries).length
                : -1
            }
            finish()
          }).catch(fail)
        }

        chrome.tabs.onRemoved.addListener(onRemoved)
        chrome.storage.onChanged.addListener(onStorageChanged)
      })
      Reflect.set(globalThis, controllerKey, { observation } satisfies Controller)
      return {
        extensionId: chrome.runtime.id,
        hasStorageChangedListener:
          typeof chrome.storage?.onChanged?.addListener === 'function',
        hasTabsRemovedListener:
          typeof chrome.tabs?.onRemoved?.addListener === 'function'
      }
    }, {
      candidateClosureToken: closureToken,
      candidateIdentityDigest: identityDigest,
      controllerKey: COLD_CLOSE_CONTROLLER_KEY,
      expectedCandidate: {
        favIconUrl: expectedPage.favIconUrl,
        surfaceKind: expectedPage.surfaceKind,
        title: expectedPage.title,
        url: expectedPage.url
      },
      ledgerKey: RETAINED_PAGES_STORAGE_KEY,
      settleMessageType: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
      targetTabId: tabId,
      timeoutMs: 30_000
    })
    expect(capabilities).toEqual({
      extensionId: installedExtension.extensionId,
      hasStorageChangedListener: true,
      hasTabsRemovedListener: true
    })

    const close = await closeInstalledTargetWithWorkerTerminated(
      installedExtension,
      controlPage,
      urlPrefix,
      () => controlPage.evaluate(async (controllerKey) => {
        type Observation = {
          readonly candidatePagesMatched: number
          readonly ledgerPublicationToSettlementMs: number
          readonly pages: number
          readonly removalBoundaries: number
          readonly removalToLedgerPublicationMs: number
          readonly removalToSettlementMs: number
        }
        const controller = Reflect.get(globalThis, controllerKey) as
          | { readonly observation?: Promise<Observation> }
          | undefined
        if (!controller?.observation) {
          throw new Error('Cold-close controller was not armed')
        }
        return controller.observation
      }, COLD_CLOSE_CONTROLLER_KEY)
    )
    const observation = close.observation

    await waitForClosedSurfaceSettlement(
      installedExtension.serviceWorker,
      [tabId],
      urlPrefix
    )
    const [reading, sessionSurfaces] = await Promise.all([
      readInstalledProfile(installedExtension.serviceWorker),
      installedExtension.serviceWorker.evaluate(async (key) => {
        const stored = (await chrome.storage.session.get(key))[key]
        if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
          return -1
        }
        const entries = Reflect.get(stored, 'entries')
        return typeof entries === 'object' && entries !== null && !Array.isArray(entries)
          ? Object.keys(entries).length
          : -1
      }, OPEN_SURFACE_SESSION_STORAGE_KEY)
    ])

    return {
      ...observation,
      closeCommandToSettlementObservationMs:
        close.closeCommandToObservationMs,
      completed: observation.candidatePagesMatched === 1 &&
        reading.durableSurfaces === 0 && sessionSurfaces === 0,
      durableSurfaces: reading.durableSurfaces,
      pages: reading.pages,
      removalBoundaries: reading.removalBoundaries,
      sessionSurfaces,
      workerAbsentBeforeClose: true
    }
  } finally {
    await controlPage.close().catch(() => undefined)
    await cleanupBenchmarkTabs(installedExtension, tabIds, urlPrefix, profile)
  }
}

async function runPairedColdSingleCloseSample(
  installedExtension: InstalledExtension,
  profile: SaturatedProfile,
  pairIndex: number
): Promise<PairedColdCloseSample> {
  const order: readonly ProfileKind[] = pairIndex % 2 === 0
    ? ['empty', 'saturated']
    : ['saturated', 'empty']
  const samples = new Map<ProfileKind, InstalledColdCloseSample>()
  for (const kind of order) {
    samples.set(
      kind,
      await measureColdSingleCloseState(installedExtension, kind, profile)
    )
  }
  const empty = samples.get('empty')
  const saturated = samples.get('saturated')
  if (!empty || !saturated) {
    throw new Error('Paired cold single-close sample did not complete')
  }
  return { empty, saturated }
}

async function runPairedBurstSample(
  installedExtension: InstalledExtension,
  profile: SaturatedProfile,
  pairIndex: number
): Promise<PairedBurstSample> {
  const order: readonly ProfileKind[] = pairIndex % 2 === 0
    ? ['empty', 'saturated']
    : ['saturated', 'empty']
  const samples = new Map<ProfileKind, InstalledBurstSample>()
  for (const kind of order) {
    samples.set(kind, await measureBurstState(installedExtension, kind, profile))
  }
  const empty = samples.get('empty')
  const saturated = samples.get('saturated')
  if (!empty || !saturated) throw new Error('Paired burst sample did not complete')
  return { empty, saturated }
}

test('installed minimum-Chrome retained keys and complete representative local storage stay within budgets', async ({
  installedExtension
}, testInfo) => {
  test.skip(MEASURED_PAIR_COUNT === 0, 'No measured benchmark pairs requested')
  const userAgent = await installedExtension.serviceWorker.evaluate(() => navigator.userAgent)
  expect(userAgent).toContain(`Chrome/${chromeSupportPolicy.minimumMajor}.`)

  const profile = await saturatedProfile()
  const samples: PairedProfileSample[] = []
  for (let index = 0; index < WARMUP_PAIR_COUNT; index += 1) {
    await runPairedProfileSample(installedExtension, profile, index)
  }
  for (let index = 0; index < MEASURED_PAIR_COUNT; index += 1) {
    samples.push(await runPairedProfileSample(
      installedExtension,
      profile,
      WARMUP_PAIR_COUNT + index
    ))
  }
  // Keep benchmark-only decompression, recursive hashing, exact readback, and
  // quota inspection out of the entire timing phase. Running those operations
  // after every navigation leaves multi-megabyte worker allocations for a
  // later pair and creates periodic GC stalls inside the product gate.
  const diagnosticSamples: PairedProfileDiagnostic[] = []
  for (let index = 0; index < MEASURED_PAIR_COUNT; index += 1) {
    diagnosticSamples.push(await runPairedProfileDiagnostic(
      installedExtension,
      profile,
      WARMUP_PAIR_COUNT + index
    ))
  }

  const pageLocalStartupContributions = samples.map(({ empty, saturated }) => (
    saturated.startupFrameReadyMs - empty.startupFrameReadyMs
  ))
  const pageLocalRequestStartContributions = samples.map(({
    empty,
    saturated
  }) => (
    saturated.serviceStateRequestStartedAtMs -
      empty.serviceStateRequestStartedAtMs
  ))
  const wallObservationContributions = samples.map(({ empty, saturated }) => (
    saturated.wallToHeaderObservationMs - empty.wallToHeaderObservationMs
  ))
  const decodeContributions = diagnosticSamples.map(({ empty, saturated }) => (
    saturated.probeDecodeAndPruneMs - empty.probeDecodeAndPruneMs
  ))
  const retainedBytes = diagnosticSamples.map(({
    saturated
  }) => saturated.retainedLocalBytes)
  const observedLocalBytes = diagnosticSamples.map(({
    saturated
  }) => saturated.observedLocalBytes)
  const report = {
    authority: {
      browser: userAgent,
      profile: 'real installed extension in Playwright bundled minimum-Chrome',
      storageTransition: 'one storage.local.set atomically installs the complete representative local profile, ledger, and durable inventory; the seed barrier spans the complete tab-event debounce horizon, observes the resulting read and Startup Snapshot lock, then requires lock release and 250ms storage quiet',
      measurementOrder: `all timed navigations run immediately after their seed barriers; only after the complete timing phase finishes does a separate ${MEASURED_PAIR_COUNT}-pair diagnostic phase perform footprint, full-ledger decode, recursive hash, and exact readback work`,
      pageLifecycle: 'each empty or saturated measurement owns one fresh extension page that is closed after header publication and visible-chip inspection',
      startupFrameGate: 'paired page-local performance.now() from the navigation document time origin to the synchronous header-stats aria-hidden publication that admits the complete Startup Frame',
      automationObservation: 'Node wall time through page.goto and Playwright locator observation is diagnostic only because CDP transport and assertion polling are outside the product seam',
      workerRead: 'manual post-quiescence decode/prune probe and the measured Dashboard request run with the installed service worker already warm'
    },
    runPlan: {
      warmupPairs: WARMUP_PAIR_COUNT,
      measuredPairs: MEASURED_PAIR_COUNT,
      order: 'empty/saturated order alternates for every pair',
      diagnosticPairs: diagnosticSamples.length,
      diagnosticIsolation: 'the exact-readback phase begins only after every timed pair completes'
    },
    profile: {
      retainedPages: RETAINED_PAGE_CAPACITY,
      retainedPageSizes: { url: 2_048, titleCodePoints: 512, favicon: 2_048 },
      removalBoundaries: RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES,
      durableInventorySurfaces: RETAINED_STORAGE_PROFILE_DURABLE_SURFACES,
      completeRepresentativeLocal: {
        version: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_VERSION,
        unrelatedKeys: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS.length,
        totalSteadyStateKeys:
          COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS.length + 2,
        counts: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS,
        fixtureSha256: profile.representativeLocalFixtureSha256,
        stableKeysSha256: profile.representativeLocalStableSha256,
        liveMutableKeys:
          COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS
      }
    },
    bytes: {
      retainedKeys: distribution(retainedBytes),
      completeRepresentativeLocal: distribution(observedLocalBytes),
      retainedBudget: RETAINED_LOCAL_BUDGET_BYTES,
      completeBudget: COMPLETE_LOCAL_BUDGET_BYTES,
      completeLocalGate: `evaluated against ${COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_VERSION}`
    },
    preHeaderServiceStateRequestCounts: {
      saturated: distribution(samples.map(({
        saturated
      }) => saturated.preHeaderServiceStateRequestCount)),
      pairedContribution: distribution(samples.map(({ empty, saturated }) => (
        saturated.preHeaderServiceStateRequestCount -
          empty.preHeaderServiceStateRequestCount
      )))
    },
    timingMs: {
      saturatedPageLocalRequestStart: distribution(
        samples.map(({ saturated }) => saturated.serviceStateRequestStartedAtMs)
      ),
      pairedPageLocalRequestStartContribution: distribution(
        pageLocalRequestStartContributions
      ),
      saturatedLatestPreHeaderServiceStateRequest: distribution(
        samples.map(({ saturated }) => saturated.serviceStateRequestMs)
      ),
      pairedLatestPreHeaderServiceStateRequestContribution: distribution(samples.map(({
        empty,
        saturated
      }) => saturated.serviceStateRequestMs - empty.serviceStateRequestMs)),
      saturatedLatestServiceStateToHeader: distribution(
        samples.map(({ saturated }) => saturated.serviceStateToHeaderMs)
      ),
      pairedLatestServiceStateToHeaderContribution: distribution(samples.map(({
        empty,
        saturated
      }) => saturated.serviceStateToHeaderMs - empty.serviceStateToHeaderMs)),
      saturatedProbeDecodeAndPrune: distribution(
        diagnosticSamples.map(({ saturated }) => saturated.probeDecodeAndPruneMs)
      ),
      pairedProbeDecodeAndPruneContribution: distribution(decodeContributions),
      saturatedPageLocalStartupFrameReady: distribution(
        samples.map(({ saturated }) => saturated.startupFrameReadyMs)
      ),
      pairedPageLocalStartupFrameContribution: distribution(
        pageLocalStartupContributions
      ),
      saturatedWallToHeaderObservation: distribution(
        samples.map(({ saturated }) => saturated.wallToHeaderObservationMs)
      ),
      pairedWallToHeaderObservationContribution: distribution(
        wallObservationContributions
      ),
      startupContributionP95Budget: STARTUP_CONTRIBUTION_P95_BUDGET_MS
    },
    exactReadback: {
      expectedLedgerSha256: profile.ledgerSha256,
      expectedDurableInventorySha256: profile.durableInventorySha256,
      samples: diagnosticSamples.map(({ empty, saturated }, index) => {
        const timing = samples[index]
        if (!timing) {
          throw new Error('Exact readback has no corresponding timing sample')
        }
        return {
          pages: saturated.pages,
          removalBoundaries: saturated.removalBoundaries,
          durableSurfaces: saturated.durableSurfaces,
          representativeLocalKeysPresent:
            saturated.representativeLocalKeysPresent,
          observedRepresentativeLocalSha256: {
            empty: empty.representativeLocalSha256,
            saturated: saturated.representativeLocalSha256
          },
          stableRepresentativeLocalSha256: {
            empty: empty.representativeLocalStableSha256,
            saturated: saturated.representativeLocalStableSha256
          },
          preHeaderServiceStateRequestCount: {
            empty: timing.empty.preHeaderServiceStateRequestCount,
            saturated: timing.saturated.preHeaderServiceStateRequestCount
          },
          visiblePageChips: timing.saturated.visiblePageChips,
          ledgerSha256: saturated.ledgerSha256,
          durableInventorySha256: saturated.durableInventorySha256
        }
      })
    },
    explicitGaps: [
      'The authoritative Startup Frame delta uses the navigation document clock and exact header publication; the Playwright wall observation remains diagnostic and intentionally includes automation overhead.',
      'Pre-header service-request counts are workload diagnostics and lower-bound capture attempts; request segments describe the request with the latest start before header publication.',
      'probeDecodeAndPrune runs in the isolated post-timing diagnostic phase; the full Dashboard Startup Frame timing is a warm post-quiescence measurement over the real stored encoding, and the cold one-close lifecycle is measured in its separate physical-target lane.'
    ]
  }
  await testInfo.attach('closed-tab-retention-installed-profile.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  console.log(`closed-tab-retention installed profile benchmark: ${JSON.stringify(report)}`)

  for (const { empty, saturated } of diagnosticSamples) {
    expect(empty.pages).toBe(0)
    expect(empty.removalBoundaries).toBe(0)
    expect(empty.durableSurfaces).toBe(0)
    expect(saturated.pages).toBe(RETAINED_PAGE_CAPACITY)
    expect(saturated.removalBoundaries).toBe(
      RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES
    )
    expect(saturated.durableSurfaces).toBe(
      RETAINED_STORAGE_PROFILE_DURABLE_SURFACES
    )
    expect(empty.representativeLocalKeysPresent).toBe(
      COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS.length
    )
    expect(saturated.representativeLocalKeysPresent).toBe(
      COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS.length
    )
    expect(empty.representativeLocalStableSha256).toBe(
      profile.representativeLocalStableSha256
    )
    expect(saturated.representativeLocalStableSha256).toBe(
      profile.representativeLocalStableSha256
    )
    expect(saturated.ledgerSha256).toBe(profile.ledgerSha256)
    expect(saturated.durableInventorySha256).toBe(
      profile.durableInventorySha256
    )
  }
  for (const { empty, saturated } of samples) {
    expect(empty.preHeaderServiceStateRequestCount).toBeGreaterThan(0)
    expect(saturated.preHeaderServiceStateRequestCount).toBeGreaterThan(0)
    expect(empty.serviceStateRequestStartedAtMs).toBeGreaterThanOrEqual(0)
    expect(saturated.serviceStateRequestStartedAtMs).toBeGreaterThanOrEqual(0)
    expect(empty.serviceStateToHeaderMs).toBeGreaterThanOrEqual(0)
    expect(saturated.serviceStateToHeaderMs).toBeGreaterThanOrEqual(0)
    // Existing same-title folding and overflow presentation intentionally mean
    // physical Page Chip nodes are not a one-to-one persistence count.
    expect(saturated.visiblePageChips).toBeGreaterThan(0)
  }
  expect(Math.max(...retainedBytes)).toBeLessThanOrEqual(
    RETAINED_LOCAL_BUDGET_BYTES
  )
  expect(Math.max(...observedLocalBytes)).toBeLessThanOrEqual(
    COMPLETE_LOCAL_BUDGET_BYTES
  )
  expect(percentile(pageLocalStartupContributions, 0.95)).toBeLessThanOrEqual(
    STARTUP_CONTRIBUTION_P95_BUDGET_MS
  )
})

test('installed minimum-Chrome records warm single-close mutation timing', async ({
  installedExtension
}, testInfo) => {
  test.skip(MEASURED_PAIR_COUNT === 0, 'No measured benchmark pairs requested')
  const profile = await saturatedProfile()
  const samples: PairedBurstSample[] = []
  for (let index = 0; index < WARMUP_PAIR_COUNT; index += 1) {
    await runPairedSingleCloseSample(installedExtension, profile, index)
  }
  for (let index = 0; index < MEASURED_PAIR_COUNT; index += 1) {
    samples.push(await runPairedSingleCloseSample(
      installedExtension,
      profile,
      WARMUP_PAIR_COUNT + index
    ))
  }

  const report = {
    authority: 'real installed-extension tabs.onRemoved path with one maximum-sized retained candidate',
    runPlan: {
      warmupPairs: WARMUP_PAIR_COUNT,
      measuredPairs: MEASURED_PAIR_COUNT,
      order: 'empty/saturated order alternates for every pair'
    },
    timingMs: {
      emptyRemoveCallToFirstLedgerSet: distribution(
        samples.map(({ empty }) => empty.removeCallToFirstLedgerSetMs)
      ),
      saturatedRemoveCallToFirstLedgerSet: distribution(
        samples.map(({ saturated }) => saturated.removeCallToFirstLedgerSetMs)
      ),
      emptyRemoveCallToFinalLedgerSet: distribution(
        samples.map(({ empty }) => empty.removeCallToFinalLedgerSetMs)
      ),
      saturatedRemoveCallToFinalLedgerSet: distribution(
        samples.map(({ saturated }) => saturated.removeCallToFinalLedgerSetMs)
      ),
      emptyLastRemovalToFinalLedger: distribution(samples.map(({ empty }) => empty.ledgerAfterLastRemovalMs)),
      saturatedLastRemovalToFinalLedger: distribution(samples.map(({ saturated }) => saturated.ledgerAfterLastRemovalMs)),
      emptyInventoryCleanup: distribution(samples.map(({ empty }) => empty.cleanupMs)),
      saturatedInventoryCleanup: distribution(samples.map(({ saturated }) => saturated.cleanupMs)),
      warmLastRemovalToFinalLedgerP95Budget: WARM_SINGLE_CLOSE_P95_BUDGET_MS
    },
    writes: {
      authority: 'actual storage.local.set calls whose items include the Retained Page Ledger key',
      empty: samples.map(({ empty }) => empty.ledgerSetCalls),
      saturated: samples.map(({ saturated }) => saturated.ledgerSetCalls)
    },
    companionGate: 'the forced-cold distribution is measured separately with an external extension-page observer so worker termination remains real'
  }
  await testInfo.attach('closed-tab-retention-installed-single-close.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  console.log(`closed-tab-retention installed single-close benchmark: ${JSON.stringify(report)}`)

  for (const { empty, saturated } of samples) {
    expect(empty.completed).toBe(true)
    expect(empty.pages).toBe(1)
    expect(empty.candidatePagesMatched).toBe(1)
    expect(empty.sessionSurfaces).toBe(0)
    expect(empty.durableSurfaces).toBe(0)
    expect(empty.ledgerSetCalls).toBe(1)
    expect(saturated.completed).toBe(true)
    expect(saturated.pages).toBe(RETAINED_PAGE_CAPACITY)
    expect(saturated.candidatePagesMatched).toBe(1)
    expect(saturated.sessionSurfaces).toBe(0)
    expect(saturated.durableSurfaces).toBe(0)
    expect(saturated.ledgerSetCalls).toBe(1)
  }
  expect(percentile(
    samples.map(({ empty }) => empty.ledgerAfterLastRemovalMs),
    0.95
  )).toBeLessThanOrEqual(WARM_SINGLE_CLOSE_P95_BUDGET_MS)
  expect(percentile(
    samples.map(({ saturated }) => saturated.ledgerAfterLastRemovalMs),
    0.95
  )).toBeLessThanOrEqual(WARM_SINGLE_CLOSE_P95_BUDGET_MS)
})

test('installed minimum-Chrome records cold single-close mutation timing', async ({
  installedExtension
}, testInfo) => {
  test.skip(MEASURED_PAIR_COUNT === 0, 'No measured benchmark pairs requested')
  const profile = await saturatedProfile()
  const samples: PairedColdCloseSample[] = []
  for (let index = 0; index < WARMUP_PAIR_COUNT; index += 1) {
    await runPairedColdSingleCloseSample(installedExtension, profile, index)
  }
  for (let index = 0; index < MEASURED_PAIR_COUNT; index += 1) {
    samples.push(await runPairedColdSingleCloseSample(
      installedExtension,
      profile,
      WARMUP_PAIR_COUNT + index
    ))
  }

  const report = {
    authority: {
      lifecycle: 'one CDP session confirms the installed MV3 worker target is absent and the candidate target is present, then immediately closes that physical target',
      gate: 'CDP close command through the controller receiving the production settlement response is a strict end-to-end upper bound: it includes Chrome event delivery, cold worker launch, the retained-close batch and durable-set Promise settlement, plus response delivery',
      eventDiagnostic: 'the main-app-blocked controller page records its own tabs.onRemoved delivery; cross-context broadcast order does not make that timestamp the worker callback timestamp',
      storageDiagnostic: 'candidate-verified storage.onChanged publication proves the exact maximum-sized synthetic snapshot became observable but may precede the originating set Promise settlement'
    },
    runPlan: {
      warmupPairs: WARMUP_PAIR_COUNT,
      measuredPairs: MEASURED_PAIR_COUNT,
      order: 'empty/saturated order alternates for every pair'
    },
    timingMs: {
      emptyCloseCommandToSettlementObservation: distribution(
        samples.map(({ empty }) => empty.closeCommandToSettlementObservationMs)
      ),
      saturatedCloseCommandToSettlementObservation: distribution(
        samples.map(({ saturated }) => (
          saturated.closeCommandToSettlementObservationMs
        ))
      ),
      emptyControllerRemovalToSettlement: distribution(
        samples.map(({ empty }) => empty.removalToSettlementMs)
      ),
      saturatedControllerRemovalToSettlement: distribution(
        samples.map(({ saturated }) => saturated.removalToSettlementMs)
      ),
      emptyControllerRemovalToLedgerPublication: distribution(
        samples.map(({ empty }) => empty.removalToLedgerPublicationMs)
      ),
      saturatedControllerRemovalToLedgerPublication: distribution(
        samples.map(({ saturated }) => saturated.removalToLedgerPublicationMs)
      ),
      emptyLedgerPublicationToSettlement: distribution(
        samples.map(({ empty }) => empty.ledgerPublicationToSettlementMs)
      ),
      saturatedLedgerPublicationToSettlement: distribution(
        samples.map(({ saturated }) => saturated.ledgerPublicationToSettlementMs)
      ),
      coldCloseCommandToSettlementObservationP95Budget:
        COLD_SINGLE_CLOSE_P95_BUDGET_MS
    }
  }
  await testInfo.attach('closed-tab-retention-installed-cold-single-close.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  console.log(
    `closed-tab-retention installed cold single-close benchmark: ${JSON.stringify(report)}`
  )

  for (const { empty, saturated } of samples) {
    expect(empty.workerAbsentBeforeClose).toBe(true)
    expect(empty.completed).toBe(true)
    expect(empty.pages).toBe(1)
    expect(empty.candidatePagesMatched).toBe(1)
    expect(empty.sessionSurfaces).toBe(0)
    expect(empty.durableSurfaces).toBe(0)
    expect(empty.removalToLedgerPublicationMs).toBeGreaterThanOrEqual(0)
    expect(empty.removalToSettlementMs).toBeGreaterThanOrEqual(0)
    expect(saturated.workerAbsentBeforeClose).toBe(true)
    expect(saturated.completed).toBe(true)
    expect(saturated.pages).toBe(RETAINED_PAGE_CAPACITY)
    expect(saturated.candidatePagesMatched).toBe(1)
    expect(saturated.sessionSurfaces).toBe(0)
    expect(saturated.durableSurfaces).toBe(0)
    expect(saturated.removalToLedgerPublicationMs).toBeGreaterThanOrEqual(0)
    expect(saturated.removalToSettlementMs).toBeGreaterThanOrEqual(0)
  }
  expect(percentile(
    samples.map(({ empty }) => empty.closeCommandToSettlementObservationMs),
    0.95
  )).toBeLessThanOrEqual(COLD_SINGLE_CLOSE_P95_BUDGET_MS)
  expect(percentile(
    samples.map(({ saturated }) => (
      saturated.closeCommandToSettlementObservationMs
    )),
    0.95
  )).toBeLessThanOrEqual(COLD_SINGLE_CLOSE_P95_BUDGET_MS)
})

test('installed minimum-Chrome preserves prior retention truth when local quota rejects capture', async ({
  installedExtension
}, testInfo) => {
  const worker = installedExtension.serviceWorker
  const profile = await saturatedProfile()
  const tabId = 9_000_000
  const senderPage = await installedExtension.context.newPage()

  try {
    await senderPage.goto(
      `chrome-extension://${installedExtension.extensionId}/index.html`,
      { waitUntil: 'domcontentloaded' }
    )
    await seedBurstState(
      worker,
      'saturated',
      profile,
      overQuotaCandidateInventory(tabId)
    )
    const before = await readInstalledProfile(worker)
    const quota = await fillInstalledLocalQuota(worker)
    const response = await senderPage.evaluate(async ({ messageType, nextTabId }) => (
      chrome.runtime.sendMessage({ type: messageType, tabId: nextTabId })
    ), {
      messageType: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
      nextTabId: tabId
    })
    const after = await readInstalledProfile(worker)
    const failureState = await worker.evaluate(async ({
      durableKey,
      healthKey,
      nextTabId,
      sessionKey
    }) => {
      const [durableStored, healthStored, sessionStored] = await Promise.all([
        chrome.storage.local.get(durableKey),
        chrome.storage.session.get(healthKey),
        chrome.storage.session.get(sessionKey)
      ])
      const candidateKey = String(nextTabId)
      const durable = durableStored[durableKey] as {
        entries?: Record<string, unknown>
      } | undefined
      const session = sessionStored[sessionKey] as {
        entries?: Record<string, unknown>
      } | undefined
      return {
        candidateInDurableInventory: Object.hasOwn(
          durable?.entries ?? {},
          candidateKey
        ),
        candidateInSessionInventory: Object.hasOwn(
          session?.entries ?? {},
          candidateKey
        ),
        health: healthStored[healthKey] as unknown
      }
    }, {
      durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
      healthKey: RETENTION_HEALTH_STORAGE_KEY,
      nextTabId: tabId,
      sessionKey: OPEN_SURFACE_SESSION_STORAGE_KEY
    })
    const report = {
      authority: 'installed-extension test settlement message over the production adjacent-close capture path; the synthetic tab id makes this a storage-failure probe, not a physical tabs.onRemoved benchmark',
      quota,
      settlement: {
        response,
        semantics: 'acknowledges batch settlement; capture outcome is authoritative in ledger, inventory, and retention health'
      },
      before: {
        pages: before.pages,
        removalBoundaries: before.removalBoundaries,
        ledgerSha256: before.ledgerSha256
      },
      after: {
        pages: after.pages,
        removalBoundaries: after.removalBoundaries,
        ledgerSha256: after.ledgerSha256
      },
      failureState
    }
    await testInfo.attach('closed-tab-retention-installed-over-quota.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })
    console.log(`closed-tab-retention installed over-quota probe: ${JSON.stringify(report)}`)

    expect(quota.freeBytes).toBeLessThanOrEqual(512)
    expect(response).toEqual({ ok: true })
    expect(before.pages).toBe(RETAINED_PAGE_CAPACITY)
    expect(before.removalBoundaries).toBe(
      RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES
    )
    expect(before.ledgerSha256).toBe(profile.ledgerSha256)
    expect(after.pages).toBe(before.pages)
    expect(after.removalBoundaries).toBe(before.removalBoundaries)
    expect(after.ledgerSha256).toBe(before.ledgerSha256)
    expect(
      failureState.candidateInSessionInventory ||
      failureState.candidateInDurableInventory
    ).toBe(true)
    expect(failureState.health).toMatchObject({
      failureKind: 'capture',
      operationKind: 'automatic-capture',
      retryState: 'exhausted-after-one-retry'
    })
  } finally {
    await senderPage.close().catch(() => undefined)
    const cleanup = await worker.evaluate(async ({
      durableKey,
      fillerKey,
      healthKey,
      ledgerKey,
      sessionKey
    }) => {
      await Promise.all([
        chrome.storage.local.remove([ledgerKey, durableKey, fillerKey]),
        chrome.storage.session.remove([sessionKey, healthKey])
      ])
      const [fillerBytes, localStored, sessionStored] = await Promise.all([
        chrome.storage.local.getBytesInUse(fillerKey),
        chrome.storage.local.get([ledgerKey, durableKey, fillerKey]),
        chrome.storage.session.get([sessionKey, healthKey])
      ])
      return {
        fillerBytes,
        localKeysAbsent: [ledgerKey, durableKey, fillerKey].every(
          (key) => localStored[key] === undefined
        ),
        sessionKeysAbsent: [sessionKey, healthKey].every(
          (key) => sessionStored[key] === undefined
        )
      }
    }, {
      durableKey: OPEN_SURFACE_DURABLE_STORAGE_KEY,
      fillerKey: QUOTA_FILLER_STORAGE_KEY,
      healthKey: RETENTION_HEALTH_STORAGE_KEY,
      ledgerKey: RETAINED_PAGES_STORAGE_KEY,
      sessionKey: OPEN_SURFACE_SESSION_STORAGE_KEY
    })
    if (
      cleanup.fillerBytes !== 0 ||
      !cleanup.localKeysAbsent ||
      !cleanup.sessionKeysAbsent
    ) throw new Error('Over-quota benchmark cleanup left fixture storage behind')
  }
})

test('installed minimum-Chrome batches a real 500-tab close within retention budgets', async ({
  installedExtension
}, testInfo) => {
  test.setTimeout(CLOSE_BURST_TEST_TIMEOUT_MS)
  test.skip(SKIP_CLOSE_BURST, 'Close-burst benchmark explicitly disabled')
  test.skip(
    MEASURED_PAIR_COUNT === 0 && !BURST_PREFLIGHT_ONLY,
    'No measured benchmark pairs requested'
  )
  const profile = await saturatedProfile()
  const samples: PairedBurstSample[] = []

  // A single saturated preflight keeps a known-bad implementation from opening
  // 35,000 disposable tabs merely to reconfirm that basic completion, latency,
  // or write-count gates already fail. Only a passing preflight advances to the
  // specified five warmup and 30 alternating measured pairs.
  const preflight = await measureBurstState(
    installedExtension,
    BURST_PREFLIGHT_KIND,
    profile
  )
  const preflightPassed = preflight.completed &&
    preflight.ledgerAfterLastRemovalMs <= CLOSE_BURST_P95_BUDGET_MS &&
    preflight.ledgerSetCalls <= CLOSE_BURST_MAX_LEDGER_WRITES &&
    preflight.candidatePagesExpected === BENCHMARK_TAB_COUNT &&
    preflight.candidatePagesMatched === BENCHMARK_TAB_COUNT &&
    preflight.candidatePageIdentityTokenSha256 ===
      preflight.expectedCandidatePageIdentityTokenSha256
  if (!preflightPassed) {
    const failureDiagnostic = await measureBurstState(
      installedExtension,
      BURST_PREFLIGHT_KIND,
      profile,
      true
    ).catch((error: unknown) => ({ error: String(error) }))
    const report = {
      authority: 'one real chrome.tabs.remove call over 500 installed-extension tabs',
      profileKind: BURST_PREFLIGHT_KIND,
      preflight,
      failureDiagnostic,
      requiredBeforeDistribution: {
        completed: true,
        exactCandidateIdentityTokenReplacement: true,
        ledgerAfterLastRemovalMs: CLOSE_BURST_P95_BUDGET_MS,
        ledgerSetCalls: CLOSE_BURST_MAX_LEDGER_WRITES
      },
      gateDefinition: 'The 1s product gate starts at the last delivered tabs.onRemoved event because the extension cannot process events Chrome has not delivered. Remove-call timing and event delivery remain diagnostics.',
      measuredDistribution: `not run because the basic ${BURST_PREFLIGHT_KIND} preflight failed`
    }
    await testInfo.attach('closed-tab-retention-installed-burst-preflight.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })
    console.log(`closed-tab-retention installed burst preflight: ${JSON.stringify(report)}`)
    expect(preflight.completed, 'all 500 close candidates must settle').toBe(true)
    expect(preflight.ledgerAfterLastRemovalMs).toBeLessThanOrEqual(
      CLOSE_BURST_P95_BUDGET_MS
    )
    expect(preflight.ledgerSetCalls).toBeLessThanOrEqual(
      CLOSE_BURST_MAX_LEDGER_WRITES
    )
    expect(preflight.candidatePagesMatched).toBe(BENCHMARK_TAB_COUNT)
    expect(preflight.candidatePageIdentityTokenSha256).toBe(
      preflight.expectedCandidatePageIdentityTokenSha256
    )
    return
  }

  console.log(`closed-tab-retention installed burst preflight passed: ${JSON.stringify({
    candidatePagesMatched: preflight.candidatePagesMatched,
    ledgerAfterLastRemovalMs: preflight.ledgerAfterLastRemovalMs,
    ledgerSetCalls: preflight.ledgerSetCalls,
    profileKind: BURST_PREFLIGHT_KIND
  })}`)

  if (BURST_PREFLIGHT_ONLY) {
    const report = {
      authority: 'one real chrome.tabs.remove call over 500 installed-extension tabs',
      profileKind: BURST_PREFLIGHT_KIND,
      preflight,
      requiredBeforeDistribution: {
        completed: true,
        exactCandidateIdentityTokenReplacement: true,
        ledgerAfterLastRemovalMs: CLOSE_BURST_P95_BUDGET_MS,
        ledgerSetCalls: CLOSE_BURST_MAX_LEDGER_WRITES
      },
      gateDefinition: 'The 1s product gate starts at the last delivered tabs.onRemoved event because the extension cannot process events Chrome has not delivered. Remove-call timing and event delivery remain diagnostics.',
      measuredDistribution: 'intentionally omitted by the preflight-only benchmark option'
    }
    await testInfo.attach('closed-tab-retention-installed-burst-preflight.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })
    console.log(`closed-tab-retention installed burst preflight: ${JSON.stringify(report)}`)
    return
  }

  for (let index = 0; index < WARMUP_PAIR_COUNT; index += 1) {
    const sample = await runPairedBurstSample(installedExtension, profile, index)
    console.log(`closed-tab-retention installed burst warmup ${index + 1}/${WARMUP_PAIR_COUNT}: ${JSON.stringify({
      emptyMs: sample.empty.ledgerAfterLastRemovalMs,
      saturatedMs: sample.saturated.ledgerAfterLastRemovalMs
    })}`)
  }
  for (let index = 0; index < MEASURED_PAIR_COUNT; index += 1) {
    const sample = await runPairedBurstSample(
      installedExtension,
      profile,
      WARMUP_PAIR_COUNT + index
    )
    samples.push(sample)
    console.log(`closed-tab-retention installed burst measured ${index + 1}/${MEASURED_PAIR_COUNT}: ${JSON.stringify({
      emptyMs: sample.empty.ledgerAfterLastRemovalMs,
      saturatedMs: sample.saturated.ledgerAfterLastRemovalMs
    })}`)
  }

  const saturatedDurations = samples.map(({
    saturated
  }) => saturated.ledgerAfterLastRemovalMs)
  const report = {
    authority: 'one real chrome.tabs.remove call over 500 installed-extension tabs',
    runPlan: {
      warmupPairs: WARMUP_PAIR_COUNT,
      measuredPairs: MEASURED_PAIR_COUNT,
      order: 'empty/saturated order alternates for every pair'
    },
    gateDefinition: 'The 1s product gate starts at the last delivered tabs.onRemoved event because the extension cannot process events Chrome has not delivered. Remove-call timing and event delivery remain diagnostics.',
    timingMs: {
      emptyRemoveCallToFirstLedgerSet: distribution(
        samples.map(({ empty }) => empty.removeCallToFirstLedgerSetMs)
      ),
      saturatedRemoveCallToFirstLedgerSet: distribution(
        samples.map(({ saturated }) => saturated.removeCallToFirstLedgerSetMs)
      ),
      emptyRemoveCallToFinalLedgerSet: distribution(
        samples.map(({ empty }) => empty.removeCallToFinalLedgerSetMs)
      ),
      saturatedRemoveCallToFinalLedgerSet: distribution(
        samples.map(({ saturated }) => saturated.removeCallToFinalLedgerSetMs)
      ),
      emptyEventDelivery: distribution(samples.map(({ empty }) => empty.eventDeliveryMs)),
      saturatedEventDelivery: distribution(samples.map(({ saturated }) => saturated.eventDeliveryMs)),
      emptyLastRemovalToFinalLedger: distribution(samples.map(({ empty }) => empty.ledgerAfterLastRemovalMs)),
      saturatedLastRemovalToFinalLedger: distribution(saturatedDurations),
      emptyInventoryCleanup: distribution(samples.map(({ empty }) => empty.cleanupMs)),
      saturatedInventoryCleanup: distribution(samples.map(({ saturated }) => saturated.cleanupMs)),
      saturatedP95Budget: CLOSE_BURST_P95_BUDGET_MS
    },
    writes: {
      authority: 'actual storage.local.set calls whose items include the Retained Page Ledger key',
      empty: samples.map(({ empty }) => empty.ledgerSetCalls),
      saturated: samples.map(({ saturated }) => saturated.ledgerSetCalls),
      maximum: CLOSE_BURST_MAX_LEDGER_WRITES
    },
    exactReadback: samples
  }
  await testInfo.attach('closed-tab-retention-installed-burst.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json'
  })
  console.log(`closed-tab-retention installed burst benchmark: ${JSON.stringify(report)}`)

  for (const sample of samples.flatMap(({ empty, saturated }) => [empty, saturated])) {
    expect(sample.completed).toBe(true)
    expect(sample.pages).toBe(RETAINED_PAGE_CAPACITY)
    expect(sample.sessionSurfaces).toBe(
      RETAINED_STORAGE_PROFILE_DURABLE_SURFACES - BENCHMARK_TAB_COUNT
    )
    expect(sample.durableSurfaces).toBe(
      RETAINED_STORAGE_PROFILE_DURABLE_SURFACES - BENCHMARK_TAB_COUNT
    )
    expect(sample.ledgerSetCalls).toBeLessThanOrEqual(
      CLOSE_BURST_MAX_LEDGER_WRITES
    )
    expect(sample.candidatePagesExpected).toBe(BENCHMARK_TAB_COUNT)
    expect(sample.candidatePagesMatched).toBe(BENCHMARK_TAB_COUNT)
    expect(sample.candidatePageIdentityTokenSha256).toBe(
      sample.expectedCandidatePageIdentityTokenSha256
    )
  }
  expect(percentile(saturatedDurations, 0.95)).toBeLessThanOrEqual(
    CLOSE_BURST_P95_BUDGET_MS
  )
})
