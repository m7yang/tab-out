export { useChipTextLayout } from './use-chip-text-layout.js'
/** @public — the browser fixture spec bundles the module at runtime and drives the session directly, invisible to static analysis. */
export { createChipTextLayoutSession } from './session.js'
export type { ChipTextLayoutSession, ChipTextLayoutSnapshot } from './session.js'
export { validatePageChipTextLayoutsAfterMasonry } from './registry.js'
export { chipTextHasExpandableContent } from './measure.js'
export {
  PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME,
  PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME,
} from './fragments.js'
