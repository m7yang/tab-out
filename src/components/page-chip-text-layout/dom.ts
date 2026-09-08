import { syncClampedTitleFadeEnd, syncTruncatedTitleFadeEnd } from '../title-expansion'
import { createSizeChangeObserver, type ObservedElementSize, type SizeChangeObserver } from '../size-change-observer.js'
import { getChipTextLineHeight, readChipTextFadeMetrics } from './measure.js'
import { shouldCaptureClamp } from './policy.js'
import { getClampedPageChipLineHtml } from './line-capture.js'
import { DEFAULT_CHIP_TEXT_METRICS } from './types.js'
import type {
  ChipTextClamp,
  ChipTextFadeMetrics,
  ChipTextLayoutReading,
  ChipTextLayoutState,
  ChipTextMetrics,
} from './types.js'

let chipTextResizeObserver: SizeChangeObserver | null = null
export const chipTextMeasuredSizes = new WeakMap<HTMLElement, ObservedElementSize>()
export const chipTextTruncationCallbacks = new WeakMap<
  HTMLElement,
  (metrics: ChipTextFadeMetrics) => void
>()

function applyChipTextFadeMetrics(
  textEl: HTMLElement,
  metrics: ChipTextFadeMetrics,
  syncFadeEnd = true,
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
  measuredMetrics?: ChipTextFadeMetrics,
) {
  if (!textEl) return { ...DEFAULT_CHIP_TEXT_METRICS, height: 0 }

  return applyChipTextFadeMetrics(
    textEl,
    measuredMetrics ?? readChipTextFadeMetrics(textEl),
    syncFadeEnd,
  )
}

export function getChipTextMetrics(textEl: HTMLElement | null): ChipTextMetrics {
  const { hasExpandableContent, isTruncated, titleVariantLabelTruncationKey, width } = syncChipTextFade(textEl)
  return { hasExpandableContent, isTruncated, titleVariantLabelTruncationKey, width }
}

export function readChipTextLayout(textEl: HTMLElement, clampEligible: boolean, clampKey: string): ChipTextLayoutReading {
  // A captured clamp fades at its known box edge. Defer the glyph-range read
  // until capture fails so successful clamps do not measure an unused anchor.
  // The box and line height are also the line-capture geometry; keep that one
  // snapshot through capture instead of forcing duplicate reads per title.
  const textRect = textEl.getBoundingClientRect()
  const fadeMetrics = readChipTextFadeMetrics(textEl, textRect)
  const nextMetrics = {
    hasExpandableContent: fadeMetrics.hasExpandableContent,
    isTruncated: fadeMetrics.isTruncated,
    titleVariantLabelTruncationKey: fadeMetrics.titleVariantLabelTruncationKey,
    width: fadeMetrics.width,
  }
  let nextClamp: ChipTextClamp | null = null
  if (shouldCaptureClamp(fadeMetrics, clampEligible)) {
    const lineHtml = getClampedPageChipLineHtml(textEl, {
      lineHeight: getChipTextLineHeight(textEl),
      textRect,
    })
    if (lineHtml.length > 1) {
      nextClamp = { key: clampKey, lineHtml, width: fadeMetrics.width }
    }
  }
  return {
    fadeMetrics,
    layout: { clamp: nextClamp, metrics: nextMetrics },
  }
}

export function applyChipTextLayout(textEl: HTMLElement, reading: ChipTextLayoutReading): ChipTextLayoutState {
  applyChipTextFadeMetrics(textEl, reading.fadeMetrics, false)
  if (reading.layout.clamp) {
    syncClampedTitleFadeEnd(textEl, reading.layout.clamp.width)
  } else {
    syncTruncatedTitleFadeEnd(textEl, reading.fadeMetrics.isTruncated)
  }
  return reading.layout
}

export function measureChipTextLayout(textEl: HTMLElement, clampEligible: boolean, clampKey: string) {
  return applyChipTextLayout(textEl, readChipTextLayout(textEl, clampEligible, clampKey))
}

export function getChipTextResizeObserver() {
  chipTextResizeObserver ??= createSizeChangeObserver(syncChipTextFade)
  return chipTextResizeObserver
}
