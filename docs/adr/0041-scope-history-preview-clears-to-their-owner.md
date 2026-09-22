# ADR 0041: Scope History Preview Clears to Their Owner

- Status: Accepted
- Date: 2026-09-22

## Decision

Each Activation History entry publishes an opaque interaction owner with its
hover or focus preview. Its departure and action cleanup can clear the shared
match, URL preview, and native highlight only while that entry still owns them.
A new preview replaces the owner even when its URL is unchanged. Dashboard-wide
clears remain unconditional and discard ownership.

Starting activation also clears unconditionally and awaits native-highlight
cleanup before changing tabs. Keyboard focus and pointer hover can belong to
different entries; a pending hover selection must finish or be cancelled before
activation, so it cannot subsequently reactivate the previously active tab.

The Domain Card frame continues to follow the matched Page Chip or collapsed
overflow through CSS, with no independent timer or state.

## Rationale

Browser reproduction showed that focusing one History entry, hovering another,
then blurring the first removed the newer entry's page match and card outline
while the pointer remained over it. The reverse sequence also failed: hovering
one entry, focusing another, then leaving the first cleared the focused match.
Both departure handlers previously cleared the shared state unconditionally.

Scoping clears at the shared hover callback also prevents delayed History action
cleanup from erasing a more recent interaction, and keeps the native highlight
and URL preview consistent with the matched outlines.

## Verification

The browser regression in `tests/browser/history-hover-outline.spec.ts` exercises
both event orders, checks the matched descendant and computed card-frame opacity,
and verifies that departure of the current owner still clears both. Expanded
surface traversal and context-menu retention/dismissal are covered separately.
The activation regression pauses a native-highlight selection lookup, activates
a different focused entry, and verifies that activation waits for cleanup.

See [the interaction contract](../../CONTEXT.md) and
[the matched-card frame decision](0039-outline-history-matched-domain-cards.md).
