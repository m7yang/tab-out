# ADR 0047: Remove Header Filtered Close

- Status: Accepted
- Date: 2026-09-24

Remove the contextual “Close N open tabs” button from the Dashboard header at
user request. The header keeps the Filter Query, counts, and Dashboard View
selector; tab cleanup remains available through Domain Card and Page Chip
actions and the Tab Actions Menu.

This supersedes ADR 0028’s decision to retain the contextual filtered-close
button. Remove its Dashboard callback and focus-transfer handling together
with the control, so filtering no longer introduces a header cleanup action.
