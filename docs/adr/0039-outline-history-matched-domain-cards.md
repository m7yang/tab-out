# ADR 0039: Outline History-Matched Domain Cards

- Status: Accepted
- Date: 2026-09-21

## Decision

Activation History hover and focus outline the full matching Domain Card,
including its domain header and page list. A neutral 1px decorative frame sits
eight pixels outside the card with a 40px squircle radius, without changing its
layout or intercepting input. It appears and disappears immediately with the
matched Page Chip outline, with no independent fade or delay.

The frame leaves a nominal 16px gap at the sides and bottom, using 8px internal
padding plus the frame's 8px outset. The top uses 4px internal padding for a
12px gap to the header's line box, accounting for the additional space above
the visible letters. The matched Page Chip outline extends 2px beyond its box,
leaving a 13px clear gap to the inside edge of the 1px outer frame at the sides
and below the last chip. The 40px outer squircle radius balances corner clearance
across one-line and two-line Page Chips with a declared 17px radius. In a local
Chromium comparison of 30, 32, 36, 40, and 44px, it had the smallest maximum
sampled clearance error across those chip heights and a short card. This is a
fit for this spacing and stroke geometry, not a universal nested-radius rule.

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

## Rationale

The domain header identifies the relationship between chronological history and
the grouped dashboard. Framing only the inner `mission-card` would omit that
label. A quiet neutral frame connects the surfaces while preserving the stronger
amber emphasis on exact pages and keyboard focus.

## References

- [Dashboard interaction contract](../../CONTEXT.md)
- [Shared Page Chip language and landmarks](0033-share-page-chip-language-and-landmarks.md)
