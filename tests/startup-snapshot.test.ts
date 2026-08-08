import assert from 'node:assert/strict'
import test from 'node:test'

import { Effect } from 'effect'

import { createLatestRefreshRunner, fetchDashboardSnapshot, fetchDashboardStartupSnapshot } from '../src/extension/dashboard-intake.js'
import { encodeDashboardRetainedPagesWire } from '../src/extension/dashboard-retained-pages-wire.js'
import { loadDashboardLocalState, loadDashboardLocalStateResult } from '../src/hooks/useDashboardLocalState.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { DEFAULT_HISTORY_RANGE } from '../src/extension/history-source.js'
import { PAGE_CHIP_PIN_STORAGE_KEY, pageChipPinId, pageChipPinKeyForUrl, pageChipPinScopeId } from '../src/extension/page-chip-pins.js'
import { SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY, subdomainPinId } from '../src/extension/section-pins.js'
import { makeChromeTab } from './helpers/chrome-tab.js'

const now = Date.now()

test('dashboard local state distinguishes a storage read failure from an empty store', async () => {
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => { throw new Error('storage unavailable') }
      }
    }
  }

  const result = await loadDashboardLocalStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.state, {
    loaded: true,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  })
})

test('dashboard local state rejects every malformed pin container instead of clearing warm state', async () => {
  for (const storageKey of [
    DOMAIN_PIN_STORAGE_KEY,
    SECTION_PIN_STORAGE_KEY,
    PAGE_CHIP_PIN_STORAGE_KEY
  ]) {
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => ({ [storageKey]: {} })
        }
      }
    }

    const result = await loadDashboardLocalStateResult()

    assert.equal(result.ok, false)
    assert.deepEqual(result.state, {
      loaded: true,
      pinnedDomains: [],
      pinnedSectionIds: [],
      pinnedPageChipIds: []
    })
  }
})

test('dashboard local state loads and normalizes every pin kind atomically', async () => {
  const sectionId = subdomainPinId('example.test', 'docs')
  const pageChipId = pageChipPinId(
    'tabs',
    pageChipPinScopeId('example.test', 'docs', '', ''),
    pageChipPinKeyForUrl('https://docs.example.test/')
  )
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => ({
          [DOMAIN_PIN_STORAGE_KEY]: ['example.test', 'example.test', '__private__'],
          [SECTION_PIN_STORAGE_KEY]: [sectionId, 'bogus', sectionId],
          [PAGE_CHIP_PIN_STORAGE_KEY]: [pageChipId, 'bogus', pageChipId]
        })
      }
    }
  }

  assert.deepEqual(await loadDashboardLocalStateResult(), {
    ok: true,
    state: {
      loaded: true,
      pinnedDomains: ['example.test'],
      pinnedSectionIds: [sectionId],
      pinnedPageChipIds: [pageChipId]
    }
  })
})

test('dashboard local state accepts storage adapters that return explicit undefined keys', async () => {
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => ({
          [DOMAIN_PIN_STORAGE_KEY]: undefined,
          [SECTION_PIN_STORAGE_KEY]: undefined,
          [PAGE_CHIP_PIN_STORAGE_KEY]: undefined
        })
      }
    }
  }

  assert.deepEqual(await loadDashboardLocalStateResult(), {
    ok: true,
    state: {
      loaded: true,
      pinnedDomains: [],
      pinnedSectionIds: [],
      pinnedPageChipIds: []
    }
  })
})

function activityRecord(url: string, title: string, at: number) {
  return {
    key: url,
    url,
    title,
    domain: new URL(url).hostname,
    lastSeenAt: at,
    lastActivatedAt: at,
    events: [{ kind: 'activation' as const, at }]
  }
}

test('page startup snapshot gathers one coherent view without writing the shared cache', async () => {
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  let tabGroupsQueryCount = 0
  let sessionsGetRecentlyClosedCount = 0
  let startupCacheWrites = 0
  const runtimeMessages: string[] = []
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.com/app', 'Example App'),
    makeChromeTab(3, 'https://example.test/report', 'Example Report'),
    makeChromeTab(4, 'chrome://extensions/', 'Extensions')
  ]
  const workingSetTabs = openTabs.filter((tab) => tab.url?.startsWith('https://'))

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async (message: { type?: string }) => {
        runtimeMessages.push(String(message.type || ''))
        if (message.type === 'tab-out:get-dashboard-service-state') {
          tabsQueryCount += 1
          windowsGetAllCount += 1
          return {
            ok: true,
            openTabsSnapshot: {
              tabs: openTabs,
              windows: [{ id: 1, focused: true, type: 'normal' }]
            },
            tabHistory: {
              stackSize: 0,
              maxSize: 48,
              cursorIndex: -1,
              currentIndex: -1,
              previousIndex: -1,
              nextIndex: -1,
              activeTabId: null,
              activeWindowId: null,
              activeWasInserted: false,
              entries: []
            },
            workingSetActivity: {
              version: 1,
              records: Object.fromEntries(workingSetTabs.map((tab, index) => [
                tab.url,
                activityRecord(String(tab.url), String(tab.title), now - index)
              ]))
            },
            retainedPages: await encodeDashboardRetainedPagesWire([]),
            retentionHealth: null
          }
        }
        return { ok: false }
      }
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return openTabs
      }
    },
    windows: {
      getAll: async () => {
        windowsGetAllCount += 1
        return [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[]
      },
      getCurrent: async () => {
        windowsGetCurrentCount += 1
        return { id: 1, focused: true, type: 'normal' } as chrome.windows.Window
      }
    },
    tabGroups: {
      query: async () => {
        tabGroupsQueryCount += 1
        return []
      }
    },
    sessions: {
      getRecentlyClosed: async () => {
        sessionsGetRecentlyClosedCount += 1
        return [
          {
            lastModified: now,
            tab: {
              sessionId: 'closed-tab',
              id: 9,
              index: 0,
              windowId: 1,
              highlighted: false,
              active: false,
              pinned: false,
              incognito: false,
              selected: false,
              discarded: false,
              autoDiscardable: true,
              groupId: -1,
              url: 'https://example.com/closed',
              title: 'Closed Example'
            } as chrome.tabs.Tab & { sessionId: string }
          }
        ] as chrome.sessions.Session[]
      }
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      },
      local: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      }
    }
  }

  const snapshot = await fetchDashboardStartupSnapshot({
    source: 'tabs',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), workingSetTabs.map((tab) => tab.url))
  assert.deepEqual(snapshot.dashboard.domainGroups.map((group) => group.domain), ['example.com', 'example.test'])
  assert.equal(snapshot.tabHistory.stackSize, 0)
  assert.equal(snapshot.workingSet.items.length, 3)
  assert.equal(snapshot.closedTabs.length, 1)
  assert.equal(snapshot.closedTabs[0]?.url, 'https://example.com/closed')
  assert.equal(tabsQueryCount, 1)
  assert.equal(windowsGetAllCount, 1)
  assert.equal(windowsGetCurrentCount, 1)
  assert.equal(tabGroupsQueryCount, 1)
  assert.equal(sessionsGetRecentlyClosedCount, 1)
  assert.equal(startupCacheWrites, 0)
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})

test('page startup snapshot includes the latest filter companion authorities', async () => {
  const openTabs = [makeChromeTab(1, 'https://open.example.test/needle', 'Open Needle')]
  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: openTabs,
          windows: [{ id: 1, focused: true, type: 'normal' }]
        },
        tabHistory: { entries: [], maxSize: 48 },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    },
    tabs: { query: async () => openTabs },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    bookmarks: {
      getTree: async () => [{
        id: 'root',
        title: '',
        children: [{ id: 'bookmark-1', title: 'Bookmark Needle', url: 'https://bookmark.example.test/needle' }]
      }]
    },
    history: {
      search: async () => [{ id: 'history-1', title: 'History Needle', url: 'https://history.example.test/needle' }]
    },
    storage: { local: { get: async () => ({}) } }
  }

  const snapshot = await fetchDashboardStartupSnapshot({
    source: 'tabs',
    filter: 'needle',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: true,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.equal(snapshot.dashboard.bookmarkSearchReady, true)
  assert.deepEqual(snapshot.dashboard.bookmarkTabs?.map((tab) => tab.url), [
    'https://bookmark.example.test/needle'
  ])
  assert.equal(snapshot.dashboard.historySearchQuery, 'needle')
  assert.equal(snapshot.dashboard.historySearchStatus, 'ready')
  assert.deepEqual(snapshot.dashboard.historyTabs?.map((tab) => tab.url), [
    'https://history.example.test/needle'
  ])
})

test('fresh page startup captures do not share browser reads or write the ordering seed', async () => {
  const { promise: tabsQueryBlocked, resolve: releaseTabsQuery } = Promise.withResolvers<void>()
  const { promise: tabsQueryStarted, resolve: markTabsQueryStarted } = Promise.withResolvers<void>()
  let tabsQueryCount = 0
  let startupCacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
          stackSize: 0,
          maxSize: 48,
          cursorIndex: -1,
          currentIndex: -1,
          previousIndex: -1,
          nextIndex: -1,
          activeTabId: null,
          activeWindowId: null,
          activeWasInserted: false,
          entries: []
        },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        markTabsQueryStarted()
        await tabsQueryBlocked
        return []
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      },
      local: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      }
    }
  }

  const baseOptions = {
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }
  const firstFetch = fetchDashboardStartupSnapshot(baseOptions)
  await tabsQueryStarted
  const latestFetch = fetchDashboardStartupSnapshot(baseOptions)
  releaseTabsQuery()
  await Promise.all([firstFetch, latestFetch])

  assert.equal(tabsQueryCount, 2)
  assert.equal(startupCacheWrites, 0)
})

test('concurrent page startup fetches remain read-only when an older read finishes last', async () => {
  const { promise: firstTabsQueryBlocked, resolve: releaseFirstTabsQuery } = Promise.withResolvers<void>()
  const { promise: firstTabsQueryStarted, resolve: markFirstTabsQueryStarted } = Promise.withResolvers<void>()
  let tabsQueryCount = 0
  let startupCacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
          stackSize: 0,
          maxSize: 48,
          cursorIndex: -1,
          currentIndex: -1,
          previousIndex: -1,
          nextIndex: -1,
          activeTabId: null,
          activeWindowId: null,
          activeWasInserted: false,
          entries: []
        },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        if (tabsQueryCount === 1) {
          markFirstTabsQueryStarted()
          await firstTabsQueryBlocked
        }
        return []
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      },
      local: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      }
    }
  }

  const baseOptions = {
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }
  const firstFetch = fetchDashboardStartupSnapshot({
    ...baseOptions,
    pinnedDomains: ['first.example']
  })
  await firstTabsQueryStarted
  const latestFetch = fetchDashboardStartupSnapshot({
    ...baseOptions,
    pinnedDomains: ['latest.example']
  })

  await latestFetch
  releaseFirstTabsQuery()
  await firstFetch

  assert.equal(tabsQueryCount, 2)
  assert.equal(startupCacheWrites, 0)
})

test('latest refresh runner discards an overtaken result and applies one trailing result', async () => {
  const { promise: firstRunBlocked, resolve: releaseFirstRun } = Promise.withResolvers<void>()
  const { promise: firstRunStarted, resolve: markFirstRunStarted } = Promise.withResolvers<void>()
  const runs: string[] = []
  const applied: string[] = []
  const runner = createLatestRefreshRunner<string>()

  const firstRequest = runner.request(
    async () => {
      runs.push('first')
      markFirstRunStarted()
      await firstRunBlocked
      return 'stale'
    },
    (value) => applied.push(value)
  )
  await firstRunStarted
  const latestRequest = runner.request(
    async () => {
      runs.push('latest')
      return 'latest'
    },
    (value) => applied.push(value)
  )
  releaseFirstRun()
  await Promise.all([firstRequest, latestRequest])

  assert.deepEqual(runs, ['first', 'latest'])
  assert.deepEqual(applied, ['latest'])
  assert.equal(runner.active(), false)
})

test('latest refresh runner ignores an overtaken failure and applies the latest request', async () => {
  const { promise: firstRunBlocked, resolve: releaseFirstRun } = Promise.withResolvers<void>()
  const { promise: firstRunStarted, resolve: markFirstRunStarted } = Promise.withResolvers<void>()
  const staleFailure = new Error('stale refresh failed')
  const applied: string[] = []
  const runner = createLatestRefreshRunner<string>()

  const firstRequest = runner.request(
    async () => {
      markFirstRunStarted()
      await firstRunBlocked
      throw staleFailure
    },
    (value) => applied.push(value)
  )
  await firstRunStarted
  const latestRequest = runner.request(
    async () => 'latest',
    (value) => applied.push(value)
  )
  releaseFirstRun()
  await Promise.all([firstRequest, latestRequest])

  assert.deepEqual(applied, ['latest'])
  assert.equal(runner.active(), false)
})

test('latest refresh runner preserves the current failure and accepts a later request', async () => {
  const expectedFailure = new Error('refresh failed')
  const applied: string[] = []
  const runner = createLatestRefreshRunner<string>()

  await assert.rejects(
    runner.request(
      async () => { throw expectedFailure },
      (value) => applied.push(value)
    ),
    (error) => error === expectedFailure
  )
  assert.equal(runner.active(), false)

  await runner.request(
    async () => 'recovered',
    (value) => applied.push(value)
  )

  assert.deepEqual(applied, ['recovered'])
})

test('latest refresh runner preserves a failure thrown while applying', async () => {
  const expectedFailure = new Error('apply failed')
  const runner = createLatestRefreshRunner<string>()

  await assert.rejects(
    runner.request(
      async () => 'value',
      () => { throw expectedFailure }
    ),
    (error) => error === expectedFailure
  )

  assert.equal(runner.active(), false)
})

test('latest refresh runner executes a request queued synchronously while applying', async () => {
  const runs: string[] = []
  const applied: string[] = []
  const runner = createLatestRefreshRunner<string>()
  let trailingRequest: Promise<void> | null = null

  const firstRequest = runner.request(
    async () => {
      runs.push('first')
      return 'first'
    },
    (value) => {
      applied.push(value)
      trailingRequest = runner.request(
        async () => {
          runs.push('trailing')
          return 'trailing'
        },
        (trailingValue) => applied.push(trailingValue)
      )
    }
  )
  await firstRequest
  await trailingRequest

  assert.deepEqual(runs, ['first', 'trailing'])
  assert.deepEqual(applied, ['first', 'trailing'])
  assert.equal(runner.active(), false)
})

test('latest refresh runner accepts an Effect without a nested Promise flight', async () => {
  const applied: string[] = []
  const runner = createLatestRefreshRunner<string>()

  await runner.requestEffect(
    Effect.succeed('effect result'),
    (value) => applied.push(value)
  )

  assert.deepEqual(applied, ['effect result'])
  assert.equal(runner.active(), false)
})

test('startup path reads ordering before saved pages without losing saved rows', async () => {
  const storageGetKeys: unknown[] = []
  const savedPageUrl = 'https://saved.example/report'
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report')
  ]

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
          stackSize: 0,
          maxSize: 48,
          cursorIndex: -1,
          currentIndex: -1,
          previousIndex: -1,
          nextIndex: -1,
          activeTabId: null,
          activeWindowId: null,
          activeWasInserted: false,
          entries: []
        },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    },
    tabs: {
      query: async () => openTabs
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: {
      query: async () => []
    },
    sessions: {
      getRecentlyClosed: async () => []
    },
    storage: {
      local: {
        get: async (keys: unknown) => {
          storageGetKeys.push(keys)
          return {
            [DOMAIN_PIN_STORAGE_KEY]: ['example.test'],
            [SAVED_PAGES_STORAGE_KEY]: {
              version: 1,
              pages: {
                [savedPageUrl]: {
                  key: savedPageUrl,
                  url: savedPageUrl,
                  title: 'Saved Report',
                  savedAt: now,
                  updatedAt: now
                }
              }
            }
          }
        }
      }
    }
  }

  const localState = await loadDashboardLocalState()
  const snapshot = await fetchDashboardStartupSnapshot({
    source: 'tabs',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: localState.pinnedDomains,
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.deepEqual(storageGetKeys, [[
    DOMAIN_PIN_STORAGE_KEY,
    SECTION_PIN_STORAGE_KEY,
    PAGE_CHIP_PIN_STORAGE_KEY
  ], SAVED_PAGES_STORAGE_KEY])
  assert.equal(snapshot.dashboard.domainGroups[0]?.domain, 'example.test')
  assert.ok(snapshot.dashboard.realTabs.some((tab) => tab.url === savedPageUrl && tab.closedSaved))
})

test('tabs refresh snapshot derives dashboard and working set from the same open-tab read', async () => {
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  const runtimeMessages: string[] = []
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report'),
    makeChromeTab(3, 'chrome://extensions/', 'Extensions')
  ]

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async (message: { type?: string }) => {
        runtimeMessages.push(String(message.type || ''))
        tabsQueryCount += 1
        windowsGetAllCount += 1
        return {
          ok: true,
          openTabsSnapshot: {
            tabs: openTabs,
            windows: [{ id: 1, focused: true, type: 'normal' }]
          },
          tabHistory: {
            stackSize: 1,
            maxSize: 48,
            cursorIndex: 0,
            currentIndex: 0,
            previousIndex: -1,
            nextIndex: -1,
            activeTabId: 1,
            activeWindowId: 1,
            activeWasInserted: false,
            entries: []
          },
          workingSetActivity: {
            version: 1,
            records: {
              'https://example.com/docs': activityRecord('https://example.com/docs', 'Example Docs', now)
            }
          },
          retainedPages: await encodeDashboardRetainedPagesWire([]),
          retentionHealth: null
        }
      }
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return openTabs
      }
    },
    windows: {
      getAll: async () => {
        windowsGetAllCount += 1
        return [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[]
      },
      getCurrent: async () => {
        windowsGetCurrentCount += 1
        return { id: 1, focused: true, type: 'normal' } as chrome.windows.Window
      }
    },
    tabGroups: {
      query: async () => []
    },
    storage: {
      local: {
        get: async () => ({})
      }
    }
  }

  const snapshot = await fetchDashboardSnapshot({
    source: 'tabs',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), ['https://example.com/docs', 'https://example.test/report'])
  assert.ok(snapshot.workingSet)
  assert.ok(snapshot.tabHistory)
  assert.equal(snapshot.workingSet.items.length, 0)
  assert.equal(snapshot.tabHistory.stackSize, 1)
  assert.equal(tabsQueryCount, 1)
  assert.equal(windowsGetAllCount, 1)
  assert.equal(windowsGetCurrentCount, 1)
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})

test('tabs refresh rejects unknown required state instead of committing an empty replacement', async () => {
  const options = {
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map<string, number>(),
      bookmarks: new Map<string, number>(),
      history: new Map<string, number>()
    }
  }
  const openTabs = [makeChromeTab(1, 'https://example.test/keep', 'Keep')]
  const baseChrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: openTabs,
          windows: [{ id: 1, focused: true, type: 'normal' }]
        },
        tabHistory: { entries: [], maxSize: 48 },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    },
    tabs: { query: async () => openTabs },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: { local: { get: async () => ({}) } }
  }

  ;(globalThis as any).chrome = {
    ...baseChrome,
    runtime: {
      ...baseChrome.runtime,
      sendMessage: async () => { throw new Error('Service worker unavailable') }
    }
  }
  await assert.rejects(fetchDashboardSnapshot(options), /dashboard service state/)

  ;(globalThis as any).chrome = {
    ...baseChrome,
    storage: {
      local: {
        get: async () => { throw new Error('Saved Pages unavailable') }
      }
    }
  }
  await assert.rejects(fetchDashboardSnapshot(options), /Saved Pages/)

  ;(globalThis as any).chrome = {
    ...baseChrome,
    windows: {
      ...baseChrome.windows,
      getCurrent: async () => ({ focused: true, type: 'normal' })
    }
  }
  await assert.rejects(fetchDashboardSnapshot(options), /current browser window/)
  await assert.rejects(fetchDashboardStartupSnapshot(options), /current browser window/)

  ;(globalThis as any).chrome = baseChrome
  await assert.doesNotReject(fetchDashboardStartupSnapshot(options))
})

test('bookmarks refresh does not wait on hidden Activation History or Working Set state', async () => {
  let runtimeMessageCount = 0
  ;(globalThis as any).chrome = {
    runtime: {
      sendMessage: async () => {
        runtimeMessageCount += 1
        throw new Error('worker state unavailable')
      }
    },
    bookmarks: {
      getTree: async () => [{
        id: 'root',
        title: '',
        children: [{ id: 'bookmark-1', title: 'Example', url: 'https://example.test/' }]
      }]
    },
    storage: {
      local: { get: async () => ({}) }
    }
  }

  const snapshot = await fetchDashboardSnapshot({
    source: 'bookmarks',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.equal(runtimeMessageCount, 0)
  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), ['https://example.test/'])
  assert.equal(snapshot.tabHistory, undefined)
  assert.equal(snapshot.workingSet, undefined)
})
