import { domainGroupCardId } from './domain-card-id.js'
import { isGroupedTab } from './groups.js'
import { compareNumericText } from './numeric-sort.js'
import { cleanTitleWithRemovedSuffix, stripTitleNoise } from './titles.js'
import { subdomainPrefix } from './domains.js'
import { resolvePathGroup } from './path-groups.js'
import { resolveGenericWebsitePathSection, resolveWebsitePathSection } from './website-path-sections.js'
import { allocateCardSuppressionTones } from './title-suppression-tones.js'
import { tabMatchesCompiledFilter } from './filter-match.js'
import { compileFilterQuery } from './filter-query.js'
import { countClosableDuplicateExtras } from './tab-dedupe-policy.js'
import { canonicalDedupeKey } from './url-canonical.js'
import { dashboardItemNameForTabs, isClosedSavedDashboardTab } from './dashboard-source.js'
import { pathgroupPinId, subdomainPinId, websitePathPinId } from './section-pins.js'
import { pageChipPinKeyForFoldUrls, pageChipPinScopeId } from './page-chip-pins.js'
import { computeTitlePresentations, summarizeTitleSuppression, titleSuppressionKey } from './domain-card-view-model/title-suppression.js'
import { compileDashboardChipDrafts } from './domain-card-view-model/chip-drafts.js'
import { createChipOrdering, createPagePinIndex, dashboardChipOrderAltKeyForTab, dashboardChipOrderKeyForTab, dashboardFoldChipOrderKey, sortPinnedFirst } from './domain-card-view-model/ordering.js'
import { collectCrossEnvFolds, dedupeTabsForDisplay, groupTabsBySubdomain } from './domain-card-view-model/grouping.js'
import { inlineSingletonSuppressionsInSections, renderedSuppressionCountsByKey, scopeSuppressedTitleParts, suppressionTargetsByText } from './domain-card-view-model/suppression-scoping.js'
import { createChipBuilders } from './domain-card-view-model/chips.js'
import type { PinnedPageChipIndex } from './page-chip-pins.js'
import type { CompiledFilterQuery } from './filter-query.js'
import type { DashboardCardVM, DashboardChipData, DashboardChipPriorityMap, DashboardClusterVM, DashboardSectionVM, DashboardSource, DashboardTab, DashboardWebsitePathSectionVM, DomainGroup, PathGroupResult, RetainedPageActionTarget, WebsitePathSectionResult } from './types'
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

  const { uniqueTabs, tabOutDisplayMeta } = dedupeTabsForDisplay({ tabs, isTabOutGroup, currentWindowId, keyOf })

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

  const { foldGroups, foldedTabUrls } = collectCrossEnvFolds({
    uniqueTabs,
    parseUrl,
    subdomainForUrl,
    titleKeyOf: (tab) => lowerDisplayTitle(tab, true),
  })

  const bySubdomain = groupTabsBySubdomain({ uniqueTabs, foldedTabUrls, parseUrl, subdomainForUrl })

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

  const { buildChipData, buildChipDataList, buildFoldedChipData, splitForOverflow } = createChipBuilders({
    filtering,
    isTabOutGroup,
    currentWindowId,
    keyOf,
    tabsByUrl,
    tabOutDisplayMeta,
    parseUrl,
    subdomainForUrl,
    titlePresentation,
    titleKeyOf: (tab) => lowerDisplayTitle(tab, true),
    suppressedTitlePartOrder,
    annotatePageChipPin,
    sortPageChipsInScope,
  })

  // Order chips within a cluster by sub-category (if the adapter
  // provided one), then by their display-label order (preserved via
  // stable sort, since the input tabs are already sorted by display
  // label above). Unknown categories fall to 'other'.
  const CATEGORY_ORDER: Record<PathCategory, number> = { pull: 0, issue: 1, commit: 2, code: 3, other: 4 }
  const categoryRank = (category?: PathGroupResult['category']) => CATEGORY_ORDER[category ?? 'other']

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

  const suppressionTargetAccessors = {
    actualTitleOf: (tab: DashboardTab) => strippedTitle(tab.title || ''),
    suppressedTitlePartsOf: (tab: DashboardTab) => titlePresentation(tab).suppressedTitleParts,
  }

  // Map each suppressed-title token to the exact open tabs whose title carries it,
  // so the dashboard can offer token-scoped "Close N tabs" and "Suspend N tabs".
  // Keyed by the normalized suppression key. Left empty for read-only sources,
  // mirroring how every other bulk mutation is suppressed there.
  const allowTitleSuppressionActions = allowMutations
  const suppressionCloseTargetsByText = allowTitleSuppressionActions ? suppressionTargetsByText(closableTabs, suppressionTargetAccessors) : {}
  const suppressionSuspendTargetsByText = allowTitleSuppressionActions ? suppressionTargetsByText(suspendableTabs, suppressionTargetAccessors) : {}

  const sectionsDataWithInlineSingletonSuppressions = inlineSingletonSuppressionsInSections(sectionsData, singletonSuppressionKeys)

  const { cardParts: cardSuppressedTitleParts, scopedSections: scopedSectionsData } = scopeSuppressedTitleParts(sectionsDataWithInlineSingletonSuppressions, visibleSuppressedTitleParts)

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
