# ADR 0054: Use Native Continuous Rectangles

- Status: Superseded for Tab Out presentation by [ADR 0055](0055-use-midpoint-corners.md); native geometry remains validated.
- Date: 2026-09-26

## Decision

Use `@fleet/continuous-capsule` 0.2.0 for tall Page Chips and Domain Card
outlines. This replaces the squircle choices in ADR 0039 and ADR 0053 for these
surfaces only. Compact chips retain their measured capsule and 34px cutoff.
Tall chips and same-title groups use a fixed 13.125px native radius, matching
half the normal 26.25px chip height. Card outlines use a fixed 28.375px radius
on their 1px stroke centerline; it is a separately chosen larger design radius,
not a formula claiming exact parallel spacing. No minimum height is added.

Reuse the existing measured paint adapter, including its padded fill, expanded
backing, action-fade clipping and coincident trims. Local focus outlines retain
their CSS widths, offsets and colors and follow the new border shape. Traveling
page outlines use the existing sampled parallel-offset SVG painter. Local and
traveling card outlines share one geometry helper. ResizeObserver regenerates
both traveling contours at the rendered dimensions during their 120ms motion;
paths and stroke widths are never scaled. Matching and interaction policy stay
unchanged. Other non-capsule surfaces, icon-only chips, and unsupported-browser
fallbacks keep their existing CSS shapes.

## Evidence and limits

The standalone generator reconstructs public SwiftUI RoundedRectangle paths
from macOS 27.0 build 26A428. It matches 32 derivation samples and 561 independent
native holdouts, with maximum corresponding control-point distance
0.000092908604 CSS pixels (bound 0.0002). The package retains the 561 holdouts
and a Swift exporter; runtime geometry has no native bridge or fixture lookup.
The native profile is pinned, not a promise about every Apple control or future
OS. Browser antialiasing, CSS focus effects and material remain browser-owned;
the SVG focus path is a parallel-offset approximation, not Apple's focus effect.

## Verification

Run the package geometry tests, Tab Out's base verification and full HTTP
browser suite. The crop suite compares tall surfaces in both contexts against
SVG at fractional positions and display scales 1, 2 and 3. Nesting checks assert
local/traveling contour equality, unchanged natural card height, 16px card gaps
and 2.5px variant-row insets. Motion checks cover interrupted resizing and native
paths at intermediate dimensions. Inspect the fixture in real Chrome as well;
these paint checks do not establish live extension API behavior.

Completed checks: package geometry tests; `pnpm verify` (1,346 Node and 376
Vitest tests); 73 focused paint, nesting, motion and title/focus browser tests;
real-Chrome fixture inspection. Generated output was verified against a temporary
Git index so the actual changes remain unstaged.
The full HTTP suite passed 277/280. Both scroll-edge local-outline opacity checks
and the smoke test's header-gutter assertion also fail against the committed
HEAD bundle, confirmed by routing extension asset requests to `git show HEAD`.
Those pre-existing failures remain outside this contour change.
