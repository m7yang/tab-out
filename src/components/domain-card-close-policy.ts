import { isClosedSavedDashboardTab } from '../extension/dashboard-source.js'
import { isRetainedPageCaptureEligible } from '../extension/retained-page-identity.js'
import type { DomainGroup } from '../extension/types.js'

type DomainCardClosePolicyInput = {
  closableCount: number
  filter: string
  group: DomainGroup
  removedCount: number
}

/** Whole-card removal is safe only when every rendered item disappears. */
export function domainCardCloseRemovesAllItems({
  closableCount,
  filter,
  group,
  removedCount
}: DomainCardClosePolicyInput): boolean {
  if (filter || removedCount === 0 || removedCount !== closableCount) return false
  const openItemCount = group.tabs.filter((tab) => !isClosedSavedDashboardTab(tab)).length
  const leavesSavedPage = group.tabs.some((tab) => tab.saved || isClosedSavedDashboardTab(tab))
  const leavesRetainedPage = group.tabs.some((tab) =>
    !isClosedSavedDashboardTab(tab) &&
    isRetainedPageCaptureEligible({
      surfaceKind: tab.isApp ? 'app' : 'normal-tab',
      url: tab.url,
      rawUrl: tab.rawUrl
    })
  )
  return !leavesSavedPage && !leavesRetainedPage && closableCount === openItemCount
}
