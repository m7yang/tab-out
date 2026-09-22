# ADR 0044: Ignore Echoed Filters in Activation History

- Status: Accepted
- Date: 2026-09-22

## Decision

Activation History identifies Tab Out pages with the shared URL helper before
calling the existing filter matcher, for indexed and supplemental rows alike.
The matcher already removes the echoed filter from dashboard titles and URL
query parameters. Genuine matches such as `Tab Out` remain visible, and an
empty filter restores the rows without changing stored navigation history.

## Rationale

Treating every history row as an ordinary page made the dashboard match any
query it echoed in its own title or URL. Reusing the Domain Card matching rule
fixes that inconsistency without introducing a blanket exclusion or another
matching algorithm.
