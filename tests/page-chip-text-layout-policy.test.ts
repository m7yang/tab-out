import assert from 'node:assert/strict'
import test from 'node:test'

import {
  carriedExpandedMarkerSpacingClass,
  carriedExpandedMarkerToneClass,
  chipExpansionLineIndexForRect,
  chipExpansionMaxWidth,
  chipExpansionRawLineIndexForRect,
  chipExpansionGeometryEqual,
  chipSlotSizeEqual,
  chipTextClampEqual,
  chipTextLayoutEqual,
  chipTextMetricsEqual,
  clampForKey,
  composeChipExpansionGeometry,
  cssPixelValue,
  decidePackedRevalidation,
  packedWidthWithinTolerance,
  shouldCaptureClamp,
  visibleChipTextLineCount,
} from '../src/components/page-chip-text-layout/policy.js'
import type {
  ChipExpansionGeometry,
  ChipTextLayoutState,
  ChipTextMetrics,
} from '../src/components/page-chip-text-layout/types.js'

const metrics = (overrides: Partial<ChipTextMetrics> = {}): ChipTextMetrics => ({
  hasExpandableContent: true,
  isTruncated: true,
  titleVariantLabelTruncationKey: '',
  width: 200,
  ...overrides,
})

const layoutState = (overrides: Partial<ChipTextLayoutState> = {}): ChipTextLayoutState => ({
  clamp: { key: 'k1', lineHtml: ['<span>a</span>', '<span>b</span>'], width: 200 },
  metrics: metrics(),
  ...overrides,
})

const geometry = (overrides: Partial<ChipExpansionGeometry> = {}): ChipExpansionGeometry => ({
  grewTaller: false,
  lineHtml: [],
  maxWidth: 400,
  viewportConstrained: false,
  width: 300,
  x: 'start',
  y: 'down',
  ...overrides,
})

test('cssPixelValue parses finite pixel values and falls back to zero', () => {
  assert.equal(cssPixelValue('12.5px'), 12.5)
  assert.equal(cssPixelValue('0'), 0)
  assert.equal(cssPixelValue(''), 0)
  assert.equal(cssPixelValue('auto'), 0)
})

test('visibleChipTextLineCount rounds heights into a positive line count', () => {
  assert.equal(visibleChipTextLineCount(0, 16), 1)
  assert.equal(visibleChipTextLineCount(16, 0), 1)
  assert.equal(visibleChipTextLineCount(16, 16), 1)
  assert.equal(visibleChipTextLineCount(33, 16), 2)
  assert.equal(visibleChipTextLineCount(40, 16), 3)
})

test('chipExpansionRawLineIndexForRect maps rect tops onto line indexes', () => {
  const textRect = { top: 100 }
  assert.equal(chipExpansionRawLineIndexForRect({ height: 0, top: 132, width: 0 }, textRect, 16), null)
  assert.equal(chipExpansionRawLineIndexForRect({ height: 14, top: 132, width: 10 }, textRect, 16), 2)
  assert.equal(chipExpansionRawLineIndexForRect({ height: 14, top: 90, width: 10 }, textRect, 16), 0)
})

test('chipExpansionLineIndexForRect rejects lines past the visible count', () => {
  const textRect = { top: 0 }
  assert.equal(chipExpansionLineIndexForRect({ height: 14, top: 16, width: 10 }, textRect, 16, 2), 1)
  assert.equal(chipExpansionLineIndexForRect({ height: 14, top: 32, width: 10 }, textRect, 16, 2), null)
})

test('chipTextMetricsEqual uses a sub-pixel width tolerance', () => {
  assert.equal(chipTextMetricsEqual(metrics(), metrics({ width: 200.05 })), true)
  assert.equal(chipTextMetricsEqual(metrics(), metrics({ width: 200.15 })), false)
  assert.equal(chipTextMetricsEqual(metrics(), metrics({ isTruncated: false })), false)
  assert.equal(chipTextMetricsEqual(metrics(), metrics({ titleVariantLabelTruncationKey: '1' })), false)
})

test('chipTextClampEqual compares key, width tolerance, and line HTML', () => {
  const clamp = { key: 'k1', lineHtml: ['<b>a</b>'], width: 100 }
  assert.equal(chipTextClampEqual(null, null), true)
  assert.equal(chipTextClampEqual(clamp, null), false)
  assert.equal(chipTextClampEqual(clamp, { ...clamp, width: 100.05 }), true)
  assert.equal(chipTextClampEqual(clamp, { ...clamp, width: 100.2 }), false)
  assert.equal(chipTextClampEqual(clamp, { ...clamp, key: 'k2' }), false)
  assert.equal(chipTextClampEqual(clamp, { ...clamp, lineHtml: ['<b>b</b>'] }), false)
})

test('chipTextLayoutEqual composes metrics and clamp equality', () => {
  assert.equal(chipTextLayoutEqual(layoutState(), layoutState()), true)
  assert.equal(chipTextLayoutEqual(layoutState(), layoutState({ clamp: null })), false)
  assert.equal(chipTextLayoutEqual(layoutState(), layoutState({ metrics: metrics({ width: 100 }) })), false)
})

test('chipSlotSizeEqual tolerates sub-pixel drift only', () => {
  assert.equal(chipSlotSizeEqual({ height: 20, width: 100 }, { height: 20.05, width: 100.05 }), true)
  assert.equal(chipSlotSizeEqual({ height: 20, width: 100 }, { height: 20, width: 100.2 }), false)
})

test('chipExpansionGeometryEqual compares placement, flags, and line HTML', () => {
  assert.equal(chipExpansionGeometryEqual(geometry(), geometry({ width: 300.05 })), true)
  assert.equal(chipExpansionGeometryEqual(geometry(), geometry({ width: 300.2 })), false)
  assert.equal(chipExpansionGeometryEqual(geometry(), geometry({ y: 'up' })), false)
  assert.equal(chipExpansionGeometryEqual(geometry(), geometry({ grewTaller: true })), false)
  assert.equal(chipExpansionGeometryEqual(geometry(), geometry({ lineHtml: ['<i>x</i>'] })), false)
})

test('clampForKey returns the stored clamp only for the same key within tolerance', () => {
  const state = layoutState()
  assert.equal(clampForKey(state, 'k1'), state.clamp)
  assert.equal(clampForKey(state, 'k2'), null)
  assert.equal(clampForKey(layoutState({ clamp: null }), 'k1'), null)
  const drifted = layoutState({ metrics: metrics({ width: 200.6 }) })
  assert.equal(clampForKey(drifted, 'k1'), null)
  const withinTolerance = layoutState({ metrics: metrics({ width: 200.4 }) })
  assert.equal(clampForKey(withinTolerance, 'k1'), withinTolerance.clamp)
})

test('shouldCaptureClamp requires eligibility, truncation, and painted width', () => {
  assert.equal(shouldCaptureClamp({ isTruncated: true, width: 100 }, true), true)
  assert.equal(shouldCaptureClamp({ isTruncated: true, width: 100 }, false), false)
  assert.equal(shouldCaptureClamp({ isTruncated: false, width: 100 }, true), false)
  assert.equal(shouldCaptureClamp({ isTruncated: true, width: 0 }, true), false)
})

test('decidePackedRevalidation remeasures on identity changes and skips stable masonry widths', () => {
  const previous = { clampEligible: true, key: 'k1', masonryCardWidth: '320px', width: 200 }
  assert.equal(decidePackedRevalidation({ clampEligible: true, key: 'k1', masonryCardWidth: '320px', previous: null }), 'remeasure')
  assert.equal(decidePackedRevalidation({ clampEligible: true, key: 'k2', masonryCardWidth: '320px', previous }), 'remeasure')
  assert.equal(decidePackedRevalidation({ clampEligible: false, key: 'k1', masonryCardWidth: '320px', previous }), 'remeasure')
  assert.equal(decidePackedRevalidation({ clampEligible: true, key: 'k1', masonryCardWidth: '320px', previous }), 'skip')
  assert.equal(decidePackedRevalidation({ clampEligible: true, key: 'k1', masonryCardWidth: '344px', previous }), 'check-width')
  assert.equal(decidePackedRevalidation({ clampEligible: true, key: 'k1', masonryCardWidth: '', previous }), 'check-width')
  assert.equal(decidePackedRevalidation({
    clampEligible: true,
    key: 'k1',
    masonryCardWidth: '',
    previous: { ...previous, masonryCardWidth: '' },
  }), 'check-width')
})

test('packedWidthWithinTolerance mirrors the clamp width tolerance', () => {
  assert.equal(packedWidthWithinTolerance(200, 200.4), true)
  assert.equal(packedWidthWithinTolerance(200, 200.5), false)
})

test('chipExpansionMaxWidth keeps the wider of chip width and viewport room', () => {
  assert.equal(chipExpansionMaxWidth({ left: 900, width: 50 }, 1000), 88)
  assert.equal(chipExpansionMaxWidth({ left: 980, width: 150 }, 1000), 150)
  assert.equal(chipExpansionMaxWidth({ left: 995, width: 4 }, 1000), 4)
})

test('composeChipExpansionGeometry places downward reveals with room below', () => {
  const composed = composeChipExpansionGeometry({
    contentMetrics: { viewportConstrained: false, width: 300 },
    horizontalInset: 10,
    lineHtml: [],
    maxWidth: 938,
    minWidth: 50,
    rect: { bottom: 120, height: 20, top: 100, width: 100 },
    viewportHeight: 800,
  })
  assert.deepEqual(composed, {
    grewTaller: false,
    lineHtml: [],
    maxWidth: 938,
    viewportConstrained: false,
    width: 310,
    x: 'start',
    y: 'down',
  })
})

test('composeChipExpansionGeometry reveals upward only when below is the tighter side', () => {
  const upward = composeChipExpansionGeometry({
    contentMetrics: { viewportConstrained: false, width: 0 },
    horizontalInset: 0,
    lineHtml: [],
    maxWidth: 400,
    minWidth: 0,
    rect: { bottom: 795, height: 20, top: 775, width: 100 },
    viewportHeight: 800,
  })
  assert.equal(upward.y, 'up')

  const cramped = composeChipExpansionGeometry({
    contentMetrics: { viewportConstrained: false, width: 0 },
    horizontalInset: 0,
    lineHtml: [],
    maxWidth: 400,
    minWidth: 0,
    rect: { bottom: 25, height: 20, top: 5, width: 100 },
    viewportHeight: 30,
  })
  assert.equal(cramped.y, 'down')
})

test('composeChipExpansionGeometry clamps the width into the max and floors at the chip', () => {
  const clamped = composeChipExpansionGeometry({
    contentMetrics: { grewTaller: true, viewportConstrained: true, width: 2000 },
    horizontalInset: 10,
    lineHtml: ['<span>line</span>'],
    maxWidth: 938,
    minWidth: 50,
    rect: { bottom: 120, height: 20, top: 100, width: 100 },
    viewportHeight: 800,
  })
  assert.equal(clamped.width, 938)
  assert.equal(clamped.grewTaller, true)
  assert.equal(clamped.viewportConstrained, true)
  assert.deepEqual(clamped.lineHtml, ['<span>line</span>'])

  const floored = composeChipExpansionGeometry({
    contentMetrics: { viewportConstrained: false, width: 0 },
    horizontalInset: 10,
    lineHtml: [],
    maxWidth: 938,
    minWidth: 120,
    rect: { bottom: 120, height: 20, top: 100, width: 100 },
    viewportHeight: 800,
  })
  assert.equal(floored.width, 120)
})

test('carriedExpandedMarkerToneClass keeps tone, ring, and palette classes only', () => {
  assert.equal(
    carriedExpandedMarkerToneClass([
      'title-suppression-token-tone-2',
      'ml-1',
      'bg-yellow-100',
      'border-teal-200',
      'border-red-200',
      'ring-1',
      'ring-2',
      'ring-inset',
      'text-foreground',
      'text-xs',
    ]),
    'title-suppression-token-tone-2 bg-yellow-100 border-teal-200 ring-1 ring-inset text-foreground',
  )
})

test('carriedExpandedMarkerSpacingClass keeps horizontal margins only', () => {
  assert.equal(carriedExpandedMarkerSpacingClass(['ml-1', 'mr-2', 'mt-1', 'px-1']), 'ml-1 mr-2')
  assert.equal(carriedExpandedMarkerSpacingClass(['px-1']), '')
})
