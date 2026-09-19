# ADR 0031: Own Filter Match Navigation In A Local Session

- Status: Accepted
- Date: 2026-09-19

## Decision

Filter Match keyboard navigation lives in
`src/components/filter-result-navigation/` behind a session owned by one mounted
Filter Query input. The session owns selection, pending keystrokes, query and
Dashboard View / Source reconciliation, and the ordering of selection and
activation. A focused React hook forwards keyboard events and committed result
snapshots and disposes the session on unmount. A DOM adapter owns mounted-target
checks, position reads, selection paint, scrolling, and the existing synthetic
Page Chip click with its original modifiers.

The session has no React dependency or external-store subscription. It operates
synchronously on events and layout-phase commits; constructing it has no effects.
Its internal surface seam has two adapters: the browser DOM and an in-memory
fixture for navigation sequences. Pure identity and spatial-selection rules
remain in `src/extension/filter-result-navigation.ts`, alongside the existing
candidate projection consumed by App and Page Chips.

## Rationale

The Header module previously combined isolated selection helpers with pending
intent, result hydration, Source changes and DOM effects. Extracting just the
helpers left that protocol spread between the event handler and layout effects.
The session now provides one place to exercise both immediate and deferred
navigation through the same interface the React adapter uses.

Existing behavior is preserved: selection initially belongs to the input;
horizontal arrows retain native editing until a match is selected; only mounted
matches participate; queued input is consumed when a target is available or the
search settles; query edits and Dashboard View / Source changes invalidate
pending intent. Activation consumes pending intent before dispatching the click.
Result commits can transfer selection by Dashboard Item Identity without
scrolling, while explicit navigation scrolls the selected match into view.

The React adapter retains commit timing and the DOM adapter retains imperative
selection markers. This is an ownership change, not a conversion of selection
paint to React state. It adds no global state or dependency, and does not change
Dashboard Intake, Tab Actions, Title Expansion, or filter-result projection.
Disposal clears the old target and input markers; a subsequent setup can commit
a fresh context, including React's development lifecycle replay.

## Verification

Session sequence tests use the in-memory adapter to cover pending intent,
supersession, settlement, identity replacement, geometry, disposal and isolation.
Browser tests retain responsibility for DOM markers, mounted-target visibility,
scrolling, focus and modifier activation. Independent pure selection and
candidate-projection tests remain useful and are retained.

## References

- [Filter Query contract](../../CONTEXT.md)
- [ADR 0014](0014-adopt-effect-behind-dashboard-intake-seams.md) — browser rendering lifecycles remain outside Effect
- [ADR 0026](0026-chip-text-layout-engine-behind-a-chip-owned-seam.md) — the existing per-surface session pattern
