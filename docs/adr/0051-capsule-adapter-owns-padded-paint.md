# ADR 0051: Capsule Adapter Owns Padded Paint

- Status: Accepted
- Date: 2026-09-25

## Decision

The existing `attachCapsuleBorder` ref owns measured contour application,
fallback selection, padded paint placement, and cleanup. Its adjacent stylesheet
consumes adapter-owned paint-mode attributes. Callers keep their controls,
interaction states, and theme tokens; count badges use the same capsule fill
token as other callers.

Ordinary labels retain pseudo paint. Overflow expanders reserve both pseudos
for their existing decoration, so the adapter creates an empty, decorative
paint child during attachment and removes it during ref cleanup. React callers
do not render or update that child. It contributes no layout or hit target and
stays hidden while geometry is unavailable.

## Rationale

The Chromium fractional-position workaround previously required the overflow
caller and global paint selectors to coordinate an exceptional child. Keeping
that choice and its lifetime inside the adapter reduces the facts a caller
must know, while retaining the existing native controls and paint behavior.
Keeping pseudo paint for captured labels also avoids adding decorative children
to the Title Expansion capture/restore path.

This is an app-owned paint module, not a universal shape renderer. Fleet retains
geometry ownership. Header SVG decoration and the resize-driven History SVG
offset contour in [ADR 0042](0042-move-the-history-match-frame-between-cards.md)
retain their separate rendering and timing requirements.

## Verification

The capsule browser checks exercise fractional paint at 1×, 2×, and 3× scales,
interaction paint, and the expander's fallback, resize, and React removal.
History contour assertions retry a complete geometry snapshot after finishing
an animation, allowing ResizeObserver to run before comparing paths at the
existing precision.
