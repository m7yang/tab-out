# ADR 0029: Limit URL Row Hover to Its Own Target

- Status: Accepted
- Date: 2026-09-16

Same-title Page Chip groups previously highlighted their default URL row when
the pointer hovered the shared title, padding, or gutter. Remove this indirect
highlight so a URL row only looks hovered when the pointer reaches that row.
The shared surface still activates and previews its deterministic default
variant, and Title Expansion continues to reveal clipped content.
