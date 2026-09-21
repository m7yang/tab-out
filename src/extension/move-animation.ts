/* ================================================================
   Move animation — the one FLIP lifecycle behind both movers
   (Domain Card blocks, Working Set items).

   snapshot(roots) BEFORE layout changes captures each item's visual
   position (including any in-flight transform, so interruptions keep
   continuity), keyed by config.keyOf with multiple positions per key
   (duplicate Domain Card ids across mission containers) resolved by
   closest-match at animate time. animate(roots, previous) cancels
   stale moves, inverts (<1px deltas skipped), forces a reflow, then
   plays on the next frame with a module-owned inline transition on
   the shared motion token: `transform <duration>ms var(--ease-swift)`.
   Cleanup runs on transitionend or a duration+grace timeout,
   whichever lands first. Reduced motion disables the whole lifecycle.

   Coordinate space is per-adapter: 'viewport' when items fly across
   roots (cards over the history pane), 'root' when items stay inside
   one scrolling container (working-set grid).
   ================================================================ */

export type MovePosition = { left: number, top: number, width: number, height: number }
export type MovePositionMap = Map<string, MovePosition[]>

export type MoveAnimatorHooks = {
  /** Runs once when this animate() call has movers, before the play frame. */
  beforePlay?: (roots: HTMLElement[]) => void
}

export type MoveAnimatorConfig = {
  itemSelector: string
  /** Optional broader selector used only while taking the before-layout snapshot. */
  snapshotItemSelector?: string
  keyOf: (item: HTMLElement) => string
  duration: number
  movingClass: string
  activeClass: string
  coordinateSpace: 'viewport' | 'root'
  /** When a parent and its descendants move together, animate only the outermost moving surface. */
  suppressNestedMoves?: boolean
  /** Inline z-index while an item is moving (consumers may prefer a class on movingClass instead). */
  moveZIndex?: string
}

export type MoveAnimator = {
  snapshot(roots: ReadonlyArray<HTMLElement | null>): MovePositionMap
  cancel(roots: ReadonlyArray<HTMLElement | null>): void
  animate(roots: ReadonlyArray<HTMLElement | null>, previous: MovePositionMap | null, hooks?: MoveAnimatorHooks): void
}

type ActiveMove = {
  frameId: number
  timeoutId: number
  cancel: () => void
}

type CandidateMove = {
  item: HTMLElement
  dx: number
  dy: number
}

const CLEANUP_GRACE_MS = 80
const activeMoves = new WeakMap<HTMLElement, ActiveMove>()

const requestFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => Number(setTimeout(cb, 16))

const cancelFrame: (id: number) => void = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id) => clearTimeout(id)

function shouldReduceMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function roundPosition(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

export function createMoveAnimator(config: MoveAnimatorConfig): MoveAnimator {
  function itemsIn(root: HTMLElement, selector = config.itemSelector): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(selector))
  }

  function originOf(root: HTMLElement): { left: number, top: number } {
    if (config.coordinateSpace === 'root') {
      const rect = root.getBoundingClientRect()
      return { left: rect.left, top: rect.top }
    }
    return { left: 0, top: 0 }
  }

  function positionOf(item: HTMLElement, origin: { left: number, top: number }): MovePosition {
    const rect = item.getBoundingClientRect()
    return {
      left: roundPosition(rect.left - origin.left),
      top: roundPosition(rect.top - origin.top),
      width: roundPosition(rect.width),
      height: roundPosition(rect.height),
    }
  }

  function snapshot(roots: ReadonlyArray<HTMLElement | null>): MovePositionMap {
    const positions: MovePositionMap = new Map()
    if (shouldReduceMotion()) return positions

    for (const root of roots) {
      if (!root) continue
      const origin = originOf(root)
      for (const item of itemsIn(root, config.snapshotItemSelector ?? config.itemSelector)) {
        const key = config.keyOf(item)
        if (!key) continue
        positions.getOrInsertComputed(key, () => []).push(positionOf(item, origin))
      }
    }

    return positions
  }

  function cancelItem(item: HTMLElement): void {
    const active = activeMoves.get(item)
    if (active) {
      active.cancel()
      return
    }

    item.classList.remove(config.movingClass, config.activeClass)
    item.style.transform = ''
    item.style.transition = ''
    if (config.moveZIndex) item.style.zIndex = ''
  }

  function cancel(roots: ReadonlyArray<HTMLElement | null>): void {
    for (const root of roots) {
      if (!root) continue
      itemsIn(root).forEach(cancelItem)
    }
  }

  function takeClosestPrevious(previous: MovePositionMap, key: string, next: MovePosition): MovePosition | null {
    const candidates = previous.get(key)
    if (!candidates || candidates.length === 0) return null

    let closestIndex = 0
    let closestDistance = Infinity
    candidates.forEach((candidate, index) => {
      const dx = candidate.left - next.left
      const dy = candidate.top - next.top
      const distance = dx * dx + dy * dy
      if (distance < closestDistance) {
        closestDistance = distance
        closestIndex = index
      }
    })

    const [closest] = candidates.splice(closestIndex, 1)
    if (!closest) return null
    if (candidates.length === 0) previous.delete(key)
    return closest
  }

  function animate(roots: ReadonlyArray<HTMLElement | null>, previous: MovePositionMap | null, hooks?: MoveAnimatorHooks): void {
    if (!previous || previous.size === 0 || shouldReduceMotion()) return

    const presentRoots: HTMLElement[] = []
    const candidateMoves: CandidateMove[] = []
    for (const root of roots) {
      if (!root) continue
      presentRoots.push(root)
      const origin = originOf(root)
      for (const item of itemsIn(root)) {
        const key = config.keyOf(item)
        cancelItem(item)
        if (!key) continue

        const next = positionOf(item, origin)
        const previousPosition = takeClosestPrevious(previous, key, next)
        if (!previousPosition) continue

        const dx = previousPosition.left - next.left
        const dy = previousPosition.top - next.top
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue

        candidateMoves.push({ item, dx, dy })
      }
    }

    const moves = config.suppressNestedMoves
      ? candidateMoves.filter((candidate) => (
          !candidateMoves.some((other) => (
            other.item !== candidate.item &&
            other.item.contains(candidate.item)
          ))
        ))
      : candidateMoves
    const moving = moves.map(({ item, dx, dy }) => {
      item.classList.add(config.movingClass)
      item.style.transition = 'none'
      item.style.transform = `translate(${dx}px, ${dy}px)`
      // A temporary will-change layer changes rasterized edges at fractional
      // zoom, making vertically moving chips twitch sideways at cleanup.
      if (config.moveZIndex) item.style.zIndex = config.moveZIndex
      return item
    })

    if (moving.length === 0) return

    hooks?.beforePlay?.(presentRoots)

    presentRoots.forEach((root) => root.getBoundingClientRect())

    moving.forEach((item) => {
      function resetItemStyles() {
        item.classList.remove(config.movingClass, config.activeClass)
        item.style.transform = ''
        item.style.transition = ''
        if (config.moveZIndex) item.style.zIndex = ''
      }
      function cleanup() {
        if (activeMoves.get(item) !== active) return
        activeMoves.delete(item)
        cancelFrame(active.frameId)
        clearTimeout(active.timeoutId)
        item.removeEventListener('transitionend', onTransitionEnd)
        resetItemStyles()
      }
      function onTransitionEnd(e: TransitionEvent) {
        if (e.target === item && e.propertyName === 'transform') cleanup()
      }
      const active: ActiveMove = {
        frameId: 0,
        timeoutId: 0,
        cancel: cleanup,
      }

      item.addEventListener('transitionend', onTransitionEnd)
      active.frameId = requestFrame(() => {
        if (activeMoves.get(item) !== active) return
        item.classList.add(config.activeClass)
        item.style.transition = `transform ${config.duration}ms var(--ease-swift)`
        item.style.transform = 'translate(0, 0)'
      })
      active.timeoutId = Number(setTimeout(cleanup, config.duration + CLEANUP_GRACE_MS))
      activeMoves.set(item, active)
    })
  }

  return { snapshot, cancel, animate }
}
