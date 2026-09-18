import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkingSetSnapshot,
  emptyWorkingSetActivity,
  normalizeWorkingSetActivity,
  pageIdentityForWorkingSet,
  parseWorkingSetActivityStorageValue,
  recordWorkingSetActivityMutation,
  recordWorkingSetActivity,
} from '../src/extension/working-set.js'
import type { DashboardTab, WorkingSetActivityStore } from '../src/extension/types'

function makeTab(overrides: Partial<DashboardTab> & { id: number, url: string, title: string }): DashboardTab {
  return {
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...overrides,
  }
}

function record(store: WorkingSetActivityStore, tab: DashboardTab, kind: 'activation' | 'navigation', at: number) {
  return recordWorkingSetActivity(store, {
    kind,
    at,
    tab,
  })
}

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

test('pageIdentityForWorkingSet distinguishes meaningful paths and ignores noisy fragments', () => {
  assert.equal(
    pageIdentityForWorkingSet('https://example.com/issues/123?utm_source=mail#comments'),
    'https://example.com/issues/123',
  )
  assert.equal(
    pageIdentityForWorkingSet('https://example.com/issues/456'),
    'https://example.com/issues/456',
  )
  assert.equal(
    pageIdentityForWorkingSet('https://EXAMPLE.com/issues/?z=last&UTM_campaign=mail&a=first&ref=feed#details'),
    'https://example.com/issues?a=first&z=last',
  )
  assert.equal(
    pageIdentityForWorkingSet('file:///Users/example/notes/?z=last&a=first#details'),
    'file:///Users/example/notes/?a=first&z=last',
  )
  assert.equal(pageIdentityForWorkingSet('chrome-extension://tab-out/index.html'), '')
  assert.equal(pageIdentityForWorkingSet('chrome-search://local-ntp/local-ntp.html'), '')
  assert.equal(pageIdentityForWorkingSet('chrome-untrusted://new-tab-page/'), '')
  assert.equal(pageIdentityForWorkingSet('https://www.google.com/search?q=example'), '')
})

test('Working Set schema repairs valid records independently from malformed events', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const key = 'https://example.test/docs'
  const normalized = normalizeWorkingSetActivity({
    version: 1,
    records: {
      [key]: {
        url: key,
        title: 'Docs',
        events: [
          { kind: 'activation', at: now - 1000 },
          { kind: 'navigation', at: 'invalid' },
          null,
        ],
      },
      malformed: 'not-a-record',
    },
  }, now)

  assert.deepEqual(normalized.records[key]?.events, [
    { kind: 'activation', at: now - 1000 },
  ])
  assert.deepEqual(normalizeWorkingSetActivity({ version: 1, records: [] }, now), emptyWorkingSetActivity())
})

test('Working Set storage parsing distinguishes missing, malformed, and unsupported envelopes', () => {
  assert.equal(parseWorkingSetActivityStorageValue(undefined).status, 'missing')
  assert.equal(
    parseWorkingSetActivityStorageValue({ version: 1, records: [] }).status,
    'malformed',
  )
  assert.deepEqual(
    parseWorkingSetActivityStorageValue({ version: 2, records: {} }),
    { status: 'unsupported-version', version: 2 },
  )
})

test('Working Set activity mutations expose one upsert and independently pruned record keys', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const expiredAt = now - 31 * 24 * 60 * 60_000
  const currentAt = now - 60_000
  const expiredKey = 'https://example.test/expired'
  const currentKey = 'https://example.test/current'
  const nextKey = 'https://example.test/next'
  const store: WorkingSetActivityStore = {
    version: 1,
    records: {
      [expiredKey]: {
        key: expiredKey,
        url: expiredKey,
        title: 'Expired',
        domain: 'example.test',
        lastSeenAt: expiredAt,
        lastActivatedAt: expiredAt,
        events: [{ kind: 'activation', at: expiredAt }],
      },
      [currentKey]: {
        key: currentKey,
        url: currentKey,
        title: 'Current',
        domain: 'example.test',
        lastSeenAt: currentAt,
        lastActivatedAt: currentAt,
        events: [{ kind: 'activation', at: currentAt }],
      },
    },
  }

  const mutation = recordWorkingSetActivityMutation(store, {
    kind: 'navigation',
    at: now,
    tab: { url: nextKey, rawUrl: nextKey, title: 'Next' },
  })

  assert.equal(mutation.upsert?.key, nextKey)
  assert.deepEqual(mutation.deleteKeys, [expiredKey])
  assert.equal(mutation.activity.records[expiredKey], undefined)
  assert.ok(mutation.activity.records[currentKey])
  assert.deepEqual(mutation.activity.records[nextKey]?.events, [
    { kind: 'navigation', at: now },
  ])
})

test('buildWorkingSetSnapshot ranks open tabs by recency-dominant activity and folds duplicates', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({ id: 2, url: 'https://example.com/issues/bravo', title: 'Bravo issue' }),
    makeTab({ id: 3, url: 'https://example.com/issues/charlie', title: 'Charlie issue' }),
    makeTab({ id: 4, url: 'https://example.com/issues/bravo?utm_source=mail', title: 'Bravo duplicate' }),
    makeTab({ id: 5, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true }),
    makeTab({ id: 6, url: 'https://mail.example.com/', title: 'Mail app', isApp: true }),
    makeTab({ id: 7, url: 'chrome-search://local-ntp/local-ntp.html', title: 'Chrome New Tab Frame' }),
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, valueAt(tabs, 0), 'activation', now - 60_000)
  store = record(store, valueAt(tabs, 1), 'activation', now - 10 * 60_000)
  store = record(store, valueAt(tabs, 1), 'navigation', now - 9 * 60_000)
  store = record(store, valueAt(tabs, 1), 'activation', now - 8 * 60_000)
  store = record(store, valueAt(tabs, 2), 'activation', now - 4 * 24 * 60 * 60_000)
  store = record(store, valueAt(tabs, 2), 'navigation', now - 3 * 24 * 60 * 60_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    defaultLimit: 8,
    expandedLimit: 16,
    minItems: 1,
  })

  assert.deepEqual(
    snapshot.items.map((item) => item.tabId),
    [1, 2, 3],
  )
  assert.equal(valueAt(snapshot.items, 1).dupeCount, 2)
  assert.equal(snapshot.items.some((item) => item.title === 'Tab Out'), false)
  assert.equal(snapshot.items.some((item) => item.title === 'Chrome New Tab Frame'), false)
  assert.equal(snapshot.items.some((item) => item.title === 'Mail app'), false)
})

test('buildWorkingSetSnapshot keeps numeric URL ordering when scores tie', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 10, url: 'https://example.test/item-10', title: 'Item 10' }),
    makeTab({ id: 2, url: 'https://example.test/item-2', title: 'Item 2' }),
  ]
  let store = emptyWorkingSetActivity()
  for (const tab of tabs) store = record(store, tab, 'activation', now - 60_000)

  const snapshot = buildWorkingSetSnapshot({ tabs, activity: store, now, minItems: 1 })

  assert.deepEqual(snapshot.items.map((item) => item.tabId), [2, 10])
})

test('buildWorkingSetSnapshot carries each tab audible and muted state independently', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/playing', title: 'Playing', audible: true }),
    makeTab({ id: 2, url: 'https://example.com/muted', title: 'Muted', muted: true }),
    makeTab({ id: 3, url: 'https://example.com/silent', title: 'Silent' }),
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, valueAt(tabs, 0), 'activation', now - 60_000)
  store = record(store, valueAt(tabs, 1), 'activation', now - 2 * 60_000)
  store = record(store, valueAt(tabs, 2), 'activation', now - 3 * 60_000)

  const snapshot = buildWorkingSetSnapshot({ tabs, activity: store, now, minItems: 1 })
  const byTab = new Map(snapshot.items.map((item) => [item.tabId, item]))

  assert.equal(byTab.get(1)?.audible, true)
  assert.equal(byTab.get(1)?.muted, false)
  assert.equal(byTab.get(2)?.audible, false)
  assert.equal(byTab.get(2)?.muted, true)
  assert.equal(byTab.get(3)?.audible, false)
  assert.equal(byTab.get(3)?.muted, false)
})

test('buildWorkingSetSnapshot keeps tab favicons aligned with Chrome tab state', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({
      id: 2,
      url: 'https://example.com/issues/bravo',
      title: 'Bravo issue',
      favIconUrl: 'data:image/png;base64,abc',
    }),
    makeTab({
      id: 3,
      url: 'https://example.com/issues/charlie',
      rawUrl: 'chrome-extension://suspender/suspended.html#ttl=Charlie&uri=https%3A%2F%2Fexample.com%2Fissues%2Fcharlie',
      suspended: true,
      title: 'Charlie issue',
      favIconUrl: 'data:image/png;base64,suspended',
    }),
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, valueAt(tabs, 0), 'activation', now - 60_000)
  store = record(store, valueAt(tabs, 1), 'activation', now - 120_000)
  store = record(store, valueAt(tabs, 2), 'activation', now - 180_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    minItems: 1,
  })
  const byTabId = new Map(snapshot.items.map((item) => [item.tabId, item]))

  assert.equal(byTabId.get(1)?.faviconUrl, '')
  assert.equal(byTabId.get(2)?.faviconUrl, 'data:image/png;base64,abc')
  assert.equal(byTabId.get(3)?.faviconUrl, 'data:image/png;base64,suspended')
})

test('buildWorkingSetSnapshot marks a grouped item loading when any awake duplicate is loading', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.test/docs', title: 'Example Docs', status: 'complete' }),
    makeTab({ id: 2, url: 'https://example.test/docs?utm_source=mail', title: 'Example Docs', status: 'loading' }),
    makeTab({
      id: 3,
      url: 'https://example.test/suspended',
      rawUrl: 'chrome-extension://suspender/suspended.html#ttl=Suspended&uri=https%3A%2F%2Fexample.test%2Fsuspended',
      suspended: true,
      title: 'Suspended',
      status: 'loading',
    }),
  ]

  let store = emptyWorkingSetActivity()
  for (const tab of tabs) store = record(store, tab, 'activation', now - 60_000)

  const snapshot = buildWorkingSetSnapshot({ tabs, activity: store, now, minItems: 1 })
  const byUrl = new Map(snapshot.items.map((item) => [item.tabUrl, item]))

  assert.equal(byUrl.get('https://example.test/docs')?.loading, true)
  assert.equal(byUrl.get('https://example.test/suspended')?.loading, false)
})

test('buildWorkingSetSnapshot clears grouped loading after every awake duplicate completes', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const loadingTabs = [
    makeTab({ id: 1, url: 'https://example.test/docs', title: 'Example Docs', status: 'complete' }),
    makeTab({ id: 2, url: 'https://example.test/docs?utm_source=mail', title: 'Example Docs', status: 'loading' }),
  ]
  let store = emptyWorkingSetActivity()
  for (const tab of loadingTabs) store = record(store, tab, 'activation', now - 60_000)

  const loading = buildWorkingSetSnapshot({ tabs: loadingTabs, activity: store, now, minItems: 1 })
  const complete = buildWorkingSetSnapshot({
    tabs: loadingTabs.map((tab) => ({ ...tab, status: 'complete' })),
    activity: store,
    now,
    minItems: 1,
  })

  assert.equal(loading.items[0]?.loading, true)
  assert.equal(complete.items[0]?.loading, false)
})

test('buildWorkingSetSnapshot excludes Google Search result pages from working set items', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://www.google.com/search?q=example', title: 'example - Google Search' }),
    makeTab({ id: 2, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, valueAt(tabs, 0), 'activation', now - 60_000)
  store = record(store, valueAt(tabs, 1), 'activation', now - 30_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    minItems: 1,
  })

  assert.deepEqual(
    snapshot.items.map((item) => item.tabId),
    [2],
  )
})

test('buildWorkingSetSnapshot hides below the minimum meaningful candidate count', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({ id: 2, url: 'https://example.com/issues/bravo', title: 'Bravo issue' }),
  ]
  let store = emptyWorkingSetActivity()
  store = record(store, valueAt(tabs, 0), 'activation', now - 60_000)
  store = record(store, valueAt(tabs, 1), 'activation', now - 120_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    minItems: 3,
  })

  assert.deepEqual(snapshot.items, [])
})

test('buildWorkingSetSnapshot populates lastActivatedAt as the max of activation and navigation events', () => {
  const now = Date.UTC(2026, 5, 1, 12)
  const tabs = [makeTab({ id: 1, url: 'https://example.com/page', title: 'Page' })]
  let activity = emptyWorkingSetActivity()
  activity = record(activity, valueAt(tabs, 0), 'activation', now - 5000)
  activity = record(activity, valueAt(tabs, 0), 'navigation', now - 1000)

  const snapshot = buildWorkingSetSnapshot({ tabs, activity, now, minItems: 1 })

  assert.equal(snapshot.items.length, 1)
  assert.equal(valueAt(snapshot.items, 0).lastActivatedAt, now - 1000)
})

test('buildWorkingSetSnapshot uses activation timestamp when no navigation event exists', () => {
  const now = Date.UTC(2026, 5, 1, 12)
  const tabs = [makeTab({ id: 1, url: 'https://example.com/page', title: 'Page' })]
  let activity = emptyWorkingSetActivity()
  activity = record(activity, valueAt(tabs, 0), 'activation', now - 2000)

  const snapshot = buildWorkingSetSnapshot({ tabs, activity, now, minItems: 1 })

  assert.equal(valueAt(snapshot.items, 0).lastActivatedAt, now - 2000)
})
