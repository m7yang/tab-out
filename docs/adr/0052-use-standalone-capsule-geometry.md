# ADR 0052: Use Standalone Capsule Geometry

- Status: Accepted
- Date: 2026-09-25

## Decision

Consume version 0.1.1 of `@fleet/continuous-capsule` from the standalone
`continuous-capsule` repository through a retained, pinned tarball. The package
name remains stable. [Vendor provenance](../../vendor/README.md) records the
extraction source and artifact checksum.

The CSS paint adapter, Filter Query decoration, and Dashboard View decoration
request `includeFocus: false`. They paint only the surface, including when
repainting that surface for keyboard focus. The History match frame continues
to request the full geometry because it paints the offset focus path while
resizing.

## Rationale

The previous package computed a densely sampled focus offset on every call,
including callers that discarded it. Skipping this calculation preserves the
surface path, inset, validation, fallback, and observation timing. The measured
profile, default full geometry, and offset algorithm are unchanged.

The standalone repository retains geometry source, native fixtures, exporter,
research, integration guidance, tests, and a public-interface benchmark.
Geometry ownership moves there for this consumer, superseding the Fleet
ownership statement in [ADR 0051](0051-capsule-adapter-owns-padded-paint.md).
Tab Out retains painting, themes, interaction, fallback selection, and observer
lifetimes as decided in that ADR. Other Fleet consumers are outside this change.

## Verification

Package tests compare surface-only output with full output across native sizes
and border widths, retain validation checks, and verify native contours and
focus offsets. Compare default output directly with the prior package as well.
Run Tab Out's base verification and capsule crop, History motion, and dashboard
browser coverage. Geometry microbenchmarks do not establish dashboard speedups.

The initial integration passed seven package tests, 588 exact comparisons with
0.1.0, declaration compatibility checks, and the base pipeline (1,346 Node and
376 Vitest tests). The generated-output gate used a temporary Git index so the
working changes remained unstaged. Public geometry benchmarks measured roughly
12–21× faster surface-only calculation at the three tested sizes.

The complete HTTP-fixture browser suite passed 256 of 259 tests, including
capsule crop/paint and History motion. The two `bottom cue covers` cases in
`dashboard-scroll-edge.spec.ts` and `dashboard cards repack when the viewport
resizes` in `dashboard-smoke.spec.ts` also failed on the original committed
bundles and fixtures. They remain pre-existing verification failures. Live
Chrome visual inspection was inconclusive while the Mac was locked; the
browser connection returned a blank page.
