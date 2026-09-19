import assert from 'node:assert/strict'
import test from 'node:test'

import { historyEntryFromWorkingSetItem } from '../src/extension/tab-history.js'
import type { WorkingSetItem } from '../src/extension/types'
import { makeHistoryEntry, renderHistoryPanel } from './helpers/history-panel.js'

test('a live history row keeps its favicon at full strength', () => {
  const html = renderHistoryPanel([makeHistoryEntry()])
  assert.match(html, /history-entry-favicon-frame/)
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a loading live history row replaces its favicon with Chrome’s loading indicator color', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ loading: true })])
  assert.match(html, /data-tabout-part="loading-indicator"/)
  assert.match(html, /style="color:#0b57d0"/)
  assert.match(html, /aria-busy="true"/)
  assert.doesNotMatch(html, /<img/)
})

test('a suspended history row dims its favicon', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ suspended: true })])
  assert.match(html, /chip-favicon-dimmed/)
  assert.doesNotMatch(html, /saturate-/)
})

test('a closed history row dims its favicon', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ exists: false, tabId: -1 })])
  assert.match(html, /chip-favicon-dimmed/)
  assert.match(html, /saturate-60/)
})

test('rows dim independently within one panel', () => {
  const html = renderHistoryPanel([
    makeHistoryEntry({ index: 0, tabId: 101, url: 'https://example.com/a', rawUrl: 'https://example.com/a' }),
    makeHistoryEntry({ index: 1, tabId: 102, cursor: false, url: 'https://example.com/b', rawUrl: 'https://example.com/b', suspended: true }),
  ])
  assert.equal((html.match(/chip-favicon-dimmed/g) || []).length, 1)
})

test('an open-ghost entry derives suspension from the suspender url', () => {
  const item: WorkingSetItem = {
    key: 'real.example/docs',
    tabId: 7,
    windowId: 1,
    tabUrl: 'https://real.example/docs',
    rawUrl: 'chrome-extension://suspenderid/suspended.html#ttl=Docs&uri=https%3A%2F%2Freal.example%2Fdocs',
    title: 'Docs',
    displayUrl: 'real.example/docs',
    faviconUrl: '',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    score: 10,
    lastActivatedAt: 0,
  }
  const entry = historyEntryFromWorkingSetItem(item)
  assert.equal(entry.exists, true)
  assert.equal(entry.suspended, true)
})

test('an open-ghost entry carries its Working Set loading state into history', () => {
  const item: WorkingSetItem = {
    key: 'https://example.test/docs',
    tabId: 8,
    windowId: 1,
    tabUrl: 'https://example.test/docs',
    rawUrl: 'https://example.test/docs',
    title: 'Example Docs',
    displayUrl: 'example.test/docs',
    faviconUrl: 'https://example.test/icon.png',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    loading: true,
    score: 10,
    lastActivatedAt: 0,
  }
  const entry = historyEntryFromWorkingSetItem(item)
  assert.equal(entry.loading, true)

  const html = renderHistoryPanel([], {}, {
    defaultLimit: 8,
    expandedLimit: 16,
    items: [item],
  })
  assert.match(html, /data-working-set-extra="true"/)
  assert.match(html, /data-tabout-part="loading-indicator"/)
  assert.match(html, /aria-busy="true"/)
})
