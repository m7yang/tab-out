import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { HistoryEntry, historyEntryIndexLabel } from '../src/components/history-entry/index.js'
import { makeHistoryEntry } from './helpers/history-panel.js'

test('HistoryEntry renders standalone through the module interface', () => {
  const entry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(HistoryEntry, {
      entry,
      indexLabel: historyEntryIndexLabel(entry, null, entry.index + 1),
      kind: 'stack',
      layoutKey: 'row-0',
      savedKeys: new Set<string>(),
    }),
  )

  assert.match(html, /history-entry-title/)
  assert.match(html, /Example Docs/)
})

test('HistoryEntry renders a closed ghost without a live-tab affordance', () => {
  const entry = makeHistoryEntry({ exists: false, tabId: -1 })
  const html = renderToStaticMarkup(
    React.createElement(HistoryEntry, {
      entry,
      indexLabel: null,
      kind: 'closed-ghost',
      layoutKey: 'ghost-0',
      savedKeys: new Set<string>(),
    }),
  )

  assert.match(html, /history-entry-title/)
  assert.match(html, /Example Docs/)
})
