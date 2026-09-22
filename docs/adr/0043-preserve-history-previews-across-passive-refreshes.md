# ADR 0043: Preserve History Previews Across Passive Refreshes

- Status: Accepted
- Date: 2026-09-22

## Decision

Passive Dashboard snapshots preserve previews owned by Activation History and
Working Set rows. Explicit filter, source, and Dashboard View changes still clear
previews, as do existing pin and activation actions. Domain Card Page Chip
previews retain their existing refresh cleanup because those surfaces may move.

Each History entry releases only its own preview when it unmounts or its
represented target changes. Target identity includes the preview source, URL,
exact match URL set, and live tab ID. Metadata such as title, favicon, and
activation time does not invalidate ownership. Cleanup uses the owner guard from
[ADR 0041](0041-scope-history-preview-clears-to-their-owner.md), so removing an old
row cannot clear a newer row's preview.

The outline movement and interruption timing from
[ADR 0042](0042-move-the-history-match-frame-between-cards.md) is unchanged.

## Rationale

The layout effect previously cleared every preview whenever a new Dashboard
snapshot arrived. An unrelated tab's favicon update therefore erased both
outlines while the pointer remained on the same History chip. Moving within that
chip could not restore the preview because its mouse-enter handler did not run
again. During rapid hover changes this appeared as an intermittently missed
outline update.

Keeping row ownership through passive updates avoids clearing and replaying the
preview, while explicit identity cleanup prevents stale URL and native-highlight
ownership after replacement or removal.

## Verification

Browser regressions in `tests/browser/history-hover-outline.spec.ts` update a
different tab's favicon with the pointer or keyboard focus held on History Alpha.
They wait for the refreshed favicon, then check the matching Page Chip, both
outlines, and URL preview without re-entering the row. Further checks cover
filter invalidation and removal or replacement of the owning History target.

Verification passed `pnpm verify` (1,341 Node and 376 Vitest tests), 133 selected
layout/history browser checks, and all 14 history-outline checks after tightening
the replacement case to preserve keyboard focus. The packaged-extension suite
passed 15 checks initially; its remaining service-worker startup timeout passed
on a focused rerun. The original rapid-hover refresh probe also passed without
missing outlines. Live profile inspection remains unavailable because the
browser tool blocks the extension URL.
