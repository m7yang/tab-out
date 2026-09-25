# Nested radius audit — 2026-09-22

Audited the current working tree against Fleet commit `2b1d622`,
`agent-tools/guides/nested-corners.md` and its calculation reference. This report
supersedes the recommendations in the [September 21 audit](nested-radius-audit.md)
where they differ. Findings below describe the audited baseline; the application
record at the end identifies the implemented corrections.

## Findings

### History range picker: use a 9px item radius

The [popup and items](../src/components/HistoryRangeSelect.tsx) use a 16px outer
squircle and 8px inner squircles. The [select group](../src/components/ui/select.tsx)
provides 4px padding. Rendered first/last items have 4px gaps on their adjacent
edges, with sufficient dimensions to avoid radius reduction. The popup ring is
outside its box and does not consume this interior band.

Holding the popup and spacing fixed gives `r ≈ 16 - 1.75 × 4 = 9px`.
Native paint measurement reduces maximum clearance error from about 0.19px at
8px to 0.09px at 9px. This is a small geometric improvement, not a clipping bug.
The previous audit's preference for sharing the 8px menu token does not follow
the new token-selection rule: 8px is 1px away from the calculated result.

Recommendation: change this caller's item radius to 9px. Shared menu items
remain 8px because their popup radius is 15px.

### Title-variant list: 6px is tighter than the hover fit

The last full-width [title-variant row](../src/components/PageChip.tsx) follows
the Page Chip's bottom-right corner. Its left edge is indented and is not a
matching nested corner. The shared parent radius is 17px, the row radius is
6px, and measured right/bottom box gaps are both 6px. Hover paints a 1px inward
parent outline, leaving a 5px straight clear band.

Keeping the radii fixed, the painted shortcut gives:

```text
g ≈ 1 + (17 - 1 - 6) / 1.75 ≈ 6.71px
```

The native full-corner fit is approximately 6.73px. Nearest-half-pixel rounding
selects **6.5px**, whose maximum hover clearance error is about 0.14px, compared
with 0.23px at the current 6px. A 7px gap has about 0.22px error. Restoring 9px
is not justified by this fit. The [prior calibration](nested-radius-calibration.md)
already identified the difference between the 6px implementation and full-corner
fitting.

Recommendation: if retaining both radii, use 6.5px right/bottom box gaps as the
hover-fit candidate. That means list padding of 2.5px right and 1.5px bottom,
combined with the parent's existing 4px right and 5px bottom padding. Keep the
[expansion measurement clone](../src/components/page-chip-text-layout/fragments.ts)
in sync. No ancestor radius change is needed.

The keyboard focus outline needs a separate state check. Its 2px width plus
1px positive offset extends 3px beyond the row. With the parent's hover outline
also present, the current 6px box gap leaves about 2px along straight edges but
only 1.19px at the tightest sampled corner. The contour remains contained;
the maximum clearance error is about 0.82px. A fill-only spacing calculation
does not establish a uniform focus band. Preserve the focus affordance and
record any accepted optical compromise when choosing the final pattern.

### History-match frame: retain as a documented compromise

The [local card frame](../src/components/DomainCard.tsx) and
[moving frame](../src/components/HistoryMatchFrame.tsx) both use 40px squircles
with a 1px inward border. The bottom chip sits 16px inside the frame's box and
its match outline extends 2px outward, leaving 13px straight clear space.
One-line chips reduce the declared 17px radius to 13.125px at 26.25px height;
taller chips retain 17px. One scalar shortcut cannot fit both painted cases.

[ADR 0039](adr/0039-outline-history-matched-domain-cards.md) explicitly records
40px as a shared fit across sizes. A finer comparison of radii from 39px to
43px in 0.5px steps found 41.5px best among the tested values: worst clearance
error across the sampled sizes fell from about 0.83px to 0.55px. The short-card
case included outer radius reduction at 82.25px frame height.

Treat 41.5px as an optional refinement for these sampled states, not a universal
replacement. Keep 40px under the existing optical decision unless revising this
pattern deliberately. Such a revision must update both frame implementations
and the ADR, and verify additional compact/overflow states. The title-variant
spacing finding does not require propagating changes to this frame.

## Reviewed and retained

| Family | Evidence and disposition |
| --- | --- |
| Dashboard view switch | 16px outer radius, 1px inward border, 5px box gap and 8px indicator radius satisfy `16 - 1 - 1.75 × (5 - 1) = 8`. Native maximum error is about 0.09px. First and last options were measured; their focus outline stays contained, with about 0.16px clearance error. |
| Context and dropdown menus | Shared 15px popup, 8px item and 4px padding satisfy `15 - 1.75 × 4 = 8`. Context-menu layout was measured; dropdown uses the same style definitions. Native maximum error is about 0.09px. |
| Filter, Page Chip and history overlays | Coincident edges inherit or share the surface radius. These are not inset corner bands. Expanded fills and fades also preserve their existing seam treatment. |
| Dialog, toast and error shells | Buttons/detail content are independent elements in a padded content layout. Fitting one child corner would not establish a consistent surrounding band for the layout. |
| Favicon rings, stacks, inline markers and badges | Artwork contours are not guaranteed; stacks are translated copies; text markers wrap; badges overlap. Their geometry does not meet the equal-inset nested-corner assumptions. |
| Circular controls, pills, tooltips, URL preview and toolbar popup rows | Preserve the intended shape. No separate child surface was found following a parent corner with a uniform inset band. |
| Other shared Select/Tabs variants | Product callers override the audited geometry. Unused primitive defaults do not justify a global radius change. |

## Evidence and limits

Source inspection covered radius/corner-shape declarations in runtime components,
shared primitives, chip measurement helpers, and styles. The current generated
bundle passed `pnpm verify:bundle` before fixture inspection.

Native Chromium 153.0.8010.12, driven by Playwright 1.63.0, supplied computed
geometry from the dashboard fixture. Title-variant gaps were checked at viewport
widths 1420, 900 and 640px, plus an expanded/focused case at 430px. The fixture's
range picker, first/last view options and context menu were opened through their
controls. Domain-card measurements confirmed 16px right/bottom gaps and the
one-line radius reduction.

Separate opaque native CSS paint masks reproduced those radii and stroke styles
at 32 device pixels per CSS pixel. Quarter-degree contour samples and convex
support distances measured clearance over the corner, including straight-edge
limits. Reported errors are rounded geometric measurements, not perceptual
thresholds or claims of exact constant thickness. The frame comparison sampled
short and tall chips and an 82.25px frame; it does not exhaust dynamic card sizes.

The browser connector did not expose the live extension surface. These results
are fixture and native-renderer evidence, not live-extension acceptance.

## Initial applied corrections

The range-picker item radius is now 9px. Title-variant lists use explicit 2.5px
right and 1.5px bottom padding in both rendering and expansion measurement,
producing 6.5px box-edge gaps. The existing assertions were updated and generated
extension assets rebuilt. The shared Page Chip and history-frame radii remain
unchanged.

Fixture measurements confirmed the 9px item radius and 6.5px gaps at rest,
hover, focus, widths 1420/900/640px, and expanded/focused at 430px. Visual
inspection found the existing focus outline visible and contained. Its native
paint model at the new gap has about 2.5px straight clearance and 1.90px minimum
corner clearance (0.61px maximum error). Retain that nonuniform band as an optical
compromise: the spacing follows the hover fill while preserving the existing
focus stroke and compact layout.

Verification passed: `pnpm verify` (1,342 Node tests and 376 Vitest tests),
with the generated-output check using a temporary Git index to preserve existing
staging. The layout suite passed 109 of 110 checks; the exit-ghost animation check
failed to observe its opacity keyframe during the suite and passed on an isolated
rerun. Targeted geometry and focus inspection passed. Live-extension acceptance
remains unverified.

## Optical adjustment — 7px title-variant corners

After the geometric correction, the inner highlight still looked too square to
the user relative to the outer corner. A native fixture comparison of 6px, 7px
and 8px inner radii held the 17px outer radius and 6.5px spacing fixed. The chosen
7px radius gives a restrained softening. Full-width rows and their expansion
clones share this value; independent inline labels retain their existing shape.

This is a component-specific optical choice, not a new geometric coefficient or
a perceptually calibrated optimum. The native paint model gives hover clearance
of about 5.43–5.74px against a 5.5px straight band, increasing maximum error from
0.14px to 0.24px. With the existing focus outline, minimum clearance improves
from about 1.90px to 2.12px against a 2.5px straight band. The small hover flare
is accepted to soften the highlight while keeping spacing and outer silhouettes
stable. Reuse the 7px row radius with this pattern's 17px parent, 6.5px gaps and
existing stroke styles. For other patterns, follow the
[UI guide's radius policy](agents/ui.md#components-anchors-and-styling).

Verification: expanded/focused fixture geometry reports 7px inner radius with
6.5px right/bottom gaps. Five relevant layout checks passed. The base pipeline's
checks through bundle validation passed; after updating the old radius assertion,
test-file lint and all 1,718 unit tests passed. Visual inspection used the fixture;
live-extension acceptance remains unverified.

## Action toast nesting — 2026-09-24

The continuous-capsule action now deliberately follows the toast's bottom-right
corner. This replaces the earlier independent-control treatment for action
toasts only. The other button corners and the overlapping close button do not
form matching nested bands. The shared toast component right-aligns actions in
both dashboard and toolbar-popup notices; the close control stays at the top-left.

All toasts share a 36px outer squircle radius, whether or not they have an
action. The user rejected increasing the radius to 40px for a closer reference
silhouette; preserve the smaller radius consistently.

Use a 24px-high capsule with 13px action text, 10px container padding, and a 1px
inward container border. Right and bottom box gaps are 11px, yielding a 10px
straight clear band. A minimum 54px action content height keeps the outer box
at least 76px tall; a flexible column anchors the action to the bottom even
without a description. Keep an 8px minimum gap between copy and action. The copy
adds 2px top and horizontal padding in both variants, preserving a shared 13px
horizontal box-edge inset. Notices without actions use the same 10px container
padding, with a minimum 50px content height and vertically centered copy. Their
outer box is at least 72px tall, ensuring the shared 36px radius is not reduced by CSS radius overlap scaling.

The macOS Notification Center reference supplies the spacing target, not a
native radius token. Its visible edge gap is approximately 45% of its button
height; the selected 11px box gap for the 24px action is 46%. These screenshot
proportions are approximate; this is an explicit optical pattern, not a new
universal nesting coefficient.

Matching-squircle shortcuts do not apply to this mixed shape pair. The package's
actual capsule path was compared against the inside of a native Chromium 153
squircle border using supporting-line distances over the matching corner and
adjacent straight segments. The selected 11px box gap and 36px radius give
approximately 9.77–11.18px clearance around a 10px straight band. This accepts a
1.18px maximum corner deviation to preserve the requested smaller shell and
button spacing. Native paint was sampled at 32 device pixels per CSS pixel with
a midpoint black/white threshold. Other button corners and the overlapping close
control are not matching nested bands.

Preserve the action's 2px focus outline at -1px offset. Its 1px outward extent
uses the existing clear band; action content allows visible overflow so that
outline is not clipped at the right or bottom edge. Colors, shadows, viewport
insets, and close-button positioning are unchanged.

## History range capsule options — 2026-09-25

The range picker now uses Fleet continuous capsules for its option highlights.
This supersedes the earlier 9px squircle item recommendation for this picker.
Keep the 24px option height and equal 4px group padding; use a **28px outer
squircle radius** on the History range popup. Other menu families retain their
existing tokens. The popup’s 1px ring lies outside its box, so the relevant
clear band is the 4px between the popup fill boundary and the option fill.
The first and last options supply the four nested corner pairs.

This mixed shape pair does not use the matching-squircle `1.75` shortcut.
Evaluating Fleet’s general convex-contour clearance function with the actual
136×24px, zero-border capsule path and an ideal CSS squircle outer boundary,
while fixing the 4px gap and fitting only the popup radius, gives approximately
27.981px. Half-pixel token rounding selects 28px. Angular and cubic sampling
at 90, 180, and 360 subdivisions keeps that token stable. The model’s clearance
range at 28px is approximately 3.69–4.30px; the former 16px radius gives about
4.00–6.98px. This is a geometric model, not a new native-renderer calibration
or a claim of exact constant thickness. No optical bias is added.

The 144px minimum popup width and eight 24px rows leave enough space for the
28px used radius without overlap reduction in the normal open menu. Preserve
the existing item focus fill, selected checkmark, popup ring, and scrolling
behavior. Recalculate for different option heights or padding rather than
copying 28px into unrelated shared popup defaults.

## Menu item shapes

Current policy, updated 2026-09-25: click menus, context menus, and the toolbar
popup use continuous capsules for single-line items and CSS squircles for
multiline items, including rows with secondary status text. Size/content
observation restores the capsule when content returns to one line. Multiline
corners use the single-line reference rather than growing with extra lines:
**21px** for click/context menus and **26px** for the toolbar popup, subject to
CSS radius overlap reduction. Preserve existing state colors and spacing.

### Click and context menu geometry

This supersedes the earlier 15px popup / 8px item squircle pair for these two
menu families. Preserve their 4px popup padding, 8px item
text inset, 13px type, 1.25 line height, and 4px vertical item padding. A normal
single-line item is 24.25px tall; the 160px minimum popup gives it 152px width.

With that zero-border capsule path and a fixed 4px clear band, the general
convex-contour function fits an ideal outer squircle radius of about 28.200px.
Sampling at 90, 180, and 360 subdivisions selects the existing **28px token**;
its modeled clearance is about 3.70–4.36px. No optical bias is added. The popup
ring remains the preset's 1px outward ring and does not reduce the inner gap.

For a one-item menu, CSS caps the used radius at half the 32.25px popup height
(16.125px). This is the best available radius under the unchanged dimensions,
but its modeled corner clearance can reach about 7px. Preserve that compact
height. Wrapped rows likewise retain their content-driven height; the
28px token is fitted to the normal single-line row, not every possible height.

### Toolbar popup geometry

The combined cleanup label breaks after “Close all suspended tabs”, with “and
dedupe” on its second line. Keep the popup width, 8px text inset, 14px type,
1.25 line height, and 6px vertical padding: a single line is 29.5px tall and
two lines are 47px tall.

### Multiline corner fit and limits

For the toolbar popup, fitting a squircle corner to the actual 29.5px capsule
corner at coincident box edges gives approximately 25.781px; the nearest-half
pixel token is **26px**. Angular/cubic sampling at 90, 180 and 360 subdivisions
keeps that token stable. The modeled deviation at 26px is at most 0.30px.
CSS caps this to 23.5px on the two-line row, whose deviation from the reference
corner is at most 0.80px; preserve the compact height rather than enlarge the
row to avoid the cap. Taller rows use the full 26px. This is a geometric
approximation for visual continuity, not an identical contour or a calibrated
perceptual match. The shared click/context menu's 24.25px single-line reference
scales the same fit to 21.193px, selecting **21px** with the same overlap rule.
