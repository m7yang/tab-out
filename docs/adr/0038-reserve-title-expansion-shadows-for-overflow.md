# ADR 0038: Reserve Title Expansion Shadows For Overflow

- Status: Accepted
- Date: 2026-09-21

## Decision

Domain Card and Activation History Page Chips add the expansion shadow only
when the existing expansion measurements indicate growth beyond the resting
surface. Horizontal growth allows one pixel of rounding tolerance. Vertical
growth includes content that must wrap when constrained by the viewport.
Existing current and active-tab resting treatments remain intact.

## Rationale

Revealing a suppressed label within the same footprint should look like ordinary
hover. A floating shadow helps separate expanded content from its surroundings
when the surface grows beyond that footprint. Expansion state alone does not
communicate that distinction.

Each surface keeps its existing measurement engine and expansion ownership;
this decision changes paint, without adding measurements or changing geometry.

## References

- [Title Expansion contract](../../CONTEXT.md)
- [Per-surface measurement](0002-title-expansion-measurement-stays-per-surface.md)
- [Hover chrome gating](0030-gate-title-hover-chrome-on-expansion.md)
