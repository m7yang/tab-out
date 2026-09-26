# 0063: Include native new-tab document URLs

Status: Accepted

Live Chrome can expose a native tab as `chrome://new-tab-page/`, not just
`chrome://newtab/`. Activation History kept the former, but the Dashboard's
internal-page filter excluded it. Its History row therefore had no matching
chip, and the New tabs count omitted a live tab.

Recognize both URLs in the shared new-tab predicate. Give the native document
the same duplicate identity as the native alias, keeping Tab Out's confirmed
override identity separate. Preserve physical URLs for activation and Undo;
the existing tab-ID membership rule then matches hover in both directions.
Other Chrome internal pages remain outside the live Dashboard population.

Membership in the New tabs card does not establish a runnable dashboard.
Window-merge handoff selects only the extension document or an alias with
Tab Out's declared favicon, so a native page cannot intercept confirmation.
