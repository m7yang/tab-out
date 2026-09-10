/* ================================================================
   Title Expansion — the module interface.

   Adapting surfaces (Page Chips, Activation History rows) and other
   consumers import from here only; files inside this directory are
   implementation. The interface has sanctioned slices:
   • controller + lane — the headless open/close half
   • width search + measure element — the sizing half
   • clamp/fade — resting truncated titles (Working Set rows use
     only this slice)
   • capture primitives — the sanctioned interface for the
     per-surface capture engines; measurement POLICY stays with each
     surface (docs/adr/0002 — a shared measurer was tried and
     rejected: its config would be as wide as the code it hides)
   ================================================================ */

export { createTitleExpansionController, createTitleExpansionLane } from './controller'
/** @public — sanctioned seam surface (consumers import from the barrel; ADR-0002). */
export type {
  TitleExpansionController,
  TitleExpansionControllerOptions,
  TitleExpansionLane,
  TitleExpansionOwner,
  TitleExpansionScheduler,
} from './controller'
export { useTitleExpansionController } from './use-title-expansion'
export { useCloseOnOutsideActivity } from './use-close-on-outside-activity'
/** @public — sanctioned seam surface (consumers import from the barrel; ADR-0002). */
export type { UseTitleExpansionControllerOptions } from './use-title-expansion'
export { searchExpandedWidth } from './width-search'
/** @public — sanctioned seam surface (consumers import from the barrel; ADR-0002). */
export type { ExpandedWidthSearchOptions, ExpandedWidthSearchResult } from './width-search'
export { createExpansionMeasureElement } from './measure-dom'
/** @public — sanctioned seam surface (consumers import from the barrel; ADR-0002). */
export type { ExpansionMeasureElementOptions } from './measure-dom'
export {
  captureVisibleLineHtml,
  clampedTitleLineNodes,
  expandedLineContentOverflows,
  expansionLineHtmlEquals,
  expansionLineMarkup,
  expansionLineNodesFromHtml,
  fragmentHtml,
  paintedRangeRect,
  syncClampedTitleFadeEnd,
  syncTruncatedTitleFadeEnd,
  truncatedTitleFadeEndPx,
  unwrapClampedTitleLines,
} from './line-capture'
/** @public — sanctioned seam surface (consumers import from the barrel; ADR-0002). */
export type {
  ExpansionLineClasses,
  TitleFadeBox,
  TitleLineCaptureGeometry,
  TitleLineFragmentRect,
} from './line-capture'
