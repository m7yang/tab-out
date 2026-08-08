/* ================================================================
   Dashboard Data Fetch — page-only browser reads and persistence.

   Shared dashboard builds live in render.ts so startup snapshot work can run
   in the service worker without importing the page's mutation runtime.
   ================================================================ */

import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { buildDomainGroups } from './domain-groups.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import {
  buildDashboardDataFromTabsEffect,
  getCurrentWindowIdResultEffect,
  type BuildDashboardDataOptions
} from './render.js'
import { annotateSavedPageHints, savedPageKeysFromStore } from './saved-pages.js'
import { loadSavedPagesStoreEffect } from './saved-pages-storage.js'
import { persistSavedPageMetadataUpdatesEffect } from './saved-pages-mutations.js'
import { fetchOpenTabsSnapshotEffect, getDashboardTabsFromOpenTabs } from './tabs.js'
import type { DashboardData, DashboardSource, DashboardTab } from './types'

type FetchDashboardDataOptions = BuildDashboardDataOptions & {
  dashboardTabs?: DashboardTab[]
  currentWindowId?: number | null
}

function dashboardTabsForDataEffect(
  dashboardTabs?: DashboardTab[],
  retainedLiveTabs?: readonly DashboardTab[]
) {
  if (dashboardTabs) {
    return Effect.succeed({
      dashboardTabs,
      retainedLiveTabs: retainedLiveTabs ?? dashboardTabs
    })
  }
  return fetchOpenTabsSnapshotEffect().pipe(
    Effect.map((result) => ({
      dashboardTabs: getDashboardTabsFromOpenTabs(result.tabs),
      retainedLiveTabs: result.tabs
    }))
  )
}

/** Refresh browser tab state and return the current page-side dashboard snapshot. */
export const fetchDashboardDataEffect = Effect.fn(
  'dashboard.fetchData'
)(function*(
  previousOrder: Map<string, number> = new Map(),
  source: DashboardSource = 'tabs',
  {
    pinnedDomains = [],
    bookmarkPreviousOrder = new Map(),
    historyPreviousOrder = new Map(),
    includeBookmarkMatches = false,
    includeHistoryMatches = false,
    searchQuery = '',
    historyRange = DEFAULT_HISTORY_RANGE,
    historySearchStatus = 'ready',
    dashboardTabs,
    bookmarkTabs = [],
    historyTabs = [],
    currentWindowId,
    savedPagesStore,
    retainedPages = [],
    retainedLiveTabs
  }: FetchDashboardDataOptions = {}
) {
  if (source === 'bookmarks') {
    const resolvedSavedPagesStore = savedPagesStore ?? (yield* loadSavedPagesStoreEffect())
    const realTabs = annotateSavedPageHints(bookmarkTabs, resolvedSavedPagesStore)
    const domainGroups = buildDomainGroups(realTabs, { previousOrder, pinnedDomains })
    return {
      realTabs,
      domainGroups,
      retainedPageSurfaceMatches: [],
      currentWindowId: null,
      bookmarkTabs: [],
      bookmarkDomainGroups: [],
      bookmarkSearchReady: false,
      historyTabs: [],
      historyDomainGroups: [],
      historySearchQuery: '',
      historyRange: DEFAULT_HISTORY_RANGE,
      historySearchStatus: 'idle' as const,
      // Merging only updates Saved Page record fields, so the pre-merge keys
      // also describe the history panel's saved state.
      savedKeys: savedPageKeysFromStore(resolvedSavedPagesStore)
    }
  }

  const [resolvedTabs, resolvedCurrentWindowId] = yield* Effect.all([
    dashboardTabsForDataEffect(dashboardTabs, retainedLiveTabs),
    currentWindowId === undefined
      ? getCurrentWindowIdResultEffect().pipe(Effect.map((result) => result.value))
      : Effect.succeed(currentWindowId)
  ] as const, { concurrency: 'unbounded' })
  const { dashboard, savedPageUpdates } = yield* buildDashboardDataFromTabsEffect(resolvedTabs.dashboardTabs, resolvedCurrentWindowId, previousOrder, {
    pinnedDomains,
    bookmarkPreviousOrder,
    historyPreviousOrder,
    includeBookmarkMatches,
    includeHistoryMatches,
    searchQuery,
    historyRange,
    historySearchStatus,
    bookmarkTabs,
    historyTabs,
    retainedPages,
    retainedLiveTabs: resolvedTabs.retainedLiveTabs,
    ...(savedPagesStore === undefined ? {} : { savedPagesStore })
  })
  // Page fetchers are the only Saved Pages metadata writers; builds stay pure
  // and the worker discards its copy of these updates.
  yield* persistSavedPageMetadataUpdatesEffect(
    savedPageUpdates.base,
    savedPageUpdates.merged
  ).pipe(
    Effect.catchTag('SavedPagesMutationError', () => Effect.void),
    Effect.forkDetach({ startImmediately: true })
  )
  return dashboard
})

export function fetchDashboardData(
  previousOrder: Map<string, number> = new Map(),
  source: DashboardSource = 'tabs',
  options: FetchDashboardDataOptions = {}
): Promise<Required<DashboardData>> {
  return getAppRuntime().runPromise(fetchDashboardDataEffect(previousOrder, source, options).pipe(
    Effect.catchTag('DashboardDataBuildError', (error) => Effect.fail(error.cause))
  ))
}
