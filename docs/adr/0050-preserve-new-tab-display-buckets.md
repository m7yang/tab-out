# ADR 0050: Preserve New Tab Display Buckets

- Status: Accepted
- Date: 2026-09-25

## Decision

The New tabs utility card keeps its current, Chrome-pinned, Chrome-grouped,
and ordinary display buckets out of same-title URL variant grouping.
It preserves that bucket order (Chrome groups ordered by group ID), bypassing
URL-based Working Set priority and remembered chip order. Physical URLs remain
unchanged for activation and other tab actions.

## Rationale

Switching Dashboard View changes the current dashboard's query parameters.
Generic same-title grouping treated that URL change as a new page variant,
merging the current chip and duplicate stack into a nested URL group. The
same physical tabs consequently had different layouts in All Tabs and
Open + Saved. The utility card already groups these tabs by canonical
identity and physical state, so generic title grouping must not merge them
again. URL-based ordering also mistakes a changed dashboard URL for a new
row, pushing the current tab below the remembered duplicate stack. Keeping the
bucket order avoids both that jump and URL-specific priority changes. Ordinary
Domain Cards retain same-title URL variant grouping and their existing ordering.

The behavior contract lives in [CONTEXT.md](../../CONTEXT.md#cards-loading-and-tab-actions).
