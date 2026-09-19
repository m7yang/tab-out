/* ================================================================
   Intra-card move animation

   One local-scope FLIP adapter for Page Chip pins, section pins, and
   Page Chip removal. Snapshot anchors may include nested same-title
   URL variants; only full layout items animate after React commits.
   ================================================================ */

import { createMoveAnimator } from './move-animation.js'
import type { MoveAnimator, MovePositionMap } from './move-animation.js'

const INTRA_CARD_MOVE_MS = 220
const REDUCED_INTRA_CARD_OPACITY_MS = 120
const DOMAIN_CARD_SELECTOR = '[data-tabout="domain-card"]'
const LAYOUT_ANCHOR_SELECTOR = '[data-tabout-layout-anchor][data-tabout-layout-key][data-tabout-layout-scope]'
const LAYOUT_ITEM_SELECTOR = '[data-tabout-layout-item][data-tabout-layout-key][data-tabout-layout-scope]:not(.closing)'
const PAGE_CHIP_REMOVAL_ANCHOR_SELECTOR = '[data-tabout-removal-anchor][data-tabout-removal-key]'
const PAGE_CHIP_REMOVAL_ITEM_SELECTOR = '[data-tabout-removal-item][data-tabout-removal-key]:not(.closing)'
const PAGE_CHIP_FOCUS_HANDOFF_MS = 1_000

type IntraCardLayoutElement = HTMLElement & {
  dataset: DOMStringMap & {
    taboutLayoutKey?: string
    taboutLayoutScope?: string
  }
}

export type PreparedIntraCardMove = {
  animator: MoveAnimator
  positions: MovePositionMap
  reducedMotionTarget: { key: string, scope: string } | null
  root: HTMLElement
}

export type QueuedPageChipRefreshMove = {
  animateNow: () => void
}

type QueuedPageChipRefreshMoveEntry = {
  consumed: boolean
  focusRemovalKey: string
  prepared: PreparedIntraCardMove
  target: HTMLElement
}

const queuedPageChipRefreshMoves: QueuedPageChipRefreshMoveEntry[] = []
let pendingPageChipFocus: {
  domain: string
  document: Document
  focusRemovalKey: string
  lastFocusedElement: HTMLElement | null
  observer: MutationObserver | null
  timeoutId: number
} | null = null

function isIntraCardLayoutElement(value: unknown): value is IntraCardLayoutElement {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<IntraCardLayoutElement>
  return !!candidate.dataset &&
    typeof candidate.dataset.taboutLayoutKey === 'string' &&
    typeof candidate.dataset.taboutLayoutScope === 'string' &&
    typeof candidate.closest === 'function'
}

function shouldReduceIntraCardMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function clearPendingPageChipFocus() {
  if (!pendingPageChipFocus) return
  clearTimeout(pendingPageChipFocus.timeoutId)
  pendingPageChipFocus.observer?.disconnect()
  pendingPageChipFocus = null
}

function restorePendingPageChipFocus() {
  const pending = pendingPageChipFocus
  if (!pending) return

  const activeElement = pending.document.activeElement
  if (pending.lastFocusedElement?.isConnected) {
    if (activeElement !== pending.lastFocusedElement) clearPendingPageChipFocus()
    return
  }
  if (pending.lastFocusedElement && activeElement !== pending.document.body) {
    clearPendingPageChipFocus()
    return
  }

  const card = pending.document.querySelectorAll<HTMLElement>(DOMAIN_CARD_SELECTOR)
    .values()
    .find((candidate) => candidate.dataset.taboutDomain === pending.domain)
  const replacementSlot = card?.querySelectorAll<HTMLElement>(PAGE_CHIP_REMOVAL_ITEM_SELECTOR)
    .values()
    .find((candidate) => candidate.dataset.taboutRemovalKey === pending.focusRemovalKey)
  const replacement = replacementSlot?.querySelector<HTMLElement>(
    '[data-tabout="page-chip"][data-tabout-context="domain-card"][tabindex="0"], [data-tabout-default-variant="true"]',
  )
  if (!replacement) return
  replacement.focus({ preventScroll: true })
  pending.lastFocusedElement = replacement
}

function beginPageChipFocusHandoff(entry: QueuedPageChipRefreshMoveEntry) {
  if (!entry.focusRemovalKey) return
  clearPendingPageChipFocus()
  const ownerWindow = entry.prepared.root.ownerDocument.defaultView
  pendingPageChipFocus = {
    domain: entry.prepared.root.dataset.taboutDomain || '',
    document: entry.prepared.root.ownerDocument,
    focusRemovalKey: entry.focusRemovalKey,
    lastFocusedElement: null,
    observer: null,
    timeoutId: Number(setTimeout(clearPendingPageChipFocus, PAGE_CHIP_FOCUS_HANDOFF_MS)),
  }
  if (ownerWindow?.MutationObserver && entry.prepared.root.ownerDocument.body) {
    pendingPageChipFocus.observer = new ownerWindow.MutationObserver(restorePendingPageChipFocus)
    pendingPageChipFocus.observer.observe(entry.prepared.root.ownerDocument.body, {
      childList: true,
      subtree: true,
    })
  }
  restorePendingPageChipFocus()
}

export function prepareIntraCardMoveAnimation(
  targetValue: unknown,
  { reducedMotionOpacity = false }: { reducedMotionOpacity?: boolean } = {},
): PreparedIntraCardMove | null {
  if (!isIntraCardLayoutElement(targetValue)) return null

  const key = targetValue.dataset.taboutLayoutKey
  const scope = targetValue.dataset.taboutLayoutScope
  const root = targetValue.closest<HTMLElement>(DOMAIN_CARD_SELECTOR)
  if (!key || !scope || !root) return null

  const animator = createMoveAnimator({
    itemSelector: LAYOUT_ITEM_SELECTOR,
    snapshotItemSelector: LAYOUT_ANCHOR_SELECTOR,
    keyOf: (item) => item.dataset.taboutLayoutScope === scope
      ? item.dataset.taboutLayoutKey || ''
      : '',
    duration: INTRA_CARD_MOVE_MS,
    movingClass: 'intra-card-layout-moving',
    activeClass: 'intra-card-layout-moving-active',
    coordinateSpace: 'viewport',
    moveZIndex: '3',
  })
  const positions = animator.snapshot([root])
  animator.cancel([root])
  const reducedMotionTarget = reducedMotionOpacity && shouldReduceIntraCardMotion()
    ? { key, scope }
    : null
  return { animator, positions, reducedMotionTarget, root }
}

function preparePageChipRefreshMoveAnimation(targetValue: unknown): PreparedIntraCardMove | null {
  if (!isIntraCardLayoutElement(targetValue)) return null

  const root = targetValue.closest<HTMLElement>(DOMAIN_CARD_SELECTOR)
  if (!root) return null

  const animator = createMoveAnimator({
    itemSelector: PAGE_CHIP_REMOVAL_ITEM_SELECTOR,
    snapshotItemSelector: PAGE_CHIP_REMOVAL_ANCHOR_SELECTOR,
    keyOf: (item) => item.dataset.taboutRemovalKey || '',
    duration: INTRA_CARD_MOVE_MS,
    movingClass: 'intra-card-layout-moving',
    activeClass: 'intra-card-layout-moving-active',
    coordinateSpace: 'root',
    suppressNestedMoves: true,
    moveZIndex: '3',
  })
  const positions = animator.snapshot([root])
  animator.cancel([root])
  return { animator, positions, reducedMotionTarget: null, root }
}

function consumeQueuedPageChipRefreshMove(entry: QueuedPageChipRefreshMoveEntry) {
  if (entry.consumed) return
  entry.consumed = true
  const index = queuedPageChipRefreshMoves.indexOf(entry)
  if (index >= 0) queuedPageChipRefreshMoves.splice(index, 1)
  animateIntraCardMoves(entry.prepared)
  beginPageChipFocusHandoff(entry)
}

export function queuePageChipRefreshMoveAnimation(
  targetValue: unknown,
  { focusTarget = null }: { focusTarget?: HTMLElement | null } = {},
): QueuedPageChipRefreshMove | null {
  const prepared = preparePageChipRefreshMoveAnimation(targetValue)
  if (!prepared || !isIntraCardLayoutElement(targetValue)) return null

  const focusRemovalKey = focusTarget
    ?.closest<HTMLElement>('[data-tabout-removal-item][data-tabout-removal-key]')
    ?.dataset.taboutRemovalKey || ''
  const entry: QueuedPageChipRefreshMoveEntry = {
    consumed: false,
    focusRemovalKey,
    prepared,
    target: targetValue,
  }
  queuedPageChipRefreshMoves.push(entry)
  return {
    animateNow: () => consumeQueuedPageChipRefreshMove(entry),
  }
}

export function animateQueuedPageChipRefreshMoves() {
  const ready = queuedPageChipRefreshMoves.filter((entry) => !entry.target.isConnected)
  ready.forEach(consumeQueuedPageChipRefreshMove)
  restorePendingPageChipFocus()
}

export function prepareIntraCardMoveAnimationByKey(key: string): PreparedIntraCardMove | null {
  if (!key || typeof document === 'undefined') return null
  const target = document.querySelectorAll<HTMLElement>(LAYOUT_ANCHOR_SELECTOR)
    .values()
    .find((candidate) => candidate.dataset.taboutLayoutKey === key)
  return prepareIntraCardMoveAnimation(target, { reducedMotionOpacity: true })
}

export function animateIntraCardMoves(prepared: PreparedIntraCardMove | null) {
  if (!prepared) return
  if (prepared.reducedMotionTarget) {
    const { key, scope } = prepared.reducedMotionTarget
    const target = prepared.root.querySelectorAll<HTMLElement>(LAYOUT_ITEM_SELECTOR)
      .values()
      .find((candidate) => (
        candidate.dataset.taboutLayoutKey === key &&
        candidate.dataset.taboutLayoutScope === scope
      ))
    target?.animate(
      [{ opacity: 0.9 }, { opacity: 1 }],
      { duration: REDUCED_INTRA_CARD_OPACITY_MS, easing: 'linear' },
    )
    return
  }
  prepared.animator.animate([prepared.root], prepared.positions)
}
