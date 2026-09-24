# ADR 0046: Bound Hammerspoon Close Inspection And Creation Retries

- Status: Accepted
- Date: 2026-09-24

## Context

After batching native Chrome inventory metadata, a live inventory still takes
about 67 ms. Repeating it on a 50 ms creation poll can occupy Hammerspoon's main
thread while the creation token is unavailable. Command-W also scans the
Accessibility tree synchronously in its event handler. Global ordered-window
enumeration queries unrelated applications, including unresponsive ones.

## Decision

- Give Command-W's tab scan a 50 ms deadline shared by its Accessibility reads.
  Stop after two tabs because Chrome must handle that case. Only a complete
  successful scan can prove one tab; errors, depth limits, and expiry leave the
  original key event to Chrome.
- Keep the first eligible creation match immediate. After an unsuccessful
  inventory, wait at least 200 ms from its completion before trying again.
  Timer and window-created callbacks share this gate and the existing overall
  creation deadline. No identity check is removed or cached across attempts.
- Read recovery z-order and geometry from fresh WindowServer metadata across
  all on-screen layers. Standard always-on-top windows remain eligible targets
  and obstructions; layer number cannot replace Accessibility classification.
  Skip other displays, other Spaces, hidden applications, and background or
  accessory applications, preserving the old ordered-window eligibility.
  The remembered recovery window already has its eligibility validated. Only
  possible obstructions ahead of it need process-specific Accessibility reads,
  sharing a 50 ms inspection budget. Missing identity, unavailable Space data,
  or unreadable obstruction state prevents interception. Verified nonstandard
  windows remain excluded. Acquire the application through `hs.application`
  and wrap its existing AX element so the timeout is set before the first read;
  the PID-based AX constructor performs an implicit unbounded role query.
- Desktop Window Merge refreshes only the authorized Chrome process's windows,
  unions them with watcher-tracked windows, and orders that set using native
  on-screen IDs. This retains untracked-window discovery and the existing
  profile, Space, display, and confirmation checks. It amends ADR 0020's use of
  global `hs.window.orderedWindows()` without changing the selection contract.

## Consequences

Healthy first matches incur no new delay. A token that becomes available after
an unsuccessful match may wait for the retry interval. A slow or incomplete
close inspection leaves closure to Chrome and the existing best-effort recovery
monitor; it never authorizes whole-window close from a partial single-tab count.

WindowServer metadata and Accessibility snapshots can still change between
reads. Existing exact-window validation and conservative rejection remain
necessary. Read-only timings and scenario tests do not replace user-observed
create, reuse, close, and Desktop Window Merge acceptance across displays.
