/* ================================================================
   Title Expansion controller — the headless open/close half of the
   Title Expansion engine (CONTEXT.md). The controller owns lane
   arbitration and expansion ownership; measurement and markup stay
   with each surface. close() is synchronous unless an owner holds
   the expansion open. Only context menus preserve expansion through
   a lane steal; closeNow() and dispose() bypass owners.
   ================================================================ */

export type TitleExpansionLane = {
  activate: (id: string) => void
  release: (id: string) => void
  subscribe: (subscriber: (activeId: string | null) => void) => () => void
  getActiveId: () => string | null
}

/**
 * One lane per surface kind (Page Chips, Activation History rows) —
 * the "at most one expanded title per surface" rule lives here.
 * Panels may subscribe directly to track which element is expanded.
 */
export function createTitleExpansionLane(): TitleExpansionLane {
  let activeId: string | null = null
  const subscribers = new Set<(activeId: string | null) => void>()

  function setActiveId(next: string | null) {
    if (activeId === next) return
    activeId = next
    for (const subscriber of subscribers) subscriber(activeId)
  }

  return {
    activate(id) {
      setActiveId(id)
    },
    release(id) {
      if (activeId === id) setActiveId(null)
    },
    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => {
        subscribers.delete(subscriber)
      }
    },
    getActiveId() {
      return activeId
    },
  }
}

/**
 * The interaction surfaces that may keep an expansion open past its
 * normal close triggers (CONTEXT.md Title Expansion ownership).
 * @public — sanctioned seam surface; surfaces pass the literals, so no
 * import site names this union (docs/adr/0021).
 */
export type TitleExpansionOwner = 'context-menu' | 'keyboard-focus'

export type TitleExpansionControllerOptions = {
  id: string
  lane: TitleExpansionLane
  onExpandedChange: (expanded: boolean) => void
}

export type TitleExpansionController = {
  open: () => void
  close: () => void
  /** Collapse and release unconditionally — bypasses owners. */
  closeNow: () => void
  /**
   * Keep the expansion open while the owner is up. Holds are refcounted
   * per owner kind, so overlapping menus stay safe; the returned release
   * is idempotent.
   */
  hold: (owner: TitleExpansionOwner) => () => void
  isExpanded: () => boolean
  dispose: () => void
}

export function createTitleExpansionController({
  id,
  lane,
  onExpandedChange,
}: TitleExpansionControllerOptions): TitleExpansionController {
  let expanded = false
  const holds = new Map<TitleExpansionOwner, number>()

  function setExpanded(next: boolean) {
    if (expanded === next) return
    expanded = next
    onExpandedChange(expanded)
  }

  // Releasing a stale owner must leave the newer lane activation intact.
  function collapseAndRelease() {
    lane.release(id)
    setExpanded(false)
  }

  const unsubscribe = lane.subscribe((activeId) => {
    if (activeId === id) return
    if (holds.has('context-menu')) return
    setExpanded(false)
  })

  return {
    open() {
      lane.activate(id)
      setExpanded(true)
    },
    close() {
      if (holds.size > 0) return
      collapseAndRelease()
    },
    closeNow: collapseAndRelease,
    hold(owner) {
      holds.set(owner, (holds.get(owner) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = holds.get(owner) ?? 0
        if (count <= 1) holds.delete(owner)
        else holds.set(owner, count - 1)
      }
    },
    isExpanded() {
      return expanded
    },
    dispose() {
      unsubscribe()
      lane.release(id)
      holds.clear()
    },
  }
}
