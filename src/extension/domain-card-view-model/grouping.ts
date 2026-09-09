/* ================================================================
   Card grouping — how one domain group of tabs becomes the tab
   sets the sections render.

   dedupeTabsForDisplay picks one display tab per identity
   (ordinary cards per URL/saved/retained key; the New tabs utility
   card keeps physical Tab Out buckets visible and records their
   representative metadata). collectCrossEnvFolds finds the same
   path+title in two or more named subdomains, and
   groupTabsBySubdomain buckets the rest per subdomain (or per
   localhost port). Section ordering stays with the assembly.
   ================================================================ */

import { isGroupedTab } from '../groups.js'
import { isCurrentTabOutPage } from './tab-state.js'
import type { DashboardTab } from '../types'

type TabOutDisplayBucketKind = 'current' | 'chrome-pinned' | 'chrome-grouped' | 'ordinary'
export type TabOutDisplayMeta = {
  tabs: DashboardTab[]
  renderKey: string
  isCurrentTabOut: boolean
  chromePinned: boolean
  pagePinDisabled: boolean
}

// Deduplicate for display: ordinary cards show each URL once, while the
// New tabs utility card keeps state-preserved physical Tab Out buckets visible.
export function dedupeTabsForDisplay({ tabs, isTabOutGroup, currentWindowId, keyOf }: {
  tabs: readonly DashboardTab[]
  isTabOutGroup: boolean
  currentWindowId: number | null
  keyOf: (tab: DashboardTab) => string
}): { uniqueTabs: DashboardTab[], tabOutDisplayMeta: WeakMap<DashboardTab, TabOutDisplayMeta> } {
  const tabOutDisplayMeta = new WeakMap<DashboardTab, TabOutDisplayMeta>()

  function tabOutBucketForTab(tab: DashboardTab): { key: string, kind: TabOutDisplayBucketKind, rank: number, groupId: number } {
    if (isCurrentTabOutPage(tab, currentWindowId)) return { key: 'current', kind: 'current', rank: 0, groupId: -1 }
    if (tab.pinned) return { key: 'chrome-pinned', kind: 'chrome-pinned', rank: 1, groupId: -1 }
    if (isGroupedTab(tab)) return { key: `chrome-grouped:${tab.groupId}`, kind: 'chrome-grouped', rank: 2, groupId: tab.groupId }
    return { key: 'ordinary', kind: 'ordinary', rank: 3, groupId: -1 }
  }

  function tabOutDisplayRenderKey(canonicalIdentity: string, bucketKey: string): string {
    return `tab-out:${canonicalIdentity}\0${bucketKey}`
  }

  function tabOutDisplayTabsForUrl(canonicalIdentity: string, urlTabs: DashboardTab[]): DashboardTab[] {
    if (urlTabs.length <= 1) {
      const tab = urlTabs[0]
      if (tab) {
        const bucket = tabOutBucketForTab(tab)
        tabOutDisplayMeta.set(tab, {
          tabs: [tab],
          renderKey: tabOutDisplayRenderKey(canonicalIdentity, bucket.key),
          isCurrentTabOut: isCurrentTabOutPage(tab, currentWindowId),
          chromePinned: !!tab.pinned,
          pagePinDisabled: false,
        })
      }
      return urlTabs
    }

    const buckets = new Map<string, {
      key: string
      kind: TabOutDisplayBucketKind
      rank: number
      groupId: number
      firstSeen: number
      tabs: DashboardTab[]
    }>()
    urlTabs.forEach((tab, firstSeen) => {
      const bucket = tabOutBucketForTab(tab)
      buckets
        .getOrInsertComputed(bucket.key, () => ({ ...bucket, firstSeen, tabs: [] }))
        .tabs.push(tab)
    })

    return buckets.values().toArray()
      .sort((a, b) => a.rank - b.rank || a.groupId - b.groupId || a.firstSeen - b.firstSeen)
      .flatMap((bucket) => {
        const representative = bucket.tabs[0]
        if (!representative) return []
        tabOutDisplayMeta.set(representative, {
          tabs: bucket.tabs,
          renderKey: tabOutDisplayRenderKey(canonicalIdentity, bucket.key),
          isCurrentTabOut: bucket.kind === 'current',
          chromePinned: bucket.tabs.some((tab) => tab.pinned),
          pagePinDisabled: true,
        })
        return [representative]
      })
  }

  const uniqueTabs: DashboardTab[] = []
  if (isTabOutGroup) {
    const displayTabsByUrl = Map.groupBy(tabs, keyOf)
    for (const [canonicalIdentity, urlTabs] of displayTabsByUrl) {
      uniqueTabs.push(...tabOutDisplayTabsForUrl(canonicalIdentity, urlTabs))
    }
  } else {
    const seen = new Set<string>()
    for (const tab of tabs) {
      const key = tab.sourceType === 'saved-page'
        ? `saved:${tab.savedPageKey || `${tab.isApp ? 'app' : 'normal-tab'}:${tab.url}`}`
        : tab.sourceType === 'retained-page'
          ? `retained:${tab.retainedPageIdentity || keyOf(tab)}`
          : `open:${keyOf(tab)}`
      if (!seen.has(key)) {
        seen.add(key)
        uniqueTabs.push(tab)
      }
    }
  }

  return { uniqueTabs, tabOutDisplayMeta }
}

// Detect cross-subdomain shared pages — the "same page in dev2us +
// dev11us + qaus" pattern that floods multi-env cards with near-
// duplicates. A path (pathname + search + hash) with the same visible
// title in 2+ named subdomains gets folded into a single chip that
// carries an env-pill stack; those tabs are then excluded from the
// per-subdomain sections below so they don't appear twice.
export function collectCrossEnvFolds({ uniqueTabs, parseUrl, subdomainForUrl, titleKeyOf }: {
  uniqueTabs: readonly DashboardTab[]
  parseUrl: (url: string) => URL | null
  subdomainForUrl: (url: string) => string
  titleKeyOf: (tab: DashboardTab) => string
}): { foldGroups: DashboardTab[][], foldedTabUrls: Set<string> } {
  const foldedTabUrls = new Set<string>()
  const foldGroups: DashboardTab[][] = [] // each entry shares the same path and visible title
  {
    const pageMap = new Map<string, DashboardTab[]>()
    for (const tab of uniqueTabs) {
      const parsed = parseUrl(tab.url)
      if (!parsed) continue
      const sub = subdomainForUrl(tab.url)
      if (!sub) continue // root-level tabs have no env to compare
      const pathKey = parsed.pathname + parsed.search + parsed.hash
      const titleKey = titleKeyOf(tab)
      const pageKey = `${pathKey}\u0000${titleKey}`
      pageMap.getOrInsertComputed(pageKey, () => []).push(tab)
    }
    for (const tabs of pageMap.values()) {
      const subs = new Set<string>()
      for (const t of tabs) {
        subs.add(subdomainForUrl(t.url))
      }
      if (subs.size < 2) continue
      foldGroups.push(tabs)
      tabs.forEach((t) => foldedTabUrls.add(t.url))
    }
  }

  return { foldGroups, foldedTabUrls }
}

// Group tabs by subdomain/port within the card, EXCLUDING any tabs
// that got folded into the shared section above. Root tabs (no
// subdomain or lone "www") sit under an empty-string key.
export function groupTabsBySubdomain({ uniqueTabs, foldedTabUrls, parseUrl, subdomainForUrl }: {
  uniqueTabs: readonly DashboardTab[]
  foldedTabUrls: ReadonlySet<string>
  parseUrl: (url: string) => URL | null
  subdomainForUrl: (url: string) => string
}): Map<string, DashboardTab[]> {
  const bySubdomain = new Map<string, DashboardTab[]>()
  for (const tab of uniqueTabs) {
    if (foldedTabUrls.has(tab.url)) continue
    let key = ''
    const parsed = parseUrl(tab.url)
    if (parsed) {
      if (parsed.hostname === 'localhost' && parsed.port) {
        key = parsed.port
      } else {
        key = subdomainForUrl(tab.url)
      }
    }
    bySubdomain.getOrInsertComputed(key, () => []).push(tab)
  }

  return bySubdomain
}
