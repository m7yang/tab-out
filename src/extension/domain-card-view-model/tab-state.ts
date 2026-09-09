/* ================================================================
   Tab state predicates — pure liveness and activity checks over a
   DashboardTab and the current window.

   These answer whether a tab is the active tab elsewhere, an open
   tab still loading, or the Tab Out page the user is looking at,
   and fold a duplicate set into the active-frame flags a chip
   paints. Presentation stays with the chip builders.
   ================================================================ */

import { isClosedSavedDashboardTab } from '../dashboard-source.js'
import type { DashboardTab } from '../types'

export function isActiveInOtherWindow(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active) return false
  if (tab.isApp) return false
  if (typeof currentWindowId !== 'number') return true
  return tab.windowId !== currentWindowId
}

export function isOpenTabLoading(tab: DashboardTab): boolean {
  return (tab.sourceType ?? 'tab') === 'tab' &&
    !isClosedSavedDashboardTab(tab) &&
    !tab.suspended &&
    tab.status === 'loading'
}

export function isCurrentTabOutPage(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active || !tab.isTabOut || tab.isApp) return false
  if (typeof currentWindowId !== 'number') return false
  return tab.windowId === currentWindowId
}

function isActiveInCurrentWindow(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active || tab.isApp) return false
  if (typeof currentWindowId !== 'number') return false
  return tab.windowId === currentWindowId
}

export function activeFrameStateForDuplicateSet(
  tabs: readonly DashboardTab[],
  currentWindowId: number | null,
): { activeInOtherWindow: boolean, activeChipFrame: boolean } {
  const activeInOtherWindow = tabs.some((tab) => isActiveInOtherWindow(tab, currentWindowId))
  const activeCurrentWindowDuplicate = tabs.length > 1 && tabs.some((tab) => isActiveInCurrentWindow(tab, currentWindowId))
  const activeCurrentTabOutPage = tabs.some((tab) => isCurrentTabOutPage(tab, currentWindowId))

  return {
    activeInOtherWindow,
    activeChipFrame: activeInOtherWindow || activeCurrentWindowDuplicate || activeCurrentTabOutPage,
  }
}
