# 0062: Match new-tab hover by physical membership

Status: Accepted

New-tab display buckets preserve current, pinned, grouped, and ordinary tabs
and distinguish native Chrome from Tab Out (ADR 0061). URL-only hover matching
still outlined every bucket and History row sharing `chrome://newtab/`.

Carry the existing bucket's physical tab IDs through the shared hover store.
A History row matches only the bucket containing its tab; a bucket matches
only the History rows it represents. Apply this to pointer and keyboard
previews, including collapsed overflow. Keep normal-page URL matching and
native Chrome's representative-tab highlight unchanged. No stored state or
new identity inference is needed.
