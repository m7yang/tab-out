# ADR 0053: Use Capsules for Compact Page Chips

- Status: Accepted
- Date: 2026-09-26

## Decision

Apply the shared capsule paint adapter to titled Page Chips in Domain Cards
and Activation History, including their expanded surfaces and opaque backing
fills. Use the measured contour for coincident active and match frames, clip
action fades to that contour, and let the traveling History frame use its SVG
offset contour for every measured capsule target.

Keep ordinary surfaces' existing dimensions, colors, interaction selectors, focus
outlines, and seam insets. Chips taller than 34px use a 23px squircle fitted to
the normal 26.25px capsule profile, subject to CSS radius overlap reduction.
Same-title groups share that 23px fit; icon-only chips
retain their existing shape.
ResizeObserver chooses the contour again as expansion or resizing changes the
box. Unsupported browsers and sizes keep the existing CSS shape and paint.

## Rationale

Full-height capsule ends would crowd multi-line text and grouped target lists
at the existing compact padding. Keep the 34px height cutoff independent of
the fallback radius so the fitted 23px token cannot make two-line chips become
capsules. At coincident box edges, fitting the capsule to a squircle gives
22.9405px, rounded to 23px. Its modeled maximum corner deviation is about
0.25px, versus 1.59px at the previous 17px radius. A normal 42.5px two-line chip
caps the used radius at 21.25px, with about 0.63px deviation. This is a contour
approximation rather than an identical shape or a new nested-clearance fit.

Page Chips reserve their pseudo-elements for group stripes and action fades,
so the adapter owns a decorative paint child as it already does for overflow
expanders. State classes set the shared fill token; they still update entirely
in CSS. The stable History ref composes measurement with its existing expansion
ref and cleans up both on unmount. Collapsed local match outlines live beside
the chip in its slot, keeping them above adjacent chips despite the surface
paint isolation; expanded outlines stay inside the raised surface.

## Verification

Extend the capsule raster comparisons to both Page Chip contexts at 1×, 2×,
and 3× scales. Check hover paint, resize, tall fallback and recovery, expansion
seams, title behavior, History motion, and dashboard layout. Paint assertions
inspect the adapter's actual surface while keeping their original behavioral
expectations.

## Group title variants

The same capsule painter also owns items in `chip-title-variant-list`, including
expanded live rows and inline tooltip labels. Group chips share the 23px
squircle fit: all four corners are equal, and no custom non-capsule contour is
introduced. Their 21px capsule rows use 2.5px right/bottom box insets supplied
by the group surface; the list and its measurement clone add no padding.
Keyboard outlines use 2px with −2px offset; filter selection uses 1px with −1px
offset. These inward rings preserve the tighter nested gap. Row text padding
and the indented left action gutter remain unchanged.

The reference is boundary overlap with the one-line capsule, not equality of
radius numbers between parent and child. Domain Card outlines use their own
larger, content-independent token. See the [current audit](../nested-radius-audit-2026-09-26.md).
