# ADR 0015: Admit One Truthful Startup Frame

- Status: Accepted
- Date: 2026-08-08

## Context

The generated Dashboard shell paints quickly and preserves focus, but the
current startup path can then expose a cached state before replacing it with
live state. A recently completed Tab Action can therefore briefly revive a
stale Dedupe action, while independently arriving history inputs can reorder
Activation History immediately after it appears. The alternatives are to
accept bounded visible staleness, make every first dynamic frame live, or add
enough cross-input revision tracking to prove a cached result still represents
one coherent current generation.

## Decision

The first dynamic-content paint is one complete **Startup Frame** admitted at a
startup-only seam immediately before Dashboard Intake. Dashboard data, header
actions, Activation History, Working Set, recently closed rows, dismissals,
and stored display preferences share one whole-generation freshness decision.
Every Startup Frame is built from live inputs. Warm Snapshots and Durable
Checkpoints may seed ordering or reconstruction, but neither is admitted as
visible Dashboard state by itself. The generated shell remains interactive
until the live Startup Frame is ready. Normal refreshes and source switching
remain owned by the existing Dashboard Intake seam.

The shell stays visually quiet throughout capture and after an unsuccessful
attempt: it shows no loading label, spinner, skeleton, startup failure copy, or
Retry control. Filter and source controls remain interactive, and their latest
intent participates in the page-local attempt revision.

A generation succeeds only when every semantic authority represented in the
frame is known: open tabs and windows, Activation History, Working Set, Saved
Pages, recently closed rows, dismissals, pins, and history range. Confirmed
absence is a known value; an unknown read fails the generation rather than
silently defaulting or omitting a surface. Purely decorative metadata that
changes no content, order, or action may use its deterministic fallback.

A cached frame cannot be proven current with one cheap tab query: window focus,
tab-group colors, Activation History, Working Set time decay, recently closed
rows, Saved Pages, dismissals, and preferences have separate authorities.
Opening Tab Out also changes visible inputs that the existing current-page
overlay does not reconcile. Preserving visible cached admission would therefore
require per-input revisions and a comprehensive current-page delta transaction.
That machinery is rejected in favor of one live first frame; the measured
source-plus-projection compute remains under 8 ms p95 at 500 tabs, so it does
not justify the extra state protocol.

The Warm Snapshot is reduced to generation metadata, card order, URL-keyed
Working Set priority and epoch, and session-only title-retention data. Durable
promotion retains only the restart-safe card-order and Working Set seeds.
Render-ready view models, full Dashboard and history payloads, recently closed
rows, dismissals, display preferences, the current-page overlay, and background
work used only to keep those cached surfaces coherent are removed.

If a live Startup Frame cannot be built, the shell stays visually quiet instead
of presenting an empty Dashboard or stale cache. A live attempt
subscribes to material browser, storage, service, and page-input changes before
capture, and only an unchanged page-local attempt revision may commit. A change
coalesces a new capture within the original five-second deadline; the deadline
does not reset. An error or deadline invalidates the attempt and releases
Dashboard Intake, so late results cannot commit. Returning the page to visible
or a material input change can start a fresh generation after failure through
one coalesced flight. There is no explicit Retry action or timer-driven retry
loop. This supersedes ADR 0005 where that decision permits either a Warm
Snapshot or Durable Checkpoint to supply visible content before live state
arrives.

## Consequences

Every load waits for live inputs before showing dynamic content, but the shell
still paints and becomes interactive immediately. Warm and Durable state can
preserve useful ordering without a Dirty Fence, two-slot commit, per-input
revision vector, or current-page delta journal. Startup admission becomes one
focused module rather than a redesign of normal Dashboard Intake. The quiet
shell avoids replacing stale-content flicker with transient startup status UI;
an unsuccessful capture intentionally remains an interactive shell until a
material change, visibility return, or page refresh starts another attempt.
