export {
  DEFAULT_CHIP_EXPANSION_GEOMETRY,
  DEFAULT_CHIP_SLOT_SIZE,
  DEFAULT_CHIP_TEXT_LAYOUT_STATE,
} from './types.js'
export type { ChipTextMeasurement } from './types.js'
export {
  chipExpansionGeometryEqual,
  chipSlotSizeEqual,
  chipTextLayoutEqual,
  chipTextMetricsEqual,
  clampForKey,
  decidePackedRevalidation,
  packedWidthWithinTolerance,
} from './policy.js'
export {
  chipTextHasExpandableContent,
  getChipTextMasonryCardWidth,
  getChipTextWidth,
  roundedElementSize,
  waitsForInitialMasonryWidth,
} from './measure.js'
export {
  chipTextMeasuredSizes,
  chipTextTruncationCallbacks,
  getChipTextMetrics,
  getChipTextResizeObserver,
  applyChipTextLayout,
  measureChipTextLayout,
  readChipTextLayout,
} from './dom.js'
export { getPageChipExpansionGeometry } from './expansion-width.js'
export {
  chipExpansionLineMarkup,
  PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME,
  PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME,
} from './fragments.js'
