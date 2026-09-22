# ADR 0042: Move History Match Frames Between Cards and Page Chips

- Status: Accepted
- Date: 2026-09-22
- Supersedes: the immediate card-to-card switching decision in [ADR 0039](0039-outline-history-matched-domain-cards.md) and its CSS-only presentation in [ADR 0041](0041-scope-history-preview-clears-to-their-owner.md).

## Decision

A unique matched Domain Card uses one decorative frame inside the dashboard
scroller. Pointer transitions between on-screen cards move and resize that frame
over 120ms with the existing `--ease-swift` curve, `cubic-bezier(0.2, 0, 0, 1)`.
Interrupted movement starts at the current rendered position and dimensions.
Movement between pages in the same card leaves its frame stationary.

The matched Page Chip outline uses a second instance of the same frame component
and the same timing. It moves independently between pages within a card as well
as between cards. Its box follows the exact matched chip or collapsed-overflow
button, retaining the native 1px outline, 1px outline offset, and target radius.
Only the replaced match outline is suppressed; resting trim, focus indicators,
and per-URL row emphasis keep their existing behavior.

First entry, keyboard focus, reduced motion, and transitions involving offscreen
cards are immediate. Multiple matches retain every card's existing local frame
without selecting an arbitrary destination. Departure hides the frame without a
fade or timer. Its last geometry can seed another pointer transition within
120ms, bridging small gaps without extending the underlying preview lifetime.
Multiple page matches retain all local outlines, independently of how many cards
match. Expanded Page Chips retain their local outlines to preserve their higher
stacking context; icon-only chips retain their existing kind-specific rings.
While a target or its ancestor is in a card or intra-card FLIP move, its outline
also stays local so it follows the surface's intermediate transform positions.
When movement finishes or is cancelled, the shared frame resumes at the settled
geometry immediately, without replaying a cached hover transition.

The shared frame retains the neutral 1px stroke, 8px outset, 40px squircle radius,
pointer transparency, scroller clipping, and scroll-cue stacking from ADR 0039.
The existing matched-page and collapsed-overflow markers resolve its target.
Mutation and resize observers reconcile presentation once per animation frame;
they do not create a second URL resolver or change preview ownership.
Root class and style changes also trigger reconciliation: removing the temporary
card-motion overflow allowance shifts the frame's coordinate origin without
changing the observed content-box size.

## Rationale

A short continuous movement helps users follow the relationship between history
and the grouped dashboard while scanning. Independent Page Chip movement keeps
that continuity when successive history entries belong to the same card.
Keyboard and reduced-motion interactions retain immediate positioning.

The browser's Web Animations API handles interruption without a new dependency.
Translation uses transforms. Width and height animate only on the isolated,
absolutely positioned decorative element: this deliberately accepts local
layout/paint work to preserve stroke thickness and squircle geometry, rather
than scaling the border or changing card layout. No JavaScript frame loop drives
the tween. The Page Chip frame uses layout containment without paint containment
so its outside outline remains visible. It sits above ordinary card content and
below expanded surfaces and the scroll cue.

## Verification

`tests/browser/history-match-motion.spec.ts` covers first entry, same-card changes,
intermediate geometry, constant stroke and radius, interrupted movement,
keyboard/reduced-motion behavior, resizing, multiple matches, and target removal.
It also checks within-card Page Chip travel, interrupted cross-card retargeting,
suppression of the destination's duplicate outline, and expanded-target fallback.
Pin-then-hover coverage samples a real card flight to verify both outlines stay
local throughout movement; an intra-card case checks local fallback and cleanup.
`tests/browser/history-hover-outline.spec.ts` retains ownership, expansion,
context-menu, and adjacent-frame regression coverage.

Validation passed the full `pnpm verify` pipeline, including 1,341 Node tests and
376 Vitest tests. After the moving-target fix, all 126 selected layout/history
browser checks passed, including 16 focused history/outline checks. The earlier
broader layout/smoke/history run passed 138 of 140 checks: the narrow-header
gutter assertion is the existing failure recorded in
[the radius audit](../nested-radius-audit.md), and an exit-ghost timing assertion
passed all three focused reruns without code changes. Generated output reproduced
exactly during verification, checked against a temporary Git index without
changing the real staging area.

Live extension-page inspection was attempted but blocked by the browser tool's
URL security policy; browser-harness evidence does not prove live profile behavior.
