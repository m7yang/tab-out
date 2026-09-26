# 0061: Separate native and dashboard new-tab duplicates

Status: Accepted

Chrome can report `chrome://newtab/` for both its native page and Tab Out.
Treating that URL alone as the dashboard identity put native and transparent
favicons into one duplicate stack and allowed cleanup across different pages.
This narrows the shared-identity assumption behind ADR 0050; its current,
pinned, grouped, and ordinary display buckets remain.

An alias joins the dashboard identity only when Chrome reports Tab Out's exact
declared favicon. Share that value with the HTML generator so the identity
check and page declaration cannot drift. An alias without the marker keeps
its native URL identity; titles and localized “New Tab” labels are not evidence.

Use the same distinction for Domain Card stacks, duplicate counts, toolbar
badge, cleanup planning, and final target/survivor revalidation. Preserve
physical URLs for activation and Undo, and keep the current page first across
the separate identities. Loading aliases are excluded from duplicate cleanup
until their document metadata settles. No additional Chrome permission or storage is needed.
