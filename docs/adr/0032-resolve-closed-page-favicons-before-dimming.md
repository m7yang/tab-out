# 0032: Resolve closed page favicons before dimming

Status: Accepted

## Context

Suspenders can encode reduced alpha directly into a tab's data-URL favicon.
Open suspended tabs already resolve their effective page URL through Chrome's
favicon cache. Saved and retained snapshots preserve the reported image but
do not preserve enough provenance to distinguish a suspender's faded image
from a genuine site data favicon after closure. Applying the closed-page
opacity to that image dims it twice.

## Decision

Closed Saved Page and Retained Page chips prefer the effective page URL's
Chrome favicon cache entry, even when their stored icon is a data URL. This
also repairs presentation of existing snapshots without a storage migration.
Awake tabs and read-only Bookmarks/History sources continue to preserve data
favicons. Stored images remain the fallback when the favicon API is absent.

## Consequences

Tab Out owns the closed-page dimming once. Closed icons depend on Chrome's
cache coverage, as open suspended icons already do; a cache miss may show a
generic icon instead of the snapshot's image. No suspender changes or pixel
alpha heuristics are needed.
