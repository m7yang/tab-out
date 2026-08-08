import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { X } from 'lucide-react'
import { isClosedSavedDashboardTab, isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../extension/page-target.js'
import { activateRetainedPageTarget, removeRetainedPageTarget } from '../extension/retained-page-actions.js'
import { activateSavedPageTarget } from '../extension/saved-page-activation.js'
import { savePageTarget, removeSavedPageTarget } from '../extension/saved-page-actions.js'
import { focusExistingTabTargetResult, tabFocusResultToastMessage } from '../extension/tab-focus.js'
import { chipActivationMode, performDashboardItemActivation, shouldSuppressSelectionForGesture } from '../extension/tab-activation.js'
import type { ChipActivationModifiers } from '../extension/tab-activation.js'
import { filterResultCandidateForTarget } from '../extension/filter-result-navigation.js'
import { focusExactTabOrOpenResult } from '../extension/tabs.js'
import { closeChipTarget, deleteHistoryUrls, duplicateTabTarget, reloadTabTarget, setChipTargetMuted, suspendChipTarget } from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'
import { nextMutedForAudioState } from '../extension/tab-audio.js'
import { DefaultFavicon } from './DefaultFavicon'
import { FaviconImage } from './FaviconImage'
import { useDomainCardContext } from './DomainCardContext'
import { useDashboardActions, useHoverStateSelector, type HoverState } from './DashboardInteractionContext'
import { startPageChipCloseAnimation } from './PageChipCloseAnimation'
import { capturePageChipFocusRecovery, type PageChipFocusRecovery } from './PageChipFocusRecovery'
import { TooltipAnchor } from './ui/tooltip'
import { PageChipContextMenu } from './PageChipContextMenu'
import { SavedPageIcon } from './SavedPageIcon'
import { TabAudioButton } from './TabAudioButton'
import { TabLoadingIndicator } from './TabLoadingIndicator'
import { ProgressiveFoldedEnvList } from './ProgressiveFoldedEnvList'
import { cn } from '@/lib/utils'
import type { CSSVariableProperties } from '@/lib/css-properties'
import { createBionicTitleTextRenderer, isUrlLikeTitle } from './bionic-title-text'
import { highlightTermsForFilter, highlightedTextNodes } from './filter-highlight-text'
import { titleSuppressionChipHighlightClass, titleSuppressionMarkerClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import { clampedTitleLineNodes, createExpansionMeasureElement, createTitleExpansionLane, expandedLineContentOverflows, expansionLineHtmlEquals, expansionLineMarkup, expansionLineNodesFromHtml, fragmentHtml, paintedRangeRect, searchExpandedWidth, syncClampedTitleFadeEnd, syncTruncatedTitleFadeEnd, unwrapClampedTitleLines, useTitleExpansionController, type ExpansionLineClasses } from './title-expansion'
import { chipTrim, CHIP_TRIM_TOKENS } from './chip-trim'
import { FAVICON_DIM_CLASS_NAME, VARIANT_LABEL_DIM_CLASS_NAME } from './liveness-dim'
import type { DashboardChipData } from './types'
import type { DashboardChipEnv, DashboardSegment } from '../extension/types'
import { closeTargetLeavesSavedPage, foldedTabCloseTargets, historyDeleteFullyRemoved, partitionVariantCloseTargets, groupCloseActionLabel, titleVariantGroupRemovalConfirmed, variantClosable } from './chip-close-targets.js'
import { pageChipTargetActionPolicy } from './page-chip-action-policy.js'
import { chipCanShowSuspend, chipSuspendableTargetCount } from './chip-suspend-targets.js'
import { registerPageChipTextLayoutValidation, type PageChipTextLayoutMeasurementJob } from './page-chip-layout-validation.js'
import { createSizeChangeObserver, type ObservedElementSize, type SizeChangeObserver } from './size-change-observer.js'
import { subscribeFontMetricsInvalidation } from './font-metrics-invalidation.js'

let chipTextResizeObserver: SizeChangeObserver | null = null
const chipTextMeasuredSizes = new WeakMap<HTMLElement, ObservedElementSize>()
const chipTextTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: { hasExpandableContent: boolean; height: number; isTruncated: boolean; width: number }) => void
>()

const PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX = 12
const PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX = 8
const CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX = 0.5
const PAGE_CHIP_EXPANDED_WIDTH_SEARCH_STEPS = 12
const PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX = 1.5
const PAGE_CHIP_TARGET_INTERACTION_BG = 'color-mix(in oklab, var(--color-neutral-600) 14%, transparent)'
const PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = 'chip-title-suppression-marker inline rounded-lg border-0 bg-[rgba(115,115,115,0.08)] px-1 text-[12px] leading-[inherit] font-medium whitespace-nowrap text-muted-foreground align-baseline [corner-shape:squircle] [box-decoration-break:clone]'
const PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME = 'chip-strip-indicator inline-block max-w-full rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground align-baseline [corner-shape:squircle]'
// Expanded chips reveal the full path suffix, so the cloned/measured copy must
// wrap (and break long, space-free query strings) instead of staying on the
// single nowrap line it uses while collapsed — otherwise it overflows the chip.
const PAGE_CHIP_EXPANDED_PATH_CLASS_NAME = 'chip-path font-normal text-muted-foreground inline-block max-w-full whitespace-normal wrap-break-word'
const DEFAULT_CHIP_EXPANSION_GEOMETRY: ChipExpansionGeometry = {
  grewTaller: false,
  lineHtml: [],
  maxWidth: 0,
  viewportConstrained: false,
  width: 0,
  x: 'start',
  y: 'down'
}

interface PageChipProps {
  chip: DashboardChipData
  filter?: string | undefined
  layoutScope?: string | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
}

function chipMatchesHoverState(target: DashboardChipData, state: HoverState): boolean {
  return (
    pageTargetMatchesHover(target, state.url, state.urls) ||
    !!target.envs?.some((env) => pageTargetMatchesHover(env, state.url, state.urls))
  )
}

function pageChipHoverMatchKey(
  state: HoverState,
  chip: DashboardChipData,
  titleVariantChips: readonly DashboardChipData[]
): string {
  if (!state.url || !state.source || state.source === 'chip') return ''
  const matches = [
    chipMatchesHoverState(chip, state),
    ...titleVariantChips.map((variant) => chipMatchesHoverState(variant, state))
  ]
  return matches.some(Boolean) ? matches.map((matched) => matched ? '1' : '0').join('') : ''
}

type ChipTextRenderMode = 'chip' | 'tooltip'
type RenderTitleContentOptions = {
  includePathSuffix?: boolean
}
type StopPropagationEvent = {
  stopPropagation: () => void
}
type ChipTextMetrics = {
  hasExpandableContent: boolean
  isTruncated: boolean
  width: number
}
type ChipTextClamp = {
  key: string
  lineHtml: string[]
  width: number
}
type ChipTextLayoutState = {
  clamp: ChipTextClamp | null
  metrics: ChipTextMetrics
}
type ChipTextFadeMetrics = ChipTextMetrics & {
  height: number
}
type ChipTextLineCaptureGeometry = {
  lineHeight: number
  textRect: DOMRect
}
type ChipTextLayoutReading = {
  fadeMetrics: ChipTextFadeMetrics
  layout: ChipTextLayoutState
}
type ChipTextMeasurement = {
  clampEligible: boolean
  element: HTMLElement
  key: string
  masonryCardWidth: string
  metrics: ChipTextMetrics
}
type ChipSlotSize = {
  height: number
  width: number
}
type ChipExpansionGeometry = {
  /** The expansion wraps to MORE lines than the resting chip, so the overlay
      extends past the resting slot instead of revealing in place. */
  grewTaller: boolean
  lineHtml: string[]
  maxWidth: number
  viewportConstrained: boolean
  width: number
  x: 'start'
  y: 'down' | 'up'
}
type ChipExpansionDomPosition =
  | {
    kind: 'text'
    node: Text
    offset: number
  }
  | {
    element: HTMLElement
    kind: 'element'
  }
type ExpandedPageChipContentMetrics = {
  /** True only when a single-line resting title must WRAP on reveal — the
      expanded overlay then grows taller than the resting slot. Multi-line
      resting chips reveal in place (frozen lines), so they never set this. */
  grewTaller?: boolean
  viewportConstrained: boolean
  width: number
}
const DEFAULT_CHIP_TEXT_METRICS: ChipTextMetrics = { hasExpandableContent: false, isTruncated: false, width: 0 }
const DEFAULT_CHIP_TEXT_LAYOUT_STATE: ChipTextLayoutState = { clamp: null, metrics: DEFAULT_CHIP_TEXT_METRICS }
const DEFAULT_CHIP_SLOT_SIZE: ChipSlotSize = { height: 0, width: 0 }

const pageChipExpansionLane = createTitleExpansionLane()

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
}

function titleTextForChip(target: Pick<DashboardChipData, 'title' | 'tooltip' | 'tabUrl'>): string {
  return (target.title || target.tooltip || target.tabUrl).trim()
}

function titleTextForEnv(env: DashboardChipEnv, parent: Pick<DashboardChipData, 'title' | 'tooltip'>): string {
  return (env.title || parent.title || parent.tooltip || env.tabUrl).trim()
}

function isTitleSuppressionSegment(segment: DashboardSegment): segment is { titleSuppression: string } {
  return typeof segment !== 'string' && 'titleSuppression' in segment
}

function isStructuralPlaceholderSegment(segment: DashboardSegment): segment is { placeholder: true; label?: string } {
  return typeof segment !== 'string' && 'placeholder' in segment
}

function isChipTextTruncated(textEl: HTMLElement | null) {
  if (!textEl) return false
  return (
    textEl.scrollHeight - textEl.clientHeight > 1 ||
    textEl.scrollWidth - textEl.clientWidth > 1
  )
}

function getChipTextWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().width * 100) / 100
}

function getChipTextPaintedContentWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return 0

  const textRect = textEl.getBoundingClientRect()
  if (textRect.width <= 0) return 0

  const range = ownerDocument.createRange()
  const walker = ownerDocument.createTreeWalker(
    textEl,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent?.trim()
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      }
    }
  )
  let maxRight = 0

  function includeRect(rect: DOMRect) {
    if (rect.width <= 0 && rect.height <= 0) return
    maxRight = Math.max(maxRight, rect.right - textRect.left)
  }

  try {
    while (true) {
      const node = walker.nextNode()
      if (!(node instanceof win.Text)) break
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) includeRect(rect)
    }
  } finally {
    range.detach()
  }

  for (const marker of textEl.querySelectorAll<HTMLElement>('.chip-title-suppression-marker, .chip-strip-indicator')) {
    includeRect(marker.getBoundingClientRect())
  }

  return Math.round(Math.max(0, maxRight) * 100) / 100
}

function getChipTextExpansionBaselineWidth(textEl: HTMLElement | null) {
  const boxWidth = getChipTextWidth(textEl)
  const contentWidth = getChipTextPaintedContentWidth(textEl)
  if (boxWidth <= 0 || contentWidth <= 0) return boxWidth
  return Math.round(Math.min(boxWidth, contentWidth + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX) * 100) / 100
}

function cssPixelValue(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function elementInlinePaddingWidth(element: HTMLElement) {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (!styles) return 0
  return cssPixelValue(styles.paddingLeft) + cssPixelValue(styles.paddingRight)
}

function elementColumnGap(element: HTMLElement) {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  return styles ? cssPixelValue(styles.columnGap) : 0
}

function visibleElementChildren(element: HTMLElement) {
  return Array.from(element.children).filter((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) return false
    const rect = child.getBoundingClientRect()
    return rect.width > 0 || child.scrollWidth > 0
  })
}

function titleVariantButtonMinimumWidth(button: HTMLElement) {
  const children = visibleElementChildren(button)
  const contentWidth = children.reduce((width, child) => {
    if (child.classList.contains('chip-title-variant-label')) {
      return width + Math.max(child.scrollWidth, child.getBoundingClientRect().width)
    }
    return width + Math.max(child.scrollWidth, child.getBoundingClientRect().width)
  }, 0)
  const gapWidth = Math.max(0, children.length - 1) * elementColumnGap(button)
  return elementInlinePaddingWidth(button) + gapWidth + contentWidth
}

function getTitleVariantMinimumContentWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0

  let width = 0
  for (const shell of textEl.querySelectorAll<HTMLElement>('.chip-title-variant-shell')) {
    const button = shell.querySelector<HTMLElement>('.chip-title-variant')
    if (!button) continue
    const list = shell.closest<HTMLElement>('.chip-title-variant-list')
    const listInlinePadding = list ? elementInlinePaddingWidth(list) : 0
    width = Math.max(
      width,
      listInlinePadding + elementInlinePaddingWidth(shell) + titleVariantButtonMinimumWidth(button)
    )
  }
  return Math.round(width * 100) / 100
}

function titleVariantLabelsOverflow(textEl: HTMLElement | null) {
  if (!textEl) return false
  return textEl.querySelectorAll<HTMLElement>('.chip-title-variant-label')
    .values()
    .some((label) => label.scrollWidth - label.clientWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX)
}

function titleVariantContentOverflows(textEl: HTMLElement | null) {
  const minimumWidth = getTitleVariantMinimumContentWidth(textEl)
  if (minimumWidth <= 0) return false
  const visibleWidth = getChipTextExpansionBaselineWidth(textEl)
  return minimumWidth - visibleWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX
}

function chipTextHasExpandableContent(textEl: HTMLElement | null) {
  return isChipTextTruncated(textEl) || titleVariantLabelsOverflow(textEl) || titleVariantContentOverflows(textEl)
}

function getChipTextHeight(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().height * 100) / 100
}

function getChipTextLineHeight(textEl: HTMLElement | null) {
  if (!textEl || typeof window === 'undefined') return 16
  const styles = window.getComputedStyle(textEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight

  const fontSize = Number.parseFloat(styles.fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16
}

function visibleChipTextLineCount(textHeight: number, lineHeight: number) {
  if (lineHeight <= 0 || textHeight <= 0) return 1
  return Math.max(1, Math.round(textHeight / lineHeight))
}

function getVisibleChipTextLineCount(textEl: HTMLElement | null) {
  if (!textEl) return 1
  const lineHeight = getChipTextLineHeight(textEl)
  const textHeight = getChipTextHeight(textEl)
  return visibleChipTextLineCount(textHeight, lineHeight)
}

function chipExpansionRawLineIndexForRect(rect: DOMRect, textRect: DOMRect, lineHeight: number) {
  if (rect.width <= 0 && rect.height <= 0) return null
  return Math.max(0, Math.round((rect.top - textRect.top) / lineHeight))
}

function chipExpansionLineIndexForRect(rect: DOMRect, textRect: DOMRect, lineHeight: number, visibleLineCount: number) {
  const lineIndex = chipExpansionRawLineIndexForRect(rect, textRect, lineHeight)
  if (lineIndex === null) return null
  return lineIndex < visibleLineCount ? lineIndex : null
}

function firstChipExpansionTextOffsetOnLine(
  node: Text,
  targetLineIndex: number,
  range: Range,
  textRect: DOMRect,
  lineHeight: number
) {
  let low = 0
  let high = node.length - 1

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    range.setStart(node, 0)
    range.setEnd(node, middle + 1)
    const rect = paintedRangeRect(range)
    const lineIndex = rect
      ? chipExpansionRawLineIndexForRect(rect, textRect, lineHeight)
      : null
    if (lineIndex !== null && lineIndex >= targetLineIndex) {
      high = middle
    } else {
      low = middle + 1
    }
  }

  range.setStart(node, 0)
  range.setEnd(node, low + 1)
  const rect = paintedRangeRect(range)
  return rect && chipExpansionRawLineIndexForRect(rect, textRect, lineHeight) === targetLineIndex
    ? low
    : null
}

function chipExpansionPositionNode(position: ChipExpansionDomPosition) {
  return position.kind === 'text' ? position.node : position.element
}

function chipExpansionElementPrecedesPosition(element: HTMLElement, position: ChipExpansionDomPosition, win: Window & typeof globalThis) {
  const positionNode = chipExpansionPositionNode(position)
  return (
    element === positionNode ||
    element.contains(positionNode) ||
    !!(element.compareDocumentPosition(positionNode) & win.Node.DOCUMENT_POSITION_FOLLOWING)
  )
}

function setRangeStartAtChipExpansionPosition(range: Range, position: ChipExpansionDomPosition) {
  if (position.kind === 'text') {
    range.setStart(position.node, position.offset)
    return
  }
  range.setStartBefore(position.element)
}

function setRangeEndAtChipExpansionPosition(range: Range, position: ChipExpansionDomPosition) {
  if (position.kind === 'text') {
    range.setEnd(position.node, position.offset)
    return
  }
  range.setEndBefore(position.element)
}

function carriedExpandedMarkerToneClass(marker: Element) {
  return Array.from(marker.classList)
    .filter((className) => (
      className.startsWith('title-suppression-token-tone-') ||
      /^(border|bg|ring)-(yellow|teal|sky|rose)-/.test(className) ||
      className === 'ring-1' ||
      className === 'ring-inset' ||
      className === 'text-foreground'
    ))
    .join(' ')
}

function carriedExpandedMarkerSpacingClass(marker: Element) {
  return Array.from(marker.classList)
    .filter((className) => className.startsWith('ml-') || className.startsWith('mr-'))
    .join(' ')
}

function ensureLeadingExpandedMarkerSpace(document: Document, marker: Element) {
  if (carriedExpandedMarkerSpacingClass(marker)) return
  const previous = marker.previousSibling
  if (previous?.textContent && /\s$/.test(previous.textContent)) return
  marker.before(document.createTextNode(' '))
}

function hydrateClonedExpandedChipFragment(document: Document, fragment: DocumentFragment) {
  for (const content of fragment.querySelectorAll('.chip-title-variant-content')) {
    content.className = 'chip-title-variant-content inline-flex max-w-full min-w-0 flex-col items-start gap-0.5 align-top'
  }

  for (const list of fragment.querySelectorAll('.chip-title-variant-list')) {
    list.className = 'chip-title-variant-list inline-flex max-w-full flex-col items-stretch pr-[5px] pb-1 align-top divide-y divide-neutral-500/15'
  }

  for (const shell of fragment.querySelectorAll('.chip-title-variant-shell')) {
    shell.className = 'chip-title-variant-shell inline-flex max-w-full min-w-0 items-center'
  }

  for (const variant of fragment.querySelectorAll('.chip-title-variant')) {
    variant.className = 'chip-title-variant inline-flex max-w-full min-w-0 items-center gap-1 rounded-none bg-transparent px-1.5 py-[3px] [font-size:inherit] leading-tight font-normal text-neutral-600'
  }

  for (const marker of fragment.querySelectorAll('.chip-title-suppression-marker')) {
    const label = marker.getAttribute('aria-label') || ''
    const hiddenTitleText = label.replace(/^Suppressed title text:\s*/, '').trim()
    if (!hiddenTitleText) continue

    ensureLeadingExpandedMarkerSpace(document, marker)
    marker.className = cn(PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME, carriedExpandedMarkerSpacingClass(marker), carriedExpandedMarkerToneClass(marker))
    marker.replaceChildren(document.createTextNode(hiddenTitleText))
  }

  for (const marker of fragment.querySelectorAll('.chip-strip-indicator')) {
    if (!marker.textContent?.trim()) {
      marker.remove()
      continue
    }

    const label = marker.getAttribute('aria-label') || ''
    if (!label) continue

    marker.className = PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME
    marker.replaceChildren(document.createTextNode(label))
  }

  for (const path of fragment.querySelectorAll('.chip-path')) {
    path.className = PAGE_CHIP_EXPANDED_PATH_CLASS_NAME
  }
}

function expandedChipFragmentHtml(document: Document, fragment: DocumentFragment) {
  unwrapClampedTitleLines(fragment)
  hydrateClonedExpandedChipFragment(document, fragment)
  return fragmentHtml(document, fragment)
}

// Clamped rows keep the raw captured markup: markers stay as-is so the
// clamped-row renderer can rebuild them as live React nodes, instead of the
// expansion pipeline's hydrated text-label presentation.
function clampedChipFragmentHtml(document: Document, fragment: DocumentFragment) {
  unwrapClampedTitleLines(fragment)
  return fragmentHtml(document, fragment)
}

function getClampedPageChipLineHtml(
  textEl: HTMLElement | null,
  geometry?: ChipTextLineCaptureGeometry
) {
  return getExpandedPageChipLineHtml(textEl, clampedChipFragmentHtml, geometry)
}

type ChipLineFragmentSerializer = (document: Document, fragment: DocumentFragment) => string

function getExpandedPageChipLineHtml(
  textEl: HTMLElement | null,
  serializeFragment: ChipLineFragmentSerializer = expandedChipFragmentHtml,
  geometry?: ChipTextLineCaptureGeometry
) {
  if (!textEl || typeof document === 'undefined') return []

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const textRect = geometry?.textRect ?? textEl.getBoundingClientRect()
  const lineHeight = geometry?.lineHeight ?? getChipTextLineHeight(textEl)
  if (textRect.height <= 0 || lineHeight <= 0) return []
  const textHeight = Math.round(textRect.height * 100) / 100
  const visibleLineCount = visibleChipTextLineCount(textHeight, lineHeight)
  if (visibleLineCount <= 1) return []

  // A compact marker glyph can be the first painted item on a wrapped line.
  // Treat those marker elements as line-start candidates so the expanded label
  // stays on the same visible line instead of jumping back into the prior text.
  const walker = ownerDocument.createTreeWalker(
    textEl,
    win.NodeFilter.SHOW_TEXT | win.NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node instanceof win.Text) {
          return node.textContent
            ? win.NodeFilter.FILTER_ACCEPT
            : win.NodeFilter.FILTER_REJECT
        }
        if (
          node instanceof win.HTMLElement &&
          (
            node.classList.contains('chip-title-suppression-marker') ||
            node.classList.contains('chip-strip-indicator')
          )
        ) {
          return win.NodeFilter.FILTER_ACCEPT
        }
        return win.NodeFilter.FILTER_SKIP
      }
    }
  )
  const textNodes: Text[] = []
  const markerElements: HTMLElement[] = []
  while (true) {
    const node = walker.nextNode()
    if (!node) break

    if (node instanceof win.HTMLElement) {
      markerElements.push(node)
      continue
    }

    if (node instanceof win.Text && node.data.trim()) textNodes.push(node)
  }

  const range = ownerDocument.createRange()
  const textLineBounds = new Map<Text, { first: number; last: number } | null>()
  function getTextLineBounds(node: Text) {
    const cached = textLineBounds.get(node)
    if (cached !== undefined) return cached

    range.selectNodeContents(node)
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    for (const rect of range.getClientRects()) {
      const lineIndex = chipExpansionRawLineIndexForRect(rect, textRect, lineHeight)
      if (lineIndex === null) continue
      first = Math.min(first, lineIndex)
      last = Math.max(last, lineIndex)
    }
    const bounds = Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null
    textLineBounds.set(node, bounds)
    return bounds
  }

  function textPositionForLine(targetLineIndex: number): ChipExpansionDomPosition | null {
    if (textNodes.length === 0) return null

    let candidateIndex = -1
    if (targetLineIndex === 0) {
      candidateIndex = textNodes.findIndex((node) => {
        const bounds = getTextLineBounds(node)
        return !!bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex
      })
    } else {
      let low = 0
      let high = textNodes.length - 1
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        const middleNode = textNodes[middle]
        if (!middleNode) return null
        const bounds = getTextLineBounds(middleNode)
        if (bounds && bounds.last >= targetLineIndex) {
          high = middle
        } else {
          low = middle + 1
        }
      }
      const lowNode = textNodes[low]
      if (!lowNode) return null
      const bounds = getTextLineBounds(lowNode)
      if (bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex) {
        candidateIndex = low
      }
    }

    // Hidden/non-painting text can make the binary predicate sparse. Walk back
    // through that rare gap so a later valid node cannot hide an earlier line
    // start; ordinary wrapped-line searches stop after one predecessor.
    if (candidateIndex >= 0 && targetLineIndex > 0) {
      for (let index = candidateIndex - 1; index >= 0; index -= 1) {
        const candidateNode = textNodes[index]
        if (!candidateNode) continue
        const bounds = getTextLineBounds(candidateNode)
        if (!bounds) continue
        if (bounds.last < targetLineIndex) break
        if (bounds.first <= targetLineIndex) candidateIndex = index
      }
    }

    // Preserve the old engine's correctness with a cached linear fallback if
    // no monotonic candidate survived at all.
    if (candidateIndex < 0) {
      candidateIndex = textNodes.findIndex((node) => {
        const bounds = getTextLineBounds(node)
        return !!bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex
      })
    }
    if (candidateIndex < 0) return null

    const node = textNodes[candidateIndex]
    if (!node) return null
    const offset = firstChipExpansionTextOffsetOnLine(node, targetLineIndex, range, textRect, lineHeight)
    return offset === null ? null : { kind: 'text', node, offset }
  }

  const lineStartsByIndex: Array<ChipExpansionDomPosition | undefined> = Array.from({ length: visibleLineCount })
  for (let lineIndex = 0; lineIndex < visibleLineCount; lineIndex += 1) {
    lineStartsByIndex[lineIndex] = textPositionForLine(lineIndex) || undefined
  }
  for (const marker of markerElements) {
    const lineIndex = chipExpansionLineIndexForRect(marker.getBoundingClientRect(), textRect, lineHeight, visibleLineCount)
    if (lineIndex === null) continue
    const current = lineStartsByIndex[lineIndex]
    if (!current || chipExpansionElementPrecedesPosition(marker, current, win)) {
      lineStartsByIndex[lineIndex] = { element: marker, kind: 'element' }
    }
  }

  range.detach()
  const lineStarts = lineStartsByIndex.filter((position): position is ChipExpansionDomPosition => !!position)
  if (lineStarts.length <= 1) return []

  const lines: string[] = []
  for (let index = 0; index < lineStarts.length; index += 1) {
    const lineRange = ownerDocument.createRange()
    const start = lineStarts[index]
    if (!start) continue
    setRangeStartAtChipExpansionPosition(lineRange, start)
    const next = lineStarts[index + 1]
    if (next) {
      setRangeEndAtChipExpansionPosition(lineRange, next)
    } else {
      lineRange.selectNodeContents(textEl)
      setRangeStartAtChipExpansionPosition(lineRange, start)
    }
    lines.push(serializeFragment(ownerDocument, lineRange.cloneContents()))
    lineRange.detach()
  }

  return lines
}

const PAGE_CHIP_EXPANSION_LINE_CLASSES: ExpansionLineClasses = {
  wrapper: 'page-chip-expanded-lines block min-w-0 max-w-full',
  line: 'page-chip-expanded-line block min-w-0 max-w-full whitespace-nowrap',
  constrainedLine: 'page-chip-expanded-line page-chip-expanded-line-constrained block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word',
  tailLine: 'page-chip-expanded-line page-chip-expanded-line-tail block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word'
}

function chipExpansionLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  return expansionLineMarkup(lineHtml, PAGE_CHIP_EXPANSION_LINE_CLASSES, viewportConstrained)
}

function expandedMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number
) {
  measureEl.style.width = `${Math.max(1, width)}px`
  const lineHeight = getChipTextLineHeight(measureEl)
  const height = measureEl.getBoundingClientRect().height
  const fixedLineOverflows = measureEl.querySelectorAll<HTMLElement>('.page-chip-expanded-line:not(.page-chip-expanded-line-tail)')
    .values()
    .some((line) => expandedLineContentOverflows(line, PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX))
  const markerWrapsTaller = measureEl.querySelectorAll<HTMLElement>('.chip-title-suppression-marker, .chip-strip-indicator')
    .values()
    .some((marker) => marker.getBoundingClientRect().height > lineHeight + PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX)
  return !fixedLineOverflows && !markerWrapsTaller && height <= targetLineCount * lineHeight + PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX
}

function getExpandedSingleLineNaturalWidth(measureEl: HTMLElement) {
  const elements = [measureEl, ...measureEl.querySelectorAll<HTMLElement>('*')]
  for (const element of elements) {
    element.style.whiteSpace = 'nowrap'
  }
  const range = measureEl.ownerDocument.createRange()
  range.selectNodeContents(measureEl)
  try {
    return Math.round(Math.max(
      measureEl.scrollWidth,
      measureEl.getBoundingClientRect().width,
      range.getBoundingClientRect().width
    ) * 100) / 100
  } finally {
    range.detach()
  }
}

/** The expansion swaps glyph pills for full-text labels, growing the visible content itself. */
function expansionRevealsHydratingPills(textEl: HTMLElement) {
  return !!textEl.querySelector('.chip-title-suppression-marker, .chip-strip-indicator[aria-label]')
}

/**
 * Widest packed line when the hydrated content wraps at the full viewport
 * allowance — the shrink-to-fit width for viewport-constrained reveals.
 * Undoes the nowrap mutation getExpandedSingleLineNaturalWidth left on the
 * measure clone, so pills keep their own nowrap while text wraps again.
 */
function measureConstrainedPackedWidth(measureEl: HTMLElement, maxContentWidth: number) {
  measureEl.style.whiteSpace = 'normal'
  for (const element of measureEl.querySelectorAll<HTMLElement>('*')) {
    element.style.whiteSpace = ''
  }
  measureEl.style.width = `${Math.max(1, maxContentWidth)}px`
  return getChipTextPaintedContentWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
}

function expandedPageChipMeasureMarkup(textEl: HTMLElement, lineHtml: readonly string[]) {
  if (lineHtml.length > 0) return chipExpansionLineMarkup(lineHtml)

  const ownerDocument = textEl.ownerDocument
  const fragment = ownerDocument.createDocumentFragment()
  for (const child of Array.from(textEl.childNodes)) {
    fragment.append(child.cloneNode(true))
  }
  hydrateClonedExpandedChipFragment(ownerDocument, fragment)
  return fragmentHtml(ownerDocument, fragment)
}

function createExpandedPageChipMeasureElement(
  textEl: HTMLElement,
  lineHtml: readonly string[]
) {
  return createExpansionMeasureElement(textEl, {
    className: 'page-chip-expansion-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-tab-live [font-family:inherit] [hyphenate-character:\'\'] wrap-break-word',
    markup: expandedPageChipMeasureMarkup(textEl, lineHtml)
  })
}

function getExpandedTitleVariantContentWidth(textEl: HTMLElement, visibleWidth: number, maxContentWidth: number) {
  const titleRow = textEl.querySelector<HTMLElement>('.chip-title-row')
  if (!titleRow) return null

  const measureEl = createExpandedPageChipMeasureElement(titleRow, [])
  if (!measureEl) return null

  try {
    const naturalTitleWidth = getExpandedSingleLineNaturalWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
    const width = Math.min(Math.max(visibleWidth, naturalTitleWidth), maxContentWidth)
    return {
      viewportConstrained: naturalTitleWidth - maxContentWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX,
      width: Math.round(width * 100) / 100
    }
  } finally {
    measureEl.remove()
  }
}

function getExpandedWrappedPageChipContentWidth(
  textEl: HTMLElement,
  measureEl: HTMLElement,
  visibleWidth: number,
  maxContentWidth: number,
  targetLineCount: number,
  lineHtml: readonly string[]
): ExpandedPageChipContentMetrics {
  // Try the resting width first: if the revealed content still fits within the resting
  // line count there, keep the resting width and don't grow (no guard padding). Flooring
  // the lower bound at the resting box width, rather than a painted-content estimate that
  // can fall below it, avoids widening a chip whose content already fits at its current
  // width. Only widen when it genuinely can't fit in the resting line count.
  const lowerBound = Math.min(maxContentWidth, Math.max(visibleWidth, getChipTextWidth(textEl)))
  return searchExpandedWidth({
    lowerBound,
    maxContentWidth,
    steps: PAGE_CHIP_EXPANDED_WIDTH_SEARCH_STEPS,
    guardPx: lineHtml.length > 0 ? PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX : 0,
    fits: (width) => expandedMeasureFitsLineCount(measureEl, width, targetLineCount)
  })
}

function getExpandedPageChipContentWidth(
  textEl: HTMLElement | null,
  lineHtml: readonly string[],
  maxContentWidth: number,
  visibleWidthOverride = 0
): ExpandedPageChipContentMetrics {
  if (!textEl) return { viewportConstrained: false, width: 0 }

  const visibleWidth = Math.max(getChipTextExpansionBaselineWidth(textEl), visibleWidthOverride)
  const targetLineCount = Math.max(getVisibleChipTextLineCount(textEl), lineHtml.length)
  if (visibleWidth <= 0 || maxContentWidth <= 0) return { viewportConstrained: false, width: visibleWidth }

  const titleVariantMetrics = textEl.querySelector('.chip-title-variant-content')
    ? getExpandedTitleVariantContentWidth(textEl, visibleWidth, maxContentWidth)
    : null
  if (titleVariantMetrics) return titleVariantMetrics

  const measureEl = createExpandedPageChipMeasureElement(textEl, lineHtml)
  if (!measureEl) return { viewportConstrained: false, width: visibleWidth }

  try {
    if (textEl.classList.contains('chip-title-row')) {
      if (targetLineCount > 1) {
        return getExpandedWrappedPageChipContentWidth(textEl, measureEl, visibleWidth, maxContentWidth, targetLineCount, lineHtml)
      }
      const naturalWidth = getChipTextPaintedContentWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
      const width = Math.min(Math.max(visibleWidth, naturalWidth), maxContentWidth)
      return {
        viewportConstrained: naturalWidth - maxContentWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX,
        width: Math.round(width * 100) / 100
      }
    }

    if (targetLineCount <= 1) {
      // Expand horizontally only as far as the revealed text needs to sit on one line.
      // The natural width comes from a measure clone, which can render a sub-pixel
      // narrower than the real expanded element; add the same guard the other width
      // paths use so the text isn't left 1px short and forced to wrap. If it can't
      // fit on one line even at the full available width (the screen edge), don't
      // widen a pure-text reveal at all — keep the resting width and let it wrap.
      // Hydrating pills void that rule: they grow the visible content itself, so
      // wrapping at the resting width re-strands pills mid-title; pack the wrap
      // at the full allowance instead and shrink the box to the widest line.
      const naturalWidth = getExpandedSingleLineNaturalWidth(measureEl) + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX
      if (naturalWidth > maxContentWidth) {
        if (!expansionRevealsHydratingPills(textEl)) {
          return { grewTaller: true, viewportConstrained: true, width: Math.round(Math.min(visibleWidth, maxContentWidth) * 100) / 100 }
        }
        const packedWidth = measureConstrainedPackedWidth(measureEl, maxContentWidth)
        return { grewTaller: true, viewportConstrained: true, width: Math.round(Math.min(Math.max(visibleWidth, packedWidth), maxContentWidth) * 100) / 100 }
      }
      return { viewportConstrained: false, width: Math.round(Math.min(maxContentWidth, Math.max(visibleWidth, naturalWidth)) * 100) / 100 }
    }

    return getExpandedWrappedPageChipContentWidth(textEl, measureEl, visibleWidth, maxContentWidth, targetLineCount, lineHtml)
  } finally {
    measureEl.remove()
  }
}

function getExpandedPageChipHorizontalInset(chipEl: HTMLElement, textEl: HTMLElement | null) {
  if (!textEl) return 0
  const chipRect = chipEl.getBoundingClientRect()
  const textRect = textEl.getBoundingClientRect()
  return Math.max(0, textRect.left - chipRect.left) + Math.max(0, chipRect.right - textRect.right)
}

function readChipTextFadeMetrics(
  textEl: HTMLElement,
  textRect = textEl.getBoundingClientRect()
): ChipTextFadeMetrics {
  const isTruncated = isChipTextTruncated(textEl)
  const hasExpandableContent = isTruncated || titleVariantLabelsOverflow(textEl) || titleVariantContentOverflows(textEl)
  return {
    hasExpandableContent,
    height: Math.round(textRect.height * 100) / 100,
    isTruncated,
    width: Math.round(textRect.width * 100) / 100
  }
}

function applyChipTextFadeMetrics(
  textEl: HTMLElement,
  metrics: ChipTextFadeMetrics,
  syncFadeEnd = true
) {
  const { height, isTruncated, width } = metrics
  chipTextMeasuredSizes.set(textEl, { height, width })
  textEl.classList.toggle('chip-text-truncated', isTruncated)
  if (syncFadeEnd) syncTruncatedTitleFadeEnd(textEl, isTruncated)
  chipTextTruncationCallbacks.get(textEl)?.(metrics)
  return metrics
}

function syncChipTextFade(
  textEl: HTMLElement | null,
  syncFadeEnd = true,
  measuredMetrics?: ChipTextFadeMetrics
) {
  if (!textEl) return { hasExpandableContent: false, height: 0, isTruncated: false, width: 0 }

  return applyChipTextFadeMetrics(
    textEl,
    measuredMetrics ?? readChipTextFadeMetrics(textEl),
    syncFadeEnd
  )
}

function getChipTextMetrics(textEl: HTMLElement | null): ChipTextMetrics {
  const { hasExpandableContent, isTruncated, width } = syncChipTextFade(textEl)
  return { hasExpandableContent, isTruncated, width }
}

function chipTextMetricsEqual(left: ChipTextMetrics, right: ChipTextMetrics) {
  return (
    left.hasExpandableContent === right.hasExpandableContent &&
    left.isTruncated === right.isTruncated &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function chipTextClampEqual(left: ChipTextClamp | null, right: ChipTextClamp | null) {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.key === right.key &&
    Math.abs(left.width - right.width) < 0.1 &&
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml)
  )
}

function chipTextLayoutEqual(left: ChipTextLayoutState, right: ChipTextLayoutState) {
  return chipTextMetricsEqual(left.metrics, right.metrics) && chipTextClampEqual(left.clamp, right.clamp)
}

function readChipTextLayout(textEl: HTMLElement, clampEligible: boolean, clampKey: string): ChipTextLayoutReading {
  // A captured clamp fades at its known box edge. Defer the glyph-range read
  // until capture fails so successful clamps do not measure an unused anchor.
  // The box and line height are also the line-capture geometry; keep that one
  // snapshot through capture instead of forcing duplicate reads per title.
  const textRect = textEl.getBoundingClientRect()
  const fadeMetrics = readChipTextFadeMetrics(textEl, textRect)
  const nextMetrics = {
    hasExpandableContent: fadeMetrics.hasExpandableContent,
    isTruncated: fadeMetrics.isTruncated,
    width: fadeMetrics.width
  }
  let nextClamp: ChipTextClamp | null = null
  if (clampEligible && fadeMetrics.isTruncated && fadeMetrics.width > 0) {
    const lineHtml = getClampedPageChipLineHtml(textEl, {
      lineHeight: getChipTextLineHeight(textEl),
      textRect
    })
    if (lineHtml.length > 1) {
      nextClamp = { key: clampKey, lineHtml, width: fadeMetrics.width }
    }
  }
  return {
    fadeMetrics,
    layout: { clamp: nextClamp, metrics: nextMetrics }
  }
}

function applyChipTextLayout(textEl: HTMLElement, reading: ChipTextLayoutReading): ChipTextLayoutState {
  applyChipTextFadeMetrics(textEl, reading.fadeMetrics, false)
  if (reading.layout.clamp) {
    syncClampedTitleFadeEnd(textEl, reading.layout.clamp.width)
  } else {
    syncTruncatedTitleFadeEnd(textEl, reading.fadeMetrics.isTruncated)
  }
  return reading.layout
}

function measureChipTextLayout(textEl: HTMLElement, clampEligible: boolean, clampKey: string) {
  return applyChipTextLayout(textEl, readChipTextLayout(textEl, clampEligible, clampKey))
}

function waitsForInitialMasonryWidth(textEl: HTMLElement) {
  const card = textEl.closest<HTMLElement>('.domain-block')
  const container = textEl.closest<HTMLElement>('.missions')
  return !!card && !!container && !container.classList.contains('is-packed') && card.style.width === ''
}

function getChipTextMasonryCardWidth(textEl: HTMLElement) {
  return textEl.closest<HTMLElement>('.domain-block')?.style.width || ''
}

function getPageChipExpansionGeometry(chipEl: HTMLElement | null, textEl: HTMLElement | null = chipEl?.querySelector<HTMLElement>('.chip-text') || null): ChipExpansionGeometry {
  if (!chipEl || typeof window === 'undefined') return DEFAULT_CHIP_EXPANSION_GEOMETRY

  const rect = chipEl.getBoundingClientRect()
  const contentBoxEl = chipEl.querySelector<HTMLElement>('.chip-text') || textEl
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const roomToRight = Math.max(0, viewportWidth - rect.left - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomBelow = Math.max(0, viewportHeight - rect.top - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomAbove = Math.max(0, rect.bottom - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const horizontalInset = getExpandedPageChipHorizontalInset(chipEl, contentBoxEl)
  const lineHtml = getExpandedPageChipLineHtml(textEl)
  const visibleWidthOverride = contentBoxEl && contentBoxEl !== textEl
    ? Math.max(getChipTextExpansionBaselineWidth(contentBoxEl), getTitleVariantMinimumContentWidth(contentBoxEl))
    : getTitleVariantMinimumContentWidth(textEl)
  const minWidth = Math.max(1, horizontalInset + Math.max(getChipTextExpansionBaselineWidth(textEl), visibleWidthOverride))
  const maxWidth = Math.max(rect.width, roomToRight)
  const contentMetrics = getExpandedPageChipContentWidth(textEl, lineHtml, Math.max(1, maxWidth - horizontalInset), visibleWidthOverride)
  return {
    grewTaller: !!contentMetrics.grewTaller,
    lineHtml,
    maxWidth,
    viewportConstrained: contentMetrics.viewportConstrained,
    width: Math.min(maxWidth, Math.max(rect.width, minWidth, contentMetrics.width + horizontalInset)),
    x: 'start',
    y: roomBelow >= rect.height * 2 || roomBelow >= roomAbove ? 'down' : 'up'
  }
}

function roundedElementSize(element: HTMLElement | null): ChipSlotSize {
  if (!element) return DEFAULT_CHIP_SLOT_SIZE
  const rect = element.getBoundingClientRect()
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100
  }
}

function chipSlotSizeEqual(left: ChipSlotSize, right: ChipSlotSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function chipExpansionGeometryEqual(left: ChipExpansionGeometry, right: ChipExpansionGeometry) {
  return (
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml) &&
    left.grewTaller === right.grewTaller &&
    left.x === right.x &&
    left.y === right.y &&
    left.viewportConstrained === right.viewportConstrained &&
    Math.abs(left.maxWidth - right.maxWidth) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

function getChipTextResizeObserver() {
  chipTextResizeObserver ??= createSizeChangeObserver(syncChipTextFade)
  return chipTextResizeObserver
}

type ChipFaviconFrameProps = {
  chip: DashboardChipData
  dupeCount: number
  showDefaultFavicon: boolean
  showFaviconCloseAction: boolean
  dedupeBadgesClosing: boolean
  closeActionLabel: string
  onCloseAction: (e: MouseEvent<HTMLButtonElement>) => void
  onToggleAudio: () => void
}

/**
 * ChipFaviconFrame — the chip's favicon cell: dupe-stack layers, the favicon
 * (or default), the page-pin badge, the hover-revealed close action, and the
 * icon-only audio toggle. The favicon image dims when no live tab backs the
 * chip — the image itself, not the frame, so dupe-stack rings and badges
 * keep their weight.
 */
function ChipFaviconFrame({ chip, dupeCount, showDefaultFavicon, showFaviconCloseAction, dedupeBadgesClosing, closeActionLabel, onCloseAction, onToggleAudio }: ChipFaviconFrameProps) {
  const faviconDimmed = !!chip.suspended || isClosedSavedDashboardTab(chip)
  return (
    <span
      className={cn(
        'chip-favicon-frame group/favicon-frame relative grid size-4 shrink-0 place-items-center',
        chip.iconOnly ? 'self-center' : 'self-start',
        !chip.isApp && 'min-h-4 min-w-4 max-h-4 max-w-4',
        // Titled app chips ring their favicon with the same 20px ring as
        // history app rows, CENTERED on the plain favicon's 16px slot: the
        // symmetric negative margins keep a 16px layout footprint (title x
        // and chip height unchanged) while the ring overflows 2px on every
        // side, so its center-line sits on the same axis as plain favicons.
        chip.isApp && !chip.iconOnly && 'size-5 -mx-0.5 -my-0.5',
        !chip.iconOnly && dupeCount > 1 && 'chip-favicon-stack',
        chip.isApp && 'is-app',
        showFaviconCloseAction && 'pointer-events-none'
      )}
    >
      {!chip.iconOnly && dupeCount > 2 && (
        <span
          className={cn(
            'chip-favicon-stack-layer pointer-events-none absolute top-0 left-0 z-0 size-4 max-h-4 max-w-4 translate-x-1 translate-y-1 rounded-sm bg-(--card-bg) ring-1 ring-neutral-300/45 shadow-[0_1px_2px_rgba(10,10,10,0.12)] [corner-shape:squircle] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
            dedupeBadgesClosing && 'closing'
          )}
          aria-hidden="true"
        />
      )}
      {!chip.iconOnly && dupeCount > 1 && (
        <span
          className={cn(
            'chip-favicon-stack-layer pointer-events-none absolute top-0 left-0 z-1 size-4 max-h-4 max-w-4 translate-x-0.5 translate-y-0.5 rounded-sm bg-(--card-bg) ring-1 ring-neutral-300/55 shadow-[0_1px_2px_rgba(10,10,10,0.1)] [corner-shape:squircle] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
            dedupeBadgesClosing && 'closing'
          )}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          'chip-favicon-content relative z-2 grid size-4 place-items-center',
          chip.isApp && !chip.iconOnly && 'chip-app-favicon-ring h-full w-full place-content-center overflow-hidden rounded-lg border border-[rgba(115,115,115,0.32)] p-0.5 [corner-shape:squircle]',
          !chip.iconOnly && dupeCount > 1 && 'rounded-sm bg-(--card-bg) ring-1 ring-neutral-300/45 shadow-[0_1px_2px_rgba(10,10,10,0.08)] [corner-shape:squircle]',
          showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0'
        )}
        aria-hidden="true"
      >
        {chip.loading ? (
          <TabLoadingIndicator />
        ) : chip.faviconUrl ? (
          <FaviconImage className={cn('chip-favicon block h-full w-full rounded-none object-cover', faviconDimmed && FAVICON_DIM_CLASS_NAME)} src={chip.faviconUrl} alt="" />
        ) : showDefaultFavicon ? (
          <DefaultFavicon className={faviconDimmed ? FAVICON_DIM_CLASS_NAME : ''} />
        ) : null}
      </span>
      {!chip.iconOnly && chip.pagePinned && (
        <span
          data-tabout-part="page-pin"
          data-pinned="true"
          className={cn(
            'chip-page-pin-badge pointer-events-none absolute -top-1.5 -right-1.5 z-3 inline-flex size-3.5 items-center justify-center rounded-full border border-tab-card bg-(--card-bg) text-muted-foreground opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.16)] data-[pinned=true]:opacity-100',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0'
          )}
          aria-hidden="true"
        >
          <span className="icon-[lucide--pin] size-2.5" aria-hidden="true" />
        </span>
      )}
      {showFaviconCloseAction && (
        <span
          data-tabout-part="close-hit-owner"
          className="chip-close-hit-owner pointer-events-auto absolute top-1/2 left-1/2 z-3 size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full"
          aria-hidden="true"
        />
      )}
      {showFaviconCloseAction && (
        <button
          type="button"
          data-tabout-part="close-button"
          className="chip-action chip-close chip-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-4 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 group-hover/favicon-frame:pointer-events-auto group-hover/favicon-frame:opacity-100 hover:bg-neutral-600/10 hover:text-foreground hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-(--card-bg) focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
          aria-label={closeActionLabel}
          onClick={onCloseAction}
        >
          <X className="size-3.75" strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      {chip.iconOnly && chip.audioState && (
        <TabAudioButton
          state={chip.audioState}
          onToggle={onToggleAudio}
          className="absolute right-0 bottom-0 z-4 size-3.5 rounded-full bg-(--card-bg) shadow-[0_1px_2px_rgba(10,10,10,0.16)] [corner-shape:squircle]"
        />
      )}
    </span>
  )
}

function usePageChipElement({ chip, filter = '', layoutScope = '', suppressedTitleToneByText }: PageChipProps) {
  const { activeSuppressedTitle, dedupeBadgesClosing, highlightTerms: cardHighlightTerms } = useDomainCardContext()
  const { onHoverUrlChange, onLayoutChange, onTogglePinnedPageChip } = useDashboardActions()
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
  const foldedCloseTargets = foldedTabCloseTargets(envs)
  const titleVariantChips = Array.isArray(chip.titleVariantChips) ? chip.titleVariantChips : []
  const hoverMatchKey = useHoverStateSelector((state) => pageChipHoverMatchKey(state, chip, titleVariantChips))
  const isTitleVariantGroup = titleVariantChips.length > 1
  const chipFilterResultCandidate = filterResultCandidateForTarget(chip)
  const chipLayoutKey = chip.pagePinId || chip.rawUrl
  const progressiveFoldedEnvResetKey = JSON.stringify([
    chip.sourceType,
    chipLayoutKey,
    filter
  ])
  const variantCloseTargets = partitionVariantCloseTargets(titleVariantChips)
  const variantCloseCount = variantCloseTargets.historyUrls.length + variantCloseTargets.tabEnvs.length
  const chipCloseLeavesSavedPage = isTitleVariantGroup
    ? titleVariantChips.some((variant) => variantClosable(variant) && closeTargetLeavesSavedPage(variant))
    : isFolded
      ? foldedCloseTargets.some(closeTargetLeavesSavedPage)
      : closeTargetLeavesSavedPage(chip)
  const parentInteractive = !isFolded && !isTitleVariantGroup
  const hasFilter = filter.trim().length > 0
  const isHistorySource = chip.sourceType === 'history'
  const isClosedSavedPage = isClosedSavedDashboardTab(chip)
  const highlightTerms = cardHighlightTerms ?? highlightTermsForFilter(filter)
  const isReadOnlySource = isReadOnlyDashboardSourceType(chip.sourceType)
  const readOnlyFilterResult = hasFilter && isReadOnlySource
  const primaryPreviewUrl = pageTargetUrl(chip)
  const suppressedTitleParts = chip.suppressedTitleParts || []
  const activeSuppressedTitleKey = activeSuppressedTitle.trim().toLowerCase()
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const suppressionHighlighted = activeSuppressedTitleKey !== '' && suppressedTitleParts.some((part) => part.toLowerCase() === activeSuppressedTitleKey)
  const chipTextClampEligible = !chip.iconOnly && !isFolded && !isTitleVariantGroup
  const chipTextClampKey = JSON.stringify([chip.displaySegments, chip.leadPrefix ?? '', chip.pathGroupLabel ?? '', chip.pathSuffix ?? '', suppressedTitleParts, highlightTerms])
  const chipExpansionId = useId()
  const chipSlotRef = useRef<HTMLDivElement | null>(null)
  const chipTextRef = useRef<HTMLSpanElement | null>(null)
  const updateChipTextMeasurementsRef = useRef<(textEl: HTMLElement | null) => void>(() => {})
  const chipTextMeasurementRef = useRef<ChipTextMeasurement | null>(null)
  const contextMenuOpenRef = useRef(false)
  const contextMenuFocusRecoveryRef = useRef<PageChipFocusRecovery | null>(null)
  const chipExpandedRef = useRef(false)
  const [chipTooltipOpen, setChipTooltipOpen] = useState(false)
  const [chipExpanded, setChipExpandedState] = useState(false)
  const [chipSlotSize, setChipSlotSize] = useState(DEFAULT_CHIP_SLOT_SIZE)
  const [chipExpansionGeometry, setChipExpansionGeometry] = useState(DEFAULT_CHIP_EXPANSION_GEOMETRY)
  const [chipTextLayout, setChipTextLayout] = useState(DEFAULT_CHIP_TEXT_LAYOUT_STATE)
  const chipTextMetrics = chipTextLayout.metrics
  const storedChipTextClamp = chipTextLayout.clamp
  const chipTextClamp =
    storedChipTextClamp?.key === chipTextClampKey &&
    Math.abs(storedChipTextClamp.width - chipTextMetrics.width) < CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX
      ? storedChipTextClamp
      : null
  const { hasExpandableContent } = chipTextMetrics

  useEffect(() => () => {
    contextMenuFocusRecoveryRef.current?.cancel()
  }, [])

  const setChipExpanded = useCallback((nextExpanded: boolean) => {
    chipExpandedRef.current = nextExpanded
    setChipExpandedState(nextExpanded)
  }, [])

  // Page Chips close synchronously on pointer exit, but an open context menu
  // or visible keyboard focus still owns the expansion. Context menus also
  // keep ownership against lane steals, unlike history rows which guard at
  // call sites.
  const chipExpansionController = useTitleExpansionController({
    id: chipExpansionId,
    lane: pageChipExpansionLane,
    closeDelayMs: 0,
    onExpandedChange: setChipExpanded,
    shouldCancelClose: () => contextMenuOpenRef.current,
    shouldIgnoreLaneSteal: () => contextMenuOpenRef.current
  })

  const updateChipTextMeasurements = useCallback((textEl: HTMLElement | null) => {
    const nextMetrics = getChipTextMetrics(textEl)
    setChipTextLayout((current) => (
      chipTextMetricsEqual(current.metrics, nextMetrics)
        ? current
        : { ...current, metrics: nextMetrics }
    ))
  }, [])

  const updateChipSlotMeasurements = useCallback((chipElArg?: HTMLElement | null) => {
    const chipEl = chipElArg !== undefined ? chipElArg : chipSlotRef.current?.querySelector<HTMLElement>('.page-chip') || null
    const nextSize = roundedElementSize(chipEl)
    const textEl = chipTextRef.current?.querySelector<HTMLElement>('.chip-title-row') || chipTextRef.current
    const nextGeometry = getPageChipExpansionGeometry(chipEl, textEl)
    setChipSlotSize((current) => chipSlotSizeEqual(current, nextSize) ? current : nextSize)
    setChipExpansionGeometry((current) => chipExpansionGeometryEqual(current, nextGeometry) ? current : nextGeometry)
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- callback reads only stable refs; eslint-plugin-react-hooks (the enforced gate) exempts refs.
  }, [])

  useEffect(() => {
    updateChipTextMeasurementsRef.current = updateChipTextMeasurements
  }, [updateChipTextMeasurements])


  // Truncated chips swap to captured-line rows so the tail fills to the box
  // edge under the fade (see the matching history-title clamp effect for the
  // invalidate-then-recapture contract). The capture keeps marker elements
  // raw and the row renderer revives suppression pills as live React nodes,
  // so their glyph and hover tone survive the swap. Folded and variant-group
  // chips never clamp (their layouts are unclamped by design), and their
  // render branches ignore any clamp a prior eligible shape left behind.
  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl || chipExpandedRef.current) return

    if (chipTextClamp) {
      textEl.classList.add('chip-text-truncated')
      syncClampedTitleFadeEnd(textEl, chipTextClamp.width)
      return
    }

    const previousMeasurement = chipTextMeasurementRef.current
    if (
      previousMeasurement?.element === textEl &&
      previousMeasurement.key === chipTextClampKey &&
      previousMeasurement.clampEligible === chipTextClampEligible &&
      chipTextMetricsEqual(previousMeasurement.metrics, chipTextMetrics)
    ) {
      return
    }

    // The parent masonry layout assigns the card's final inline width later in
    // this same layout-effect phase. Measuring its unconstrained grid width here
    // would be discarded immediately by the post-pack validation below.
    if (waitsForInitialMasonryWidth(textEl)) return

    const nextLayout = measureChipTextLayout(textEl, chipTextClampEligible, chipTextClampKey)
    chipTextMeasurementRef.current = {
      clampEligible: chipTextClampEligible,
      element: textEl,
      key: chipTextClampKey,
      masonryCardWidth: getChipTextMasonryCardWidth(textEl),
      metrics: nextLayout.metrics
    }
    setChipTextLayout((current) => chipTextLayoutEqual(current, nextLayout) ? current : nextLayout)
    // Resize-observer metrics carry width changes back through chipTextMetrics,
    // which invalidates the captured rows without re-reading unchanged titles.
  }, [chipExpanded, chipTextClamp, chipTextClampEligible, chipTextClampKey, chipTextMetrics])

  // The parent masonry pass owns the card's final width. Its pre-paint callback
  // measures initially deferred titles once, while later packs remeasure only
  // titles whose live width actually changed.
  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    const createPackedLayoutMeasurement = (): PageChipTextLayoutMeasurementJob => ({
      read() {
        const masonryCardWidth = getChipTextMasonryCardWidth(textEl)
        const reading = readChipTextLayout(textEl, chipTextClampEligible, chipTextClampKey)
        return () => {
          if (chipTextRef.current !== textEl || chipExpandedRef.current) return
          const nextLayout = applyChipTextLayout(textEl, reading)
          chipTextMeasurementRef.current = {
            clampEligible: chipTextClampEligible,
            element: textEl,
            key: chipTextClampKey,
            masonryCardWidth,
            metrics: nextLayout.metrics
          }
          setChipTextLayout((current) => chipTextLayoutEqual(current, nextLayout) ? current : nextLayout)
        }
      }
    })
    const validatePackedWidth = (): PageChipTextLayoutMeasurementJob | null => {
      if (chipTextRef.current !== textEl || chipExpandedRef.current) return null
      const previousMeasurement = chipTextMeasurementRef.current
      if (
        previousMeasurement?.element !== textEl ||
        previousMeasurement.key !== chipTextClampKey ||
        previousMeasurement.clampEligible !== chipTextClampEligible
      ) {
        return createPackedLayoutMeasurement()
      }
      const masonryCardWidth = getChipTextMasonryCardWidth(textEl)
      // Masonry controls the card's explicit inline width. If that width and
      // the title identity are unchanged, a second pack cannot change this
      // title's available width, so avoid forcing another live box read.
      if (
        masonryCardWidth &&
        previousMeasurement.masonryCardWidth === masonryCardWidth
      ) {
        return null
      }
      const width = getChipTextWidth(textEl)
      if (Math.abs(previousMeasurement.metrics.width - width) < CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX) {
        return null
      }
      return createPackedLayoutMeasurement()
    }
    return registerPageChipTextLayoutValidation(textEl, validatePackedWidth)
  }, [chipTextClampEligible, chipTextClampKey])

  // Folded and title-variant text can still remount when shouldExpandChip flips,
  // so a mount-once registration would keep observing the dead element and
  // resize-driven metric updates would stop. Re-register against the current
  // element on every render instead.
  const observedChipTextElRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const textEl = chipTextRef.current
    const previous = observedChipTextElRef.current
    if (previous === textEl) return

    const observer = getChipTextResizeObserver()
    if (previous) {
      observer.unobserve(previous)
      chipTextTruncationCallbacks.delete(previous)
    }
    observedChipTextElRef.current = textEl
    if (!textEl) return

    chipTextTruncationCallbacks.set(textEl, ({ hasExpandableContent, isTruncated, width }) => {
      setChipTextLayout((current) => {
        const nextMetrics = { hasExpandableContent, isTruncated, width }
        return chipTextMetricsEqual(current.metrics, nextMetrics)
          ? current
          : { ...current, metrics: nextMetrics }
      })
    })
    observer.observe(textEl, chipTextMeasuredSizes.get(textEl))
  })

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- the cleanup reads observedChipTextElRef at unmount time deliberately: it must unobserve whichever element is registered THEN, not the mount-time one.
  useEffect(() => {
    let disposed = false
    const onFontsDone = () => {
      if (disposed) return
      chipTextMeasurementRef.current = null
      setChipTextLayout((current) => current.clamp ? { ...current, clamp: null } : current)
      updateChipTextMeasurementsRef.current(chipTextRef.current)
    }
    const unsubscribeFontMetrics = subscribeFontMetricsInvalidation(onFontsDone)

    return () => {
      disposed = true
      unsubscribeFontMetrics()
      const observed = observedChipTextElRef.current
      if (observed) {
        getChipTextResizeObserver().unobserve(observed)
        chipTextTruncationCallbacks.delete(observed)
        observedChipTextElRef.current = null
      }
    }
  }, [])

  function isKeyboardActivation(e: KeyboardEvent<HTMLElement>) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function focusChipUrl(
    targetUrl: string | undefined,
    target?: { rawUrl?: string; tabId?: number | string }
  ) {
    if (!targetUrl) return
    if (typeof target?.tabId === 'number') {
      // A rendered numeric id represents one physical tab. Every result other
      // than focused is still terminal here: widening a stale/failed exact
      // target to another URL on the same host can activate the wrong chip.
      const result = await focusExistingTabTargetResult({
        tabId: target.tabId,
        url: targetUrl,
        ...(target.rawUrl === undefined ? {} : { rawUrl: target.rawUrl })
      })
      const message = tabFocusResultToastMessage(result.status)
      if (message) showToast(message)
      return
    }
    // Synthetic/read-only/closed-saved chips have no physical id. Their URL
    // fallback is exact and opens only after a confirmed no-match read.
    const result = await focusExactTabOrOpenResult(targetUrl)
    if (result.status === 'opened') return
    if (result.status === 'open-failed') {
      showToast('Could not open page')
      return
    }
    const message = tabFocusResultToastMessage(result.status)
    if (message) showToast(message)
  }

  async function activateChipTarget(
    e: ChipActivationModifiers | undefined,
    targetUrl: string | undefined,
    sourceType: DashboardChipData['sourceType'],
    target?: {
      rawUrl?: string
      tabId?: number | string
      isApp?: boolean
      retainedPageIdentity?: string
      retainedPageClosureToken?: string
    },
    focusOrigin?: EventTarget | null
  ) {
    if (!targetUrl && sourceType !== 'retained-page') return
    await setPreview('')
    const mode = chipActivationMode(e, navigator.platform)
    if (sourceType === 'retained-page') {
      const focusRecovery = capturePageChipFocusRecovery(focusOrigin)
      const targetDisappears = await activateRetainedPageTarget(target || {}, mode)
      focusRecovery?.complete(targetDisappears)
      return
    }
    if (sourceType === 'saved-page') {
      await activateSavedPageTarget({ tabUrl: targetUrl || '', isApp: !!target?.isApp }, mode)
      return
    }
    if (!targetUrl) return
    const activationResult = await performDashboardItemActivation(mode, {
      tabUrl: targetUrl,
      ...(target?.tabId === undefined ? {} : { tabId: target.tabId }),
      ...(target?.rawUrl === undefined ? {} : { rawUrl: target.rawUrl })
    })
    if (activationResult === 'unhandled') await focusChipUrl(targetUrl, target)
  }

  function defaultTitleVariantChip() {
    if (!isTitleVariantGroup) return undefined
    return titleVariantChips.find((variant) => !!variant.activeChipFrame && !variant.activeInOtherWindow)
      || titleVariantChips.find((variant) => !!variant.activeInOtherWindow)
      || (titleVariantChips.every(isClosedSavedDashboardTab)
        ? titleVariantChips.find((variant) => variant.sourceType === 'saved-page')
        : undefined)
      || titleVariantChips[0]
  }

  function previewDefaultTitleVariant() {
    const variant = defaultTitleVariantChip()
    if (!variant) return
    setPreview(variant.tabUrl, previewUrlsForChip(variant), variant)
  }

  function titleVariantEventTargetsExactVariant(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('.chip-title-variant, .chip-title-variant-actions, .chip-title-variant-action')
  }

  function titleVariantEventTargetsDefaultSurfaceBlocker(target: EventTarget | null) {
    if (!(target instanceof Element)) return false
    if (titleVariantEventTargetsExactVariant(target)) return true
    if (target.closest('[data-tabout-part="audio-toggle"]')) return true
    const faviconFrame = target.closest('.chip-favicon-frame')
    return !!faviconFrame?.querySelector('.chip-close-favicon')
  }

  function setDefaultVariantSurfaceHover(active: boolean) {
    chipSlotRef.current?.toggleAttribute('data-tabout-default-surface-hover', active)
  }

  function previewDefaultTitleVariantSurface(target: EventTarget | null) {
    if (titleVariantEventTargetsDefaultSurfaceBlocker(target)) {
      setDefaultVariantSurfaceHover(false)
      return false
    }
    setDefaultVariantSurfaceHover(true)
    previewDefaultTitleVariant()
    return true
  }

  async function onFocus(e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    if (isFolded) return
    await activateChipTarget(e, chip.tabUrl, chip.sourceType, chip, e?.currentTarget)
  }

  async function onPageChipTooltipClick(e: MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!parentInteractive) return
    await onFocus(e)
  }

  async function onChipKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus(e)
  }

  function onChipPointerDown(e: MouseEvent<HTMLDivElement>) {
    // Shift-click moves the tab into a new window; ⌘/⌃-click moves it into this window.
    // Cancel the browser's native text selection for those gestures only so the chip behaves
    // like a link (a plain click still drag-selects). See tab-activation.ts.
    if (shouldSuppressSelectionForGesture(e, navigator.platform)) e.preventDefault()
  }

  // The whole grouped-chip surface is the default-variant target: clicks on
  // the exact pills, their action rails, the favicon close, and the audio
  // toggle never reach these handlers (each stops propagation), so only
  // title/blank-surface clicks activate the default variant.
  async function onVariantGroupChipClick(e: MouseEvent<HTMLDivElement>) {
    if (titleVariantEventTargetsExactVariant(e.target)) return
    const variant = defaultTitleVariantChip()
    if (!variant) return
    await activateChipTarget(e, variant.tabUrl, variant.sourceType, variant, e.currentTarget)
  }

  function onVariantGroupChipMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (shouldSuppressSelectionForGesture(e, navigator.platform)) e.preventDefault()
  }

  function onVariantGroupChipMouseEnter(e: MouseEvent<HTMLDivElement>) {
    if (!previewDefaultTitleVariantSurface(e.target)) return
    openChipExpansion()
  }

  function onVariantGroupChipMouseMove(e: MouseEvent<HTMLDivElement>) {
    if (!previewDefaultTitleVariantSurface(e.target)) return
    if (chipExpandedRef.current) return
    openChipExpansion()
  }

  function onVariantGroupChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  async function onEnvClick(e: MouseEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    e.stopPropagation()
    await activateChipTarget(e, env.tabUrl, env.sourceType || chip.sourceType, env, e.currentTarget)
  }

  async function onEnvKeyDown(e: KeyboardEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    e.stopPropagation()
    await activateChipTarget(e, env.tabUrl, env.sourceType || chip.sourceType, env, e.currentTarget)
  }

  function setPreview(url: string, matchUrls: readonly string[] = [url], target?: Pick<DashboardChipData, 'tabId'>) {
    const tabId = typeof target?.tabId === 'number' ? target.tabId : undefined
    return onHoverUrlChange?.(url || '', 'chip', matchUrls, tabId)
  }

  function previewUrlsForChip(target: DashboardChipData): string[] {
    return pageTargetMatchUrls(target)
  }

  function captureContextMenuFocusRecovery() {
    contextMenuFocusRecoveryRef.current?.cancel()
    contextMenuFocusRecoveryRef.current = capturePageChipFocusRecovery(
      document.activeElement
    )
  }

  function onChipContextMenuOpenChange(open: boolean) {
    contextMenuOpenRef.current = open
    if (open) {
      captureContextMenuFocusRecovery()
      openChipExpansion()
      if (isTitleVariantGroup) {
        previewDefaultTitleVariant()
      } else {
        setPreview(primaryPreviewUrl, previewUrlsForChip(chip), chip)
      }
      return
    }
    closeChipExpansion()
    setPreview('')
  }

  function onEnvContextMenuOpenChange(open: boolean, env: DashboardChipEnv) {
    contextMenuOpenRef.current = open
    if (open) {
      captureContextMenuFocusRecovery()
      setPreview(env.tabUrl, [env.tabUrl, env.rawUrl], env)
      return
    }
    setPreview('')
  }

  function onTitleVariantContextMenuOpenChange(open: boolean, variant: DashboardChipData) {
    contextMenuOpenRef.current = open
    if (open) {
      captureContextMenuFocusRecovery()
      setPreview(variant.tabUrl, previewUrlsForChip(variant), variant)
      return
    }
    setPreview('')
  }

  function onChipMouseEnter() {
    if (isFolded) return
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip), chip)
  }

  function onChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function openChipExpansion() {
    if (chip.iconOnly) return
    const textEl = chipTextRef.current
    const measuredExpandable = hasTitleSuppressionMarkers || hasStructuralPlaceholders || chipTextHasExpandableContent(textEl)
    if (!measuredExpandable) return
    // Expansion geometry is intentionally measured only when the interaction
    // opens it. Measuring every collapsed chip on mount and resize multiplies
    // layout work across the whole dashboard before any expansion is needed.
    // Only measure from the collapsed source DOM. Re-measuring while already
    // expanded feeds the hydrated expanded markers (whose suppressed text is now
    // a real text node) back into getExpandedPageChipLineHtml, which re-captures
    // the marker on two adjacent line ranges and duplicates it.
    if (!chipExpandedRef.current) {
      updateChipTextMeasurements(textEl)
      updateChipSlotMeasurements()
    }
    chipExpansionController.open()
  }

  function closeChipExpansion() {
    chipExpansionController.close({ delayed: false })
  }

  useEffect(() => {
    if (!chipExpanded) return
    const closeNow = () => {
      chipExpansionController.closeNow()
    }
    const closeOnPointerMove = (event: globalThis.PointerEvent) => {
      if (contextMenuOpenRef.current) return
      // Measure the EXPANDED chip, not the original slot: the expanded chip floats
      // wider/taller than its 1:1 slot, so testing the slot rect collapsed the chip
      // the instant the pointer crossed into the revealed overflow — blinking it shut
      // at the border before the revealed content could be reached. The expanded
      // bounding box is the complete pointer region; leaving it closes immediately.
      const expandedChipEl = chipSlotRef.current?.querySelector<HTMLElement>('.page-chip')
      if (expandedChipEl?.matches(':focus-visible')) return
      const rect = expandedChipEl?.getBoundingClientRect() ?? chipSlotRef.current?.getBoundingClientRect()
      if (!rect) return
      const insideExpandedChip =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      if (!insideExpandedChip) closeNow()
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
  }, [chipExpanded, chipExpansionController])

  function onChipTextPointerEnter(e: PointerEvent<HTMLSpanElement>) {
    updateChipTextMeasurements(e.currentTarget)
  }

  function onChipTooltipOpenChange(open: boolean) {
    setChipTooltipOpen(open)
  }

  function onChipFocus(e: FocusEvent<HTMLDivElement>) {
    if (isFolded) return
    if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) openChipExpansion()
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip), chip)
  }

  function onChipBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    closeChipExpansion()
    setPreview('')
  }

  function onChipPointerLeave(e: PointerEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (e.currentTarget.matches(':focus-visible')) return
    if (chipExpandedRef.current) {
      const rect = e.currentTarget.getBoundingClientRect()
      const insideExpandedBounds =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      // Rounded corners can stop DOM hover while the pointer is still inside
      // the visible expansion bounds. Let the window pointer tracker close it
      // once the pointer genuinely leaves that box.
      if (insideExpandedBounds) return
    }
    closeChipExpansion()
  }

  function onChipPointerEnter() {
    openChipExpansion()
  }

  function isPointerInsideChipSlot(e: PointerEvent<HTMLDivElement>) {
    const slotRect = chipSlotRef.current?.getBoundingClientRect()
    if (!slotRect) return true
    return (
      e.clientX >= slotRect.left &&
      e.clientX <= slotRect.right &&
      e.clientY >= slotRect.top &&
      e.clientY <= slotRect.bottom
    )
  }

  function onChipPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (chipExpandedRef.current) return
    if (!isPointerInsideChipSlot(e)) return
    openChipExpansion()
  }

  function onEnvMouseEnter(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl], env)
  }

  function onEnvMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl, [primaryPreviewUrl], chip)
      return
    }
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function onEnvFocus(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl], env)
  }

  function onEnvBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl, [primaryPreviewUrl], chip)
      return
    }
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  async function onClose(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()

    await closeChipTarget({
      tabUrl: chip.tabUrl,
      ...(chip.tabId === undefined ? {} : { tabId: chip.tabId }),
      ...(chip.chromePinned === undefined ? {} : { expectedPinned: chip.chromePinned }),
      ...(chip.chromeGroupId === undefined ? {} : { expectedGroupId: chip.chromeGroupId }),
      envs: isFolded ? foldedCloseTargets : envs,
      onAfterClose: () => {
        setPreview('')
      }
    })
  }

  async function onDeleteHistory(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget
    const urls = Array.from(new Set(isFolded ? envs.flatMap((env) => env.tabUrl ? [env.tabUrl] : []) : chip.tabUrl ? [chip.tabUrl] : []))
    if (urls.length === 0) return

    const result = await deleteHistoryUrls({ urls })
    if (historyDeleteFullyRemoved(urls.length, result)) {
      startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
    }
    setPreview('')
  }

  function onToggleChipAudio() {
    if (!chip.audioState) return
    void setChipTargetMuted({
      tabUrl: chip.tabUrl,
      envs: chip.envs,
      muted: nextMutedForAudioState(chip.audioState)
    })
  }

  function onToggleChipSuspend(e: StopPropagationEvent) {
    e.stopPropagation()
    void suspendChipTarget({ tabUrl: chip.tabUrl, envs: chip.envs })
  }

  function onReloadPageTarget(e: StopPropagationEvent, target: Pick<DashboardChipData, 'tabId' | 'tabUrl'>) {
    e.stopPropagation()
    void reloadTabTarget(target)
  }

  function onDuplicatePageTarget(e: StopPropagationEvent, target: Pick<DashboardChipData, 'tabId' | 'tabUrl'>) {
    e.stopPropagation()
    void duplicateTabTarget(target)
  }

  async function onRemoveRetainedPage(
    e: StopPropagationEvent,
    target: Pick<
      DashboardChipData,
      'retainedPageIdentity' | 'retainedPageClosureToken'
    >
  ) {
    e.stopPropagation()
    const focusRecovery = contextMenuFocusRecoveryRef.current
    contextMenuFocusRecoveryRef.current = null
    const targetDisappears = await removeRetainedPageTarget(target)
    focusRecovery?.complete(targetDisappears)
    setPreview('')
  }

  async function onToggleSavedPage(e: StopPropagationEvent) {
    e.stopPropagation()
    if (chip.saved) {
      await removeSavedPageTarget(chip.savedPageKey || chip.tabUrl)
    } else {
      await savePageTarget({
        url: chip.tabUrl,
        rawUrl: chip.rawUrl,
        title: chip.actionTitle || chip.title || chip.tooltip,
        favIconUrl: chip.actionFaviconUrl || chip.faviconUrl,
        isTabOut: false,
        isApp: chip.isApp
      })
    }
    setPreview('')
  }

  async function onTogglePagePin(e: StopPropagationEvent) {
    e.stopPropagation()
    if (!chip.pagePinId) return
    await onTogglePinnedPageChip?.(chip.pagePinId)
    onLayoutChange?.({ animate: true })
    setPreview('')
  }

  async function onCopyTitleText(e: StopPropagationEvent, titleText: string) {
    e.stopPropagation()
    if (!titleText) return

    try {
      await navigator.clipboard.writeText(titleText)
      showToast('Page title copied')
    } catch {
      showToast('Could not copy page title')
    }
  }

  async function onCopyUrlText(e: StopPropagationEvent, urlText: string) {
    e.stopPropagation()
    if (!urlText) return

    try {
      await navigator.clipboard.writeText(urlText)
      showToast('Page URL copied')
    } catch {
      showToast('Could not copy page URL')
    }
  }

  async function onTitleVariantFocus(e: MouseEvent<HTMLButtonElement>, variant: DashboardChipData) {
    e.stopPropagation()
    await activateChipTarget(e, variant.tabUrl, variant.sourceType, variant, e.currentTarget)
  }

  function onTitleVariantMouseEnter(variant: DashboardChipData) {
    setDefaultVariantSurfaceHover(false)
    setPreview(variant.tabUrl, previewUrlsForChip(variant), variant)
  }

  function onTitleVariantMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      if (!titleVariantEventTargetsDefaultSurfaceBlocker(e.relatedTarget)) {
        previewDefaultTitleVariantSurface(e.relatedTarget)
      } else {
        setDefaultVariantSurfaceHover(false)
      }
      return
    }
    if (contextMenuOpenRef.current) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  function onTitleVariantFocusIn(variant: DashboardChipData) {
    setDefaultVariantSurfaceHover(false)
    setPreview(variant.tabUrl, previewUrlsForChip(variant), variant)
  }

  function onTitleVariantBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  async function onCloseTitleVariant(e: MouseEvent<HTMLButtonElement>, variant: DashboardChipData) {
    e.stopPropagation()
    if (variant.sourceType === 'history') {
      await deleteHistoryUrls({
        urls: [variant.tabUrl].filter(Boolean),
        onAfterDelete: async () => setPreview('')
      })
      return
    }

    await closeChipTarget({
      tabUrl: variant.tabUrl,
      ...(variant.tabId === undefined ? {} : { tabId: variant.tabId }),
      ...(variant.chromePinned === undefined ? {} : { expectedPinned: variant.chromePinned }),
      ...(variant.chromeGroupId === undefined ? {} : { expectedGroupId: variant.chromeGroupId }),
      onAfterClose: async () => setPreview('')
    })
  }

  async function onCloseAllVariants(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget
    const { historyUrls, tabEnvs } = variantCloseTargets
    if (historyUrls.length === 0 && tabEnvs.length === 0) return

    // Close tabs and delete history without each call running its own removal
    // animation; animate the whole group chip out once, after both resolve.
    const tabResult = tabEnvs.length > 0
      ? await closeChipTarget({ tabUrl: chip.tabUrl, envs: tabEnvs })
      : null
    const historyResult = historyUrls.length > 0
      ? await deleteHistoryUrls({ urls: historyUrls })
      : null

    if (
      tabEnvs.length === 0 &&
      !chipCloseLeavesSavedPage &&
      chipEl &&
      titleVariantGroupRemovalConfirmed({
        requestedTabCount: tabEnvs.length,
        tabResult,
        requestedHistoryCount: historyUrls.length,
        historyResult
      })
    ) {
      startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
    }
    setPreview('')
  }

  async function onToggleSavedTitleVariant(e: StopPropagationEvent, variant: DashboardChipData) {
    e.stopPropagation()
    if (variant.saved) {
      await removeSavedPageTarget(variant.savedPageKey || variant.tabUrl)
    } else {
      await savePageTarget({
        url: variant.tabUrl,
        rawUrl: variant.rawUrl,
        title: variant.actionTitle || variant.title || variant.tooltip,
        favIconUrl: variant.actionFaviconUrl || variant.faviconUrl,
        isTabOut: false,
        isApp: variant.isApp
      })
    }
    setPreview('')
  }

  async function onTogglePinnedTitleVariant(e: StopPropagationEvent, variant: DashboardChipData) {
    e.stopPropagation()
    if (!variant.pagePinId) return
    await onTogglePinnedPageChip?.(variant.pagePinId)
    onLayoutChange?.({ animate: true })
    setPreview('')
  }

  async function onToggleSavedEnv(e: StopPropagationEvent, env: DashboardChipEnv) {
    e.stopPropagation()
    if (env.saved) {
      await removeSavedPageTarget(env.savedPageKey || env.tabUrl)
    } else {
      await savePageTarget({
        url: env.tabUrl,
        rawUrl: env.rawUrl,
        title: env.actionTitle || env.title || chip.actionTitle || chip.title || chip.tooltip,
        favIconUrl: env.actionFaviconUrl || env.faviconUrl || chip.actionFaviconUrl || chip.faviconUrl,
        isTabOut: false,
        isApp: !!env.isApp
      })
    }
    setPreview('')
  }

  const trim = chipTrim({
    activeChipFrame: !!chip.activeChipFrame,
    activeInOtherWindow: !!chip.activeInOtherWindow,
    isCurrentTabOut: !!chip.isCurrentTabOut,
    closedSavedPage: isClosedSavedPage,
    readOnlyFilterResult,
    folded: isFolded,
    titleVariantGroup: isTitleVariantGroup,
    iconOnly: !!chip.iconOnly,
    isApp: !!chip.isApp,
    expanded: chipExpanded ? { grewTaller: chipExpansionGeometry.grewTaller, y: chipExpansionGeometry.y } : null
  })
  const dupeCount = chip.sourceType === 'retained-page' ? 1 : (chip.dupeCount || 1)
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const loadingLabel = chip.loading ? 'Loading' : ''
  const pinnedLabel = chip.pagePinned ? 'Pinned' : ''
  const activeLabel = chip.activeInOtherWindow ? 'Active in another window' : ''
  const savedLabel = chip.saved ? (isClosedSavedPage ? 'Closed saved page' : 'Saved page') : ''
  const hiddenTitleLabel = suppressedTitleParts.length > 0 ? `Suppressed title text: ${suppressedTitleParts.join(' · ')}` : ''
  const titleVariantLabel = isTitleVariantGroup ? `${titleVariantChips.length} URL variants: ${titleVariantChips.map((variant) => variant.pathSuffix || variant.tabUrl).join(' · ')}` : ''
  const chipLabel = [chip.tooltip, loadingLabel, pinnedLabel, titleVariantLabel, hiddenTitleLabel, duplicateLabel, activeLabel, savedLabel].filter(Boolean).join(' · ')
  const groupCloseCount = isTitleVariantGroup ? variantCloseCount : isFolded ? foldedCloseTargets.length : 1
  const closeTargetsAllHistory = isTitleVariantGroup
    ? variantCloseTargets.tabEnvs.length === 0 && variantCloseTargets.historyUrls.length > 0
    : isHistorySource
  const closeActionLabel = groupCloseActionLabel({ count: groupCloseCount, allHistory: closeTargetsAllHistory })
  const savedActionLabel = chip.saved ? 'Remove saved page' : 'Save page'
  const pagePinActionLabel = chip.pagePinned ? 'Unpin' : 'Pin'
  const chipTitleText = titleTextForChip(chip)
  const chipUrlText = pageTargetUrl(chip)
  const {
    canClose: canCloseChip,
    canRemoveRetained,
    canToggleSaved: canToggleSavedPage,
    canUseChromeTabActions,
    showSavedHint
  } = pageChipTargetActionPolicy(chip, { interactive: parentInteractive })
  const canTogglePagePin = !!chip.pagePinId && typeof onTogglePinnedPageChip === 'function'
  // Unlike the other can* flags, canShowSuspend intentionally does NOT gate on
  // parentInteractive: folded groups (not parentInteractive) still expose Suspend.
  const canShowSuspend = chipCanShowSuspend(chip)
  const suspendEnabled = chipSuspendableTargetCount(chip) > 0
  const canCloseFoldedGroup = isFolded && foldedCloseTargets.length > 0
  const canCloseVariantGroup = isTitleVariantGroup && variantCloseCount > 0
  const canUseCopyContextMenu = parentInteractive && (!!chipTitleText || !!chipUrlText)
  const showFaviconCloseAction = !chip.iconOnly && (canCloseChip || canCloseFoldedGroup || canCloseVariantGroup)
  const showDefaultFavicon = !chip.faviconUrl && (!isReadOnlySource || isClosedSavedPage)
  const showFaviconFrame = !!chip.faviconUrl || showDefaultFavicon || dupeCount > 1 || showFaviconCloseAction
  const rightActionCount = showSavedHint ? 1 : 0
  const chipHoverFadeWidth = rightActionCount === 0 ? '0px' : rightActionCount === 1 ? '56px' : '88px'
  const style: CSSVariableProperties = {
    '--chip-hover-fade-bg': trim.styleVars.fadeBg,
    '--chip-hover-fade-width': chipHoverFadeWidth,
    '--chip-hover-border': trim.styleVars.hoverBorder,
    '--chip-interaction-bg': trim.styleVars.interactionBg,
    '--chip-target-interaction-bg': PAGE_CHIP_TARGET_INTERACTION_BG,
    '--chip-rest-bg': trim.styleVars.restBg,
    ...(chip.isGrouped ? { '--group-color': chip.groupDotColor ?? undefined } : {})
  }
  const hasTitleSuppressionMarkers = suppressedTitleParts.length > 0 || chip.displaySegments.some(isTitleSuppressionSegment)
  const hasStructuralPlaceholders = chip.displaySegments.some((segment) => isStructuralPlaceholderSegment(segment) && !!(segment.label || chip.pathGroupLabel))
  const shouldExpandChip = !chip.iconOnly && (hasExpandableContent || hasTitleSuppressionMarkers || hasStructuralPlaceholders)
  const chipSlotStyle: CSSVariableProperties | undefined = chipExpanded && chipSlotSize.width > 0 && chipSlotSize.height > 0 ? {
    height: `${chipSlotSize.height}px`,
    width: `${chipSlotSize.width}px`
  } : undefined
  const chipExpandedMaxWidth = chipExpansionGeometry.maxWidth > 0 ? `${chipExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const chipExpandedWidth = chipExpansionGeometry.width > 0 ? `${chipExpansionGeometry.width}px` : chipExpandedMaxWidth
  const chipStyle: CSSVariableProperties = {
    ...style,
    ...(chipExpanded ? {
      '--page-chip-expanded-max-width': chipExpandedMaxWidth,
      '--page-chip-expanded-width': chipExpandedWidth,
      maxWidth: chipExpandedMaxWidth,
      width: chipExpandedWidth
    } : {})
  }
  const chipTooltipStyle: CSSVariableProperties = {
    '--page-chip-tooltip-max-width': 'calc(100vw - 16px)',
    maxWidth: 'min(var(--page-chip-tooltip-max-width), calc(100vw - 16px))'
  }
  function filterResultTargetInteractionStyle(
    target: Pick<DashboardChipEnv, 'sourceType' | 'closedSaved'>
  ): CSSVariableProperties | undefined {
    const sourceType = target.sourceType ?? chip.sourceType
    const isClosedTarget = isReadOnlyDashboardSourceType(sourceType) || isClosedSavedDashboardTab({
      ...(sourceType === undefined ? {} : { sourceType }),
      ...(target.closedSaved === undefined ? {} : { closedSaved: target.closedSaved })
    })
    if (!hasFilter || !isClosedTarget) return undefined
    return { '--chip-target-interaction-bg': trim.styleVars.closedInteractionBg }
  }
  const hoverMatched = hoverMatchKey !== ''

  function suppressionMarkerNode(part: string, mode: ChipTextRenderMode, key: string, markerClassName = '') {
    const partKey = part.trim().toLowerCase()
    const active = activeSuppressedTitleKey !== '' && partKey === activeSuppressedTitleKey
    const tone = active ? activeSuppressionTone : titleSuppressionToneForText(part, suppressedTitleToneByText)
    const label = `Suppressed title text: ${part}`
    const marker = (
      <span
        key={key}
        className={cn(
          'chip-title-suppression-marker inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-[rgba(115,115,115,0.08)] px-0.75 text-[12px] leading-3 text-muted-foreground align-middle [corner-shape:squircle] group-[.page-chip-expanded]/page-chip:h-auto group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:items-baseline group-[.page-chip-expanded]/page-chip:rounded-lg group-[.page-chip-expanded]/page-chip:border-0 group-[.page-chip-expanded]/page-chip:px-1 group-[.page-chip-expanded]/page-chip:leading-[inherit] group-[.page-chip-expanded]/page-chip:font-medium group-[.page-chip-expanded]/page-chip:align-baseline group-[.page-chip-expanded]/page-chip:[box-decoration-break:clone]',
          markerClassName,
          titleSuppressionMarkerClass(tone, active)
        )}
        aria-label={label}
      >
        <svg className="chip-title-suppression-glyph h-1.75 w-2 group-[.page-chip-expanded]/page-chip:hidden" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.25 5.4c1.25-1.45 2.5-1.45 3.75 0s2.5 1.45 3.75 0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
        <span className="chip-title-suppression-label hidden group-[.page-chip-expanded]/page-chip:inline">
          {highlightedTextNodes(part, highlightTerms, `${key}-label`)}
        </span>
      </span>
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={key}
          className={cn(
            PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME,
            markerClassName,
            titleSuppressionMarkerClass(tone, active)
          )}
          aria-label={label}
        >
          {highlightedTextNodes(part, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function trailingSuppressionMarkerNodes(mode: ChipTextRenderMode, target: DashboardChipData = chip, keyPrefix: string = mode) {
    const targetSuppressedTitleParts = target.suppressedTitleParts || []
    if (targetSuppressedTitleParts.length === 0) return null

    const inlineSuppressedTitleKeys = new Set(
      target.displaySegments.flatMap((segment) => (
        isTitleSuppressionSegment(segment)
          ? [segment.titleSuppression.trim().toLowerCase()]
          : []
      ))
    )
    const trailingParts = targetSuppressedTitleParts.filter((part) => !inlineSuppressedTitleKeys.has(part.trim().toLowerCase()))

    return trailingParts.map((part, index) => {
      const markerSpacingClass = mode === 'chip' ? (index === 0 ? 'ml-1' : 'ml-0.5') : ''
      const marker = suppressionMarkerNode(
        part,
        mode,
        `${keyPrefix}-trailing-title-suppression-marker-${part}`,
        markerSpacingClass
      )

      if (mode === 'tooltip') {
        return (
          <span key={`${keyPrefix}-trailing-title-suppression-${part}-${index}`}>
            {' '}
            {marker}
          </span>
        )
      }

      return marker
    })
  }

  function structuralPlaceholderNode(segment: { placeholder: true; label?: string }, mode: ChipTextRenderMode, key: string, fallbackLabelArg?: string) {
    const fallbackLabel = fallbackLabelArg !== undefined ? fallbackLabelArg : chip.pathGroupLabel
    const hiddenLabel = segment.label || fallbackLabel
    const marker = (
      <span
        key={key}
        className="chip-strip-indicator inline-flex size-4 items-center justify-center rounded-full bg-[rgba(115,115,115,0.1)] text-xs leading-none font-medium text-muted-foreground align-baseline group-[.page-chip-expanded]/page-chip:h-auto group-[.page-chip-expanded]/page-chip:w-auto group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:rounded-lg group-[.page-chip-expanded]/page-chip:px-1.5 group-[.page-chip-expanded]/page-chip:leading-[inherit] group-[.page-chip-expanded]/page-chip:[corner-shape:squircle]"
        aria-hidden={hiddenLabel ? undefined : true}
        aria-label={hiddenLabel || undefined}
      >
        <span className={hiddenLabel ? 'chip-strip-indicator-glyph group-[.page-chip-expanded]/page-chip:hidden' : undefined}>/</span>
        {hiddenLabel && (
          <span className="chip-strip-indicator-label hidden group-[.page-chip-expanded]/page-chip:inline">
            {highlightedTextNodes(hiddenLabel, highlightTerms, `${key}-label`)}
          </span>
        )}
      </span>
    )

    if (mode === 'tooltip' && hiddenLabel) {
      return (
        <span
          key={key}
          className={PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME}
          aria-label={hiddenLabel}
        >
          {highlightedTextNodes(hiddenLabel, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function envLabelNode(env: DashboardChipEnv, mode: ChipTextRenderMode) {
    const envSourceType = env.sourceType || chip.sourceType || 'tab'
    const envClosed = isClosedSavedDashboardTab({
      sourceType: envSourceType,
      closedSaved: !!env.closedSaved
    })
    const envLabel = envClosed
      ? `Open ${env.prefix} closed page`
      : `Focus ${env.prefix} tab${env.activeInOtherWindow ? ' (active in another window)' : ''}`
    const envSavedActionLabel = env.saved ? 'Remove saved page' : 'Save page'
    const {
      canRemoveRetained: canRemoveRetainedEnv,
      canToggleSaved: canToggleSavedEnv,
      canUseChromeTabActions: envCanUseChromeTabActions,
      showSavedHint: showSavedEnvHint
    } = pageChipTargetActionPolicy(env)
    const envTitleText = titleTextForEnv(env, chip)
    const envKey = env.rawUrl || env.tabUrl
    const envFilterResultCandidate = filterResultCandidateForTarget(env, chip.sourceType)
    const envClassName = cn(
      "chip-env inline-flex items-center rounded-lg border-0 bg-neutral-500/4.5 px-1.5 text-xs leading-[inherit] font-medium text-muted-foreground [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.']",
      isFolded && 'h-6 rounded-[7px] px-2',
      mode === 'chip' && 'clickable cursor-default transition-[background,color,box-shadow] duration-150 ease-[ease] hover:bg-(--chip-target-interaction-bg) hover:text-tab-live focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) data-[tabout-filter-result-selected=true]:bg-(--chip-target-interaction-bg) data-[tabout-filter-result-selected=true]:outline-1 data-[tabout-filter-result-selected=true]:outline-offset-1 data-[tabout-filter-result-selected=true]:outline-(--accent-amber) [&.page-chip-context-menu-open]:bg-(--chip-target-interaction-bg) [&.page-chip-context-menu-open]:text-tab-live',
      env.activeInOtherWindow && 'bg-neutral-600/7.5 text-tab-live shadow-[inset_0_0_0_1px_rgba(115,115,115,0.22)]'
    )

    if (mode === 'tooltip') {
      return (
        <span key={envKey} className={envClassName}>
          {highlightedTextNodes(env.prefix, highlightTerms, `tooltip-env-${env.prefix}`)}
        </span>
      )
    }

    const envFocusButton = (
      <button
        type="button"
        id={hasFilter ? envFilterResultCandidate.domId : undefined}
        data-tabout-retained-page-identity={envSourceType === 'retained-page' ? env.retainedPageIdentity : undefined}
        data-tabout-retained-page-closure-token={envSourceType === 'retained-page' ? env.retainedPageClosureToken : undefined}
        data-tabout-filter-result={hasFilter ? '' : undefined}
        data-tabout-filter-result-key={hasFilter ? envFilterResultCandidate.key : undefined}
        data-tabout-removal-key={`page:${env.rawUrl}`}
        className={envClassName}
        style={filterResultTargetInteractionStyle(env)}
        aria-label={envLabel}
        onClick={(e) => onEnvClick(e, env)}
        onKeyDown={(e) => onEnvKeyDown(e, env)}
        onMouseEnter={() => onEnvMouseEnter(env)}
        onMouseLeave={onEnvMouseLeave}
        onFocus={() => onEnvFocus(env)}
        onBlur={onEnvBlur}
      >
        {highlightedTextNodes(env.prefix, highlightTerms, `env-${env.prefix}`)}
      </button>
    )
    const envCanUseContextMenu = canToggleSavedEnv || canRemoveRetainedEnv || !!envTitleText || !!env.tabUrl
    const envFocusTarget = envCanUseContextMenu ? (
      <PageChipContextMenu
        savedActionLabel={canToggleSavedEnv ? envSavedActionLabel : undefined}
        saved={!!env.saved}
        onSavedSelect={canToggleSavedEnv ? (e) => onToggleSavedEnv(e, env) : undefined}
        onRemoveFromTabsSelect={canRemoveRetainedEnv ? (e) => onRemoveRetainedPage(e, env) : undefined}
        onReloadSelect={envCanUseChromeTabActions ? (e) => onReloadPageTarget(e, env) : undefined}
        onDuplicateSelect={envCanUseChromeTabActions ? (e) => onDuplicatePageTarget(e, env) : undefined}
        titleText={envTitleText}
        onCopyTitle={(e) => onCopyTitleText(e, envTitleText)}
        urlText={env.tabUrl}
        onCopyUrl={(e) => onCopyUrlText(e, env.tabUrl)}
        onOpenChange={(open) => onEnvContextMenuOpenChange(open, env)}
      >
        {envFocusButton}
      </PageChipContextMenu>
    ) : envFocusButton

    if (!showSavedEnvHint) return <span key={envKey} className="chip-env-shell relative inline-flex items-center">{envFocusTarget}</span>

    return (
      <span key={envKey} className="chip-env-shell group/env relative inline-flex items-center">
        {envFocusTarget}
        <span
          className="chip-env-saved-hint pointer-events-none absolute -top-1.5 -right-1.5 z-2 inline-flex size-4 cursor-default items-center justify-center rounded-full border border-tab-card bg-(--card-bg) p-0 text-(--accent-amber) opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.14)] group-hover/env:pointer-events-auto group-hover/env:opacity-100"
          aria-hidden="true"
        >
          <SavedPageIcon saved className="size-2.5" />
        </span>
      </span>
    )
  }

  function titleContentNode(mode: ChipTextRenderMode, target: DashboardChipData = chip, keyPrefix: string = mode, options: RenderTitleContentOptions = {}) {
    const includePathSuffix = options.includePathSuffix ?? true

    return (
      <>
        {target.pathGroupLabel && (
          <span className="chip-pathgroup mr-1.5 inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-muted-foreground align-baseline [corner-shape:squircle]">
            {highlightedTextNodes(pathGroupDisplayLabel(target.pathGroupLabel), highlightTerms, `${keyPrefix}-pathgroup`)}
          </span>
        )}
        {target.displaySegments.map((seg, index) => {
          if (typeof seg === 'string') {
            // A URL title has no spaces and only structural break points (/, -).
            // Under the chip's default `break-normal` it refuses to break at "/"
            // and overflows one clipped line, stranding a short tail (e.g.
            // "US.json") alone on line 2. overflow-wrap:break-word lets it wrap at
            // the "/" boundaries into balanced lines. Prose titles keep bionic +
            // the tuned break-normal path so short words never break awkwardly.
            return isUrlLikeTitle(seg)
              ? (
                <span key={`${keyPrefix}-url-${seg}`} className="chip-url-title wrap-break-word">
                  {highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`)}
                </span>
              )
              : highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`, createBionicTitleTextRenderer(seg))
          }
          if (isTitleSuppressionSegment(seg)) return suppressionMarkerNode(seg.titleSuppression, mode, `${keyPrefix}-inline-title-suppression-${index}`)
          if (isStructuralPlaceholderSegment(seg)) return structuralPlaceholderNode(seg, mode, `${keyPrefix}-structural-placeholder-${index}`, target.pathGroupLabel)
          return null
        })}
        {trailingSuppressionMarkerNodes(mode, target, keyPrefix)}
        {includePathSuffix && target.pathSuffix && (
          <>
            {' '}
            <span
              className={cn(
                'chip-path font-normal text-muted-foreground',
                mode === 'chip'
                  ? 'inline-block whitespace-nowrap group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:whitespace-normal group-[.page-chip-expanded]/page-chip:wrap-break-word'
                  : 'inline-block max-w-[calc(100%-6px)] whitespace-normal break-normal w-max wrap-break-word'
              )}
            >
              {highlightedTextNodes(target.pathSuffix, highlightTerms, `${keyPrefix}-path`)}
            </span>
          </>
        )}
      </>
    )
  }

  function titleVariantActionLabel(variant: DashboardChipData) {
    return `${variant.sourceType === 'history' ? 'Delete from history' : 'Close this tab'}: ${variant.pathSuffix || variant.tabUrl}`
  }

  function titleVariantNode(variant: DashboardChipData, index: number, mode: ChipTextRenderMode) {
    const label = variant.pathSuffix || variant.tabUrl || '/'
    const variantActive = !!(variant.activeChipFrame || variant.activeInOtherWindow)
    const variantCurrent = !!variant.activeChipFrame && !variant.activeInOtherWindow
    const variantHoverMatched = hoverMatchKey[index + 1] === '1'
    // Static marker consumed only by base.css: hovering the group's non-URL
    // surface highlights this pill via :hover CSS so it swaps with the exact
    // pill's own :hover inside one style recalc. Routing this highlight
    // through React state paints a one-frame rest-background flash instead.
    const variantIsDefaultTarget = defaultTitleVariantChip() === variant
    const variantDupeCount = variant.sourceType === 'retained-page' ? 1 : (variant.dupeCount || 1)
    const variantClosedSaved = isClosedSavedDashboardTab(variant)
    const {
      canClose: variantCanClose,
      canRemoveRetained: variantCanRemoveRetained,
      canToggleSaved: variantCanToggleSaved,
      canUseChromeTabActions: variantCanUseChromeTabActions,
      showSavedHint: variantShowSavedHint
    } = pageChipTargetActionPolicy(variant)
    const variantActionCount = (variantShowSavedHint ? 1 : 0) + (variantCanClose ? 1 : 0)
    const variantPagePinOwnSlot = !!variant.pagePinned && !variantCanClose
    const variantActionSlotCount = variantActionCount + (variantPagePinOwnSlot ? 1 : 0)
    const variantSavedActionLabel = variant.saved ? 'Remove saved page' : 'Save page'
    const variantPagePinActionLabel = variant.pagePinned ? 'Unpin' : 'Pin'
    const variantCanTogglePagePin = !!variant.pagePinId && typeof onTogglePinnedPageChip === 'function'
    const variantTitleText = titleTextForChip(variant)
    const variantCanUseContextMenu = variantCanToggleSaved || variantCanRemoveRetained || variantCanTogglePagePin || !!variantTitleText || !!variant.tabUrl
    const variantFilterResultCandidate = filterResultCandidateForTarget(variant, chip.sourceType)
    const variantPinnedLabel = variant.pagePinned ? 'Pinned' : ''
    const variantLabel = [variant.tooltip, variantPinnedLabel, variantDupeCount > 1 ? `${variantDupeCount} open copies` : '', variant.activeInOtherWindow ? 'Active in another window' : '', variant.saved ? (variantClosedSaved ? 'Closed saved page' : 'Saved page') : ''].filter(Boolean).join(' · ')
    // Variant rows carry no favicon, so the label text carries the liveness
    // signal the favicon would: dim when this variant has no awake tab.
    const variantDimmed = !!variant.suspended || variantClosedSaved
    const labelContent = (
      <>
        <span className={cn('chip-title-variant-label min-w-0 overflow-hidden text-left text-ellipsis whitespace-nowrap', variantDimmed && VARIANT_LABEL_DIM_CLASS_NAME)}>
          {highlightedTextNodes(label, highlightTerms, `${mode}-title-variant-${index}`)}
        </span>
        {variantDupeCount > 1 && (
          <span className="chip-title-variant-dupe inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[rgba(254,243,199,0.95)] px-1 text-[9px] leading-none font-bold tabular-nums text-[rgb(120,53,15)]">
            {variantDupeCount}
          </span>
        )}
      </>
    )
    const variantFocusButton = (
      <button
        type="button"
        id={hasFilter ? variantFilterResultCandidate.domId : undefined}
        data-tabout-retained-page-identity={variant.sourceType === 'retained-page' ? variant.retainedPageIdentity : undefined}
        data-tabout-retained-page-closure-token={variant.sourceType === 'retained-page' ? variant.retainedPageClosureToken : undefined}
        data-tabout-filter-result={hasFilter ? '' : undefined}
        data-tabout-filter-result-key={hasFilter ? variantFilterResultCandidate.key : undefined}
        data-tabout-layout-anchor={layoutScope ? '' : undefined}
        data-tabout-layout-key={layoutScope ? (variant.pagePinId || variant.rawUrl) : undefined}
        data-tabout-layout-scope={layoutScope || undefined}
        data-tabout-removal-anchor=""
        data-tabout-removal-key={`page:${variant.rawUrl}`}
        data-tabout-default-variant={variantIsDefaultTarget ? 'true' : undefined}
        style={filterResultTargetInteractionStyle(variant)}
        className={cn(
          'chip-title-variant clickable flex w-full max-w-full min-w-0 cursor-default items-center gap-1 rounded-none border-0 bg-transparent px-1.5 py-0.75 [font-size:inherit] leading-tight font-normal text-neutral-600 hover:bg-(--chip-target-interaction-bg) hover:text-tab-live focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) data-[tabout-filter-result-selected=true]:bg-(--chip-target-interaction-bg) data-[tabout-filter-result-selected=true]:outline-1 data-[tabout-filter-result-selected=true]:outline-offset-1 data-[tabout-filter-result-selected=true]:outline-(--accent-amber)',
          '[&.page-chip-context-menu-open]:bg-(--chip-target-interaction-bg) [&.page-chip-context-menu-open]:text-tab-live',
          variantActive && 'bg-neutral-600/7.5 text-tab-live',
          variantCurrent && 'bg-neutral-100 text-tab-live shadow-[inset_2px_0_0_0_var(--accent-amber)]',
          variantHoverMatched && 'bg-(--chip-target-interaction-bg) text-tab-live'
        )}
        aria-label={variantLabel}
        onClick={(e) => onTitleVariantFocus(e, variant)}
        onMouseEnter={() => onTitleVariantMouseEnter(variant)}
        onMouseLeave={onTitleVariantMouseLeave}
        onFocus={() => onTitleVariantFocusIn(variant)}
        onBlur={onTitleVariantBlur}
      >
        {labelContent}
      </button>
    )
    const variantFocusTarget = variantCanUseContextMenu ? (
      <PageChipContextMenu
        savedActionLabel={variantCanToggleSaved ? variantSavedActionLabel : undefined}
        saved={!!variant.saved}
        onSavedSelect={variantCanToggleSaved ? (e) => onToggleSavedTitleVariant(e, variant) : undefined}
        onRemoveFromTabsSelect={variantCanRemoveRetained ? (e) => onRemoveRetainedPage(e, variant) : undefined}
        onReloadSelect={variantCanUseChromeTabActions ? (e) => onReloadPageTarget(e, variant) : undefined}
        onDuplicateSelect={variantCanUseChromeTabActions ? (e) => onDuplicatePageTarget(e, variant) : undefined}
        pagePinActionLabel={variantCanTogglePagePin ? variantPagePinActionLabel : undefined}
        pagePinned={!!variant.pagePinned}
        onPagePinSelect={variantCanTogglePagePin ? (e) => onTogglePinnedTitleVariant(e, variant) : undefined}
        titleText={variantTitleText}
        onCopyTitle={(e) => onCopyTitleText(e, variantTitleText)}
        urlText={variant.tabUrl}
        onCopyUrl={(e) => onCopyUrlText(e, variant.tabUrl)}
        onOpenChange={(open) => onTitleVariantContextMenuOpenChange(open, variant)}
      >
        {variantFocusButton}
      </PageChipContextMenu>
    ) : (
      variantFocusButton
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={variant.rawUrl || variant.tabUrl}
          className="chip-title-variant inline-flex max-w-full items-center gap-1 rounded-lg bg-neutral-500/4.5 px-1.5 py-0.5 leading-tight font-normal text-neutral-600 [corner-shape:squircle]"
        >
          {labelContent}
        </span>
      )
    }

    return (
      <span
        key={variant.rawUrl || variant.tabUrl}
        className="chip-title-variant-shell relative flex w-full max-w-full min-w-0 items-center"
      >
        {variantFocusTarget}
        {variantActionSlotCount > 0 && (
          <span className={cn(
            'chip-title-variant-actions group/title-variant-actions absolute top-0 bottom-0 z-2 my-auto flex h-4.75 items-center gap-0.5',
            variantActionSlotCount === 1 && 'left-[-25.5px]',
            variantActionSlotCount > 1 && 'left-[-46.5px]'
          )}>
            {variantShowSavedHint && (
              <span
                className="chip-title-variant-saved-hint pointer-events-none inline-flex size-4.75 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-0 text-(--accent-amber) opacity-0 group-hover/title-variant-actions:pointer-events-auto group-hover/title-variant-actions:opacity-100"
                aria-hidden="true"
              >
                <SavedPageIcon saved className="size-3.5" />
              </span>
            )}
            {variantCanClose && (
              <span
                data-tabout-part="variant-close-hit-owner"
                className="chip-title-variant-close-hit-owner group/title-variant-close-owner relative inline-flex size-4.75 shrink-0 cursor-pointer items-center justify-center rounded-full"
              >
                <button
                  type="button"
                  data-tabout-part="variant-close-button"
                  className="chip-title-variant-action pointer-events-none absolute inset-0 inline-flex size-4.75 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 group-hover/title-variant-close-owner:pointer-events-auto group-hover/title-variant-close-owner:opacity-100 hover:bg-neutral-600/10 hover:text-foreground hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
                  aria-label={titleVariantActionLabel(variant)}
                  onClick={(e) => onCloseTitleVariant(e, variant)}
                  onMouseEnter={() => onTitleVariantMouseEnter(variant)}
                  onMouseLeave={onTitleVariantMouseLeave}
                  onFocus={() => onTitleVariantFocusIn(variant)}
                  onBlur={onTitleVariantBlur}
                >
                  <svg className="size-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            )}
            {variant.pagePinned && (
              <span className={cn(
                'chip-title-variant-page-pin-slot pointer-events-none inline-flex size-4.75 shrink-0 items-center justify-center',
                variantCanClose && 'absolute top-0 right-0 group-hover/title-variant-actions:opacity-0 group-focus-within/title-variant-actions:opacity-0'
              )}>
                <span
                  data-tabout-part="variant-page-pin"
                  data-pinned="true"
                  className="chip-title-variant-page-pin icon-[lucide--pin] size-2.5 text-muted-foreground"
                  aria-hidden="true"
                />
              </span>
            )}
          </span>
        )}
      </span>
    )
  }

  function titleVariantListNode(mode: ChipTextRenderMode) {
    if (!isTitleVariantGroup) return null
    return (
      <span className="chip-title-variant-list flex w-full max-w-full flex-col items-stretch pr-1.25 pb-1 divide-y divide-neutral-500/15">
        {titleVariantChips.map((variant, index) => titleVariantNode(variant, index, mode))}
      </span>
    )
  }

  function expandedTitleContentNode(keyPrefix: string) {
    if (!chipExpanded || chipExpansionGeometry.lineHtml.length === 0) return null
    return expansionLineNodesFromHtml(
      chipExpansionLineMarkup(chipExpansionGeometry.lineHtml, chipExpansionGeometry.viewportConstrained),
      keyPrefix
    )
  }

  function titleRowContentNode(mode: ChipTextRenderMode, keyPrefix: string) {
    const expandedContent = expandedTitleContentNode(keyPrefix)
    if (expandedContent) return expandedContent
    return (
      <>
        {chip.leadPrefix && (
          <span className="chip-subdomain mr-1.5 font-medium text-muted-foreground after:ml-1.5 after:opacity-50 after:content-['·']">
            {highlightedTextNodes(chip.leadPrefix, highlightTerms, `${mode}-lead`)}
          </span>
        )}
        {titleContentNode(mode)}
      </>
    )
  }

  function titleVariantTitleRowNode(mode: ChipTextRenderMode) {
    return (
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleRowContentNode(mode, `${mode}-expanded-title-variant-title`)}
      </span>
    )
  }

  function chipTextContentNode(mode: ChipTextRenderMode) {
    if (isFolded) {
      return (
        <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
          <span className="chip-title-row block min-w-0 max-w-full">
            {titleRowContentNode(mode, `${mode}-expanded-folded-title`)}
          </span>
          <span className="chip-env-row flex max-w-full flex-wrap items-center gap-1">
            {envs.map((env) => envLabelNode(env, mode))}
          </span>
        </span>
      )
    }

    if (isTitleVariantGroup) {
      return (
        <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
          {titleVariantTitleRowNode(mode)}
          {titleVariantListNode(mode)}
        </span>
      )
    }

    if (mode === 'chip' && !chipExpanded && chipTextClamp && chipTextClamp.key === chipTextClampKey && chipTextClamp.lineHtml.length > 1) {
      return clampedTitleLineNodes(
        chipTextClamp.lineHtml,
        'chip-text',
        hasTitleSuppressionMarkers ? rebuildClampedChipMarker : undefined
      )
    }

    return (
      titleRowContentNode(mode, `${mode}-expanded-title`)
    )
  }

  // Captured suppression pills come back as live nodes: the static rebuild
  // would drop their SVG glyph and freeze the context-driven hover tone. The
  // trailing-marker spacing class rides along from the captured element.
  function rebuildClampedChipMarker(element: Element, key: string) {
    if (!element.classList.contains('chip-title-suppression-marker')) return undefined
    const part = (element.getAttribute('aria-label') || '').replace(/^Suppressed title text:\s*/, '')
    if (!part) return undefined
    const markerSpacingClass = element.classList.contains('ml-1') ? 'ml-1' : element.classList.contains('ml-0.5') ? 'ml-0.5' : ''
    return suppressionMarkerNode(part, 'chip', key, markerSpacingClass)
  }

  const chipTooltipContent = chip.iconOnly ? (
    <span
      className={cn(
        "chip-text block min-w-0 max-w-[calc(100vw-32px)] hyphens-auto break-normal text-[13px] leading-tight text-tab-live font-[inherit] [hyphenate-character:'']",
        "whitespace-normal wrap-break-word",
        hasFilter && 'text-[color-mix(in_srgb,var(--color-tab-live)_72%,var(--color-muted-foreground))]'
      )}
    >
      {chipTextContentNode('tooltip')}
    </span>
  ) : undefined

  const foldedTitleExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-1.25 flex min-w-0 py-1.25"
    >
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleRowContentNode('chip', 'chip-expanded-folded-title-trigger')}
      </span>
    </span>
  )

  const foldedChipTextContent = (
    <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
      {shouldExpandChip ? (
        foldedTitleExpansionTriggerElement
      ) : (
        <span className="chip-title-row block min-w-0 max-w-full">
          {titleRowContentNode('chip', 'chip-expanded-folded-title-rest')}
        </span>
      )}
      <span className="chip-env-row relative flex max-w-full flex-wrap items-center gap-1">
        <ProgressiveFoldedEnvList
          key={progressiveFoldedEnvResetKey}
          envs={envs}
          renderEnv={(env) => envLabelNode(env, 'chip')}
        />
      </span>
    </span>
  )

  const titleVariantTitleExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-1.25 flex min-w-0 py-1.25"
    >
      {titleVariantTitleRowNode('chip')}
    </span>
  )

  const titleVariantChipTextContent = (
    <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
      {shouldExpandChip ? (
        titleVariantTitleExpansionTriggerElement
      ) : (
        titleVariantTitleRowNode('chip')
      )}
      {titleVariantListNode('chip')}
    </span>
  )

  const chipTextClampAvailable =
    !isFolded &&
    !isTitleVariantGroup &&
    chipTextClamp?.key === chipTextClampKey &&
    chipTextClamp.lineHtml.length > 1
  const chipTextContentKey = chipTextClampAvailable ? 'captured' : 'natural'
  // Fallback emoji and tall symbols can paint slightly outside the tight line
  // box. Extend the clip edge without shifting the title or changing clamp
  // height; the expansion hit-area padding sits outside this clipping element.
  const chipTextElement = (
    <span
      className={cn(
        "chip-text block min-w-0 flex-1 overflow-clip [overflow-clip-margin:2px] hyphens-auto break-normal max-h-[calc(2lh)] [hyphenate-character:''] [&.chip-text-truncated]:mask-(--title-fade-mask)",
        hasFilter && 'text-[color-mix(in_srgb,var(--color-tab-live)_72%,var(--color-muted-foreground))]',
        chip.pathSuffix && 'max-h-[calc(3lh)]',
        isTitleVariantGroup && 'max-h-none overflow-visible!',
        isFolded && 'max-h-none',
        chipExpanded && 'max-h-none! max-w-none! flex-1! overflow-visible! mask-none! whitespace-normal wrap-break-word'
      )}
      ref={chipTextRef}
      onPointerEnter={onChipTextPointerEnter}
    >
      <span
        key={chipTextContentKey}
        className="captured-title-content-root contents"
      >
        {isFolded ? foldedChipTextContent : isTitleVariantGroup ? titleVariantChipTextContent : chipTextContentNode('chip')}
      </span>
    </span>
  )

  const chipTextExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-1.25 flex min-w-0 flex-1 py-1.25"
    >
      {chipTextElement}
    </span>
  )

  const chipInteractionProps = parentInteractive
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: onFocus,
        onMouseDown: onChipPointerDown,
        onKeyDown: onChipKeyDown,
        onMouseEnter: onChipMouseEnter,
        onMouseLeave: onChipMouseLeave,
        onFocus: onChipFocus,
        onBlur: onChipBlur
      } as const
    : {}

  // The grouped chip stays keyboard-inert (no role/tabIndex — the URL variant
  // buttons are the keyboard targets), but its whole mouse surface targets the
  // default variant. These live on the rectangular `.chip-slot`, NOT the
  // `.page-chip`: the chip is rounded (`rounded-[10px] [corner-shape:squircle]`)
  // so clicks at its corners fall through to the slot underneath; owning them
  // on the slot makes the corner gutter activate the default variant too (the
  // base.css hover highlight is keyed off the slot for the same reason). The
  // exact pills, their action rails, the favicon close, and the audio toggle
  // each stop propagation, so only title/blank-surface clicks reach here.
  const variantGroupInteractionProps = isTitleVariantGroup
    ? {
        onClick: onVariantGroupChipClick,
        onMouseDown: onVariantGroupChipMouseDown,
        onMouseEnter: onVariantGroupChipMouseEnter,
        onMouseMove: onVariantGroupChipMouseMove,
        onMouseLeave: onVariantGroupChipMouseLeave
      } as const
    : {}

  const chipElement = (
      <div
        id={hasFilter && parentInteractive ? chipFilterResultCandidate.domId : undefined}
        data-tabout="page-chip"
        data-tabout-retained-page-identity={chip.sourceType === 'retained-page' ? chip.retainedPageIdentity : undefined}
        data-tabout-retained-page-closure-token={chip.sourceType === 'retained-page' ? chip.retainedPageClosureToken : undefined}
        data-tabout-filter-result={hasFilter && parentInteractive ? '' : undefined}
        data-tabout-filter-result-key={hasFilter && parentInteractive ? chipFilterResultCandidate.key : undefined}
        data-expanded={chipExpanded ? 'true' : undefined}
        className={cn(
          "page-chip group/page-chip relative flex items-start gap-2 rounded-[10px] border-0 bg-transparent py-1.25 pr-1 pl-3 text-left text-[13px] leading-tight text-tab-live font-[inherit] [corner-shape:squircle] transition-[color] duration-100 before:pointer-events-none before:absolute before:top-1.75 before:bottom-1.75 before:left-1 before:w-0.5 before:rounded-[1px] before:bg-(--group-color,transparent) before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-(--chip-hover-fade-width) after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--chip-hover-fade-bg)_34%,var(--chip-hover-fade-bg)_100%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transform-[scale(0.96)] motion-reduce:[&.closing]:transform-none",
          !chip.iconOnly && 'w-full',
          parentInteractive && 'clickable cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-amber) data-[tabout-filter-result-selected=true]:bg-(--chip-interaction-bg) data-[tabout-filter-result-selected=true]:outline-1 data-[tabout-filter-result-selected=true]:outline-offset-2 data-[tabout-filter-result-selected=true]:outline-(--accent-amber)',
          chipTooltipOpen && CHIP_TRIM_TOKENS.tooltipOpen,
          chipExpanded && 'page-chip-expanded absolute z-30 min-w-0 max-w-(--page-chip-expanded-max-width) overflow-visible! transition-none! w-(--page-chip-expanded-width) [&.page-chip-expanded]:shadow-[0_3px_10px_rgba(10,10,10,0.055)]',
          chipExpanded && 'left-0',
          chipExpanded && (chipExpansionGeometry.y === 'up' ? 'bottom-0' : 'top-0'),
          trim.chipClasses,
          isTitleVariantGroup && 'cursor-default',
          isFolded && `${CHIP_TRIM_TOKENS.folded} cursor-default after:hidden`,
          chip.saved && 'page-chip-saved',
          hoverMatched && `${CHIP_TRIM_TOKENS.hoverMatch} outline-1 outline-offset-1 outline-(--accent-amber)`,
          suppressionHighlighted && cn('page-chip-suppression-highlighted', titleSuppressionChipHighlightClass(activeSuppressionTone)),
          chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 rounded-xl bg-transparent p-0 [corner-shape:squircle] before:hidden after:hidden',
          trim.iconChipClasses
        )}
        aria-label={chipLabel}
        style={chipStyle}
        onPointerEnter={onChipPointerEnter}
        onPointerMove={onChipPointerMove}
        onPointerLeave={onChipPointerLeave}
        {...chipInteractionProps}
      >
      {trim.expandedFill && (
        <span
          aria-hidden="true"
          className={trim.expandedFill.classes}
          style={{
            top: trim.expandedFill.top,
            bottom: trim.expandedFill.bottom,
            backgroundColor: trim.expandedFill.background
          }}
        />
      )}
      {trim.frame && (
        <span className={trim.frame.classes} aria-hidden="true" />
      )}
      {showFaviconFrame && (
        <ChipFaviconFrame
          chip={chip}
          dupeCount={dupeCount}
          showDefaultFavicon={showDefaultFavicon}
          showFaviconCloseAction={showFaviconCloseAction}
          dedupeBadgesClosing={dedupeBadgesClosing}
          closeActionLabel={closeActionLabel}
          onCloseAction={isTitleVariantGroup ? onCloseAllVariants : isHistorySource ? onDeleteHistory : onClose}
          onToggleAudio={onToggleChipAudio}
        />
      )}
      {!chip.iconOnly && chip.audioState && (
        <TabAudioButton
          state={chip.audioState}
          onToggle={onToggleChipAudio}
          className="mt-px self-start"
        />
      )}
      {!chip.iconOnly && chip.chromePinned && (
        <span
          data-tabout-part="chrome-pin"
          className="chip-chrome-pin icon-[lucide--pin] mt-px size-3 shrink-0 text-muted-foreground opacity-70"
          aria-hidden="true"
        />
      )}
      {!chip.iconOnly && (
        isFolded || isTitleVariantGroup ? chipTextElement : chipTextExpansionTriggerElement
      )}
      {!chip.iconOnly && showSavedHint && (
        <div className="chip-actions absolute top-1/2 right-2 z-2 flex -translate-y-1/2 items-center gap-0.5">
          <span
            className="chip-action chip-saved-hint pointer-events-none inline-flex shrink-0 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-1 text-(--accent-amber) opacity-0 group-hover/page-chip:pointer-events-auto group-hover/page-chip:opacity-100 group-[.page-chip-expanded]/page-chip:pointer-events-auto group-[.page-chip-expanded]/page-chip:opacity-100 group-[.page-chip-context-menu-open]/page-chip:pointer-events-auto group-[.page-chip-context-menu-open]/page-chip:opacity-100 group-[.page-chip-tooltip-open]/page-chip:pointer-events-auto group-[.page-chip-tooltip-open]/page-chip:opacity-100"
            aria-hidden="true"
          >
            <SavedPageIcon saved className="size-3.5" />
          </span>
        </div>
      )}
      </div>
  )
  const chipElementWithContextMenu = !chip.iconOnly && (canToggleSavedPage || canRemoveRetained || canTogglePagePin || canUseChromeTabActions || canShowSuspend || canUseCopyContextMenu) ? (
    <PageChipContextMenu
      savedActionLabel={canToggleSavedPage ? savedActionLabel : undefined}
      saved={!!chip.saved}
      onSavedSelect={canToggleSavedPage ? onToggleSavedPage : undefined}
      onRemoveFromTabsSelect={canRemoveRetained ? (e) => onRemoveRetainedPage(e, chip) : undefined}
      pagePinActionLabel={canTogglePagePin ? pagePinActionLabel : undefined}
      pagePinned={!!chip.pagePinned}
      onPagePinSelect={canTogglePagePin ? onTogglePagePin : undefined}
      onReloadSelect={canUseChromeTabActions ? (e) => onReloadPageTarget(e, chip) : undefined}
      onDuplicateSelect={canUseChromeTabActions ? (e) => onDuplicatePageTarget(e, chip) : undefined}
      suspendEnabled={suspendEnabled}
      onSuspendSelect={canShowSuspend ? onToggleChipSuspend : undefined}
      titleText={chipTitleText}
      onCopyTitle={(e) => onCopyTitleText(e, chipTitleText)}
      urlText={chipUrlText}
      onCopyUrl={(e) => onCopyUrlText(e, chipUrlText)}
      onOpenChange={onChipContextMenuOpenChange}
    >
      {chipElement}
    </PageChipContextMenu>
  ) : chipElement

  const renderedChipElement = chip.iconOnly && chipTooltipContent ? (
    <TooltipAnchor
      content={chipTooltipContent}
      className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight wrap-break-word cursor-default select-none"
      instant
      onClick={onPageChipTooltipClick}
      onOpenChange={onChipTooltipOpenChange}
      style={chipTooltipStyle}
    >
      {chipElement}
    </TooltipAnchor>
  ) : chipElementWithContextMenu

  return (
    <div
      data-tabout-part="slot"
      data-tabout-layout-anchor={layoutScope ? '' : undefined}
      data-tabout-layout-item={layoutScope ? '' : undefined}
      data-tabout-layout-key={layoutScope ? chipLayoutKey : undefined}
      data-tabout-layout-scope={layoutScope || undefined}
      data-tabout-removal-anchor=""
      data-tabout-removal-item=""
      data-tabout-removal-key={`page:${chip.rawUrl}`}
      // The hover-match slot lift (z-3) stays below the interacting-slot
      // lift (z-4, inside trim.slotClasses) by specificity, so a deliberate
      // interaction always wins over passive hover-match at the seam.
      className={cn('chip-slot relative min-w-0', chip.iconOnly ? 'inline-flex' : `${trim.slotClasses} flex w-full`, hoverMatched && 'z-3')}
      style={chipSlotStyle}
      ref={chipSlotRef}
      {...variantGroupInteractionProps}
    >
      {renderedChipElement}
    </div>
  )
}

export function PageChip(props: PageChipProps) {
  return usePageChipElement(props)
}
