# ADR 0033: Share Page Chip Language And Landmarks

- Status: Accepted
- Date: 2026-09-19

## Decision

Adopt shared Page Chip vocabulary and landmarks across Domain Cards and
Activation History. [CONTEXT.md](../../CONTEXT.md#domain-language) owns the
definitions; the [UI guide](../agents/ui.md#page-chip-landmarks) owns selector
rules and inspection guidance.

## Rationale

Separate visual names obscured shared favicon, title, and interaction concepts.
A shared landmark supports cross-context inspection, while its qualifier keeps
card-only counting, navigation, and geometry consumers precise. Reusing the
chip landmark on the history wrapper would incorrectly include the index and
gutter; marking both base and expanded surfaces would count one item twice.
This selector contract must migrate together with its runtime and test consumers.

Implementation identifiers and CSS classes retain their existing names.
Grouping, activation targets, persistence, and expansion policies remain owned
by their existing contexts. In particular, [ADR 0002](0002-title-expansion-measurement-stays-per-surface.md)
and [ADR 0026](0026-chip-text-layout-engine-behind-a-chip-owned-seam.md) still apply;
their original Page Chip references mean Domain Card Page Chips. Historical
ADRs retain the terminology used when those decisions were made.
