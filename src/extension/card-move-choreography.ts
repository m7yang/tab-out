/* ================================================================
   Dashboard move choreography — the FLIP hand-off state between
   user actions, Dashboard Intake applies, and the layout commit.

   Domain Card moves: a prime captures card rects before a state
   change (filter edits, pinned-domain applies, animated refreshes,
   view and source switches); the store apply may re-stage rects
   for the matching source-switch request; commitDashboardLayout
   consumes staged rects after React commits — cancelling stale
   moves, repacking the masonry, then playing the FLIP. A filter
   move stays alive across the companion data-only refresh that
   lands right after the local filter commit.

   Intra-card moves: one prepared section or page-chip pin move
   parks between the pin toggle and the pins commit.

   One instance lives for the App's lifetime. All state is event
   and commit scoped and never read during render, so App keeps
   thin effects that delegate to these named transitions.
   ================================================================ */

import { animateDomainCardMoves, cancelDomainCardMoves, hasActiveDomainCardMoves, prepareDomainCardMoveAnimation } from './card-move-animation.js'
import { animateIntraCardMoves, prepareIntraCardMoveAnimationByKey } from './intra-card-move-animation.js'
import type { CardPositionMap, MissionContainer } from './card-move-animation.js'
import type { PreparedIntraCardMove } from './intra-card-move-animation.js'
import type { DashboardBeforeApplyEvent } from './dashboard-intake.js'

export type DashboardMoveChoreography = {
  /** Snapshot card rects so the next layout commit plays a FLIP from them. */
  primeCardMove: () => void
  /** Prime for a filter edit; the move survives the companion data-only refresh. */
  primeFilterCardMove: () => void
  /** Snapshot, run the same-source view mutation, and stage the move for the commit it triggers. */
  runViewMoveNow: (mutate: () => void) => void
  /** Snapshot, run the source switch, and park the move until its request's store apply. */
  runSourceSwitchMove: (mutate: () => number | null) => void
  onBeforeStoreApply: (event: DashboardBeforeApplyEvent) => void
  /** Consume staged rects after a dashboard commit: cancel stale moves, repack, play the FLIP. */
  commitDashboardLayout: (options: { pack: () => void }) => void
  prepareIntraCardMove: (moveKey: string) => void
  commitPreparedIntraCardMove: () => void
}

export function createDashboardMoveChoreography({ containers }: { containers: () => MissionContainer[] }): DashboardMoveChoreography {
  let stagedCardRects: CardPositionMap | null = null
  let pendingSourceSwitch: { rects: CardPositionMap | null, requestId: number } | null = null
  let filterCardMoveActive = false
  let preparedIntraCardMove: PreparedIntraCardMove | null = null

  function primeCardMove(): void {
    stagedCardRects = prepareDomainCardMoveAnimation(containers())
  }

  return {
    primeCardMove,
    primeFilterCardMove() {
      filterCardMoveActive = true
      primeCardMove()
    },
    runViewMoveNow(mutate) {
      const previousRects = prepareDomainCardMoveAnimation(containers())
      pendingSourceSwitch = null
      mutate()
      stagedCardRects = previousRects
    },
    runSourceSwitchMove(mutate) {
      const previousRects = prepareDomainCardMoveAnimation(containers())
      const requestId = mutate()
      if (requestId !== null) {
        pendingSourceSwitch = { rects: previousRects, requestId }
      }
    },
    onBeforeStoreApply(event) {
      if (event.reason === 'animated-refresh') {
        primeCardMove()
        return
      }
      if (event.reason === 'source-switch') {
        const pending = pendingSourceSwitch
        if (pending?.requestId !== event.requestId) return
        pendingSourceSwitch = null
        stagedCardRects = pending.rects
      }
    },
    commitDashboardLayout({ pack }) {
      const missionContainers = containers()
      const previousRects = stagedCardRects
      stagedCardRects = null
      // Bookmark/history matches hydrate after the local tab filter commits. Keep
      // that data-only refresh from cancelling the filter move halfway through.
      const preserveActiveFilterMove = !previousRects &&
        filterCardMoveActive &&
        hasActiveDomainCardMoves(missionContainers)
      if (!previousRects && !preserveActiveFilterMove) {
        filterCardMoveActive = false
        cancelDomainCardMoves(missionContainers)
      }
      pack()
      if (previousRects) animateDomainCardMoves(missionContainers, previousRects)
    },
    prepareIntraCardMove(moveKey) {
      preparedIntraCardMove = prepareIntraCardMoveAnimationByKey(moveKey)
    },
    commitPreparedIntraCardMove() {
      const prepared = preparedIntraCardMove
      preparedIntraCardMove = null
      animateIntraCardMoves(prepared)
    },
  }
}
