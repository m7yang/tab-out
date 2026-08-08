import type { DashboardSource, DashboardTab } from './types'

type DashboardSourceType = DashboardTab['sourceType']

export function dashboardSourceAllowsTabActions(source: DashboardSource) {
  return source === 'tabs'
}

export function dashboardSourceAllowsSideSearches(source: DashboardSource) {
  return source === 'tabs'
}

export function dashboardSourceItemName(source: DashboardSource, tabName = 'tab') {
  if (source === 'bookmarks') return 'bookmark'
  if (source === 'history') return 'history result'
  return tabName
}

export function dashboardSourceEmptyNoun(source: DashboardSource) {
  if (source === 'bookmarks') return 'bookmarks'
  if (source === 'history') return 'history results'
  return 'pages'
}

export function dashboardItemNameForTabs(tabs: ReadonlyArray<Pick<DashboardTab, 'sourceType'>>, tabName = 'tab') {
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'bookmark')) return 'bookmark'
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'history')) return 'history result'
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'saved-page')) return 'saved page'
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'retained-page')) return 'closed page'
  return tabName
}

export function isReadOnlyDashboardSourceType(sourceType: DashboardSourceType) {
  return sourceType === 'bookmark' ||
    sourceType === 'history' ||
    sourceType === 'saved-page' ||
    sourceType === 'retained-page'
}

export function isClosedSavedDashboardTab(tab: Pick<DashboardTab, 'sourceType' | 'closedSaved'>): boolean {
  return tab.sourceType === 'saved-page' || tab.sourceType === 'retained-page' || !!tab.closedSaved
}

type SuspendedAggregateItem = Pick<DashboardTab, 'sourceType' | 'closedSaved'> & { suspended?: boolean }

/**
 * allOpenTargetsSuspended(items) — true when a chip stands for at least one
 * open tab and every open tab behind it is suspended (no live target).
 * Closed/read-only items are never live, but they can't make a chip
 * "suspended" on their own either: a chip with no open tabs returns false —
 * its non-live look comes from the saved-closed treatment instead. Accepts
 * DashboardTabs (single/dupe/folded builds) and built chips (title-variant
 * groups), which share the three fields it reads.
 */
export function allOpenTargetsSuspended(items: ReadonlyArray<SuspendedAggregateItem>): boolean {
  const openTabs = items.filter((item) => (item.sourceType ?? 'tab') === 'tab' && !isClosedSavedDashboardTab(item))
  return openTabs.length > 0 && openTabs.every((item) => !!item.suspended)
}
