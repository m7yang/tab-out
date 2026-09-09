/* ================================================================
   Chip builders — turn tabs into the DashboardChipData shapes the
   sections render.

   createChipBuilders holds the per-card build context (URL/title
   accessors, duplicate sets, Tab Out display metadata, pin
   annotation) and returns the four builders the assembly calls:
   the per-tab chip, the same-title-grouped chip list for one
   rendered scope, the cross-env folded chip, and the "+N more"
   overflow split. All output is fresh data; inputs are not
   mutated.
   ================================================================ */

import { omitUndefined } from '../../lib/omit-undefined.js'
import { compareNumericText } from '../numeric-sort.js'
import { pickFavicon, pickTabFavicon } from '../favicons.js'
import { groupDotColor, isGroupedTab } from '../groups.js'
import { aggregateAudioState, mergeAudioStates } from '../tab-audio.js'
import { allOpenTargetsSuspended, isClosedSavedDashboardTab } from '../dashboard-source.js'
import { pageChipPinKeyForUrl } from '../page-chip-pins.js'
import { aggregateSuppressedTitleParts } from './title-suppression.js'
import { injectBreakPoints, insertTitleSuppressionSegmentsBeforeStructuralPlaceholder, stripPgLabel } from './segments.js'
import { SAME_TITLE_PAGE_CHIP_DRAFT } from './chip-drafts.js'
import { activeFrameStateForDuplicateSet, isActiveInOtherWindow, isCurrentTabOutPage, isOpenTabLoading } from './tab-state.js'
import type { DashboardChipDraft } from './chip-drafts.js'
import type { TabOutDisplayMeta } from './grouping.js'
import type { TitlePresentation } from './title-suppression.js'
import type { DashboardChipData, DashboardTab } from '../types'

type ChipBuildEntry = {
  tab: DashboardTab
  chip: DashboardChipData
  titleKey: string
}

function pickDashboardChipFavicon(tab: DashboardTab): string {
  if ((tab.sourceType || 'tab') === 'tab') return pickTabFavicon(tab)
  return pickFavicon(tab)
}

type ChipBuilders = {
  buildChipData: (
    tab: DashboardTab,
    showPrefix: boolean,
    pathSuffix: string,
    pathGroupLabel: string,
    stripLabel?: string,
    options?: { iconOnly?: boolean, rawTitle?: boolean },
  ) => DashboardChipData
  buildChipDataList: (contentTabs: DashboardTab[], showChipPrefix: boolean, pathGroupLabel: string, pinScopeId: string, stripLabel?: string) => DashboardChipData[]
  buildFoldedChipData: (tabs: DashboardTab[]) => DashboardChipData
  splitForOverflow: <T>(tabs: T[]) => { vis: T[], hid: T[] }
}

type ChipBuildContext = {
  filtering: boolean
  isTabOutGroup: boolean
  currentWindowId: number | null
  keyOf: (tab: DashboardTab) => string
  tabsByUrl: ReadonlyMap<string, DashboardTab[]>
  tabOutDisplayMeta: WeakMap<DashboardTab, TabOutDisplayMeta>
  parseUrl: (url: string) => URL | null
  subdomainForUrl: (url: string) => string
  titlePresentation: (tab: DashboardTab) => TitlePresentation
  titleKeyOf: (tab: DashboardTab) => string
  suppressedTitlePartOrder: ReadonlyMap<string, number>
  annotatePageChipPin: (chip: DashboardChipData, scopeId: string, chipKey: string) => DashboardChipData
  sortPageChipsInScope: <T extends DashboardChipData>(chips: readonly T[]) => T[]
}

export function createChipBuilders({ filtering, isTabOutGroup, currentWindowId, keyOf, tabsByUrl, tabOutDisplayMeta, parseUrl, subdomainForUrl, titlePresentation, titleKeyOf, suppressedTitlePartOrder, annotatePageChipPin, sortPageChipsInScope }: ChipBuildContext): ChipBuilders {
  function displayTitle(tab: DashboardTab): string {
    return titlePresentation(tab).displayTitle
  }

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
        titleKey: titleKeyOf(tab),
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

  return {
    buildChipData,
    buildChipDataList,
    buildFoldedChipData,
    splitForOverflow,
  }
}
