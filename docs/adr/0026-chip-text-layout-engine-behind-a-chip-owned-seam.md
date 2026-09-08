# ADR 0026: Chip Text Layout Engine Behind A Chip-Owned Seam

- Status: Accepted
- Date: 2026-09-08

## Decision

The Page Chip's title measurement, clamp capture, packed-width revalidation,
expansion geometry, and fragment machinery live in
`src/components/page-chip-text-layout/` as one deep module instead of fused
into `PageChip.tsx`. Its interface is a React-free session
(`createChipTextLayoutSession`: attach, content key, expanded gate, commit,
expansion measurement, snapshot/subscribe) plus the masonry entry point
`validatePageChipTextLayoutsAfterMasonry` — the former standalone validation
registry folded in because it was a pass-through between the dashboard shell
and this engine. `useChipTextLayout` is a thin binding that owns only React
phase adaptation: layout-phase attachment/commit, after-paint observation, and
node building (clamped rows and expanded lines cross the facade as React
nodes, never as HTML strings). Internally the module keeps a node-pure policy
seam (clamp-key validity, packed-revalidation decisions, expansion placement,
marker class carriers) with direct unit tests, and a real-Chrome fixture spec
drives the session on fixture DOM without mounting React.

Phase discipline is load-bearing and deliberate: commits and masonry jobs run
in the layout phase and record every measured size; observation happens after
paint so the resize observer's initial callback stays silent at startup and
fires exactly once for a remounted element that still needs its first measure.
The owner reports expanded-state flips synchronously through the facade's
`setExpanded`, so in-flight masonry jobs see the gate before the next commit.

## What Deliberately Did Not Move

- Interaction stays in `PageChip.tsx`: gesture handlers, hover/preview policy,
  context-menu focus recovery, `ChipFaviconFrame`, variant-row rendering, and
  the ADR 0021 controller wiring (the engine reports geometry; it never owns
  open/close).
- Shared primitives stay shared: `title-expansion/` (ADR 0002's sanctioned
  seam), `size-change-observer` (also used by Activation History), and
  `font-metrics-invalidation` are consumed, not absorbed.
- Measurement policy stays per-surface (ADR 0002 intact): this is the chip's
  own engine gaining a seam, not a convergence with the history rows' engine.

Future reviews should not re-flag the remaining `PageChip.tsx` interaction
mass as an unfinished half of this extraction, and should not propose merging
this engine with the Activation History measurement engine unless the
surfaces' measurement policies themselves converge first.

## References

- [ADR 0002](0002-title-expansion-measurement-stays-per-surface.md) — the
  per-surface measurement decision this extraction preserves
- [ADR 0021](0021-expansion-ownership-lives-in-the-title-expansion-controller.md)
  — expansion ownership, unchanged by this seam
