/* ================================================================
   Tooltip coordination — the cross-tooltip state shared by every
   Tooltip instance on the page.

   Two small machines live here. Anchor activity remembers which
   tooltip is open and when the last one closed, so a neighbouring
   tooltip can open with the short adjacent rest delay instead of
   the full initial delay. Wheel forwarding keeps routing wheel
   events into the scroll container that closed a tooltip for a
   short window (renewed while scrolling), so the page keeps
   scrolling under the pointer while reopen stays blocked.

   All of this state is read only from event handlers — never
   during render — so instances coordinate through these named
   transitions rather than a store subscription.
   ================================================================ */

const TOOLTIP_ADJACENT_REST_WINDOW_MS = 700
const TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS = 900
const TOOLTIP_WHEEL_DELTA_LINE = 1
const TOOLTIP_WHEEL_DELTA_PAGE = 2
const TOOLTIP_WHEEL_LINE_HEIGHT_PX = 16

let activeTooltipAnchorId: string | null = null
let latestTooltipActivityAt = 0
let wheelClosedTooltipBlockedUntil = 0
let tooltipWheelForwardContainer: HTMLElement | null = null
let tooltipWheelForwardUntil = 0
let tooltipWheelForwardClearTimer: number | null = null
let tooltipWheelForwardListenerInstalled = false
let tooltipWheelForwardRefresh: (() => void) | null = null
let tooltipWheelForwardOwnerId: string | null = null

function now() {
  return performance.now()
}

export function shouldUseAdjacentTooltipDelay(anchorId: string) {
  const hasActiveOtherTooltip =
    activeTooltipAnchorId !== null && activeTooltipAnchorId !== anchorId
  const recentlyClosed =
    activeTooltipAnchorId === null &&
    latestTooltipActivityAt > 0 &&
    now() - latestTooltipActivityAt <= TOOLTIP_ADJACENT_REST_WINDOW_MS
  return hasActiveOtherTooltip || recentlyClosed
}

export function markTooltipAnchorActive(anchorId: string): void {
  activeTooltipAnchorId = anchorId
  latestTooltipActivityAt = now()
}

export function releaseActiveTooltipAnchor(anchorId: string) {
  if (activeTooltipAnchorId !== anchorId) return
  activeTooltipAnchorId = null
  latestTooltipActivityAt = now()
}

export function isTooltipReopenBlockedAfterWheelClose(): boolean {
  return now() < wheelClosedTooltipBlockedUntil
}

export function blockTooltipReopenAfterWheelClose(): void {
  wheelClosedTooltipBlockedUntil = now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
}

function tooltipWheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  pageSize: number,
) {
  if (deltaMode === TOOLTIP_WHEEL_DELTA_LINE) {
    return delta * TOOLTIP_WHEEL_LINE_HEIGHT_PX
  }
  if (deltaMode === TOOLTIP_WHEEL_DELTA_PAGE) {
    return delta * pageSize
  }
  return delta
}

type TooltipWheelLike = Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>

export function tooltipScrollElementByWheel(
  element: HTMLElement,
  event: TooltipWheelLike,
) {
  const deltaX = tooltipWheelDeltaToPixels(
    event.deltaX,
    event.deltaMode,
    element.clientWidth,
  )
  const deltaY = tooltipWheelDeltaToPixels(
    event.deltaY,
    event.deltaMode,
    element.clientHeight,
  )
  const previousLeft = element.scrollLeft
  const previousTop = element.scrollTop

  if (deltaX !== 0) {
    element.scrollLeft += deltaX
  }
  if (deltaY !== 0) {
    element.scrollTop += deltaY
  }

  return element.scrollLeft !== previousLeft || element.scrollTop !== previousTop
}

export function clearTooltipWheelForwarding(ownerId?: string) {
  if (ownerId && tooltipWheelForwardOwnerId !== ownerId) return
  tooltipWheelForwardContainer = null
  tooltipWheelForwardUntil = 0
  tooltipWheelForwardRefresh = null
  tooltipWheelForwardOwnerId = null
  if (tooltipWheelForwardClearTimer !== null) {
    window.clearTimeout(tooltipWheelForwardClearTimer)
    tooltipWheelForwardClearTimer = null
  }
  if (tooltipWheelForwardListenerInstalled) {
    window.removeEventListener('wheel', handleTooltipWheelForward, true)
    tooltipWheelForwardListenerInstalled = false
  }
}

function handleTooltipWheelForward(event: WheelEvent) {
  const scrollContainer = tooltipWheelForwardContainer
  if (
    !scrollContainer ||
    now() > tooltipWheelForwardUntil ||
    !document.contains(scrollContainer)
  ) {
    clearTooltipWheelForwarding()
    return
  }

  if (!tooltipScrollElementByWheel(scrollContainer, event)) {
    clearTooltipWheelForwarding()
    return
  }

  tooltipWheelForwardUntil = now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
  tooltipWheelForwardRefresh?.()
  event.preventDefault()
  event.stopPropagation()
}

export function startTooltipWheelForwarding(
  scrollContainer: HTMLElement,
  ownerId: string,
  refreshWheelTarget: () => void,
) {
  tooltipWheelForwardContainer = scrollContainer
  tooltipWheelForwardOwnerId = ownerId
  tooltipWheelForwardRefresh = refreshWheelTarget
  tooltipWheelForwardUntil = now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
  if (!tooltipWheelForwardListenerInstalled) {
    // react-doctor-disable-next-line react-doctor/client-passive-event-listeners -- wheel forwarding consumes the event after manual scroll.
    window.addEventListener('wheel', handleTooltipWheelForward, {
      capture: true,
      passive: false,
    })
    tooltipWheelForwardListenerInstalled = true
  }
  if (tooltipWheelForwardClearTimer !== null) {
    window.clearTimeout(tooltipWheelForwardClearTimer)
  }
  tooltipWheelForwardClearTimer = window.setTimeout(
    clearTooltipWheelForwarding,
    TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS,
  )
}
