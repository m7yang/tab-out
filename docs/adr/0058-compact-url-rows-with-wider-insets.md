# ADR 0058: Compact URL rows with wider insets

- Status: Accepted
- Date: 2026-09-26

## Decision

Same-title Page Chip groups use 20px-high URL capsules, 1px between rows and
4.5px right/bottom insets. Keep the 12px label text, inward focus/selection rings,
20.5px tall-chip radius ([ADR 0059](0059-increase-tall-page-chip-radius.md)),
38.5px card radius and compact Page Chip capsules.
The expansion measurement copy uses the same row padding and spacing.
Row action controls retain their width and use 18px height to avoid overlapping
adjacent rows. This supersedes ADR 0055's variant-row spacing only.

## Reason and limits

The initial 18px rows felt too small. After trying 19px rows and increasing the
parent radius to 20.5px, the user selected 20px rows with 4.5px insets to gain
both label breathing room and separation from the outer chip. Hit areas follow
the row height; 1px gaps separate adjacent targets.

Using ADR 0059's native painted-contour method at 16× and 32×, the selected
pattern gives about 3.29–3.77px corner clearance against a 3.5px straight clear
band (4.5px box gap minus the parent's 1px inward hover outline). Its maximum
clearance error is about 0.27px, compared with 0.36px for the original
18.65px-parent/19px-row/4px-inset pattern. The inset row focus/selection rings
and 18px action controls remain unchanged.

This is an approved optical pattern, not a claim of exact parallel contours or
a newly calculated geometric optimum. Preserve the fixed ancestor radii.

## Initial 18px verification

`pnpm verify` passed (1,347 Node tests and 376 Vitest tests), with generated
output checked using a temporary Git index. Eight focused browser checks passed,
covering grouping, expansion, row spacing and unchanged one-line/card geometry.
Real Chrome fixture inspection confirmed 18px URL/action targets, 1px row/action
gaps and 4px right/bottom insets. Live-extension acceptance was not exercised.

The 19px follow-up passed `pnpm verify` and the same eight browser checks.
Real Chrome fixture measurements confirmed 19px rows, 1px spacing and 4px insets.

The 20px/4.5px follow-up passed `pnpm verify` and the same eight browser checks.
Real Chrome fixture inspection confirmed 20px rows, 1px spacing, 4.5px insets
and the 20.5px parent radius. Live-extension acceptance was not exercised.
