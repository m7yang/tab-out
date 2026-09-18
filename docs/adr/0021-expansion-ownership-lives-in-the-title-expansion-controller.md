# ADR 0021: Expansion Ownership Lives In The Title Expansion Controller

- Status: Accepted
- Date: 2026-08-24
- Last reviewed: 2026-09-19

## Decision

The Title Expansion controller owns the keep-open ownership rules that Page Chips
and Activation History rows previously restated as scattered `contextMenuOpenRef`
guards. `hold('context-menu' | 'keyboard-focus')` returns an idempotent release;
holds are refcounted per owner kind so overlapping menus on one chip stay safe.
Any held owner vetoes synchronous `close()`; only `context-menu` keeps the
expansion through a lane steal;
`closeNow()` and `dispose()` bypass owners. Two decisions stay surface-side
because they need DOM knowledge the headless controller must not have: force-open
on menu open, and the backdrop-dismiss containment check before the post-release
close.

The delayed-close scheduler was removed after confirming that every production
caller closes synchronously. The controller no longer accepts a delay, scheduler,
or pending-close cancellation; tests exercise immediate closure and ownership.

## Consequences

Sharing ownership does not reopen ADR 0002: measurement policy remains
per-surface, and this controller was already the sanctioned shared half. URL
preview retention while a menu is open is a separate contract and keeps its
surface-side guards. Future reviews should not push ownership back to the
surfaces; the controller tests state the CONTEXT.md ownership sentences directly.

## References

- [ADR 0002](0002-title-expansion-measurement-stays-per-surface.md) — the
  per-surface measurement rejection this decision leaves intact
- [`CONTEXT.md`](../../CONTEXT.md) — the Title Expansion ownership contract
