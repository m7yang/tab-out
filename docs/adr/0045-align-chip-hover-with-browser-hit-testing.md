# ADR 0045: Align Chip Hover With Browser Hit Testing

- Status: Accepted
- Date: 2026-09-22

## Decision

Full-width Domain Card Page Chips have a transparent rectangular pointer surface
behind their content and controls. Activation History already has a rectangular
inner focus surface. Rounded fills and outlines keep their existing appearance.

Expansion entry, pointer movement, and outside-activity checks accept the browser's
hit target within one CSS pixel of the measured surface bounds. This is conditional
on the event targeting that surface or a descendant; ordinary geometric checks
remain sufficient inside the bounds. The resting slot still limits reopening
after an expanded surface closes.

## Rationale

Adjacent chip bounds overlap by one pixel, but Chrome can hit a chip just outside
its fractional layout edge. Strict geometry checks then reject the same pointer
that CSS considers hovered, leaving neither chip's expansion chrome visible.
Rounded corners also left small unowned areas between Domain Card chips.

A rectangular hit surface closes the corner holes. Deferring to the native hit
target at fractional edges removes the disagreement without adding an exit timer
or an unconditional hover margin. The one-pixel limit prevents overflowing
descendants from extending slot ownership beyond that rounding fringe.

## References

- [Title Expansion contract](../../CONTEXT.md)
- [Expanded interaction bounds](0040-use-expanded-history-chip-interaction-bounds.md)
- [Hover chrome gating](0030-gate-title-hover-chrome-on-expansion.md)
