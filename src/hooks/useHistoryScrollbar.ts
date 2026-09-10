import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { useRetimer } from 'foxact/use-retimer'
import { startPointerDrag, type PointerDragHandle } from '../lib/pointer-drag.js'

const HISTORY_ENTRY_SCROLLBAR_AXIS_PADDING_PX = 2
const HISTORY_ENTRY_SCROLLBAR_MIN_THUMB_HEIGHT_PX = 33
// How long the bar lingers after the last scroll/hover before fading out.
const HISTORY_ENTRY_SCROLLBAR_IDLE_HIDE_DELAY_MS = 2500

interface HistoryScrollbarMetrics {
  thumbHeight: number
  thumbTop: number
  visible: boolean
}

export interface HistoryScrollbar {
  /** current painted-thumb geometry */
  metrics: HistoryScrollbarMetrics
  /** true while the bar should be revealed (recent scroll / hover / drag) */
  active: boolean
  /** true while the thumb is being dragged (keeps it at hover width throughout) */
  dragging: boolean
  /** attach to the scrollbar track element */
  trackRef: RefObject<HTMLDivElement | null>
  /** wire to the thumb's onPointerDown (begins a drag) */
  onThumbPointerDown: (event: ReactPointerEvent) => void
  /** wire to the track's onPointerDown (jump-to-position) */
  onTrackPointerDown: (event: ReactPointerEvent) => void
  /** wire to the track's onPointerEnter (reveal) */
  onPointerEnter: () => void
  /** wire to the track's onPointerLeave (begin idle countdown) */
  onPointerLeave: () => void
}

const DEFAULT_HISTORY_SCROLLBAR_METRICS: HistoryScrollbarMetrics = {
  thumbHeight: 0,
  thumbTop: 0,
  visible: false,
}

function roundedCssPixel(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function getHistoryScrollbarMetrics(listEl: HTMLElement | null): HistoryScrollbarMetrics {
  if (!listEl) return DEFAULT_HISTORY_SCROLLBAR_METRICS

  const { clientHeight, scrollHeight, scrollTop } = listEl
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  if (clientHeight <= 0 || maxScrollTop <= 1) return DEFAULT_HISTORY_SCROLLBAR_METRICS

  const trackHeight = Math.max(0, clientHeight - HISTORY_ENTRY_SCROLLBAR_AXIS_PADDING_PX * 2)
  if (trackHeight <= 0) return DEFAULT_HISTORY_SCROLLBAR_METRICS

  const thumbHeight = Math.min(
    trackHeight,
    Math.max(HISTORY_ENTRY_SCROLLBAR_MIN_THUMB_HEIGHT_PX, trackHeight * (clientHeight / scrollHeight)),
  )
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight)
  const thumbTop = maxThumbTop <= 0 ? 0 : (scrollTop / maxScrollTop) * maxThumbTop

  return {
    thumbHeight: roundedCssPixel(thumbHeight),
    thumbTop: roundedCssPixel(thumbTop),
    visible: true,
  }
}

function historyScrollbarMetricsEqual(left: HistoryScrollbarMetrics, right: HistoryScrollbarMetrics): boolean {
  return (
    left.visible === right.visible &&
    Math.abs(left.thumbHeight - right.thumbHeight) < 0.1 &&
    Math.abs(left.thumbTop - right.thumbTop) < 0.1
  )
}

interface TrackGeometry {
  trackTop: number
  thumbHeight: number
  maxThumbTop: number
  maxScrollTop: number
}

/** Measure live geometry from the real DOM so drag/click stay pixel-accurate. */
function readTrackGeometry(listEl: HTMLElement, trackEl: HTMLElement): TrackGeometry {
  const trackRect = trackEl.getBoundingClientRect()
  const thumbEl = trackEl.firstElementChild
  const thumbHeight = thumbEl instanceof HTMLElement ? thumbEl.getBoundingClientRect().height : 0
  return {
    trackTop: trackRect.top,
    thumbHeight,
    maxThumbTop: Math.max(0, trackRect.height - thumbHeight),
    maxScrollTop: Math.max(0, listEl.scrollHeight - listEl.clientHeight),
  }
}

/**
 * Drives the styled overlay scrollbar that mirrors the natively-scrolling
 * history list. Adds what a painted thumb otherwise lacks:
 *   - a draggable thumb,
 *   - click-to-jump on the track,
 *   - browser-like auto-hide (reveal on scroll/hover/drag, fade when idle).
 *
 * Geometry stays in sync via a scroll listener plus a ResizeObserver on the
 * list and its content, so the caller only needs to pass the list ref.
 */
export function useHistoryScrollbar(
  listRef: RefObject<HTMLDivElement | null>,
): HistoryScrollbar {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState(DEFAULT_HISTORY_SCROLLBAR_METRICS)
  const [active, setActive] = useState(false)
  // Exposed (unlike draggingRef) so the thumb can stay at hover width for the
  // whole drag, even after the pointer leaves the rail — like a native bar.
  const [dragging, setDragging] = useState(false)

  // Imperative flags read inside timers/listeners (avoid stale-closure churn).
  const hoveringRef = useRef(false)
  const draggingRef = useRef(false)
  const activeDragRef = useRef<PointerDragHandle | null>(null)
  const retimeHide = useRetimer()

  const scheduleHide = useCallback(() => {
    retimeHide(window.setTimeout(() => {
      if (!hoveringRef.current && !draggingRef.current) setActive(false)
    }, HISTORY_ENTRY_SCROLLBAR_IDLE_HIDE_DELAY_MS))
  }, [retimeHide])

  const reveal = useCallback(() => {
    setActive(true)
    scheduleHide()
  }, [scheduleHide])

  useLayoutEffect(() => {
    const listEl = listRef.current
    if (!listEl) return

    let frameId = 0
    let hasMeasured = false

    function updateScrollbar() {
      frameId = 0
      hasMeasured = true
      const nextMetrics = getHistoryScrollbarMetrics(listEl)
      setMetrics((current) => (
        historyScrollbarMetricsEqual(current, nextMetrics) ? current : nextMetrics
      ))
    }
    function scheduleScrollbarUpdate(
      deferUntilAfterPaint: boolean,
      replacePending = false,
    ) {
      if (frameId !== 0) {
        if (!replacePending) return
        cancelAnimationFrame(frameId)
      }
      if (!deferUntilAfterPaint) {
        frameId = requestAnimationFrame(updateScrollbar)
        return
      }
      frameId = requestAnimationFrame(() => {
        frameId = requestAnimationFrame(() => {
          frameId = requestAnimationFrame(() => {
            frameId = requestAnimationFrame(updateScrollbar)
          })
        })
      })
    }
    function requestScrollbarUpdate() {
      const awaitingInitialMeasurement = !hasMeasured
      scheduleScrollbarUpdate(awaitingInitialMeasurement, awaitingInitialMeasurement)
    }
    function requestUrgentScrollbarUpdate() {
      scheduleScrollbarUpdate(false, true)
    }
    function onScroll() {
      requestUrgentScrollbarUpdate()
      reveal()
    }

    // The scrollbar is inactive and invisible at mount. ResizeObserver
    // guarantees an initial delivery, and the content observation also covers
    // row hydration. Each delivery before the first measurement restarts the
    // defer so an empty-list delivery cannot outrun hydrated rows or their title
    // clamps. Leave the content paint and its following frame untouched before
    // reading geometry. A real scroll bypasses that initial delay so interaction
    // feedback stays responsive.
    listEl.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', requestScrollbarUpdate)

    const resizeObserver = new ResizeObserver(requestScrollbarUpdate)
    resizeObserver.observe(listEl)
    const contentEl = listEl.querySelector<HTMLElement>('.history-entry-list-content')
    if (contentEl) resizeObserver.observe(contentEl)

    return () => {
      if (frameId !== 0) cancelAnimationFrame(frameId)
      listEl.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', requestScrollbarUpdate)
      resizeObserver.disconnect()
    }
  }, [listRef, reveal])

  const onTrackPointerDown = useCallback((event: ReactPointerEvent) => {
    const listEl = listRef.current
    const trackEl = trackRef.current
    if (!listEl || !trackEl) return
    event.preventDefault()

    const { trackTop, thumbHeight, maxThumbTop, maxScrollTop } = readTrackGeometry(listEl, trackEl)
    const desiredThumbTop = clamp(event.clientY - trackTop - thumbHeight / 2, 0, maxThumbTop)
    listEl.scrollTop = maxThumbTop > 0 ? (desiredThumbTop / maxThumbTop) * maxScrollTop : 0
    reveal()
  }, [listRef, reveal])

  const onThumbPointerDown = useCallback((event: ReactPointerEvent) => {
    const listEl = listRef.current
    const trackEl = trackRef.current
    if (!listEl || !trackEl) return
    // Stop the track handler (jump-to-position) from also firing.
    event.preventDefault()
    event.stopPropagation()
    activeDragRef.current?.dispose()

    draggingRef.current = true
    setDragging(true)
    setActive(true)
    retimeHide()

    const { maxThumbTop, maxScrollTop } = readTrackGeometry(listEl, trackEl)
    const startY = event.clientY
    const startScrollTop = listEl.scrollTop

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const deltaScroll = maxThumbTop > 0
        ? ((moveEvent.clientY - startY) / maxThumbTop) * maxScrollTop
        : 0
      listEl.scrollTop = clamp(startScrollTop + deltaScroll, 0, maxScrollTop)
    }
    // The helper has already detached its listeners when either callback runs.
    const finishDrag = () => {
      activeDragRef.current = null
      if (!draggingRef.current) return
      draggingRef.current = false
      setDragging(false)
      scheduleHide()
    }
    activeDragRef.current = startPointerDrag({ onMove, onEnd: finishDrag, onCancel: finishDrag })
  }, [listRef, retimeHide, scheduleHide])

  const onPointerEnter = useCallback(() => {
    hoveringRef.current = true
    setActive(true)
    retimeHide()
  }, [retimeHide])

  const onPointerLeave = useCallback(() => {
    hoveringRef.current = false
    scheduleHide()
  }, [scheduleHide])

  // Clean up any pending fade timer or global drag listeners on unmount.
  useEffect(() => () => {
    draggingRef.current = false
    activeDragRef.current?.dispose()
    retimeHide()
  }, [retimeHide])

  return {
    metrics,
    active,
    dragging,
    trackRef,
    onThumbPointerDown,
    onTrackPointerDown,
    onPointerEnter,
    onPointerLeave,
  }
}
