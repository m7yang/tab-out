/* ================================================================
   Chip Trim — the module interface (CONTEXT.md: Chip Trim).

   The per-kind surface paint and seam participation of a Page Chip —
   active frames, group/saved-page interaction outlines, interaction
   fills, slot seam overlap, and interaction z-order — decided by one
   decision table. Consumers import from here only; files inside this
   directory are implementation.

   The contract, in full:

   • chipTrim(facts) → { chipClasses, iconChipClasses, slotClasses,
     frame, styleVars, expandedFill }. Facts in, paint out — kind
     resolution and precedence (an active frame suppresses the group
     outline) live INSIDE the table, never in callers.

   • Plain full-width chips have no resting trim, but gain a quiet
     outline on interaction, matching the closed-page treatment. Their in-flow fills stay translucent so a
     neighbour's line on the shared seam row shows through. Icon-only
     chips retain their outside ring instead of gaining an inset rim.

   • Adjacent full-width chip slots overlap by 1px so coinciding trim
     lines render once. Whoever paints on the shared row either draws
     a line there (frames, outlines) or lets the neighbour's line show
     through (translucent fills; the expanded fill layer spares edges
     flush with the resting seam).

   • The module is single-language: the seam rules that used to live in
     a CSS rump (slot overlap, interacting z-lift, hover frame
     strengthen) ride in the emitted class strings as previous-sibling /
     has-[] / group-hover arbitrary variants. They still compile to
     plain CSS selectors, so interaction chrome swaps inside one style
     recalculation (the hover-flash lesson, 2026-06-13) — never own an
     interaction highlight from React state.
   ================================================================ */

export { chipTrim, CHIP_TRIM_TOKENS } from './trim'
/** @public — sanctioned seam surface (consumers import from the barrel; ADR-0002). */
export type { ChipTrim, ChipTrimFacts } from './trim'
