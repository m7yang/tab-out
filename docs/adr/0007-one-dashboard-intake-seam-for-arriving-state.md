# ADR 0007: One Dashboard Intake Seam For Arriving State

- Status: Accepted
- Date: 2026-07-29

## Context

Dashboard state reaches the page through four paths: the startup cache
subscription, the latest-refresh runner, the source-switch retry loop, and the
dashboard refresh trigger used by Tab Actions, undo, and Saved Page actions.
Each path carried its own race protocol (revision guards, sequence refs,
request-context matching), and final arbitration lived in the root React
component's reducer. The recurring dashboard-state regressions all landed in
this spread-out protocol.

The dashboard build additionally persisted Saved Page metadata as a hidden
side effect. Because the same builder runs on pages and in the service worker,
two processes were writers of the Saved Pages storage key without an explicit
decision, and the ambient write produced a build → storage event → rebuild
loop that was suppressed with an equality check rather than removed.

## Decision

- Dashboard builds are pure. `buildDashboardDataFromTabsEffect` and
  `buildTabsDashboardStartupSnapshotEffect` return the Saved Page metadata refresh
  as data (`savedPageUpdates: { base, merged }`) instead of persisting it.
  Nothing transient enters `DashboardData` or the cached snapshot shape, so
  the startup cache contract is unchanged.
- Page-side fetchers are the only Saved Pages metadata writers. The service
  worker's snapshot rebuilds never write Saved Pages; stale metadata heals on
  the next dashboard-page build. The writer remains idempotent: equal stores
  produce no read and no write, and a concurrent user mutation always wins
  over an advisory render snapshot.
- The arrival paths consolidate behind one extension-layer Dashboard Intake
  store consumed via `useSyncExternalStore`. The migration landed
  strangler-style: first relocate the non-React fetch orchestration out of the
  hooks layer, then port the app dashboard reducer wholesale, then move one
  arrival path per slice so no slice splits a protocol across the seam.
- The store stays DOM-free. Pre-commit DOM work (card-move rect capture,
  hover-preview clearing) registers through a `subscribeBeforeApply(reason)`
  lifecycle notification; callers keep stating intent only.
- The dashboard refresh trigger keeps its call sites, while its settle and
  option-merge semantics live in the intake module. The former registration
  indirection was deleted when the store took ownership of refresh.

## Consequences

Builds are provably side-effect free and testable without storage; the
duplicate metadata refresh loop is removed rather than suppressed; and the
Saved Pages key has one writing process. A closed Saved Page can now carry
stale metadata across a browser restart if no dashboard page opened after the
change; the same open that would reveal it also heals it.

Source-switch snapshot commits leave `startTransition` when the store lands,
because `useSyncExternalStore` updates cannot be transitions. A 1,008-card
fixture comparison found that the synchronous store path added a roughly 68
ms median long task even though first-content timing stayed level. The page
therefore mirrors store snapshots and schedules only an arriving source
snapshot inside a transition; all other arrivals remain synchronous. This is
an adapter detail, not a seam change.

The migration is complete. Startup admission, live refresh, source switching,
and closed-tab updates now arbitrate through the intake store; the React layer
only subscribes to its snapshot and performs registered pre-commit DOM work.

## References

- Startup contract: [`CONTEXT.md`](../../CONTEXT.md)
- [ADR 0005](0005-separate-warm-snapshots-from-durable-checkpoints.md) — the
  Warm Snapshot / Durable Checkpoint cadence this seam builds on
