import { domainGroupCardId } from './domain-card-id.js'
import { registrableDomain } from './domains.js'
import { isPinnableDomain, normalizePinnedDomains } from './domain-pins.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import type { DashboardTab, DomainGroup, DomainGroupBuildOptions } from './types'

function presentationHostname(url: string): string | null {
  if (!url) return null
  if (url.startsWith('file://')) return 'local-files'
  const parsed = URL.parse(url)
  if (!parsed) return null
  if (parsed.hostname) return parsed.hostname
  if (parsed.protocol === 'view-source:') {
    return URL.parse(url.slice('view-source:'.length))?.hostname || '__hostless-pages__'
  }
  return '__hostless-pages__'
}

/**
 * @param {DashboardTab[]} realTabs
 * @param {DomainGroupBuildOptions} [opts]
 * @returns {DomainGroup[]}
 */
export function buildDomainGroups(
  realTabs: DashboardTab[],
  { previousOrder = new Map(), pinnedDomains = [] }: DomainGroupBuildOptions = {}
): DomainGroup[] {
  // Group tabs by domain. Utility cards (apps / new tabs) still split out,
  // but homepage-like routes stay in their native domain cards.
  const groupMap = new Map<string, DomainGroup>()
  const appTabs: DashboardTab[] = []
  const tabOutTabs: DashboardTab[] = []

  for (const tab of realTabs) {
    if (tab.isTabOut) {
      tabOutTabs.push(tab)
      continue
    }

    if (tab.isApp) {
      appTabs.push(tab)
      continue
    }

    const hostname = presentationHostname(tab.url)
    if (!hostname) continue

    // Roll up subdomains so dev1.foo.com + dev2.foo.com share one
    // card. registrableDomain() is a no-op for IPs, localhost, and
    // user-space suffixes like user.github.io — see domains.js.
    const key = registrableDomain(hostname)
    groupMap.getOrInsertComputed(key, () => ({ domain: key, tabs: [] })).tabs.push(tab)
  }

  if (tabOutTabs.length > 0) {
    groupMap.set('__tab-out__', { domain: '__tab-out__', label: 'New tabs', tabs: tabOutTabs })
  }
  if (appTabs.length > 0) {
    groupMap.set('__standalone-apps__', { domain: '__standalone-apps__', label: 'Apps', tabs: appTabs })
  }
  const hostlessPages = groupMap.get('__hostless-pages__')
  if (hostlessPages) hostlessPages.label = 'Other pages'

  const normalizedPinnedDomains = normalizePinnedDomains(pinnedDomains)
  const pinnedOrder = new Map(normalizedPinnedDomains.map((domain, index) => [domain, index]))

  const groupedDomains = groupMap.values().toArray()
  groupedDomains.forEach((group) => {
    group.pinned = isPinnableDomain(group.domain) && pinnedOrder.has(group.domain)
  })
  const openTabCounts = new Map(
    groupedDomains.map((group) => [
      group,
      group.tabs.reduce(
        (count, tab) => count + (isClosedSavedDashboardTab(tab) ? 0 : 1),
        0
      )
    ])
  )

  function orderCount(group: DomainGroup): number {
    return openTabCounts.get(group) ?? 0
  }

  function orderTier(group: DomainGroup): number {
    if (group.pinned) return 0
    if (orderCount(group) > 0) return 1
    return 2
  }

  // Keep pinned cards first. Within each remaining tier, previously-seen
  // cards retain their order and new cards fall back to open-tab count.
  groupedDomains.sort((a, b) => {
    const tierDelta = orderTier(a) - orderTier(b)
    if (tierDelta !== 0) return tierDelta
    if (a.pinned && b.pinned) return (pinnedOrder.get(a.domain) ?? 0) - (pinnedOrder.get(b.domain) ?? 0)
    const aPrev = previousOrder.get(domainGroupCardId(a))
    const bPrev = previousOrder.get(domainGroupCardId(b))
    if (aPrev !== undefined && bPrev !== undefined) {
      const previousOrderDelta = aPrev - bPrev
      if (previousOrderDelta !== 0) return previousOrderDelta
    }
    if (aPrev !== undefined) return -1
    if (bPrev !== undefined) return 1
    return orderCount(b) - orderCount(a)
  })

  return groupedDomains
}
