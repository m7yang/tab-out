# ADR 0024: Transfer Native Profile Authority Explicitly

- Status: Accepted
- Date: 2026-08-31

## Context

ADR 0023 made one explicitly paired Chrome profile the Configured Profile and
prevented startup order from changing native-integration authority. Changing
that choice still required a local CLI reset followed by another pairing click.
That recovery was safe but unnecessarily indirect for a normal user action,
and it made a later profile's popup look like a setup failure rather than a
place where ownership could be changed deliberately.

Chrome native messaging still does not identify the calling profile directory.
Tab Out therefore cannot prove that Hammerspoon's machine-local
`chromeProfileDirectory` setting names the profile asking to take ownership.
Transfer must also avoid interrupting an active Desktop Window Merge or a
running or queued Hammerspoon shortcut.

## Decision

- One and only one Configured Profile remains authoritative. A transfer replaces
  it; it does not introduce simultaneous multi-profile ownership.
- The Tab Actions Menu exposes state-specific actions: **Use this profile for
  macOS integration** when no owner exists, **Switch macOS integration to this
  profile…** when another owner exists and transfer is supported, and **Set up
  or update macOS integration…** when local components are unavailable or
  incompatible. The setup action opens the canonical
  `https://github.com/m7yang/tab-out` guide.
- Switch requires a compact confirmation with Cancel initially focused. It says
  that `chromeProfileDirectory` must already match, Tab Out cannot verify that
  setting, and the profile that currently owns the integration will lose access.
  Confirming is the user's attestation of that setup invariant.
- The popup offers Switch only when a read-only probe proves that the current
  owner is offline or that its live native host, extension worker, and
  Hammerspoon controller all support transfer. The probe does not begin a drain.
- A non-owner refreshes that read-only observation when the Tab Actions Menu
  opens. Otherwise, a negative startup probe could outlive Hammerspoon
  becoming ready and prevent Switch from being offered. The check is
  bounded and shared by concurrent menu opens; passive status updates do
  not trigger another probe, and failed checks return to dormancy. This
  keeps freshness tied to the menu without sustaining an unused worker
  or beginning a transfer.
- Persisted selection schema 2 includes an opaque owner revision. A challenger
  may commit only the exact revision captured when the user opened the
  confirmation; a status change dismisses that confirmation. The first valid
  commit wins, and a stale or competing challenger must refresh and be confirmed
  again.
- A live owner enters a drain only when its extension worker has no confirmed
  Desktop Window Merge running and its Hammerspoon controller has no running or
  queued shortcut. The drain blocks new actions. Read-only merge preview does
  not make the owner busy. Preparation replies use a transfer-specific response
  type so ordinary controller rejections cannot be consumed as drain results.
- If the challenger cannot acknowledge a successful preparation, the native
  owner sends cancellation to both the extension and Hammerspoon before clearing
  the preparation. A controller disconnect also cancels its local drain.
- The popup never force-terminates a live owner. Mixed or outdated extension,
  native-host, or Hammerspoon components reject transfer and direct the user to
  update setup.
- An offline owner may be replaced because there is no live native owner to
  interrupt. This does not claim that the old profile has no browser-only tail.
- Under the selection lock, the challenger rechecks the owner revision, drains
  the live owner or verifies that it is offline, binds the shared endpoint, and
  then atomically writes its profile ID with a fresh revision. A precommit
  failure preserves prior persisted authority. If the old host was already
  drained, that guarantee does not imply uninterrupted old-host liveness.
- A lost post-commit response is transport ambiguity, not proof that the transfer
  failed. The extension performs one bounded read-only reconnect and compares
  fresh authority before reporting success, a competing selection, or a proven
  failure. If reconciliation also times out, the popup reports an indeterminate
  status and never claims that the former owner still owns the integration.
- `pnpm setup:local --reset-profile` remains the explicit fallback. It releases
  or invalidates a live owner while holding the selection lock, then clears the
  selection even when its persisted JSON is malformed. The post-reset diagnostic
  treats only the native host's dedicated unpaired-endpoint exit as expected;
  version output cannot hide an unrelated setup failure.

## Consequences

Users can correct or intentionally change the Configured Profile from the
extension popup without a normal terminal detour. Use and Switch keep the popup
open, refresh ownership state, and show inline success or Safe Abort feedback.

The handoff is atomic for durable authority, not for continuous availability of
the former host. Offline transfer is intentionally bounded to native ownership;
Tab Out cannot infer or cancel browser-only work in a profile whose native owner
is absent. The `chromeProfileDirectory` correspondence remains a reviewed setup
invariant because macOS native messaging provides no trustworthy profile path.

This supersedes ADR 0023 only where CLI reset was the sole supported way to
replace the Configured Profile. ADR 0023's exclusive authority, privacy, process
identity, and Safe Abort requirements remain in force.
