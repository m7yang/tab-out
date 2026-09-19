# ADR 0034: Share Page Chip Paint And Target Liveness

- Status: Accepted
- Date: 2026-09-19

## Decision

Share Page Chip surface colors and current-chip styling through
`src/components/page-chip-paint.ts`. Domain Cards and Activation History retain
their own interaction and expansion policies, as described in
[ADR 0033](0033-share-page-chip-language-and-landmarks.md).

Folded environment labels follow the same liveness convention as same-title URL
labels in [CONTEXT.md](../../CONTEXT.md#relationships). An environment's
suspension state includes every open duplicate behind its represented URL.

## Rationale

Shared paint values prevent the two contexts from drifting when a color changes.
A single current-chip background makes the current frame consistent across
contexts. Child targets without individual favicons need their own liveness
signal: an awake sibling must not make a suspended or closed target look awake.
The label owns its dimmed color so hover and active-parent styling preserve it.

Expanded fill layers inherit the surface radius. Child-target corners share one
shape while retaining the spacing required by URL rows and environment buttons.

Keyboard focus uses the existing Domain Card outer outline in both contexts.
History paints it on the expanded surface while focus stays on its canonical
interaction target. Child targets use the URL rows' fill-only active treatment
and immediate hover feedback. URL action slots adopt the existing main-chip
20px control size; their rail keeps the close icon centered on the favicon axis.

Unframed Page Chips use the existing closed-page hover surface across Sources
and liveness states. The light fill and stronger rim identify an interaction
target consistently; title and favicon styling continue to communicate liveness.
In-flow plain rows retain a translucent equivalent of that fill so adjacent
frames remain visible. Current/active frames and child-target feedback keep
their existing treatments.
