# ADR 0048: Remove Domain Card Dedupe

- Status: Accepted
- Date: 2026-09-24

Remove the Dedupe button from Domain Card headers at user request. Browser-wide
dedupe remains available in the Tab Actions Menu; duplicate chip grouping,
stacked favicons, and open-copy counts remain unchanged.

This supersedes ADR 0028's decision to retain card-scoped dedupe. Remove the
card's dedupe handler and its local badge-closing animation state together
with the button. Other Domain Card actions remain in the card menu.
