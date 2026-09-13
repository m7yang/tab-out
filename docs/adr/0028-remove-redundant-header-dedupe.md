# ADR 0028: Remove Redundant Header Dedupe

- Status: Accepted
- Date: 2026-09-13

The Dashboard header keeps search, counts, and the contextual filtered-close
action. Browser-wide dedupe already lives in the Tab Actions Menu, with its
close-target count also available on the toolbar badge. Remove the header's
additional dedupe button to reduce competition with search and status; Domain
Card dedupe continues to provide scoped cleanup.

When some tabs are suspended, the unfiltered count reads “23 of 36 tabs active”,
emphasizing the active number. Filtering retains matching-versus-total counts
and the supplementary active count. The all-active and read-only Source counts
keep their compact existing labels.
