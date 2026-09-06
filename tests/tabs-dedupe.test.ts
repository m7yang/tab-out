import assert from 'node:assert/strict'
import test from 'node:test'

import { countClosableDuplicateExtras, pickDuplicateTabsToClose } from '../src/extension/tab-dedupe-policy.js'
import { closeDuplicateTabsResult, fetchOpenTabsSnapshot } from '../src/extension/tabs.js'

function createChromeMock(initialTabs: any[]) {
  let tabs = initialTabs.map((tab) => ({ ...tab }))
  const removedIds: number[] = []

  const api = {
    runtime: {
      id: 'tab-out',
    },
    tabs: {
      async query() {
        return tabs.map((tab) => ({ ...tab }))
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return { ...tab }
      },
      async remove(tabIds: number | number[]) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        removedIds.push(...ids)
        tabs = tabs.filter((tab) => !ids.includes(tab.id))
      },
    },
    windows: {
      async getCurrent() {
        return { id: 1 }
      },
      async getAll() {
        return [{ id: 1, type: 'normal' }]
      },
    },
  }

  ;(globalThis as any).chrome = api
  return { api, removedIds, getTabs: () => tabs }
}

test('dedupe policy counts only safe close extras for grouped duplicate tabs', () => {
  const sameGroup = [
    { id: 1, url: 'https://example.com/a', windowId: 1, groupId: 7 },
    { id: 2, url: 'https://example.com/a', windowId: 1, groupId: 7 },
  ]
  const multiGroup = [
    { id: 1, url: 'https://example.com/a', windowId: 1, groupId: 7 },
    { id: 2, url: 'https://example.com/a', windowId: 1, groupId: 8 },
  ]
  const mixed = [
    { id: 1, url: 'https://example.com/a', windowId: 1, groupId: 7 },
    { id: 2, url: 'https://example.com/a', windowId: 1, groupId: -1 },
  ]

  assert.equal(countClosableDuplicateExtras(sameGroup), 1)
  assert.equal(countClosableDuplicateExtras(multiGroup), 0)
  assert.equal(countClosableDuplicateExtras(mixed), 1)
})

test('dedupe policy preserves pinned Tab Out copies before score-based selection', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const matching = [
    { id: 1, url: tabOutUrl, windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, windowId: 1, index: 1, active: true, pinned: false, groupId: -1 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching, {
      preservePinnedTabOut: true,
      isTabOutUrl: (url) => url === tabOutUrl,
    }).map((tab) => tab.id),
    [2],
  )
})

test('dedupe policy preserves pinned and grouped Tab Out buckets while closing ordinary extras', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const matching = [
    { id: 1, url: tabOutUrl, windowId: 1, index: 0, active: true, pinned: true, groupId: 7 },
    { id: 2, url: tabOutUrl, windowId: 1, index: 1, active: false, pinned: true, groupId: -1 },
    { id: 3, url: tabOutUrl, windowId: 1, index: 2, active: false, pinned: false, groupId: 7 },
    { id: 4, url: tabOutUrl, windowId: 1, index: 3, active: false, pinned: false, groupId: 7 },
    { id: 5, url: tabOutUrl, windowId: 1, index: 4, active: false, pinned: false, groupId: 8 },
    { id: 6, url: tabOutUrl, windowId: 1, index: 5, active: false, pinned: false, groupId: -1 },
    { id: 7, url: tabOutUrl, windowId: 1, index: 6, active: false, pinned: false, groupId: -1 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching, {
      currentWindowId: 1,
      preservePinnedTabOut: true,
      isTabOutUrl: (url) => url === tabOutUrl,
    }).map((tab) => tab.id),
    [6, 7],
  )
  assert.equal(
    countClosableDuplicateExtras(matching, {
      isTabOutGroup: true,
      currentWindowId: 1,
      isTabOutUrl: (url) => url === tabOutUrl,
    }),
    2,
  )
})

test('dedupe keeps the most recently touched copy among ungrouped duplicates', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 1, lastAccessed: 300 },
    { id: 3, url, windowId: 1, index: 2, lastAccessed: 200 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [1, 3],
  )
})

test('a grouped duplicate is kept over a more recently touched ungrouped one', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0, groupId: 7, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 1, groupId: -1, lastAccessed: 999 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [2],
  )
})

test('a pinned duplicate is kept over a more recently touched unpinned one', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0, pinned: true, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 1, pinned: false, lastAccessed: 999 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [2],
  )
})

test('a more recently touched background copy is kept over one active in another window', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 2, index: 5, active: true, lastAccessed: 100 },
    { id: 2, url, windowId: 1, index: 0, active: false, lastAccessed: 999 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching, { currentWindowId: 1 }).map((tab) => tab.id),
    [1],
  )
})

test('tab id breaks recency ties so the newer-opened duplicate is kept', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 10, url, windowId: 1, index: 0 },
    { id: 20, url, windowId: 1, index: 1 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [10],
  )
})

test('a duplicate with a recorded lastAccessed is kept over one missing it (e.g. discarded)', () => {
  const url = 'https://example.com/a'
  const matching = [
    { id: 1, url, windowId: 1, index: 0 },
    { id: 2, url, windowId: 1, index: 1, lastAccessed: 500 },
  ]

  assert.deepEqual(
    pickDuplicateTabsToClose(matching).map((tab) => tab.id),
    [1],
  )
})

test('global dedupe keeps the current Tab Out tab when a pinned duplicate exists', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 },
  ])

  await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [])
})

test('global dedupe preserves pinned Tab Out tabs while closing non-current unpinned duplicates', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 },
  ])

  await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [2])
})

test('global dedupe keeps the current Tab Out tab when a grouped duplicate exists', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: false, groupId: 7 },
  ])

  await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [])
})

test('global dedupe aborts for Tab Out pages when current-window identity is unavailable', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 },
  ])
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    throw new Error('Current window disappeared')
  }

  const { value: snapshot } = await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(snapshot, [])
  assert.deepEqual(removedIds, [])
})

test('global dedupe accepts toolbar-provided current-window identity', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Current Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Other Tab Out', windowId: 2, index: 0, active: true, pinned: false, groupId: -1 },
  ])
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    throw new Error('Current window should come from the toolbar click')
  }

  await closeDuplicateTabsResult([tabOutUrl], true, {
    currentWindowId: 1,
    preservePinnedTabOut: true,
  })

  assert.deepEqual(removedIds, [2])
})

test('global dedupe returns an undo snapshot for closed Tab Out duplicates', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Tab Out', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 },
  ])

  const { value: snapshot } = await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(snapshot, [
    {
      url: tabOutUrl,
      rawUrl: tabOutUrl,
      title: 'Tab Out',
      pinned: false,
      groupId: -1,
      windowId: 2,
      index: 1,
    },
  ])
})

test('dedupe snapshots a confirmed Tab Out close independently of its preservation policy', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Current Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: tabOutUrl, title: 'Sibling Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 },
  ])

  const result = await closeDuplicateTabsResult([tabOutUrl], true, { preservePinnedTabOut: false })

  assert.equal(result.ok, true)
  assert.equal(result.removedCount, 1)
  assert.deepEqual(result.value.map((tab) => ({ url: tab.url, title: tab.title })), [
    { url: tabOutUrl, title: 'Sibling Tab Out' },
  ])
})

test('closeDuplicateTabsResult reports a partial duplicate close with confirmed snapshots', async () => {
  const url = 'https://example.test/docs'
  createChromeMock([
    { id: 1, url, title: 'Oldest', windowId: 1, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 2, url, title: 'Middle', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
    { id: 3, url, title: 'Newest', windowId: 1, index: 2, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
  ])
  const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
    if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
    if (tabIds === 1) throw new Error('Tab is managed')
    await removeTab(tabIds)
  }

  const result = await closeDuplicateTabsResult([url])

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial')
  assert.equal(result.attemptedCount, 2)
  assert.equal(result.removedCount, 1)
  assert.equal(result.failedCount, 1)
  assert.deepEqual(result.value.map((tab) => tab.title), ['Middle'])
})

test('dedupe stops a page after losing its original survivor and continues unrelated pages', async () => {
  const url = 'https://example.test/page'
  const otherUrl = 'https://example.test/other'
  for (const survivorChange of ['close', 'navigate']) {
    for (const firstRemoveFails of [false, true]) {
      const { api, getTabs, removedIds } = createChromeMock([
        { id: 1, url, title: 'First copy', windowId: 1, index: 0, lastAccessed: 100 },
        { id: 2, url, title: 'Second copy', windowId: 1, index: 1, lastAccessed: 200 },
        { id: 3, url, title: 'Third copy', windowId: 1, index: 2, lastAccessed: 300 },
        { id: 4, url, title: 'Original survivor', windowId: 1, index: 3, lastAccessed: 400 },
        { id: 5, url: otherUrl, title: 'Other copy', windowId: 1, index: 4, lastAccessed: 100 },
        { id: 6, url: otherUrl, title: 'Other survivor', windowId: 1, index: 5, lastAccessed: 400 },
      ])
      const removeTab = api.tabs.remove
      api.tabs.remove = async (tabIds) => {
        if (tabIds !== 1) return removeTab(tabIds)
        if (!firstRemoveFails) await removeTab(tabIds)
        const tabs = getTabs()
        const survivor = tabs.find((tab) => tab.id === 4)
        if (survivorChange === 'close') tabs.splice(tabs.indexOf(survivor), 1)
        else survivor.pendingUrl = 'https://example.test/departure'
        tabs.push({ id: 7, url, title: 'Later copy', windowId: 1, index: 6, lastAccessed: 500 })
        if (firstRemoveFails) throw new Error('Tab is managed')
      }
      const getTab = api.tabs.get
      api.tabs.get = async (tabId) => {
        if (tabId === 3 && survivorChange === 'navigate') {
          getTabs().find((tab) => tab.id === 4).pendingUrl = url
        }
        return getTab(tabId)
      }

      const result = await closeDuplicateTabsResult([url, otherUrl])

      const context = `${survivorChange}, first removal ${firstRemoveFails ? 'rejected' : 'accepted'}`
      assert.deepEqual(removedIds, firstRemoveFails ? [5] : [1, 5], context)
      assert.equal(result.status, 'partial', context)
      assert.equal(result.attemptedCount, 4, context)
      assert.equal(result.removedCount, firstRemoveFails ? 1 : 2, context)
      assert.equal(result.failedCount, firstRemoveFails ? 3 : 2, context)
      assert.deepEqual(result.value.map((tab) => tab.title), firstRemoveFails ? ['Other copy'] : ['First copy', 'Other copy'], context)
      assert.deepEqual(getTabs().filter((tab) => [2, 3, 7].includes(tab.id)).map((tab) => tab.id), [2, 3, 7], context)
    }
  }
})

test('dedupe revalidates new pin, current-dashboard, and group protections after a confirmed close', async () => {
  for (const protection of ['pinned-page', 'pinned-dashboard', 'current-dashboard', 'grouped']) {
    const isTabOut = protection.endsWith('dashboard')
    const url = isTabOut ? 'chrome-extension://tab-out/index.html' : 'https://example.test/page'
    const { api, getTabs, removedIds } = createChromeMock([
      { id: 1, url, title: 'First copy', windowId: 2, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
      { id: 2, url, title: 'Protected copy', windowId: 2, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
      { id: 3, url, title: 'Survivor', windowId: 1, index: 0, active: true, pinned: false, groupId: protection === 'grouped' ? 7 : -1, lastAccessed: 300 },
    ])
    const removeTab = api.tabs.remove
    api.tabs.remove = async (tabIds) => {
      await removeTab(tabIds)
      const target = getTabs().find((tab) => tab.id === 2)
      if (!target) return
      if (protection.startsWith('pinned')) target.pinned = true
      if (protection === 'current-dashboard') {
        target.active = true
        target.windowId = 1
      }
      if (protection === 'grouped') target.groupId = 8
    }

    const result = await closeDuplicateTabsResult([url], true, {
      preservePinned: protection === 'pinned-page',
      preservePinnedTabOut: isTabOut,
    })

    assert.deepEqual(removedIds, [1], protection)
    assert.equal(result.status, 'partial', protection)
    assert.deepEqual(result.value.map((tab) => tab.title), ['First copy'], protection)
    assert.deepEqual(getTabs().map((tab) => tab.id), [2, 3], protection)
  }
})

test('dedupe closes grouped copies only while their original survivor remains in the same group', async () => {
  const url = 'https://example.test/page'
  for (const nextGroupId of [7, 8, -1]) {
    const { api, getTabs, removedIds } = createChromeMock([
      { id: 1, url, title: 'First grouped copy', windowId: 1, index: 0, groupId: 7, lastAccessed: 100 },
      { id: 2, url, title: 'Second grouped copy', windowId: 1, index: 1, groupId: 7, lastAccessed: 200 },
      { id: 3, url, title: 'Grouped survivor', windowId: 1, index: 2, groupId: 7, lastAccessed: 300 },
      { id: 4, url, title: 'Pinned survivor', windowId: 1, index: 3, groupId: -1, pinned: true, active: true },
    ])
    const removeTab = api.tabs.remove
    api.tabs.remove = async (tabIds) => {
      await removeTab(tabIds)
      getTabs().find((tab) => tab.id === 3).groupId = nextGroupId
    }

    const result = await closeDuplicateTabsResult([url], true, { preservePinned: true })

    const context = `survivor group ${nextGroupId}`
    assert.deepEqual(removedIds, nextGroupId === 7 ? [1, 2] : [1], context)
    assert.equal(result.status, nextGroupId === 7 ? 'complete' : 'partial', context)
    assert.ok(getTabs().some((tab) => tab.id === 3), context)
    assert.ok(getTabs().some((tab) => tab.id === 4), context)
  }
})

test('dedupe revalidates the target after waiting for its survivor', async () => {
  const url = 'https://example.test/page'
  const { api, getTabs, removedIds } = createChromeMock([
    { id: 1, url, title: 'Departing copy', windowId: 1, index: 0, lastAccessed: 100 },
    { id: 2, url, title: 'Survivor', windowId: 1, index: 1, lastAccessed: 200 },
  ])
  const getTab = api.tabs.get
  api.tabs.get = async (tabId) => {
    if (tabId === 2) getTabs().find((tab) => tab.id === 1).pendingUrl = 'https://example.test/departure'
    return getTab(tabId)
  }

  const result = await closeDuplicateTabsResult([url])

  assert.deepEqual(removedIds, [])
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.value, [])
})

test('global dedupe does not close a tab whose pending navigation left the duplicate URL', async () => {
  const url = 'https://example.test/docs'
  const { removedIds } = createChromeMock([
    { id: 1, url, title: 'Newest', windowId: 1, index: 0, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
    { id: 2, url, pendingUrl: 'https://example.test/other', title: 'Leaving', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 3, url, title: 'Middle', windowId: 1, index: 2, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
  ])

  const result = await closeDuplicateTabsResult([url])

  assert.equal(result.removedCount, 1)
  assert.deepEqual(removedIds, [3])
})

test('global dedupe reads tabs after current-window state settles', async () => {
  const url = 'https://example.test/docs'
  const pendingUrl = 'https://example.test/other'
  const { removedIds } = createChromeMock([
    { id: 1, url, title: 'Current', windowId: 1, index: 0, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
    { id: 2, url, title: 'Leaving', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
  ])
  const { promise: currentWindowGate, resolve: releaseCurrentWindow } = Promise.withResolvers<void>()
  let navigationStarted = false
  let tabQueryCount = 0
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    await currentWindowGate
    navigationStarted = true
    return { id: 1 }
  }
  ;(globalThis as any).chrome.tabs.query = async () => {
    tabQueryCount += 1
    return [
      { id: 1, url, title: 'Current', windowId: 1, index: 0, active: true, pinned: false, groupId: -1, lastAccessed: 300 },
      {
        id: 2,
        url,
        ...(navigationStarted ? { pendingUrl } : {}),
        title: 'Leaving',
        windowId: 1,
        index: 1,
        active: false,
        pinned: false,
        groupId: -1,
        lastAccessed: 100,
      },
    ]
  }

  const resultPromise = closeDuplicateTabsResult([url])
  await Promise.resolve()

  assert.equal(tabQueryCount, 0)
  releaseCurrentWindow()
  const result = await resultPromise

  assert.equal(tabQueryCount, 1)
  assert.equal(result.removedCount, 0)
  assert.deepEqual(removedIds, [])
})

test('global dedupe indexes each live tab once when many keys are requested', async () => {
  const tabCount = 240
  const urls = Array.from({ length: tabCount }, (_, index) => `https://example.test/page-${index}`)
  let queryCount = 0
  let urlReadCount = 0
  const tabs = urls.map((url, index) => new Proxy({
    id: index + 1,
    url,
    title: `Page ${index}`,
    windowId: 1,
    index,
    active: index === 0,
    pinned: false,
    groupId: -1,
  }, {
    get(target, property, receiver) {
      if (property === 'url') urlReadCount += 1
      return Reflect.get(target, property, receiver)
    },
  }))
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out' },
    tabs: {
      async query() {
        queryCount += 1
        return tabs
      },
      async remove() {},
    },
    windows: {
      async getCurrent() {
        return { id: 1 }
      },
    },
  }

  const result = await closeDuplicateTabsResult(urls)

  assert.equal(result.attemptedCount, 0)
  assert.equal(queryCount, 1)
  assert.equal(urlReadCount, tabCount)
})

test('global dedupe returns an undo snapshot for closed native new-tab duplicates', async () => {
  const newTabUrl = 'chrome://newtab/'
  createChromeMock([
    { id: 1, url: newTabUrl, title: 'New Tab', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: newTabUrl, title: 'New Tab', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 },
  ])

  const { value: snapshot } = await closeDuplicateTabsResult([newTabUrl], true, { preservePinnedTabOut: true })

  assert.deepEqual(snapshot, [
    {
      url: newTabUrl,
      rawUrl: newTabUrl,
      title: 'New Tab',
      pinned: false,
      groupId: -1,
      windowId: 2,
      index: 1,
    },
  ])
})

test('global dedupe does not preserve pinned non-Tab-Out tabs with the Tab Out-only option', async () => {
  const url = 'https://example.com/dashboard'
  const { removedIds } = createChromeMock([
    { id: 1, url, title: 'Example', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url, title: 'Example', windowId: 1, index: 1, active: true, pinned: false, groupId: -1 },
  ])

  await closeDuplicateTabsResult([url], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [1])
})

test('fetchOpenTabsSnapshot recognizes filter-focus dashboard URLs as Tab Out pages', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html?focusFilter=1'
  createChromeMock([
    { id: 1, url: tabOutUrl, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
  ])

  const tabs = await fetchOpenTabsSnapshot()

  assert.equal(tabs.length, 1)
  const [tab] = tabs
  assert.ok(tab)
  assert.equal(tab.rawUrl, tabOutUrl)
  assert.equal(tab.isTabOut, true)
})

test('global dedupe collapses dashboards with different filter params, keeping the active one', async () => {
  const base = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: `${base}?filter=github`, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 1, index: 1, active: false, pinned: false, groupId: -1 },
    { id: 3, url: base, title: 'Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 },
  ])

  await closeDuplicateTabsResult([base], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds.toSorted((a, b) => a - b), [2, 3])
})

test('global dedupe closes an ordinary native new-tab alias while keeping the current dashboard', async () => {
  const base = 'chrome-extension://tab-out/index.html'
  const newTab = 'chrome://newtab/'
  const { removedIds } = createChromeMock([
    { id: 1, url: base, title: 'Tab Out', windowId: 1, index: 0, active: true, pinned: false, groupId: -1 },
    { id: 2, url: newTab, title: 'New Tab', windowId: 2, index: 0, active: false, pinned: false, groupId: -1 },
  ])

  const { value: snapshot } = await closeDuplicateTabsResult([base], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [2])
  assert.deepEqual(snapshot, [{
    url: newTab,
    rawUrl: newTab,
    title: 'New Tab',
    pinned: false,
    groupId: -1,
    windowId: 2,
    index: 0,
  }])
})

test('global dedupe uses existing recency ranking instead of preferring one Tab Out alias', async () => {
  const base = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: base, title: 'Tab Out', windowId: 2, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 2, url: 'chrome://newtab/', title: 'New Tab', windowId: 2, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
  ])

  await closeDuplicateTabsResult([base], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [1])
})

test('global dedupe preserves a pinned dashboard even when filters differ', async () => {
  const base = 'chrome-extension://tab-out/index.html'
  const { removedIds } = createChromeMock([
    { id: 1, url: `${base}?filter=github`, title: 'Tab Out', windowId: 1, index: 0, active: false, pinned: true, groupId: -1 },
    { id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 2, index: 1, active: true, pinned: false, groupId: -1 },
  ])

  await closeDuplicateTabsResult([base], true, { preservePinnedTabOut: true })

  assert.deepEqual(removedIds, [2])
})

test('closeDuplicateTabs accepts a non-canonical requested URL for equivalent Jira comments', async () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
  const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const { removedIds } = createChromeMock([
    { id: 1, url: longForm, title: 'ABC-123', windowId: 1, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 100 },
    { id: 2, url: shortForm, title: 'ABC-123', windowId: 1, index: 1, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
  ])

  await closeDuplicateTabsResult([longForm], true)

  assert.deepEqual(removedIds, [1])
})

test('closeDuplicateTabs treats GitHub repository root slash variants as duplicates while keeping the active tab', async () => {
  const repository = 'https://github.com/example/repo'
  const { removedIds } = createChromeMock([
    { id: 1, url: repository, title: 'example/repo', windowId: 1, index: 0, active: false, pinned: false, groupId: -1, lastAccessed: 200 },
    { id: 2, url: `${repository}/`, title: 'example/repo', windowId: 1, index: 1, active: true, pinned: false, groupId: -1, lastAccessed: 100 },
  ])

  await closeDuplicateTabsResult([`${repository}/`], true)

  assert.deepEqual(removedIds, [1])
})
