# ADR 0057: Place Chrome Group Rails Outside Page Chips

- Status: Accepted
- Date: 2026-09-26

## Decision

Move the Chrome group stripe from the Page Chip surface to its existing slot,
2px wide and 4px outside the left edge. Join neighboring slot segments when
their full-width chips represent the same Chrome group ID. Keep 7px insets and
rounded ends at each run boundary. Use group identity, never color equality.
Same-title chips join a run only when every exact target belongs to the same
Chrome group. Mixed aggregates keep their individual marker but break joins
on both sides; the compiled plan supplies unanimous membership without changing
the representative or exact-target action metadata.

Compute adjacency in the existing section/overflow renderer. Collapsed rows do
not extend a visible rail; revealed rows continue it when their group matches.
Keep existing chip order, section boundaries, slot geometry, and hit targets.
Rails stay at resting positions while titles expand. Icon-only chips remain
unchanged.

## Rationale

The inset stripe competes with compact chip outlines and resembles a text caret.
An external rail separates group membership from interaction paint; a connected
run communicates shared membership without adding group containers or headings.
Slot segments preserve the existing shared seams, animation anchors, and keys.
This supersedes ADR 0053's placement of group stripes on chip pseudo-elements;
the capsule paint adapter itself is unchanged.

## Verification

Browser geometry checks cover joined segments, ungrouped interruptions,
different groups sharing a color, overflow reveal, resizing, and filtering.
