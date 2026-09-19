# Debugging the dashboard locally

The dashboard is a Chrome extension page, but you can run and debug it in a
plain browser with **fake tab data** — no extension reload loop, no real Chrome
APIs. This is the fastest way to inspect intricate UI such as page-chip hover
expansion.

## Run it

```sh
pnpm build      # build extension/dist (the fixture loads the built bundle)
pnpm serve      # static server on http://127.0.0.1:8765 (override with PORT=…)
```

Then open:

```
http://127.0.0.1:8765/tests/fixtures/dashboard-resize.html
```

`tests/fixtures/dashboard-resize.html` mocks `window.chrome` with a fixed set of
fake tabs — including single-line `… - JIRA` chips, suppression-marker chips, and
folded / title-variant groups — and loads `extension/dist/app.js`. Rebuild
(`pnpm build`) after editing `src/`; the fixture always loads the built `dist`.

## Measure, don't guess

The Domain Card Page Chip title expansion-width logic in `src/components/PageChip.tsx`
(`getPageChipExpansionGeometry`, `getExpandedPageChipContentWidth`) is intricate.
Reason about it by **measuring the live DOM**, not by eye:

- Hover a `.page-chip`, then read its `getBoundingClientRect()` and the
  `--page-chip-expanded-width` custom property to see how far it actually grew.
- Compare against the chip's resting width and the content's one-line natural
  width to decide whether a given expansion is correct.

Driving the page with an automation browser (Playwright, Chrome DevTools MCP,
etc.) lets you hover and measure programmatically instead of guessing at the
layout math.

## Automated version

`tests/browser/dashboard-smoke.spec.ts` (run with `pnpm test:browser:smoke`) is the
automated form of the same idea: Playwright serves the repo, loads the fixture
in headless Chrome, and asserts on layout / expansion behavior.

## Inspecting Domain Card Page Chip title expansion

Truncated Domain Card Page Chip titles expand in place as `.page-chip-expanded`; they do
not open a tooltip popup. Small auxiliary controls can still use
`[data-slot="tooltip-content"]`. When a real-extension result differs from the
fixture, hover the affected Domain Card Page Chip and run this geometry-only probe in the
Tab Out console. It intentionally omits title and URL data so the output can be
shared safely:

```js
(() => {
  const chip = document.querySelector('.page-chip-expanded')
  const text = chip?.querySelector('.chip-text')
  if (!(chip instanceof HTMLElement) || !(text instanceof HTMLElement)) {
    return null
  }

  const chipRect = chip.getBoundingClientRect()
  const textRect = text.getBoundingClientRect()
  const range = document.createRange()
  range.selectNodeContents(text)
  const paintedRect = range.getBoundingClientRect()
  const lines = [...text.querySelectorAll('.page-chip-expanded-line')]

  return {
    chip: { width: chipRect.width, height: chipRect.height, right: chipRect.right },
    text: {
      width: textRect.width,
      height: textRect.height,
      clientWidth: text.clientWidth,
      scrollWidth: text.scrollWidth,
      clientHeight: text.clientHeight,
      scrollHeight: text.scrollHeight
    },
    painted: {
      right: paintedRect.right,
      bottom: paintedRect.bottom,
      fitsRight: paintedRect.right <= chipRect.right + 1,
      fitsBottom: paintedRect.bottom <= chipRect.bottom + 1
    },
    lines: lines.map((line) => ({
      clientWidth: line.clientWidth,
      scrollWidth: line.scrollWidth,
      overflows: line.scrollWidth > line.clientWidth + 1
    })),
    visiblePopupTooltips: [...document.querySelectorAll('[data-slot="tooltip-content"]')]
      .filter((popup) => popup.getClientRects().length > 0).length
  }
})()
```

Measure the expanded element itself, not its resting slot. If the issue depends
on live tab state or extension focus, reproduce it on the real extension page;
the fixture proves layout only.

## Visualizing re-renders (react-scan)

To *see* which components render on a hover or a filter keystroke (e.g. to
check the stable-seams contract in `App.tsx`, or to decide whether the
per-chip hover fan-out is worth a `useSyncExternalStore` store), run
[react-scan](https://github.com/aidenybai/react-scan) against the served
fixture — its CLI instruments the page before React loads, which the real
`chrome-extension://` page's CSP does not allow:

```sh
pnpm serve
npx react-scan@latest http://127.0.0.1:8765/tests/fixtures/dashboard-resize.html
```

Hover chips and type in the filter; render flashes and counts show up live.
Expected after the compiler-coverage wave: a hover re-renders the chips and
the history panel (they consume `HoverStateContext` by design) but not
`DomainCard`, `HeaderBar`, or the missions plumbing. A filter keystroke rebuilds
the filter-dependent view models immediately. The bookmark tree starts loading
on the first non-empty keystroke, while History candidate reads remain coalesced
for 200 ms. No dependency needed — the fixture page is plain http.

## Debugging startup order / CLS

Startup layout shifts — chips or Website Path sections re-sorting between the
cached first paint and live hydration — are hard to see by eye. Tab Out ships an
opt-in capture for this, plus a tight reload-diff loop you can drive over CDP /
Chrome DevTools MCP against the **real** extension page. The fake-data fixture
above can't reproduce the cache → hydration transition, so use a real Tab Out
tab here.

### Enable the capture

In the Tab Out page console, *before* reloading:

```js
localStorage.setItem('tab-out:debug-startup-order', '1')
// Optional: focus on specific cards by case-insensitive RegExp (domain/title
// fragment). Unset captures every card.
localStorage.setItem('tab-out:debug-startup-order-filter', 'example\\.com')
```

(`?taboutStartupOrderDebug` in the URL works too.) Reload; the capture downloads
itself after roughly 3 seconds. You can still read or save it manually:

```js
window.__tabOutStartupOrderDebug        // { timings: [...], samples: [...], shifts: [...] }
window.__tabOutSaveStartupOrderDebug()  // download it as JSON
window.__tabOutCopyStartupOrderDebug()  // copy it to the clipboard
```

`timings` records the startup phase sequence (`startup-cache-loaded`,
`local-state-ready`, `first-dashboard-layout`, and live hydration marks) with
`durationMs` on async storage reads. Each `vm` sample records the rendered
card/section/chip order for one render; each `dom` sample records card order and
Activation History row order. `shifts` records `layout-shift` PerformanceObserver
entries (global, not filtered). The first `vm` sample is the cached first paint;
later ones are live hydration and refreshes. Disable with
`localStorage.removeItem('tab-out:debug-startup-order')`.

### The reload-diff loop

Diff the **first** `vm` sample (cached first paint) against the **last**
(post-hydration): the visible chip order per Website Path section should be
identical, and `shifts` inside the startup window should be empty.

- **Bring the tab to the foreground first.** Startup hydration short-circuits on
  `document.visibilityState !== 'visible'`, so a backgrounded reload never hydrates
  and the diff is meaningless. Over CDP, `Page.bringToFront` before reloading.
- Reload, wait for hydration (a second `vm` sample), then compare.

Invariants the dashboard guarantees today (see the startup contract in `AGENTS.md`):

- First paint reuses any structurally valid same-session cached snapshot regardless
  of age, so reopens never flash empty → populated.
- During the startup Working Set priority freeze the tabs chip order is held
  (remembered chip-order memory is ignored), so hydration cannot re-sort the visible
  chip window. The order resumes from memory once a filter/source change lifts the freeze.
