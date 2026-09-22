# Rendered nested-radius calibration — 2026-09-22

The previous `1.8409` coefficient is mathematically correct for matching the
diagonal midpoint of two ideal squircle corners to their straight-edge gap.
It is not an exact parallel-offset rule, and using it without the Page Chip's
inward outline understated the spacing for that painted corner.

For the 17px outer / 6px inner pair with a 1px inward outline, native Chromium
measurements put the full-corner fit around **6.7–6.8px**. A 6.75px candidate is
close to that measured minimum; **7px is the nearest whole-pixel candidate**.
The implementation used 6px when this calibration was recorded. The subsequent
[audit and applied corrections](nested-radius-audit-2026-09-22.md) select 6.5px
under Fleet's half-pixel rounding policy and document the focus-state compromise.

## What the calculation measures

The CSS keyword `squircle` is `superellipse(2)`, whose normalized curve has the
equation `x^4 + y^4 = 1`. At the 45-degree midpoint, its inset from the square
corner is `cR` on each axis, where `c = 1 - 2^(-1/4)`.

For two equal-axis corners with radii `R` and `r` and equal box-edge gap `g`,
their midpoint separation along the diagonal is:

```text
d45 = sqrt(2) × [g - c × (R - r)]
```

Setting `d45 = g` gives:

```text
k = (1 - 1/sqrt(2)) / (1 - 2^(-1/4)) = 1.840896…
g_midpoint = (R - r) / k
```

This matches one pair of points. It neither guarantees the nearest contour
distance at other points nor makes the two curves exact constant-distance
offsets. A claim that every nested squircle must satisfy this equation is too
strong.

## Account for visible paint

With a uniform inward stroke of thickness `b` on the outer surface, the clear
straight-edge gap is approximately `g - b`, not `g`. For the tested Chromium
border and inward-outline styles, using `R - b` for the inner painted contour
supplies an improved midpoint estimate:

```text
g_midpoint_with_rim ≈ b + (R - b - r) / 1.840896
```

For `R = 17`, `r = 6`, `b = 1`, this gives **6.43px**, versus **5.98px** when
the rim is omitted. Border paint is not specified as an exact smaller
superellipse; this remains an approximation to the measured rendering.

Across the tested dashboard-sized cases, a useful starting estimate for the
full-corner fit is:

```text
g_seed ≈ b + (R - b - r) / 1.75
```

This yields **6.71px** for the Page Chip. The `1.75` coefficient is an empirical
seed for these CSS squircles, not a CSS standard or a replacement universal
constant. Small child radii and extreme radius ratios need explicit measurement.
For circular corners, retain `g = R - r`; do not apply either squircle factor.

## Rendered measurements

Environment: bundled Chromium **153.0.8010.12**, native DOM screenshots, default
16 raster pixels per CSS pixel. The Page Chip case was also checked at 8× and
32×. The masks use opaque black and white to measure geometric coverage; they
do not model perceived contrast from the actual translucent colors or shadows.

Each shape is rasterized separately. Bilinear interpolation extracts its
half-coverage contour at 361 angular samples. Each inner-corner sample is
compared to the nearest segment of the outer painted contour, including the
adjacent straight edges. Samples are directions from the corner center, not
surface normals. The objective is to minimize the **largest absolute difference
between corner clearance and straight-edge clearance**, scanning candidate gaps
in 0.025px increments. Thus the objective is uniformity, not minimum whitespace.

For the Page Chip with its 1px inward outline, the 32× measurements are:

| Box-edge gap | Clear straight-edge gap | Corner clearance range | Largest deviation |
| --- | --- | --- | --- |
| 6px | 5px | 4.76–4.95px | 0.24px |
| 6.5px | 5.5px | 5.35–5.52px | 0.15px |
| 6.75px | 5.75px | 5.64–5.87px | 0.12px |
| 7px | 6px | 5.91–6.22px | 0.22px |
| 8px | 7px | 6.97–7.57px | 0.57px |
| 9px | 8px | 8.00–8.74px | 0.74px |

The fitted optimum moved between 6.73px and 6.80px across 8×, 16×, and 32×
rasterization. Varying the coverage threshold from 25% to 75% at 16× also kept
it near 6.8px. Report the result as **about 6.7–6.8px**, not an exact 6.725px
design requirement. The small difference between the 6px and 7px errors is not
strong evidence of a perceptible improvement by itself.

Cross-checks at 16×:

| Outer / inner radius | Inward rim | Midpoint estimate including rim | Measured best gap |
| --- | --- | --- | --- |
| 17 / 6px | none | 5.98px | 6.30px |
| 17 / 6px | 1px outline | 6.43px | 6.80px |
| 16 / 8px | 1px border | 4.80px | 5.05px |
| 16 / 8px | none | 4.35px | 4.60px |
| 15 / 8px | none | 3.80px | 4.03px |
| 32 / 12px | none | 10.86px | 11.41px |
| 32 / 12px | 1px outline | 11.32px | 11.91px |

The 17/6px inset-shadow case fitted at approximately the same gap as the inward
outline. Circular controls with and without a 1px rim recovered the expected
11px gap within 0.03px. Additional cases covered 2px and 3px rims, a child radius
clamped by its height, and high and low inner/outer radius ratios. The 1.75 seed
missed the best gap by about 0.32px for 12/2px and 0.76px for 48/4px without rims:
these are explicit counterexamples to treating that coefficient as exact.

## Calibrated working rules

1. Identify the two painted boundaries. Coincident overlays, independent text
   labels, and overlapping badges do not imply a nested contour requirement.
2. Use the radii actually rendered after CSS overlap reduction. Do not assume
   a declared radius survives unchanged on a short row or pill.
3. Distinguish box-edge spacing from visible clearance. Include borders,
   outlines, and inset rings in the model.
4. For equal-gap, equal-shape CSS squircles in this size range, use the 1.75
   formula as a candidate generator. Preserve the 1.840896 formula only when
   explicitly describing the ideal midpoint criterion.
5. Compare nearby spacing tokens against rendered contours and the actual
   content. Do not alter surrounding radii automatically to force an equation.
6. Treat unequal gaps, elliptical radii, different corner shapes, clamping,
   extreme ratios, and different paint styles as separate measurement cases.

This is Chromium harness evidence, not a live extension capture or a claim
about other browser engines. The original audit's classifications and visual
decisions are not invalidated merely because a different numerical optimum
exists.

## Sources

- [CSS Borders Level 4: corner shaping](https://www.w3.org/TR/css-borders-4/#corner-shaping)
  defines the superellipse parameterization and distinguishes the border's
  inner painted curve from an exact superellipse.
- [CSS Borders Level 4: overlapping curves](https://www.w3.org/TR/css-borders-4/#corner-overlap)
  describes reduction of overlapping radii.
- [Chrome's corner-shape implementation notes](https://developer.chrome.com/blog/implementing-corner-shape)
  explain the curve approximation and border, outline, and shadow rendering.
