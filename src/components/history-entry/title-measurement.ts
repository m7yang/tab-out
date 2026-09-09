import type { Dispatch, SetStateAction } from 'react'
import { captureVisibleLineHtml, createExpansionMeasureElement, expandedLineContentOverflows, expansionLineHtmlEquals, expansionLineMarkup, searchExpandedWidth, syncTruncatedTitleFadeEnd, unwrapClampedTitleLines, type ExpansionLineClasses, type TitleLineCaptureGeometry } from '../title-expansion'
import { createSizeChangeObserver, type ObservedElementSize, type SizeChangeObserver } from '../size-change-observer.js'

let historyTitleResizeObserver: SizeChangeObserver | null = null
export const historyTitleMeasuredSizes = new WeakMap<HTMLElement, ObservedElementSize>()
const HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX = 12
const HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX = 8
const HISTORY_ENTRY_EXPANDED_WIDTH_SEARCH_STEPS = 12
const HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX = 1
export const HISTORY_TITLE_CLAMP_WIDTH_TOLERANCE_PX = 0.5
export const HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME = 'history-entry-expanded-lines block min-w-0 max-w-full'
export const HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME = 'history-entry-expanded-line block min-w-0 max-w-full whitespace-nowrap'
export const HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME = 'history-entry-expanded-line history-entry-expanded-line-constrained block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word'
export const HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME = 'history-entry-expanded-line history-entry-expanded-line-tail block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word'

export const DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY: HistoryEntryExpansionGeometry = {
  lineHtml: [],
  maxWidth: 0,
  scrollbarShieldLeft: 0,
  scrollbarShieldWidth: 0,
  titleWidth: 0,
  viewportConstrained: false,
  width: 0,
  y: 'down',
}
export const DEFAULT_HISTORY_ENTRY_SLOT_SIZE: HistoryEntrySlotSize = { height: 0, width: 0 }
export const historyTitleTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: HistoryTitleMetrics) => void
>()

const HISTORY_TITLE_EXPANDED_LAYOUT_CACHE_LIMIT = 240
const historyTitleExpandedLayoutCache = new Map<string, HistoryTitleExpandedLayoutMetrics>()

export type HistoryTitleMetrics = {
  contentWidth: number
  expandedLineHtml: string[]
  expandedTextWidth: number
  expandedViewportConstrained: boolean
  isTruncated: boolean
  visibleLineCount: number
  width: number
}
type HistoryTitleExpandedLayoutMetrics = Omit<HistoryTitleMetrics, 'isTruncated'>
type HistoryTitleGeometryMeasurement = {
  captureGeometry: TitleLineCaptureGeometry
  metrics: HistoryTitleMetrics
}
type HistoryTitleMeasurement = {
  lineHtml: string[]
  metrics: HistoryTitleMetrics
}
const DEFAULT_HISTORY_TITLE_METRICS: HistoryTitleMetrics = {
  contentWidth: 0,
  expandedLineHtml: [],
  expandedTextWidth: 0,
  expandedViewportConstrained: false,
  isTruncated: false,
  visibleLineCount: 1,
  width: 0,
}

export type HistoryEntryExpansionGeometry = {
  lineHtml: string[]
  maxWidth: number
  scrollbarShieldLeft: number
  scrollbarShieldWidth: number
  titleWidth: number
  viewportConstrained: boolean
  width: number
  y: 'down' | 'up'
}

export type HistoryEntrySlotSize = {
  height: number
  width: number
}

export function isHistoryTitleTruncated(titleEl: HTMLElement | null) {
  if (!titleEl) return false
  return (
    titleEl.scrollHeight - titleEl.clientHeight > 1 ||
    titleEl.scrollWidth - titleEl.clientWidth > 1
  )
}

function getHistoryTitleWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0
  return Math.round(titleEl.getBoundingClientRect().width * 100) / 100
}

function getHistoryTitleVisibleLineCount(titleEl: HTMLElement | null) {
  if (!titleEl) return 1

  const styles = window.getComputedStyle(titleEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  const height = titleEl.getBoundingClientRect().height
  if (!lineHeight || !Number.isFinite(lineHeight)) return 1
  return Math.max(1, Math.round(height / lineHeight))
}

function getHistoryTitleContentWidth(titleEl: HTMLElement | null) {
  if (!titleEl) return 0

  const ownerDocument = titleEl.ownerDocument
  if (!ownerDocument.body) return 0

  const styles = window.getComputedStyle(titleEl)
  const clone = titleEl.cloneNode(true) as HTMLElement
  clone.classList.remove('history-entry-title-truncated')
  unwrapClampedTitleLines(clone)
  Object.assign(clone.style, {
    display: 'inline-block',
    font: styles.font,
    left: '0',
    letterSpacing: styles.letterSpacing,
    lineHeight: styles.lineHeight,
    maxHeight: 'none',
    maxWidth: 'none',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    visibility: 'hidden',
    whiteSpace: 'nowrap',
    width: 'max-content',
  })
  clone.style.setProperty('mask-image', 'none')
  ownerDocument.body.append(clone)
  const width = Math.round(clone.getBoundingClientRect().width * 100) / 100
  clone.remove()
  return width
}

function getHistoryTitleExpandedLineHtml(titleEl: HTMLElement | null) {
  if (!titleEl || typeof document === 'undefined') return []
  return captureVisibleLineHtml(titleEl, getHistoryTitleVisibleLineCount(titleEl))
}

const HISTORY_ENTRY_EXPANSION_LINE_CLASSES: ExpansionLineClasses = {
  wrapper: HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME,
  line: HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME,
  constrainedLine: HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME,
  tailLine: HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME,
}

function historyTitleExpandedLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  return expansionLineMarkup(lineHtml, HISTORY_ENTRY_EXPANSION_LINE_CLASSES, viewportConstrained)
}

function historyTitleExpandedMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number,
) {
  measureEl.style.width = `${Math.max(1, width)}px`
  const styles = window.getComputedStyle(measureEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (!lineHeight || !Number.isFinite(lineHeight)) return true
  const fixedLineOverflows = measureEl.querySelectorAll<HTMLElement>('.history-entry-expanded-line:not(.history-entry-expanded-line-tail)')
    .values()
    .some((line) => expandedLineContentOverflows(line, HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX))
  return !fixedLineOverflows && measureEl.getBoundingClientRect().height <=
    targetLineCount * lineHeight + HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX
}

function createHistoryTitleExpandedMeasureElement(titleEl: HTMLElement, lineHtml: readonly string[]) {
  return createExpansionMeasureElement(titleEl, {
    className: 'history-entry-title-expansion-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-tab-live [font-family:inherit] [hyphenate-character:\'\'] wrap-break-word',
    markup: lineHtml.length > 0 ? historyTitleExpandedLineMarkup(lineHtml) : titleEl.innerHTML,
  })
}

function getHistoryTitleExpandedTextWidth(
  titleEl: HTMLElement | null,
  lineHtml: readonly string[],
  contentWidth: number,
  availableContentWidth: number,
  visibleLineCount: number,
  visibleWidth: number,
) {
  if (!titleEl) return { viewportConstrained: false, width: 0 }

  const availableWidth = Math.max(1, availableContentWidth)
  const naturalWidth = Math.max(1, contentWidth || visibleWidth)
  const maxContentWidth = Math.min(availableWidth, naturalWidth)
  const targetLineCount = Math.max(1, visibleLineCount || 1)

  const measureEl = createHistoryTitleExpandedMeasureElement(titleEl, lineHtml)
  if (!measureEl) return { viewportConstrained: false, width: Math.round(Math.min(availableWidth, Math.max(visibleWidth, naturalWidth / targetLineCount)) * 100) / 100 }

  try {
    const lowerBound = Math.min(Math.max(1, visibleWidth), maxContentWidth)
    return searchExpandedWidth({
      lowerBound,
      maxContentWidth,
      steps: HISTORY_ENTRY_EXPANDED_WIDTH_SEARCH_STEPS,
      fits: (width) => historyTitleExpandedMeasureFitsLineCount(measureEl, width, targetLineCount),
    })
  } finally {
    measureEl.remove()
  }
}

export function sameHistoryTitleMetrics(a: HistoryTitleMetrics, b: HistoryTitleMetrics) {
  return (
    Math.abs(a.contentWidth - b.contentWidth) < 0.1 &&
    expansionLineHtmlEquals(a.expandedLineHtml, b.expandedLineHtml) &&
    Math.abs(a.expandedTextWidth - b.expandedTextWidth) < 0.1 &&
    a.expandedViewportConstrained === b.expandedViewportConstrained &&
    a.isTruncated === b.isTruncated &&
    a.visibleLineCount === b.visibleLineCount &&
    Math.abs(a.width - b.width) < 0.1
  )
}

function rememberHistoryTitleExpandedLayout(key: string, metrics: HistoryTitleExpandedLayoutMetrics) {
  historyTitleExpandedLayoutCache.set(key, metrics)
  if (historyTitleExpandedLayoutCache.size <= HISTORY_TITLE_EXPANDED_LAYOUT_CACHE_LIMIT) return
  const oldestKey = historyTitleExpandedLayoutCache.keys().next().value
  if (oldestKey) historyTitleExpandedLayoutCache.delete(oldestKey)
}

function historyTitleExpandedLayoutCacheKey(titleEl: HTMLElement, availableContentWidth: number) {
  const win = titleEl.ownerDocument.defaultView
  const styles = win?.getComputedStyle(titleEl)
  const rect = titleEl.getBoundingClientRect()
  return JSON.stringify([
    titleEl.innerHTML,
    Math.round(rect.left * 100) / 100,
    Math.round(rect.top * 100) / 100,
    getHistoryTitleWidth(titleEl),
    getHistoryTitleVisibleLineCount(titleEl),
    Math.round(availableContentWidth * 100) / 100,
    styles?.font || '',
    styles?.letterSpacing || '',
    styles?.lineHeight || '',
    win?.devicePixelRatio || 1,
  ])
}

function readHistoryTitleGeometry(titleEl: HTMLElement): HistoryTitleGeometryMeasurement {
  const isTruncated = isHistoryTitleTruncated(titleEl)
  const rect = titleEl.getBoundingClientRect()
  const styles = window.getComputedStyle(titleEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  const visibleLineCount = !lineHeight || !Number.isFinite(lineHeight)
    ? 1
    : Math.max(1, Math.round(rect.height / lineHeight))
  const width = Math.round(rect.width * 100) / 100
  historyTitleMeasuredSizes.set(titleEl, {
    height: Math.round(rect.height * 100) / 100,
    width,
  })
  return {
    captureGeometry: {
      elementRect: rect,
      lineHeight,
    },
    metrics: {
      contentWidth: 0,
      expandedLineHtml: [],
      expandedTextWidth: 0,
      expandedViewportConstrained: false,
      isTruncated,
      visibleLineCount,
      width,
    },
  }
}

function readHistoryTitleMetrics(titleEl: HTMLElement): HistoryTitleMetrics {
  return readHistoryTitleGeometry(titleEl).metrics
}

function readHistoryTitleMeasurement(titleEl: HTMLElement): HistoryTitleMeasurement {
  const { captureGeometry, metrics } = readHistoryTitleGeometry(titleEl)
  const lineHtml = metrics.isTruncated && metrics.visibleLineCount > 1
    ? captureVisibleLineHtml(titleEl, metrics.visibleLineCount, captureGeometry)
    : []
  return { lineHtml, metrics }
}

type HistoryTitleMeasurementJob = {
  apply: (measurement: HistoryTitleMeasurement) => void
  titleEl: HTMLElement
}
const pendingHistoryTitleMeasurementJobs = new Map<HTMLElement, HistoryTitleMeasurementJob>()
let historyTitleMeasurementFlushQueued = false

export function flushHistoryTitleMeasurementJobs() {
  historyTitleMeasurementFlushQueued = false
  const jobs = pendingHistoryTitleMeasurementJobs.values().toArray()
  pendingHistoryTitleMeasurementJobs.clear()
  // Complete every natural-box and Range read before the first truncation
  // class or captured-line state write. Interleaving those phases makes each
  // later title repay style/layout work triggered by the previous title.
  const measuredJobs = jobs.flatMap((job) => (
    job.titleEl.isConnected
      ? [{ job, measurement: readHistoryTitleMeasurement(job.titleEl) }]
      : []
  ))
  if (measuredJobs.length === 0) return
  for (const { job, measurement } of measuredJobs) job.apply(measurement)
}

export function scheduleHistoryTitleMeasurement(job: HistoryTitleMeasurementJob) {
  pendingHistoryTitleMeasurementJobs.set(job.titleEl, job)
  if (!historyTitleMeasurementFlushQueued) {
    historyTitleMeasurementFlushQueued = true
    queueMicrotask(flushHistoryTitleMeasurementJobs)
  }
  return () => {
    if (pendingHistoryTitleMeasurementJobs.get(job.titleEl) === job) {
      pendingHistoryTitleMeasurementJobs.delete(job.titleEl)
    }
  }
}

export function syncHistoryTitleFade(
  titleEl: HTMLElement | null,
  syncFadeEnd = true,
  measuredMetrics?: HistoryTitleMetrics,
) {
  if (!titleEl) return { contentWidth: 0, expandedLineHtml: [], expandedTextWidth: 0, expandedViewportConstrained: false, isTruncated: false, visibleLineCount: 1, width: 0 }

  const metrics = measuredMetrics ?? readHistoryTitleMetrics(titleEl)
  titleEl.classList.toggle('history-entry-title-truncated', metrics.isTruncated)
  if (syncFadeEnd) syncTruncatedTitleFadeEnd(titleEl, metrics.isTruncated)
  historyTitleTruncationCallbacks.get(titleEl)?.(metrics)
  return metrics
}

function measureHistoryTitleExpandedLayout(titleEl: HTMLElement | null, availableContentWidth = Number.POSITIVE_INFINITY): HistoryTitleMetrics {
  if (!titleEl) return { contentWidth: 0, expandedLineHtml: [], expandedTextWidth: 0, expandedViewportConstrained: false, isTruncated: false, visibleLineCount: 1, width: 0 }

  const cacheKey = historyTitleExpandedLayoutCacheKey(titleEl, availableContentWidth)
  const cachedLayout = historyTitleExpandedLayoutCache.get(cacheKey)
  const isTruncated = isHistoryTitleTruncated(titleEl)
  if (cachedLayout) return { ...cachedLayout, isTruncated }

  const contentWidth = getHistoryTitleContentWidth(titleEl)
  const visibleLineCount = getHistoryTitleVisibleLineCount(titleEl)
  const width = getHistoryTitleWidth(titleEl)
  const expandedLineHtml = getHistoryTitleExpandedLineHtml(titleEl)
  const expandedMetrics = getHistoryTitleExpandedTextWidth(titleEl, expandedLineHtml, contentWidth, availableContentWidth, visibleLineCount, width)
  const layout = {
    contentWidth,
    expandedLineHtml,
    expandedTextWidth: expandedMetrics.width,
    expandedViewportConstrained: expandedMetrics.viewportConstrained,
    visibleLineCount,
    width,
  }
  rememberHistoryTitleExpandedLayout(cacheKey, layout)
  return { ...layout, isTruncated }
}

export function updateTitleTruncation(
  titleEl: HTMLElement | null,
  setTitleMetrics: Dispatch<SetStateAction<HistoryTitleMetrics>>,
) {
  const metrics = syncHistoryTitleFade(titleEl)
  setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
}

function getHistoryEntryExpansionHorizontalInset(entryEl: HTMLElement, titleEl: HTMLElement) {
  const entryRect = entryEl.getBoundingClientRect()
  const titleRect = titleEl.getBoundingClientRect()
  return Math.max(0, titleRect.left - entryRect.left) + Math.max(0, entryRect.right - titleRect.right)
}

export function getHistoryEntryExpansionGeometry(entryEl: HTMLElement | null, titleEl: HTMLElement | null): HistoryEntryExpansionGeometry {
  if (!entryEl || !titleEl || typeof window === 'undefined') return DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY

  const rect = entryEl.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const roomToRight = Math.max(0, viewportWidth - rect.left - HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomBelow = Math.max(0, viewportHeight - rect.top - HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomAbove = Math.max(0, rect.bottom - HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX)
  const maxWidth = Math.max(rect.width, roomToRight)
  const horizontalInset = getHistoryEntryExpansionHorizontalInset(entryEl, titleEl)
  const maxContentWidth = Math.max(1, maxWidth - horizontalInset)
  const metrics = measureHistoryTitleExpandedLayout(titleEl, maxContentWidth)
  const expandedContentWidth = Math.min(
    maxContentWidth,
    Math.max(metrics.width, metrics.expandedTextWidth + HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX),
  )
  const width = Math.min(maxWidth, Math.max(rect.width, horizontalInset + expandedContentWidth))
  const scrollbarTrack = entryEl.closest('.tab-history-panel')?.querySelector<HTMLElement>('.history-entry-scrollbar-track')
  const scrollbarRect = scrollbarTrack?.getBoundingClientRect()
  const scrollbarOverlapLeft = scrollbarRect ? Math.max(rect.left, scrollbarRect.left) : 0
  const scrollbarOverlapRight = scrollbarRect ? Math.min(rect.left + width, scrollbarRect.right) : 0

  return {
    lineHtml: metrics.expandedLineHtml,
    maxWidth,
    scrollbarShieldLeft: Math.max(0, scrollbarOverlapLeft - rect.left),
    scrollbarShieldWidth: Math.max(0, scrollbarOverlapRight - scrollbarOverlapLeft),
    titleWidth: expandedContentWidth,
    viewportConstrained: metrics.expandedViewportConstrained,
    width,
    y: roomBelow >= rect.height * 2 || roomBelow >= roomAbove ? 'down' : 'up',
  }
}

export function roundedHistoryEntrySlotSize(element: HTMLElement | null): HistoryEntrySlotSize {
  if (!element) return DEFAULT_HISTORY_ENTRY_SLOT_SIZE
  const rect = element.getBoundingClientRect()
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
  }
}

export function historyEntrySlotSizeEqual(left: HistoryEntrySlotSize, right: HistoryEntrySlotSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

export function historyEntryExpansionGeometryEqual(left: HistoryEntryExpansionGeometry, right: HistoryEntryExpansionGeometry) {
  return (
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml) &&
    left.y === right.y &&
    left.viewportConstrained === right.viewportConstrained &&
    Math.abs(left.maxWidth - right.maxWidth) < 0.1 &&
    Math.abs(left.scrollbarShieldLeft - right.scrollbarShieldLeft) < 0.1 &&
    Math.abs(left.scrollbarShieldWidth - right.scrollbarShieldWidth) < 0.1 &&
    Math.abs(left.titleWidth - right.titleWidth) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

export function getHistoryTitleResizeObserver() {
  historyTitleResizeObserver ??= createSizeChangeObserver(syncHistoryTitleFade)
  return historyTitleResizeObserver
}

export type HistoryTitleClamp = {
  key: string
  lineHtml: string[]
  width: number
}
export type HistoryTitleLayoutState = {
  clamp: HistoryTitleClamp | null
  metrics: HistoryTitleMetrics
}
export const DEFAULT_HISTORY_TITLE_LAYOUT_STATE: HistoryTitleLayoutState = {
  clamp: null,
  metrics: DEFAULT_HISTORY_TITLE_METRICS,
}

export function historyTitleClampEqual(left: HistoryTitleClamp | null, right: HistoryTitleClamp | null) {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.key === right.key &&
    Math.abs(left.width - right.width) < 0.1 &&
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml)
  )
}
