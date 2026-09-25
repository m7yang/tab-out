import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TabActionsPopup } from '../src/components/TabActionsPopup.js'

test('TabActionsPopup renders the Tab Actions Menu with browser-state-dependent items disabled first', () => {
  const html = renderToStaticMarkup(React.createElement(TabActionsPopup))

  assert.match(html, /data-tabout="tab-actions"/)

  const itemOrder = [
    'dedupe-button',
    'close-suspended-button',
    'close-suspended-and-dedupe-button',
    'move-current-tab-button',
    'merge-desktop-windows-button',
  ]
  const itemIndexes = itemOrder.map((part) => html.indexOf(`data-tabout-part="${part}"`))
  for (const [position, index] of itemIndexes.entries()) {
    assert.ok(index >= 0, `missing popup item ${itemOrder[position]}`)
    if (position > 0) assert.ok(index > (itemIndexes[position - 1] ?? -1), `popup item ${itemOrder[position]} is out of order`)
  }

  const separatorIndex = html.indexOf('role="separator"')
  assert.ok(separatorIndex > (itemIndexes[2] ?? -1))
  assert.ok(separatorIndex < (itemIndexes[3] ?? -1))

  assert.match(html, />Dedupe duplicate tabs</)
  assert.match(html, />Close all suspended tabs</)
  assert.match(html, />Close all suspended tabs<br\s*\/> and dedupe</)
  assert.match(html, />Move current tab to new window</)
  assert.match(html, />Merge windows on this desktop…</)

  function itemOpeningTag(part: string): string {
    const index = html.indexOf(`data-tabout-part="${part}"`)
    const start = html.lastIndexOf('<button', index)
    const end = html.indexOf('>', index)
    return html.slice(start, end + 1)
  }

  // Before the first browser read settles, the count-driven dedupe item and
  // the integration-gated merge item stay disabled; the cleanup items are
  // immediately available.
  assert.match(itemOpeningTag('dedupe-button'), / disabled(?:=|>| )/)
  assert.doesNotMatch(itemOpeningTag('close-suspended-button'), / disabled(?:=|>| )/)
  assert.doesNotMatch(itemOpeningTag('close-suspended-and-dedupe-button'), / disabled(?:=|>| )/)
  assert.doesNotMatch(itemOpeningTag('move-current-tab-button'), / disabled(?:=|>| )/)
  assert.match(itemOpeningTag('merge-desktop-windows-button'), / disabled(?:=|>| )/)
  assert.match(html, /Checking macOS integration…/)
})
