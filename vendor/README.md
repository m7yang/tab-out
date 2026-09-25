# Continuous capsule

`fleet-continuous-capsule-0.1.0.tgz` is the portable package produced by `pnpm pack`
from Fleet commit `dfa5cab9e1e3487d0880150a8c7ed9e3f3c56edf`, package
`agent-tools/packages/continuous-capsule` (version 0.1.0, unmodified sources).
Its measured profile is `swiftui-macos-27.0-26A428`.

The header Filter Query uses its 1px surface border. Focus repaints that same
path blue with the existing soft blue shadow, without an offset ring or gap.
The existing 280px (156px at the compressed breakpoint) by 34px
control box, text inset, input identity, and keyboard behavior are preserved.
The React adapter measures the native input's border box and retains geometry
until its dimensions change. The generated shell and unsupported dimensions use
a CSS capsule with the same blue border and shadow. Theme colors remain owned
by Tab Out; the package's separate offset focus path is intentionally unused.

Dashboard View uses the same profile for its 34px outer frame, 24px sliding
selection, and each tab's keyboard-focus contour. Border, fill, focus color,
spacing, and animation remain app-owned. The selection is measured during its
width transition rather than stretching a fixed SVG. CSS pills provide the
prerender and unsupported-size fallback; no material or shadow is added.

Overflow expanders, open-tab count badges, title-suppression tokens, chip
suppression markers, path-group labels (including PR badges), structural strip
indicators, toast buttons, Select controls/options, and click/context-menu items
apply the measured path through CSS `border-shape`. This
keeps their existing backgrounds, borders, inset highlights, shadows, and focus
outlines app-owned, including the original outline offsets. The adapter observes
size and content changes; expanded and clamped captured labels are rebuilt with
live refs.
Narrow/circular dimensions and fragmented inline labels retain CSS pill rounding.
Compact suppression and structural markers instead use a round path through the
same padded painter, preserving pixel alignment when they expand.

Chromium clips CSS `border-shape` backgrounds at fractional positions. Tab Out's
padded paint layer works around this without changing Fleet's geometry or the
vendored tarball. For consumer paint changes, consult the shared
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

Geometry changes belong in Fleet. See its
`agent-tools/guides/continuous-capsules.md` and
`agent-tools/guides/continuous-capsules-react.md`; the local checkout is
`/Users/ian/Developer/fleet`. Run that package's geometry tests, pack the new
version here, update this provenance, and install the tarball with pnpm.
