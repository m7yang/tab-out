import { createExpansionMeasureElement, expandedLineContentOverflows, fragmentHtml, searchExpandedWidth } from '../title-expansion'
import {
  getChipTextExpansionBaselineWidth,
  getChipTextLineHeight,
  getChipTextPaintedContentWidth,
  getChipTextWidth,
  getExpandedPageChipHorizontalInset,
  getTitleVariantMinimumContentWidth,
  getVisibleChipTextLineCount,
} from './measure.js'
import { chipExpansionMaxWidth, composeChipExpansionGeometry } from './policy.js'
import { chipExpansionLineMarkup, hydrateClonedExpandedChipFragment } from './fragments.js'
import { getExpandedPageChipLineHtml } from './line-capture.js'
import {
  DEFAULT_CHIP_EXPANSION_GEOMETRY,
  PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX,
  PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX,
  PAGE_CHIP_EXPANDED_WIDTH_SEARCH_STEPS,
} from './types.js'
import type { ChipExpansionGeometry, ExpandedPageChipContentMetrics } from './types.js'

function expandedMeasureFitsLineCount(
  measureEl: HTMLElement,
  width: number,
  targetLineCount: number,
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
      range.getBoundingClientRect().width,
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
  lineHtml: readonly string[],
) {
  return createExpansionMeasureElement(textEl, {
    className: 'page-chip-expansion-measure pointer-events-none invisible fixed top-0 left-0 z-[-1] block min-w-0 max-w-none whitespace-normal hyphens-auto break-normal text-[13px] leading-tight text-tab-live [font-family:inherit] [hyphenate-character:\'\'] wrap-break-word',
    markup: expandedPageChipMeasureMarkup(textEl, lineHtml),
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
      width: Math.round(width * 100) / 100,
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
  lineHtml: readonly string[],
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
    fits: (width) => expandedMeasureFitsLineCount(measureEl, width, targetLineCount),
  })
}

function getExpandedPageChipContentWidth(
  textEl: HTMLElement | null,
  lineHtml: readonly string[],
  maxContentWidth: number,
  visibleWidthOverride = 0,
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
        width: Math.round(width * 100) / 100,
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

export function getPageChipExpansionGeometry(chipEl: HTMLElement | null, textEl: HTMLElement | null = chipEl?.querySelector<HTMLElement>('.chip-text') || null): ChipExpansionGeometry {
  if (!chipEl || typeof window === 'undefined') return DEFAULT_CHIP_EXPANSION_GEOMETRY

  const rect = chipEl.getBoundingClientRect()
  const contentBoxEl = chipEl.querySelector<HTMLElement>('.chip-text') || textEl
  const horizontalInset = getExpandedPageChipHorizontalInset(chipEl, contentBoxEl)
  const lineHtml = getExpandedPageChipLineHtml(textEl)
  const visibleWidthOverride = contentBoxEl && contentBoxEl !== textEl
    ? Math.max(getChipTextExpansionBaselineWidth(contentBoxEl), getTitleVariantMinimumContentWidth(contentBoxEl))
    : getTitleVariantMinimumContentWidth(textEl)
  const minWidth = Math.max(1, horizontalInset + Math.max(getChipTextExpansionBaselineWidth(textEl), visibleWidthOverride))
  const maxWidth = chipExpansionMaxWidth(rect, window.innerWidth)
  const contentMetrics = getExpandedPageChipContentWidth(textEl, lineHtml, Math.max(1, maxWidth - horizontalInset), visibleWidthOverride)
  return composeChipExpansionGeometry({
    contentMetrics,
    horizontalInset,
    lineHtml,
    maxWidth,
    minWidth,
    rect,
    viewportHeight: window.innerHeight,
  })
}
