import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode, RefObject } from 'react'
import { clampedTitleLineNodes, expansionLineNodesFromHtml } from '../title-expansion'
import { chipExpansionLineMarkup } from './fragments.js'
import { clampForKey } from './policy.js'
import { createChipTextLayoutSession } from './session.js'
import type { ChipExpansionGeometry, ChipSlotSize } from './types.js'

type ClampedMarkerRebuilder = Parameters<typeof clampedTitleLineNodes>[2]

export type ChipTextLayoutView = {
  /** Captured clamp rows as nodes; null unless a valid multi-line clamp exists. */
  clampedLines: (rebuildElement?: ClampedMarkerRebuilder) => ReactNode | null
  /** Expanded overlay rows as nodes; null until expansion geometry captured lines. */
  expandedLines: (keyPrefix: string) => ReactNode | null
  expansion: Omit<ChipExpansionGeometry, 'lineHtml'>
  hasClampedLines: boolean
  hasExpandableContent: boolean
  /** Measure expansion geometry from the collapsed source DOM at open time. */
  measureExpansion: () => void
  /** Refresh the attached element's text metrics without geometry work. */
  refreshMetrics: () => void
  /** The owner must call this synchronously when its expanded state flips, so
      in-flight masonry jobs and observer callbacks see the new gate before the
      next commit. */
  setExpanded: (expanded: boolean) => void
  slotSize: ChipSlotSize
  variantLabelTruncationKey: string
}

export function useChipTextLayout({ clampEligible, contentKey, expanded, slotRef, textRef }: {
  clampEligible: boolean
  contentKey: string
  expanded: boolean
  slotRef: RefObject<HTMLDivElement | null>
  textRef: RefObject<HTMLSpanElement | null>
}): ChipTextLayoutView {
  const [session] = useState(createChipTextLayoutSession)
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot)

  // Folded and title-variant text can still remount when the owner's expandable
  // shape flips, so a mount-once attachment would keep observing the dead
  // element. Follow the current element on every commit; attachment is
  // idempotent per element, and it must land in the layout phase so masonry
  // validation is registered before the parent's post-pack callback runs.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the session re-attaches per element; the unmount effect below detaches whichever element is current then.
  useLayoutEffect(() => {
    session.syncText(textRef.current)
  })

  useLayoutEffect(() => {
    session.setContent(contentKey, clampEligible)
  }, [session, contentKey, clampEligible])

  const layoutState = snapshot.layout
  const clamp = clampForKey(layoutState, contentKey)

  // Re-apply or re-capture the clamp after every commit that changed its
  // inputs, including collapse (expanded -> false) re-painting captured rows.
  useLayoutEffect(() => {
    session.onCommit()
  }, [session, expanded, layoutState, contentKey, clampEligible])

  // Observation waits for the after-paint phase: layout-phase commits (and the
  // masonry jobs they defer to) have recorded every measured size by then, so
  // the observer's initial callback fires only for a genuinely remounted
  // element that still needs its one re-measure.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- observation follows the current element; the unmount effect below detaches it.
  useEffect(() => {
    session.observeText()
  })

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only by design: dispose detaches whichever element the session follows at that point.
  useLayoutEffect(() => () => {
    session.dispose()
  }, [session])

  const hasClampedLines = !!clamp && clamp.lineHtml.length > 1
  const { lineHtml: expansionLineHtml, ...expansion } = snapshot.expansionGeometry

  return {
    clampedLines: (rebuildElement?: ClampedMarkerRebuilder) => (
      clamp && hasClampedLines
        ? clampedTitleLineNodes(clamp.lineHtml, 'chip-text', rebuildElement)
        : null
    ),
    expandedLines: (keyPrefix: string) => (
      expansionLineHtml.length === 0
        ? null
        : expansionLineNodesFromHtml(
            chipExpansionLineMarkup(expansionLineHtml, expansion.viewportConstrained),
            keyPrefix,
          )
    ),
    expansion,
    hasClampedLines,
    hasExpandableContent: layoutState.metrics.hasExpandableContent,
    measureExpansion: () => session.measureExpansion(slotRef.current),
    refreshMetrics: session.syncMetrics,
    setExpanded: session.setExpanded,
    slotSize: snapshot.slotSize,
    variantLabelTruncationKey: layoutState.metrics.titleVariantLabelTruncationKey,
  }
}
