import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addSavedPageToStore,
  emptySavedPagesStore
} from '../src/extension/saved-pages.js'
import { projectTabsPageSources } from '../src/extension/tabs-page-projection.js'
import { makeDashboardItem } from '../src/extension/dashboard-item.js'
import type { RetainedPageRecord } from '../src/extension/retained-pages-ledger.js'
import { RETAINED_PAGE_LIFETIME_MS } from '../src/extension/retained-pages-ledger.js'

const PROJECTION_NOW = 10_000

function retained(overrides: Partial<RetainedPageRecord> = {}): RetainedPageRecord {
  return {
    identityDigest: 'identity-example',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/article',
    url: 'https://example.test/article',
    title: 'Example article',
    closedAt: 1_000,
    closureToken: 'lifetime-example',
    ...overrides
  }
}

test('Tabs projection presents an unmatched Retained Page as the existing closed chip shape', () => {
  const result = projectTabsPageSources([], emptySavedPagesStore(), [retained()], PROJECTION_NOW)

  assert.equal(result.tabs.length, 1)
  assert.deepEqual(result.tabs[0], makeDashboardItem({
    id: 'retained:identity-example:lifetime-example',
    url: 'https://example.test/article',
    rawUrl: 'https://example.test/article',
    title: 'Example article',
    windowId: 0,
    sourceType: 'retained-page',
    closedSaved: true,
    retainedPageIdentity: 'identity-example',
    retainedPageClosureToken: 'lifetime-example'
  }))
})

test('matching live or Saved state owns the visible Page Chip while retention remains hidden', () => {
  const open = makeDashboardItem({
    id: 1,
    url: 'https://example.test/article',
    title: 'Live article',
    windowId: 1,
    sourceType: 'tab'
  })
  const withLive = projectTabsPageSources(
    [open],
    emptySavedPagesStore(),
    [retained()],
    PROJECTION_NOW
  )
  assert.deepEqual(withLive.tabs.map((tab) => tab.id), [1])

  const savedStore = addSavedPageToStore(emptySavedPagesStore(), {
    url: 'https://example.test/article',
    rawUrl: 'https://example.test/article',
    title: 'Saved article',
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 2_000)
  const withSaved = projectTabsPageSources([], savedStore, [retained()], PROJECTION_NOW)
  assert.equal(withSaved.tabs.length, 1)
  assert.equal(withSaved.tabs[0]?.sourceType, 'saved-page')
  assert.equal(withSaved.tabs[0]?.saved, true)
  assert.equal(withSaved.tabs[0]?.url, 'https://example.test/article')
})

test('a live internal page hides matching Saved and retained state outside dashboard presentation', () => {
  const internal = makeDashboardItem({
    id: 2,
    url: 'chrome://settings/privacy',
    title: 'Settings',
    windowId: 1,
    sourceType: 'tab'
  })
  const savedStore = addSavedPageToStore(emptySavedPagesStore(), {
    url: internal.url,
    rawUrl: internal.rawUrl,
    title: internal.title,
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 2_000)
  const result = projectTabsPageSources(
    [],
    savedStore,
    [retained({
      canonicalKey: 'chrome://settings/privacy',
      url: 'chrome://settings/privacy'
    })],
    PROJECTION_NOW,
    [internal]
  )

  assert.deepEqual(result.tabs, [])
  assert.ok(result.store.pages['chrome://settings/privacy'])
})

test('Tabs projection never flashes a retained snapshot at or after its expiry boundary', () => {
  const now = 5_000 + RETAINED_PAGE_LIFETIME_MS

  const beforeExpiry = projectTabsPageSources(
    [],
    emptySavedPagesStore(),
    [retained({ closedAt: 5_001 })],
    now
  )
  const atExpiry = projectTabsPageSources(
    [],
    emptySavedPagesStore(),
    [retained({ closedAt: 5_000 })],
    now
  )

  assert.equal(beforeExpiry.tabs.length, 1)
  assert.equal(atExpiry.tabs.length, 0)
})

test('surface qualification prevents a normal retained page from merging into an app Saved Page', () => {
  const savedStore = addSavedPageToStore(emptySavedPagesStore(), {
    url: 'https://example.test/article',
    rawUrl: 'https://example.test/article',
    title: 'Saved app',
    favIconUrl: '',
    isTabOut: false,
    isApp: true
  }, 2_000)
  const result = projectTabsPageSources([], savedStore, [retained()], PROJECTION_NOW)

  assert.equal(result.tabs.length, 2)
  assert.deepEqual(result.tabs.map((tab) => tab.sourceType).sort(), [
    'retained-page',
    'saved-page'
  ])
})

test('multiple exact Saved targets survive canonical coordination while the retained fallback stays hidden', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const shortForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  const canonicalKey =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  let savedStore = addSavedPageToStore(emptySavedPagesStore(), {
    url: longForm,
    rawUrl: longForm,
    title: 'Example issue from mention',
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 2_000)
  savedStore = addSavedPageToStore(savedStore, {
    url: shortForm,
    rawUrl: shortForm,
    title: 'Example issue',
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 3_000)

  const result = projectTabsPageSources([], savedStore, [retained({
    canonicalKey,
    url: longForm
  })], PROJECTION_NOW)

  assert.deepEqual(
    result.tabs.map((tab) => ({
      savedPageKey: tab.savedPageKey,
      sourceType: tab.sourceType,
      url: tab.url
    })).toSorted((left, right) => left.url.localeCompare(right.url)),
    [
      { savedPageKey: longForm, sourceType: 'saved-page', url: longForm },
      { savedPageKey: shortForm, sourceType: 'saved-page', url: shortForm }
    ].toSorted((left, right) => left.url.localeCompare(right.url))
  )
})
