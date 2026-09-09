import { omitUndefined } from '../lib/omit-undefined.js'
import { domainGroupCardId } from './domain-card-id.js'
import { pickFavicon, pickTabFavicon } from './favicons.js'
import { isGroupedTab, groupDotColor } from './groups.js'
import { compareNumericText } from './numeric-sort.js'
import { aggregateAudioState, mergeAudioStates } from './tab-audio.js'
import { cleanTitleWithRemovedSuffix, stripTitleNoise } from './titles.js'
import { subdomainPrefix } from './domains.js'
import { resolvePathGroup } from './path-groups.js'
import { resolveGenericWebsitePathSection, resolveWebsitePathSection } from './website-path-sections.js'
import { allocateCardSuppressionTones } from './title-suppression-tones.js'
import { tabMatchesCompiledFilter } from './filter-match.js'
import { compileFilterQuery } from './filter-query.js'
import { countClosableDuplicateExtras } from './tab-dedupe-policy.js'
import { canonicalDedupeKey } from './url-canonical.js'
import { allOpenTargetsSuspended, dashboardItemNameForTabs, isClosedSavedDashboardTab } from './dashboard-source.js'
import { pathgroupPinId, subdomainPinId, websitePathPinId } from './section-pins.js'
import { pageChipPinKeyForFoldUrls, pageChipPinKeyForUrl, pageChipPinScopeId } from './page-chip-pins.js'
import { aggregateSuppressedTitleParts, computeTitlePresentations, summarizeTitleSuppression, titleSuppressionKey, titleSuppressionPartPosition } from './domain-card-view-model/title-suppression.js'
import { injectBreakPoints, inlineSingletonSuppressionsInSegments, insertTitleSuppressionSegmentsBeforeStructuralPlaceholder, stripPgLabel, titleTextFromSegments } from './domain-card-view-model/segments.js'
import { SAME_TITLE_PAGE_CHIP_DRAFT, compileDashboardChipDrafts, sameTitlePageChipDraftTargets } from './domain-card-view-model/chip-drafts.js'
import { createChipOrdering, createPagePinIndex, dashboardChipOrderAltKeyForTab, dashboardChipOrderKeyForTab, dashboardFoldChipOrderKey, sortPinnedFirst } from './domain-card-view-model/ordering.js'
import { activeFrameStateForDuplicateSet, isActiveInOtherWindow, isCurrentTabOutPage, isOpenTabLoading } from './domain-card-view-model/tab-state.js'
import type { DashboardChipDraft } from './domain-card-view-model/chip-drafts.js'
import type { PinnedPageChipIndex } from './page-chip-pins.js'
import type { CompiledFilterQuery } from './filter-query.js'
import type { DashboardCardVM, DashboardChipData, DashboardChipPriorityMap, DashboardClusterVM, DashboardSectionVM, DashboardSource, DashboardTab, DashboardTitleSuppression, DashboardWebsitePathSectionVM, DomainGroup, PathGroupResult, RetainedPageActionTarget, WebsitePathSectionResult } from './types'
import type { TitlePresentation, TitlePresentationSeedRow } from './domain-card-view-model/title-suppression.js'
export { dashboardChipOrderAltKeyForChip, dashboardChipOrderKeyForChip, dashboardChipOrderKeyForTab } from './domain-card-view-model/ordering.js'

type ComputeCardOptions = {
  filter?: string
  filterQuery?: CompiledFilterQuery
  source?: DashboardSource
  allowMutations?: boolean
  currentWindowId?: number | null
  chipOrder?: Map<string, number>
  chipPriority?: DashboardChipPriorityMap
  pinnedSections?: ReadonlySet<string>
  pinnedPageChips?: PinnedPageChipIndex
}

const EMPTY_PINNED_SECTIONS: ReadonlySet<string> = new Set<string>()

type PathCategory = NonNullable<PathGroupResult['category']>
type BaseTitlePresentation = {
  displayTitle: string
  removedDomainTitleSuffix: string
}
type SectionContentVM = {
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  clusters: DashboardClusterVM[]
}
type WebsitePathSectionBucket = WebsitePathSectionResult & {
  tabs: DashboardTab[]
}
type ChipBuildEntry = {
  tab: DashboardTab
  chip: DashboardChipData
  titleKey: string
}
type TabOutDisplayBucketKind = 'current' | 'chrome-pinned' | 'chrome-grouped' | 'ordinary'
type TabOutDisplayMeta = {
  tabs: DashboardTab[]
  renderKey: string
  isCurrentTabOut: boolean
  chromePinned: boolean
  pagePinDisabled: boolean
}

function pickDashboardChipFavicon(tab: DashboardTab): string {
  if ((tab.sourceType || 'tab') === 'tab') return pickTabFavicon(tab)
  return pickFavicon(tab)
}

function retainedPageRemovalLabelForCount(count: number): string {
  return count === 0
    ? ''
    : count === 1
      ? 'Remove from Tabs'
      : `Remove ${count} from Tabs`
}

/* ---- Domain card view-model ----
   Builds the per-card data consumed by <DomainCard>. Filtering used
   to be done imperatively in filter.js — walk each chip's DOM,
   toggle style.display, update each section-count, recompute the
   close-domain / dedup labels from per-card state. The whole thing
   is now inside this function: pass `{ filter }` and get back
   a VM whose visibleChips / sections / closableCount already reflect
   the current match scope.

     • filter — normalized (trim + lowercase) query string ('' means
                no filter)

   Returned fields:
     • isHidden     — true when the card has zero chips under the
                      current filter; <Missions> skips it entirely
     • filtering    — convenience flag; sections/chips use it to
                      bypass the "+N more" overflow split so every
                      matching chip is visible at once
*/
/**
 * @param {DomainGroup} group
 * @param {{ filter?: string, allowMutations?: boolean, currentWindowId?: number | null }} [opts]
 * @returns {DashboardCardVM}
 */
export function computeDomainCardViewModel(group: DomainGroup, { filter = '', filterQuery, source = 'tabs', allowMutations = true, currentWindowId = null, chipOrder, chipPriority, pinnedSections = EMPTY_PINNED_SECTIONS, pinnedPageChips }: ComputeCardOptions = {}): DashboardCardVM {
  const compiledFilter = filterQuery ?? compileFilterQuery(filter)
  const allTabs = group.tabs || []
  const filtering = compiledFilter.active
  const stableId = domainGroupCardId(group)
  const isAppsGroup = group.domain === '__standalone-apps__'
  const parsedUrlByValue = new Map<string, URL | null>()
  const canonicalKeyByValue = new Map<string, string>()
  const pathGroupByValue = new Map<string, PathGroupResult | null>()
  const strippedTitleByValue = new Map<string, string>()
  const subdomainPrefixByValue = new Map<string, string>()

  function parseUrl(url: string): URL | null {
    return parsedUrlByValue.getOrInsertComputed(url, () => URL.parse(url))
  }

  function strippedTitle(title: string): string {
    return strippedTitleByValue.getOrInsertComputed(title, stripTitleNoise)
  }

  function canonicalKey(url: string): string {
    return canonicalKeyByValue.getOrInsertComputed(
      url,
      () => canonicalDedupeKey(url),
    )
  }

  function subdomainForUrl(url: string): string {
    return subdomainPrefixByValue.getOrInsertComputed(url, () => {
      const parsed = parseUrl(url)
      return parsed ? subdomainPrefix(parsed.hostname, group.domain) : ''
    })
  }

  const tabs = filtering
    ? allTabs.filter((tab) => tabMatchesCompiledFilter(tab, compiledFilter))
    : allTabs

  if (tabs.length === 0) {
    return { stableId, isHidden: true, filtering }
  }

  const retainedPageRemovalTargets: Required<RetainedPageActionTarget>[] =
    !allowMutations
      ? []
      : tabs.flatMap((tab) => {
          const retainedPageIdentity = tab.retainedPageIdentity
          const retainedPageClosureToken = tab.retainedPageClosureToken
          return tab.sourceType === 'retained-page' &&
            typeof retainedPageIdentity === 'string' && retainedPageIdentity.length > 0 &&
            typeof retainedPageClosureToken === 'string' && retainedPageClosureToken.length > 0
            ? [{ retainedPageIdentity, retainedPageClosureToken }]
            : []
        })
  const retainedPageRemovalLabel = retainedPageRemovalLabelForCount(
    retainedPageRemovalTargets.length,
  )

  const openTabs = tabs.filter((tab) => !isClosedSavedDashboardTab(tab))
  const totalOpenTabs = allTabs.filter((tab) => !isClosedSavedDashboardTab(tab))
  const closedSavedTabs = tabs.filter(isClosedSavedDashboardTab)
  const totalClosedSavedTabs = allTabs.filter(isClosedSavedDashboardTab)
  const tabCount = openTabs.length
  const totalTabCount = totalOpenTabs.length
  const closedSavedCount = closedSavedTabs.length
  const totalClosedSavedCount = totalClosedSavedTabs.length
  const itemLabel = dashboardItemNameForTabs(totalOpenTabs, 'open tab')
  const openCountLabel = filtering && tabCount !== totalTabCount && tabCount > 0 ? `${tabCount}/${totalTabCount}` : `${tabCount}`
  const savedCountText = filtering && closedSavedCount !== totalClosedSavedCount
    ? `${closedSavedCount}/${totalClosedSavedCount}`
    : `${closedSavedCount}`
  const closedOnlyCountLabel = tabCount === 0 && closedSavedCount > 0
    ? `${savedCountText} closed`
    : ''
  const savedCountLabel = closedSavedCount > 0 ? ` + ${savedCountText} closed` : ''
  const tabCountLabel = closedOnlyCountLabel || `${openCountLabel}${savedCountLabel}`
  const tabCountTitleParts = [
    filtering
      ? `${tabCount} of ${totalTabCount} ${itemLabel}${totalTabCount !== 1 ? 's' : ''} shown while filtering`
      : `${tabCount} ${itemLabel}${tabCount !== 1 ? 's' : ''}`,
    closedSavedCount > 0
      ? filtering
        ? `${closedSavedCount} of ${totalClosedSavedCount} closed page${totalClosedSavedCount !== 1 ? 's' : ''} shown while filtering`
        : `${closedSavedCount} closed page${closedSavedCount !== 1 ? 's' : ''}`
      : '',
  ].filter(Boolean)
  const tabCountTitle = tabCountTitleParts.join(', ')
  const isTabOutGroup = group.domain === '__tab-out__'

  // Tabs in a Chrome group are preserved by bulk close / dedup actions.
  const isBulkClosableTab = (tab: DashboardTab) =>
    !isClosedSavedDashboardTab(tab) &&
    !isGroupedTab(tab) &&
    !(isTabOutGroup && tab.pinned)
  const closableTabs = openTabs.filter(isBulkClosableTab)
  const closableCount = closableTabs.length
  const suspendableTabs = closableTabs.filter((t) => !t.suspended)
  const suspendableCount = suspendableTabs.length
  const closableSuspendedCount = closableTabs.filter((t) => t.suspended).length

  // Count duplicates per URL and delegate the closeability rules to the
  // shared dedupe policy so dashboard counts mirror tab mutation behavior.
  const keyOf = (t: DashboardTab) => canonicalKey(t.url)
  const tabsByUrl = Map.groupBy(openTabs, keyOf)

  function closableForUrl(u: string): number {
    return countClosableDuplicateExtras(tabsByUrl.get(u) || [], { isTabOutGroup, currentWindowId })
  }
  const closableDupeUrls = tabsByUrl.keys().filter((u) => closableForUrl(u) > 0).toArray()
  const closableExtras = closableDupeUrls.reduce((s, u) => s + closableForUrl(u), 0)

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

  // Deduplicate for display: ordinary cards show each URL once, while the
  // New tabs utility card keeps state-preserved physical Tab Out buckets visible.
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

  function baseTitlePresentation(tab: DashboardTab): BaseTitlePresentation {
    const hostname = parseUrl(tab.url)?.hostname ?? group.domain
    const cleaned = cleanTitleWithRemovedSuffix(strippedTitle(tab.title || ''), hostname, titleNoiseSuffixesForUrl(tab.url))
    return {
      displayTitle: cleaned.title,
      removedDomainTitleSuffix: cleaned.removedSuffix,
    }
  }

  function titleNoiseSuffixesForUrl(url: string): string[] {
    const parsed = parseUrl(url)
    if (parsed?.hostname.endsWith('.atlassian.net') && parsed.pathname.startsWith('/wiki/')) return ['Confluence']
    return []
  }

  function structuralPathGroup(tab: DashboardTab): PathGroupResult | null {
    return pathGroupByValue.getOrInsertComputed(tab.url, () => {
      const parsed = parseUrl(tab.url)
      if (!parsed) return null
      try {
        return resolvePathGroup(parsed)
      } catch {
        return null
      }
    })
  }

  const titlePresentationByUrl = computeTitlePresentations(
    uniqueTabs.map((tab): TitlePresentationSeedRow => {
      const baseTitle = baseTitlePresentation(tab)
      const pathGroup = structuralPathGroup(tab)
      return {
        url: tab.url,
        rawTitle: strippedTitle(tab.title || ''),
        displayTitle: baseTitle.displayTitle,
        removedDomainTitleSuffix: baseTitle.removedDomainTitleSuffix,
        pathGroupLabel: pathGroup?.label || '',
        pathGroupKey: pathGroup?.key || '',
      }
    }),
    { filtering },
  )

  function titlePresentation(tab: DashboardTab): TitlePresentation {
    return titlePresentationByUrl.get(tab.url) || {
      displayTitle: strippedTitle(tab.title || ''),
      suppressedTitleParts: [],
      suppressedTitlePartPositions: [],
      suppressedTitlePartsBeforeStructuralTail: [],
    }
  }

  // Build the exact title string the chip displays BEFORE path crumbs
  // and path-group placeholders. Shared by sort order and collision
  // detection so both reason over the same visible label.
  function displayTitle(tab: DashboardTab): string {
    return titlePresentation(tab).displayTitle
  }

  const lowerDisplayTitleByValue = new Map<string, string>()
  const trimmedLowerDisplayTitleByValue = new Map<string, string>()
  function lowerDisplayTitle(tab: DashboardTab, trim = false): string {
    const cache = trim
      ? trimmedLowerDisplayTitleByValue
      : lowerDisplayTitleByValue
    const title = displayTitle(tab)
    const value = trim ? title.trim() : title
    return cache.getOrInsertComputed(value, () => value.toLowerCase())
  }

  const suppressedTitleParts = summarizeTitleSuppression(titlePresentationByUrl.values())
  const suppressedTitlePartOrder = new Map(suppressedTitleParts.map((part, index) => [part.text.toLowerCase(), index]))

  // Sort by title — the exact string the chip displays, so the visible
  // order never diverges from the sort order. `numeric: true` gives
  // natural number ordering (Dashboard 2 before Dashboard 11, PR #4488
  // before PR #4706).
  function sortLabel(tab: DashboardTab): string {
    return lowerDisplayTitle(tab)
  }
  const { hasRememberedChipOrder, chipPriorityScore, chipPriorityScoreForTabs, compareWithPriority, compareWithPriorityThenRememberedChipOrder } = createChipOrdering({ chipOrder, chipPriority })
  const { annotatePageChipPin, sortPageChipsInScope } = createPagePinIndex({ source, pinnedPageChips })
  function tabOpenStateRank(tab: DashboardTab): number {
    return isClosedSavedDashboardTab(tab) ? 1 : 0
  }
  const uniqueTabSortMeta = new Map(uniqueTabs.map((tab) => [tab, {
    priority: chipPriorityScore(tab),
    openStateRank: tabOpenStateRank(tab),
    sortLabel: sortLabel(tab),
    ...(hasRememberedChipOrder
      ? {
          orderKey: dashboardChipOrderKeyForTab(tab),
          orderAltKey: dashboardChipOrderAltKeyForTab(tab),
        }
      : {}),
  }]))
  uniqueTabs.sort((a, b) => {
    const aMeta = uniqueTabSortMeta.get(a)!
    const bMeta = uniqueTabSortMeta.get(b)!
    const fallback = () => aMeta.openStateRank - bMeta.openStateRank ||
      compareNumericText(aMeta.sortLabel, bMeta.sortLabel)
    if (!hasRememberedChipOrder) {
      return compareWithPriority(aMeta.priority, bMeta.priority, fallback)
    }
    return compareWithPriorityThenRememberedChipOrder(
      aMeta.orderKey!,
      bMeta.orderKey!,
      aMeta.priority,
      bMeta.priority,
      fallback,
      aMeta.orderAltKey,
      bMeta.orderAltKey,
    )
  })

  // Detect cross-subdomain shared pages — the "same page in dev2us +
  // dev11us + qaus" pattern that floods multi-env cards with near-
  // duplicates. A path (pathname + search + hash) with the same visible
  // title in 2+ named subdomains gets folded into a single chip that
  // carries an env-pill stack; those tabs are then excluded from the
  // per-subdomain sections below so they don't appear twice.
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
      const titleKey = lowerDisplayTitle(tab, true)
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

  // Group tabs by subdomain/port within the card, EXCLUDING any tabs
  // that got folded into the shared section above. Root tabs (no
  // subdomain or lone "www") sit under an empty-string key.
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

  // Sort policy: high-priority sections surface first; ties fall back to
  // root tabs (empty key) first, then alphabetically by subdomain.
  const sections = bySubdomain.entries().toArray().sort((a, b) => {
    return compareWithPriority(
      chipPriorityScoreForTabs(a[1]),
      chipPriorityScoreForTabs(b[1]),
      () => {
        if (a[0] === b[0]) return 0
        if (a[0] === '') return -1
        if (b[0] === '') return 1
        return a[0].localeCompare(b[0])
      },
    )
  })
  const multipleSections = sections.length > 1
  // Single-subdomain card: hoist the subdomain up to a pill next to
  // the card title so chips don't repeat the prefix on every row.
  // Only for non-empty keys — all-root cards don't need a pill.
  const onlySection = sections.length === 1 ? sections[0] : undefined
  const singleSubdomainKey = onlySection?.[0] || ''

  // Localhost cards use the port as the "subdomain" key (see the
  // bySubdomain loop above), so the pill / header for those should
  // render as `:3000` — prefix colon, no trailing dot — instead of
  // the FQDN-style `dev2us.` treatment. Flag it here so <DomainCard>
  // + <SubdomainSection> + the CSS pseudo-elements can branch.
  const isPortGroup = group.domain === 'localhost'
  const singleSubdomainIsPort = isPortGroup && !!singleSubdomainKey

  // Per-chip data builder. Closes over group + urlCounts so the
  // section loop below can call it without repeating context.
  // Returns the display-only fields <PageChip> needs — title,
  // favicon URL, tooltip, prefix/path/pg/dupe annotations. Phase 5
  // replaced the old renderChip HTML-string emitter with this
  // data-shape so components can render declaratively.
  function buildChipData(
    tab: DashboardTab,
    showPrefix: boolean,
    pathSuffix: string,
    pathGroupLabel: string,
    stripLabel = '',
    { iconOnly = false, rawTitle = false }: { iconOnly?: boolean, rawTitle?: boolean } = {},
  ): DashboardChipData {
    const parsed = parseUrl(tab.url)
    // rawTitle: bypass the presentation pipeline entirely (no noise strip,
    // no suppression pills) — app chips mirror the history list, which
    // shows titles exactly as Chrome reports them.
    const presentation = rawTitle
      ? {
          displayTitle: (tab.title || '').trim(),
          suppressedTitleParts: [],
          suppressedTitlePartPositions: [],
          suppressedTitlePartsBeforeStructuralTail: [],
        }
      : titlePresentation(tab)
    const label = presentation.displayTitle
    let subPrefix = ''
    let portPrefix = ''
    if (parsed && showPrefix) {
      if (parsed.hostname === 'localhost' && parsed.port) portPrefix = parsed.port
      else subPrefix = subdomainForUrl(tab.url)
    }
    const leadPrefix = subPrefix || portPrefix
    const pgLabel = pathGroupLabel || ''
    const rawSegments = insertTitleSuppressionSegmentsBeforeStructuralPlaceholder(
      stripPgLabel(label, stripLabel || pgLabel),
      presentation.suppressedTitlePartsBeforeStructuralTail,
    )
    // Inject zero-width spaces into long unbreakable tokens so the
    // browser can break them if layout needs to — without us setting
    // global `word-break: break-all` (which would also break SHORT
    // words awkwardly, e.g. "Highlight c / ode"). ZWSP is invisible
    // and doesn't render as a hyphen, so line-2 breaks on these long
    // tokens read as a clipped edge (the fade mask handles the
    // visual). Threshold 15 chars + every 5-char split keeps natural
    // English words (which are almost always <15 chars outside
    // "internationalization"-class outliers) intact and only tags
    // compound identifiers / usernames / hashes / slugs. Page-chip
    // tooltip rendering intentionally reuses these display segments so
    // highlighting and visual structure match the source chip.
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    const tooltip = [leadPrefix, label, pathSuffix].filter(Boolean).join(' · ')
    const grouped = isGroupedTab(tab)
    const tabOutMeta = tabOutDisplayMeta.get(tab)
    // Closed Saved and retained targets are exact, independent snapshots. A
    // canonical-equivalent live tab may share their presentation group, but it
    // must not lend them live-only state such as loading, suspension, audio, or
    // an active frame.
    const duplicateTabs = isClosedSavedDashboardTab(tab)
      ? [tab]
      : tabOutMeta?.tabs || tabsByUrl.get(keyOf(tab)) || [tab]
    const { activeInOtherWindow, activeChipFrame } = activeFrameStateForDuplicateSet(duplicateTabs, currentWindowId)
    return omitUndefined({
      tabId: tab.id,
      renderKey: tabOutMeta?.renderKey,
      tabUrl: tab.url,
      rawUrl: tab.rawUrl || tab.url,
      sourceType: tab.sourceType || 'tab',
      saved: !!tab.saved,
      closedSaved: isClosedSavedDashboardTab(tab),
      suspended: allOpenTargetsSuspended(duplicateTabs),
      loading: duplicateTabs.some(isOpenTabLoading),
      savedPageKey: tab.savedPageKey,
      retainedPageIdentity: tab.retainedPageIdentity,
      retainedPageClosureToken: tab.retainedPageClosureToken,
      pagePinDisabled: !!tabOutMeta?.pagePinDisabled,
      leadPrefix,
      pathGroupLabel: pgLabel,
      title: label,
      displaySegments,
      suppressedTitleParts: presentation.suppressedTitleParts,
      pathSuffix: pathSuffix || '',
      tooltip,
      dupeCount: isClosedSavedDashboardTab(tab)
        ? 1
        : tabOutMeta?.tabs.length || tabsByUrl.get(keyOf(tab))?.length || 1,
      faviconUrl: pickDashboardChipFavicon(tab),
      actionTitle: tab.title,
      actionFaviconUrl: tab.favIconUrl || undefined,
      isGrouped: grouped,
      groupDotColor: grouped ? groupDotColor(tab.groupId) : null,
      isApp: !!tab.isApp,
      activeInOtherWindow,
      activeChipFrame,
      isCurrentTabOut: tabOutMeta?.isCurrentTabOut || isCurrentTabOutPage(tab, currentWindowId),
      chromePinned: tabOutMeta?.chromePinned || (isTabOutGroup && !!tab.pinned),
      chromeGroupId: tab.groupId,
      iconOnly,
      audioState: aggregateAudioState(duplicateTabs),
      envs: null,
    })
  }

  // Per-section visible limit. With multiple subdomain sections in one
  // card, a global 8 would flood the card; 5 per section keeps each
  // sub-group scannable while the card stays compact.
  const CHIPS_PER_SECTION = 5

  // "+N more" collapses hidden chips behind an expander button. But
  // when N would be 1, the button itself takes about the same vertical
  // space as rendering the one chip inline — so the collapse saves
  // nothing. Roll that last chip into the visible set instead.
  //
  // While filtering we bypass the split entirely: every chip that
  // made it through the filter is, by definition, something the user
  // is trying to see. Collapsing any of them behind "+N more" would
  // defeat the filter. (Previously filter.js forced all .page-chips-
  // overflow elements to display:contents; the VM handles it now.)
  function splitForOverflow<T>(tabs: T[]): { vis: T[], hid: T[] } {
    if (filtering || tabs.length <= CHIPS_PER_SECTION + 1) {
      return { vis: tabs, hid: [] }
    }
    return { vis: tabs.slice(0, CHIPS_PER_SECTION), hid: tabs.slice(CHIPS_PER_SECTION) }
  }

  // Order chips within a cluster by sub-category (if the adapter
  // provided one), then by their display-label order (preserved via
  // stable sort, since the input tabs are already sorted by display
  // label above). Unknown categories fall to 'other'.
  const CATEGORY_ORDER: Record<PathCategory, number> = { pull: 0, issue: 1, commit: 2, code: 3, other: 4 }
  const categoryRank = (category?: PathGroupResult['category']) => CATEGORY_ORDER[category ?? 'other']

  function titleVariantGroupChip(
    variants: DashboardChipData[],
    representative: DashboardChipData,
  ): DashboardChipData {
    const activeInCurrentWindow = variants.some((variant) => !!variant.activeChipFrame && !variant.activeInOtherWindow)
    const activeInOtherWindow = !activeInCurrentWindow && variants.some((variant) => !!variant.activeInOtherWindow)
    const allVariantsSaved = variants.length > 0 && variants.every((variant) => !!variant.saved)
    const allVariantsClosedSaved = variants.length > 0 && variants.every((variant) => isClosedSavedDashboardTab(variant))
    const stateRepresentative = !isClosedSavedDashboardTab(representative)
      ? representative
      : variants.find((variant) => !isClosedSavedDashboardTab(variant)) || representative
    const groupTitle = [representative.leadPrefix, representative.title].filter(Boolean).join(' · ')
    const groupedChip: DashboardChipDraft = {
      ...stateRepresentative,
      [SAME_TITLE_PAGE_CHIP_DRAFT]: variants,
      saved: allVariantsSaved,
      closedSaved: allVariantsClosedSaved,
      suspended: allOpenTargetsSuspended(variants),
      loading: variants.some((variant) => !!variant.loading),
      pathSuffix: '',
      tooltip: `${groupTitle} · ${variants.length} URL variants`,
      dupeCount: 1,
      activeChipFrame: activeInCurrentWindow || activeInOtherWindow,
      activeInOtherWindow,
      audioState: mergeAudioStates(variants.map((variant) => variant.audioState ?? null)),
    }
    delete groupedChip.savedPageKey
    delete groupedChip.retainedPageIdentity
    delete groupedChip.retainedPageClosureToken
    delete groupedChip.pagePinId
    delete groupedChip.pagePinned
    delete groupedChip.variantLabel
    return groupedChip
  }

  function buildChipDataList(contentTabs: DashboardTab[], showChipPrefix: boolean, pathGroupLabel: string, pinScopeId: string, stripLabel = ''): DashboardChipData[] {
    const entries: ChipBuildEntry[] = contentTabs.map((tab) => {
      return {
        tab,
        chip: buildChipData(tab, showChipPrefix, '', pathGroupLabel, stripLabel),
        titleKey: lowerDisplayTitle(tab, true),
      }
    })
    const entriesByTitle = Map.groupBy(entries, (entry) => entry.titleKey)
    entriesByTitle.delete('')
    const groupedTitleKeys = new Set(
      entriesByTitle.entries()
        .filter(([, groupEntries]) => groupEntries.length > 1 && new Set(groupEntries.map((entry) => entry.tab.url)).size > 1)
        .map(([titleKey]) => titleKey),
    )
    const emittedTitleKeys = new Set<string>()
    const result: DashboardChipData[] = []
    for (const entry of entries) {
      if (!groupedTitleKeys.has(entry.titleKey)) {
        result.push(annotatePageChipPin(entry.chip, pinScopeId, pageChipPinKeyForUrl(entry.tab.url)))
        continue
      }
      if (emittedTitleKeys.has(entry.titleKey)) continue
      emittedTitleKeys.add(entry.titleKey)
      const variantEntries = entriesByTitle.get(entry.titleKey) || []
      const variants = variantEntries.map(({ tab, chip: variant }) => {
        const exactUrl = tab.url
        return annotatePageChipPin(variant, pinScopeId, pageChipPinKeyForUrl(exactUrl))
      })
      const stableRepresentative = variants[0]
      if (!stableRepresentative) continue
      const sortedVariants = sortPageChipsInScope(variants)
      // The group identity remains anchored to the original stable
      // representative; pin order affects visible variant rows, not the
      // remembered Page Chip identity.
      const representative = sortedVariants[sortedVariants.indexOf(stableRepresentative)]
      if (representative) result.push(titleVariantGroupChip(sortedVariants, representative))
    }
    return sortPageChipsInScope(result)
  }

  function buildSectionContent(contentTabs: DashboardTab[], showChipPrefix: boolean, redundantLabels: Set<string>, pinContext: { subdomainKey: string, websitePathKey: string }): SectionContentVM {
    // Path-group pills: resolve each tab's path group (github repo,
    // jira project, contentful env, etc.) and only keep labels whose
    // group has ≥2 members in this content group. A lone group is
    // usually silent clutter — the signal is "these belong together,"
    // which takes at least two chips to convey.
    //
    // Exception: adapters can opt in to `alwaysCluster: true` to
    // bypass the threshold. Jira uses this so ticket keys stay as
    // their own cluster even at member-count 1 — a self-contained
    // identifier and, more importantly, a position-stable anchor.
    //
    // Extra guardrail: drop labels already carried by the parent
    // domain/subdomain/path-section context.
    const pgByUrl = new Map<string, PathGroupResult>()
    const pgKeyCount = new Map<string, number>()
    for (const t of contentTabs) {
      const pg = structuralPathGroup(t)
      if (!pg) continue
      pgByUrl.set(t.url, pg)
      pgKeyCount.set(pg.key, (pgKeyCount.get(pg.key) || 0) + 1)
    }
    const pgLabelByUrl = new Map<string, string>()
    for (const [url, pg] of pgByUrl) {
      if (!pg.alwaysCluster && (pgKeyCount.get(pg.key) ?? 0) < 2) continue
      if (redundantLabels.has(pg.label)) continue
      pgLabelByUrl.set(url, pg.label)
    }

    // Build cluster blocks (≥2 members share a path-group label) and
    // a singleton block. Clusters render as labeled sub-sections; the
    // pill becomes the header and inner chips skip their per-chip
    // pill. Singletons follow flat with no header. Each block manages
    // its OWN visible/hidden split and its OWN "+N more" expander.
    const clusterByLabel = new Map<string, DashboardTab[]>()
    const singletonTabs: DashboardTab[] = []
    for (const t of contentTabs) {
      const lbl = pgLabelByUrl.get(t.url)
      if (!lbl) {
        singletonTabs.push(t)
        continue
      }
      clusterByLabel.getOrInsertComputed(lbl, () => []).push(t)
    }
    const sortedClusters = clusterByLabel.entries().toArray().sort((a, b) => compareWithPriority(
      chipPriorityScoreForTabs(a[1]),
      chipPriorityScoreForTabs(b[1]),
      () => compareNumericText(a[0], b[0]),
    ))

    // Pull requests deserve their own section under a repo: they're
    // action items ("review me"), not browsing state ("I'm reading
    // this file"). Splitting them into a sibling sub-cluster lets
    // each half claim its own CHIPS_PER_SECTION limit instead of
    // fighting over one.
    const rawClusters: Array<{ label: string, tabs: DashboardTab[], key: string, isPR: boolean }> = []
    for (const [lbl, tabs] of sortedClusters) {
      const prTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category === 'pull')
      const nonPrTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category !== 'pull')
      if (prTabs.length >= 2 && nonPrTabs.length >= 1) {
        rawClusters.push({ label: lbl, tabs: nonPrTabs, key: lbl, isPR: false })
        rawClusters.push({ label: lbl, tabs: prTabs, key: lbl + ':pr', isPR: true })
      } else {
        const allArePRs = prTabs.length === tabs.length && tabs.length > 0
        rawClusters.push({ label: lbl, tabs, key: lbl, isPR: allArePRs })
      }
    }

    const unsortedClusters = rawClusters.map(({ label, tabs, key, isPR }) => {
      const orderedTabs = tabs.toSorted((a, b) => {
        const aCat = categoryRank(pgByUrl.get(a.url)?.category)
        const bCat = categoryRank(pgByUrl.get(b.url)?.category)
        return aCat - bCat
      })
      // Title-collision disambiguation is scoped to the rendered
      // group. If path-group headers already separate same-title
      // chips, URL crumbs would duplicate that structural signal.
      const pinScopeId = pageChipPinScopeId(group.domain, pinContext.subdomainKey, pinContext.websitePathKey, key)
      const chipData = buildChipDataList(orderedTabs, showChipPrefix, '', pinScopeId, label)
      const { vis, hid } = splitForOverflow(chipData)
      const clusterClosable = allowMutations ? orderedTabs.filter(isBulkClosableTab) : []
      return {
        key,
        label,
        isPR,
        count: tabs.length,
        closableUrls: clusterClosable.map((t) => t.url),
        visibleChips: vis,
        hiddenChips: hid,
        hiddenCount: hid.length,
        isPinned: pinnedSections.has(pathgroupPinId(group.domain, pinContext.subdomainKey, pinContext.websitePathKey, key)),
      }
    })
    const clusters = sortPinnedFirst(unsortedClusters)

    const flatPinScopeId = pageChipPinScopeId(group.domain, pinContext.subdomainKey, pinContext.websitePathKey, '')
    const flatChipData = buildChipDataList(singletonTabs, showChipPrefix, '', flatPinScopeId)
    const { vis: flatVisibleChips, hid: flatHiddenChips } = splitForOverflow(flatChipData)

    return {
      hasFlat: singletonTabs.length > 0,
      flatVisibleChips,
      flatHiddenChips,
      flatHiddenCount: flatHiddenChips.length,
      clusters,
    }
  }

  if (isAppsGroup) {
    // Apps render as regular titled chips (favicon + title, stacked) — the
    // icon-only presentation hid which window was which once several apps
    // were open. PageChip still branches on iconOnly for callers that want
    // the compact form. Titles stay RAW (rawTitle) to match history rows.
    const appChips = uniqueTabs.map((tab) => buildChipData(tab, false, '', '', '', { rawTitle: true }))
    const { vis: visibleAppChips, hid: hiddenAppChips } = splitForOverflow(appChips)
    const vmClosableCount = !allowMutations ? 0 : closableCount
    const vmClosableExtras = !allowMutations ? 0 : closableExtras
    const vmClosableDupeUrls = !allowMutations ? [] : closableDupeUrls
    return {
      stableId,
      isHidden: false,
      filtering,
      tabCount,
      totalTabCount,
      tabCountLabel,
      tabCountTitle,
      closableCount: vmClosableCount,
      closableCountLabel:
        closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`,
      closableDupeUrls: vmClosableDupeUrls,
      closableExtras: vmClosableExtras,
      retainedPageRemovalTargets,
      retainedPageRemovalLabel,
      singleSubdomainKey: '',
      singleSubdomainIsPort: false,
      displayName: group.label || 'Apps',
      suppressedTitleParts: [],
      allSuppressedTitleParts: [],
      sections: [
        {
          key: '__apps__',
          sectionCount: tabs.length,
          sectionClosableUrls: !allowMutations ? [] : closableTabs.map((tab) => tab.url),
          showHeader: false,
          isShared: false,
          isPort: false,
          hasFlat: true,
          flatVisibleChips: visibleAppChips,
          flatHiddenChips: hiddenAppChips,
          flatHiddenCount: hiddenAppChips.length,
          suppressedTitleParts: [],
          clusters: [],
          websitePathSections: [],
          isPinned: false,
        },
      ],
    }
  }

  // Folded (cross-env) chip data — one chip representing the same path
  // and visible title present in 2+ subdomains. The env-pill stack
  // replaces the usual subdomain prefix; clicking a pill focuses that
  // env's tab and the chip's close button (handled in PageChip) closes
  // every env copy.
  function buildFoldedChipData(tabs: DashboardTab[]): DashboardChipData {
    const primary = tabs[0]
    if (!primary) throw new Error('Folded chip requires at least one tab')
    const liveTabs = tabs.filter((tab) => !isClosedSavedDashboardTab(tab))
    // `tabs` contains one display representative per environment URL. Expand
    // those representatives back to their open duplicate sets so a loading
    // copy cannot disappear behind an already-complete representative.
    const representedTabs = tabs.flatMap((tab) => (
      isClosedSavedDashboardTab(tab) ? [tab] : tabsByUrl.get(keyOf(tab)) || [tab]
    ))
    const stateRepresentative = liveTabs[0] || primary
    const presentation = titlePresentation(primary)
    const label = presentation.displayTitle
    const rawSegments = stripPgLabel(label, '')
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    // Sort envs by prefix with numeric-aware compare so dev2us lands
    // before dev11us (plain lexicographic would give dev11us, dev2us,
    // qaus — technically right but wrong for a human-natural read).
    // Stable across refreshes since `tabs` is derived from the same
    // page identity and subdomain prefix every time.
    const envs = tabs
      .map((t) => {
        const sub = subdomainForUrl(t.url)
        return omitUndefined({
          tabId: t.id,
          prefix: sub || '?',
          tabUrl: t.url,
          rawUrl: t.rawUrl || t.url,
          sourceType: t.sourceType || 'tab',
          saved: !!t.saved,
          closedSaved: isClosedSavedDashboardTab(t),
          savedPageKey: t.savedPageKey,
          retainedPageIdentity: t.retainedPageIdentity,
          retainedPageClosureToken: t.retainedPageClosureToken,
          title: displayTitle(t),
          faviconUrl: pickDashboardChipFavicon(t),
          actionTitle: t.title,
          actionFaviconUrl: t.favIconUrl || undefined,
          isApp: !!t.isApp,
          activeInOtherWindow: isActiveInOtherWindow(t, currentWindowId),
        })
      })
      .sort((a, b) => compareNumericText(a.prefix, b.prefix))
    const tooltip = [envs.map((e) => e.prefix).join(' · '), label].filter(Boolean).join(' · ')
    return {
      tabUrl: stateRepresentative.url,
      rawUrl: stateRepresentative.rawUrl || stateRepresentative.url,
      sourceType: stateRepresentative.sourceType || 'tab',
      closedSaved: liveTabs.length === 0,
      suspended: allOpenTargetsSuspended(tabs),
      loading: representedTabs.some(isOpenTabLoading),
      leadPrefix: '',
      pathGroupLabel: '',
      displaySegments,
      suppressedTitleParts: aggregateSuppressedTitleParts(tabs.map((tab) => titlePresentation(tab)), suppressedTitlePartOrder),
      pathSuffix: '',
      tooltip,
      dupeCount: 1,
      faviconUrl: pickDashboardChipFavicon(stateRepresentative),
      isGrouped: false,
      groupDotColor: null,
      // Folded chip reads as "app" only when every env tab behind it
      // is running in an app window — a mixed set isn't clearly one
      // or the other, so we bias toward "not app" (no dashed marker).
      isApp: tabs.every((t) => t.isApp),
      activeInOtherWindow: envs.some((env) => env.activeInOtherWindow),
      activeChipFrame: envs.some((env) => env.activeInOtherWindow),
      audioState: aggregateAudioState(tabs),
      envs,
    }
  }

  // Assemble the shared section (appears first in the card when any
  // fold groups exist). It's a virtual subdomain: one flat list of
  // folded chips, no cluster sub-sections. Close-section closes every
  // tab across every env in every fold group.
  let sharedSectionData: DashboardSectionVM | null = null
  if (foldGroups.length > 0) {
    const sortedFolds = foldGroups.toSorted((a, b) => compareWithPriorityThenRememberedChipOrder(
      dashboardFoldChipOrderKey(a[0]?.sourceType, a.map((tab) => tab.url)),
      dashboardFoldChipOrderKey(b[0]?.sourceType, b.map((tab) => tab.url)),
      chipPriorityScoreForTabs(a),
      chipPriorityScoreForTabs(b),
      () => {
        const aFirst = a[0]
        const bFirst = b[0]
        if (!aFirst || !bFirst) return a.length - b.length
        return compareNumericText(sortLabel(aFirst), sortLabel(bFirst))
      },
    ))
    const sharedPinScopeId = pageChipPinScopeId(group.domain, '__shared__', '', '')
    const foldedChipData = sortPageChipsInScope(sortedFolds.map((tabs) => annotatePageChipPin(
      buildFoldedChipData(tabs),
      sharedPinScopeId,
      pageChipPinKeyForFoldUrls(tabs.map((tab) => tab.url)),
    )))
    const { vis, hid } = splitForOverflow(foldedChipData)
    const sharedClosableUrls = allowMutations
      ? sortedFolds.flatMap((tabs) => tabs.filter(isBulkClosableTab).map((t) => t.url))
      : []
    const totalFoldedTabs = sortedFolds.reduce((sum, tabs) => sum + tabs.length, 0)
    sharedSectionData = {
      key: '__shared__',
      sectionCount: totalFoldedTabs,
      sectionClosableUrls: sharedClosableUrls,
      showHeader: false,
      isShared: true,
      hasFlat: true,
      flatVisibleChips: vis,
      flatHiddenChips: hid,
      flatHiddenCount: hid.length,
      suppressedTitleParts: [],
      clusters: [],
      websitePathSections: [],
      isPinned: false,
    }
  }

  const unsortedSectionsData: DashboardSectionVM[] = sections.map(([key, sectionTabs]) => {
    // Header appears only when a card has 2+ subdomain sections AND
    // the section isn't the empty-key "root" (card title already says
    // the root). When shown, the header replaces the per-chip prefix —
    // repeating "dev2ca" on every chip under a "dev2ca" header is noise.
    const showHeader = multipleSections && key !== ''
    // Suppress chip prefix whenever the subdomain info is shown
    // elsewhere — either a section header (multi-subdomain card) or
    // the card-title pill (single-subdomain card).
    const showChipPrefix = !showHeader && !singleSubdomainKey

    const parentRedundantLabels = new Set([key, group.domain].filter(Boolean))
    const websitePathBuckets = new Map<string, WebsitePathSectionBucket>()
    const genericWebsitePathBuckets = new Map<string, WebsitePathSectionBucket>()
    const tabsWithoutWebsitePathSection: DashboardTab[] = []
    for (const tab of sectionTabs) {
      const websitePathSection = resolveWebsitePathSection(tab.url)
      if (websitePathSection) {
        websitePathBuckets
          .getOrInsertComputed(websitePathSection.key, () => ({ ...websitePathSection, tabs: [] }))
          .tabs.push(tab)
        continue
      }

      const genericWebsitePathSection = resolveGenericWebsitePathSection(tab.url)
      if (!genericWebsitePathSection) {
        tabsWithoutWebsitePathSection.push(tab)
        continue
      }

      genericWebsitePathBuckets
        .getOrInsertComputed(
          genericWebsitePathSection.key,
          () => ({ ...genericWebsitePathSection, tabs: [] }),
        )
        .tabs.push(tab)
    }
    for (const bucket of genericWebsitePathBuckets.values()) {
      if (bucket.tabs.length >= 2) {
        websitePathBuckets.set(bucket.key, bucket)
      } else {
        tabsWithoutWebsitePathSection.push(...bucket.tabs)
      }
    }
    const websitePathBucketList = websitePathBuckets.values().toArray().sort((a, b) => compareWithPriority(
      chipPriorityScoreForTabs(a.tabs),
      chipPriorityScoreForTabs(b.tabs),
      () => compareNumericText(a.label, b.label),
    ))
    const showWebsitePathSections =
      websitePathBucketList.length > 1 ||
      ((websitePathBucketList[0]?.tabs.length ?? 0) >= 2 && tabsWithoutWebsitePathSection.length > 0)
    const parentTabs = showWebsitePathSections ? tabsWithoutWebsitePathSection : sectionTabs
    const parentContent = buildSectionContent(parentTabs, showChipPrefix, parentRedundantLabels, { subdomainKey: key, websitePathKey: '' })
    const unsortedWebsitePathSections: DashboardWebsitePathSectionVM[] = showWebsitePathSections
      ? websitePathBucketList.map((websitePathSection) => {
          const content = buildSectionContent(
            websitePathSection.tabs,
            showChipPrefix,
            new Set([...parentRedundantLabels, websitePathSection.label]),
            { subdomainKey: key, websitePathKey: websitePathSection.key },
          )
          return {
            key: websitePathSection.key,
            label: websitePathSection.label,
            sectionCount: websitePathSection.tabs.length,
            sectionClosableUrls: allowMutations ? websitePathSection.tabs.filter(isBulkClosableTab).map((t) => t.url) : [],
            ...content,
            suppressedTitleParts: [],
            isPinned: pinnedSections.has(websitePathPinId(group.domain, key, websitePathSection.key)),
          }
        })
      : []
    const websitePathSections = sortPinnedFirst(unsortedWebsitePathSections)

    // Closable URLs for the subdomain-level close button in the
    // SubdomainSection header (shown only on multi-subdomain cards,
    // where the header itself is visible). Filters out tabs already
    // in a Chrome tab group — matches the preserveGroups semantics
    // used elsewhere. Union of every chip's URL in this section.
    const sectionClosableUrls = allowMutations ? sectionTabs.filter(isBulkClosableTab).map((t) => t.url) : []

    return {
      key,
      sectionCount: sectionTabs.length,
      sectionClosableUrls,
      showHeader,
      isShared: false,
      isPort: isPortGroup,
      ...parentContent,
      suppressedTitleParts: [],
      websitePathSections,
      isPinned: pinnedSections.has(subdomainPinId(group.domain, key)),
    }
  })

  // Float pinned subdomain sections to the top of the card. The shared
  // (cross-env) section, prepended below, is a virtual aggregation —
  // not user-pinnable — so the sort runs before the unshift to keep
  // shared above everything.
  const sectionsData = sortPinnedFirst(unsortedSectionsData)

  // Prepend the cross-env fold section so it sits above the per-
  // subdomain sections — it reads as a TL;DR of "these pages are the
  // same across your envs, you probably want to see them grouped."
  if (sharedSectionData) sectionsData.unshift(sharedSectionData)

  function renderedChipsInSections(sectionsToScan: DashboardSectionVM[]): DashboardChipData[] {
    return sectionsToScan.flatMap((section) => [
      ...section.flatVisibleChips,
      ...section.flatHiddenChips,
      ...section.clusters.flatMap((cluster) => [...cluster.visibleChips, ...cluster.hiddenChips]),
      ...(section.websitePathSections ?? []).flatMap((websitePathSection) => [
        ...websitePathSection.flatVisibleChips,
        ...websitePathSection.flatHiddenChips,
        ...websitePathSection.clusters.flatMap((cluster) => [...cluster.visibleChips, ...cluster.hiddenChips]),
      ]),
    ])
  }

  function renderedSuppressionCountsByKey(sectionsToScan: DashboardSectionVM[]): Map<string, { count: number, titleVariantCount: number }> {
    const countsByKey = new Map<string, { count: number, titleVariantCount: number }>()
    for (const chip of renderedChipsInSections(sectionsToScan)) {
      const chipKeys = new Set((chip.suppressedTitleParts || []).map(titleSuppressionKey))
      for (const key of chipKeys) {
        const current = countsByKey.getOrInsertComputed(
          key,
          () => ({ count: 0, titleVariantCount: 0 }),
        )
        current.count += 1
        if ((sameTitlePageChipDraftTargets(chip)?.length ?? 0) > 1) current.titleVariantCount += 1
      }
    }
    return countsByKey
  }

  function tooltipForChipTitle(chip: DashboardChipData, title: string): string {
    const titlePart = title.trim()
    if (chip.envs?.length) {
      return [chip.envs.map((env) => env.prefix).join(' · '), titlePart].filter(Boolean).join(' · ')
    }
    const tooltip = [chip.leadPrefix, titlePart, chip.variantLabel || chip.pathSuffix].filter(Boolean).join(' · ')
    const titleVariantCount = sameTitlePageChipDraftTargets(chip)?.length ?? 0
    return titleVariantCount > 0 ? `${tooltip} · ${titleVariantCount} URL variants` : tooltip
  }

  function inlineSingletonSuppressionsInChip(chip: DashboardChipData, singletonKeys: Set<string>): DashboardChipData {
    const partsToInline = (chip.suppressedTitleParts || []).filter((part) => singletonKeys.has(titleSuppressionKey(part)))
    const sameTitleTargets = sameTitlePageChipDraftTargets(chip)
    const chipWithVariants = sameTitleTargets
      ? {
          ...chip,
          [SAME_TITLE_PAGE_CHIP_DRAFT]: sameTitleTargets.map((target) => (
            inlineSingletonSuppressionsInChip(target, singletonKeys)
          )),
        }
      : chip
    if (partsToInline.length === 0) {
      return chipWithVariants
    }

    const displaySegments = inlineSingletonSuppressionsInSegments(chip.displaySegments, partsToInline)
    const suppressedTitleParts = chip.suppressedTitleParts.filter((part) => !singletonKeys.has(titleSuppressionKey(part)))
    return {
      ...chipWithVariants,
      displaySegments,
      suppressedTitleParts,
      tooltip: tooltipForChipTitle(chipWithVariants, titleTextFromSegments(displaySegments)),
    }
  }

  function inlineSingletonSuppressionsInSections(
    sectionsToNormalize: DashboardSectionVM[],
    singletonKeys: Set<string>,
  ): DashboardSectionVM[] {
    if (singletonKeys.size === 0) return sectionsToNormalize
    return sectionsToNormalize.map((section) => ({
      ...section,
      flatVisibleChips: section.flatVisibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
      flatHiddenChips: section.flatHiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
      clusters: section.clusters.map((cluster) => ({
        ...cluster,
        visibleChips: cluster.visibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        hiddenChips: cluster.hiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
      })),
      websitePathSections: (section.websitePathSections ?? []).map((websitePathSection) => ({
        ...websitePathSection,
        flatVisibleChips: websitePathSection.flatVisibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        flatHiddenChips: websitePathSection.flatHiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        clusters: websitePathSection.clusters.map((cluster) => ({
          ...cluster,
          visibleChips: cluster.visibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
          hiddenChips: cluster.hiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        })),
      })),
    }))
  }

  const renderedSuppressionCounts = renderedSuppressionCountsByKey(sectionsData)
  const singletonSuppressionKeys = new Set(
    renderedSuppressionCounts.entries()
      .filter(([, counts]) => counts.count <= 1 && counts.titleVariantCount === counts.count)
      .map(([key]) => key),
  )
  const visibleSuppressedTitleParts = suppressedTitleParts
    .filter((part) => !singletonSuppressionKeys.has(titleSuppressionKey(part.text)))
    .map((part) => {
      const renderedCounts = renderedSuppressionCounts.get(titleSuppressionKey(part.text))
      return {
        ...part,
        count: renderedCounts?.titleVariantCount ? renderedCounts.count : part.count,
      }
    })

  function suppressionTargetsByText(tabs: readonly DashboardTab[]): Record<string, Array<{ tabId: number, tabUrl: string }>> {
    const targetsByText: Record<string, Array<{ tabId: number, tabUrl: string }>> = {}
    const targetsByKey = new Map<string, Array<{ tabId: number, tabUrl: string }>>()
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue
      const actualTitle = strippedTitle(tab.title || '')
      for (const part of titlePresentation(tab).suppressedTitleParts) {
        // Display presentations are URL-deduplicated, but destructive actions
        // operate on physical tabs. Same-URL duplicates can carry different
        // live titles, so only include a tab whose own title contains the token.
        if (titleSuppressionPartPosition(actualTitle, part) === Number.MAX_SAFE_INTEGER) continue
        const key = titleSuppressionKey(part)
        targetsByKey.getOrInsertComputed(key, () => []).push({ tabId: tab.id, tabUrl: tab.url })
      }
    }
    for (const [key, targets] of targetsByKey) targetsByText[key] = targets
    return targetsByText
  }

  // Map each suppressed-title token to the exact open tabs whose title carries it,
  // so the dashboard can offer token-scoped "Close N tabs" and "Suspend N tabs".
  // Keyed by the normalized suppression key. Left empty for read-only sources,
  // mirroring how every other bulk mutation is suppressed there.
  const allowTitleSuppressionActions = allowMutations
  const suppressionCloseTargetsByText = allowTitleSuppressionActions ? suppressionTargetsByText(closableTabs) : {}
  const suppressionSuspendTargetsByText = allowTitleSuppressionActions ? suppressionTargetsByText(suspendableTabs) : {}

  const sectionsDataWithInlineSingletonSuppressions = inlineSingletonSuppressionsInSections(sectionsData, singletonSuppressionKeys)
  const hasMultipleVisibleSuppressionMeaningsAfterMerge = visibleSuppressedTitleParts.length > 1

  function scopeSuppressedTitleParts(sectionsToScope: DashboardSectionVM[]) {
    type ScopeTracker = {
      part: DashboardTitleSuppression
      sectionIndexes: Set<number>
      flatSectionIndexes: Set<number>
      clusterRefs: Set<string>
      websitePathSectionRefs: Set<string>
      websitePathFlatRefs: Set<string>
      websitePathClusterRefs: Set<string>
    }

    const trackers = new Map<string, ScopeTracker>()
    for (const part of visibleSuppressedTitleParts) {
      trackers.set(titleSuppressionKey(part.text), {
        part,
        sectionIndexes: new Set(),
        flatSectionIndexes: new Set(),
        clusterRefs: new Set(),
        websitePathSectionRefs: new Set(),
        websitePathFlatRefs: new Set(),
        websitePathClusterRefs: new Set(),
      })
    }

    function childGroupScopedPart(part: DashboardTitleSuppression, spansRenderedChildGroups: boolean): DashboardTitleSuppression {
      return hasMultipleVisibleSuppressionMeaningsAfterMerge && spansRenderedChildGroups ? { ...part, spansRenderedChildGroups: true } : part
    }

    function clusterRef(sectionIndex: number, clusterIndex: number): string {
      return `cluster\u0000${sectionIndex}\u0000${clusterIndex}`
    }

    function websitePathSectionRef(sectionIndex: number, websitePathSectionIndex: number): string {
      return `website-path-section\u0000${sectionIndex}\u0000${websitePathSectionIndex}`
    }

    function websitePathClusterRef(sectionIndex: number, websitePathSectionIndex: number, clusterIndex: number): string {
      return `website-path-cluster\u0000${sectionIndex}\u0000${websitePathSectionIndex}\u0000${clusterIndex}`
    }

    function sectionChildGroupCount(tracker: ScopeTracker, sectionIndex: number): number {
      let count = tracker.flatSectionIndexes.has(sectionIndex) ? 1 : 0
      const clusterPrefix = `cluster\u0000${sectionIndex}\u0000`
      const websitePathSectionPrefix = `website-path-section\u0000${sectionIndex}\u0000`
      for (const ref of tracker.clusterRefs) {
        if (ref.startsWith(clusterPrefix)) count += 1
      }
      for (const ref of tracker.websitePathSectionRefs) {
        if (ref.startsWith(websitePathSectionPrefix)) count += 1
      }
      return count
    }

    function websitePathChildGroupCount(tracker: ScopeTracker, sectionIndex: number, websitePathSectionIndex: number): number {
      const websiteRef = websitePathSectionRef(sectionIndex, websitePathSectionIndex)
      let count = tracker.websitePathFlatRefs.has(websiteRef) ? 1 : 0
      const prefix = `website-path-cluster\u0000${sectionIndex}\u0000${websitePathSectionIndex}\u0000`
      for (const ref of tracker.websitePathClusterRefs) {
        if (ref.startsWith(prefix)) count += 1
      }
      return count
    }

    function recordChip(
      chip: DashboardChipData,
      sectionIndex: number,
      clusterIndex: number | null,
      websitePathSectionIndex: number | null = null,
      websitePathSectionClusterIndex: number | null = null,
    ) {
      for (const part of chip.suppressedTitleParts || []) {
        const tracker = trackers.get(titleSuppressionKey(part))
        if (!tracker) continue
        tracker.sectionIndexes.add(sectionIndex)
        if (websitePathSectionIndex !== null) {
          const websiteRef = websitePathSectionRef(sectionIndex, websitePathSectionIndex)
          tracker.websitePathSectionRefs.add(websiteRef)
          if (websitePathSectionClusterIndex === null) {
            tracker.websitePathFlatRefs.add(websiteRef)
          } else {
            tracker.websitePathClusterRefs.add(websitePathClusterRef(sectionIndex, websitePathSectionIndex, websitePathSectionClusterIndex))
          }
        } else if (clusterIndex === null) {
          tracker.flatSectionIndexes.add(sectionIndex)
        } else {
          tracker.clusterRefs.add(clusterRef(sectionIndex, clusterIndex))
        }
      }
    }

    sectionsToScope.forEach((section, sectionIndex) => {
      section.flatVisibleChips.forEach((chip) => recordChip(chip, sectionIndex, null))
      section.flatHiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null))
      section.clusters.forEach((cluster, clusterIndex) => {
        cluster.visibleChips.forEach((chip) => recordChip(chip, sectionIndex, clusterIndex))
        cluster.hiddenChips.forEach((chip) => recordChip(chip, sectionIndex, clusterIndex))
      })
      const sectionWebsitePathSections = section.websitePathSections ?? []
      sectionWebsitePathSections.forEach((websitePathSection, websitePathSectionIndex) => {
        websitePathSection.flatVisibleChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, null))
        websitePathSection.flatHiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, null))
        websitePathSection.clusters.forEach((cluster, clusterIndex) => {
          cluster.visibleChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, clusterIndex))
          cluster.hiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, clusterIndex))
        })
      })
    })

    const cardParts: DashboardTitleSuppression[] = []
    const sectionPartsByIndex = new Map<number, DashboardTitleSuppression[]>()
    const clusterPartsByRef = new Map<string, DashboardTitleSuppression[]>()
    const websitePathSectionPartsByRef = new Map<string, DashboardTitleSuppression[]>()
    const websitePathClusterPartsByRef = new Map<string, DashboardTitleSuppression[]>()

    for (const part of visibleSuppressedTitleParts) {
      const tracker = trackers.get(titleSuppressionKey(part.text))
      if (!tracker || tracker.sectionIndexes.size === 0) {
        cardParts.push(part)
        continue
      }

      if (
        tracker.clusterRefs.size === 1 &&
        tracker.flatSectionIndexes.size === 0 &&
        tracker.websitePathSectionRefs.size === 0
      ) {
        const clusterRefKey = [...tracker.clusterRefs][0]
        if (clusterRefKey === undefined) continue
        clusterPartsByRef.getOrInsertComputed(clusterRefKey, () => []).push(part)
        continue
      }

      if (
        tracker.websitePathClusterRefs.size === 1 &&
        tracker.websitePathFlatRefs.size === 0 &&
        tracker.clusterRefs.size === 0 &&
        tracker.flatSectionIndexes.size === 0
      ) {
        const clusterRefKey = [...tracker.websitePathClusterRefs][0]
        if (clusterRefKey === undefined) continue
        websitePathClusterPartsByRef.getOrInsertComputed(clusterRefKey, () => []).push(part)
        continue
      }

      if (
        tracker.websitePathSectionRefs.size === 1 &&
        tracker.clusterRefs.size === 0 &&
        tracker.flatSectionIndexes.size === 0
      ) {
        const websiteRef = [...tracker.websitePathSectionRefs][0]
        if (websiteRef === undefined) continue
        const [, sectionIndexText, websitePathSectionIndexText] = websiteRef.split('\u0000')
        if (sectionIndexText === undefined || websitePathSectionIndexText === undefined) continue
        const sectionIndex = Number(sectionIndexText)
        const websitePathSectionIndex = Number(websitePathSectionIndexText)
        websitePathSectionPartsByRef.getOrInsertComputed(websiteRef, () => []).push(
          childGroupScopedPart(part, websitePathChildGroupCount(tracker, sectionIndex, websitePathSectionIndex) > 1),
        )
        continue
      }

      if (tracker.sectionIndexes.size === 1) {
        const sectionIndex = [...tracker.sectionIndexes][0]
        if (sectionIndex === undefined) continue
        sectionPartsByIndex.getOrInsertComputed(sectionIndex, () => []).push(
          childGroupScopedPart(part, sectionChildGroupCount(tracker, sectionIndex) > 1),
        )
        continue
      }

      cardParts.push(childGroupScopedPart(part, tracker.sectionIndexes.size > 1))
    }

    const scopedSections = sectionsToScope.map((section, sectionIndex) => ({
      ...section,
      suppressedTitleParts: sectionPartsByIndex.get(sectionIndex) ?? [],
      clusters: section.clusters.map((cluster, clusterIndex) => ({
        ...cluster,
        suppressedTitleParts: clusterPartsByRef.get(clusterRef(sectionIndex, clusterIndex)) ?? [],
      })),
      websitePathSections: (section.websitePathSections ?? []).map((websitePathSection, websitePathSectionIndex) => ({
        ...websitePathSection,
        suppressedTitleParts: websitePathSectionPartsByRef.get(websitePathSectionRef(sectionIndex, websitePathSectionIndex)) ?? [],
        clusters: websitePathSection.clusters.map((cluster, clusterIndex) => ({
          ...cluster,
          suppressedTitleParts: websitePathClusterPartsByRef.get(websitePathClusterRef(sectionIndex, websitePathSectionIndex, clusterIndex)) ?? [],
        })),
      })),
    }))

    return { cardParts, scopedSections }
  }

  const { cardParts: cardSuppressedTitleParts, scopedSections: scopedSectionsData } = scopeSuppressedTitleParts(sectionsDataWithInlineSingletonSuppressions)

  // Labels derived for the React component to consume directly.
  // closableCountLabel mirrors the original "Close all N tabs" vs
  // "Close N ungrouped tabs" split so the button text matches.
  const closableCountLabel =
    closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`
  const suspendableCountLabel =
    suspendableCount === tabCount
      ? `Suspend all ${suspendableCount} tab${suspendableCount !== 1 ? 's' : ''}`
      : closableCount !== tabCount
        ? `Suspend ${suspendableCount} ungrouped tab${suspendableCount !== 1 ? 's' : ''}`
        : `Suspend ${suspendableCount} active tab${suspendableCount !== 1 ? 's' : ''}`
  const closableSuspendedCountLabel =
    closableCount === tabCount
      ? closableSuspendedCount === 1
        ? 'Close 1 suspended tab'
        : `Close all ${closableSuspendedCount} suspended tabs`
      : `Close ${closableSuspendedCount} suspended ungrouped tab${closableSuspendedCount !== 1 ? 's' : ''}`

  const displayName = group.label || group.domain.replace(/^www\./, '')

  const vmClosableCount = !allowMutations ? 0 : closableCount
  const vmSuspendableCount = !allowMutations ? 0 : suspendableCount
  const vmClosableSuspendedCount = !allowMutations ? 0 : closableSuspendedCount
  const vmClosableExtras = !allowMutations ? 0 : closableExtras
  const vmClosableDupeUrls = !allowMutations ? [] : closableDupeUrls
  const vmSections = scopedSectionsData

  const { cardSuppressionToneScope, sections: tonedSections } = allocateCardSuppressionTones(cardSuppressedTitleParts, vmSections)
  const compiledSections = compileDashboardChipDrafts(tonedSections)

  return {
    stableId,
    isHidden: false,
    filtering,
    tabCount,
    totalTabCount,
    tabCountLabel,
    tabCountTitle,
    closableCount: vmClosableCount,
    closableCountLabel,
    suspendableCount: vmSuspendableCount,
    suspendableCountLabel,
    closableSuspendedCount: vmClosableSuspendedCount,
    closableSuspendedCountLabel,
    closableDupeUrls: vmClosableDupeUrls,
    closableExtras: vmClosableExtras,
    retainedPageRemovalTargets,
    retainedPageRemovalLabel,
    singleSubdomainKey,
    singleSubdomainIsPort,
    displayName,
    suppressedTitleParts: cardSuppressedTitleParts,
    allSuppressedTitleParts: visibleSuppressedTitleParts,
    suppressionCloseTargetsByText,
    suppressionSuspendTargetsByText,
    cardSuppressionToneScope,
    sections: compiledSections,
  }
}
