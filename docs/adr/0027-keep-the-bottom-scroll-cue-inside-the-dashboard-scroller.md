# ADR 0027: Keep The Bottom Scroll Cue Inside The Dashboard Scroller

- Status: Accepted
- Date: 2026-09-13

The Dashboard uses a conditional bottom blur to indicate remaining downward
travel, including trailing space. Its footer owns that space and an observed
end marker, keeping visibility tied to the actual end as masonry content grows
without a scroll listener. The sticky blur stays inside the scroller's stacking
context so expanded Page Chips can paint above it; a sibling overlay outside
that context would also blur the expanded titles. Scroll padding reserves
clearance for keyboard-selected results without adding a second scrolling
controller. The empty spacer is invisible so its movement as content arrives
does not contribute to startup layout shift; intersection observation still
uses its end marker's geometry.

Activation History has no sticky header, so it uses the same treatment at both
edges. Its custom scrollbar already observes content and viewport resizing and
reads the scroll position; the cues reuse those measurements and their deferred
first-paint scheduling instead of adding another observer or scroll listener.
The history scroller extends across the dashboard to accommodate expanded
titles. Its cues therefore sit within the history panel's bounds, in the same
stacking context as expanded titles and the custom scrollbar, below both. This
keeps the wide expansion area clear. Scroll padding reserves clearance at both
edges without changing the content's existing padding or scroll range.
