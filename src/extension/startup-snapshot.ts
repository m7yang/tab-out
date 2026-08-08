import { Effect, Result, Schema, Semaphore } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import type { ClosedTabEntry } from './closed-tabs.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import {
  DashboardDataBuildError,
  buildDashboardDataFromTabsEffect
} from './render.js'
import { runPromiseExclusiveEffect } from './promise-exclusive-effect.js'
import {
  deriveDashboardStartupSeedFromLegacyBoundary,
  parseDashboardStartupSeedBoundary,
  type DashboardStartupSeedBoundary,
  type DashboardStartupTitleRetention
} from './startup-snapshot-schema.js'
import { buildWorkingSetSnapshot, pageIdentityForWorkingSet } from './working-set.js'
import type {
  DashboardData,
  DashboardTab,
  HistorySearchStatus,
  TabHistorySnapshot,
  WorkingSetActivityStore,
  WorkingSetSnapshot
} from './types'
import type { SavedPageMetadataUpdates, SavedPagesStore } from './saved-pages.js'
import type { RetainedPageRecord } from './retained-pages-ledger.js'

export type { DashboardStartupTitleRetention }

/** A complete live snapshot. This type is not a persistence boundary. */
export type DashboardStartupSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
  closedTabs: readonly ClosedTabEntry[]
}

export type DashboardStartupSeed = DashboardStartupSeedBoundary
export type DashboardStartupSeedLoadResult = {
  ok: boolean
  value: DashboardStartupSeed | null
}
export type DashboardStartupSeedSource = {
  cardOrder: readonly string[]
  workingSet: WorkingSetSnapshot
  titleTabs: readonly DashboardTab[]
}
export type SaveDashboardStartupSeedOptions = {
  captureStartedAt?: number
  durableCheckpointIntervalMs?: number
  now?: number
  scheduleDurableCheckpoint?: (when: number) => Promise<void> | void
}

// The v2 key intentionally does not reuse the former render-cache key. Old
// payloads stay read-only until a valid replacement is written successfully.
export const DASHBOARD_STARTUP_SEED_CACHE_KEY = 'tab-out:startup-seed:v2'
export const LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY = 'tab-out:startup-snapshot:v1'
// Temporary source-compatibility alias for extension listeners and tests. The
// value points at the compact v2 seed, never at the legacy render cache.
export const DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY = DASHBOARD_STARTUP_SEED_CACHE_KEY

export const DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS = 30 * 60_000
export const DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS = 7 * 24 * 60 * 60_000
const DASHBOARD_STARTUP_SEED_CACHE_WRITE_LOCK = 'tab-out:startup-snapshot-cache-write'

export class StartupSnapshotCacheMutationError extends Schema.TaggedErrorClass<StartupSnapshotCacheMutationError>()(
  'StartupSnapshotCacheMutationError',
  { cause: Schema.Defect() }
) {}

const startupSeedCacheMutationSemaphore = Semaphore.makeUnsafe(1)

export function captureDashboardStartupSnapshotStartedAt(): number {
  const monotonicEpoch = typeof performance === 'undefined'
    ? Number.NaN
    : performance.timeOrigin + performance.now()
  return Number.isFinite(monotonicEpoch) ? monotonicEpoch : Date.now()
}

function startupSeedWarmStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.session || null
}

function startupSeedDurableStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.local || null
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameTitleRetention(
  left: readonly DashboardStartupTitleRetention[],
  right: readonly DashboardStartupTitleRetention[]
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return entry.tabId === other?.tabId &&
      entry.url === other.url &&
      entry.title === other.title &&
      entry.kind === other.kind
  })
}

function sameSeedCore(left: DashboardStartupSeed, right: DashboardStartupSeed): boolean {
  return sameStringOrder(left.cardOrder, right.cardOrder) &&
    left.workingSetPriority.epoch === right.workingSetPriority.epoch &&
    sameStringOrder(left.workingSetPriority.keys, right.workingSetPriority.keys)
}

function sameWarmSeed(left: DashboardStartupSeed, right: DashboardStartupSeed): boolean {
  return sameSeedCore(left, right) && sameTitleRetention(
    left.titleRetention ?? [],
    right.titleRetention ?? []
  )
}

function seedWithoutTitleRetention(seed: DashboardStartupSeed): DashboardStartupSeed {
  return {
    schemaVersion: 2,
    savedAt: seed.savedAt,
    captureStartedAt: seed.captureStartedAt,
    cardOrder: seed.cardOrder,
    workingSetPriority: seed.workingSetPriority
  }
}

function newerSeed(
  left: DashboardStartupSeed | null,
  right: DashboardStartupSeed | null,
  preferLeftOnEqual = true
): DashboardStartupSeed | null {
  if (!left) return right
  if (!right) return left
  if (left.captureStartedAt === right.captureStartedAt) {
    return preferLeftOnEqual ? left : right
  }
  return left.captureStartedAt > right.captureStartedAt ? left : right
}

type StartupSeedStorageRead = {
  ok: boolean
  seed: DashboardStartupSeed | null
  hasV2: boolean
  hasLegacy: boolean
  selectedFromV2: boolean
  v2HadTitleRetention: boolean
}

function readStartupSeedStorageEffect(
  storage: chrome.storage.StorageArea | null,
  includeTitleRetention: boolean
): Effect.Effect<StartupSeedStorageRead> {
  if (!storage) {
    return Effect.succeed({
      ok: true,
      seed: null,
      hasV2: false,
      hasLegacy: false,
      selectedFromV2: false,
      v2HadTitleRetention: false
    })
  }
  return Effect.tryPromise({
    try: () => storage.get([
      DASHBOARD_STARTUP_SEED_CACHE_KEY,
      LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY
    ]),
    catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
  }).pipe(
    Effect.map((stored): StartupSeedStorageRead => {
      const rawV2 = stored[DASHBOARD_STARTUP_SEED_CACHE_KEY]
      const parsedV2WithTitle = parseDashboardStartupSeedBoundary(rawV2)
      const parsedV2 = parsedV2WithTitle && includeTitleRetention
        ? parsedV2WithTitle
        : parseDashboardStartupSeedBoundary(rawV2, false)
      const rawLegacy = stored[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
      const legacy = deriveDashboardStartupSeedFromLegacyBoundary(
        rawLegacy,
        includeTitleRetention
      )
      const selected = newerSeed(parsedV2, legacy)
      return {
        ok: true,
        seed: selected,
        hasV2: parsedV2 !== null,
        hasLegacy: legacy !== null,
        selectedFromV2: selected !== null && selected === parsedV2,
        v2HadTitleRetention: (parsedV2WithTitle?.titleRetention?.length ?? 0) > 0
      }
    }),
    Effect.catchTag('StartupSnapshotCacheMutationError', () => Effect.succeed({
      ok: false,
      seed: null,
      hasV2: false,
      hasLegacy: false,
      selectedFromV2: false,
      v2HadTitleRetention: false
    }))
  )
}

const runStartupSeedCacheMutation = Effect.fn('startupSeedCache.mutate')(function*<
  Value,
  Failure,
  Requirements
>(mutation: Effect.Effect<Value, Failure, Requirements>) {
  const guardedMutation = mutation.pipe(
    Effect.catchDefect((cause) => Effect.fail(
      StartupSnapshotCacheMutationError.make({ cause })
    ))
  )
  return yield* startupSeedCacheMutationSemaphore.withPermit(
    runPromiseExclusiveEffect(
      (task) => navigator.locks.request(DASHBOARD_STARTUP_SEED_CACHE_WRITE_LOCK, task),
      guardedMutation,
      (cause) => StartupSnapshotCacheMutationError.make({ cause })
    )
  )
})

function removeLegacySeedAfterWriteEffect(
  storage: chrome.storage.StorageArea | null
): Effect.Effect<void> {
  if (!storage) return Effect.void
  return Effect.tryPromise({
    try: () => storage.remove(LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY),
    catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
  }).pipe(
    // A valid v2 seed is already committed. Cleanup can be retried by a later
    // save without making that committed seed unavailable.
    Effect.catchTag('StartupSnapshotCacheMutationError', () => Effect.void)
  )
}

function writeStartupSeedEffect(
  storage: chrome.storage.StorageArea | null,
  seed: DashboardStartupSeed
): Effect.Effect<boolean> {
  if (!storage) return Effect.succeed(true)
  const write = Effect.tryPromise({
    try: () => storage.set({ [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed }),
    catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
  })
  return Effect.gen(function*() {
    const first = yield* Effect.result(write)
    const written = Result.isSuccess(first) || Result.isSuccess(yield* Effect.result(write))
    if (!written) return false
    yield* removeLegacySeedAfterWriteEffect(storage)
    return true
  })
}

function durableCheckpointDueAt(
  durable: DashboardStartupSeed | null,
  now: number,
  intervalMs: number
): number {
  const savedAt = durable?.savedAt
  if (savedAt === undefined || !Number.isFinite(savedAt) || now < savedAt) return now
  return Math.max(now, savedAt + intervalMs)
}

export function dashboardStartupPreviousOrder(
  seed: DashboardStartupSeed | null | undefined
): Map<string, number> {
  return new Map((seed?.cardOrder ?? []).map((cardId, index) => [cardId, index]))
}

export function dashboardStartupWorkingSetKey(value: string): string {
  return pageIdentityForWorkingSet(value)
}

export function dashboardStartupWorkingSetPriorityKeys(
  workingSet: WorkingSetSnapshot
): string[] {
  const seen = new Set<string>()
  return workingSet.items.flatMap((item) => {
    const key = dashboardStartupWorkingSetKey(item.key || item.tabUrl)
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [key]
  })
}

export function dashboardStartupTitleRetentionFromTabs(
  tabs: readonly DashboardTab[]
): DashboardStartupTitleRetention[] {
  const seenTabIds = new Set<number>()
  return tabs.flatMap((tab) => {
    if (
      typeof tab.id !== 'number' ||
      !Number.isInteger(tab.id) ||
      tab.id < 0 ||
      seenTabIds.has(tab.id) ||
      !tab.url ||
      !tab.title.replaceAll('\u200E', '').trim()
    ) return []
    const kind: DashboardStartupTitleRetention['kind'] | null =
      tab.retainedSuspendedTitle === true
        ? 'retained-loading'
        : tab.suspended ? 'suspended' : null
    if (!kind) return []
    seenTabIds.add(tab.id)
    return [{ tabId: tab.id, url: tab.url, title: tab.title, kind }]
  })
}

export function dashboardStartupTitleHistory(
  seed: DashboardStartupSeed | null | undefined
): DashboardTab[] {
  return (seed?.titleRetention ?? []).map((entry): DashboardTab => ({
    id: entry.tabId,
    url: entry.url,
    rawUrl: entry.url,
    suspended: entry.kind === 'suspended',
    title: entry.title,
    ...(entry.kind === 'retained-loading'
      ? { status: 'loading', retainedSuspendedTitle: true }
      : {}),
    favIconUrl: '',
    windowId: -1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false
  }))
}

export function rebaseDashboardStartupWorkingSetPriority(
  seed: DashboardStartupSeed | null | undefined,
  live: WorkingSetSnapshot,
  now = Date.now()
): WorkingSetSnapshot {
  if (
    !seed ||
    now - seed.workingSetPriority.epoch > DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS
  ) return live

  const liveByKey = new Map<string, WorkingSetSnapshot['items'][number]>()
  for (const item of live.items) {
    const key = dashboardStartupWorkingSetKey(item.key || item.tabUrl)
    if (key) liveByKey.set(key, item)
  }
  const selectedKeys = new Set<string>()
  const prioritizedItems = seed.workingSetPriority.keys.flatMap((key) => {
    const liveItem = liveByKey.get(key)
    if (!liveItem || selectedKeys.has(key)) return []
    selectedKeys.add(key)
    return [liveItem]
  })
  const remainingItems = live.items.filter((item) => {
    const key = dashboardStartupWorkingSetKey(item.key || item.tabUrl)
    if (!key) return true
    if (selectedKeys.has(key)) return false
    selectedKeys.add(key)
    return true
  })
  const orderedItems = [...prioritizedItems, ...remainingItems]
  const items = orderedItems.map((item, index) => ({
    ...item,
    score: orderedItems.length - index
  }))
  return { ...live, items }
}

export const loadDashboardStartupSeedResultEffect = Effect.fn(
  'startupSeedCache.load'
)(function*(now = Date.now()) {
  const [warmRead, durableRead] = yield* Effect.all([
    readStartupSeedStorageEffect(startupSeedWarmStorage(), true),
    readStartupSeedStorageEffect(startupSeedDurableStorage(), false)
  ], { concurrency: 'unbounded' })
  const durableSeed = durableRead.seed &&
    now - durableRead.seed.savedAt <= DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS
    ? durableRead.seed
    : null
  return {
    ok: warmRead.ok && durableRead.ok,
    // Equal generations prefer Warm because title retention is session-only.
    value: newerSeed(warmRead.seed, durableSeed, true)
  }
})

export function loadDashboardStartupSeedResult(
  now = Date.now()
): Promise<DashboardStartupSeedLoadResult> {
  return getAppRuntime().runPromise(loadDashboardStartupSeedResultEffect(now))
}

export const loadDashboardStartupSeedEffect = Effect.fn(
  'startupSeedCache.loadValue'
)(function*(now = Date.now()) {
  return (yield* loadDashboardStartupSeedResultEffect(now)).value
})

export function loadDashboardStartupSeed(
  now = Date.now()
): Promise<DashboardStartupSeed | null> {
  return getAppRuntime().runPromise(loadDashboardStartupSeedEffect(now))
}

export const invalidateDashboardStartupTitleRetentionEffect = Effect.fn(
  'startupSeedCache.invalidateTitleRetention'
)(function*(
  tabId: number | undefined,
  now = captureDashboardStartupSnapshotStartedAt()
) {
  if (tabId === undefined || !Number.isInteger(tabId) || tabId < 0) return false
  return yield* runStartupSeedCacheMutation(Effect.gen(function*() {
    const warmStorage = startupSeedWarmStorage()
    const warmRead = yield* readStartupSeedStorageEffect(warmStorage, true)
    if (!warmRead.ok || !warmRead.seed) return false
    const retainedTitles = warmRead.seed.titleRetention ?? []
    const remainingTitles = retainedTitles.filter((entry) => entry.tabId !== tabId)
    if (remainingTitles.length === retainedTitles.length) return false
    const candidate: DashboardStartupSeed = {
      schemaVersion: 2,
      savedAt: now,
      captureStartedAt: Math.max(warmRead.seed.captureStartedAt, now),
      cardOrder: warmRead.seed.cardOrder,
      workingSetPriority: warmRead.seed.workingSetPriority,
      ...(remainingTitles.length > 0 ? { titleRetention: remainingTitles } : {})
    }
    return yield* writeStartupSeedEffect(warmStorage, candidate)
  }))
})

export function invalidateDashboardStartupTitleRetention(
  tabId: number | undefined,
  now = Date.now()
): Promise<boolean> {
  return getAppRuntime().runPromise(
    invalidateDashboardStartupTitleRetentionEffect(tabId, now).pipe(
      Effect.catchTag('StartupSnapshotCacheMutationError', (error) => Effect.fail(error.cause))
    )
  )
}

function priorityForNextWarmSeed(
  previous: DashboardStartupSeed | null,
  workingSet: WorkingSetSnapshot,
  now: number
): DashboardStartupSeed['workingSetPriority'] {
  const liveKeys = dashboardStartupWorkingSetPriorityKeys(workingSet)
  if (
    !previous ||
    now - previous.workingSetPriority.epoch > DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS
  ) {
    return { epoch: now, keys: liveKeys }
  }
  const liveKeySet = new Set(liveKeys)
  const preservedKeys = previous.workingSetPriority.keys.filter((key) => liveKeySet.has(key))
  const preservedKeySet = new Set(preservedKeys)
  return {
    epoch: previous.workingSetPriority.epoch,
    keys: [
      ...preservedKeys,
      ...liveKeys.filter((key) => !preservedKeySet.has(key))
    ]
  }
}

export const saveDashboardStartupSeedEffect = Effect.fn(
  'startupSeedCache.save'
)(function*(
  source: DashboardStartupSeedSource,
  options: SaveDashboardStartupSeedOptions = {}
) {
  const now = options.now ?? Date.now()
  const requestedCaptureStartedAt = options.captureStartedAt ?? now
  const captureStartedAt = Number.isFinite(requestedCaptureStartedAt)
    ? requestedCaptureStartedAt
    : now
  const requestedInterval = options.durableCheckpointIntervalMs ?? 0
  const durableCheckpointIntervalMs = Number.isFinite(requestedInterval)
    ? Math.max(0, requestedInterval)
    : 0

  yield* runStartupSeedCacheMutation(Effect.gen(function*() {
    const warmStorage = startupSeedWarmStorage()
    const durableStorage = startupSeedDurableStorage()
    const [warmRead, durableRead] = yield* Effect.all([
      readStartupSeedStorageEffect(warmStorage, true),
      readStartupSeedStorageEffect(durableStorage, false)
    ], { concurrency: 'unbounded' })
    if (!warmRead.ok || !durableRead.ok) return

    const previous = newerSeed(warmRead.seed, durableRead.seed)
    if ((previous?.captureStartedAt ?? Number.NEGATIVE_INFINITY) > captureStartedAt) return

    const unvalidatedSeed: DashboardStartupSeed = {
      schemaVersion: 2,
      savedAt: now,
      captureStartedAt,
      cardOrder: source.cardOrder,
      workingSetPriority: priorityForNextWarmSeed(previous, source.workingSet, now),
      titleRetention: dashboardStartupTitleRetentionFromTabs(source.titleTabs)
    }
    const candidate = parseDashboardStartupSeedBoundary(unvalidatedSeed)
    if (!candidate) return

    const warmWriteRequired = !warmRead.hasV2 || !warmRead.selectedFromV2 || !warmRead.seed ||
      !sameWarmSeed(warmRead.seed, candidate)
    if (warmWriteRequired) {
      const warmWritten = yield* writeStartupSeedEffect(warmStorage, candidate)
      if (!warmWritten) return
    } else if (warmRead.hasLegacy) {
      yield* removeLegacySeedAfterWriteEffect(warmStorage)
    }

    const durableCandidate = seedWithoutTitleRetention(candidate)
    const durableMissing = durableStorage !== null && (
      !durableRead.hasV2 || !durableRead.selectedFromV2
    )
    if (durableMissing) {
      yield* writeStartupSeedEffect(durableStorage, durableCandidate)
      return
    }
    if (durableRead.hasLegacy && durableRead.hasV2) {
      yield* removeLegacySeedAfterWriteEffect(durableStorage)
    }
    if (!durableRead.seed) return

    const durableCurrent = sameSeedCore(durableRead.seed, durableCandidate) &&
      !durableRead.v2HadTitleRetention
    if (durableCurrent) return
    const dueAt = durableCheckpointDueAt(
      durableRead.seed,
      now,
      durableCheckpointIntervalMs
    )
    if (dueAt <= now && !options.scheduleDurableCheckpoint) {
      yield* writeStartupSeedEffect(durableStorage, durableCandidate)
      return
    }
    if (!options.scheduleDurableCheckpoint) return
    yield* Effect.tryPromise({
      try: async () => {
        await options.scheduleDurableCheckpoint?.(dueAt)
      },
      catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
    })
  }))
})

export function saveDashboardStartupSeed(
  source: DashboardStartupSeedSource,
  options: SaveDashboardStartupSeedOptions = {}
): Promise<void> {
  return getAppRuntime().runPromise(
    saveDashboardStartupSeedEffect(source, options).pipe(
      Effect.catchTag('StartupSnapshotCacheMutationError', (error) => Effect.fail(error.cause))
    )
  )
}

export const promoteDashboardStartupSeedEffect = Effect.fn(
  'startupSeedCache.promote'
)(function*(now = Date.now()) {
  return yield* runStartupSeedCacheMutation(Effect.gen(function*() {
    const warmStorage = startupSeedWarmStorage()
    const durableStorage = startupSeedDurableStorage()
    const [warmRead, durableRead] = yield* Effect.all([
      readStartupSeedStorageEffect(warmStorage, true),
      readStartupSeedStorageEffect(durableStorage, false)
    ], { concurrency: 'unbounded' })
    if (!warmRead.ok || !durableRead.ok || !warmRead.seed) return false
    if (
      durableRead.seed &&
      durableRead.seed.captureStartedAt > warmRead.seed.captureStartedAt
    ) return true

    const candidate: DashboardStartupSeed = {
      ...seedWithoutTitleRetention(warmRead.seed),
      savedAt: now
    }
    const durableCurrent = durableRead.hasV2 && durableRead.selectedFromV2 && !!durableRead.seed &&
      sameSeedCore(durableRead.seed, candidate) &&
      durableRead.seed.captureStartedAt === candidate.captureStartedAt &&
      !durableRead.v2HadTitleRetention
    if (durableCurrent) {
      if (durableRead.hasLegacy) yield* removeLegacySeedAfterWriteEffect(durableStorage)
      return true
    }
    return yield* writeStartupSeedEffect(durableStorage, candidate)
  }))
})

export function promoteDashboardStartupSeed(now = Date.now()): Promise<boolean> {
  return getAppRuntime().runPromise(
    promoteDashboardStartupSeedEffect(now).pipe(
      Effect.catchTag('StartupSnapshotCacheMutationError', (error) => Effect.fail(error.cause))
    )
  )
}

export type TabsStartupSnapshotInputs = {
  dashboardTabs: DashboardTab[]
  /** Full live inventory used only to suppress hidden retained matches. */
  retainedLiveTabs?: readonly DashboardTab[]
  currentWindowId: number | null
  tabHistory: TabHistorySnapshot
  workingSetActivity: WorkingSetActivityStore
  savedPagesStore: SavedPagesStore
  retainedPages?: readonly RetainedPageRecord[]
  closedTabs: readonly ClosedTabEntry[]
  pinnedDomains: string[]
  tabPreviousOrder?: Map<string, number>
  filterSearch?: {
    bookmarkTabs: DashboardTab[]
    historyRange: string
    historySearchStatus: HistorySearchStatus
    historyTabs: DashboardTab[]
    includeBookmarkMatches: boolean
    includeHistoryMatches: boolean
    query: string
  }
}

export type TabsStartupSnapshotBuild = {
  snapshot: DashboardStartupSnapshot
  savedPageUpdates: SavedPageMetadataUpdates
}

// Build a complete live Tabs-source snapshot from already-gathered inputs. It
// remains shared by page and worker-independent tests, but is never persisted.
export const buildTabsDashboardStartupSnapshotEffect = Effect.fn(
  'startupSnapshot.buildFromTabs'
)(function*(inputs: TabsStartupSnapshotInputs) {
  const { dashboard, savedPageUpdates } = yield* buildDashboardDataFromTabsEffect(
    inputs.dashboardTabs,
    inputs.currentWindowId,
    inputs.tabPreviousOrder ?? new Map(),
    {
      pinnedDomains: inputs.pinnedDomains,
      bookmarkPreviousOrder: new Map(),
      historyPreviousOrder: new Map(),
      includeBookmarkMatches: inputs.filterSearch?.includeBookmarkMatches ?? false,
      includeHistoryMatches: inputs.filterSearch?.includeHistoryMatches ?? false,
      searchQuery: inputs.filterSearch?.query ?? '',
      historyRange: inputs.filterSearch?.historyRange ?? DEFAULT_HISTORY_RANGE,
      historySearchStatus: inputs.filterSearch?.historySearchStatus ?? 'idle',
      bookmarkTabs: inputs.filterSearch?.bookmarkTabs ?? [],
      historyTabs: inputs.filterSearch?.historyTabs ?? [],
      savedPagesStore: inputs.savedPagesStore,
      retainedPages: inputs.retainedPages ?? [],
      retainedLiveTabs: inputs.retainedLiveTabs ?? inputs.dashboardTabs
    }
  )
  return yield* Effect.try({
    try: (): TabsStartupSnapshotBuild => ({
      snapshot: {
        dashboard,
        tabHistory: inputs.tabHistory,
        workingSet: buildWorkingSetSnapshot({
          tabs: inputs.dashboardTabs,
          activity: inputs.workingSetActivity,
          currentWindowId: inputs.currentWindowId
        }),
        closedTabs: inputs.closedTabs
      },
      savedPageUpdates
    }),
    catch: (cause) => DashboardDataBuildError.make({ cause })
  })
})

export function buildTabsDashboardStartupSnapshot(
  inputs: TabsStartupSnapshotInputs
): Promise<TabsStartupSnapshotBuild> {
  return getAppRuntime().runPromise(
    buildTabsDashboardStartupSnapshotEffect(inputs).pipe(
      Effect.catchTag('DashboardDataBuildError', (error) => Effect.fail(error.cause))
    )
  )
}
