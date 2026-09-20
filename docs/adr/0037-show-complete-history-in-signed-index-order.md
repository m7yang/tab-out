# Show complete Activation History in signed index order

Sorting by distance from the current position interleaved back and forward
targets as `0, -1, +1, -2, +2`. Deduplicating activated rows by page identity
also hid distinct physical tabs, leaving unexplained gaps in an unfiltered
navigation sequence. ADR 0036 prevented pending tabs from hiding activated
representatives, but preserved both of these presentation rules.

Keep every indexed physical tab, including activated and pending tabs with
matching URLs. Display indexed rows in descending index order, equivalent to
descending signed offsets from the current position: `+2, +1, 0, -1, -2`.
Offsets remain the actual navigation positions; filtering must not renumber
them. The underlying history stack and forward navigation through pending
tabs in FIFO creation order remain unchanged.

Activated history still reserves capacity first, followed by the earliest
pending tabs. Indexed identities still suppress overlapping Working Set and
recently closed rows. Clamp effective timestamps in signed display order
before the merged recency sort so supplemental rows can interleave without
reordering indexed targets, including when cross-tab activity refreshes a
back-history timestamp.

Regression coverage reproduces the reported interleaving and missing offsets,
checks duplicate utility pages, cursor movement, filtering, supplemental
deduplication and capacity, and verifies the rendered marker sequence.
