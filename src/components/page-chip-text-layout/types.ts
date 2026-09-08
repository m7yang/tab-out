export type ChipTextMetrics = {
  hasExpandableContent: boolean
  isTruncated: boolean
  titleVariantLabelTruncationKey: string
  width: number
}

export type ChipTextClamp = {
  key: string
  lineHtml: string[]
  width: number
}

export type ChipTextLayoutState = {
  clamp: ChipTextClamp | null
  metrics: ChipTextMetrics
}

export type ChipTextFadeMetrics = ChipTextMetrics & {
  height: number
}

export type ChipTextLineCaptureGeometry = {
  lineHeight: number
  textRect: DOMRect
}

export type ChipTextLayoutReading = {
  fadeMetrics: ChipTextFadeMetrics
  layout: ChipTextLayoutState
}

export type ChipTextMeasurement = {
  clampEligible: boolean
  element: HTMLElement
  key: string
  masonryCardWidth: string
  metrics: ChipTextMetrics
}

export type ChipSlotSize = {
  height: number
  width: number
}

export type ChipExpansionGeometry = {
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

export type ExpandedPageChipContentMetrics = {
  /** True only when a single-line resting title must WRAP on reveal — the
      expanded overlay then grows taller than the resting slot. Multi-line
      resting chips reveal in place (frozen lines), so they never set this. */
  grewTaller?: boolean
  viewportConstrained: boolean
  width: number
}

export const PAGE_CHIP_EXPANDED_VIEWPORT_MARGIN_PX = 12
export const PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX = 8
export const CHIP_TEXT_CLAMP_WIDTH_TOLERANCE_PX = 0.5
export const PAGE_CHIP_EXPANDED_WIDTH_SEARCH_STEPS = 12
export const PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX = 1.5

export const DEFAULT_CHIP_TEXT_METRICS: ChipTextMetrics = {
  hasExpandableContent: false,
  isTruncated: false,
  titleVariantLabelTruncationKey: '',
  width: 0,
}

export const DEFAULT_CHIP_TEXT_LAYOUT_STATE: ChipTextLayoutState = { clamp: null, metrics: DEFAULT_CHIP_TEXT_METRICS }

export const DEFAULT_CHIP_SLOT_SIZE: ChipSlotSize = { height: 0, width: 0 }

export const DEFAULT_CHIP_EXPANSION_GEOMETRY: ChipExpansionGeometry = {
  grewTaller: false,
  lineHtml: [],
  maxWidth: 0,
  viewportConstrained: false,
  width: 0,
  x: 'start',
  y: 'down',
}
