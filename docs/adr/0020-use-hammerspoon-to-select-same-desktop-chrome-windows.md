# ADR 0020: Use Hammerspoon To Select Same-Desktop Chrome Windows

- Status: Accepted
- Date: 2026-08-16

## Context

Desktop Window Merge must combine only the configured-profile Chrome windows on
the same macOS Desktop as the Tab Out page that invoked it. Chrome's extension
window APIs expose browser IDs, type, state, bounds, and display geometry, but
not macOS Space identity or native z-order. An extension-only implementation
could therefore merge windows from another Desktop when their bounds happen to
match. Chrome also has no native Merge All Windows command that can supply this
product contract while preserving Tab Out's profile and exclusion rules.

The existing optional integration already owns configured-profile discovery,
native Chrome-window correlation, and guarded access to Hammerspoon's Spaces
interface. Its Native Placement Bridge has one owner-only Unix-domain socket and
one extension-owned native-messaging process, but the original protocol is a
short-lived Hammerspoon-client-to-extension request path. Desktop selection
needs the reverse direction while the user reviews a preview and confirms it.

## Decision

- Keep Chrome tab and group mutation in the extension. Hammerspoon selects
  native windows; it never receives or moves tabs.
- Extend the native host with a separately versioned control protocol. One
  persistent Hammerspoon controller registers the `merge-desktop` capability;
  the host validates and correlates extension requests and controller responses
  without gaining Space, profile, ordering, or mutation policy.
- The extension sends the invoking browser window ID and the current profile's
  normal, non-minimized browser window IDs. Hammerspoon maps those IDs to unique
  Accessibility windows through Chrome's focus-independent AppleScript
  inventory, then selects only visible standard windows on the destination's
  exact active regular Space and display in native front-to-back order. A
  window retained by Accessibility but absent from the native on-screen order,
  such as an inactive Stage Manager set, remains untouched.
- Chrome declares its AppleScript window collection front-to-back, and
  Hammerspoon declares `hs.window.orderedWindows()` front-to-back. When multiple
  visible native windows have the same bounds and active document, correlate
  them by those orders only if the complete browser and native collision groups
  have equal counts. A partial, hidden, or cross-Space collision group remains
  ambiguous and rejects the selection.
- URL values used inside the local AppleScript-to-Accessibility fingerprint are
  ephemeral correlation input. Requests and responses allow only protocol
  fields, IDs, status, bounded reasons, and the opaque selection token. Extra
  fields are rejected at both the host and controller boundaries; URLs and
  titles are never returned, persisted, or logged.
- A preview token records the exact destination, display, Space, ordered window
  IDs, and creation time only in Hammerspoon memory. Confirmation consumes that
  token and repeats the complete selection. A missing, expired, reordered,
  ambiguous, sticky, minimized, fullscreen, tiled, hidden, nonstandard,
  other-profile, other-display, or other-Space window causes a fail-closed
  rejection before Chrome mutation.
- The invoking Tab Out page identifies the destination Desktop directly. There
  is no screen or Desktop capture step and no new keyboard shortcut.

## Consequences

The header can promise exact same-Desktop scope instead of a bounds-based
approximation. Extension reloads remain compatible with the placement-v3 path,
while the versioned control capability makes an older native host or Spoon
visibly unavailable rather than partially functional. The Hammerspoon controller
reconnects only to the extension-owned host endpoint and creates no LaunchAgent,
network listener, durable selection record, or independent keepalive.

The selection depends on Hammerspoon's experimental `hs.spaces` implementation
and Chrome's AppleScript and Accessibility inventories. macOS or Chrome updates
can therefore invalidate correlation or Space observation even when unit tests
pass. The setup doctor proves installation and capability loading; live
same-Desktop, cross-Desktop, exclusion, order, pin, group, and focus acceptance
remains required after those updates.

An extension-only bounds heuristic was rejected because it cannot distinguish
Spaces. Moving all normal profile windows and relying on the user to undo was
rejected because it violates fail-closed scope and has no lossless window-layout
rollback. A new always-running native application was rejected because the
existing user-local Hammerspoon integration already owns the required native
identity and Space policy with a smaller lifecycle and permission surface.

## Amendment: Control Protocol V5

On 2026-08-25, the control protocol advanced from v4 to v5 after an accepted
response shape changed. Keeping the old protocol number had allowed a linked
Spoon and a previously copied native host to register successfully, then reject
every Desktop Window Merge response as malformed. Request or response shape
changes must advance the control protocol so mixed installations fail during
registration and surface the existing controller-update guidance.

## Amendment: Control Protocol V6 And Process Authority

On 2026-08-26, [ADR 0022](0022-target-chrome-through-native-host-process-authority.md)
advanced control to v6. The Chrome-launched native host stamps its validated
parent PID onto every request before Hammerspoon sees it. Selection now excludes
all other same-bundle processes before PID-targeted ScriptingBridge and
Accessibility correlation. Mixed controller or extension versions receive a
version rejection and cannot fall back to application-name targeting.

## Amendment: Process-Scoped Window Enumeration

[ADR 0046](0046-bound-hammerspoon-close-inspection-and-creation-retries.md)
replaces global ordered-window enumeration with an explicit refresh of the
authorized Chrome process and WindowServer's on-screen IDs. Watcher-missed
windows still participate, and native front-to-back selection is unchanged.
