import assert from 'node:assert/strict'
import test from 'node:test'

import {
  historyEntrySaveTarget,
  historyEntrySaved,
  historyEntrySavedPageKey,
  isHistoryEntrySaveEligible
} from '../src/extension/history-saved-page.js'
import { savedPageKeyForUrl } from '../src/extension/saved-pages.js'
import type { RetainedPageRecord, RetainedPageSurfaceKind } from '../src/extension/retained-pages-ledger.js'
import type { TabHistoryEntry } from '../src/extension/types'

function makeEntry(overrides: Partial<TabHistoryEntry> & { url: string }): TabHistoryEntry {
  return {
    index: 0, tabId: 1, windowId: 1, exists: true, active: false, activeInOtherWindow: false,
    isApp: false, pinned: false, discarded: false, suspended: false, cursor: false, current: false,
    previousTarget: false, nextTarget: false,
    title: 'Title', rawUrl: overrides.url, displayUrl: overrides.url,
    favIconUrl: '', lastActivatedAt: null, ...overrides
  }
}

function makeRetainedPage(
  surfaceKind: RetainedPageSurfaceKind,
  url: string,
  canonicalKey = url
): RetainedPageRecord {
  return {
    identityDigest: `${surfaceKind}:${canonicalKey}`,
    surfaceKind,
    canonicalKey,
    url,
    title: 'Retained title',
    closedAt: 1,
    closureToken: `${surfaceKind}-closure`
  }
}

test('historyEntrySaveTarget maps entry fields to the save-page target shape', () => {
  const target = historyEntrySaveTarget(makeEntry({
    url: 'https://x.test/p', rawUrl: 'https://x.test/raw', title: 'X', favIconUrl: 'https://x.test/i.png', isApp: false
  }))
  assert.deepEqual(target, {
    url: 'https://x.test/p', rawUrl: 'https://x.test/raw', title: 'X', favIconUrl: 'https://x.test/i.png', isTabOut: false, isApp: false
  })
})

test('historyEntrySaveTarget chooses app only from an unambiguous retained app match', () => {
  const url = 'https://app.test/workspace'
  const entry = makeEntry({ url, isApp: false })

  assert.equal(historyEntrySaveTarget(entry, [makeRetainedPage('app', url)]).isApp, true)
  assert.equal(historyEntrySaveTarget(entry, [makeRetainedPage('normal-tab', url)]).isApp, false)
  assert.equal(historyEntrySaveTarget(entry, [
    makeRetainedPage('app', url),
    makeRetainedPage('normal-tab', url)
  ]).isApp, false)
})

test('historyEntrySaveTarget falls back to normal-tab without matching retained state', () => {
  const url = 'https://app.test/workspace'
  const entry = makeEntry({ url, isApp: true })

  assert.equal(historyEntrySaveTarget(entry).isApp, false)
  assert.equal(
    historyEntrySaveTarget(entry, [makeRetainedPage('app', 'https://other.test/workspace')]).isApp,
    false
  )
})

test('historyEntrySaveTarget marks Tab Out new-tab state as ineligible at the action boundary', () => {
  assert.equal(historyEntrySaveTarget(makeEntry({ url: 'chrome://newtab/' })).isTabOut, true)
})

test('isHistoryEntrySaveEligible includes privileged and http(s) targets', () => {
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'chrome://extensions' })), true)
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'https://ok.test/' })), true)
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'chrome://newtab/' })), false)
})

test('isHistoryEntrySaveEligible includes URLs from app rows through normal-tab fallback', () => {
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'https://app.test/', isApp: true })), true)
})

test('historyEntrySaved matches by normalized saved key', () => {
  const saved = new Set(['https://ok.test/'])
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://ok.test/' }), saved), true)
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://nope.test/' }), saved), false)
  assert.equal(historyEntrySaved(makeEntry({ url: 'chrome://x' }), saved), false)
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://ok.test/' }), null), false)
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://ok.test/' }), undefined), false)
})

test('historyEntrySaved matches app state independently from the same normal-tab URL', () => {
  const url = 'https://app.test/'
  const normalSaved = new Set([savedPageKeyForUrl(url, 'normal-tab')])
  const appSaved = new Set([savedPageKeyForUrl(url, 'app')])
  const retainedPages = [makeRetainedPage('app', url)]

  assert.equal(historyEntrySaved(makeEntry({ url, isApp: true }), normalSaved, retainedPages), false)
  assert.equal(historyEntrySaved(makeEntry({ url, isApp: true }), appSaved, retainedPages), true)
  assert.equal(historyEntrySaved(makeEntry({ url, isApp: true }), normalSaved), true)
})

test('historyEntrySavedPageKey returns the exact surface-qualified removal target', () => {
  const url = 'https://app.test/'

  assert.equal(
    historyEntrySavedPageKey(makeEntry({ url })),
    savedPageKeyForUrl(url, 'normal-tab')
  )
  assert.equal(
    historyEntrySavedPageKey(makeEntry({ url, isApp: true }), [makeRetainedPage('app', url)]),
    savedPageKeyForUrl(url, 'app')
  )
})
