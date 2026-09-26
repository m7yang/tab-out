# Page Chip nested-radius verification — 2026-09-26

## Current midpoint contour

[ADR 0055](adr/0055-use-midpoint-corners.md) adopts CSS `superellipse(1.7)`:
[ADR 0059](adr/0059-increase-tall-page-chip-radius.md) increases the tall-chip
radius to 20.5px; the card radius remains 38.5px. Compact capsules, natural
heights, 16px card gaps remain. [ADR 0058](adr/0058-compact-url-rows-with-wider-insets.md)
updates URL rows to 20px capsules, 1px row gaps and 4.5px right/bottom insets. These fixed tokens
come from the approved compact-card and two-line-chip previews; they do not
promise an exact average silhouette or parallel clearance at every size.

## Historical native contour integration

[ADR 0054](adr/0054-use-native-continuous-rectangles.md) supersedes the squircle
choices below for tall Page Chips and card outlines. Native radii are 13.125px
and 28.375px, respectively; layout gaps, natural height and equal corners remain.
The earlier raster clearance measurements below describe the old CSS shapes,
not the new native contours, and must not be cited as validation of this patch.

## Historical fixed-corner contract

The user clarified the design constraints: non-capsules remain squircles,
each rectangle has four equal corners, every card outline uses one fixed
radius, and Page Chip squircles should overlap the capsule reference when
aligned. The card can use a larger radius to account for the surrounding gap.
This supersedes the content-dependent fitting described in the historical
measurements below.

- Normal and group Page Chips use the 23px squircle fit to the 26.25px capsule.
  The modeled overlap deviation is about 0.25px; a 42.5px two-line chip still
  has four equal, CSS-reduced 21.25px corners (about 0.63px deviation).
- Every card outline uses a declared 50px at all four corners. Preserve the
  natural card height and content spacing: the user rejected adding height
  to accommodate the radius. The 83.25px compact outline therefore uses
  41.625px after CSS overlap reduction. Side/bottom chip insets remain 16px.
- Variant rows remain 21px capsules with 2.5px right/bottom insets. Group
  corners use the same 23px fit, with inward 2px keyboard and 1px selection
  rings. The painted band is about 1.25–1.74px at rest and 1.18–1.50px with
  the inward ring; it remains contained.

Native Chromium 153 contour checks at 32×, using the method below, give:

| Bottom chip | Fixed card radius | Match-outline clear band |
| --- | --- | --- |
| 26.25px capsule, enough card height | 50px | 12.46–13.52px |
| 26.25px capsule, compact 83.25px card | 50px declared, 41.625px used | 12.88–15.43px |
| Two-line chip (21.25px used radius) | 50px | 12.44–13.00px |
| Taller ordinary/group chip (23px used radius) | 50px | 12.61–13.01px |

The clear straight band is 13px. These are constrained squircle fits, not exact
parallel contours. Reference overlap, four-corner equality and content-independent
card shape take precedence over optimizing a different radius for each chip.

The compact-height constraint intentionally retains the corner-band variation
in the short-card case. This is not a perfectly parallel band. A shared
declared token does not guarantee the same used radius in differently sized
cards; preserving compact layout takes precedence over preventing CSS reduction.

Compact-height verification: `pnpm verify` passed (1,346 Node tests and
376 Vitest tests), and all 134 selected layout, History-frame and nesting
browser tests passed. The compact fixture's outline remains 83.25px high;
showing it leaves the card bounds unchanged. No minimum height or automatic
top margin is applied. Evidence is from the Chromium fixture harness.

## Historical per-card fit

This audit supersedes the fixed-card-radius compromise in the
[earlier audit](nested-radius-audit-2026-09-22.md). It applies Fleet's
`agent-tools/guides/nested-corners.md` and its general painted-contour distance
rule. Scope: compact and wrapped Page Chips, same-title groups, overflow,
expansion, coincident frames, hover, keyboard focus and viewport changes.

## Finding and correction

The 50px card radius was fitted to a compact capsule. Containment alone did not
establish that it remained the best fit after the inner chip changed shape.
The attached example is represented by a neutral two-line fixture: a 42.5px
chip inside a 99.5px-high card outline. The chip's declared 23px radius is
reduced to 21.25px. Its best sampled card radius is approximately 47.05px,
which rounds to **47px**, not the prior 50px (used as 49.75px in this short card).

The card outline now selects a radius from the actual bottom chip's used
geometry. Keep all layout gaps and strokes fixed. The native fits for the
supported non-capsule sizes are represented by `roundHalf(usedRadius + 25.5)`;
this calibrated rule is specific to these contours and paint, not a universal
squircle coefficient. Compact 26.25px capsules, including overflow controls,
retain their separately fitted 50px reference. Local and traveling frames share
the result and remeasure on resize/content changes. Coincident Page Chip frames
also refresh when the radius changes without a size change.

## Painted-contour checks

Use the bottom-left and bottom-right corners of a full-width bottom chip. Both
box gaps are 16px: 8px content padding plus the card frame's 8px outset. The
outer border occupies 1px inward; the chip match outline occupies 2px outward,
leaving a 13px straight clear band. Keyboard outlines occupy 3px, leaving 12px.

Native Chromium 153 masks use the actual capsule path or CSS squircle, plus the
specified border and outline. Sample at 16×, refine at 32×, interpolate the
128/255 coverage crossings, and measure nearest polyline-segment distances.
Include adjacent straight edges. Minimize the largest absolute clearance error
while separately enforcing containment. Sweep outer radii in 0.5px steps and
refine the optima in 0.1px steps; apply Fleet's half-pixel token rounding.

| Inner geometry | Selected outer radius | Match-outline clear band | Keyboard-outline clear band |
| --- | --- | --- | --- |
| Normal 26.25px capsule | 50px | 12.46–13.52px | 11.46–12.51px |
| Two-line 42.5px chip, used radius 21.25px | 47px | 12.74–13.28px | 11.69–12.07px |
| Taller chip, used radius 23px | 48.5px | 12.74–13.27px | 11.69–12.07px |
| Same-title group, used radius 29.5px | 55px | 12.73–13.27px | 11.70–12.07px |

The refined non-capsule optima are approximately 47.05, 48.6 and 55.1px. All
selected tokens remain contained. Existing variant-list nesting also passes:
21px capsule rows, 29.5px parent radius and 6.5px equal box gaps give a
5.26–5.70px hover band and 2.15–2.62px keyboard-focus band.

## Constraints and applicability

- **Short single-line cards:** an 83.25px-high card caps the used 50px radius at
  41.625px. Native checks give a 12.88–15.43px match band. Increasing the declared
  radius cannot change that cap. This is the best feasible radius under the
  existing symmetric-corner and compact-height constraints, not a uniform band.
- **Expanded chips:** their enlarged, sometimes out-of-card surfaces do not form
  the original equal-inset corner pair. Keep the established card reference;
  the expansion's backing and local Page Chip outline follow its own contour.
- **Indented rows, environment labels, title markers, badges, favicon stacks and
  icon-only chips:** these do not follow both card corners with equal side gaps.
  Preserve their recorded patterns; do not apply the equal-gap shortcut to them.
- **Interior Page Chips:** only the bottom full-width surface determines the
  lower card corner fit. Moving the match between siblings does not change that
  reference or cause the card radius to follow a nonmatching interior corner.
- **Coincident trim:** active, local and traveling Page Chip outlines share the
  target curve. These are coincident/offset strokes, not separately nested boxes.
- **Compact versus tall shapes:** retain the 34px capsule cutoff, the 23px tall
  reference and CSS used-radius reduction. Do not enlarge controls to avoid caps.

The rules are applied as constrained best fits. A second CSS squircle cannot
express an exact constant-distance offset of a capsule or another squircle.
“Perfectly uniform” would require the guide's exact offset contour construction,
not further radius tweaks. The table reports residual error rather than claiming
zero error or confusing containment with a successful fit.

## Verification

Browser regression coverage reproduces the wrapped-title example with neutral
text, checks reflow among compact/two-line/taller chips, checks both local and
traveling outlines, multiple simultaneous matches, variant groups, viewport
resizing, token-only changes and observer/token cleanup. The broader layout,
capsule raster, title-hover and History outline/motion suites cover the remaining
interaction states. Live-profile visual acceptance remains unavailable because
the browser tool previously blocked the extension URL; evidence here is from
the Chromium fixture harness and native synthetic contour masks.

Final results: `pnpm verify` passed (1,346 Node tests and 376 Vitest tests),
and all 202 selected browser tests passed. `git diff --check` is clean.
