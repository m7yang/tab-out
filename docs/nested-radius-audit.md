# Nested radius audit — 2026-09-21

Scope: radius declarations in runtime components, shared UI primitives, chip
paint helpers, and the base stylesheet. This is a source audit plus local
Chromium layout evidence, not a claim that every live extension state was tested.

## Method

This audit treated a child as a contour-fitting candidate when its surface
followed the container's corner with a narrow surrounding gap. It used radii,
dimensions, border widths, and actual edge separation to assess candidate radii.
Independent controls inside a larger content layout need not form a uniform
parallel band with their container.

For matching, unclamped squircle corners with equal box-edge gaps, the ideal
midpoint estimate is `R ≈ r + 1.8409g`. This supplies candidates; it does not
account for painted borders or optimize the complete curve. The audit compared
the baseline with nearby tokens using the same geometry and stroke styles.

The control comparisons rasterized native CSS at eight pixels per CSS pixel.
Clearance was measured from five inner-corner samples to the nearest outer
painted edge. Angles 15, 30, 45, 60, and 75 degrees locate samples from the inner
corner center; they are not normal directions. Values below are rounded to 0.1px;
differences smaller than approximately 0.25px should not be treated as precise.

## Corrections

| Surface | Existing geometry | Change and evidence |
| --- | --- | --- |
| Dashboard view switch | 16px outer radius, 10px indicator radius, 5px box gap including a 1px border | Use 8px (`rounded-lg`) for the indicator and its corresponding focus frame. Target painted clearance is 4px; sampled maximum error falls from about 0.6px to 0.1px. Check the first and last options, where the indicator faces a container corner. |
| History range picker | 16px popup radius, 10px items, 4px group padding | Use the same 8px item token. Sampled corner clearance changes from about 4.4px to 3.9px against a 4px side gap. A 9px candidate also fits; the measurements do not justify a separate token over 8px. |
| Error detail panel | Rounded detail background inside a squircle error surface | Add the missing squircle shape while keeping its 8px radius. |
| Icon-only Page Chip audio badge | `rounded-full` combined with squircle shaping | Remove the squircle override so the circular badge follows the shared audio-button shape. This is an overlapping badge, not a nested contour fit. |

## Reviewed and retained

| Family | Reason |
| --- | --- |
| Domain Card history-match frame | The 40px frame already has a measured fit across short, one-line, and two-line cases; see [ADR 0039](adr/0039-outline-history-matched-domain-cards.md). |
| Dropdown and context menus | Shared 15px popup, 8px item, and 4px padding produce about 4.1px diagonal clearance. Both menu kinds use the same style definitions. |
| Filter field and Page Chip/Activation History frame overlays | These paint the same surface boundary and inherit or share its radius. Do not add a nesting gap to coincident edges. |
| Expanded chip/history fill and action fades | These are layered paint for one surface. Their small vertical seam insets protect adjacent outlines; changing them to a nested-radius model would change seam behavior. |
| Dialog, toast, and error shells | Their action buttons are independent controls in a padded content layout. Increasing entire shells to fit one button's corner would substantially alter their silhouettes without establishing a uniform band across the other content. Existing padding keeps content clear. |
| Favicon rings and duplicate stacks | Rings wrap images whose artwork has no guaranteed inner contour. Duplicate layers are translated copies, not concentric nested surfaces. |
| Environment pills, title variants, suppression/path labels, and text highlights | These follow text flow inside Page Chips and can wrap or move. They do not track the parent corner with a fixed equal inset. |
| Circular close/pin/saved/count badges and scrollbars | Preserve circular or pill geometry; most badges overlap rather than nest. |
| Tooltips, empty states, URL preview, and toolbar popup rows | No separate child surface forms a matching nested corner band. |
| Uncustomized shared Select/Tabs variants | Product callers supply the audited styles. Preserve the shared primitives' other supported variants instead of changing unused upstream geometry. |

## Verification

The rebuilt switch indicator and focus frame report 8px radii, with 5px box-edge
clearance at the first and last options. The range picker reports 8px items,
a 16px popup, and 4px group padding; keyboard navigation reaches the last item
in a height-constrained popup. The rendered error fallback reports an 8px
`superellipse(2)` detail panel.

Code checks, build, bundle validation, and 1,717 unit tests passed. Of 182 HTTP
browser checks, 181 passed. The dashboard smoke test's narrow header-gutter
assertion also fails against the unchanged committed build (`36b629e4`), at
`dashboard-smoke.spec.ts`'s filter-to-page-gutter comparison. It is not caused by
these radius changes. Live extension inspection remains unavailable.
