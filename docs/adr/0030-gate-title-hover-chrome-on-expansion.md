# ADR 0030: Gate Title Hover Chrome On Expansion

- Status: Accepted
- Date: 2026-09-16

## Decision

Expandable Page Chips and Activation History rows mark their collapsed state on
the surface. The shared `title-interaction` CSS variant excludes that surface
and its descendants from hover chrome until expansion commits. Short titles keep
ordinary hover feedback. Existing expansion ownership and measurement policies
remain with their current modules.

## Rationale

CSS hover can begin before React opens a title, or survive after an outside
activity closes it. Letting it independently paint the fill, rim, fade, frame, or
favicon action produces a collapsed chip that looks expanded. Gate those paints
on the same render as expansion, including nested controls. Page Chips also use
their known clamp when deciding whether to open: captured lines can fit their
replacement DOM even though the natural title still has hidden content.

## References

- [Title Expansion contract](../../CONTEXT.md)
- [Expansion ownership](0021-expansion-ownership-lives-in-the-title-expansion-controller.md)
