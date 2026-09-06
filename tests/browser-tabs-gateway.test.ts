import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTab,
  createTabWithFallbackUrl,
  duplicateTab,
  focusWindow,
  getAllWindowsResult,
  getCurrentTab,
  getCurrentWindow,
  getCurrentWindowResult,
  getRecentlyClosedResult,
  getTab,
  getWindow,
  groupTabs,
  highlightTabs,
  moveTab,
  moveTabGroup,
  queryAllTabsResult,
  queryTabsInWindowResult,
  queryTabGroupsResult,
  reloadTab,
  removeTabs,
  requestExternalUnsuspend,
  setChromeTabsApi,
  updateTab,
} from '../src/extension/browser-tabs-gateway.js'
import type { ChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'
import { createFakeChromeApi } from './helpers/fake-chrome.mjs'

function fakeTab(id: number, url: string, extra: Record<string, unknown> = {}): chrome.tabs.Tab {
  return { id, url, title: `Tab ${id}`, favIconUrl: '', windowId: 1, active: false, pinned: false, groupId: -1, index: id, ...extra } as unknown as chrome.tabs.Tab
}

function withoutGlobalChrome() {
  const previous = (globalThis as { chrome?: unknown }).chrome
  delete (globalThis as { chrome?: unknown }).chrome
  return () => {
    if (previous !== undefined) (globalThis as { chrome?: unknown }).chrome = previous
    else delete (globalThis as { chrome?: unknown }).chrome
  }
}

test('gateway resolves the injected api before the global, and releases on null', async (t) => {
  const restoreGlobal = withoutGlobalChrome()
  t.after(() => {
    setChromeTabsApi(null)
    restoreGlobal()
  })

  const injected = createFakeChromeApi({ tabs: [fakeTab(1, 'https://injected.test/')] })
  ;(globalThis as { chrome?: unknown }).chrome = createFakeChromeApi({ tabs: [fakeTab(2, 'https://global.test/')] })

  setChromeTabsApi(injected)
  assert.deepEqual((await queryAllTabsResult()).value.map((tab) => tab.url), ['https://injected.test/'])

  setChromeTabsApi(null)
  assert.deepEqual((await queryAllTabsResult()).value.map((tab) => tab.url), ['https://global.test/'])
})

test('gateway re-reads globalThis.chrome on every call — no module-load caching', async (t) => {
  const restoreGlobal = withoutGlobalChrome()
  t.after(restoreGlobal)

  ;(globalThis as { chrome?: unknown }).chrome = createFakeChromeApi({ tabs: [fakeTab(1, 'https://first.test/')] })
  assert.equal((await queryAllTabsResult()).value.length, 1)

  ;(globalThis as { chrome?: unknown }).chrome = createFakeChromeApi({ tabs: [fakeTab(2, 'https://second.test/'), fakeTab(3, 'https://third.test/')] })
  assert.deepEqual((await queryAllTabsResult()).value.map((tab) => tab.url), ['https://second.test/', 'https://third.test/'])
})

test('gateway never throws: missing global and rejecting apis normalize to empty values', async (t) => {
  const restoreGlobal = withoutGlobalChrome()
  t.after(() => {
    setChromeTabsApi(null)
    restoreGlobal()
  })

  assert.deepEqual(await queryAllTabsResult(), { ok: false, value: [] })
  assert.equal(await getTab(1), null)
  assert.equal(await getCurrentTab(), null)
  assert.deepEqual(await removeTabs([1, 2]), [])
  assert.equal(await updateTab(1, { muted: true }), null)
  assert.equal(await createTab({ url: 'https://a.test/' }), null)
  assert.equal(await reloadTab(1), false)
  assert.equal(await duplicateTab(1), null)
  assert.equal(await highlightTabs(1, [0]), false)
  assert.equal(await groupTabs([1], 5), false)
  assert.equal(await moveTab(1, { index: 0 }), null)
  assert.equal(await moveTabGroup(5, { index: 0 }), null)
  assert.deepEqual(await getAllWindowsResult(), { ok: false, value: [] })
  assert.equal(await getWindow(1), null)
  assert.equal(await getCurrentWindow(), null)
  assert.deepEqual(await getCurrentWindowResult(), { ok: false, value: null })
  assert.equal(await focusWindow(1), false)
  assert.deepEqual(await queryTabGroupsResult(), { ok: true, value: [] })
  assert.deepEqual(await getRecentlyClosedResult(), { ok: true, value: [] })

  const rejecting = {
    tabs: {
      query: async () => {
        throw new Error('boom')
      },
      get: async () => {
        throw new Error('boom')
      },
    },
  } as unknown as ChromeTabsApi
  setChromeTabsApi(rejecting)
  assert.deepEqual(await queryAllTabsResult(), { ok: false, value: [] })
  assert.equal(await getTab(1), null)
})

test('getCurrentTab normalizes current-page lookup availability and rejection', async (t) => {
  t.after(() => setChromeTabsApi(null))
  const currentTab = fakeTab(7, 'chrome-extension://tab-out/index.html')
  setChromeTabsApi({
    tabs: {
      query: async () => [],
      getCurrent: async () => currentTab,
    },
  })
  assert.equal(await getCurrentTab(), currentTab)

  setChromeTabsApi({
    tabs: {
      query: async () => [],
      getCurrent: async () => {
        throw new Error('Current page unavailable')
      },
    },
  })
  assert.equal(await getCurrentTab(), null)
})

test('window tab reads and native highlighting stay scoped to the requested window', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const calls = {
    highlight: [] as chrome.tabs.HighlightInfo[],
    query: [] as chrome.tabs.QueryInfo[],
    windows: [] as number[],
  }
  const targetWindow = {
    id: 4,
    type: 'normal',
    focused: false,
    alwaysOnTop: false,
    incognito: false,
  } as chrome.windows.Window
  setChromeTabsApi({
    tabs: {
      query: async (queryInfo) => {
        calls.query.push(queryInfo)
        return [fakeTab(8, 'https://target.test/', { windowId: 4, index: 2 })]
      },
      highlight: async (highlightInfo) => {
        calls.highlight.push(highlightInfo)
        return targetWindow
      },
    },
    windows: {
      get: async (windowId) => {
        calls.windows.push(windowId)
        return targetWindow
      },
    },
  })

  assert.deepEqual(await queryTabsInWindowResult(4), {
    ok: true,
    value: [fakeTab(8, 'https://target.test/', { windowId: 4, index: 2 })],
  })
  assert.equal((await getWindow(4))?.id, 4)
  assert.equal(await highlightTabs(4, [2, 2, -1, 0]), true)
  assert.deepEqual(calls, {
    highlight: [{ windowId: 4, tabs: [2, 0] }],
    query: [{ windowId: 4 }],
    windows: [4],
  })
})

test('collection read results distinguish Chrome rejection from confirmed empty state', async (t) => {
  t.after(() => setChromeTabsApi(null))
  setChromeTabsApi({
    tabs: { query: async () => [] },
    tabGroups: {
      query: async () => { throw new Error('group metadata unavailable') },
    },
    sessions: {
      getRecentlyClosed: async () => { throw new Error('sessions unavailable') },
    },
  } as unknown as ChromeTabsApi)

  assert.deepEqual(await queryTabGroupsResult(), { ok: false, value: [] })
  assert.deepEqual(await getRecentlyClosedResult(), { ok: false, value: [] })
})

test('reloadTab and duplicateTab normalize Chrome tab commands', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const calls = { duplicate: [] as number[], reload: [] as number[] }
  const api = {
    tabs: {
      query: async () => [],
      reload: async (tabId: number) => {
        calls.reload.push(tabId)
      },
      duplicate: async (tabId: number) => {
        calls.duplicate.push(tabId)
        return fakeTab(9, 'https://duplicate.test/')
      },
    },
  } as unknown as ChromeTabsApi
  setChromeTabsApi(api)

  assert.equal(await reloadTab(4), true)
  assert.equal((await duplicateTab(4))?.id, 9)
  assert.deepEqual(calls, { duplicate: [4], reload: [4] })

  setChromeTabsApi({
    tabs: {
      query: async () => [],
      reload: async () => {
        throw new Error('gone')
      },
      duplicate: async () => {
        throw new Error('gone')
      },
    },
  } as unknown as ChromeTabsApi)
  assert.equal(await reloadTab(4), false)
  assert.equal(await duplicateTab(4), null)
})

test('removeTabs preserves every acknowledged close when Chrome rejects a missing middle id', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const liveIds = new Set([1, 3])
  const calls: Array<number | number[]> = []
  const removed: number[] = []
  const api: ChromeTabsApi = {
    tabs: {
      query: async () => [],
      remove: async (tabIds: number | number[]) => {
        calls.push(tabIds)
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          if (!liveIds.delete(tabId)) throw new Error('already gone')
          removed.push(tabId)
        }
      },
    },
  }
  setChromeTabsApi(api)

  assert.deepEqual(await removeTabs([1, 2, 3]), [1, 3])
  assert.deepEqual(calls, [1, 2, 3])
  assert.deepEqual(removed, [1, 3])
  assert.deepEqual([...liveIds], [])
})

test('removeTabs validates every write and retains earlier acknowledgements when validation rejects', async (t) => {
  t.after(() => setChromeTabsApi(null))
  const removed: number[] = []
  const checked: number[] = []
  setChromeTabsApi({
    tabs: {
      query: async () => [],
      remove: async (tabId) => {
        assert.equal(typeof tabId, 'number')
        if (typeof tabId === 'number') removed.push(tabId)
      },
    },
  })

  const result = await removeTabs([1, 2, 3, 4, 4], {
    beforeSingleRemove: async (tabId) => {
      checked.push(tabId)
      if (tabId === 3) throw new Error('Validation unavailable')
      return tabId !== 2
    },
  })

  assert.deepEqual(checked, [1, 2, 3, 4])
  assert.deepEqual(removed, [1, 4])
  assert.deepEqual(result, removed)
})

test('removeTabs mutates fake state in place and returns the acknowledged ids', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const tabs = [fakeTab(1, 'https://a.test/'), fakeTab(2, 'https://b.test/'), fakeTab(3, 'https://c.test/')]
  setChromeTabsApi(createFakeChromeApi({ tabs }))

  assert.deepEqual(await removeTabs([1, 3]), [1, 3])
  assert.deepEqual(tabs.map((tab) => tab.id), [2])
})

test('createTabWithFallbackUrl retries the effective url when the raw url is refused', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const created: string[] = []
  const api = {
    tabs: {
      query: async () => [],
      create: async (props: chrome.tabs.CreateProperties) => {
        if (props.url?.startsWith('chrome-extension://')) throw new Error('refused')
        created.push(props.url || '')
        return fakeTab(9, props.url || '')
      },
    },
  } as unknown as ChromeTabsApi
  setChromeTabsApi(api)

  const restored = await createTabWithFallbackUrl({ url: 'chrome-extension://suspender/suspended.html#uri=https://page.test/' }, 'https://page.test/')
  assert.equal(restored?.url, 'https://page.test/')
  assert.deepEqual(created, ['https://page.test/'])

  const bothRefused = await createTabWithFallbackUrl({ url: 'chrome-extension://suspender/a' }, 'chrome-extension://suspender/a')
  assert.equal(bothRefused, null)
})

test('groupTabs guards a missing tabs.group and reports success through the fake', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const withoutGroup = { tabs: { query: async () => [] } } as unknown as ChromeTabsApi
  setChromeTabsApi(withoutGroup)
  assert.equal(await groupTabs([1], 7), false)

  const tabs = [fakeTab(1, 'https://a.test/')]
  setChromeTabsApi(createFakeChromeApi({ tabs }))
  assert.equal(await groupTabs([1], 7), true)
  assert.equal(tabs[0]?.groupId, 7)
})

test('moveTabGroup preserves the native group move result and normalizes failures', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const movedGroup = {
    collapsed: true,
    color: 'blue',
    id: 7,
    shared: false,
    title: 'Example group',
    windowId: 3,
  } as chrome.tabGroups.TabGroup
  const calls: Array<{ groupId: number, properties: chrome.tabGroups.MoveProperties }> = []
  setChromeTabsApi({
    tabs: { query: async () => [] },
    tabGroups: {
      query: async () => [movedGroup],
      move: async (groupId, properties) => {
        calls.push({ groupId, properties })
        return movedGroup
      },
    },
  })

  assert.equal(await moveTabGroup(7, { index: -1, windowId: 3 }), movedGroup)
  assert.deepEqual(calls, [{ groupId: 7, properties: { index: -1, windowId: 3 } }])

  setChromeTabsApi({
    tabs: { query: async () => [] },
    tabGroups: {
      query: async () => [],
      move: async () => {
        throw new Error('group disappeared')
      },
    },
  })
  assert.equal(await moveTabGroup(7, { index: -1, windowId: 3 }), null)
})

test('requestExternalUnsuspend refuses self, missing messaging, and suspender errors', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const messages: Array<{ extensionId: string, message: unknown }> = []
  const apiWith = (response: unknown, id = 'tab-out-self') =>
    ({
      tabs: { query: async () => [] },
      runtime: {
        id,
        sendMessage: async (extensionId: string, message: unknown) => {
          messages.push({ extensionId, message })
          return response
        },
      },
    }) as unknown as ChromeTabsApi

  setChromeTabsApi(apiWith('done'))
  assert.equal(await requestExternalUnsuspend('tab-out-self', 3), false)
  assert.equal(messages.length, 0)

  assert.equal(await requestExternalUnsuspend('other-suspender', 3), true)
  assert.deepEqual(messages, [{ extensionId: 'other-suspender', message: { action: 'unsuspend', tabId: 3 } }])

  setChromeTabsApi(apiWith('Error: no such tab'))
  assert.equal(await requestExternalUnsuspend('other-suspender', 3), false)
})

test('fake windows and sessions back the read ops', async (t) => {
  t.after(() => setChromeTabsApi(null))

  const windows = [
    { id: 1, type: 'normal', focused: false },
    { id: 2, type: 'normal', focused: true },
  ] as chrome.windows.Window[]
  setChromeTabsApi(
    createFakeChromeApi({
      windows,
      recentlyClosed: [{ lastModified: 1, tab: fakeTab(4, 'https://closed.test/') } as unknown as chrome.sessions.Session],
    }),
  )

  assert.equal((await getCurrentWindow())?.id, 2)
  assert.equal(await focusWindow(1), true)
  assert.equal(windows[0]?.focused, true)
  assert.equal(windows[1]?.focused, false)
  assert.equal((await getRecentlyClosedResult()).value.length, 1)
})
