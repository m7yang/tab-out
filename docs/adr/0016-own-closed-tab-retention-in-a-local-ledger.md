# ADR 0016: Own Closed Tab Retention in a Local Background Ledger

- Status: Accepted
- Date: 2026-08-08
- Acceptance evidence: Partial; the storage and performance gates passed on
  2026-08-08, while the remaining release matrix stays open

## Context

Tab Out previously had three different closed-page models:

- Saved Pages preserve explicit user intent in the Tabs source;
- Activation History projects Chrome-owned recently closed sessions; and
- Tab Action Undo temporarily remembers the physical tabs closed by one action.

None can own general Closed Tab Retention. Saving must remain explicit, Chrome
Sessions exposes only a small and short-lived chronology, and Undo is an
in-memory action snapshot rather than a durable page model. A retained page
must also be captured when no Dashboard is open, survive Manifest V3 worker
termination, distinguish normal tabs from standalone apps, reject stale event
replay, and participate truthfully in the Dashboard's one Startup Frame.

The product model retains one latest page snapshot rather than every physical
closure. It includes ordinary web pages, files, Chrome pages, pages owned by
other extensions, and standalone apps even though some of those exact targets
may not be reopenable at a later moment. Eligibility and reopenability are
therefore separate concerns.

## Decision

### Keep the four closed-page models independent

Closed Tab Retention is a new Tab Out-owned domain record. It never converts to
a Saved Page, Chrome session, Activation History row, or Undo snapshot. Those
owners remain independent even when one Page Chip coordinates their visible
state.

A Retained Page uses surface kind plus the existing canonical dedupe key of the
unwrapped effective URL as identity. The ledger key is a SHA-256 digest of that
identity, while the newest exact effective URL remains available as the recovery
target. This preserves existing safe canonicalization without treating a digest
or normalized key as a navigable URL. Normal-tab and app surfaces remain
separate.

Each identity owns one latest automatic snapshot and one capacity slot. A newer
genuine closure refreshes the exact URL, useful metadata, closure time, and
stable closure token. Repeated physical duplicates add no occurrence list or
duplicate count. Unsaved Retained Pages expire after 30 days and the ledger
keeps at most 500 visible identities globally, pruning expired entries before
least-recently-closed capacity eviction. Saved Pages neither expire nor consume
this capacity.

### Use a background-owned local ledger and two inventories

One `RetainedPages` service in the worker's existing Effect runtime is the sole
semantic reader and writer for automatic capture, migration, pruning,
activation consumption, and explicit removal. Dashboard pages issue commands
and read projections; they do not mutate retained storage directly. Browser
Tabs Gateway remains the live Chrome action boundary, not a retained-state
owner.

Use three separately versioned whole-store envelopes:

- the authoritative Retained Page Ledger in `chrome.storage.local`;
- the complete current-session Open Surface Inventory in
  `chrome.storage.session`; and
- a compact prior-session Open Surface Inventory in `chrome.storage.local`.

The inventory follows every eligible physical lifetime with a stable random
closure token and the exact information required to capture it. It deliberately
does not store tab-strip position, Chrome group or pin state, document history,
scroll, form state, or content. Incognito is rejected before normalization,
hashing, logging, inventory, or persistence. All retained stores are
device-local and accessible only to trusted extension contexts.

The ledger may keep an invisible Removal Boundary containing only the identity
digest, acted-on closure token, and original expiry boundary. It has no URL,
title, favicon, visible projection, or capacity cost. It prevents a worker
restart or delayed event from replaying an activated or explicitly removed
snapshot, then expires when that snapshot would have expired.

### Reconcile physical lifetimes, not browser history

First installation seeds the inventories without retroactively retaining every
open page. On ordinary close, persist the ledger outcome before removing the
lifetime from either inventory. A valid current-session candidate is preferred;
only a matching valid durable candidate may substitute. Dashboard state,
Activation History, Chrome Sessions, and browser history are never capture
fallbacks.

Browser startup is a physical-lifetime boundary: every prior durable lifetime
is inferred closed before current live tabs are seeded with new lifetimes, even
when Chrome restores a matching page. A worker restart within the same browser
session trusts session inventory and infers only missing lifetimes. Extension
reload or update preserves surviving tab IDs and reseeds the remainder.
`tabs.onReplaced` transfers the closure token rather than manufacturing a
closure. Stable tokens make every reconciliation and partial-cleanup replay
idempotent.

An idle close batch starts at the next microtask without a timer. Closure events
delivered while one asynchronous transaction is in flight accumulate behind it
and drain together as the next transaction; settlement requests from one or
more Dashboard pages await that same physical-lifetime result. Within each
transaction, token-guarded bulk inventory transforms and an indexed bulk ledger
mutation preserve event order while cloning each large store once per phase.
An automatic capture write retries once immediately; persistent failure leaves
the previous durable ledger and candidate intact where possible, never blocks
the physical close, schedules no failure-only timer, and records a session-only
degraded-health episode. The service keeps one earliest-expiry Chrome alarm and
also prunes on startup, read, and write. Projection filters expired records even
when durable cleanup is delayed.

### Recover one exact page and consume by comparison

Retained activation is URL-based recovery, not session restoration. It never
stores a Chrome session ID or calls `chrome.sessions.restore()`. Revalidate the
exact target before mutation, reuse a matching live target when possible, and
otherwise open the newest exact effective URL through the existing Page Chip
modifier contract. App records retain app identity for presentation and
capacity but fall back to a normal browser tab when their former app surface is
closed.

Activation is single-flight per retained identity across Dashboard pages. A
confirmed recovery conditionally consumes only the identity and closure token
the user acted on. A newer genuine closure wins over delayed consumption. An
unavailable or unconfirmed target keeps the Retained Page. Browser success
followed by ledger-write failure is not reversed: both the recovered page and
retained record remain, no automatic retry runs, and the Dashboard reports that
Tabs could not be updated.

**Remove from Tabs** uses the same conditional comparison and has no Undo.
Concurrent removal is idempotent, already-absent or expired state is success,
and a newer closure defeats delayed removal. It never affects a live tab,
Saved Page, Activation History, Chrome history, or physical-tab Undo. Explicit
removal writes do not retry automatically.

### Project one shared closed-page presentation

The Retained Page Ledger is a required live semantic input to the Startup Frame
and every full Tabs refresh. It is not stored in Warm Snapshot, Durable
Checkpoint, Activation History `closedTabs`, Browser Tabs Gateway state, Saved
Pages, or a render-ready seed. A retained storage change invalidates a Startup
Generation or schedules an authoritative full refresh after startup; a
storage-event `newValue` is never installed as a partial view patch.

A matching live page or Saved Page suppresses a separate retained chip. Saved
state wins target, metadata, surface behavior, and save/remove action while the
independent retained lifetime continues underneath. Multiple exact Saved Pages
that share one canonical retained identity remain separately actionable; the
projection cannot discard explicit saved intent.

Saved-only, retained-only, and combined state use the existing closed Page Chip
without a retention badge, icon, region, duplicate count, or resting visual
distinction. Counts describe actionable closed targets with generic copy such
as `n closed`. A visible retained-only target exposes **Save page** and
**Remove from Tabs**; visible Saved state exposes **Remove saved page**. V1 has
no group-wide, Domain Card, filtered, source-wide, or global retention clearing
surface.

### Keep `chrome.storage.local` with a compact ledger envelope until measurements require more

Whole-store `chrome.storage.local` is the baseline because it matches existing
durable ownership and cross-context change notification. The ledger writer
serializes an allowlisted compact v1 JSON value, omits fields duplicated by map
keys, reconstructs canonical keys from exact URLs on read, then stores the
lossless result in a `gzip-base64-json-v1` whole-store envelope. Readers retain
compatibility with the earlier expanded uncompressed v1 value. Known schemas
migrate at the owner; known identity changes reindex from the stored exact URL
and surface, retaining the newest collision. Unknown newer envelopes are
preserved without overwrite. Open Surface Inventory schema 2 marks identities
already derived by that owner; legacy schema 1 reindexes and rewrites once, so
later cold workers do not repeat the hashes. Exact Saved Pages gain surface identity
independently and are never collapsed by retained reindexing.

Keeping that baseline is conditional on the installed-extension benchmark:
retained keys must remain at or below 50 percent of Chrome's 10 MB local quota,
the **Complete Representative Local Profile v1** at or below 80 percent,
Retained Pages may add no more than 100 milliseconds p95 to Startup Frame
capture, one close must stay at or below 250 milliseconds warm p95 and 500
milliseconds cold p95, and a 500-close burst must become durable within one
second p95 using at most three ledger writes. The versioned complete profile
seeds every recognized steady-state local-storage key with checked-in, bounded,
generic fixtures while retaining the saturated Retained Page values. It is an
acceptance population, not a maximum-valid claim, and creates no cap, rejection
rule, or eviction behavior for unrelated features. Over-quota tests must
preserve the previous valid ledger, acted-on snapshot, and required replay
boundary rather than truncate an exact URL or sacrifice replay safety.
The benchmark records the complete fixture hash and requires every named key to
remain present. Post-barrier exact equality applies to the eight stable keys;
the Startup Seed and global Tab History remain live-owned and may change through
their normal checkpoint and navigation paths, so their observed hashes are
reported instead of freezing legitimate product behavior.

Close-latency gates measure extension-owned product work from the last
`tabs.onRemoved` event delivered by Chrome through the durable Retained Page
Ledger write. Warm and cold distributions differ only in whether the MV3 worker
is already running when Chrome delivers that event. The physical close request
through event delivery remains outside extension control, so benchmarks report
that end-to-end time separately. A cold installed-extension lane may enforce the
same threshold against the stricter close-command-through-production-settlement
upper bound when directly instrumenting the restarted worker would change the
cold lifecycle under test; passing that upper bound proves, but does not redefine,
the event-to-durable-write product gate. Startup Frame contribution uses paired
empty and saturated profiles and the navigation document's page-local
`performance.now()` from its time origin through the exact header-stats
publication that admits the complete Startup Frame. Playwright wall time through
navigation and locator observation includes automation transport and polling,
so it remains a separate diagnostic rather than the product gate. Every timed
navigation uses a fresh extension page after its completed seed barrier while
the installed service worker remains warm; this models independent new-tab
documents without carrying a saturated renderer heap into the next sample.
The complete timing phase finishes before the separate 30-pair diagnostic phase performs footprint,
full-ledger decode, recursive hashing, or exact readback work. This keeps
benchmark-owned multi-megabyte allocations and their later garbage collection
outside every product-gate sample.

IndexedDB is deferred. If measured saturated storage or write behavior fails,
first reduce or re-encode remaining redundant inventory data while preserving
one semantic owner. Adopt IndexedDB only when those steps remain insufficient or
a future feature needs indexed queries, and only with an explicit migration and
a replacement for `chrome.storage.onChanged` invalidation.

The deterministic saturated fixture supports the compact local representation.
Node's UTF-8 `JSON.stringify` estimates are 135,070 bytes for the encoded ledger
value, 2,429,337 bytes for the durable inventory value, and 2,564,464 bytes for
both retained local items including key and object framing.

The installed minimum-Chrome benchmark completed five warmup pairs followed by
30 alternating measured empty and saturated pairs. Fixture-only tab creation
started navigation in batches of 25 privileged pages with a 30-second bound per
batch; all 500 remained resident, and the measured seam stayed one real
`chrome.tabs.remove` call over all 500 tabs.
Chrome reported 2,564,487 bytes for the retained keys, below the 5,242,880-byte
ceiling, and a 4,989,882-byte p95 Complete Representative Local Profile v1,
below the 8,388,608-byte ceiling. The saturated Startup Frame contribution was
81.4 milliseconds p95, warm single-close latency was 64.6 milliseconds p95,
and the stricter cold close-command-through-production-settlement upper bound
was 173.907 milliseconds p95. In the official 500-close distribution,
last-delivered-removal through the final durable ledger write was 840.1
milliseconds saturated p95 and 872.7 milliseconds saturated maximum; every
measured empty and saturated sample matched all 500 exact candidates and used
exactly two ledger writes. The over-quota lane left only 64 bytes free,
preserved the prior 500-page and 10,000-boundary ledger byte-for-byte, kept the
acted candidate in both inventories, and recorded capture exhaustion after the
one allowed retry.

The `chrome.storage.local` representation therefore passes its measured v1
adoption boundary. IndexedDB remains deferred unless a later schema or measured
workload invalidates this evidence.

## Consequences

The design recovers pages across closure origins and worker lifetimes without
pretending Chrome Sessions is a 30-day database. It deliberately recovers one
page, not former duplicate copies, app-window structure, tab order, group or pin
state, navigation history, scroll, forms, or document state. Activation History
continues to offer Chrome's separate short-lived session restoration.

Broad eligibility means a retained or saved record can be valid even while its
target is unavailable. File access, another extension's install state, and
privileged Chrome schemes are checked at action time. Failure preserves the
record instead of weakening the capture boundary.

The local ledger adds durable device storage, lifecycle reconciliation, and an
expiry alarm to the worker. Stable closure tokens, conditional writes, and
Removal Boundaries are required complexity: without them, worker termination or
concurrent Dashboard pages could refresh stale closures or resurrect removed
ones.

## Acceptance evidence

The implementation branch contains the service, ledger, inventory, projection,
Page Chip integration, deterministic tests, and installed-extension harness.
The installed-extension suite proves built-worker launch, real Chrome WebUI
closure capture, retained-only Save and Remove actions, exact URL recovery,
conditional snapshot consumption, storage budgets, warm and cold single-close
latency, 500-close batching, exact candidate preservation, bounded writes, and
over-quota preservation. Localhost browser evidence also covers the retained
focus fallback. This ADR records the accepted contract and completed measured
gates, not proof that the feature is ready to ship; the remaining release
matrix below is still mandatory.

The following mandatory release evidence is not yet implemented or recorded:

- installed-extension lifecycle scenarios for worker termination at each
  persistence boundary, reload/update, graceful and forced browser restart,
  restored and non-restored tabs, stable-token replay, and expiry-alarm wakes;
- the minimum-Chrome target matrix for supported Chrome pages, enabled,
  disabled, and uninstalled extension owners, unavailable files, rejected
  privileged schemes, exact target confirmation, focus outcomes, app fallback,
  and two simultaneous Dashboards;
- full accessibility, reduced-motion, 390-pixel, 500-identity,
  filtering, overflow, cross-Dashboard convergence, and closed-only-card
  browser evidence for the shared presentation;
- current-stable Chrome macOS PWA/app and final target/focus smoke, rollback
  proof, Chrome-support release check, disposable-profile and owner pilots, and
  the generic evidence report; and
- one release-candidate run of the complete deterministic, build, browser,
  installed-extension, privacy, permission, migration, corruption, and failure
  suites with zero unexplained errors.

The measured storage and performance thresholds above are passed for this
source and fixture set. Privileged-target behavior, browser-restart outcomes,
and the overall ship gate must not be described as passed until their remaining
evidence exists for the same release-candidate source and fixtures.

## References

- [ADR 0001](0001-saved-pages-local-storage.md) — Saved Pages remain explicit
  Tab Out-owned state
- [ADR 0014](0014-adopt-effect-behind-dashboard-intake-seams.md) — the shared
  worker Effect runtime and persisted-state boundary
- [ADR 0015](0015-admit-one-truthful-startup-frame.md) — retained state joins
  the one complete live Startup Frame
- [`CONTEXT.md`](../../CONTEXT.md) — the canonical durable behavior contract
