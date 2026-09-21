/* ================================================================
   Activation History row move adapter

   Closing/forgetting a row removes it from layout immediately while
   the stable-key survivors FLIP into the gap. The fixed exit ghost is
   owned by LayoutRemovalAnimation.
   ================================================================ */

import { REDUCED_LAYOUT_REMOVAL_ANIMATION_MS } from '../lib/layout-removal-motion.js'
import { createMoveAnimator } from './move-animation.js'
import type { MovePositionMap } from './move-animation.js'

const HISTORY_ENTRY_MOVE_MS = 180

const HISTORY_ENTRY_LAYOUT_SELECTOR =
  '.history-entry-row[data-tabout-layout-key]:not(.closing)'

const historyEntryMoveAnimator = createMoveAnimator({
  itemSelector: HISTORY_ENTRY_LAYOUT_SELECTOR,
  keyOf: (row) => row.dataset.taboutLayoutKey || '',
  duration: HISTORY_ENTRY_MOVE_MS,
  movingClass: 'history-entry-layout-moving',
  activeClass: 'history-entry-layout-moving-active',
  coordinateSpace: 'root',
  // HistoryEntry owns the move layers so the current row stays above crossings.
})

function shouldReduceHistoryMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function snapshotHistoryEntryPositions(root: HTMLElement | null): MovePositionMap {
  if (!root) return new Map()
  const positions = historyEntryMoveAnimator.snapshot([root])
  historyEntryMoveAnimator.cancel([root])
  return positions
}

export function animateHistoryEntryMoves(root: HTMLElement | null, positions: MovePositionMap | null) {
  if (!root) return
  historyEntryMoveAnimator.animate([root], positions)
}

export async function waitForHistoryEntryMoves() {
  const duration = shouldReduceHistoryMotion()
    ? REDUCED_LAYOUT_REMOVAL_ANIMATION_MS
    : HISTORY_ENTRY_MOVE_MS
  await new Promise((resolve) => setTimeout(resolve, duration))
}
