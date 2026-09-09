/* ================================================================
   Chip ordering — remembered order keys, the priority comparators,
   and the per-card page-pin index.

   Order keys are the stable strings the remembered chip-order map
   is keyed by (saved/retained targets order under their open-tab
   key; folds under a representative URL). The two factories hold
   the ordering state of one computeDomainCardViewModel call:
   createChipOrdering compares by priority score, then remembered
   order, then the caller fallback; createPagePinIndex records pin
   order while chips are annotated and sorts chips pinned-first
   within one rendered sibling scope. Nothing here mutates inputs.
   ================================================================ */

import { pageChipFoldRepresentativeUrl, pageChipPinId, pinnedPageChipOrder } from '../page-chip-pins.js'
import { sameTitlePageChipDraftTargets } from './chip-drafts.js'
import type { PinnedPageChipIndex } from '../page-chip-pins.js'
import type { DashboardChipData, DashboardChipPriorityMap, DashboardSource, DashboardTab } from '../types'

// Stable pinned-first sort: unpinned items keep their incoming order.
// Treats absent isPinned (test mocks built before this feature) as false.
export function sortPinnedFirst<T extends { isPinned?: boolean }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => Number(b.isPinned === true) - Number(a.isPinned === true))
}

function dashboardChipOrderKey(sourceType: DashboardTab['sourceType'] | undefined, kind: 'url' | 'fold', value: string): string {
  const orderSource = sourceType === 'saved-page' || sourceType === 'retained-page'
    ? 'tab'
    : sourceType || 'tab'
  return `${orderSource}:${kind}:${value}`
}

export function dashboardFoldChipOrderKey(sourceType: DashboardTab['sourceType'] | undefined, urls: readonly string[]): string {
  return dashboardChipOrderKey(sourceType, 'fold', pageChipFoldRepresentativeUrl(urls))
}

export function dashboardChipOrderKeyForTab(tab: Pick<DashboardTab, 'sourceType' | 'url'>): string {
  return dashboardChipOrderKey(tab.sourceType, 'url', tab.url)
}

export function dashboardChipOrderAltKeyForTab(tab: Pick<DashboardTab, 'sourceType' | 'rawUrl' | 'url'>): string | null {
  return tab.rawUrl && tab.rawUrl !== tab.url ? dashboardChipOrderKey(tab.sourceType, 'url', tab.rawUrl) : null
}

export function dashboardChipOrderKeyForChip(chip: Pick<DashboardChipData, 'sourceType' | 'tabUrl' | 'envs'>): string {
  const envUrls = chip.envs?.map((env) => env.tabUrl).filter(Boolean)
  if (envUrls?.length) return dashboardFoldChipOrderKey(chip.sourceType, envUrls)
  return dashboardChipOrderKey(chip.sourceType, 'url', chip.tabUrl)
}

export function dashboardChipOrderAltKeyForChip(chip: Pick<DashboardChipData, 'sourceType' | 'rawUrl' | 'tabUrl' | 'envs'>): string | null {
  if (chip.envs?.length) return null
  return chip.rawUrl && chip.rawUrl !== chip.tabUrl ? dashboardChipOrderKey(chip.sourceType, 'url', chip.rawUrl) : null
}

type ChipOrdering = {
  hasRememberedChipOrder: boolean
  chipPriorityScore: (tab: DashboardTab) => number
  chipPriorityScoreForTabs: (priorityTabs: readonly DashboardTab[]) => number
  compareWithPriority: (aPriority: number, bPriority: number, fallback: () => number) => number
  compareWithPriorityThenRememberedChipOrder: (aKey: string, bKey: string, aPriority: number, bPriority: number, fallback: () => number, aAltKey?: string | null, bAltKey?: string | null) => number
}

// Ordering state for one card compute: priority scores win first,
// then the remembered chip order, then the caller fallback.
export function createChipOrdering({ chipOrder, chipPriority }: { chipOrder: Map<string, number> | undefined, chipPriority: DashboardChipPriorityMap | undefined }): ChipOrdering {
  const hasRememberedChipOrder = !!chipOrder && chipOrder.size > 0

  function chipPriorityScore(tab: DashboardTab): number {
    const score = chipPriority?.get(tab.url || '') ?? chipPriority?.get(tab.rawUrl || '')
    return typeof score === 'number' && Number.isFinite(score) ? score : 0
  }

  function chipPriorityScoreForTabs(priorityTabs: readonly DashboardTab[]): number {
    return priorityTabs.reduce((max, tab) => Math.max(max, chipPriorityScore(tab)), 0)
  }

  function comparePriorityScores(aPriority: number, bPriority: number): number {
    return aPriority === bPriority ? 0 : bPriority - aPriority
  }

  function compareWithPriority(aPriority: number, bPriority: number, fallback: () => number): number {
    return comparePriorityScores(aPriority, bPriority) || fallback()
  }

  function chipOrderForKey(key: string, altKey: string | null = null): number | undefined {
    return chipOrder?.get(key) ?? (altKey ? chipOrder?.get(altKey) : undefined)
  }

  function compareWithPriorityThenRememberedChipOrder(aKey: string, bKey: string, aPriority: number, bPriority: number, fallback: () => number, aAltKey: string | null = null, bAltKey: string | null = null): number {
    const priorityDelta = comparePriorityScores(aPriority, bPriority)
    if (priorityDelta !== 0) return priorityDelta
    const aOrder = chipOrderForKey(aKey, aAltKey)
    const bOrder = chipOrderForKey(bKey, bAltKey)
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder
    if (aOrder !== undefined && bOrder === undefined) return -1
    if (aOrder === undefined && bOrder !== undefined) return 1
    return fallback()
  }

  return {
    hasRememberedChipOrder,
    chipPriorityScore,
    chipPriorityScoreForTabs,
    compareWithPriority,
    compareWithPriorityThenRememberedChipOrder,
  }
}

type PagePinIndex = {
  annotatePageChipPin: (chip: DashboardChipData, scopeId: string, chipKey: string) => DashboardChipData
  sortPageChipsInScope: <T extends DashboardChipData>(chips: readonly T[]) => T[]
}

// Pin order is discovered while chips are annotated and consulted
// by the in-scope sorts afterwards, so both live behind one index.
export function createPagePinIndex({ source, pinnedPageChips }: { source: DashboardSource, pinnedPageChips: PinnedPageChipIndex | undefined }): PagePinIndex {
  const pagePinOrderById = new Map<string, number>()

  function annotatePageChipPin(chip: DashboardChipData, scopeId: string, chipKey: string): DashboardChipData {
    if (source !== 'tabs' || chip.iconOnly || chip.isApp || chip.pagePinDisabled) return chip
    const pinId = pageChipPinId(source, scopeId, chipKey)
    const order = pinnedPageChipOrder(pinnedPageChips, source, scopeId, chipKey)
    if (order !== null) pagePinOrderById.set(pinId, order)
    return {
      ...chip,
      pagePinId: pinId,
      pagePinned: order !== null,
    }
  }

  function pagePinOrderForChip(chip: DashboardChipData): number | null {
    const directOrder = chip.pagePinId ? pagePinOrderById.get(chip.pagePinId) : undefined
    if (directOrder !== undefined) return directOrder

    let earliestVariantOrder: number | null = null
    for (const variant of sameTitlePageChipDraftTargets(chip) ?? []) {
      const variantOrder = variant.pagePinId ? pagePinOrderById.get(variant.pagePinId) : undefined
      if (variantOrder === undefined) continue
      if (earliestVariantOrder === null || variantOrder < earliestVariantOrder) {
        earliestVariantOrder = variantOrder
      }
    }
    return earliestVariantOrder
  }

  function comparePageChipPins(a: DashboardChipData, b: DashboardChipData): number {
    const aOrder = pagePinOrderForChip(a)
    const bOrder = pagePinOrderForChip(b)
    if (aOrder !== null && bOrder !== null) return aOrder - bOrder
    if (aOrder !== null) return -1
    if (bOrder !== null) return 1
    return 0
  }

  function sortPageChipsInScope<T extends DashboardChipData>(chips: readonly T[]): T[] {
    return chips.toSorted(comparePageChipPins)
  }

  return {
    annotatePageChipPin,
    sortPageChipsInScope,
  }
}
