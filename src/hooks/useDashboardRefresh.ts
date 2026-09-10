import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react'
import { dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { appDashboardStore, settleDashboardRefresh, type MissionOrderMap } from '../extension/dashboard-intake.js'
import type { DashboardData, DashboardSource } from '../extension/types'

type UseDashboardRefreshOptions = {
  bookmarkFilter: string
  dashboard: DashboardData | null
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  localStateLoaded: boolean
  initialDashboardIncludesPinnedDomains?: boolean
  previousOrder: MissionOrderMap
  onBeforePinnedRefresh?: () => void
}

/**
 * React adapter for the Dashboard Intake store's refresh path: it feeds the
 * store its page-side refresh inputs and turns React-observable changes
 * (filter search staleness, pinned-domain updates) into refresh requests.
 * The latest-wins arbitration itself lives in the store.
 */
export function useDashboardRefresh({
  bookmarkFilter,
  dashboard,
  source,
  filter,
  historyRange,
  historyFilterEnabled,
  pinnedDomains,
  localStateLoaded,
  initialDashboardIncludesPinnedDomains = false,
  previousOrder,
  onBeforePinnedRefresh,
}: UseDashboardRefreshOptions) {
  const pinnedRefreshInitializedRef = useRef(false)
  const bookmarkSearchActive = source === 'tabs' && bookmarkFilter.trim() !== ''
  // The pinned-refresh effect reacts to pin changes only; the callback it
  // notifies is read at call time without joining the dependency list.
  const notifyBeforePinnedRefresh = useEffectEvent(() => {
    onBeforePinnedRefresh?.()
  })

  useLayoutEffect(() => {
    appDashboardStore.setRefreshInputs({ filter, localStateLoaded, pinnedDomains, previousOrder })
  }, [filter, localStateLoaded, pinnedDomains, previousOrder])

  useEffect(() => {
    if (!localStateLoaded || !dashboard || !bookmarkSearchActive || dashboard.bookmarkSearchReady) return
    void settleDashboardRefresh(appDashboardStore.hydrateBookmarkCompanion())
  }, [bookmarkSearchActive, dashboard, localStateLoaded, pinnedDomains])

  useEffect(() => {
    if (!localStateLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => {
      void settleDashboardRefresh(appDashboardStore.refresh())
    })
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, localStateLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!localStateLoaded) return
    if (!pinnedRefreshInitializedRef.current) {
      pinnedRefreshInitializedRef.current = true
      if (initialDashboardIncludesPinnedDomains) return
    }
    notifyBeforePinnedRefresh()
    const frame = requestAnimationFrame(() => {
      void settleDashboardRefresh(appDashboardStore.refresh())
    })
    return () => cancelAnimationFrame(frame)
  }, [initialDashboardIncludesPinnedDomains, pinnedDomains, localStateLoaded])

  return { refreshDashboard: appDashboardStore.refresh }
}
