# ADR 0056: Adopt native-render-fitted capsules

Date: 2026-09-26
Status: Accepted

## Decision

Use `@fleet/continuous-capsule` 0.3.0 for every existing capsule consumer.
Replace the exported-command profile with the frozen fit to a 332×150 SwiftUI
Capsule capture at 16× on macOS 27.0 (26A428). Preserve the shared API, minimum
1.6 path aspect ratio, border inset, focus-offset algorithm and consumer paint
adapters. Compact Page Chips, labels, menus, controls and matching outlines all
receive the same curve through their existing package calls. Tall chips and
card outlines retain ADR 0055's CSS midpoint contours.

## Reason

Rebuilding native exported commands as a SwiftUI Path differs from native
Capsule paint even within the same renderer. Command equality alone was therefore
insufficient evidence of native rendered fidelity. The frozen fit improves all
eight independent 16× holdouts; the 300×26.25 reference improves from 0.0521px
to 0.0125px in the sampled boundary-support metric.

Seven of eight holdouts also improve at 2×; 180×24 regresses from 0.0906px to
0.1082px. Accept this small, recorded tradeoff rather than retuning against the
holdouts. The result is an approximation, not exact native paint or a claim of
fixing sharp vertices. Segment tangents align; curvature continuity is not proven.
Focus rings remain calculated offsets, not native focus effects.

## Verification

The package retains the training image, frozen profile, original exported
fixtures, holdout paths, native comparison report and reproduction scripts.
Geometry checks cover serialization, bounded paths, joins, focus clearance,
invalid inputs and the unchanged 561-case rectangle corpus. Native captures
must reproduce the retained report. Tab Out additionally checks CSS border-shape
against SVG at fractional positions and 1×/2×/3× scales, resize/cleanup, interaction
paint and matching-outline motion, plus dashboard layout and real Chrome visuals.

The generated profile splits each fitted cubic exactly in half, offline. Its
24 cubic segments describe the same fitted silhouette. This eliminated the
CSS/SVG edge-pixel mismatches found at fractional 3× positions without changing
the existing 12-level pixel tolerance. Enlarging the paint margin did not help;
changing reference translation alone introduced failures elsewhere. Native paint
was rechecked after subdivision because equivalent paths can rasterize differently.
