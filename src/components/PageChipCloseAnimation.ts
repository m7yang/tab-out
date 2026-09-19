import { omitUndefined } from '../lib/omit-undefined.js'
import {
  LAYOUT_REMOVAL_ANIMATION_MS,
  startLayoutRemovalAnimation,
  type LayoutRemovalAnimationScheduler,
} from './LayoutRemovalAnimation.js'
import {
  animateIntraCardMoves,
  prepareIntraCardMoveAnimation,
  queuePageChipRefreshMoveAnimation,
} from '../extension/intra-card-move-animation.js'
import type { LayoutChangeHandler } from './types'

export const PAGE_CHIP_CLOSE_ANIMATION_MS = LAYOUT_REMOVAL_ANIMATION_MS

type PageChipCloseAnimationElement = {
  closest?: (selector: string) => unknown
}

type PageChipLayoutElement = HTMLElement & {
  dataset: DOMStringMap & {
    taboutLayoutScope?: string
  }
}

function pageChipSlot(chipEl: unknown) {
  if (!chipEl || typeof chipEl !== 'object') return chipEl
  const candidate = chipEl as PageChipCloseAnimationElement
  return candidate.closest?.('[data-tabout-part="slot"]') ?? chipEl
}

function isPageChipLayoutElement(value: unknown): value is PageChipLayoutElement {
  return !!value &&
    typeof value === 'object' &&
    'dataset' in value &&
    'closest' in value &&
    typeof (value as { closest?: unknown }).closest === 'function'
}

function pageChipIsLastScopeItem(slotValue: unknown) {
  if (!isPageChipLayoutElement(slotValue)) return false
  const scope = slotValue.dataset.taboutLayoutScope
  const card = slotValue.closest<HTMLElement>('[data-tabout="domain-card"]')
  if (!scope || !card) return false

  const scopeItems = Array.from(card.querySelectorAll<HTMLElement>('[data-tabout-layout-item][data-tabout-layout-scope]'))
    .filter((item) => (
      item.dataset.taboutLayoutScope === scope &&
      !item.classList.contains('closing') &&
      item.getClientRects().length > 0
    ))
  return scopeItems.at(-1) === slotValue
}

function pageChipCloseFocusTarget(slotValue: unknown, focusWasInsideClosingChip: boolean): HTMLElement | null {
  if (!isPageChipLayoutElement(slotValue)) return null
  const activeElement = slotValue.ownerDocument.activeElement
  if (!focusWasInsideClosingChip && (!activeElement || !slotValue.contains(activeElement))) return null

  const card = slotValue.closest<HTMLElement>('[data-tabout="domain-card"]')
  if (!card) return null
  const slots = Array.from(card.querySelectorAll<HTMLElement>('[data-tabout-part="slot"]'))
    .filter((slot) => !slot.classList.contains('closing') && slot.getClientRects().length > 0)
  const closingIndex = slots.indexOf(slotValue)
  if (closingIndex < 0) return null

  const candidates = [
    ...slots.slice(closingIndex + 1),
    ...slots.slice(0, closingIndex).reverse(),
  ]
  for (const candidate of candidates) {
    const focusTarget = candidate.querySelector<HTMLElement>(
      '[data-tabout="page-chip"][data-tabout-context="domain-card"][tabindex="0"], [data-tabout-default-variant="true"]',
    )
    if (focusTarget) return focusTarget
  }
  return null
}

export function startPageChipCloseAnimation(
  chipEl: unknown,
  onLayoutChange: LayoutChangeHandler | null = null,
  scheduleCleanup?: LayoutRemovalAnimationScheduler,
  focusWasInsideClosingChip = false,
): boolean {
  const slot = pageChipSlot(chipEl)
  const lastScopeItem = pageChipIsLastScopeItem(slot)
  const focusTarget = pageChipCloseFocusTarget(slot, focusWasInsideClosingChip)
  const queuedMove = lastScopeItem
    ? queuePageChipRefreshMoveAnimation(slot, { focusTarget })
    : null
  let preparedMove = lastScopeItem ? null : prepareIntraCardMoveAnimation(slot)

  return startLayoutRemovalAnimation(chipEl, omitUndefined({
    ghostClassName: 'page-chip-closing-ghost',
    layoutElement: slot,
    deferLayoutRemoval: lastScopeItem,
    scheduleCleanup,
    onBeforeRemove: () => {
      focusTarget?.focus({ preventScroll: true })
    },
    onAfterRemove: () => {
      animateIntraCardMoves(preparedMove)
      preparedMove = null
      onLayoutChange?.({ animate: true })
    },
    onDeferredLayoutRelease: () => {
      queuedMove?.animateNow()
      onLayoutChange?.({ animate: true })
    },
  }))
}
