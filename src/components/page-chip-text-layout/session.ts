import { syncClampedTitleFadeEnd } from '../title-expansion'
import { subscribeFontMetricsInvalidation } from '../font-metrics-invalidation.js'
import {
  getChipTextMasonryCardWidth,
  getChipTextWidth,
  roundedElementSize,
  waitsForInitialMasonryWidth,
} from './measure.js'
import {
  applyChipTextLayout,
  chipTextMeasuredSizes,
  chipTextTruncationCallbacks,
  getChipTextMetrics,
  getChipTextResizeObserver,
  measureChipTextLayout,
  readChipTextLayout,
} from './dom.js'
import {
  chipExpansionGeometryEqual,
  chipSlotSizeEqual,
  chipTextLayoutEqual,
  chipTextMetricsEqual,
  clampForKey,
  decidePackedRevalidation,
  packedWidthWithinTolerance,
} from './policy.js'
import { getPageChipExpansionGeometry } from './expansion-width.js'
import { registerPageChipTextLayoutValidation, type PageChipTextLayoutMeasurementJob } from './registry.js'
import {
  DEFAULT_CHIP_EXPANSION_GEOMETRY,
  DEFAULT_CHIP_SLOT_SIZE,
  DEFAULT_CHIP_TEXT_LAYOUT_STATE,
} from './types.js'
import type {
  ChipExpansionGeometry,
  ChipSlotSize,
  ChipTextLayoutState,
  ChipTextMeasurement,
  ChipTextMetrics,
} from './types.js'

export type ChipTextLayoutSnapshot = {
  expansionGeometry: ChipExpansionGeometry
  layout: ChipTextLayoutState
  slotSize: ChipSlotSize
}

export type ChipTextLayoutSession = {
  dispose: () => void
  /** Measure expansion geometry from the collapsed source DOM at open time. */
  measureExpansion: (slotRoot: HTMLElement | null) => void
  /** Observe the attached element after paint; the initial resize-observer
      fire re-measures a remounted element that has no recorded size yet. */
  observeText: () => void
  /** Refresh the attached element's text metrics without geometry work. */
  syncMetrics: () => void
  /** Re-apply or re-capture the clamp after the owner commits a render. */
  onCommit: () => void
  setContent: (key: string, clampEligible: boolean) => void
  setExpanded: (expanded: boolean) => void
  snapshot: () => ChipTextLayoutSnapshot
  subscribe: (listener: () => void) => () => void
  /** Follow the current text element across remounts; idempotent per element. */
  syncText: (textEl: HTMLElement | null) => void
}

const DEFAULT_CHIP_TEXT_LAYOUT_SNAPSHOT: ChipTextLayoutSnapshot = {
  expansionGeometry: DEFAULT_CHIP_EXPANSION_GEOMETRY,
  layout: DEFAULT_CHIP_TEXT_LAYOUT_STATE,
  slotSize: DEFAULT_CHIP_SLOT_SIZE,
}

export function createChipTextLayoutSession(): ChipTextLayoutSession {
  let attachedText: HTMLElement | null = null
  let observedText: HTMLElement | null = null
  let clampEligible = false
  let contentKey = ''
  let expanded = false
  let measurement: ChipTextMeasurement | null = null
  let snapshot = DEFAULT_CHIP_TEXT_LAYOUT_SNAPSHOT
  let unregisterValidation: (() => void) | null = null
  const listeners = new Set<() => void>()

  function setSnapshot(next: ChipTextLayoutSnapshot) {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  function setLayout(nextLayout: ChipTextLayoutState) {
    if (chipTextLayoutEqual(snapshot.layout, nextLayout)) return
    setSnapshot({ ...snapshot, layout: nextLayout })
  }

  function mergeMetrics(nextMetrics: ChipTextMetrics) {
    if (chipTextMetricsEqual(snapshot.layout.metrics, nextMetrics)) return
    setLayout({ ...snapshot.layout, metrics: nextMetrics })
  }

  let unsubscribeFontMetrics: (() => void) | null = null

  function onFontMetricsInvalidated() {
    measurement = null
    if (snapshot.layout.clamp) setLayout({ ...snapshot.layout, clamp: null })
    mergeMetrics(getChipTextMetrics(attachedText))
  }

  function rememberMeasurement(textEl: HTMLElement, masonryCardWidth: string, metrics: ChipTextMetrics) {
    measurement = { clampEligible, element: textEl, key: contentKey, masonryCardWidth, metrics }
  }

  // Observation belongs to the owner's after-paint phase: by then the commit
  // (or the masonry jobs it deferred to) has recorded every measured size, so
  // the observer's initial callback stays silent at startup. A remounted
  // element has no recorded size yet, and that initial fire is exactly the
  // one re-measure the remount needs.
  function observeText() {
    const textEl = attachedText
    if (!textEl || observedText === textEl) return
    observedText = textEl
    getChipTextResizeObserver().observe(textEl, chipTextMeasuredSizes.get(textEl))
  }

  function createPackedLayoutMeasurement(textEl: HTMLElement): PageChipTextLayoutMeasurementJob {
    return {
      read() {
        const masonryCardWidth = getChipTextMasonryCardWidth(textEl)
        const reading = readChipTextLayout(textEl, clampEligible, contentKey)
        return () => {
          if (attachedText !== textEl || expanded) return
          const nextLayout = applyChipTextLayout(textEl, reading)
          rememberMeasurement(textEl, masonryCardWidth, nextLayout.metrics)
          setLayout(nextLayout)
        }
      },
    }
  }

  function validatePackedWidth(textEl: HTMLElement): PageChipTextLayoutMeasurementJob | null {
    if (attachedText !== textEl || expanded) return null
    const previous = measurement
    const decision = decidePackedRevalidation({
      clampEligible,
      key: contentKey,
      masonryCardWidth: getChipTextMasonryCardWidth(textEl),
      previous: previous?.element === textEl ? previous : null,
    })
    if (decision === 'skip') return null
    if (decision === 'remeasure') return createPackedLayoutMeasurement(textEl)
    const width = getChipTextWidth(textEl)
    if (previous && packedWidthWithinTolerance(previous.metrics.width, width)) return null
    return createPackedLayoutMeasurement(textEl)
  }

  // Folded and title-variant text can still remount when the owner's expandable
  // shape flips, so following the CURRENT element on every owner render keeps
  // the observer, truncation callback, and masonry validation attached to a
  // live node instead of a detached one.
  function syncText(textEl: HTMLElement | null) {
    if (attachedText === textEl) return
    if (attachedText) {
      if (observedText === attachedText) {
        getChipTextResizeObserver().unobserve(attachedText)
        observedText = null
      }
      chipTextTruncationCallbacks.delete(attachedText)
      unregisterValidation?.()
      unregisterValidation = null
    }
    attachedText = textEl
    if (!textEl) return
    unsubscribeFontMetrics ??= subscribeFontMetricsInvalidation(onFontMetricsInvalidated)
    chipTextTruncationCallbacks.set(textEl, ({ hasExpandableContent, isTruncated, titleVariantLabelTruncationKey, width }) => {
      mergeMetrics({ hasExpandableContent, isTruncated, titleVariantLabelTruncationKey, width })
    })
    unregisterValidation = registerPageChipTextLayoutValidation(textEl, () => validatePackedWidth(textEl))
  }

  // Truncated chips swap to captured-line rows so the tail fills to the box
  // edge under the fade. The capture keeps marker elements raw and the owner's
  // row renderer revives suppression pills as live nodes, so their glyph and
  // hover tone survive the swap. A valid clamp only re-applies its class and
  // fade; measurement runs when no memoized reading covers the commit.
  function onCommit() {
    const textEl = attachedText
    if (!textEl || expanded) return

    const clamp = clampForKey(snapshot.layout, contentKey)
    if (clamp) {
      textEl.classList.add('chip-text-truncated')
      syncClampedTitleFadeEnd(textEl, clamp.width)
      return
    }

    const previous = measurement
    if (
      previous?.element === textEl &&
      previous.key === contentKey &&
      previous.clampEligible === clampEligible &&
      chipTextMetricsEqual(previous.metrics, snapshot.layout.metrics)
    ) {
      return
    }

    // The parent masonry layout assigns the card's final inline width later in
    // the same layout phase. Measuring its unconstrained grid width here would
    // be discarded immediately by the post-pack validation.
    if (waitsForInitialMasonryWidth(textEl)) return

    const nextLayout = measureChipTextLayout(textEl, clampEligible, contentKey)
    rememberMeasurement(textEl, getChipTextMasonryCardWidth(textEl), nextLayout.metrics)
    setLayout(nextLayout)
  }

  // Expansion geometry is intentionally measured only when the interaction
  // opens it. Measuring every collapsed chip on mount and resize multiplies
  // layout work across the whole dashboard before any expansion is needed.
  function syncMetrics() {
    mergeMetrics(getChipTextMetrics(attachedText))
  }

  function measureExpansion(slotRoot: HTMLElement | null) {
    syncMetrics()
    const chipEl = slotRoot?.querySelector<HTMLElement>('.page-chip') ?? null
    const geometryTextEl = attachedText?.querySelector<HTMLElement>('.chip-title-row') || attachedText
    const nextSize = roundedElementSize(chipEl)
    const nextGeometry = getPageChipExpansionGeometry(chipEl, geometryTextEl)
    const slotChanged = !chipSlotSizeEqual(snapshot.slotSize, nextSize)
    const geometryChanged = !chipExpansionGeometryEqual(snapshot.expansionGeometry, nextGeometry)
    if (!slotChanged && !geometryChanged) return
    setSnapshot({
      ...snapshot,
      ...(slotChanged ? { slotSize: nextSize } : {}),
      ...(geometryChanged ? { expansionGeometry: nextGeometry } : {}),
    })
  }

  return {
    dispose() {
      syncText(null)
      unsubscribeFontMetrics?.()
      unsubscribeFontMetrics = null
      listeners.clear()
    },
    measureExpansion,
    observeText,
    onCommit,
    setContent(key, nextClampEligible) {
      contentKey = key
      clampEligible = nextClampEligible
    },
    setExpanded(nextExpanded) {
      expanded = nextExpanded
    },
    snapshot: () => snapshot,
    syncMetrics,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    syncText,
  }
}
