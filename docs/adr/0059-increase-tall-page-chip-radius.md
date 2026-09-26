# ADR 0059: Increase the tall Page Chip radius

- Status: Accepted
- Date: 2026-09-26

## Decision

Increase the shared non-capsule Page Chip radius from 18.65px to 20.5px, keeping
`superellipse(1.7)`, equal corners, natural height and CSS overlap reduction.
Compact Page Chips retain their measured capsules and the 34px cutoff. Keep
the Domain Card radius at 38.5px. URL row height and spacing follow
[ADR 0058](0058-compact-url-rows-with-wider-insets.md). This supersedes ADR 0055's
tall-chip radius only.

## Reason

The user selected 20.5px after comparing aligned Page Chip corners. Against
the 26.25px one-line capsule, the largest sampled boundary difference is
0.35px at 20.5px versus 0.37px at 18.65px. Both comparisons use coincident box
edges, not nested spacing. The closest sampled radius was 19.25px; 20.5px
allows a rounder shell while retaining comparable maximum deviation.

## URL row height headroom

Measure the last row's bottom-right corner, with equal 4px box gaps and the
parent's 1px inward hover outline. The straight painted clear band is 3px.
Native Chromium 153 masks at 32×, checked at 16×, give:

| Parent radius | URL height | Corner clearance | Maximum deviation from 3px |
| --- | --- | --- | --- |
| 18.65px | 19px | 2.83–3.36px | 0.36px |
| 20.5px | 19px | 2.65–3.00px | 0.35px |
| 20.5px | 20px | 2.73–3.07px | 0.27px |
| 20.5px | 21px | 2.80–3.27px | 0.27px |
| 20.5px | 22px | 2.84–3.47px | 0.47px |

At 4px insets, 21px is the largest tested half-pixel height with no worse maximum
clearance error than the old 18.65px/19px pattern. This is not a clipping limit:
larger rows remain contained but produce a less uniform band. The user later
selected 20px rows and wider 4.5px insets, recorded in ADR 0058.

The masks use the current capsule package, a native CSS parent with an inward
outline, midpoint pixel crossings, and nearest polyline-segment distances over
the matching corner and adjacent straight edges. The corner is reflected to
top-left coordinates for measurement. All tested clearances remain positive;
the 16×/32× maximum-error difference stays below 0.05px. Inward row focus and
selection outlines retain their existing geometry; no ancestor radius is refit.

## Verification

`pnpm verify` passed (1,347 Node tests and 376 Vitest tests), with generated
output checked against a temporary Git index. Fourteen relevant browser checks
passed, covering both Page Chip contexts, capsule/tall reflow, nested spacing,
expansion, fades and traveling outlines. Real Chrome fixture inspection confirmed
20.5px corners, unchanged 19px URL rows, 1px row gaps and 4px outer insets.
Live-extension acceptance was not exercised.
