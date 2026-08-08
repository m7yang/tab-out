import { makeDashboardItem } from './dashboard-item.js'
import {
  mergeSavedPagesWithTabs,
  normalizeSavedPagesStore,
  type SavedPagesStore
} from './saved-pages.js'
import {
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageRecord,
  type RetainedPageSurfaceKind
} from './retained-pages-ledger.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { DashboardTab } from './types'
import { canonicalDedupeKey } from './url-canonical.js'

export interface TabsPageProjection {
  tabs: DashboardTab[]
  store: SavedPagesStore
}

function surfaceKindForTab(tab: Pick<DashboardTab, 'isApp'>): RetainedPageSurfaceKind {
  return tab.isApp ? 'app' : 'normal-tab'
}

type SurfaceIdentityIndex = Record<RetainedPageSurfaceKind, Set<string>>

function emptySurfaceIdentityIndex(): SurfaceIdentityIndex {
  return {
    'normal-tab': new Set(),
    app: new Set()
  }
}

function addTabIdentity(index: SurfaceIdentityIndex, tab: DashboardTab): void {
  const effectiveUrl = unwrapSuspenderUrl(tab.rawUrl || tab.url || '')
  index[surfaceKindForTab(tab)].add(canonicalDedupeKey(effectiveUrl))
}

function retainedPageToDashboardTab(page: RetainedPageRecord): DashboardTab {
  return makeDashboardItem({
    id: `retained:${page.identityDigest}:${page.closureToken}`,
    url: page.url,
    rawUrl: page.url,
    title: page.title,
    favIconUrl: page.favIconUrl || '',
    windowId: 0,
    isApp: page.surfaceKind === 'app',
    sourceType: 'retained-page',
    closedSaved: true,
    retainedPageIdentity: page.identityDigest,
    retainedPageClosureToken: page.closureToken
  })
}

export function projectTabsPageSources(
  openTabs: DashboardTab[],
  savedPagesStore: Partial<SavedPagesStore> | null | undefined,
  retainedPages: readonly RetainedPageRecord[],
  now = Date.now(),
  liveTabs: readonly DashboardTab[] = openTabs
): TabsPageProjection {
  const normalizedSavedPages = normalizeSavedPagesStore(savedPagesStore)
  const liveIdentities = emptySurfaceIdentityIndex()
  for (const tab of liveTabs) addTabIdentity(liveIdentities, tab)
  const savedIdentities = emptySurfaceIdentityIndex()
  for (const page of Object.values(normalizedSavedPages.pages)) {
    savedIdentities[page.surfaceKind].add(
      canonicalDedupeKey(unwrapSuspenderUrl(page.url))
    )
  }
  // Merge against the full browser inventory so an exact Saved Page does not
  // masquerade as closed merely because its live Chrome-internal or other-
  // extension tab is outside the dashboard's historical presentation filter.
  const savedMerge = mergeSavedPagesWithTabs([...liveTabs], normalizedSavedPages, now)
  const visibleOpenTabIds = new Set(openTabs.map((tab) => tab.id))
  const projectedSavedTabs = savedMerge.tabs.filter((tab) =>
    tab.sourceType === 'saved-page' || visibleOpenTabIds.has(tab.id)
  )
  const visibleRetainedPages = retainedPages
    .filter((page) => {
      if (page.closedAt + RETAINED_PAGE_LIFETIME_MS <= now) return false
      return !liveIdentities[page.surfaceKind].has(page.canonicalKey) &&
        !savedIdentities[page.surfaceKind].has(page.canonicalKey)
    })
    .map(retainedPageToDashboardTab)

  return {
    tabs: [...projectedSavedTabs, ...visibleRetainedPages],
    store: savedMerge.store
  }
}
