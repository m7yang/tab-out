import { useSyncExternalStore } from 'react'

export type DomainReorderPlacement = 'before' | 'after'

export type DomainReorderTarget = {
  readonly domain: string
  readonly placement: DomainReorderPlacement
  /** Dropping here leaves the pinned order unchanged, so the indicator mutes. */
  readonly keepsOrder: boolean
}

export type DomainReorderFeedback = {
  readonly sourceDomain: string | null
  readonly target: DomainReorderTarget | null
}

/** What one Domain Card paints for the drag in progress. */
export type DomainReorderCardFeedback = {
  readonly isSource: boolean
  readonly targetPlacement: DomainReorderPlacement | null
  readonly targetKeepsOrder: boolean
}

const IDLE_FEEDBACK: DomainReorderFeedback = { sourceDomain: null, target: null }

const IDLE_CARD: DomainReorderCardFeedback = { isSource: false, targetPlacement: null, targetKeepsOrder: false }
const SOURCE_CARD: DomainReorderCardFeedback = { isSource: true, targetPlacement: null, targetKeepsOrder: false }
const TARGET_CARDS: Record<DomainReorderPlacement, Record<'move' | 'noop', DomainReorderCardFeedback>> = {
  before: {
    move: { isSource: false, targetPlacement: 'before', targetKeepsOrder: false },
    noop: { isSource: false, targetPlacement: 'before', targetKeepsOrder: true },
  },
  after: {
    move: { isSource: false, targetPlacement: 'after', targetKeepsOrder: false },
    noop: { isSource: false, targetPlacement: 'after', targetKeepsOrder: true },
  },
}

let feedback = IDLE_FEEDBACK
const listeners = new Set<() => void>()

function sameTarget(left: DomainReorderTarget | null, right: DomainReorderTarget | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.domain === right.domain && left.placement === right.placement && left.keepsOrder === right.keepsOrder
}

function publishFeedback(next: DomainReorderFeedback): void {
  if (feedback.sourceDomain === next.sourceDomain && sameTarget(feedback.target, next.target)) return
  feedback = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDomainReorderFeedback(): DomainReorderFeedback {
  return feedback
}

/** A pinned card's drag crossed the movement threshold. */
export function startDomainReorder(sourceDomain: string): void {
  publishFeedback({ sourceDomain, target: null })
}

/** The pointer is over another pinned card (or over nothing droppable). */
export function setDomainReorderTarget(target: DomainReorderTarget | null): void {
  publishFeedback({ sourceDomain: feedback.sourceDomain, target })
}

/** The drag dropped or was cancelled; every card returns to rest. */
export function endDomainReorder(): void {
  publishFeedback(IDLE_FEEDBACK)
}

/**
 * Resolves one card's share of the drag. Results are shared constants so a
 * store snapshot that does not change this card compares equal by identity.
 */
export function domainReorderCardFeedback(state: DomainReorderFeedback, domain: string): DomainReorderCardFeedback {
  if (state.sourceDomain === domain) return SOURCE_CARD
  const target = state.target
  if (!target || target.domain !== domain) return IDLE_CARD
  return TARGET_CARDS[target.placement][target.keepsOrder ? 'noop' : 'move']
}

const serverCardFeedback = () => IDLE_CARD

/** Subscribes one Domain Card; only the source and the hovered target re-render. */
export function useDomainReorderCardFeedback(domain: string): DomainReorderCardFeedback {
  return useSyncExternalStore(subscribe, () => domainReorderCardFeedback(feedback, domain), serverCardFeedback)
}
