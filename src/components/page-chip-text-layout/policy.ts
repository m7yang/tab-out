import { expansionLineHtmlEquals } from '../title-expansion'
import {
  CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX,
  PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX,
} from './types.js'
import type {
  ChipExpansionGeometry,
  ChipSlotSize,
  ChipTextClamp,
  ChipTextLayoutState,
  ChipTextMetrics,
  ExpandedPageChipContentMetrics,
} from './types.js'

type RectTopLike = Pick<DOMRect, 'top'>
type RectLineLike = Pick<DOMRect, 'height' | 'top' | 'width'>

export function cssPixelValue(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function visibleChipTextLineCount(textHeight: number, lineHeight: number) {
  if (lineHeight <= 0 || textHeight <= 0) return 1
  return Math.max(1, Math.round(textHeight / lineHeight))
}

export function chipExpansionRawLineIndexForRect(rect: RectLineLike, textRect: RectTopLike, lineHeight: number) {
  if (rect.width <= 0 && rect.height <= 0) return null
  return Math.max(0, Math.round((rect.top - textRect.top) / lineHeight))
}

export function chipExpansionLineIndexForRect(rect: RectLineLike, textRect: RectTopLike, lineHeight: number, visibleLineCount: number) {
  const lineIndex = chipExpansionRawLineIndexForRect(rect, textRect, lineHeight)
  if (lineIndex === null) return null
  return lineIndex < visibleLineCount ? lineIndex : null
}

export function chipTextMetricsEqual(left: ChipTextMetrics, right: ChipTextMetrics) {
  return (
    left.hasExpandableContent === right.hasExpandableContent &&
    left.isTruncated === right.isTruncated &&
    left.titleVariantLabelTruncationKey === right.titleVariantLabelTruncationKey &&
    Math.abs(left.width - right.width) < 0.1
  )
}

export function chipTextClampEqual(left: ChipTextClamp | null, right: ChipTextClamp | null) {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.key === right.key &&
    Math.abs(left.width - right.width) < 0.1 &&
    expansionLineHtmlEquals(left.lineHtml, right.lineHtml)
  )
}

export function chipTextLayoutEqual(left: ChipTextLayoutState, right: ChipTextLayoutState) {
  return chipTextMetricsEqual(left.metrics, right.metrics) && chipTextClampEqual(left.clamp, right.clamp)
}

export function chipSlotSizeEqual(left: ChipSlotSize, right: ChipSlotSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

export function chipExpansionGeometryEqual(left: ChipExpansionGeometry, right: ChipExpansionGeometry) {
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

/** A captured clamp stays valid for its exact content key while the measured
    box width has not drifted past the clamp tolerance. */
export function clampForKey(layout: ChipTextLayoutState, key: string): ChipTextClamp | null {
  const clamp = layout.clamp
  return clamp?.key === key &&
    Math.abs(clamp.width - layout.metrics.width) < CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX
    ? clamp
    : null
}

export function shouldCaptureClamp(fade: Pick<ChipTextMetrics, 'isTruncated' | 'width'>, clampEligible: boolean) {
  return clampEligible && fade.isTruncated && fade.width > 0
}

export type PackedRevalidationDecision = 'check-width' | 'remeasure' | 'skip'

type PackedRevalidationPrevious = {
  clampEligible: boolean
  key: string
  masonryCardWidth: string
}

/** Masonry controls the card's explicit inline width. If that width and the
    title identity are unchanged, a second pack cannot change this title's
    available width. The live box read is deferred behind 'check-width' so a
    skippable pack never forces layout. */
export function decidePackedRevalidation({ clampEligible, key, masonryCardWidth, previous }: {
  clampEligible: boolean
  key: string
  masonryCardWidth: string
  previous: PackedRevalidationPrevious | null
}): PackedRevalidationDecision {
  if (!previous || previous.key !== key || previous.clampEligible !== clampEligible) return 'remeasure'
  if (masonryCardWidth && previous.masonryCardWidth === masonryCardWidth) return 'skip'
  return 'check-width'
}

export function packedWidthWithinTolerance(previousWidth: number, currentWidth: number) {
  return Math.abs(previousWidth - currentWidth) < CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX
}

export function chipExpansionMaxWidth(rect: Pick<DOMRect, 'left' | 'width'>, viewportWidth: number) {
  const roomToRight = Math.max(0, viewportWidth - rect.left - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  return Math.max(rect.width, roomToRight)
}

export function composeChipExpansionGeometry({ contentMetrics, horizontalInset, lineHtml, maxWidth, minWidth, rect, viewportHeight }: {
  contentMetrics: ExpandedPageChipContentMetrics
  horizontalInset: number
  lineHtml: string[]
  maxWidth: number
  minWidth: number
  rect: Pick<DOMRect, 'bottom' | 'height' | 'top' | 'width'>
  viewportHeight: number
}): ChipExpansionGeometry {
  const roomBelow = Math.max(0, viewportHeight - rect.top - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  const roomAbove = Math.max(0, rect.bottom - PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX)
  return {
    grewTaller: !!contentMetrics.grewTaller,
    lineHtml,
    maxWidth,
    viewportConstrained: contentMetrics.viewportConstrained,
    width: Math.min(maxWidth, Math.max(rect.width, minWidth, contentMetrics.width + horizontalInset)),
    x: 'start',
    y: roomBelow >= rect.height * 2 || roomBelow >= roomAbove ? 'down' : 'up',
  }
}

export function carriedExpandedMarkerToneClass(classNames: readonly string[]) {
  return classNames
    .filter((className) => (
      className.startsWith('title-suppression-token-tone-') ||
      /^(border|bg|ring)-(yellow|teal|sky|rose)-/.test(className) ||
      className === 'ring-1' ||
      className === 'ring-inset' ||
      className === 'text-foreground'
    ))
    .join(' ')
}

export function carriedExpandedMarkerSpacingClass(classNames: readonly string[]) {
  return classNames
    .filter((className) => className.startsWith('ml-') || className.startsWith('mr-'))
    .join(' ')
}
