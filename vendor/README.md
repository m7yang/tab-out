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

Geometry changes belong in Fleet. See its
`agent-tools/guides/continuous-capsules.md` and
`agent-tools/guides/continuous-capsules-react.md`; the local checkout is
`/Users/ian/Developer/fleet`. Run that package's geometry tests, pack the new
version here, update this provenance, and install the tarball with pnpm.
