# 0060: Use native new-tab favicons

Status: Accepted

Chrome exposes an empty `favIconUrl` for its native new-tab document even
though the tab strip displays a monochrome Chrome icon. The ordinary empty-icon
fallback therefore showed a globe in Domain Cards. Activation History queried
the `chrome://newtab/` alias, which can resolve to the overriding extension.

When no icon is reported for `chrome://newtab/` or `chrome://new-tab-page/`,
resolve Chrome's favicon API against `chrome://new-tab-page/` in both contexts.
The packaged browser probe confirms this returns the native monochrome icon.
Keep reported data icons, including Tab Out's transparent favicon, unchanged.
No copied icon asset, title heuristic, or new permission is needed.
