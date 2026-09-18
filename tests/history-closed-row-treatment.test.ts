import assert from 'node:assert/strict'
import test from 'node:test'

import { makeHistoryEntry, renderHistoryPanel } from './helpers/history-panel.js'

function titleSpanClass(html: string): string {
  const match = html.match(/class="(history-entry-title [^"]*)"/)
  assert.ok(match, 'history entry title should render')
  const classes = match[1]
  assert.ok(classes)
  return classes
}

test('a closed history row mutes its title like a closed saved page chip', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ exists: false, tabId: -1 })])
  assert.match(html, /history-entry-closed/)
  assert.match(titleSpanClass(html), /\btext-tab-closed\b/)
  assert.doesNotMatch(titleSpanClass(html), /\btext-tab-live\b/)
})

test('a closed history row hovers with the closed-saved chip treatment', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ exists: false, tabId: -1 })])
  const rowMatch = html.match(/class="([^"]*\bhistory-entry-closed\b[^"]*)"/)
  assert.ok(rowMatch)
  const rowClasses = rowMatch[1]
  assert.ok(rowClasses)
  assert.match(rowClasses, /hover:outline\b/)
})

test('a live history row keeps its live-tab title and no closed treatment', () => {
  const html = renderHistoryPanel([makeHistoryEntry()])
  assert.doesNotMatch(html, /history-entry-closed/)
  assert.match(titleSpanClass(html), /\btext-tab-live\b/)
})

test('a never-activated background history row uses the existing index UI without a new badge', () => {
  const html = renderHistoryPanel([
    makeHistoryEntry({ current: true }),
    makeHistoryEntry({
      index: 1,
      tabId: 102,
      pending: true,
      createdAt: 2000,
      title: 'Background Docs',
      url: 'https://example.com/background',
      rawUrl: 'https://example.com/background',
      displayUrl: 'example.com/background',
    }),
  ])

  assert.match(html, /data-pending="true"/)
  assert.match(html, /<span>\+<\/span><span>1<\/span>/)
  assert.doesNotMatch(html, />New</)
})

test('history entries never render Cursor, Pending, or Pinned title badges', () => {
  const html = renderHistoryPanel([
    makeHistoryEntry({ cursor: true, current: false, pinned: true }),
    makeHistoryEntry({
      index: 1,
      tabId: 102,
      cursor: false,
      current: true,
      pinned: true,
      title: 'Current notes',
      url: 'https://example.com/current',
      rawUrl: 'https://example.com/current',
      displayUrl: 'example.com/current',
    }),
  ], { activeWasInserted: true })

  assert.doesNotMatch(html, />Cursor<\/span>/)
  assert.doesNotMatch(html, />Pending<\/span>/)
  assert.doesNotMatch(html, />Pinned<\/span>/)
})

test('an open history row hovers with the closed line recipe at the quiet interaction-fill color', () => {
  const html = renderHistoryPanel([makeHistoryEntry()])
  const rowMatch = html.match(/class="(history-entry group\/history-entry[^"]*)"/)
  assert.ok(rowMatch, 'history entry surface should render')
  const rowClasses = rowMatch[1]
  assert.ok(rowClasses)
  assert.match(rowClasses, /hover:outline\b/)
  assert.match(rowClasses, /hover:outline-\(--history-entry-hover-border\)/)
  // The interaction-fill rim: same 10% mix as the open rows' clickable fill, laid
  // once more at the edge — the darkened fill carries the hover emphasis.
  assert.match(html, /--history-entry-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 10%, transparent\)/)
})

test('a row active in another window strengthens its permanent frame on interaction like a Page Chip', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ activeInOtherWindow: true })])
  const rowMatch = html.match(/class="(history-entry group\/history-entry[^"]*)"/)
  assert.ok(rowMatch, 'history entry surface should render')
  const rowClasses = rowMatch[1]
  assert.ok(rowClasses)
  assert.doesNotMatch(rowClasses, /hover:outline-\(--history-entry-hover-border\)/)
  assert.match(html, /active-history-entry-frame\b[^"]*shadow-\[inset_0_0_0_1px_rgba\(115,115,115,0\.2\)\]/)
  assert.match(html, /group-hover\/history-entry:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
  assert.match(html, /group-\[\.history-entry-expanded-open\]\/history-entry:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
  assert.match(html, /group-data-context-menu-open\/history-entry:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
})

test('a closed history row keeps the stronger closed line color', () => {
  // Closed rows barely darken their fill on hover, so the line carries
  // their signal at 22% — not the open rows' quiet 10% rim.
  const html = renderHistoryPanel([makeHistoryEntry({ exists: false, tabId: -1 })])
  assert.match(html, /--history-entry-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 22%, transparent\)/)
  assert.doesNotMatch(html, /--history-entry-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 10%, transparent\)/)
})

test('a suspended open row dims only the favicon, not the title', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ suspended: true })])
  assert.doesNotMatch(html, /history-entry-closed/)
  assert.match(html, /chip-favicon-dimmed/)
  assert.match(titleSpanClass(html), /\btext-tab-live\b/)
})
