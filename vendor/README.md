# Continuous capsule

`fleet-continuous-capsule-0.3.0.tgz` is produced by `pnpm pack` from
`/Users/ian/Developer/continuous-capsule` at standalone commit
`fcd069cd97a05e6188ee196694cb46cd4e414b76` (2026-09-26).
Its SHA-256 is
`79091b0f2dfd76b444b9cbeeb7fabca79ff0efc4323d6f943968397733d2309c`.
Version 0.3.0 adopts the frozen capsule render fit and includes the zero-radius
rectangle focus-ring fix. The profile is
`swiftui-macos-27.0-26A428-render-fit-v1`. Original native exports, the training
capture, frozen fit, comparison report, and reproduction scripts remain in the
package repository. The 0.2.0 tarball is retained unchanged as the prior artifact.

The fit improves all eight high-resolution holdouts and seven of eight 2×
holdouts; 180×24 worsens by 0.0176 CSS px at 2×. It approximates native filled
silhouettes on the recorded OS, not every Apple control or browser pixel.
See [ADR 0056](../docs/adr/0056-adopt-native-render-fitted-capsules.md).

Tab Out now uses CSS midpoint corners for tall Page Chips and card outlines
([ADR 0055](../docs/adr/0055-use-midpoint-corners.md)); compact capsules still use
this package. Its native rectangle API remains available as the validated reference.

The header Filter Query uses its 1px surface border. Focus repaints that same
path blue with the existing soft blue shadow, without an offset ring or gap.
The existing 280px (156px at the compressed breakpoint) by 34px
control box, text inset, input identity, and keyboard behavior are preserved.
The React adapter measures the native input's border box and retains geometry
until its dimensions change. The generated shell and unsupported dimensions use
a CSS capsule with the same blue border and shadow. Theme colors remain owned
by Tab Out; `includeFocus: false` skips the unused separate offset focus path.

Dashboard View uses the same profile for its 34px outer frame, 24px sliding
selection, and each tab's keyboard-focus contour. Border, fill, focus color,
spacing, and animation remain app-owned. The selection is measured during its
width transition rather than stretching a fixed SVG. CSS pills provide the
prerender and unsupported-size fallback; no material or shadow is added.
These decorations and the CSS border adapter request surface-only geometry.
The History match frame retains full geometry for its animated offset outline.

Overflow expanders, open-tab count badges, title-suppression tokens, chip
suppression markers, path-group labels (including PR badges), structural strip
indicators, toast buttons, Select controls/options, and click/context/toolbar-popup menu items
apply the fitted path through CSS `border-shape`. This
keeps their existing backgrounds, borders, inset highlights, shadows, and focus
outlines app-owned, including the original outline offsets. The adapter observes
size and content changes; expanded and clamped captured labels are rebuilt with
live refs.
When changing menu item shapes or line wrapping, follow the
[menu shape policy](../docs/nested-radius-audit-2026-09-22.md#menu-item-shapes)
for shape selection, radius constraints, and fit limits.
Narrow/circular dimensions and fragmented inline labels retain CSS pill rounding.
Compact suppression and structural markers instead use a round path through the
same padded painter, preserving pixel alignment when they expand.

Chromium clips CSS `border-shape` backgrounds at fractional positions. Tab Out's
padded paint layer works around this without changing the capsule geometry. For consumer paint changes, consult the shared
[adapter](../src/components/capsule-border.ts) and its
[paint styles](../src/components/capsule-border.css).
The ref owns observation, fallback selection, paint placement, and cleanup,
including the decorative child used when overflow expanders reserve both pseudos.
Callers provide their existing control and theme states through `--capsule-fill`
and `--capsule-border-color`; fallback theme styles stay in
[app.css](../src/styles/app.css). Paint-mode attributes, contour properties, and
paint children are internal to the adapter.
Preserve colors, borders, shadows, focus outlines, layout, and hit targets.

After changing consumer paint, rebuild the extension and run
`pnpm test:browser:all tests/browser/capsule-crop.spec.ts`.
The [crop regression](../tests/browser/capsule-crop.spec.ts) must pass its
fractional-position comparisons at 1×, 2×, and 3× display scales and its
interaction-paint checks before handoff.

Geometry changes belong in the standalone `continuous-capsule` repository;
see [ADR 0052](../docs/adr/0052-use-standalone-capsule-geometry.md).
The installed package includes `docs/continuous-capsules.md` and
`docs/continuous-capsules-react.md`. Run the standalone package's geometry tests,
pack the new version here, update this provenance and checksum, and install the
tarball with pnpm. Fixtures, exporter, and benchmark remain in that repository.
