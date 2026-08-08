import {
  Context,
  Deferred,
  Effect,
  FiberHandle,
  FiberSet,
  Layer,
  Ref,
  Result,
  Schema
} from 'effect'

import { BrowserTabs } from '../browser-tabs-service.js'
import type { CapturedDashboardServiceState } from '../dashboard-service-messages.js'
import { buildDomainGroups } from '../domain-groups.js'
import { domainGroupCardId } from '../domain-card-id.js'
import { DOMAIN_PIN_STORAGE_KEY, normalizePinnedDomains } from '../domain-pins.js'
import { RETAINED_PAGES_STORAGE_KEY } from '../retained-pages-storage.js'
import { SAVED_PAGES_STORAGE_KEY, mergeSavedPagesWithTabs } from '../saved-pages.js'
import { loadSavedPagesStoreResultEffect } from '../saved-pages-storage.js'
import {
  captureDashboardStartupSnapshotStartedAt,
  dashboardStartupPreviousOrder,
  dashboardStartupTitleHistory,
  invalidateDashboardStartupTitleRetentionEffect,
  loadDashboardStartupSeedResultEffect,
  promoteDashboardStartupSeedEffect,
  saveDashboardStartupSeedEffect
} from '../startup-snapshot.js'
import {
  fetchOpenTabsSnapshotEffect,
  getDashboardTabsFromOpenTabs,
  seedOpenTabsTitleHistory
} from '../tabs.js'
import { buildWorkingSetSnapshot } from '../working-set.js'

// Event bursts still coalesce seed maintenance. The seed is ordering-only, so
// it does not participate in first-content freshness or visible hydration.
export const STARTUP_SNAPSHOT_DEBOUNCE_MS = 4000
export const STARTUP_SNAPSHOT_MAX_WAIT_MS = 30_000
export const STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS = 5 * 60_000
export const STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM = 'tab-out:startup-snapshot-durable-checkpoint'
export const STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS = 250
const STARTUP_SEED_SOURCE_KEYS = [
  DOMAIN_PIN_STORAGE_KEY,
  RETAINED_PAGES_STORAGE_KEY,
  SAVED_PAGES_STORAGE_KEY
]

export function startupSnapshotStorageChangesRequireRefresh(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): boolean {
  return areaName === 'local' &&
    STARTUP_SEED_SOURCE_KEYS.some((key) => Object.hasOwn(changes, key))
}

type StartupSnapshotAlarmApi = {
  create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => Promise<void>
  get: (name: string) => Promise<chrome.alarms.Alarm | undefined>
}

export type StartupSnapshotLayerDeps<Failure, Requirements> = {
  readonly alarms?: StartupSnapshotAlarmApi
  readonly getDashboardServiceState: Effect.Effect<
    CapturedDashboardServiceState,
    Failure,
    Requirements
  >
}

export class StartupSnapshot extends Context.Service<StartupSnapshot, {
  readonly invalidateTitleRetention: (tabId: number | undefined) => Effect.Effect<void>
  readonly scheduleRefresh: () => Effect.Effect<void>
  readonly sessionsChanged: () => Effect.Effect<void>
  readonly sessionRestoreStarted: (restoreId: string) => Effect.Effect<void>
  readonly sessionRestoreSettled: (restoreId: string) => Effect.Effect<void>
  readonly promoteDurableCheckpoint: () => Effect.Effect<void>
  readonly refreshNow: () => Effect.Effect<void>
}>()('@tab-out/background/StartupSnapshot') {
  static layer<Failure, Requirements>(
    deps: StartupSnapshotLayerDeps<Failure, Requirements>
  ): Layer.Layer<StartupSnapshot, never, Requirements | BrowserTabs> {
    return makeStartupSnapshotLayer(deps)
  }
}

class StartupSnapshotRefreshError extends Schema.TaggedErrorClass<StartupSnapshotRefreshError>()(
  'StartupSnapshotRefreshError',
  { cause: Schema.Defect() }
) {}

type RefreshFlight = {
  readonly completion: Deferred.Deferred<void>
  readonly shouldStart: boolean
}

const loadStartupSeedPinnedDomainsResultEffect = Effect.fn(
  'StartupSnapshot.loadPinnedDomains'
)(function*() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ok: true, value: new Array<string>() }
  }
  const stored = yield* Effect.result(Effect.tryPromise({
    try: () => chrome.storage.local.get(DOMAIN_PIN_STORAGE_KEY),
    catch: (cause) => StartupSnapshotRefreshError.make({ cause })
  }))
  if (Result.isFailure(stored)) return { ok: false, value: new Array<string>() }
  return {
    ok: true,
    value: normalizePinnedDomains(stored.success[DOMAIN_PIN_STORAGE_KEY])
  }
})

function makeStartupSnapshotLayer<Failure, Requirements>(
  deps: StartupSnapshotLayerDeps<Failure, Requirements>
): Layer.Layer<StartupSnapshot, never, Requirements | BrowserTabs> {
  return Layer.effect(StartupSnapshot, Effect.gen(function*() {
    const scope = yield* Effect.scope
    const browserTabs = yield* BrowserTabs
    const services = yield* Effect.context<Requirements>()
    const getDashboardServiceState = deps.getDashboardServiceState.pipe(
      Effect.provide(services)
    )
    const inFlight = yield* Ref.make<Deferred.Deferred<void> | null>(null)
    const quietRefresh = yield* FiberHandle.make<void, never>()
    const maxWaitRefresh = yield* FiberHandle.make<void, never>()
    const cacheSeedRetry = yield* FiberHandle.make<void, never>()
    const runInLayer = yield* FiberSet.makeRuntime<never, void, never>()
    let cacheSeedRetryAttempted = false
    let durablePromotionInFlight = false
    let cachedOpenTabsSeeded = false
    let tabPreviousOrder = new Map<string, number>()

    async function scheduleDurableCheckpoint(when: number): Promise<void> {
      if (!deps.alarms || durablePromotionInFlight) return
      try {
        const pending = await deps.alarms.get(STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM)
        if (pending) return
        await deps.alarms.create(STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM, { when })
      } catch {}
    }

    const clearScheduledRefresh = Effect.fn('StartupSnapshot.clearScheduledRefresh')(function*() {
      yield* FiberHandle.clear(quietRefresh)
      yield* FiberHandle.clear(maxWaitRefresh)
    })

    const clearCacheSeedRetry = () => FiberHandle.clear(cacheSeedRetry)

    function refreshNow(): Effect.Effect<void> {
      return runRefreshNow()
    }

    const scheduleCacheSeedRetry = Effect.fn('StartupSnapshot.scheduleCacheSeedRetry')(function*() {
      if (cachedOpenTabsSeeded || cacheSeedRetryAttempted) return
      yield* FiberHandle.run(
        cacheSeedRetry,
        Effect.sleep(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS).pipe(
          Effect.andThen(Effect.sync(() => {
            cacheSeedRetryAttempted = true
            runInLayer(refreshNow())
          }))
        ),
        { onlyIfMissing: true }
      )
    })

    const computeStartupSeed = Effect.fn('StartupSnapshot.computeSeed')(function*() {
      const captureStartedAt = captureDashboardStartupSnapshotStartedAt()
      if (!cachedOpenTabsSeeded) {
        const cachedResult = yield* loadDashboardStartupSeedResultEffect()
        if (!cachedResult.ok) {
          yield* scheduleCacheSeedRetry()
          return
        }
        yield* clearCacheSeedRetry()
        seedOpenTabsTitleHistory(dashboardStartupTitleHistory(cachedResult.value))
        tabPreviousOrder = dashboardStartupPreviousOrder(cachedResult.value)
        cachedOpenTabsSeeded = true
      }

      const dashboardServiceStateEffect = getDashboardServiceState.pipe(
        Effect.mapError((cause) => StartupSnapshotRefreshError.make({ cause }))
      )
      const [dashboardServiceState, savedPagesResult, pinnedDomainsResult] =
        yield* Effect.all([
          dashboardServiceStateEffect,
          loadSavedPagesStoreResultEffect(),
          loadStartupSeedPinnedDomainsResultEffect()
        ], { concurrency: 'unbounded' })
      const openTabsResult = yield* fetchOpenTabsSnapshotEffect(
        dashboardServiceState.openTabsSnapshot
      ).pipe(Effect.provideService(BrowserTabs, browserTabs))
      if (!openTabsResult.ok || !savedPagesResult.ok || !pinnedDomainsResult.ok) return

      const openTabs = openTabsResult.tabs
      const dashboardTabs = getDashboardTabsFromOpenTabs(openTabs)
      // Merge only to retain saved-only card identities and ordering. The worker
      // deliberately drops metadata updates; page-side writers own Saved Pages.
      const mergedTabs = mergeSavedPagesWithTabs(
        dashboardTabs,
        savedPagesResult.value
      ).tabs
      const groups = buildDomainGroups(mergedTabs, {
        pinnedDomains: pinnedDomainsResult.value,
        previousOrder: tabPreviousOrder
      })
      const capturedActiveWindowId = dashboardServiceState.tabHistory.activeWindowId
      const currentWindowId = typeof capturedActiveWindowId === 'number' &&
        Number.isInteger(capturedActiveWindowId) && capturedActiveWindowId >= 0
        ? capturedActiveWindowId
        : null
      const workingSet = buildWorkingSetSnapshot({
        tabs: dashboardTabs,
        activity: dashboardServiceState.workingSetActivity,
        currentWindowId
      })
      const cardOrder = groups.map(domainGroupCardId)
      yield* saveDashboardStartupSeedEffect({
        cardOrder,
        workingSet,
        titleTabs: openTabs
      }, {
        captureStartedAt,
        durableCheckpointIntervalMs: STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS,
        ...(deps.alarms ? { scheduleDurableCheckpoint } : {})
      }).pipe(
        Effect.mapError((error) => StartupSnapshotRefreshError.make({ cause: error.cause }))
      )
      tabPreviousOrder = new Map(cardOrder.map((cardId, index) => [cardId, index]))
    })

    const runStartupSnapshotRefresh = Effect.fn('StartupSnapshot.runRefresh')(function*() {
      yield* computeStartupSeed().pipe(
        Effect.catchTag('StartupSnapshotRefreshError', () => Effect.void)
      )
    })

    const scheduleRefreshState = Effect.fn('StartupSnapshot.scheduleRefresh')(function*() {
      const runScheduledRefresh = Effect.sync(() => {
        runInLayer(refreshNow())
      })
      yield* FiberHandle.run(
        quietRefresh,
        Effect.sleep(STARTUP_SNAPSHOT_DEBOUNCE_MS).pipe(
          Effect.andThen(runScheduledRefresh)
        )
      )
      yield* FiberHandle.run(
        maxWaitRefresh,
        Effect.sleep(STARTUP_SNAPSHOT_MAX_WAIT_MS).pipe(
          Effect.andThen(runScheduledRefresh)
        ),
        { onlyIfMissing: true }
      )
    })

    const runRefreshNow = Effect.fn('StartupSnapshot.refreshNow')(function*() {
      yield* clearScheduledRefresh()
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
        const candidate = yield* Deferred.make<void>()
        const flight = yield* Ref.modify(
          inFlight,
          (current): readonly [RefreshFlight, Deferred.Deferred<void> | null] => current
            ? [{ completion: current, shouldStart: false }, current]
            : [{ completion: candidate, shouldStart: true }, candidate]
        )
        if (!flight.shouldStart) {
          yield* scheduleRefreshState()
          return yield* restore(Deferred.await(flight.completion))
        }

        yield* runStartupSnapshotRefresh().pipe(
          Effect.onExit((exit) => Ref.update(inFlight, (current) =>
            current === flight.completion ? null : current
          ).pipe(
            Effect.andThen(Deferred.done(flight.completion, exit)),
            Effect.asVoid
          )),
          Effect.forkIn(scope, { startImmediately: true })
        )
        return yield* restore(Deferred.await(flight.completion))
      }))
    })

    const promoteDurableCheckpoint = Effect.fn('StartupSnapshot.promoteDurableCheckpoint')(
      function*() {
        if (durablePromotionInFlight) return
        durablePromotionInFlight = true
        yield* promoteDashboardStartupSeedEffect().pipe(
          Effect.mapError((error) => StartupSnapshotRefreshError.make({ cause: error.cause })),
          Effect.catchTag('StartupSnapshotRefreshError', () => Effect.void),
          Effect.ensuring(Effect.sync(() => {
            durablePromotionInFlight = false
          }))
        )
      }
    )

    // Session restore notifications remain part of the background public API,
    // but recently closed rows are no longer persisted in the compact seed.
    const ignoreSessionChange = () => Effect.void

    return StartupSnapshot.of({
      invalidateTitleRetention: (tabId) => invalidateDashboardStartupTitleRetentionEffect(tabId).pipe(
        Effect.catchTag('StartupSnapshotCacheMutationError', () => Effect.void),
        Effect.asVoid
      ),
      scheduleRefresh: scheduleRefreshState,
      sessionsChanged: ignoreSessionChange,
      sessionRestoreStarted: () => Effect.void,
      sessionRestoreSettled: () => Effect.void,
      promoteDurableCheckpoint,
      refreshNow
    })
  }))
}
