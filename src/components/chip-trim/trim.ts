import { PAGE_CHIP_CURRENT_CLASSES, PAGE_CHIP_PAINT } from '../page-chip-paint'

/* Chip Trim implementation — the decision table. See index.ts for the
   contract; this file is implementation and may only be imported from
   there.

   Every class that needs CSS emitted for it appears as a FULL LITERAL in
   this file or page-chip-paint.ts. Tailwind scans source text; interpolated
   candidates never emit. Marker names (no CSS of their own) may ride
   through CHIP_TRIM_TOKENS. */

const FADE_INTERACTION_CLASSES = 'title-interaction:[&:has(.chip-actions):hover::after]:opacity-100 [&.page-chip-expanded:has(.chip-actions)::after]:opacity-100 title-interaction:[&.page-chip-context-menu-open:has(.chip-actions)::after]:opacity-100 title-interaction:[&.page-chip-tooltip-open:has(.chip-actions)::after]:opacity-100'
const SURFACE_INTERACTION_CLASSES = 'title-interaction:hover:[--capsule-fill:var(--chip-interaction-bg)] [&.page-chip-expanded]:[--capsule-fill:var(--chip-interaction-bg)] title-interaction:[&.page-chip-context-menu-open]:[--capsule-fill:var(--chip-interaction-bg)] title-interaction:[&.page-chip-tooltip-open]:[--capsule-fill:var(--chip-interaction-bg)]'
// The 1px interaction line, across the same states the fill responds to.
// The color rides --chip-hover-border (per-kind value via styleVars) — an
// interpolated color-mix() class would not survive Tailwind's extractor.
const HOVER_OUTLINE_CLASSES = 'title-interaction:hover:not-focus-visible:not-data-[tabout-filter-result-selected=true]:outline title-interaction:hover:not-focus-visible:not-data-[tabout-filter-result-selected=true]:outline-1 title-interaction:hover:not-focus-visible:not-data-[tabout-filter-result-selected=true]:-outline-offset-1 title-interaction:hover:not-focus-visible:not-data-[tabout-filter-result-selected=true]:outline-(--chip-hover-border) [&.page-chip-expanded:not(:focus-visible):not([data-tabout-filter-result-selected=true])]:outline [&.page-chip-expanded:not(:focus-visible):not([data-tabout-filter-result-selected=true])]:outline-1 [&.page-chip-expanded:not(:focus-visible):not([data-tabout-filter-result-selected=true])]:-outline-offset-1 [&.page-chip-expanded:not(:focus-visible):not([data-tabout-filter-result-selected=true])]:outline-(--chip-hover-border) title-interaction:[&.page-chip-context-menu-open]:outline title-interaction:[&.page-chip-context-menu-open]:outline-1 title-interaction:[&.page-chip-context-menu-open]:-outline-offset-1 title-interaction:[&.page-chip-context-menu-open]:outline-(--chip-hover-border) title-interaction:[&.page-chip-tooltip-open]:outline title-interaction:[&.page-chip-tooltip-open]:outline-1 title-interaction:[&.page-chip-tooltip-open]:-outline-offset-1 title-interaction:[&.page-chip-tooltip-open]:outline-(--chip-hover-border)'
// Unframed chips share a light fill and a stronger rim across Sources and liveness states.
const CLICKABLE_INTERACTION_CLASSES = `${SURFACE_INTERACTION_CLASSES} ${FADE_INTERACTION_CLASSES}`
const GROUP_INTERACTION_CLASSES = `${SURFACE_INTERACTION_CLASSES} ${HOVER_OUTLINE_CLASSES}`
const ACTIVE_OTHER_INTERACTION_CLASSES = `${SURFACE_INTERACTION_CLASSES} ${FADE_INTERACTION_CLASSES}`

/** Class-name tokens shared across the trim class strings (arbitrary
    variants key off them as literals below) and PageChip, which applies
    the state-class tokens. One source for every shared name. */
export const CHIP_TRIM_TOKENS = {
  slotRow: 'chip-slot-row',
  frame: 'active-chip-frame',
  tooltipOpen: 'page-chip-tooltip-open',
  contextMenuOpen: 'page-chip-context-menu-open',
  expanded: 'page-chip-expanded',
  hoverMatch: 'page-chip-hover-match',
  savedClosed: 'page-chip-saved-closed',
  folded: 'page-chip-folded',
} as const

export type ChipTrimFacts = {
  activeChipFrame: boolean
  activeInOtherWindow: boolean
  isCurrentTabOut: boolean
  closedSavedPage: boolean
  readOnlyFilterResult: boolean
  folded: boolean
  titleVariantGroup: boolean
  iconOnly: boolean
  isApp: boolean
  expanded: null | { grewTaller: boolean, y: 'down' | 'up' }
}

export type ChipTrim = {
  /** Kind-driven trim for the chip element (interaction fills/outlines,
      rest bg + rings for framed kinds, the saved-closed marker). */
  chipClasses: string
  /** Icon-only trim (border/outline/active bg). Separate from chipClasses
      because it merges AFTER hover-match/suppression classes in the chip's
      class order — tailwind-merge conflict resolution is order-sensitive. */
  iconChipClasses: string
  /** Seam-participation marker for the slot ('' for icon-only slots, which
      wrap horizontally in overflow rows and must not join vertical runs). */
  slotClasses: string
  /** The inset ring overlay for framed kinds; null when the kind draws none. */
  frame: null | { classes: string }
  /** CSS vars for fills and the interaction line. The fade bg stays the
      opaque mix in every kind — the fade exists to hide chip text under the
      action rail. Unframed chips share the closed-page hover treatment;
      title and favicon styling carry liveness independently. */
  styleVars: {
    closedInteractionBg: string
    interactionBg: string
    restBg: string
    fadeBg: string
    hoverBorder: string
  }
  /** The expanded plain chip's opaque fill layer. Edges FLUSH with the
      resting seam stay 1px clear (a bordered neighbour's line paints on the
      overlapped row and must show through the chip's translucent fill);
      grown edges extend fully so nothing bleeds through the overlay. */
  expandedFill: null | { classes: string, top: string, bottom: string, background: string }
}

const EXPANDED_FILL_CLASSES = 'page-chip-expanded-fill bg-(--capsule-fill) pointer-events-none absolute inset-x-0 -z-1 rounded-[inherit] opacity-0 [corner-shape:inherit] title-interaction:group-hover/page-chip:opacity-100 group-focus-visible/page-chip:opacity-100 group-[.page-chip-expanded]/page-chip:opacity-100 title-interaction:group-[.page-chip-context-menu-open]/page-chip:opacity-100 title-interaction:group-[.page-chip-tooltip-open]/page-chip:opacity-100'

export function chipTrim(facts: ChipTrimFacts): ChipTrim {
  const hasActiveChipFrame = facts.activeChipFrame || facts.activeInOtherWindow
  const isCurrentTabOutFrame = facts.isCurrentTabOut && facts.activeChipFrame && !facts.activeInOtherWindow
  const isCurrentActiveFrame = facts.activeChipFrame && !facts.activeInOtherWindow && !isCurrentTabOutFrame
  const isGroupKind = facts.titleVariantGroup || facts.folded
  const isPlainClickable = !hasActiveChipFrame && !facts.closedSavedPage && !isGroupKind

  const chipClasses = [
    !facts.closedSavedPage && !isGroupKind && !hasActiveChipFrame && !isCurrentActiveFrame && !isCurrentTabOutFrame && CLICKABLE_INTERACTION_CLASSES,
    // Plain chips share the group kinds' 1px line. Icon-only chips opt out: their
    // always-on ring sits OUTSIDE (outline-offset-1), and the trio's inset
    // offset would yank it inward on hover.
    isPlainClickable && !facts.iconOnly && HOVER_OUTLINE_CLASSES,
    facts.closedSavedPage && 'text-tab-closed',
    facts.closedSavedPage && !isGroupKind && `${CHIP_TRIM_TOKENS.savedClosed} ${GROUP_INTERACTION_CLASSES}`,
    hasActiveChipFrame && !isCurrentActiveFrame && !isCurrentTabOutFrame && '[--capsule-fill:var(--chip-rest-bg)] text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.04)]',
    isCurrentActiveFrame && `current-active-chip ${PAGE_CHIP_CURRENT_CLASSES}`,
    isCurrentTabOutFrame && `current-tab-out-chip ${PAGE_CHIP_CURRENT_CLASSES}`,
    hasActiveChipFrame && !isCurrentActiveFrame && !isCurrentTabOutFrame && ACTIVE_OTHER_INTERACTION_CLASSES,
    isGroupKind && !hasActiveChipFrame && !isCurrentActiveFrame && !isCurrentTabOutFrame && GROUP_INTERACTION_CLASSES,
  ].filter(Boolean).join(' ')

  const iconChipClasses = facts.iconOnly
    ? [
        facts.isApp
          ? 'overflow-visible border border-[rgba(115,115,115,0.32)] outline-none'
          : 'overflow-hidden border-0 [outline:1px_solid_rgba(115,115,115,0.18)] outline-offset-1',
        hasActiveChipFrame && '[--capsule-fill:var(--chip-rest-bg)] [outline:1px_solid_rgba(82,82,82,0.32)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22)]',
      ].filter(Boolean).join(' ')
    : ''

  // On interaction the frame's alpha strengthens so the line stays crisp
  // against the darker fill — via group variants so it swaps in the same
  // style recalculation as CSS :hover (the hover-flash lesson, 2026-06-13).
  const frame = hasActiveChipFrame && !facts.iconOnly
    ? {
        classes: [
          `${CHIP_TRIM_TOKENS.frame} pointer-events-none absolute inset-0 z-2 rounded-[inherit] [corner-shape:inherit]`,
          'title-interaction:group-hover/page-chip:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)] group-[.page-chip-expanded]/page-chip:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)] title-interaction:group-[.page-chip-context-menu-open]/page-chip:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)] title-interaction:group-[.page-chip-tooltip-open]/page-chip:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)]',
          isCurrentTabOutFrame
            ? 'active-history-entry-frame current-tab-out-chip-frame shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)]'
            : isCurrentActiveFrame
              ? 'current-active-chip-frame shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)]'
              : 'shadow-[inset_0_0_0_1px_rgba(115,115,115,0.2)]',
        ].join(' '),
      }
    : null

  const fadeBg = isCurrentTabOutFrame || isCurrentActiveFrame
    ? PAGE_CHIP_PAINT.currentBg
    : hasActiveChipFrame
      ? PAGE_CHIP_PAINT.activeOtherInteractionBg
      : PAGE_CHIP_PAINT.quietInteractionBg

  const styleVars = {
    // Child targets inside a mixed folded/title-variant chip may be closed
    // even when an open sibling gives the parent an active frame.
    closedInteractionBg: PAGE_CHIP_PAINT.quietInteractionBg,
    // Plain chips use the translucent equivalent so a bordered neighbour's
    // line survives on overlapped seam rows. Read-only results and groups
    // keep the same visible fill through the opaque recipe.
    interactionBg: isPlainClickable && !facts.readOnlyFilterResult
      ? PAGE_CHIP_PAINT.quietInteractionOverlayBg
      : fadeBg,
    restBg: hasActiveChipFrame && !isCurrentTabOutFrame ? PAGE_CHIP_PAINT.activeOtherRestBg : 'transparent',
    fadeBg,
    hoverBorder: PAGE_CHIP_PAINT.quietHoverBorder,
  }

  const expandedFill = facts.expanded && isPlainClickable && !facts.iconOnly
    ? {
        classes: EXPANDED_FILL_CLASSES,
        top: facts.expanded.y === 'up' && facts.expanded.grewTaller ? '0px' : '1px',
        bottom: facts.expanded.y === 'down' && facts.expanded.grewTaller ? '0px' : '1px',
        background: fadeBg,
      }
    : null

  // Full-width slots carry the seam behaviour:
  // • adjacent slot-rows ALWAYS overlap by -1px, so whenever two neighbours
  //   both paint a 1px trim line at the seam the lines coincide as one.
  //   Unconditional — trim capability is app state (saved page opens:
  //   saved-closed → plain; tab activates: plain → framed), and an overlap
  //   gated on trim markers shifted run heights 1px on those flips.
  // • the interacting slot lifts (z-4) so its strengthened frame paints on
  //   top of the neighbour at the shared seam; specificity keeps it above
  //   the hover-match outline layer (z-3, applied by PageChip).
  // Icon-only slots wrap horizontally in overflow rows — no seams, no
  // marker, no lift.
  const slotClasses = facts.iconOnly
    ? ''
    : 'chip-slot-row [.chip-slot-row+&]:-mt-px has-[.page-chip:hover:not([data-title-collapsed])]:z-4 has-[.page-chip-expanded]:z-4 has-[.page-chip-context-menu-open]:z-4 has-[.page-chip-tooltip-open]:z-4'

  return {
    chipClasses,
    iconChipClasses,
    slotClasses,
    frame,
    styleVars,
    expandedFill,
  }
}
