import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addSavedPageToStore,
  annotateSavedPageHints,
  emptySavedPagesStore,
  isSavedPageEligible,
  mergeSavedPagesWithTabs,
  normalizeSavedPagesStore,
  removeSavedPageFromStore,
  restoreSavedPageToStore,
  savedPageKeyForUrl,
  savedPageKeysFromStore,
  savedPagesStoresEqual
} from '../src/extension/saved-pages.js'
import { parseSavedPagesStoreValue } from '../src/extension/saved-pages-storage.js'
import type { DashboardTab } from '../src/extension/types'

function makeTab(overrides: Partial<DashboardTab> & { url: string }): DashboardTab {
  return {
    id: 1,
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    title: overrides.title || '',
    favIconUrl: overrides.favIconUrl || '',
    windowId: overrides.windowId || 1,
    active: overrides.active || false,
    pinned: overrides.pinned || false,
    groupId: overrides.groupId ?? -1,
    isTabOut: false,
    isApp: false,
    ...overrides
  }
}

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

test('savedPageKeyForUrl preserves meaningful query and hash in the saved page identity', () => {
  assert.equal(
    savedPageKeyForUrl('https://example.test/docs?panel=reviews#comment-7'),
    'https://example.test/docs?panel=reviews#comment-7'
  )
})

test('Saved Page identity distinguishes the same exact URL by surface kind', () => {
  const url = 'https://example.test/docs?panel=reviews#comment-7'

  assert.notEqual(
    savedPageKeyForUrl(url, 'normal-tab'),
    savedPageKeyForUrl(url, 'app')
  )
})

test('isSavedPageEligible includes privileged pages and apps but excludes Tab Out itself', () => {
  assert.equal(isSavedPageEligible({ url: 'https://example.test/docs' }), true)
  assert.equal(isSavedPageEligible({ url: 'chrome://settings/' }), true)
  assert.equal(isSavedPageEligible({ url: 'chrome-extension://other-extension/index.html' }), true)
  assert.equal(isSavedPageEligible({ url: 'chrome-untrusted://new-tab-page/' }), false)
  assert.equal(isSavedPageEligible({ url: 'https://mail.example.test/', isApp: true }), true)
  assert.equal(isSavedPageEligible({ url: 'chrome-extension://tab-out/index.html', isTabOut: true }), false)
  assert.equal(isSavedPageEligible({ url: 'chrome://newtab/' }), false)
  assert.equal(isSavedPageEligible({ url: 'about:blank' }), false)
  assert.equal(isSavedPageEligible({ url: 'data:text/plain,temporary' }), false)
  assert.equal(isSavedPageEligible({ url: 'chrome://newtab/', isTabOut: true }), false)
})

test('isSavedPageEligible excludes every page on the current Tab Out extension origin', () => {
  assert.equal(
    isSavedPageEligible({ url: 'chrome-extension://tab-out/help.html' }, 'tab-out'),
    false
  )
  assert.equal(
    isSavedPageEligible({ url: 'chrome-extension://other-extension/help.html' }, 'tab-out'),
    true
  )
})

test('normalizeSavedPagesStore keeps valid v2 records and drops identity mismatches', () => {
  const normalized = normalizeSavedPagesStore({
    version: 2,
    pages: {
      'https://example.test/docs': {
        key: 'https://example.test/docs',
        surfaceKind: 'normal-tab',
        url: 'https://example.test/docs',
        title: 'Docs',
        favIconUrl: 'https://example.test/favicon.ico',
        savedAt: 10,
        updatedAt: 11
      },
      invalid: {
        key: 'invalid',
        surfaceKind: 'normal-tab',
        url: 'chrome://settings/',
        title: 'Settings',
        savedAt: 12,
        updatedAt: 13
      }
    }
  })

  assert.deepEqual(Object.keys(normalized.pages), ['https://example.test/docs'])
  const normalizedPage = normalized.pages['https://example.test/docs']
  assert.ok(normalizedPage)
  assert.equal(normalizedPage.url, 'https://example.test/docs')
})

test('Saved Pages storage migrates v1 URL-only records to v2 normal-tab records', () => {
  const parsed = parseSavedPagesStoreValue({
    version: 1,
    pages: {
      'https://example.test/docs': {
        key: 'https://example.test/docs',
        url: 'https://example.test/docs',
        title: 'Docs',
        savedAt: 10,
        updatedAt: 11
      },
      malformed: 'not-a-record'
    }
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.version, 2)
  assert.deepEqual(Object.keys(parsed.value.pages), ['https://example.test/docs'])
  assert.equal(parsed.value.pages['https://example.test/docs']?.surfaceKind, 'normal-tab')
})

test('saving the same exact URL as a normal tab and app preserves both targets', () => {
  const url = 'https://app.example.test/inbox'
  const normalTab = makeTab({ url, title: 'Inbox tab' })
  const app = makeTab({ url, title: 'Inbox app', isApp: true })

  const store = addSavedPageToStore(
    addSavedPageToStore(emptySavedPagesStore(), normalTab, 100),
    app,
    200
  )

  assert.deepEqual(Object.keys(store.pages).sort(), [
    savedPageKeyForUrl(url, 'app'),
    savedPageKeyForUrl(url, 'normal-tab')
  ].sort())
  assert.equal(store.pages[savedPageKeyForUrl(url, 'normal-tab')]?.title, 'Inbox tab')
  assert.equal(store.pages[savedPageKeyForUrl(url, 'app')]?.title, 'Inbox app')

  const parsed = parseSavedPagesStoreValue(structuredClone(store))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.pages[savedPageKeyForUrl(url, 'app')]?.surfaceKind, 'app')

  const merged = mergeSavedPagesWithTabs([normalTab], store)
  const mergedNormalTab = merged.tabs.find((tab) => !tab.isApp)
  const closedApp = merged.tabs.find((tab) => tab.isApp)
  assert.equal(mergedNormalTab?.saved, true)
  assert.equal(mergedNormalTab?.closedSaved, false)
  assert.equal(closedApp?.sourceType, 'saved-page')
  assert.equal(closedApp?.closedSaved, true)

  const removedApp = removeSavedPageFromStore(store, savedPageKeyForUrl(url, 'app'))
  assert.equal(removedApp.removed?.surfaceKind, 'app')
  assert.ok(removedApp.store.pages[savedPageKeyForUrl(url, 'normal-tab')])
  assert.equal(removedApp.store.pages[savedPageKeyForUrl(url, 'app')], undefined)
})

test('an app Saved Page derives fallback copy from its exact URL rather than its qualified key', () => {
  const url = 'https://app.example.test/inbox'
  const store = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url, title: '', isApp: true }),
    100
  )

  assert.equal(store.pages[savedPageKeyForUrl(url, 'app')]?.title, 'app.example.test/inbox')
})

test('mergeSavedPagesWithTabs annotates matching open tabs and emits closed saved page items', () => {
  const savedStore = addSavedPageToStore(
    addSavedPageToStore(emptySavedPagesStore(), makeTab({ url: 'https://example.test/open', title: 'Old open title', favIconUrl: 'old-open.ico' }), 100),
    makeTab({ url: 'https://example.test/closed?panel=reviews#comment-7', title: 'Closed reference', favIconUrl: 'closed.ico' }),
    200
  )

  const { tabs, store } = mergeSavedPagesWithTabs(
    [
      makeTab({ url: 'https://example.test/open', title: 'Fresh open title', favIconUrl: 'fresh-open.ico' }),
      makeTab({ id: 2, url: 'https://example.test/unsaved', title: 'Unsaved' })
    ],
    savedStore,
    300
  )

  const open = tabs.find((tab) => tab.url === 'https://example.test/open')
  const closed = tabs.find((tab) => tab.url === 'https://example.test/closed?panel=reviews#comment-7')
  assert.equal(open?.sourceType, undefined)
  assert.equal(open?.saved, true)
  assert.equal(open?.closedSaved, false)
  assert.equal(open?.savedPageKey, 'https://example.test/open')
  assert.equal(closed?.sourceType, 'saved-page')
  assert.equal(closed?.saved, true)
  assert.equal(closed?.closedSaved, true)
  assert.equal(closed?.title, 'Closed reference')
  const storedOpenPage = store.pages['https://example.test/open']
  assert.ok(storedOpenPage)
  assert.equal(storedOpenPage.title, 'Fresh open title')
  assert.equal(storedOpenPage.favIconUrl, 'fresh-open.ico')
  assert.equal(storedOpenPage.lastSeenOpenAt, 300)
})

test('mergeSavedPagesWithTabs does not rewrite unchanged open saved page metadata', () => {
  const savedStore = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url: 'https://example.test/open', title: 'Open reference', favIconUrl: 'open.ico' }),
    100
  )

  const { tabs, store } = mergeSavedPagesWithTabs(
    [makeTab({ url: 'https://example.test/open', title: 'Open reference', favIconUrl: 'open.ico' })],
    savedStore,
    300
  )

  assert.equal(valueAt(tabs, 0).saved, true)
  assert.equal(savedPagesStoresEqual(savedStore, store), true)
  const storedOpenPage = store.pages['https://example.test/open']
  assert.ok(storedOpenPage)
  assert.equal(storedOpenPage.lastSeenOpenAt, 100)
})

test('mergeSavedPagesWithTabs does not emit timestamp-only updates for mixed duplicate favicons', () => {
  const url = 'https://example.test/open'
  const savedStore = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url, title: 'Open reference', favIconUrl: 'page.ico' }),
    100
  )

  const { tabs, store } = mergeSavedPagesWithTabs(
    [
      makeTab({ id: 1, url, title: 'Open reference', favIconUrl: 'suspender.ico', suspended: true, status: 'unloaded' }),
      makeTab({ id: 2, url, title: 'Open reference', favIconUrl: 'suspender.ico', suspended: true, status: 'unloaded' }),
      makeTab({ id: 3, url, title: 'Open reference', favIconUrl: 'page.ico', status: 'complete' })
    ],
    savedStore,
    300
  )

  assert.equal(tabs.every((tab) => tab.saved), true)
  assert.equal(savedPagesStoresEqual(savedStore, store), true)
  const storedOpenPage = store.pages[url]
  assert.ok(storedOpenPage)
  assert.equal(storedOpenPage.updatedAt, 100)
  assert.equal(storedOpenPage.lastSeenOpenAt, 100)
})

test('mergeSavedPagesWithTabs retains the saved title while its matching open tab is loading', () => {
  const savedStore = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url: 'https://example.test/open', title: 'Full saved title', favIconUrl: 'old.ico' }),
    100
  )

  const { tabs, store } = mergeSavedPagesWithTabs(
    [makeTab({
      url: 'https://example.test/open',
      title: 'Example',
      status: 'loading',
      favIconUrl: 'fresh.ico'
    })],
    savedStore,
    300
  )

  assert.equal(valueAt(tabs, 0).title, 'Full saved title')
  const storedOpenPage = store.pages['https://example.test/open']
  assert.ok(storedOpenPage)
  assert.equal(storedOpenPage.title, 'Full saved title')
  assert.equal(storedOpenPage.favIconUrl, 'fresh.ico')
})

test('annotateSavedPageHints marks matching bookmark items without adding closed saved rows', () => {
  const savedStore = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url: 'https://example.test/saved', title: 'Saved reference', favIconUrl: 'saved.ico' }),
    100
  )
  const matchingBookmark = makeTab({ id: 'bookmark-1', sourceType: 'bookmark', url: 'https://example.test/saved', title: 'Saved bookmark' })
  const otherBookmark = makeTab({ id: 'bookmark-2', sourceType: 'bookmark', url: 'https://example.test/other', title: 'Other bookmark' })

  const annotated = annotateSavedPageHints([matchingBookmark, otherBookmark], savedStore)

  assert.equal(annotated.length, 2)
  const annotatedMatch = valueAt(annotated, 0)
  assert.equal(annotatedMatch.sourceType, 'bookmark')
  assert.equal(annotatedMatch.saved, true)
  assert.equal(annotatedMatch.closedSaved, false)
  assert.equal(annotatedMatch.savedPageKey, 'https://example.test/saved')
  assert.equal(valueAt(annotated, 1), otherBookmark)
})

test('savedPageKeysFromStore returns the normalized keys of every saved page', () => {
  const one = addSavedPageToStore(emptySavedPagesStore(), {
    url: 'https://a.test/', rawUrl: 'https://a.test/', title: 'A', favIconUrl: '', isTabOut: false, isApp: false
  })
  const two = addSavedPageToStore(one, {
    url: 'https://b.test/', rawUrl: 'https://b.test/', title: 'B', favIconUrl: '', isTabOut: false, isApp: false
  })
  assert.deepEqual(savedPageKeysFromStore(two).sort(), ['https://a.test/', 'https://b.test/'])
})

test('savedPageKeysFromStore returns [] for a nullish store', () => {
  assert.deepEqual(savedPageKeysFromStore(null), [])
})

test('Saved Page Undo does not overwrite a newer re-save of the same URL', () => {
  const original = addSavedPageToStore(
    emptySavedPagesStore(),
    makeTab({ url: 'https://example.test/article', title: 'Original title' }),
    100
  )
  const { store: removedStore, removed } = removeSavedPageFromStore(original, 'https://example.test/article')
  const resaved = addSavedPageToStore(
    removedStore,
    makeTab({ url: 'https://example.test/article', title: 'New title' }),
    200
  )

  const afterUndo = restoreSavedPageToStore(resaved, removed)

  assert.equal(afterUndo.pages['https://example.test/article']?.title, 'New title')
  assert.equal(afterUndo.pages['https://example.test/article']?.savedAt, 200)
})
