# ADR 0035: Use Page Chip Cursors For Activation Targets

- Status: Accepted
- Date: 2026-09-19

Page Chip activation uses an arrow for a represented open tab and a hand for an
actionable closed page or bookmark/history reference. This reinforces the
distinction between selecting an existing tab and following a page reference,
while keeping the existing liveness styling. Suspended tabs remain open.

The cursor follows each surface's ordinary activation target, including the
default target of a same-title group. Folded group bodies and unavailable
Activation History entries keep the arrow because they do not activate a page.
Modifier keys do not change the cursor, and secondary controls keep their own
treatment. Expansion preserves the target's cursor.

The hand indicates a link-like action, not guaranteed tab creation. Closed-page
recovery and bookmark/history activation may reuse an exact open match after
revalidation. Cursor rendering uses the represented target and does not add a
browser lookup or change activation policy.
