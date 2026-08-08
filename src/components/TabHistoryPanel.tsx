import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode, RefObject, SetStateAction } from 'react'
import { EyeOff, X } from 'lucide-react'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntryResult, historyEntryFromClosedTab, historyEntryFromWorkingSetItem } from '../extension/tab-history.js'
import { audioStateForTab, nextMutedForAudioState } from '../extension/tab-audio.js'
import { duplicateTabTarget, reloadTabTarget, setHistoryEntryMuted, suspendHistoryEntry } from '../extension/tab-actions'
import { restoreClosedTab } from '../extension/closed-tab-actions.js'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import { closedGhostDismissalKey, dismissClosedGhost, restoreClosedGhost, subscribeClosedGhostDismissals, type ClosedGhostDismissals } from '../extension/closed-ghost-dismissals.js'
import { focusWorkingSetItemResult } from '../extension/working-set-client.js'
import { tabFocusResultToastMessage, type ExistingTabFocusResult } from '../extension/tab-focus.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../extension/page-target.js'
import { markClosure } from '../extension/undo.js'
import { showToast } from '../extension/toast.js'
import { chipActivationMode, performDashboardItemActivation, shouldSuppressSelectionForGesture } from '../extension/tab-activation.js'
import { savePageTarget, removeSavedPageTarget } from '../extension/saved-page-actions.js'
import { historyEntrySaveTarget, historyEntrySaved, historyEntrySavedPageKey, isHistoryEntrySaveEligible } from '../extension/history-saved-page.js'
import { PageChipContextMenu } from './PageChipContextMenu'
import type { PageChipContextMenuTriggerElement } from './PageChipContextMenu'
import { DefaultFavicon } from './DefaultFavicon'
import { FaviconImage } from './FaviconImage'
import { FAVICON_DIM_CLASS_NAME } from './liveness-dim'
import { TabAudioButton } from './TabAudioButton'
import { TabLoadingIndicator } from './TabLoadingIndicator'
import { createBionicTitleTextRenderer } from './bionic-title-text'
import { highlightTermsForFilter, highlightedTextNodes } from './filter-highlight-text'
import { captureVisibleLineHtml, clampedTitleLineNodes, createExpansionMeasureElement, createTitleExpansionLane, expandedLineContentOverflows, expansionLineHtmlEquals, expansionLineMarkup, expansionLineNodesFromHtml, searchExpandedWidth, syncClampedTitleFadeEnd, syncTruncatedTitleFadeEnd, unwrapClampedTitleLines, useTitleExpansionController, type ExpansionLineClasses, type TitleLineCaptureGeometry } from './title-expansion'
import { cn } from '@/lib/utils'
import type { CSSVariableProperties } from '@/lib/css-properties'
import type { HoverUrlChangeHandler, HoverUrlSource, SnapshotChangeHandler, TabHistorySnapshot, TabsChangeHandler } from './types'
import type { RetainedPageSurfaceMatch, TabHistoryEntry, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import { useHistoryPanelRows, type HistoryPanelRow } from '../hooks/useHistoryPanelRows.js'
import { useHistoryScrollbar, type HistoryScrollbar } from '../hooks/useHistoryScrollbar.js'
import { useDashboardActions, useHoverStateSelector } from './DashboardInteractionContext'
import { startLayoutRemovalAnimation } from './LayoutRemovalAnimation.js'
import { animateHistoryEntryMoves, snapshotHistoryEntryPositions, waitForHistoryEntryMoves } from '../extension/history-entry-move-animation.js'
import { createSizeChangeObserver, type ObservedElementSize, type SizeChangeObserver } from './size-change-observer.js'
import { subscribeFontMetricsInvalidation } from './font-metrics-invalidation.js'

let historyTitleResizeObserver: SizeChangeObserver | null = null
const historyTitleMeasuredSizes = new WeakMap<HTMLElement, ObservedElementSize>()
const HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX = 12
const HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX = 8
const HISTORY_ENTRY_EXPANDED_WIDTH_SEARCH_STEPS = 12
const HISTORY_ENTRY_EXPANDED_LINE_TOLERANCE_PX = 1
const HISTORY_TITLE_CLAMP_WIDTH_TOLERANCE_PX = 0.5
const HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME = 'history-entry-expanded-lines block min-w-0 max-w-full'
const HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME = 'history-entry-expanded-line block min-w-0 max-w-full whitespace-nowrap'
const HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME = 'history-entry-expanded-line history-entry-expanded-line-constrained block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word'
const HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME = 'history-entry-expanded-line history-entry-expanded-line-tail block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word'
const HISTORY_ENTRY_CLICKABLE_INTERACTION_BG = 'color-mix(in srgb, var(--card-bg) 90%, var(--color-neutral-600) 10%)'
const HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG = 'color-mix(in srgb, var(--card-bg) 96.5%, var(--color-neutral-600) 3.5%)'
const HISTORY_ENTRY_ACTIVE_OTHER_REST_BG = 'color-mix(in srgb, var(--card-bg) 92.5%, var(--color-neutral-600) 7.5%)'
const HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_BG = 'color-mix(in srgb, var(--card-bg) 84%, var(--color-neutral-600) 16%)'
const HISTORY_ENTRY_INTERACTION_CLASSES = 'group-hover/history-row:bg-(--history-entry-interaction-bg) focus-within:bg-(--history-entry-interaction-bg) [&.history-entry-expanded-open]:bg-(--history-entry-interaction-bg) [&[data-context-menu-open]]:bg-(--history-entry-interaction-bg) group-hover/history-row:after:opacity-100 [&.history-entry-expanded-open]:after:opacity-100 [&[data-context-menu-open]]:after:opacity-100'
// Every hoverable row answers interaction with a 1px outline beside the
// fill (chip-trim's hover-line recipe), across the same interaction states
// the fill responds to. Focus keeps the amber ring instead. The outline
// color rides a CSS var (set in entryBaseStyle) exactly like the chips'
// --chip-hover-border — an arbitrary color-mix() class does not survive
// Tailwind's extractor: closed rows (dead stack rows and recently-closed
// ghosts) match closed-saved chips at 22% (their faint fill leaves the
// line carrying the signal); open rows (2026-07-15) draw the quiet
// interaction-fill rim instead — the same 10% mix as their clickable fill, laid
// once more at the edge — because the darkened fill already carries the
// open-hover emphasis.
const HISTORY_ENTRY_HOVER_OUTLINE_CLASSES = 'group-hover/history-row:outline group-hover/history-row:outline-1 group-hover/history-row:-outline-offset-1 group-hover/history-row:outline-(--history-entry-hover-border) [&.history-entry-expanded-open]:outline [&.history-entry-expanded-open]:outline-1 [&.history-entry-expanded-open]:-outline-offset-1 [&.history-entry-expanded-open]:outline-(--history-entry-hover-border) [&[data-context-menu-open]]:outline [&[data-context-menu-open]]:outline-1 [&[data-context-menu-open]]:-outline-offset-1 [&[data-context-menu-open]]:outline-(--history-entry-hover-border)'
const HISTORY_ENTRY_CLOSED_HOVER_BORDER = 'color-mix(in srgb, var(--color-neutral-600) 22%, transparent)'
const HISTORY_ENTRY_OPEN_HOVER_BORDER = 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)'
const HISTORY_ENTRY_CLICKABLE_INTERACTION_CLASSES = `${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`
const HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_CLASSES = HISTORY_ENTRY_INTERACTION_CLASSES
const HISTORY_ENTRY_CLOSED_INTERACTION_CLASSES = `${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`
const HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES = `bg-(--history-entry-rest-bg) text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.04)] ${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`
const DEFAULT_HISTORY_ENTRY_EXPANSION_GEOMETRY: HistoryEntryExpansionGeometry = {
  lineHtml: [],
  maxWidth: 0,
  scrollbarShieldLeft: 0,
  scrollbarShieldWidth: 0,
  titleWidth: 0,
  viewportConstrained: false,
  width: 0,
  y: 'down'
}
const DEFAULT_HISTORY_ENTRY_SLOT_SIZE: HistoryEntrySlotSize = { height: 0, width: 0 }
const historyTitleTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: HistoryTitleMetrics) => void
>()
const EMPTY_HIGHLIGHT_TERMS: readonly string[] = []
const EMPTY_CLOSED_TABS: readonly ClosedTabEntry[] = []
const EMPTY_RETAINED_PAGE_SURFACE_MATCHES: readonly RetainedPageSurfaceMatch[] = []
const HISTORY_TITLE_EXPANDED_LAYOUT_CACHE_LIMIT = 240
const historyTitleExpandedLayoutCache = new Map<string, HistoryTitleExpandedLayoutMetrics>()
const historyEntryExpansionLane = createTitleExpansionLane()

type HistoryTitleMetrics = {
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
  width: 0
}

type HistoryEntryExpansionGeometry = {
  lineHtml: string[]
  maxWidth: number
  scrollbarShieldLeft: number
  scrollbarShieldWidth: number
  titleWidth: number
  viewportConstrained: boolean
  width: number
  y: 'down' | 'up'
}

type HistoryEntrySlotSize = {
  height: number
  width: number
}

type HistoryEntryKind = 'stack' | 'open-ghost' | 'closed-ghost'

type StopPropagationEvent = { stopPropagation: () => void }

type VisibleHistoryLayoutSnapshot = {
  filter: string
  positions: ReturnType<typeof snapshotHistoryEntryPositions>
  root: HTMLElement
  width: number
}

interface HistoryEntryProps {
  entry: TabHistoryEntry
  kind: HistoryEntryKind
  layoutKey: string
  indexLabel: ReactNode
  workingSetItem?: WorkingSetItem | null | undefined
  closedTab?: ClosedTabEntry | null | undefined
  savedKeys?: ReadonlySet<string> | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  highlightTerms?: readonly string[] | undefined
  onSnapshotChange?: SnapshotChangeHandler | undefined
  onHistoryLayoutSettled?: (() => void) | undefined
  onHoverUrlChange?: HoverUrlChangeHandler | undefined
  onTabsChange?: TabsChangeHandler | undefined
  onForgetClosedGhost?: ((closed: ClosedTabEntry) => void) | undefined
}

interface TabHistoryPanelProps {
  snapshot: TabHistorySnapshot | null
  workingSet?: WorkingSetSnapshot | null | undefined
  closedTabs?: readonly ClosedTabEntry[] | undefined
  dismissedClosedGhosts?: ClosedGhostDismissals | null | undefined
  filter?: string | undefined
  savedKeys?: readonly string[] | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  onSnapshotChange?: SnapshotChangeHandler | undefined
  onTabsChange?: TabsChangeHandler | undefined
}

function isHistoryTitleTruncated(titleEl: HTMLElement | null) {
  if (!titleEl) return false
  return (
    titleEl.scrollHeight - titleEl.clientHeight > 1 ||
    titleEl.scrollWidth - titleEl.clientWidth > 1
  )
}

function startHistoryEntryRemoval(row: Element | null | undefined): boolean {
  if (!(row instanceof HTMLElement)) return false
  const root = row.closest<HTMLElement>('.history-entry-list-content')
  const positions = snapshotHistoryEntryPositions(root)
  return startLayoutRemovalAnimation(row, {
    ghostClassName: 'history-entry-closing-ghost',
    onAfterRemove: () => animateHistoryEntryMoves(root, positions)
  })
}

function syncVisibleHistoryLayout(
  root: HTMLElement | null,
  previous: VisibleHistoryLayoutSnapshot | null,
  filter: string,
  animate: boolean
): VisibleHistoryLayoutSnapshot | null {
  if (!root || document.visibilityState !== 'visible') return previous

  const width = Math.round(root.getBoundingClientRect().width * 100) / 100
  const moveInProgress = root.querySelector('.history-entry-layout-moving') !== null
  // The first snapshot preserves the current transformed rectangles and cancels
  // stale ownership; a second read records the settled DOM as the next baseline.
  const visualPositions = snapshotHistoryEntryPositions(root)
  const positions = moveInProgress
    ? snapshotHistoryEntryPositions(root)
    : visualPositions
  const current = { filter, positions, root, width }

  if (
    animate &&
    previous &&
    previous.root === root &&
    previous.filter === filter &&
    Math.abs(previous.width - width) < 1
  ) {
    animateHistoryEntryMoves(root, moveInProgress ? visualPositions : previous.positions)
  }

  return current
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
    width: 'max-content'
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
  tailLine: HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME
}

function historyTitleExpandedLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  return expansionLineMarkup(lineHtml, HISTORY_ENTRY_EXPANSION_LINE_CLASSES, viewportConstrained)
}

function historyTitleExpandedMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number
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
    markup: lineHtml.length > 0 ? historyTitleExpandedLineMarkup(lineHtml) : titleEl.innerHTML
  })
}

function getHistoryTitleExpandedTextWidth(
  titleEl: HTMLElement | null,
  lineHtml: readonly string[],
  contentWidth: number,
  availableContentWidth: number,
  visibleLineCount: number,
  visibleWidth: number
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
      fits: (width) => historyTitleExpandedMeasureFitsLineCount(measureEl, width, targetLineCount)
    })
  } finally {
    measureEl.remove()
  }
}

function sameHistoryTitleMetrics(a: HistoryTitleMetrics, b: HistoryTitleMetrics) {
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
    win?.devicePixelRatio || 1
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
    width
  })
  return {
    captureGeometry: {
      elementRect: rect,
      lineHeight
    },
    metrics: {
      contentWidth: 0,
      expandedLineHtml: [],
      expandedTextWidth: 0,
      expandedViewportConstrained: false,
      isTruncated,
      visibleLineCount,
      width
    }
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

function flushHistoryTitleMeasurementJobs() {
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

function scheduleHistoryTitleMeasurement(job: HistoryTitleMeasurementJob) {
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

function syncHistoryTitleFade(
  titleEl: HTMLElement | null,
  syncFadeEnd = true,
  measuredMetrics?: HistoryTitleMetrics
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
    width
  }
  rememberHistoryTitleExpandedLayout(cacheKey, layout)
  return { ...layout, isTruncated }
}

function updateTitleTruncation(
  titleEl: HTMLElement | null,
  setTitleMetrics: Dispatch<SetStateAction<HistoryTitleMetrics>>
) {
  const metrics = syncHistoryTitleFade(titleEl)
  setTitleMetrics((current) => sameHistoryTitleMetrics(current, metrics) ? current : metrics)
}

function getHistoryEntryExpansionHorizontalInset(entryEl: HTMLElement, titleEl: HTMLElement) {
  const entryRect = entryEl.getBoundingClientRect()
  const titleRect = titleEl.getBoundingClientRect()
  return Math.max(0, titleRect.left - entryRect.left) + Math.max(0, entryRect.right - titleRect.right)
}

function getHistoryEntryExpansionGeometry(entryEl: HTMLElement | null, titleEl: HTMLElement | null): HistoryEntryExpansionGeometry {
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
    Math.max(metrics.width, metrics.expandedTextWidth + HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX)
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
    y: roomBelow >= rect.height * 2 || roomBelow >= roomAbove ? 'down' : 'up'
  }
}

function roundedHistoryEntrySlotSize(element: HTMLElement | null): HistoryEntrySlotSize {
  if (!element) return DEFAULT_HISTORY_ENTRY_SLOT_SIZE
  const rect = element.getBoundingClientRect()
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100
  }
}

function historyEntrySlotSizeEqual(left: HistoryEntrySlotSize, right: HistoryEntrySlotSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function historyEntryExpansionGeometryEqual(left: HistoryEntryExpansionGeometry, right: HistoryEntryExpansionGeometry) {
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

function getHistoryTitleResizeObserver() {
  historyTitleResizeObserver ??= createSizeChangeObserver(syncHistoryTitleFade)
  return historyTitleResizeObserver
}

function historyEntryIndexLabel(entry: TabHistoryEntry, snapshot: TabHistorySnapshot | null, fallback: number): ReactNode {
  if (Number.isInteger(entry.index) && snapshot && Number.isInteger(snapshot.currentIndex) && snapshot.currentIndex >= 0) {
    const relativeIndex = entry.index - snapshot.currentIndex
    if (relativeIndex < 0) {
      return (
        <>
          <span>-</span>
          <span>{Math.abs(relativeIndex)}</span>
        </>
      )
    }
    if (relativeIndex > 0) {
      return (
        <>
          <span>+</span>
          <span>{relativeIndex}</span>
        </>
      )
    }
    return String(relativeIndex)
  }
  return String(fallback)
}

function workingSetUrls(item: WorkingSetItem | null | undefined) {
  return item ? [...new Set([...pageTargetMatchUrls(item), item.key].filter(Boolean))] : []
}

function uniqueUrls(urls: readonly string[]) {
  return [...new Set(urls.filter(Boolean))]
}

type HistoryTitleClamp = {
  key: string
  lineHtml: string[]
  width: number
}
type HistoryTitleLayoutState = {
  clamp: HistoryTitleClamp | null
  metrics: HistoryTitleMetrics
}
const DEFAULT_HISTORY_TITLE_LAYOUT_STATE: HistoryTitleLayoutState = {
  clamp: null,
  metrics: DEFAULT_HISTORY_TITLE_METRICS
}

function historyTitleClampEqual(left: HistoryTitleClamp | null, right: HistoryTitleClamp | null) {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.key === right.key &&
    Math.abs(left.width - right.width) < 0.1 &&
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml)
  )
}

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
  onHistoryEntryContextMenuOpenChange: (open: boolean) => void
}

function useHistoryEntryExpansion(contextMenuOpenRef: RefObject<boolean>, titleClampKey: string): HistoryEntryExpansion {
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

  // History rows pass no close veto: their context menu guards closes at the
  // call sites instead (unlike Page Chips, which veto inside close itself).
  const titleExpansionController = useTitleExpansionController({
    id: entryExpansionId,
    lane: historyEntryExpansionLane,
    closeDelayMs: 0,
    onExpandedChange: setTitleExpanded,
    shouldIgnoreLaneSteal: () => contextMenuOpenRef.current
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
          metrics
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
      }
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
      if (contextMenuOpenRef.current) return
      const slotRect = entrySlotRef.current?.getBoundingClientRect()
      if (!slotRect) return
      const insideOriginalSlot =
        event.clientX >= slotRect.left &&
        event.clientX <= slotRect.right &&
        event.clientY >= slotRect.top &&
        event.clientY <= slotRect.bottom
      if (!insideOriginalSlot) closeNow()
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
  }, [titleExpansionController, titleExpanded, contextMenuOpenRef])

  // Unlike PageChip (which force-opens the title expansion when its menu opens),
  // history rows only keep an already-open expansion from collapsing while the
  // menu is open — they don't force-expand on right-click. The hover preview is
  // driven separately by the row's onMouseEnter/onMouseLeave.
  function onHistoryEntryContextMenuOpenChange(open: boolean) {
    contextMenuOpenRef.current = open
    if (!open) closeTitleExpansion()
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
    if (contextMenuOpenRef.current) return
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeTitleExpansion()
  }

  function onHistoryEntryFocus(e: FocusEvent<HTMLDivElement>) {
    if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) openTitleExpansion()
  }

  function onHistoryEntryBlur(e: FocusEvent<HTMLDivElement>) {
    if (contextMenuOpenRef.current) return
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
    onHistoryEntryContextMenuOpenChange
  }
}

type HistoryEntryActionsOptions = {
  entry: TabHistoryEntry
  kind: HistoryEntryKind
  workingSetItem: WorkingSetItem | null
  closedTab: ClosedTabEntry | null
  canActivateEntry: boolean
  entrySlotRef: RefObject<HTMLDivElement | null>
  contextMenuOpenRef: RefObject<boolean>
  onSnapshotChange?: SnapshotChangeHandler
  onHistoryLayoutSettled?: () => void
  onHoverUrlChange?: HoverUrlChangeHandler
  onTabsChange?: TabsChangeHandler
}

function useHistoryEntryActions({ entry, kind, workingSetItem, closedTab, canActivateEntry, entrySlotRef, contextMenuOpenRef, onSnapshotChange, onHistoryLayoutSettled, onHoverUrlChange, onTabsChange }: HistoryEntryActionsOptions) {
  function focusChangedActiveTab(result: ExistingTabFocusResult): boolean {
    const message = tabFocusResultToastMessage(result.status)
    if (message) showToast(message)
    return result.status === 'focused' || result.status === 'activated'
  }

  async function refreshAfterMutation() {
    try {
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
    } catch {
      // The browser mutation is already authoritative; an unavailable refresh
      // must not turn it into a failed action or suppress Undo/success state.
    }
  }

  async function onFocusEntry() {
    if (kind === 'closed-ghost' && closedTab) {
      const ok = await restoreClosedTab(closedTab.sessionId)
      if (!ok) {
        showToast("Couldn't reopen that tab")
        return
      }
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
      return
    }

    if (workingSetItem) {
      const result = await focusWorkingSetItemResult(workingSetItem)
      if (!focusChangedActiveTab(result)) return
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
      return
    }

    const result = await focusHistoryEntryResult(entry)
    if (!focusChangedActiveTab(result)) return
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  async function activateHistoryEntry(e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    await onHoverUrlChange?.('')
    const mode = chipActivationMode(e, navigator.platform)
    const hasLiveTab = !!workingSetItem || entry.exists
    const tabId = workingSetItem ? workingSetItem.tabId : entry.tabId
    const tabUrl = workingSetItem ? workingSetItem.tabUrl : entry.url
    const rawUrl = workingSetItem ? workingSetItem.rawUrl : entry.rawUrl
    // Only a plain click restores a closed session. Modifier gestures on a
    // no-live-target row follow the same URL-opening contract as other chips:
    // background/foreground in this window, or a new window for Shift.
    if (mode === 'focus') {
      await onFocusEntry()
      return
    }
    const activationResult = await performDashboardItemActivation(
      mode,
      { tabId, tabUrl, rawUrl },
      { moveExisting: hasLiveTab }
    )
    if (activationResult === 'handled') await refreshAfterMutation()
  }

  function onEntryKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!canActivateEntry) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    void activateHistoryEntry(e)
  }

  function onEntryMouseDown(e: MouseEvent<HTMLDivElement>) {
    // Shift-click moves the tab into a new window; ⌘/⌃-click moves it into this window.
    // Cancel the browser's native text selection for those gestures only so the row behaves like a link
    // (a plain click still drag-selects). See tab-activation.ts.
    if (shouldSuppressSelectionForGesture(e, navigator.platform)) e.preventDefault()
  }

  async function onCloseEntry(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const row = e.currentTarget.closest('.history-entry-row') || entrySlotRef.current?.closest('.history-entry-row')
    const result = await closeHistoryEntry(entry)
    if (!result.closed) {
      if (result.status === 'unknown') {
        showToast("Couldn't read open tabs, so the tab wasn't closed")
      } else if (result.status === 'failed') {
        showToast("Couldn't close that tab")
      } else {
        showToast('Nothing to close')
      }
      return
    }

    if (result.snapshot.length > 0) {
      markClosure(result.snapshot, 'Tab closed')
    } else {
      showToast('Tab closed')
    }

    if (startHistoryEntryRemoval(row)) {
      await waitForHistoryEntryMoves()
      onHistoryLayoutSettled?.()
    }
    onHoverUrlChange?.('')
    await refreshAfterMutation()
  }

  function onMouseEnter() {
    const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
    const hoverUrl = workingSetItem ? pageTargetUrl(workingSetItem) : pageTargetUrl(entry)
    const hoverUrls = uniqueUrls([
      ...pageTargetMatchUrls(entry),
      ...workingSetUrls(workingSetItem ?? undefined)
    ])
    const tabId = workingSetItem?.tabId ?? (entry.exists ? entry.tabId : undefined)
    onHoverUrlChange?.(hoverUrl, hoverSource, hoverUrls, tabId)
  }

  function onMouseLeave() {
    if (contextMenuOpenRef.current) return
    onHoverUrlChange?.('')
  }

  return { activateHistoryEntry, onEntryKeyDown, onEntryMouseDown, onCloseEntry, onMouseEnter, onMouseLeave }
}

type HistoryEntryMarkerCellProps = {
  indexLabel: ReactNode
  isIndexHighlighted: boolean
}

// Ghost rows (Working Set extras, recently-closed) render a blank marker
// cell: their open/closed state already reads from the row itself via the
// liveness treatment, so the old amber dot glyphs carried redundant signal.
function HistoryEntryMarkerCell({ indexLabel, isIndexHighlighted }: HistoryEntryMarkerCellProps) {
  const marker: ReactNode = indexLabel
  return (
    <span
      data-tabout-part="history-entry-marker"
      className={cn(
        'mt-1.25 inline-flex h-4 w-5.5 flex-none items-center justify-end gap-px bg-transparent text-xs font-medium tabular-nums text-muted-foreground group-hover/history-row:text-[rgba(64,64,64,0.76)] group-focus-within/history-row:text-[rgba(64,64,64,0.76)]',
        isIndexHighlighted && 'font-semibold text-tab-live group-hover/history-row:text-tab-live group-focus-within/history-row:text-tab-live'
      )}
    >
      {marker}
    </span>
  )
}

type HistoryEntryTitleProps = {
  expanded: boolean
  title: string
  highlightTerms: readonly string[]
  mutedTitle: boolean
  geometry: HistoryEntryExpansionGeometry
  clampedLineHtml: readonly string[] | null
  titleRef: RefObject<HTMLSpanElement | null>
}

function HistoryEntryTitle({ expanded, title, highlightTerms, mutedTitle, geometry, clampedLineHtml, titleRef }: HistoryEntryTitleProps) {
  function expandedLinesNode() {
    const lastIndex = geometry.lineHtml.length - 1
    return (
      <span className={HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME}>
        {geometry.lineHtml.map((html, index) => (
          <span
            key={`${index}:${html}`}
            className={index === lastIndex ? HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME : geometry.viewportConstrained ? HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME : HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME}
          >
            {expansionLineNodesFromHtml(html, `history-title-line-${index}`)}
          </span>
        ))}
      </span>
    )
  }
  const titleContent = expanded && geometry.lineHtml.length > 0
    ? expandedLinesNode()
    : !expanded && clampedLineHtml && clampedLineHtml.length > 1
      ? clampedTitleLineNodes(clampedLineHtml, 'history-entry-title')
      : highlightedTextNodes(title, highlightTerms, 'history-entry-title', createBionicTitleTextRenderer(title))
  const titleContentKey = clampedLineHtml && clampedLineHtml.length > 1
    ? 'captured'
    : 'natural'
  return (
    <span className="history-entry-title-expansion-hit-area -my-1.25 flex min-w-0 flex-auto py-1.25">
      <span className="flex min-w-0 flex-auto items-start gap-1.5">
        <span
          className={cn(
            "history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [font-size:inherit] [font-weight:inherit] [hyphenate-character:''] wrap-break-word [&.history-entry-title-truncated]:mask-(--title-fade-mask)",
            mutedTitle ? 'text-tab-closed' : 'text-tab-live',
            expanded && 'max-h-none! max-w-none! flex-none! overflow-visible! mask-none! w-(--history-entry-expanded-title-width) whitespace-normal wrap-break-word'
          )}
          ref={expanded ? undefined : titleRef}
        >
          <span
            key={titleContentKey}
            className="captured-title-content-root contents"
          >
            {titleContent}
          </span>
        </span>
      </span>
    </span>
  )
}

type HistoryEntryFaviconFrameProps = {
  expanded: boolean
  faviconUrl: string
  faviconDimmed: boolean
  loading: boolean
  isApp: boolean
  isWorkingSetExtra: boolean
  canRemoveEntry: boolean
  canForgetClosedGhost: boolean
  entryLabel: string
  onForget: (e: MouseEvent<HTMLButtonElement>) => void
  onClose: (e: MouseEvent<HTMLButtonElement>) => void
}

function HistoryEntryFaviconFrame({ expanded, faviconUrl, faviconDimmed, loading, isApp, isWorkingSetExtra, canRemoveEntry, canForgetClosedGhost, entryLabel, onForget, onClose }: HistoryEntryFaviconFrameProps) {
  return (
    <span className={cn(
      'history-entry-favicon-frame group/history-favicon-frame relative grid size-4 flex-none place-items-center',
      canRemoveEntry && 'pointer-events-none',
      !loading && !faviconUrl && !isWorkingSetExtra && !canRemoveEntry && 'invisible'
    )}>
      <span
        className={cn(
          // The favicon column is the same 16px cell page chips use, so
          // plain rows carry identical icon-to-title spacing to non-app
          // page chips. Standalone-app rows draw the shared 20px app ring
          // with the symmetric negative margins page chips use: the grid
          // track auto-sizes to its content, so an oversized child alone
          // would sit flush-left and overflow only rightward — the margins
          // force the 2px overflow to split evenly, keeping the ring's
          // center-line on the same axis as every plain favicon. The frame
          // keeps full strength — only the icon dims with liveness.
          'history-entry-favicon-content grid place-items-center',
          isApp
            ? 'history-entry-app-favicon -mx-0.5 -my-0.5 size-5 place-content-center overflow-hidden rounded-lg border border-[rgba(115,115,115,0.32)] p-0.5 [corner-shape:squircle]'
            : 'h-full w-full',
          canRemoveEntry && 'group-hover/history-favicon-frame:opacity-0'
        )}
        aria-hidden="true"
      >
        {loading ? <TabLoadingIndicator /> : faviconUrl ? <FaviconImage className={cn('block h-full w-full object-contain', faviconDimmed && FAVICON_DIM_CLASS_NAME)} src={faviconUrl} alt="" /> : isWorkingSetExtra || canForgetClosedGhost ? <DefaultFavicon className={faviconDimmed ? FAVICON_DIM_CLASS_NAME : ''} /> : null}
      </span>
      {canRemoveEntry && (
        <span
          data-tabout-part={canForgetClosedGhost ? 'forget-hit-owner' : 'close-hit-owner'}
          className="history-entry-close-hit-owner pointer-events-auto absolute top-1/2 left-1/2 z-2 size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full"
          aria-hidden="true"
        />
      )}
      {canRemoveEntry && (
        <button
          type="button"
          data-tabout-part={canForgetClosedGhost ? 'forget-button' : 'close-button'}
          className="history-entry-close history-entry-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-3 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 leading-0 outline-none group-hover/history-favicon-frame:pointer-events-auto group-hover/history-favicon-frame:opacity-100 hover:bg-neutral-600/10 hover:text-foreground hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-(--card-bg) focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
          tabIndex={expanded ? -1 : undefined}
          aria-label={canForgetClosedGhost ? `Remove ${entryLabel} from recently closed` : `Close ${entryLabel}`}
          onClick={canForgetClosedGhost ? onForget : onClose}
        >
          {canForgetClosedGhost ? (
            <EyeOff className="size-3.75" aria-hidden="true" />
          ) : (
            <X className="size-3.75" strokeWidth={2.5} aria-hidden="true" />
          )}
        </button>
      )}
    </span>
  )
}

type HistoryEntryContextMenuProps = {
  entry: TabHistoryEntry
  savedKeys?: ReadonlySet<string> | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  onOpenChange: (open: boolean) => void
  children: PageChipContextMenuTriggerElement
}

/**
 * HistoryEntryContextMenu — wraps a history row in the shared page-chip
 * context menu (Reload / Duplicate / Copy title / Copy URL / Save page / Suspend) when at least one action
 * applies; otherwise renders the row untouched.
 */
function HistoryEntryContextMenu({ entry, savedKeys, retainedPageSurfaceMatches = EMPTY_RETAINED_PAGE_SURFACE_MATCHES, onOpenChange, children }: HistoryEntryContextMenuProps) {
  const copyTitleText = entry.title
  const copyUrlText = entry.url
  const saveEligible = isHistoryEntrySaveEligible(entry, retainedPageSurfaceMatches)
  const saved = historyEntrySaved(entry, savedKeys, retainedPageSurfaceMatches)
  const savedActionLabel = saved ? 'Remove saved page' : 'Save page'
  const canShowSuspend = entry.exists && Number.isInteger(entry.tabId)
  const suspendEnabled = canShowSuspend && !entry.suspended

  async function onCopyEntryTitle(e: StopPropagationEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(copyTitleText)
      showToast('Page title copied')
    } catch {
      showToast('Could not copy page title')
    }
  }

  async function onCopyEntryUrl(e: StopPropagationEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(copyUrlText)
      showToast('Page URL copied')
    } catch {
      showToast('Could not copy page URL')
    }
  }

  async function onToggleEntrySaved(e: StopPropagationEvent) {
    e.stopPropagation()
    try {
      if (saved) await removeSavedPageTarget(historyEntrySavedPageKey(entry, retainedPageSurfaceMatches))
      else await savePageTarget(historyEntrySaveTarget(entry, retainedPageSurfaceMatches))
    } catch {
      showToast(saved ? "Couldn't remove the saved page" : "Couldn't save the page")
    }
  }

  function onToggleEntrySuspend(e: StopPropagationEvent) {
    e.stopPropagation()
    if (!Number.isInteger(entry.tabId)) return
    void suspendHistoryEntry({ tabId: entry.tabId, tabUrl: entry.url, rawUrl: entry.rawUrl })
  }

  function onReloadEntry(e: StopPropagationEvent) {
    e.stopPropagation()
    void reloadTabTarget({ tabId: entry.tabId, tabUrl: entry.url })
  }

  function onDuplicateEntry(e: StopPropagationEvent) {
    e.stopPropagation()
    void duplicateTabTarget({ tabId: entry.tabId, tabUrl: entry.url })
  }

  if (!copyTitleText && !copyUrlText && !saveEligible && !canShowSuspend) return children
  return (
    <PageChipContextMenu
      titleText={copyTitleText}
      onCopyTitle={onCopyEntryTitle}
      urlText={copyUrlText}
      onCopyUrl={onCopyEntryUrl}
      saved={saved}
      savedActionLabel={saveEligible ? savedActionLabel : undefined}
      onSavedSelect={saveEligible ? onToggleEntrySaved : undefined}
      onReloadSelect={canShowSuspend ? onReloadEntry : undefined}
      onDuplicateSelect={canShowSuspend ? onDuplicateEntry : undefined}
      suspendEnabled={suspendEnabled}
      onSuspendSelect={canShowSuspend ? onToggleEntrySuspend : undefined}
      onOpenChange={onOpenChange}
    >
      {children}
    </PageChipContextMenu>
  )
}

function HistoryEntry({ entry, kind, layoutKey, indexLabel, workingSetItem = null, closedTab = null, savedKeys, retainedPageSurfaceMatches = EMPTY_RETAINED_PAGE_SURFACE_MATCHES, highlightTerms = EMPTY_HIGHLIGHT_TERMS, onSnapshotChange, onHistoryLayoutSettled, onHoverUrlChange, onTabsChange, onForgetClosedGhost }: HistoryEntryProps) {
  const contextMenuOpenRef = useRef(false)
  const titleClampKey = JSON.stringify([entry.title, highlightTerms])
  const {
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
    onHistoryEntryContextMenuOpenChange
  } = useHistoryEntryExpansion(contextMenuOpenRef, titleClampKey)

  const isWorkingSetExtra = !!workingSetItem
  // Open-ghost (Working Set) rows reference a live tab, so they close it like
  // stack rows. Closed-ghost rows are already closed and Chrome exposes no API
  // to delete a recently-closed entry, so they "forget" via a local dismissal.
  const canCloseEntry = entry.exists
  const canForgetClosedGhost = kind === 'closed-ghost' && !!closedTab
  const canRemoveEntry = canCloseEntry || canForgetClosedGhost
  const canActivateEntry = entry.exists || (kind === 'closed-ghost' && !!closedTab)

  const { activateHistoryEntry, onEntryKeyDown, onEntryMouseDown, onCloseEntry, onMouseEnter, onMouseLeave } = useHistoryEntryActions({
    entry,
    kind,
    workingSetItem,
    closedTab,
    canActivateEntry,
    entrySlotRef,
    contextMenuOpenRef,
    ...(onSnapshotChange ? { onSnapshotChange } : {}),
    ...(onHistoryLayoutSettled ? { onHistoryLayoutSettled } : {}),
    ...(onHoverUrlChange ? { onHoverUrlChange } : {}),
    ...(onTabsChange ? { onTabsChange } : {})
  })

  async function onForgetEntry(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    if (!closedTab) return
    const row = e.currentTarget.closest('.history-entry-row') || entrySlotRef.current?.closest('.history-entry-row')
    if (startHistoryEntryRemoval(row)) {
      await waitForHistoryEntryMoves()
      onHistoryLayoutSettled?.()
    }
    onHoverUrlChange?.('')
    onForgetClosedGhost?.(closedTab)
  }

  const activeInOtherWindow = !!entry.activeInOtherWindow && !entry.current
  const isActiveEntry = entry.active || entry.activeInOtherWindow
  // Closed rows (no open tab) mirror closed-saved page chips: muted title,
  // dimmed favicon, and the group-style hover (lighter fill + outline).
  // The closed branch outranks canActivateEntry — closed ghosts are
  // activatable (reopen) but must not read as live clickable rows.
  const entryClosed = !entry.exists
  const historyEntryInteractionBg = entry.current
    ? 'var(--color-neutral-100)'
    : activeInOtherWindow
      ? HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_BG
      : entryClosed
        ? HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG
        : canActivateEntry
          ? HISTORY_ENTRY_CLICKABLE_INTERACTION_BG
          : HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG
  const historyEntryInteractionClasses = activeInOtherWindow
    ? HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES
    : entryClosed
      ? HISTORY_ENTRY_CLOSED_INTERACTION_CLASSES
      : canActivateEntry
        ? HISTORY_ENTRY_CLICKABLE_INTERACTION_CLASSES
        : HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_CLASSES
  const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
  const matchUrls = uniqueUrls([
    ...pageTargetMatchUrls(entry),
    ...workingSetUrls(workingSetItem ?? undefined)
  ])
  const hoverMatched = useHoverStateSelector((state) => (
    !!state.source && state.source !== hoverSource && (
      pageTargetMatchesHover(entry, state.url, state.urls) ||
      matchUrls.some((url) => url === state.url || state.urls.includes(url))
    )
  ))
  const isIndexHighlighted = isActiveEntry || entry.previousTarget || entry.nextTarget || hoverMatched
  const entryLabel = entry.title || entry.displayUrl || entry.url
  const faviconUrl = entry.favIconUrl || workingSetItem?.faviconUrl || ''
  // Same liveness rule as page chips: full strength only when an awake tab
  // backs the row. Open-ghost rows derive `suspended` from the suspender url
  // (makeHistoryEntry default), closed rows are exists:false.
  const faviconDimmed = !entry.exists || entry.suspended
  // Audio icon shows on any live (exists) row that is playing or muted — both
  // stack entries and working-set open-ghost rows (the adapter carries the
  // tab's audible/muted). Closed rows are exists:false, so a gone tab gets none.
  const audioState = entry.exists ? audioStateForTab(entry) : null
  function onToggleEntryAudio() {
    if (!audioState || !Number.isInteger(entry.tabId)) return
    void setHistoryEntryMuted(
      { tabId: entry.tabId, tabUrl: entry.url, rawUrl: entry.rawUrl },
      nextMutedForAudioState(audioState)
    )
  }
  function onHistoryEntryMenuOpenChange(open: boolean) {
    onHistoryEntryContextMenuOpenChange(open)
    if (open) {
      onMouseEnter()
    } else {
      onHoverUrlChange?.('')
    }
  }

  const entrySlotStyle: CSSVariableProperties | undefined = titleExpanded && entrySlotSize.width > 0 && entrySlotSize.height > 0 ? {
    height: `${entrySlotSize.height}px`,
    width: `${entrySlotSize.width}px`
  } : undefined
  const entryExpandedMaxWidth = entryExpansionGeometry.maxWidth > 0 ? `${entryExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const entryExpandedWidth = entryExpansionGeometry.width > 0 ? `${entryExpansionGeometry.width}px` : entryExpandedMaxWidth
  const entryExpandedTitleWidth = entryExpansionGeometry.titleWidth > 0 ? `${entryExpansionGeometry.titleWidth}px` : `${Math.max(1, titleMetrics.width)}px`
  const entryBaseStyle: CSSVariableProperties = {
    '--history-entry-fade-bg': historyEntryInteractionBg,
    '--history-entry-interaction-bg': historyEntryInteractionBg,
    '--history-entry-hover-border': entryClosed ? HISTORY_ENTRY_CLOSED_HOVER_BORDER : HISTORY_ENTRY_OPEN_HOVER_BORDER,
    '--history-entry-rest-bg': activeInOtherWindow ? HISTORY_ENTRY_ACTIVE_OTHER_REST_BG : 'transparent'
  }
  const entryOverlayStyle: CSSVariableProperties = {
    ...entryBaseStyle,
    '--history-entry-expanded-max-width': entryExpandedMaxWidth,
    '--history-entry-expanded-title-width': entryExpandedTitleWidth,
    '--history-entry-expanded-width': entryExpandedWidth,
    maxWidth: entryExpandedMaxWidth,
    width: entryExpandedWidth
  }
  function historyEntrySurface(expanded: boolean) {
    return (
      <div
        data-expanded={titleExpanded ? 'true' : undefined}
        data-current={entry.current ? 'true' : undefined}
        data-active={isActiveEntry ? 'true' : undefined}
        data-active-in-other-window={activeInOtherWindow ? 'true' : undefined}
        data-previous-target={entry.previousTarget ? 'true' : undefined}
        data-next-target={entry.nextTarget ? 'true' : undefined}
        aria-hidden={expanded ? true : undefined}
        className={cn(
          "history-entry group/history-entry relative min-w-0 flex-auto rounded-[10px] border-0 bg-transparent text-tab-live [--history-entry-fade-bg:var(--card-bg)] [corner-shape:squircle] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-0 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] focus-within:shadow-[inset_0_0_0_1px_rgba(234,179,8,0.42)] focus-within:after:opacity-100",
          entryClosed && 'history-entry-closed text-tab-closed',
          titleExpanded && 'history-entry-expanded-open',
          expanded && 'history-entry-expanded pointer-events-none absolute left-0 z-30 min-w-0 max-w-(--history-entry-expanded-max-width) cursor-default select-none overflow-visible! transition-none! w-(--history-entry-expanded-width) shadow-[0_3px_10px_rgba(10,10,10,0.055)]',
          expanded && (entryExpansionGeometry.y === 'up' ? 'bottom-0' : 'top-0'),
          entry.current && 'bg-neutral-100 text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400 [--history-entry-fade-bg:var(--color-neutral-100)]',
          !entry.current && historyEntryInteractionClasses,
          hoverMatched && 'history-entry-hover-match outline-1 outline-offset-1 outline-(--accent-amber)'
        )}
        style={expanded ? entryOverlayStyle : entryBaseStyle}
        ref={expanded ? undefined : entryRef}
        onMouseEnter={expanded ? onMouseEnter : undefined}
        onMouseLeave={expanded ? onMouseLeave : undefined}
        onPointerEnter={onHistoryEntryPointerEnter}
        onPointerMove={onHistoryEntryPointerMove}
        onPointerLeave={onHistoryEntryPointerLeave}
        onFocus={(e) => {
          if (expanded) onMouseEnter()
          onHistoryEntryFocus(e)
        }}
        onBlur={(e) => {
          if (expanded) onMouseLeave()
          onHistoryEntryBlur(e)
        }}
      >
        {entry.current && (
          <span
            className="active-history-entry-frame pointer-events-none absolute inset-0 z-2 rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)] [corner-shape:squircle]"
            aria-hidden="true"
          />
        )}
        {expanded && entryExpansionGeometry.scrollbarShieldWidth > 0 && (
          <span
            data-tabout-part="history-scrollbar-input-shield"
            className="history-entry-scrollbar-input-shield pointer-events-auto absolute top-0 bottom-0 z-3"
            style={{
              left: `${entryExpansionGeometry.scrollbarShieldLeft}px`,
              width: `${entryExpansionGeometry.scrollbarShieldWidth}px`
            }}
            aria-hidden="true"
          />
        )}
        {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- row contains a nested close <button>; a real <button> wrapper would be invalid nested-interactive DOM. */}
        <div
          role="button"
          tabIndex={!expanded && canActivateEntry ? 0 : -1}
          data-tabout-part="focus-button"
          aria-label={entryLabel}
          aria-disabled={!canActivateEntry || expanded}
          aria-busy={entry.loading ? true : undefined}
          className="history-entry-main flex w-full cursor-default items-start gap-2 border-0 bg-transparent px-2.25 py-1.25 text-left text-[13px] font-normal text-inherit font-[inherit] leading-tight outline-none focus-visible:outline-none"
          onClick={!expanded && canActivateEntry ? activateHistoryEntry : undefined}
          onMouseDown={!expanded && canActivateEntry ? onEntryMouseDown : undefined}
          onKeyDown={expanded ? undefined : onEntryKeyDown}
        >
          <HistoryEntryFaviconFrame
            expanded={expanded}
            faviconUrl={faviconUrl}
            faviconDimmed={faviconDimmed}
            loading={!!entry.loading}
            isApp={entry.isApp}
            isWorkingSetExtra={isWorkingSetExtra}
            canRemoveEntry={canRemoveEntry}
            canForgetClosedGhost={canForgetClosedGhost}
            entryLabel={entryLabel}
            onForget={onForgetEntry}
            onClose={onCloseEntry}
          />
          {audioState && (
            <TabAudioButton
              state={audioState}
              onToggle={onToggleEntryAudio}
              className="mt-px self-start"
            />
          )}
          <HistoryEntryTitle
            expanded={expanded}
            title={entry.title}
            highlightTerms={highlightTerms}
            mutedTitle={entryClosed}
            geometry={entryExpansionGeometry}
            clampedLineHtml={titleClamp?.key === titleClampKey ? titleClamp.lineHtml : null}
            titleRef={titleRef}
          />
        </div>
      </div>
    )
  }

  const expandedEntryElement = titleExpanded ? historyEntrySurface(true) : null

  return (
    <div
      data-tabout="activation-history-entry"
      data-tabout-layout-key={layoutKey}
      data-working-set-extra={isWorkingSetExtra ? 'true' : undefined}
      data-loading={entry.loading ? 'true' : undefined}
      data-pending={entry.pending ? 'true' : undefined}
      className={cn(
        'history-entry-row group/history-row flex w-full min-w-0 flex-none items-start gap-2 font-[inherit] [&.closing]:pointer-events-none',
        titleExpanded && 'history-entry-row-expanded-open'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <HistoryEntryMarkerCell
        indexLabel={indexLabel}
        isIndexHighlighted={isIndexHighlighted}
      />
      <div
        className="history-entry-slot relative min-w-0 flex-auto"
        style={entrySlotStyle}
        ref={entrySlotRef}
      >
        <HistoryEntryContextMenu entry={entry} savedKeys={savedKeys} retainedPageSurfaceMatches={retainedPageSurfaceMatches} onOpenChange={onHistoryEntryMenuOpenChange}>
          {historyEntrySurface(false)}
        </HistoryEntryContextMenu>
        {expandedEntryElement}
      </div>
    </div>
  )
}

function HistoryEntryScrollbar({ scrollbar }: { scrollbar: HistoryScrollbar }) {
  const { metrics, active, dragging, trackRef, onThumbPointerDown, onTrackPointerDown, onPointerEnter, onPointerLeave } = scrollbar
  if (!metrics.visible) return null

  const scrollbarStyle: CSSVariableProperties = {
    '--history-entry-scrollbar-thumb-height': `${metrics.thumbHeight}px`,
    '--history-entry-scrollbar-thumb-top': `${metrics.thumbTop}px`
  }

  return (
    <div
      data-tabout-part="history-scrollbar"
      className="history-entry-scrollbar pointer-events-none absolute top-0 right-0 bottom-0 z-20 w-(--dashboard-scrollbar-size) select-none max-[900px]:right-[calc(0px-var(--dashboard-scrollbar-inset))]"
      style={scrollbarStyle}
      aria-hidden="true"
    >
      <div
        ref={trackRef}
        className="history-entry-scrollbar-track pointer-events-auto absolute top-(--dashboard-scrollbar-padding) right-0 bottom-(--dashboard-scrollbar-padding) w-(--dashboard-scrollbar-size)"
        onPointerDown={onTrackPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <div
          data-dragging={dragging || undefined}
          className={cn(
            'history-entry-scrollbar-thumb absolute top-0 right-0 w-(--dashboard-scrollbar-size) rounded-(--dashboard-scrollbar-radius) border-(length:--dashboard-scrollbar-padding) border-transparent bg-(--dashboard-scrollbar-thumb-bg) bg-clip-content [transition:opacity_300ms_ease-out,border-width_var(--dashboard-scrollbar-grow-duration)_ease-out] h-(--history-entry-scrollbar-thumb-height) transform-[translateY(var(--history-entry-scrollbar-thumb-top))] hover:border-(length:--dashboard-scrollbar-padding-hover)',
            active ? 'opacity-100' : 'opacity-0',
            dragging && 'border-(length:--dashboard-scrollbar-padding-hover)'
          )}
          onPointerDown={onThumbPointerDown}
        />
      </div>
    </div>
  )
}

export function TabHistoryPanel({
  snapshot,
  workingSet = null,
  closedTabs = EMPTY_CLOSED_TABS,
  dismissedClosedGhosts: admittedClosedGhostDismissals = null,
  filter = '',
  savedKeys,
  retainedPageSurfaceMatches = EMPTY_RETAINED_PAGE_SURFACE_MATCHES,
  onSnapshotChange,
  onTabsChange
}: TabHistoryPanelProps) {
  const { onHoverUrlChange } = useDashboardActions()
  const [observedClosedGhostDismissals, setObservedClosedGhostDismissals] = useState<ClosedGhostDismissals | null>(null)
  const dismissedClosedGhosts = observedClosedGhostDismissals ?? admittedClosedGhostDismissals
  const closedGhostMutationRevisionRef = useRef(0)
  useEffect(() => {
    return subscribeClosedGhostDismissals((dismissals) => {
      closedGhostMutationRevisionRef.current += 1
      setObservedClosedGhostDismissals(dismissals)
    })
  }, [])

  async function handleForgetClosedGhost(closed: ClosedTabEntry) {
    const mutationRevision = closedGhostMutationRevisionRef.current
    let dismissals: Map<string, number>
    try {
      dismissals = await dismissClosedGhost(closed)
    } catch {
      showToast('Could not remove from recently closed')
      return
    }

    const expectedDismissedAt = dismissals.get(closedGhostDismissalKey(closed))
    if (typeof expectedDismissedAt !== 'number') {
      showToast('Could not remove from recently closed')
      return
    }

    if (closedGhostMutationRevisionRef.current === mutationRevision) {
      closedGhostMutationRevisionRef.current += 1
      setObservedClosedGhostDismissals(dismissals)
    }
    showToast('Removed from recently closed', {
      label: 'Undo',
      description: 'You can undo this action.',
      onClick: async () => {
        const undoRevision = closedGhostMutationRevisionRef.current
        try {
          const restoredDismissals = await restoreClosedGhost(closed, expectedDismissedAt)
          if (closedGhostMutationRevisionRef.current === undoRevision) {
            closedGhostMutationRevisionRef.current += 1
            setObservedClosedGhostDismissals(restoredDismissals)
          }
        } catch {
          showToast('Could not restore recently closed page')
        }
      }
    })
  }

  const rows = useHistoryPanelRows({ snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts })
  const savedKeySet = useMemo(() => new Set(savedKeys ?? []), [savedKeys])
  const highlightTerms = useMemo(() => highlightTermsForFilter(filter), [filter])
  const historyListRef = useRef<HTMLDivElement | null>(null)
  const historyContentRef = useRef<HTMLDivElement | null>(null)
  const lastVisibleHistoryLayoutRef = useRef<VisibleHistoryLayoutSnapshot | null>(null)
  const currentHistoryFilterRef = useRef(filter)
  const scrollbar = useHistoryScrollbar(historyListRef)

  function settleVisibleHistoryLayout() {
    lastVisibleHistoryLayoutRef.current = syncVisibleHistoryLayout(
      historyContentRef.current,
      lastVisibleHistoryLayoutRef.current,
      currentHistoryFilterRef.current,
      false
    )
  }

  // Row layout effects queue natural title reads. As their parent, this layout
  // effect runs after every row has queued but before ancestor masonry effects,
  // keeping the read phase together and the resulting clamp writes pre-paint.
  useLayoutEffect(() => {
    flushHistoryTitleMeasurementJobs()
  })

  useLayoutEffect(() => {
    currentHistoryFilterRef.current = filter
    lastVisibleHistoryLayoutRef.current = syncVisibleHistoryLayout(
      historyContentRef.current,
      lastVisibleHistoryLayoutRef.current,
      filter,
      true
    )
  }, [filter, rows])

  useEffect(() => {
    function animateHistoryLayoutOnReturn() {
      if (document.visibilityState !== 'visible') return
      lastVisibleHistoryLayoutRef.current = syncVisibleHistoryLayout(
        historyContentRef.current,
        lastVisibleHistoryLayoutRef.current,
        currentHistoryFilterRef.current,
        true
      )
    }

    document.addEventListener('visibilitychange', animateHistoryLayoutOnReturn)
    return () => document.removeEventListener('visibilitychange', animateHistoryLayoutOnReturn)
  }, [])

  return (
    <section
      data-tabout="activation-history"
      className="tab-history-panel sticky top-0 z-30 col-start-1 flex h-screen max-h-screen min-w-0 flex-col overflow-visible pl-(--dashboard-history-edge-gutter) max-[900px]:relative max-[900px]:ml-0 max-[900px]:mr-(--dashboard-scrollbar-inset) max-[900px]:h-auto max-[900px]:max-h-65 max-[900px]:border-b max-[900px]:border-(--warm-gray) max-[900px]:pr-0 max-[900px]:pb-0 max-[900px]:[.dashboard-shell.has-history_&]:col-1"
      aria-label="Activation history"
    >
      <div
        ref={historyListRef}
        className="history-entry-list pointer-events-none relative flex min-h-0 w-[calc(100vw-var(--dashboard-history-edge-gutter))] min-w-0 flex-auto overflow-x-hidden overflow-y-auto scrollbar-gutter-stable scrollbar-none min-[901px]:ml-[calc(var(--dashboard-page-gutter)-var(--dashboard-edge-bleed)-var(--dashboard-history-edge-gutter))] min-[901px]:pl-[calc(var(--dashboard-edge-bleed)-var(--dashboard-page-gutter)+var(--dashboard-history-edge-gutter))] max-[900px]:w-auto max-[900px]:mr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))]"
      >
        <div className="history-entry-scroll-hit-area-frame pointer-events-none sticky top-0 z-0 ml-[calc(var(--dashboard-page-gutter)-var(--dashboard-edge-bleed)-var(--dashboard-history-edge-gutter))] h-0 w-[calc(var(--dashboard-edge-bleed)-var(--dashboard-page-gutter)+var(--dashboard-history-edge-gutter))] flex-none max-[900px]:hidden" aria-hidden="true">
          <div
            data-tabout-part="history-scroll-hit-area"
            className="history-entry-scroll-hit-area h-screen w-full pointer-events-auto"
          />
        </div>
        <div ref={historyContentRef} className="history-entry-list-content pointer-events-auto flex self-start w-65 min-w-0 flex-col gap-[2.5px] pt-3 pr-3.5 pb-10 max-[900px]:w-full max-[900px]:pr-0 max-[900px]:pb-3">
          {rows.map((row) => {
            const layoutKey = historyPanelRowLayoutKey(row)
            return (
              <HistoryPanelRow
                key={historyPanelRowRenderKey(row)}
                row={row}
                layoutKey={layoutKey}
                snapshot={snapshot}
                savedKeys={savedKeySet}
                retainedPageSurfaceMatches={retainedPageSurfaceMatches}
                highlightTerms={highlightTerms}
                onSnapshotChange={onSnapshotChange}
                onHistoryLayoutSettled={settleVisibleHistoryLayout}
                onHoverUrlChange={onHoverUrlChange}
                onTabsChange={onTabsChange}
                onForgetClosedGhost={handleForgetClosedGhost}
              />
            )
          })}
        </div>
      </div>
      <HistoryEntryScrollbar scrollbar={scrollbar} />
    </section>
  )
}

function historyPanelRowRenderKey(row: HistoryPanelRow): string {
  if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}:${row.entry.index}`
  if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
  return `closed-ghost:${row.closed.sessionId}`
}

function historyPanelRowLayoutKey(row: HistoryPanelRow): string {
  if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}`
  if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
  return `closed-ghost:${row.closed.sessionId}`
}

function HistoryPanelRow({
  row,
  layoutKey,
  snapshot,
  savedKeys,
  retainedPageSurfaceMatches,
  highlightTerms,
  onSnapshotChange,
  onHistoryLayoutSettled,
  onHoverUrlChange,
  onTabsChange,
  onForgetClosedGhost
}: {
  row: HistoryPanelRow
  layoutKey: string
  snapshot: TabHistorySnapshot | null
  savedKeys: ReadonlySet<string>
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[]
  highlightTerms: readonly string[]
  onSnapshotChange?: SnapshotChangeHandler | undefined
  onHistoryLayoutSettled?: (() => void) | undefined
  onHoverUrlChange?: HoverUrlChangeHandler | undefined
  onTabsChange?: TabsChangeHandler | undefined
  onForgetClosedGhost?: ((closed: ClosedTabEntry) => void) | undefined
}): ReactNode {
  if (row.kind === 'stack') {
    return (
      <HistoryEntry
        entry={row.entry}
        layoutKey={layoutKey}
        indexLabel={historyEntryIndexLabel(row.entry, snapshot, row.entry.index + 1)}
        kind="stack"
        savedKeys={savedKeys}
        retainedPageSurfaceMatches={retainedPageSurfaceMatches}
        highlightTerms={highlightTerms}
        onSnapshotChange={onSnapshotChange}
        onHistoryLayoutSettled={onHistoryLayoutSettled}
        onHoverUrlChange={onHoverUrlChange}
        onTabsChange={onTabsChange}
      />
    )
  }
  if (row.kind === 'open-ghost') {
    return (
      <HistoryEntry
        entry={historyEntryFromWorkingSetItem(row.item)}
        layoutKey={layoutKey}
        indexLabel={null}
        kind="open-ghost"
        workingSetItem={row.item}
        savedKeys={savedKeys}
        retainedPageSurfaceMatches={retainedPageSurfaceMatches}
        highlightTerms={highlightTerms}
        onSnapshotChange={onSnapshotChange}
        onHistoryLayoutSettled={onHistoryLayoutSettled}
        onHoverUrlChange={onHoverUrlChange}
        onTabsChange={onTabsChange}
      />
    )
  }
  return (
    <HistoryEntry
      entry={historyEntryFromClosedTab(row.closed)}
      layoutKey={layoutKey}
      indexLabel={null}
      kind="closed-ghost"
      closedTab={row.closed}
      savedKeys={savedKeys}
      retainedPageSurfaceMatches={retainedPageSurfaceMatches}
      highlightTerms={highlightTerms}
      onSnapshotChange={onSnapshotChange}
      onHistoryLayoutSettled={onHistoryLayoutSettled}
      onHoverUrlChange={onHoverUrlChange}
      onTabsChange={onTabsChange}
      onForgetClosedGhost={onForgetClosedGhost}
    />
  )
}
