# ADR 0055: Use Midpoint Corners

- Status: Accepted
- Date: 2026-09-26

## Decision

Use CSS `corner-shape: superellipse(1.7)` for tall Page Chips, their expanded
backing and coincident trims, and local/traveling Domain Card outlines. The
user selected a visual midpoint between the native reference and the earlier
squircle after comparing them at the same bounds. This supersedes ADR 0054's
native rectangle choice for those surfaces. Compact chips retain the measured
capsule, its padded paint, and the 34px cutoff. Icon-only chips stay unchanged.

Use fixed radius tokens: 18.65px for tall chips and 38.5px for cards. These round
the preview's 18.6479px two-line-chip and 38.5178px compact-card calibrations.
The preview fits k=1.7 to the average support values of the native and prior
squircle silhouettes at 300×42.5 and 332×83.25, respectively. Production keeps
these tokens fixed as dimensions change, preserving the content-independent
corner contract; it does not run a shape-fitting search during layout or promise
an exact average silhouette at every size.

## Implementation

CSS owns these corners, fills, borders and focus outlines. Remove the native
rectangle ResizeObserver from Domain Cards. The existing chip observer switches
tall surfaces back to CSS; capsule geometry and its SVG traveling offset remain
unchanged. Traveling tall-chip frames copy their target's radius and corner
shape. Card frames use the shared card radius and CSS curve. Existing 120ms
width/height motion preserves stroke widths without scaling.

The action fade uses the full chip bounds with the same corners; its gradient
width stays unchanged. Preserve hit targets, natural card height, 16px outer
side/bottom gaps, 2.5px variant-row insets and inward variant focus rings.

## Evidence and limits

The native generator remains a validated SwiftUI reference. A separate 8× native
render check on macOS 27.0 (26A428) found identical pixels between the SwiftUI
continuous shape and its exported path. At the compact-card reference size, a
fitted circle is only about 0.32px away by sampled silhouette support distance.
The user preferred a squarer appearance, so this is an aesthetic choice rather
than a native-fidelity claim. Existing native fixtures and package APIs remain.

The separate contour lab retains the approved `variant=middle` preview and its
side-by-side comparison. Browser checks cover compact/tall reflow in both Page
Chip contexts, matching local/traveling frames, intermediate motion dimensions,
expansion, keyboard focus, unchanged layout gaps and retained capsule raster
coverage at 1×, 2× and 3× display scales.

## Completed verification

`pnpm verify` passed (1,346 Node and 376 Vitest tests). All 67 affected capsule,
midpoint, nesting, motion and title/focus browser checks passed in the final full
run, and the applied 38.5px / k=1.7 card was inspected in real Chrome's fixture.
The full HTTP suite passed 270/274 initially: three failures are the previously
confirmed baseline scroll-edge/header-gutter assertions; the fourth was the
filter-shadow check receiving opacity 2.08337e-10 instead of exactly zero and
passed its isolated rerun. No failures remain in the changed contour coverage.
The extension is rebuilt. A temporary Git index verified generated output;
existing staging was preserved and this follow-up patch remains unstaged.
