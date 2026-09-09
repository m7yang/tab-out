/* ================================================================
   Suppression scoping — after sections are assembled, decide where
   each suppressed-title token renders and which chips inline their
   pills back into the title.

   renderedSuppressionCountsByKey counts a token across every
   rendered chip; singleton tokens get inlined back into their one
   chip (inlineSingletonSuppressionsInSections) instead of holding
   a summary slot. scopeSuppressedTitleParts then narrows every
   remaining token to the single cluster, website-path section, or
   subdomain section that owns all its occurrences, leaving only
   genuinely cross-section tokens at the card level.
   suppressionTargetsByText maps tokens to the exact live tabs a
   token-scoped close or suspend action may touch.
   ================================================================ */

import { titleSuppressionKey, titleSuppressionPartPosition } from './title-suppression.js'
import { inlineSingletonSuppressionsInSegments, titleTextFromSegments } from './segments.js'
import { SAME_TITLE_PAGE_CHIP_DRAFT, sameTitlePageChipDraftTargets } from './chip-drafts.js'
import type { DashboardChipData, DashboardSectionVM, DashboardTab, DashboardTitleSuppression } from '../types'

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

export function renderedSuppressionCountsByKey(sectionsToScan: DashboardSectionVM[]): Map<string, { count: number, titleVariantCount: number }> {
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

export function inlineSingletonSuppressionsInSections(
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

type SuppressionTargetAccessors = {
  actualTitleOf: (tab: DashboardTab) => string
  suppressedTitlePartsOf: (tab: DashboardTab) => string[]
}

export function suppressionTargetsByText(
  tabs: readonly DashboardTab[],
  { actualTitleOf, suppressedTitlePartsOf }: SuppressionTargetAccessors,
): Record<string, Array<{ tabId: number, tabUrl: string }>> {
  const targetsByText: Record<string, Array<{ tabId: number, tabUrl: string }>> = {}
  const targetsByKey = new Map<string, Array<{ tabId: number, tabUrl: string }>>()
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue
    const actualTitle = actualTitleOf(tab)
    for (const part of suppressedTitlePartsOf(tab)) {
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

export function scopeSuppressedTitleParts(
  sectionsToScope: DashboardSectionVM[],
  visibleSuppressedTitleParts: readonly DashboardTitleSuppression[],
): { cardParts: DashboardTitleSuppression[], scopedSections: DashboardSectionVM[] } {
  const hasMultipleVisibleSuppressionMeaningsAfterMerge = visibleSuppressedTitleParts.length > 1

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
