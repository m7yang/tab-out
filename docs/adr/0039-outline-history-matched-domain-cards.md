# ADR 0039: Outline History-Matched Domain Cards

- Status: Accepted
- Date: 2026-09-21

## Decision

Activation History hover and focus outline the full matching Domain Card,
including its domain header and page list. A neutral 1px decorative frame sits
eight pixels outside the card with the same declared 50px squircle radius at all four
corners, independent of its Page Chips and without intercepting input. It appears and disappears immediately with the
matched Page Chip outline, with no independent fade or delay.

The frame leaves a nominal 16px gap at the sides and bottom, using 8px internal
padding plus the frame's 8px outset. The top uses 4px internal padding for a
12px gap to the header's line box, accounting for the additional space above
the visible letters. The matched Page Chip outline extends 2px beyond its box,
leaving a 13px clear gap to the inside edge of the 1px outer frame at the sides
and below the last chip. The original 40px outer squircle radius balanced corner clearance
across one-line and two-line Page Chips with a declared 17px radius. In a local
Chromium comparison of 30, 32, 36, 40, and 44px, it had the smallest maximum
sampled clearance error across those chip heights and a short card. This is a
fit for that earlier spacing and stroke geometry, not a universal nested-radius
rule. The per-card fitting update below supersedes this fixed radius.

The dashboard scroller reserves 10px of top and left paint clearance so its
overflow clipping cannot cut off the first card's 8px outset. The left negative
margin preserves horizontal card alignment. The scroller starts below the header
without a top overlap, so scrolling text cannot paint behind the transparent
header. Right and bottom clearance come from the existing scrollbar gutter and
trailing space.

The bottom scroll cue extends across that horizontal paint clearance, covering
the entire outline so its side edges and bottom corners fade together with the
card content. It retains its existing stacking order below expanded Page Chips
and stays clear of the scrollbar.

In the side-by-side layout, the facing edges of the history and dashboard cues
fade horizontally over 12px as well as vertically. The dashboard reserves that
additional width outside its existing 10px clearance, so the side fade finishes
before the card outline. The stacked layout keeps the original vertical fade.

The frame follows the existing matched Page Chip and collapsed-overflow states.
It inherits their exact-page matching and preview lifetime, including context
menus, without adding a second hover store or domain resolver. Existing page
emphasis remains intact. Hidden cards stay hidden and offscreen cards stay put.

## Capsule nesting update — 2026-09-26

The original 40px fit above predates continuous-capsule Page Chips. The shared
static/traveling card frame uses a **50px** compact-capsule reference, fitted to a 26.25px
compact capsule's 1px match outline with 1px offset, retaining the 16px box gap
and 1px inward card border. The native general-contour fit selects about 49.9px;
nearest-half-pixel rounding gives 50px. Clear spacing is approximately
12.46–13.52px around the 13px straight band. See the
[nested-radius audit](../nested-radius-audit-2026-09-22.md#applied-capsule-nesting-correction--2026-09-26).

Short cards retain CSS radius overlap reduction; tall Page Chips and overflow
controls keep their own shapes and existing layout. This token fits the normal
compact capsule reference rather than claiming identical spacing for every
inner silhouette. Matching, motion and stroke widths remain unchanged.

## Fixed-corner contract — 2026-09-26

Use one 50px squircle token for every card outline, with equal corners.
The user explicitly chose squircles, symmetric corners, a content-independent
card radius, and a Page Chip squircle fit that overlaps the capsule reference.
This supersedes the earlier 47/48.5/55px per-card fitting experiment and rejects
custom non-capsule offset contours or asymmetric top/bottom radii.

Preserve natural card height and content spacing. The user explicitly rejected
adding height to keep the used radius at 50px. All cards share the declared
50px token; CSS may reduce all four radii equally in short cards. In the
83.25px-high compact outline, the used radius is 41.625px. Do not add a minimum
height, move the page list to the bottom, or choose a radius from chip contents.
The existing side/bottom chip insets remain 16px.

The static pseudo-element and moving frame both use the theme token. Remove
per-card radius computation, mutation, and extra observations; observe the
unique target for bounds as before. Coincident Page Chip outlines still
invalidate their geometry when the target radius changes without a resize.

The fixed radius is fitted to the one-line capsule reference. Other chip
shapes retain small clearance differences, documented in the
[current audit](../nested-radius-audit-2026-09-26.md); matching CSS squircles and
capsules do not promise an exact parallel band.

## Rationale

The domain header identifies the relationship between chronological history and
the grouped dashboard. Framing only the inner `mission-card` would omit that
label. A quiet neutral frame connects the surfaces while preserving the stronger
amber emphasis on exact pages and keyboard focus.

## References

- [Dashboard interaction contract](../../CONTEXT.md)
- [Shared Page Chip language and landmarks](0033-share-page-chip-language-and-landmarks.md)
