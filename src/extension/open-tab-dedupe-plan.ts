import { isBrowserInternalUrl } from './browser-url-policy.js'
import { liveTabUrlForIdentity } from './live-tab-matching.js'
import { unwrapSuspenderUrl } from './suspension.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import { pickDuplicateTabsToClose } from './tab-dedupe-policy.js'
import { canonicalDedupeKey } from './url-canonical.js'

export type OpenTabDedupePlan = {
  closableCount: number
  urls: string[]
}

function effectiveUrl(tab: chrome.tabs.Tab): string {
  return unwrapSuspenderUrl(liveTabUrlForIdentity(tab))
}

/**
 * Builds the global close-duplicates plan from a live Chrome tab inventory.
 * The scope mirrors the dashboard: real pages plus Tab Out's new-tab aliases,
 * with every close target delegated to the shared group-aware dedupe policy.
 */
export function buildOpenTabDedupePlan(
  tabs: readonly chrome.tabs.Tab[],
  currentWindowId: number,
): OpenTabDedupePlan {
  const eligibleTabs = tabs.filter((tab) => {
    const rawUrl = liveTabUrlForIdentity(tab)
    const url = effectiveUrl(tab)
    if (!url) return false
    return isTabOutPageUrl(rawUrl) || !isBrowserInternalUrl(url)
  })
  const tabsByUrl = Map.groupBy(eligibleTabs, (tab) => canonicalDedupeKey(effectiveUrl(tab), tab.favIconUrl))
  const urls: string[] = []
  let closableCount = 0

  for (const [url, matchingTabs] of tabsByUrl) {
    if (!url || matchingTabs.length < 2) continue
    const isTabOutGroup = matchingTabs.some((tab) => isTabOutPageUrl(liveTabUrlForIdentity(tab)))
    const closeTargets = pickDuplicateTabsToClose(matchingTabs, {
      currentWindowId,
      preservePinnedTabOut: isTabOutGroup,
      isTabOutUrl: isTabOutPageUrl,
    })
    if (closeTargets.length === 0) continue
    urls.push(url)
    closableCount += closeTargets.length
  }

  return { closableCount, urls }
}
