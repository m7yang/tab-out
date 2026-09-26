# 0064: Preserve blank dashboard titles in History

Status: Accepted

Tab Out sets its empty-filter document title to a left-to-right mark so Chrome
renders it blank. Activation History removed that mark and substituted the
URL, while Domain Cards preserved it.

Preserve the existing deliberate blank-title value through History capture
and normalization. Keep the URL as the History row's accessible label and
preview target. Native Chrome titles and ordinary missing-title fallbacks
retain their existing behavior.

New-tab Domain Cards also bypass URL-keyed title suppression. Native Chrome
and Tab Out can both report `chrome://newtab/`, so a URL-keyed presentation
overwrote one representative's title with another's according to scan order.
Each new-tab chip now uses its own representative's title.
