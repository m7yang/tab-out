/* ================================================================
   Dashboard Intake — the page's fetch orchestration for arriving
   Dashboard state (ADR 0007).

   This module is UI-free: it gathers browser and service state, runs
   the pure Dashboard builds, and acts as the page-side single writer
   for the Saved Page metadata refresh those builds return. The React
   layer consumes it through the intake store's React adapter.
   ================================================================ */

import { Effect, FiberHandle, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import type { BrowserReadResult } from './browser-tabs-gateway.js'
import {
  closedTabFetchSuppressionRemainingMs,
  fetchClosedTabsResultEffect,
  fetchClosedTabsResult,
  isClosedTabFetchSuppressed,
  subscribeClosedTabChanges,
  type ClosedTabEntry
} from './closed-tabs.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from './history-range.js'
import { fetchDashboardServiceStateResultEffect, type DashboardServiceStateResult } from './dashboard-service-state.js'
import { fetchDashboardDataEffect } from './dashboard-data-fetch.js'
import { buildFilterSearchRequest } from './filter-search.js'
import { buildDashboardDataFromTabsEffect, getCurrentWindowIdResultEffect } from './render.js'
import { fetchOpenTabsSnapshotEffect, getDashboardTabsFromOpenTabs } from './tabs.js'
import { buildWorkingSetSnapshot } from './working-set.js'
import type { SavedPagesStore } from './saved-pages.js'
import { loadSavedPagesStoreResultEffect } from './saved-pages-storage.js'
import { persistSavedPageMetadataUpdatesEffect } from './saved-pages-mutations.js'
import { buildTabsDashboardStartupSnapshotEffect, type DashboardStartupSnapshot } from './startup-snapshot.js'
import { showToast } from './toast.js'
import type { DashboardData, DashboardSource, DashboardTab, TabHistorySnapshot, WorkingSetSnapshot } from './types'

export type MissionOrderMap = Record<DashboardSource, Map<string, number>>

export type DashboardRefreshOptions = {
  animateCards?: boolean
}

export function mergeDashboardRefreshOptions(
  current: DashboardRefreshOptions | undefined,
  next: DashboardRefreshOptions
): DashboardRefreshOptions {
  return {
    ...current,
    ...next,
    ...((current?.animateCards || next.animateCards) ? { animateCards: true } : {})
  }
}

/** Settle automatic/event-driven refreshes without creating an unhandled rejection. */
export async function settleDashboardRefresh(refresh: Promise<void> | void): Promise<void> {
  try {
    await refresh
  } catch {}
}

export type DashboardSnapshotOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  prefetchedBookmarkTabs?: DashboardTab[]
  prefetchedServiceStateResult?: DashboardServiceStateResult
  savedPagesStore?: SavedPagesStore
  previousOrder: MissionOrderMap
}
export type DashboardRefreshSnapshot = {
  dashboard: DashboardData
  tabHistory?: TabHistorySnapshot
  workingSet?: WorkingSetSnapshot
}
type BookmarkCompanionSnapshot = Pick<Required<DashboardData>, 'bookmarkTabs' | 'bookmarkDomainGroups'>

type LatestRefreshRequest<T> = {
  apply: (value: T) => void
  run: Effect.Effect<T, DashboardRefreshRunError, BrowserTabs>
}
export type LatestRefreshRunner<T> = {
  active: () => boolean
  request: (run: () => Promise<T>, apply: (value: T) => void) => Promise<void>
  requestEffect: <Failure>(
    run: Effect.Effect<T, Failure, BrowserTabs>,
    apply: (value: T) => void
  ) => Promise<void>
  wait: () => Promise<void>
}

export type DashboardRefreshContext = {
  filter: string
  historyFilterEnabled: boolean
  historyRange: string
  pinnedDomains: readonly string[]
  source: DashboardSource
}

class DashboardSourceFetchError extends Schema.TaggedErrorClass<DashboardSourceFetchError>()(
  'DashboardSourceFetchError',
  { cause: Schema.Defect() }
) {}

class DashboardRefreshRunError extends Schema.TaggedErrorClass<DashboardRefreshRunError>()(
  'DashboardRefreshRunError',
  { cause: Schema.Defect() }
) {}

class DashboardClosedTabsFetchError extends Schema.TaggedErrorClass<DashboardClosedTabsFetchError>()(
  'DashboardClosedTabsFetchError',
  { cause: Schema.Defect() }
) {}

class DashboardStartupSnapshotFetchError extends Schema.TaggedErrorClass<DashboardStartupSnapshotFetchError>()(
  'DashboardStartupSnapshotFetchError',
  { cause: Schema.Defect() }
) {}

class DashboardSnapshotFetchError extends Schema.TaggedErrorClass<DashboardSnapshotFetchError>()(
  'DashboardSnapshotFetchError',
  { cause: Schema.Defect() }
) {}

export function createLatestRefreshRunner<T>(): LatestRefreshRunner<T> {
  let inFlight: Promise<void> | null = null
  let latestRequest: LatestRefreshRequest<T> | null = null
  let revision = 0

  const runLatestRefreshFlight = Effect.fn('dashboardIntake.runLatestRefreshFlight')(function*() {
    while (latestRequest) {
      const requestRevision = revision
      const currentRequest = latestRequest
      const runResult = yield* Effect.result(currentRequest.run)
      if (Result.isFailure(runResult)) {
        if (requestRevision !== revision) continue
        return yield* Effect.fail(runResult.failure)
      }
      if (requestRevision !== revision) continue
      const applyResult = yield* Effect.result(Effect.try({
        try: () => currentRequest.apply(runResult.success),
        catch: (cause) => DashboardRefreshRunError.make({ cause })
      }))
      if (Result.isFailure(applyResult)) {
        if (requestRevision !== revision) continue
        return yield* Effect.fail(applyResult.failure)
      }
      if (requestRevision !== revision) continue
      latestRequest = null
      return
    }
  })

  function schedule(
    run: Effect.Effect<T, DashboardRefreshRunError, BrowserTabs>,
    apply: (value: T) => void
  ): Promise<void> {
    latestRequest = { apply, run }
    revision += 1
    if (inFlight) return inFlight

    const flight = getAppRuntime().runPromise(runLatestRefreshFlight().pipe(
      Effect.catchTag('DashboardRefreshRunError', (error) => Effect.fail(error.cause))
    ))
    inFlight = flight
    const clearFlight = () => {
      if (inFlight === flight) inFlight = null
    }
    void flight.then(clearFlight, clearFlight)
    return flight
  }

  function request(run: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    return schedule(Effect.tryPromise({
      try: run,
      catch: (cause) => DashboardRefreshRunError.make({ cause })
    }), apply)
  }

  function requestEffect<Failure>(
    run: Effect.Effect<T, Failure, BrowserTabs>,
    apply: (value: T) => void
  ): Promise<void> {
    return schedule(run.pipe(
      Effect.mapError((cause) => DashboardRefreshRunError.make({ cause }))
    ), apply)
  }

  return {
    active: () => inFlight !== null,
    request,
    requestEffect,
    wait: () => inFlight ?? Promise.resolve()
  }
}

export function dashboardRefreshContextMatches(
  request: DashboardRefreshContext,
  current: DashboardRefreshContext
): boolean {
  const sourceAndPinsMatch = request.source === current.source &&
    request.pinnedDomains.length === current.pinnedDomains.length &&
    request.pinnedDomains.every((domain, index) => domain === current.pinnedDomains[index])
  return sourceAndPinsMatch &&
    request.filter === current.filter &&
    request.historyRange === current.historyRange &&
    request.historyFilterEnabled === current.historyFilterEnabled
}

export function retainHistorySearchResultsOnError(
  nextDashboard: DashboardData,
  previousDashboard: DashboardData | null
): DashboardData {
  if (
    nextDashboard.historySearchStatus !== 'error' ||
    !previousDashboard ||
    previousDashboard.historySearchQuery !== nextDashboard.historySearchQuery
  ) return nextDashboard

  return {
    ...nextDashboard,
    historyTabs: previousDashboard.historyTabs ?? [],
    historyDomainGroups: previousDashboard.historyDomainGroups ?? []
  }
}

// Keep the first-keystroke bookmark read reachable across the delayed History
// refresh scheduling seam. This grace period delays neither browser read.
const BOOKMARK_COMPANION_FLIGHT_GRACE_MS = 200
let bookmarkCompanionSourceItemsFlight: Promise<BrowserReadResult<DashboardTab[]>> | null = null

function fetchBookmarksSourceItemsShared(
  holdForCompanion = false,
  reuseCompanion = false
): Promise<BrowserReadResult<DashboardTab[]>> {
  if (reuseCompanion && bookmarkCompanionSourceItemsFlight) return bookmarkCompanionSourceItemsFlight

  const flight = import('../extension/bookmarks.js')
    .then((bookmarks) => bookmarks.fetchBookmarksSourceItemsResult())
  if (holdForCompanion) {
    bookmarkCompanionSourceItemsFlight = flight
    const clearFlight = () => {
      if (bookmarkCompanionSourceItemsFlight === flight) bookmarkCompanionSourceItemsFlight = null
    }
    void flight.then(
      () => setTimeout(clearFlight, BOOKMARK_COMPANION_FLIGHT_GRACE_MS),
      clearFlight
    )
  }
  return flight
}

const fetchBookmarksSourceItemsLazyEffect = Effect.fn(
  'dashboardIntake.fetchBookmarks'
)((holdForCompanion = false, reuseCompanion = false) => Effect.tryPromise({
  try: () => fetchBookmarksSourceItemsShared(holdForCompanion, reuseCompanion),
  catch: (cause) => DashboardSnapshotFetchError.make({ cause })
}))

const fetchHistorySourceItemsLazyEffect = Effect.fn(
  'dashboardIntake.fetchHistory'
)(function*(query: string, range: string) {
  const history = yield* Effect.tryPromise({
    try: () => import('../extension/history-source.js'),
    catch: (cause) => DashboardSnapshotFetchError.make({ cause })
  })
  return yield* Effect.tryPromise({
    try: () => history.fetchHistorySourceSearch(query, range),
    catch: (cause) => DashboardSnapshotFetchError.make({ cause })
  })
})

const fetchBookmarkCompanionSnapshotEffect = Effect.fn(
  'dashboardIntake.fetchBookmarkCompanion'
)(function*({ pinnedDomains, previousOrder }: Pick<DashboardSnapshotOptions, 'pinnedDomains' | 'previousOrder'>) {
  const bookmarkTabsResult = yield* fetchBookmarksSourceItemsLazyEffect(true, true)
  if (!bookmarkTabsResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read bookmarks'))

  const bookmarkDashboard = yield* fetchDashboardDataEffect(
    previousOrder.bookmarks || new Map(),
    'bookmarks',
    {
      pinnedDomains,
      bookmarkTabs: bookmarkTabsResult.value
    }
  ).pipe(
    Effect.mapError((error) => DashboardSnapshotFetchError.make({ cause: error.cause }))
  )

  return {
    bookmarkTabs: bookmarkDashboard.realTabs,
    bookmarkDomainGroups: bookmarkDashboard.domainGroups
  }
})

function dashboardSnapshotReadError(message: string): DashboardSnapshotFetchError {
  return DashboardSnapshotFetchError.make({ cause: new Error(message) })
}

function dashboardStartupSnapshotReadError(message: string): DashboardStartupSnapshotFetchError {
  return DashboardStartupSnapshotFetchError.make({ cause: new Error(message) })
}

const fetchTabsDashboardSnapshotEffect = Effect.fn(
  'dashboardIntake.fetchTabsSnapshot'
)(function*({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, prefetchedBookmarkTabs, prefetchedServiceStateResult, savedPagesStore, previousOrder }: DashboardSnapshotOptions) {
  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [currentWindowResult, serviceStateResult, savedPagesResult, bookmarkTabsResult, historySearch] = yield* Effect.all([
    getCurrentWindowIdResultEffect(),
    prefetchedServiceStateResult
      ? Effect.succeed(prefetchedServiceStateResult)
      : fetchDashboardServiceStateResultEffect(),
    savedPagesStore
      ? Effect.succeed({ ok: true as const, value: savedPagesStore })
      : loadSavedPagesStoreResultEffect(),
    filterSearch.includeBookmarkMatches
      ? prefetchedBookmarkTabs === undefined
        ? fetchBookmarksSourceItemsLazyEffect(false, true)
        : Effect.succeed({ ok: true as const, value: prefetchedBookmarkTabs })
      : Effect.succeed({ ok: true as const, value: [] }),
    filterSearch.includeHistoryMatches
      ? fetchHistorySourceItemsLazyEffect(filterSearch.query, filterSearch.historyRange)
      : Effect.succeed({ status: 'ready' as const, tabs: [] })
  ] as const, { concurrency: 'unbounded' })
  if (!serviceStateResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read dashboard service state'))
  if (!currentWindowResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read current browser window'))
  if (!savedPagesResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read Saved Pages'))
  if (!bookmarkTabsResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read bookmarks'))
  const serviceState = serviceStateResult.value
  const currentWindowId = currentWindowResult.value
  const openTabsResult = yield* fetchOpenTabsSnapshotEffect(serviceState.openTabsSnapshot)
  if (!openTabsResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read open tabs'))
  const openTabs = openTabsResult.tabs
  const resolvedSavedPagesStore = savedPagesResult.value
  const dashboardTabs = getDashboardTabsFromOpenTabs(openTabs)
  const { dashboard, savedPageUpdates } = yield* buildDashboardDataFromTabsEffect(
    dashboardTabs,
    currentWindowId,
    previousOrder[source] || new Map(),
    {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange,
      historySearchStatus: historySearch.status,
      bookmarkTabs: bookmarkTabsResult.value,
      historyTabs: historySearch.tabs,
      savedPagesStore: resolvedSavedPagesStore,
      retainedPages: serviceState.retainedPages,
      retainedLiveTabs: openTabs
    }
  ).pipe(
    Effect.mapError((error) => DashboardSnapshotFetchError.make({ cause: error.cause }))
  )
  // Page fetchers are the Saved Pages metadata writers; the build stays pure.
  yield* persistSavedPageMetadataUpdatesEffect(
    savedPageUpdates.base,
    savedPageUpdates.merged
  ).pipe(
    Effect.catchTag('SavedPagesMutationError', () => Effect.void),
    Effect.forkDetach({ startImmediately: true })
  )
  const workingSet = buildWorkingSetSnapshot({
    tabs: dashboardTabs,
    activity: serviceState.workingSetActivity,
    currentWindowId
  })

  return { dashboard, tabHistory: serviceState.tabHistory, workingSet }
})

export const fetchDashboardSnapshotEffect = Effect.fn(
  'dashboardIntake.fetchSnapshot'
)(function*({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder }: DashboardSnapshotOptions) {
  if (source === 'tabs') {
    return yield* fetchTabsDashboardSnapshotEffect({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder })
  }

  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [bookmarkTabsResult, savedPagesResult] = yield* Effect.all([
    source === 'bookmarks'
      ? fetchBookmarksSourceItemsLazyEffect()
      : Effect.succeed({ ok: true as const, value: [] }),
    loadSavedPagesStoreResultEffect()
  ] as const, { concurrency: 'unbounded' })
  if (!savedPagesResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read Saved Pages'))
  if (!bookmarkTabsResult.ok) return yield* Effect.fail(dashboardSnapshotReadError('Could not read bookmarks'))
  const dashboard = yield* fetchDashboardDataEffect(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange,
      bookmarkTabs: bookmarkTabsResult.value,
      savedPagesStore: savedPagesResult.value
    }).pipe(
      Effect.mapError((error) => DashboardSnapshotFetchError.make({ cause: error.cause }))
    )

  return { dashboard }
})

export function fetchDashboardSnapshot(options: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  return getAppRuntime().runPromise(fetchDashboardSnapshotEffect(options).pipe(
    Effect.catchTag('DashboardSnapshotFetchError', (error) => Effect.fail(error.cause))
  ))
}

const fetchDashboardStartupSnapshotOnceEffect = Effect.fn(
  'dashboardIntake.fetchStartupSnapshotOnce'
)(function*(options: DashboardSnapshotOptions) {
  if (isClosedTabFetchSuppressed()) {
    return yield* Effect.fail(dashboardStartupSnapshotReadError('Recently closed is settling after restore'))
  }
  const filterSearch = buildFilterSearchRequest(options)
  const [
    currentWindowResult,
    serviceStateResult,
    savedPagesResult,
    closedTabsResult,
    bookmarkTabsResult,
    historySearch
  ] = yield* Effect.all([
    getCurrentWindowIdResultEffect(),
    options.prefetchedServiceStateResult
      ? Effect.succeed(options.prefetchedServiceStateResult)
      : fetchDashboardServiceStateResultEffect(),
    options.savedPagesStore
      ? Effect.succeed({ ok: true as const, value: options.savedPagesStore })
      : loadSavedPagesStoreResultEffect(),
    fetchClosedTabsResultEffect(),
    filterSearch.includeBookmarkMatches
      ? fetchBookmarksSourceItemsLazyEffect()
      : Effect.succeed({ ok: true as const, value: [] }),
    filterSearch.includeHistoryMatches
      ? fetchHistorySourceItemsLazyEffect(filterSearch.query, filterSearch.historyRange)
      : Effect.succeed({ status: 'ready' as const, tabs: [] })
  ] as const, { concurrency: 'unbounded' })
  if (!serviceStateResult.ok) return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read dashboard service state'))
  if (!currentWindowResult.ok) return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read current browser window'))
  if (!savedPagesResult.ok) return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read Saved Pages'))
  if (!closedTabsResult.ok) return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read recently closed tabs'))
  if (!bookmarkTabsResult.ok) return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read bookmarks'))
  if (historySearch.status === 'error') return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read history'))
  const openTabsResult = yield* fetchOpenTabsSnapshotEffect(serviceStateResult.value.openTabsSnapshot)
  if (!openTabsResult.ok) return yield* Effect.fail(dashboardStartupSnapshotReadError('Could not read open tabs'))
  const { snapshot, savedPageUpdates } = yield* buildTabsDashboardStartupSnapshotEffect({
    dashboardTabs: getDashboardTabsFromOpenTabs(openTabsResult.tabs),
    retainedLiveTabs: openTabsResult.tabs,
    currentWindowId: currentWindowResult.value,
    tabHistory: serviceStateResult.value.tabHistory,
    workingSetActivity: serviceStateResult.value.workingSetActivity,
    savedPagesStore: savedPagesResult.value,
    retainedPages: serviceStateResult.value.retainedPages,
    closedTabs: closedTabsResult.value,
    pinnedDomains: options.pinnedDomains,
    tabPreviousOrder: options.previousOrder.tabs || new Map(),
    filterSearch: {
      bookmarkTabs: bookmarkTabsResult.value,
      historyRange: filterSearch.historyRange,
      historySearchStatus: historySearch.status,
      historyTabs: historySearch.tabs,
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      query: filterSearch.query
    }
  }).pipe(
    Effect.mapError((error) => DashboardStartupSnapshotFetchError.make({ cause: error.cause }))
  )
  // Page fetchers are the Saved Pages metadata writers; the build stays pure.
  yield* persistSavedPageMetadataUpdatesEffect(
    savedPageUpdates.base,
    savedPageUpdates.merged
  ).pipe(
    Effect.catchTag('SavedPagesMutationError', () => Effect.void),
    Effect.forkDetach({ startImmediately: true })
  )
  return snapshot
})

/** Fresh, unshared capture for the startup admission transaction. */
export const fetchDashboardStartupSnapshotEffect = fetchDashboardStartupSnapshotOnceEffect

export function fetchDashboardStartupSnapshot(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  return getAppRuntime().runPromise(fetchDashboardStartupSnapshotEffect(options).pipe(
    Effect.catchTag('DashboardStartupSnapshotFetchError', (error) => Effect.fail(error.cause))
  ))
}

export type AppDashboardState = {
  closedTabs: readonly ClosedTabEntry[]
  dashboard: DashboardData | null
  deferredStartupPriorityWorkingSet: WorkingSetSnapshot | null
  deferredStartupSourceFields: Partial<AppDashboardSnapshotFields> | null
  historyRange: string
  historySearchPending: boolean
  source: DashboardSource
  sourceAppliedRequestId: number
  sourceRequestId: number
  sourceSelection: DashboardSource
  startupPriorityWorkingSet: WorkingSetSnapshot | null
  startupStateApplied: boolean
  tabHistory: TabHistorySnapshot | null
  workingSet: WorkingSetSnapshot | null
}
type AppDashboardSnapshotFields = Pick<AppDashboardState, 'closedTabs' | 'dashboard' | 'tabHistory' | 'workingSet'>
export type AppDashboardAction =
  | { type: 'closedTabs'; closedTabs: readonly ClosedTabEntry[] }
  | { type: 'dashboard'; dashboard: DashboardData | null }
  | { type: 'historyRange'; historyRange: string }
  | { type: 'historySearchPending'; historySearchPending: boolean }
  | { type: 'source'; source: DashboardSource }
  | { type: 'startupSourceSelection'; source: DashboardSource }
  | { type: 'sourceRequestCancelled' }
  | { type: 'sourceRequest'; requestId: number; source: DashboardSource }
  | { type: 'sourceRequestFailed'; requestId: number }
  | { type: 'startupPriorityCleared' }
  | { type: 'tabHistory'; tabHistory: TabHistorySnapshot | null }
  | { type: 'workingSet'; workingSet: WorkingSetSnapshot | null }
  | {
      type: 'startup'
      historyRange: string
      snapshot: DashboardStartupSnapshot | null
      source?: DashboardSource
    }
  | {
      type: 'sourceSnapshot'
      dashboard: DashboardData | null
      requestId: number
      source: DashboardSource
      tabHistory?: TabHistorySnapshot
      workingSet?: WorkingSetSnapshot
    }

export function initialAppDashboardState({
  historyRange,
  snapshot
}: {
  historyRange: string
  snapshot: DashboardStartupSnapshot | null
}): AppDashboardState {
  return {
    ...appDashboardSnapshotFields(snapshot),
    deferredStartupPriorityWorkingSet: null,
    deferredStartupSourceFields: null,
    historyRange,
    historySearchPending: false,
    source: 'tabs',
    sourceAppliedRequestId: 0,
    sourceRequestId: 0,
    sourceSelection: 'tabs',
    startupPriorityWorkingSet: snapshot?.workingSet ?? null,
    startupStateApplied: snapshot !== null
  }
}

function appDashboardSnapshotFields(
  snapshot: DashboardStartupSnapshot | null
): AppDashboardSnapshotFields {
  return {
    closedTabs: snapshot?.closedTabs ?? [],
    dashboard: snapshot?.dashboard ?? null,
    tabHistory: snapshot?.tabHistory ?? null,
    workingSet: snapshot?.workingSet ?? null
  }
}

function startupSnapshotFieldsAfterLiveUpdates(
  state: AppDashboardState,
  snapshot: DashboardStartupSnapshot | null
): AppDashboardSnapshotFields {
  const cachedFields = appDashboardSnapshotFields(snapshot)
  return !state.startupStateApplied && state.deferredStartupSourceFields
    ? { ...cachedFields, ...state.deferredStartupSourceFields }
    : cachedFields
}

function clearDashboardHistorySearch(dashboard: DashboardData | null, historyRange: string): DashboardData | null {
  if (!dashboard) return null
  return {
    ...dashboard,
    historyTabs: [],
    historyDomainGroups: [],
    historySearchQuery: '',
    historyRange,
    historySearchStatus: 'idle'
  }
}

function settleSourceRequestWithoutSnapshot(state: AppDashboardState): AppDashboardState {
  const restoreDeferredStartup = state.startupStateApplied &&
    state.source === 'tabs' &&
    state.sourceAppliedRequestId === 0 &&
    state.deferredStartupSourceFields
  return {
    ...state,
    ...(restoreDeferredStartup ?? {}),
    deferredStartupPriorityWorkingSet: null,
    deferredStartupSourceFields: state.startupStateApplied
      ? null
      : state.deferredStartupSourceFields,
    sourceRequestId: state.sourceAppliedRequestId,
    sourceSelection: state.source,
    startupPriorityWorkingSet: state.deferredStartupPriorityWorkingSet ?? state.startupPriorityWorkingSet
  }
}

function updateAppDashboardSnapshotField<K extends keyof AppDashboardSnapshotFields>(
  state: AppDashboardState,
  field: K,
  value: AppDashboardSnapshotFields[K]
): AppDashboardState {
  const deferredStartupSourceFields = state.deferredStartupSourceFields
  if (!state.startupStateApplied || deferredStartupSourceFields) {
    if (deferredStartupSourceFields &&
      Object.hasOwn(deferredStartupSourceFields, field) &&
      deferredStartupSourceFields[field] === value) return state
    return {
      ...state,
      deferredStartupSourceFields: {
        ...deferredStartupSourceFields,
        [field]: value
      }
    }
  }
  if (state[field] === value) return state
  return { ...state, [field]: value }
}

export function appDashboardReducer(state: AppDashboardState, action: AppDashboardAction): AppDashboardState {
  switch (action.type) {
    case 'closedTabs':
      return updateAppDashboardSnapshotField(state, 'closedTabs', action.closedTabs)
    case 'dashboard':
      return updateAppDashboardSnapshotField(state, 'dashboard', action.dashboard)
    case 'historyRange': {
      if (state.historyRange === action.historyRange) return state
      return {
        ...state,
        dashboard: isHistoryFilterEnabled(action.historyRange)
          ? state.dashboard
          : clearDashboardHistorySearch(state.dashboard, action.historyRange),
        historyRange: action.historyRange
      }
    }
    case 'historySearchPending':
      return state.historySearchPending === action.historySearchPending
        ? state
        : { ...state, historySearchPending: action.historySearchPending }
    case 'source':
      return state.source === action.source && state.sourceSelection === action.source
        ? state
        : { ...state, source: action.source, sourceSelection: action.source }
    case 'startupSourceSelection':
      return state.sourceSelection === action.source
        ? state
        : { ...state, sourceSelection: action.source }
    case 'sourceRequest':
      return {
        ...state,
        sourceRequestId: action.requestId,
        sourceSelection: action.source,
        startupPriorityWorkingSet: null
      }
    case 'sourceRequestCancelled':
      return settleSourceRequestWithoutSnapshot(state)
    case 'sourceRequestFailed': {
      if (action.requestId !== state.sourceRequestId) return state
      return settleSourceRequestWithoutSnapshot(state)
    }
    case 'startupPriorityCleared':
      return state.startupPriorityWorkingSet === null
        ? state
        : { ...state, startupPriorityWorkingSet: null }
    case 'tabHistory':
      return updateAppDashboardSnapshotField(state, 'tabHistory', action.tabHistory)
    case 'workingSet':
      return updateAppDashboardSnapshotField(state, 'workingSet', action.workingSet)
    case 'startup': {
      const sourceSnapshotFields = startupSnapshotFieldsAfterLiveUpdates(state, action.snapshot)
      const startupSource = action.source ?? 'tabs'
      const applySourceSnapshot = state.sourceRequestId === 0 &&
        state.sourceAppliedRequestId === 0 &&
        state.sourceSelection === startupSource
      const applySupplementalFields = state.sourceAppliedRequestId !== 0
      return {
        ...state,
        deferredStartupPriorityWorkingSet: !applySourceSnapshot && startupSource === 'tabs' && state.sourceAppliedRequestId === 0 && state.source === 'tabs'
          ? action.snapshot?.workingSet ?? null
          : null,
        deferredStartupSourceFields: !applySourceSnapshot && state.sourceAppliedRequestId === 0
          ? sourceSnapshotFields
          : null,
        historyRange: action.historyRange,
        source: applySourceSnapshot ? startupSource : state.source,
        startupPriorityWorkingSet: applySourceSnapshot && startupSource === 'tabs'
          ? action.snapshot?.workingSet ?? null
          : state.startupPriorityWorkingSet,
        startupStateApplied: true,
        // A source request is causally newer than the admitted startup frame.
        // Its completed or pending dashboard generation must survive a late
        // frame instead of flashing back to the Tabs startup snapshot.
        ...(applySourceSnapshot
          ? sourceSnapshotFields
          : applySupplementalFields
            ? {
                closedTabs: sourceSnapshotFields.closedTabs,
                tabHistory: sourceSnapshotFields.tabHistory,
                workingSet: sourceSnapshotFields.workingSet
              }
            : {})
      }
    }
    case 'sourceSnapshot': {
      if (action.requestId !== state.sourceRequestId) return state
      const deferredSupplementalFields: Partial<AppDashboardSnapshotFields> = {}
      const deferredFields = state.deferredStartupSourceFields
      if (deferredFields) {
        const deferredClosedTabs = deferredFields.closedTabs
        if (deferredClosedTabs !== undefined) {
          deferredSupplementalFields.closedTabs = deferredClosedTabs
        }
        const deferredTabHistory = deferredFields.tabHistory
        if (action.tabHistory === undefined && deferredTabHistory !== undefined) {
          deferredSupplementalFields.tabHistory = deferredTabHistory
        }
        const deferredWorkingSet = deferredFields.workingSet
        if (action.workingSet === undefined && deferredWorkingSet !== undefined) {
          deferredSupplementalFields.workingSet = deferredWorkingSet
        }
      }
      const deferredStartupSourceFields = state.startupStateApplied
        ? null
        : {
            ...deferredFields,
            dashboard: action.dashboard,
            ...(action.tabHistory === undefined ? {} : { tabHistory: action.tabHistory }),
            ...(action.workingSet === undefined ? {} : { workingSet: action.workingSet })
          }
      return {
        ...state,
        ...deferredSupplementalFields,
        dashboard: action.dashboard,
        deferredStartupPriorityWorkingSet: null,
        deferredStartupSourceFields,
        source: action.source,
        sourceAppliedRequestId: action.requestId,
        sourceSelection: action.source,
        startupPriorityWorkingSet: null,
        ...(action.tabHistory !== undefined ? { tabHistory: action.tabHistory } : {}),
        ...(action.workingSet !== undefined ? { workingSet: action.workingSet } : {})
      }
    }
  }
}

export type DashboardRefreshInputs = {
  filter: string
  localStateLoaded: boolean
  pinnedDomains: readonly string[]
  previousOrder: MissionOrderMap
}

export type DashboardRefreshRequestOptions = DashboardRefreshOptions

export type DashboardBeforeApplyEvent =
  | { reason: 'animated-refresh' }
  | { reason: 'source-switch'; requestId: number }

export type AppDashboardStoreDependencies = {
  cancelTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  closedTabFetchSuppressionRemainingMs?: typeof closedTabFetchSuppressionRemainingMs
  fetchDashboardSnapshot?: typeof fetchDashboardSnapshot
  fetchDashboardSnapshotEffect?: typeof fetchDashboardSnapshotEffect
  fetchClosedTabsResult?: typeof fetchClosedTabsResult
  fetchClosedTabsResultEffect?: typeof fetchClosedTabsResultEffect
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  showToast?: typeof showToast
  subscribeClosedTabChanges?: typeof subscribeClosedTabChanges
}

export type AppDashboardStore = {
  applyStartup: (startup: { historyRange: string; snapshot: DashboardStartupSnapshot | null; source?: DashboardSource }) => void
  clearStartupPriority: () => void
  dispatch: (action: AppDashboardAction) => void
  hydrateBookmarkCompanion: () => Promise<void>
  read: () => AppDashboardState
  readBuildTime: () => AppDashboardState
  refresh: (options?: DashboardRefreshRequestOptions) => Promise<void>
  selectStartupSource: (source: DashboardSource) => void
  setRefreshInputs: (inputs: DashboardRefreshInputs) => void
  startClosedTabUpdates: () => () => void
  subscribe: (listener: () => void) => () => void
  subscribeBeforeApply: (listener: (event: DashboardBeforeApplyEvent) => void) => () => void
  switchSource: (nextSource: DashboardSource) => number | null
}

/**
 * The Dashboard Intake store: every arrival — startup frame admission,
 * live refreshes, source switches, and closed-tab updates — applies through
 * this one dispatch, and the page renders its snapshot. The frozen
 * build-time state backs the hydration render, so the first client render
 * reproduces the generated shell exactly. subscribeBeforeApply fires
 * synchronously just before an arrival's dispatches so the React layer can
 * capture pre-commit DOM geometry; the store itself stays DOM-free.
 */
export function createAppDashboardStore(
  dependencies: AppDashboardStoreDependencies = {}
): AppDashboardStore {
  const {
    cancelTimeout = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    closedTabFetchSuppressionRemainingMs: readClosedTabFetchSuppressionRemainingMs = closedTabFetchSuppressionRemainingMs,
    fetchDashboardSnapshot: fetchSourceSwitchSnapshot = fetchDashboardSnapshot,
    fetchClosedTabsResult: fetchLatestClosedTabsResult = fetchClosedTabsResult,
    scheduleTimeout = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    showToast: showSourceSwitchToast = showToast,
    subscribeClosedTabChanges: subscribeToClosedTabChanges = subscribeClosedTabChanges
  } = dependencies
  const fetchSourceSwitchSnapshotEffect = dependencies.fetchDashboardSnapshotEffect ?? (
    dependencies.fetchDashboardSnapshot ? null : fetchDashboardSnapshotEffect
  )
  const fetchLatestClosedTabsEffect = dependencies.fetchClosedTabsResultEffect ?? (
    dependencies.fetchClosedTabsResult ? null : fetchClosedTabsResultEffect
  )
  const buildTimeState = initialAppDashboardState({
    historyRange: DEFAULT_HISTORY_RANGE,
    snapshot: null
  })
  let state = buildTimeState
  const listeners = new Set<() => void>()
  const beforeApplyListeners = new Set<(event: DashboardBeforeApplyEvent) => void>()
  let refreshInputs: DashboardRefreshInputs | null = null
  const refreshRunner = createLatestRefreshRunner<DashboardRefreshSnapshot>()
  const bookmarkCompanionRunner = createLatestRefreshRunner<BookmarkCompanionSnapshot>()
  let prefetchedBookmarkTabs: DashboardTab[] | null = null
  let animatedRefreshPending = false
  let historySearchPendingRevision = 0
  let sourceSwitchSequence = 0
  let activeSourceSwitch: {
    readonly id: object
    interrupt: () => void
  } | null = null

  function dispatch(action: AppDashboardAction): void {
    const nextState = appDashboardReducer(state, action)
    if (nextState === state) return
    state = nextState
    for (const listener of [...listeners]) listener()
  }

  function emitBeforeApply(event: DashboardBeforeApplyEvent): void {
    for (const listener of [...beforeApplyListeners]) listener(event)
  }

  function waitForClosedTabsDelay(delayMs: number): Effect.Effect<void> {
    return Effect.callback((resume) => {
      const timer = scheduleTimeout(
        () => resume(Effect.void),
        Math.max(1, Math.ceil(delayMs))
      )
      return Effect.sync(() => cancelTimeout(timer))
    })
  }

  const refreshClosedTabs = Effect.fn('dashboardIntake.refreshClosedTabs')(function*(
    settleDelayMs = 0
  ) {
    let minimumDelayMs = settleDelayMs
    while (true) {
      const suppressionRemainingMs = readClosedTabFetchSuppressionRemainingMs()
      const delayMs = Math.max(minimumDelayMs, suppressionRemainingMs)
      minimumDelayMs = 0
      if (!Number.isFinite(delayMs)) {
        // An unresolved sessions.restore has no safe deadline. Its settlement
        // emits another change notification that starts the finite trailing fiber.
        return
      }
      if (delayMs > 0) {
        yield* waitForClosedTabsDelay(delayMs)
        continue
      }
      const result = yield* (fetchLatestClosedTabsEffect
        ? fetchLatestClosedTabsEffect()
        : Effect.tryPromise({
            try: fetchLatestClosedTabsResult,
            catch: (cause) => DashboardClosedTabsFetchError.make({ cause })
          }))
      if (result.ok) {
        yield* Effect.sync(() => dispatch({ type: 'closedTabs', closedTabs: result.value }))
      }
      return
    }
  })

  const runClosedTabUpdates = Effect.fn('dashboardIntake.runClosedTabUpdates')(function*() {
    const runRefresh = yield* FiberHandle.makeRuntime<BrowserTabs, never, void>()
    yield* Effect.acquireRelease(
      Effect.sync(() => subscribeToClosedTabChanges((settleDelayMs) => {
        runRefresh(refreshClosedTabs(settleDelayMs).pipe(
          Effect.catchTag('DashboardClosedTabsFetchError', () => Effect.void)
        ))
      })),
      (unsubscribe) => Effect.sync(() => unsubscribe())
    )
    return yield* Effect.never
  })

  function startClosedTabUpdates(): () => void {
    return getAppRuntime().runCallback(Effect.scoped(runClosedTabUpdates()))
  }

  async function hydrateBookmarkCompanion(): Promise<void> {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (state.source !== 'tabs' || state.sourceSelection !== 'tabs' || state.dashboard?.bookmarkSearchReady) return
    const inputs = refreshInputs
    if (!inputs?.localStateLoaded) return
    const pinnedDomains = [...inputs.pinnedDomains]

    await bookmarkCompanionRunner.requestEffect(
      fetchBookmarkCompanionSnapshotEffect({
        pinnedDomains,
        previousOrder: inputs.previousOrder
      }),
      (bookmarkCompanion) => {
        const dashboard = state.dashboard
        if (!dashboard || state.source !== 'tabs' || state.sourceSelection !== 'tabs') return
        prefetchedBookmarkTabs = bookmarkCompanion.bookmarkTabs
        dispatch({
          type: 'dashboard',
          dashboard: {
            ...dashboard,
            ...bookmarkCompanion,
            bookmarkSearchReady: true
          }
        })
      }
    )
  }

  function refreshContextFromInputs(
    inputs: DashboardRefreshInputs,
    source: DashboardSource = state.source
  ): DashboardRefreshContext {
    return {
      filter: inputs.filter,
      historyFilterEnabled: isHistoryFilterEnabled(state.historyRange),
      historyRange: state.historyRange,
      pinnedDomains: inputs.pinnedDomains,
      source
    }
  }

  function failSourceSwitch(requestId: number): void {
    dispatch({ type: 'sourceRequestFailed', requestId })
    showSourceSwitchToast('Could not switch source')
  }

  const runSourceSwitch = Effect.fn('dashboardIntake.runSourceSwitch')(function*(
    requestId: number,
    nextSource: DashboardSource
  ) {
    while (true) {
      const inputs = refreshInputs
      if (!inputs) {
        failSourceSwitch(requestId)
        return
      }
      const requestContext: DashboardRefreshContext = {
        ...refreshContextFromInputs(inputs, nextSource),
        pinnedDomains: [...inputs.pinnedDomains]
      }
      const snapshotOptions: DashboardSnapshotOptions = {
        source: nextSource,
        filter: requestContext.filter,
        historyRange: requestContext.historyRange,
        historyFilterEnabled: requestContext.historyFilterEnabled,
        pinnedDomains: [...requestContext.pinnedDomains],
        previousOrder: inputs.previousOrder
      }
      const sourceSnapshot = fetchSourceSwitchSnapshotEffect
        ? fetchSourceSwitchSnapshotEffect(snapshotOptions).pipe(
            Effect.mapError((error) => DashboardSourceFetchError.make({ cause: error.cause }))
          )
        : Effect.tryPromise({
            try: () => fetchSourceSwitchSnapshot(snapshotOptions),
            catch: (cause) => DashboardSourceFetchError.make({ cause })
          })
      const result = yield* Effect.result(sourceSnapshot)
      const latestInputs = refreshInputs
      if (Result.isFailure(result)) {
        if (
          latestInputs &&
          !dashboardRefreshContextMatches(
            requestContext,
            refreshContextFromInputs(latestInputs, nextSource)
          )
        ) continue
        failSourceSwitch(requestId)
        return
      }
      if (
        !latestInputs ||
        !dashboardRefreshContextMatches(
          requestContext,
          refreshContextFromInputs(latestInputs, nextSource)
        )
      ) continue
      const snapshot = result.success
      emitBeforeApply({ reason: 'source-switch', requestId })
      dispatch({
        type: 'sourceSnapshot',
        dashboard: snapshot.dashboard,
        requestId,
        source: nextSource,
        ...(snapshot.tabHistory === undefined ? {} : { tabHistory: snapshot.tabHistory }),
        ...(snapshot.workingSet === undefined ? {} : { workingSet: snapshot.workingSet })
      })
      return
    }
  })

  function interruptActiveSourceSwitch(): void {
    const active = activeSourceSwitch
    activeSourceSwitch = null
    active?.interrupt()
  }

  function startSourceSwitch(requestId: number, nextSource: DashboardSource): void {
    const id = {}
    const active = {
      id,
      interrupt: () => {}
    }
    activeSourceSwitch = active
    active.interrupt = getAppRuntime().runCallback(runSourceSwitch(requestId, nextSource), {
      onExit: () => {
        if (activeSourceSwitch?.id === id) activeSourceSwitch = null
      }
    })
  }

  function switchSource(nextSource: DashboardSource): number | null {
    if (nextSource === state.sourceSelection) return null
    sourceSwitchSequence += 1
    const requestId = sourceSwitchSequence
    interruptActiveSourceSwitch()
    if (nextSource === state.source) {
      dispatch({ type: 'sourceRequestCancelled' })
      return null
    }
    dispatch({ type: 'sourceRequest', requestId, source: nextSource })
    startSourceSwitch(requestId, nextSource)
    return requestId
  }

  /*
   * Effect owns the source-switch lifecycle above: a later request interrupts
   * the previous fiber, and only the surviving fiber may retry or dispatch.
   * Keep the Promise-based browser adapters and the store interface at this
   * seam so React callers do not need to understand Effect runtime types.
   */

  async function refresh({
    animateCards = false
  }: DashboardRefreshRequestOptions = {}): Promise<void> {
    if (animateCards) animatedRefreshPending = true
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    const inputs = refreshInputs
    if (!inputs?.localStateLoaded) return
    const requestContext: DashboardRefreshContext = {
      ...refreshContextFromInputs(inputs),
      pinnedDomains: [...inputs.pinnedDomains]
    }
    const { filter, historyFilterEnabled, historyRange, pinnedDomains, source } = requestContext
    const previousOrder = inputs.previousOrder
    const filterSearch = buildFilterSearchRequest(requestContext)
    const tracksHistorySearch = filterSearch.includeHistoryMatches
    const historySearchRevision = tracksHistorySearch ? historySearchPendingRevision + 1 : 0
    if (tracksHistorySearch) {
      historySearchPendingRevision = historySearchRevision
      dispatch({ type: 'historySearchPending', historySearchPending: true })
    }
    const reusableBookmarkTabs = filterSearch.includeBookmarkMatches
      ? prefetchedBookmarkTabs
      : null
    if (reusableBookmarkTabs !== null) prefetchedBookmarkTabs = null
    const snapshotOptions: DashboardSnapshotOptions = {
      source,
      filter,
      historyRange,
      historyFilterEnabled,
      pinnedDomains: [...pinnedDomains],
      ...(reusableBookmarkTabs === null ? {} : { prefetchedBookmarkTabs: reusableBookmarkTabs }),
      previousOrder
    }
    const fetchRefreshSnapshot = Effect.gen(function*() {
      if (animatedRefreshPending) {
        yield* Effect.sync(() => emitBeforeApply({ reason: 'animated-refresh' }))
      }
      return yield* fetchDashboardSnapshotEffect(snapshotOptions).pipe(
        Effect.catchTag('DashboardSnapshotFetchError', (error) => Effect.fail(error.cause))
      )
    })
    try {
      await refreshRunner.requestEffect(
        fetchRefreshSnapshot,
        (snapshot) => {
          animatedRefreshPending = false
          const latestInputs = refreshInputs
          if (
            !latestInputs ||
            !dashboardRefreshContextMatches(
              requestContext,
              refreshContextFromInputs(latestInputs)
            )
          ) return
          dispatch({
            type: 'dashboard',
            dashboard: retainHistorySearchResultsOnError(snapshot.dashboard, state.dashboard)
          })
          if (snapshot.tabHistory !== undefined) dispatch({ type: 'tabHistory', tabHistory: snapshot.tabHistory })
          if (snapshot.workingSet !== undefined) dispatch({ type: 'workingSet', workingSet: snapshot.workingSet })
        }
      )
    } catch (error) {
      animatedRefreshPending = false
      throw error
    } finally {
      if (tracksHistorySearch && historySearchPendingRevision === historySearchRevision) {
        dispatch({ type: 'historySearchPending', historySearchPending: false })
      }
    }
  }

  return {
    applyStartup: ({ historyRange, snapshot, source }) => {
      dispatch({ type: 'startup', historyRange, snapshot, ...(source === undefined ? {} : { source }) })
    },
    clearStartupPriority: () => {
      dispatch({ type: 'startupPriorityCleared' })
    },
    dispatch,
    hydrateBookmarkCompanion,
    read: () => state,
    readBuildTime: () => buildTimeState,
    refresh,
    selectStartupSource: (source) => {
      dispatch({ type: 'startupSourceSelection', source })
    },
    setRefreshInputs: (inputs) => {
      refreshInputs = inputs
    },
    startClosedTabUpdates,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeBeforeApply(listener) {
      beforeApplyListeners.add(listener)
      return () => beforeApplyListeners.delete(listener)
    },
    switchSource
  }
}

export const appDashboardStore = createAppDashboardStore()

export function requestDashboardRefresh(options: DashboardRefreshOptions = {}): Promise<void> {
  return appDashboardStore.refresh(options)
}

/** Replace the global refresh target for a focused test and restore it afterward. */
export function replaceDashboardRefreshForTesting(
  refresh: (options?: DashboardRefreshOptions) => Promise<void> | void
): () => void {
  const previousRefresh = appDashboardStore.refresh
  const replacementRefresh: typeof appDashboardStore.refresh = async (options) => {
    await refresh(options)
  }
  appDashboardStore.refresh = replacementRefresh
  return () => {
    if (appDashboardStore.refresh === replacementRefresh) {
      appDashboardStore.refresh = previousRefresh
    }
  }
}
