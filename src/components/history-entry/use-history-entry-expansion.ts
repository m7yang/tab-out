import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, PointerEvent, RefObject, SetStateAction } from 'react'
import { createTitleExpansionLane, syncClampedTitleFadeEnd, syncTruncatedTitleFadeEnd, useTitleExpansionController } from '../title-expansion'
import { isOutsidePressInsideElement } from '../context-menu-outside-press'
import type { ContextMenuChangeEventDetails } from '../context-menu-outside-press'
import { subscribeFontMetricsInvalidation } from '../font-metrics-invalidation.js'
import {
  DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY,
  DEFAULT_HISTORY_ENTRY_SLOT_SIZE,
  DEFAULT_HISTORY_TITLE_LAYOUT_STATE,
  HISTORY_TITLE_CLAMP_WIDTH_TOLERANCE_PX,
  getHistoryEntryExpansionGeometry,
  getHistoryTitleResizeObserver,
  historyEntryExpansionGeometryEqual,
  historyEntrySlotSizeEqual,
  historyTitleClampEqual,
  historyTitleMeasuredSizes,
  historyTitleTruncationCallbacks,
  isHistoryTitleTruncated,
  roundedHistoryEntrySlotSize,
  sameHistoryTitleMetrics,
  scheduleHistoryTitleMeasurement,
  syncHistoryTitleFade,
  updateTitleTruncation,
} from './title-measurement.js'
import type { HistoryEntryExpansionGeometry, HistoryEntrySlotSize, HistoryTitleClamp, HistoryTitleMetrics } from './title-measurement.js'

const historyEntryExpansionLane = createTitleExpansionLane()

type HistoryEntryExpansion = {
  entryExpansionId: string
  entrySlotRef: RefObject<HTMLDivElement | null>
  entryRef: RefObject<HTMLDivElement | null>
  titleRef: RefObject<HTMLSpanElement | null>
  titleMetrics: HistoryTitleMetrics
  titleClamp: HistoryTitleClamp | null
  titleExpanded: boolean
  entrySlotSize: HistoryEntrySlotSize
  entryExpansionGeometry: HistoryEntryExpansionGeometry
  onHistoryEntryPointerEnter: () => void
  onHistoryEntryPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onHistoryEntryPointerLeave: (e: PointerEvent<HTMLDivElement>) => void
  onHistoryEntryFocus: (e: FocusEvent<HTMLDivElement>) => void
  onHistoryEntryBlur: (e: FocusEvent<HTMLDivElement>) => void
  onHistoryEntryContextMenuOpenChange: (open: boolean, details: ContextMenuChangeEventDetails) => void
}

export function useHistoryEntryExpansion(contextMenuOpenRef: RefObject<boolean>, titleClampKey: string): HistoryEntryExpansion {
  const entryExpansionId = useId()
  const entrySlotRef = useRef<HTMLDivElement | null>(null)
  const entryRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const titleExpandedRef = useRef(false)
  const titleMeasurementRef = useRef<{
    element: HTMLElement
    key: string
    metrics: HistoryTitleMetrics
  } | null>(null)
  const [titleLayout, setTitleLayout] = useState(DEFAULT_HISTORY_TITLE_LAYOUT_STATE)
  const titleMetrics = titleLayout.metrics
  const storedTitleClamp = titleLayout.clamp
  const titleClamp =
    storedTitleClamp?.key === titleClampKey &&
    Math.abs(storedTitleClamp.width - titleMetrics.width) < HISTORY_TITLE_CLAMP_WIDTH_TOLERANCE_PX
      ? storedTitleClamp
      : null
  function setTitleMetrics(update: SetStateAction<HistoryTitleMetrics>) {
    setTitleLayout((current) => {
      const nextMetrics = typeof update === 'function' ? update(current.metrics) : update
      return sameHistoryTitleMetrics(current.metrics, nextMetrics)
        ? current
        : { ...current, metrics: nextMetrics }
    })
  }
  const [titleExpanded, setTitleExpandedState] = useState(false)
  const [entrySlotSize, setEntrySlotSize] = useState(DEFAULT_HISTORY_ENTRY_SLOT_SIZE)
  const [entryExpansionGeometry, setEntryExpansionGeometry] = useState(DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY)

  function setTitleExpanded(nextExpanded: boolean) {
    titleExpandedRef.current = nextExpanded
    setTitleExpandedState(nextExpanded)
  }

  // An open row menu owns the expansion as a controller hold; history rows
  // have no keyboard-focus owner (unlike Page Chips), so blur and pointer
  // departure close unless the menu hold vetoes inside the controller.
  // contextMenuOpenRef stays for the hover-preview retention guards only.
  const menuHoldRef = useRef<(() => void) | null>(null)
  const titleExpansionController = useTitleExpansionController({
    id: entryExpansionId,
    lane: historyEntryExpansionLane,
    closeDelayMs: 0,
    onExpandedChange: setTitleExpanded,
  })

  function updateHistoryEntryExpansionMeasurements() {
    const entryEl = entryRef.current
    const titleEl = titleRef.current
    const nextSize = roundedHistoryEntrySlotSize(entryEl)
    const nextGeometry = getHistoryEntryExpansionGeometry(entryEl, titleEl)
    setEntrySlotSize((current) => historyEntrySlotSizeEqual(current, nextSize) ? current : nextSize)
    setEntryExpansionGeometry((current) => historyEntryExpansionGeometryEqual(current, nextGeometry) ? current : nextGeometry)
  }
  // Truncated titles swap to captured-line rows (clampedTitleLineNodes) so the
  // tail runs to the box edge under the fade. The capture is only valid for the
  // content and width it was measured at: on mismatch, drop it first — that
  // commit restores the natural wrapped rendering, and the re-run of this
  // effect measures and re-captures from that natural layout before paint.
  // While the swap is live the tail's horizontal overflow keeps the element's
  // truncation detection true, so the mask class cannot oscillate.
  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl || titleExpandedRef.current) return

    if (titleClamp) {
      titleEl.classList.add('history-entry-title-truncated')
      syncClampedTitleFadeEnd(titleEl, titleClamp.width)
      return
    }

    const previousMeasurement = titleMeasurementRef.current
    if (
      previousMeasurement?.element === titleEl &&
      previousMeasurement.key === titleClampKey &&
      sameHistoryTitleMetrics(previousMeasurement.metrics, titleMetrics)
    ) {
      return
    }

    // A captured clamp fades at its known box edge. Defer the glyph-range read
    // until capture fails so successful clamps do not measure an unused anchor.
    return scheduleHistoryTitleMeasurement({
      titleEl,
      apply({ lineHtml, metrics: measuredMetrics }) {
        if (titleRef.current !== titleEl || titleExpandedRef.current) return
        const metrics = syncHistoryTitleFade(titleEl, false, measuredMetrics)
        titleMeasurementRef.current = {
          element: titleEl,
          key: titleClampKey,
          metrics,
        }
        let nextClamp: HistoryTitleClamp | null = null
        if (metrics.isTruncated && lineHtml.length > 1) {
          nextClamp = { key: titleClampKey, lineHtml, width: metrics.width }
        }
        if (nextClamp) {
          syncClampedTitleFadeEnd(titleEl, nextClamp.width)
        } else {
          syncTruncatedTitleFadeEnd(titleEl, metrics.isTruncated)
        }
        setTitleLayout((current) => (
          sameHistoryTitleMetrics(current.metrics, metrics) &&
          historyTitleClampEqual(current.clamp, nextClamp)
            ? current
            : { clamp: nextClamp, metrics }
        ))
      },
    })
    // Resize-observer metrics carry width changes back through titleMetrics,
    // which invalidates the captured rows without re-reading unchanged titles.
  }, [titleClamp, titleClampKey, titleExpanded, titleMetrics])

  useEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    let disposed = false
    const observer = getHistoryTitleResizeObserver()
    historyTitleTruncationCallbacks.set(titleEl, (metrics) => {
      if (disposed) return
      if (titleExpandedRef.current) return
      setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
    })
    observer.observe(titleEl, historyTitleMeasuredSizes.get(titleEl))

    const onFontsDone = () => {
      if (disposed) return
      if (titleExpandedRef.current) return
      titleMeasurementRef.current = null
      setTitleLayout((current) => current.clamp ? { ...current, clamp: null } : current)
      updateTitleTruncation(titleEl, setTitleMetrics)
    }
    const unsubscribeFontMetrics = subscribeFontMetricsInvalidation(onFontsDone)

    return () => {
      disposed = true
      observer.unobserve(titleEl)
      historyTitleTruncationCallbacks.delete(titleEl)
      unsubscribeFontMetrics()
    }
  }, [])

  function openTitleExpansion() {
    const titleEl = titleRef.current
    const measuredTruncated = titleMetrics.isTruncated || titleClamp !== null
    // A captured clamp can land its final glyph exactly on the title edge, so
    // its replacement DOM no longer reports scroll overflow even though the
    // natural title was measured as truncated and still renders a fade.
    if (!measuredTruncated && !isHistoryTitleTruncated(titleEl)) return
    // The collapsed title observer owns truncation state. Slot and expansion
    // geometry are interaction-only work and should not block dashboard startup.
    if (!measuredTruncated) updateTitleTruncation(titleEl, setTitleMetrics)
    updateHistoryEntryExpansionMeasurements()
    titleExpansionController.open()
  }

  function closeTitleExpansion() {
    titleExpansionController.close({ delayed: false })
  }

  useEffect(() => {
    if (!titleExpanded) return
    const closeNow = () => {
      titleExpansionController.closeNow()
    }
    const closeOnPointerMove = (event: globalThis.PointerEvent) => {
      const slotRect = entrySlotRef.current?.getBoundingClientRect()
      if (!slotRect) return
      const insideOriginalSlot =
        event.clientX >= slotRect.left &&
        event.clientX <= slotRect.right &&
        event.clientY >= slotRect.top &&
        event.clientY <= slotRect.bottom
      // Leaving the original entry slot closes immediately, vetoed inside
      // the controller while the row menu holds the expansion.
      if (!insideOriginalSlot) titleExpansionController.close({ delayed: false })
    }
    const closeOnVisibilityChange = () => {
      if (document.hidden) closeNow()
    }
    window.addEventListener('blur', closeNow)
    window.addEventListener('pointermove', closeOnPointerMove, true)
    document.addEventListener('visibilitychange', closeOnVisibilityChange)
    return () => {
      window.removeEventListener('blur', closeNow)
      window.removeEventListener('pointermove', closeOnPointerMove, true)
      document.removeEventListener('visibilitychange', closeOnVisibilityChange)
    }
  }, [titleExpansionController, titleExpanded])

  // Unlike PageChip (which force-opens the title expansion when its menu opens),
  // history rows only keep an already-open expansion from collapsing while the
  // menu is open — they don't force-expand on right-click. The hover preview is
  // driven separately by the row's onMouseEnter/onMouseLeave.
  function onHistoryEntryContextMenuOpenChange(open: boolean, details: ContextMenuChangeEventDetails) {
    contextMenuOpenRef.current = open
    menuHoldRef.current?.()
    menuHoldRef.current = open ? titleExpansionController.hold('context-menu') : null
    if (!open && !isOutsidePressInsideElement(details, entryRef.current)) closeTitleExpansion()
  }

  function onHistoryEntryPointerEnter() {
    openTitleExpansion()
  }

  function onHistoryEntryPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (titleExpandedRef.current) return
    const slotRect = entrySlotRef.current?.getBoundingClientRect()
    if (
      slotRect &&
      (e.clientX < slotRect.left ||
        e.clientX > slotRect.right ||
        e.clientY < slotRect.top ||
        e.clientY > slotRect.bottom)
    ) {
      return
    }
    openTitleExpansion()
  }

  function onHistoryEntryPointerLeave(e: PointerEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeTitleExpansion()
  }

  function onHistoryEntryFocus(e: FocusEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) openTitleExpansion()
  }

  function onHistoryEntryBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeTitleExpansion()
  }

  return {
    entryExpansionId,
    entrySlotRef,
    entryRef,
    titleRef,
    titleMetrics,
    titleClamp,
    titleExpanded,
    entrySlotSize,
    entryExpansionGeometry,
    onHistoryEntryPointerEnter,
    onHistoryEntryPointerMove,
    onHistoryEntryPointerLeave,
    onHistoryEntryFocus,
    onHistoryEntryBlur,
    onHistoryEntryContextMenuOpenChange,
  }
}
