import assert from 'node:assert/strict'
import { it, test, vi } from '@effect/vitest'
import { Effect, Fiber, Layer, Result } from 'effect'
import * as TabHistoryService from '../../src/extension/background/tab-history-service.js'
import {
  readChromeStorageValue,
  writeChromeStorageValue,
} from '../../src/extension/background/chrome-storage.js'
import { WorkingSetActivityStorage } from '../../src/extension/background/working-set-activity-storage.js'
import {
  effectiveUrlForHistoryIdentity,
  historyChanged,
  historyForBackgroundTabCreation,
} from '../../src/extension/background/tab-history-state.js'
import { normalizeTabHistorySnapshot } from '../../src/extension/tab-history.js'
import { emptyWorkingSetActivity, recordWorkingSetActivity } from '../../src/extension/working-set.js'
import type { ChromeApi } from '../../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'

const WORKING_SET_ACTIVITY_KEY = 'working-set-activity-test'
function tabHistoryLayer(chromeApi: ChromeApi) {
  const storage = chromeApi.storage?.local
  const unavailable = (): Promise<never> => Promise.reject(
    new Error('Chrome local storage is unavailable for Working Set activity'),
  )
  const activityStorage = WorkingSetActivityStorage.layer({
    read: () => storage
      ? readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      : unavailable(),
    write: (change) => storage
      ? writeChromeStorageValue(
          storage,
          WORKING_SET_ACTIVITY_KEY,
          change.activity,
        )
      : unavailable(),
    replace: (activity) => storage
      ? writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, activity)
      : unavailable(),
  })
  return TabHistoryService.TabHistory.layer(chromeApi).pipe(
    Layer.provide(activityStorage),
  )
}

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

function makeChromeApi(state: {
  history?: {
    stack: { windowId: number, tabId: number, url?: string }[]
    index: number
    pending?: { windowId: number, tabId: number, url?: string, createdAt: number }[]
  }
  tabs?: chrome.tabs.Tab[]
  activity?: WorkingSetActivityStore
}): ChromeApi {
  const tabs = state.tabs || []
  const rawHistory = state.history || { stack: [], index: -1 }
  const withIdentity = <Entry extends { tabId: number, url?: string }>(entry: Entry) => ({
    ...entry,
    url: entry.url ?? effectiveUrlForHistoryIdentity(tabs.find((tab) => tab.id === entry.tabId)),
  })
  const history = {
    version: 2,
    stack: rawHistory.stack.map(withIdentity),
    index: rawHistory.index,
    pending: (rawHistory.pending || []).map(withIdentity),
  }
  const activity = state.activity || emptyWorkingSetActivity()
  const storage = new Map<string, unknown>([
    ['globalTabHistory', history],
    [WORKING_SET_ACTIVITY_KEY, activity],
  ])
  return {
    tabs: {
      get: async (tabId: number) => {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return tab
      },
      query: async (q: chrome.tabs.QueryInfo) => {
        if ('windowId' in q && typeof q.windowId === 'number') {
          return tabs.filter((t) => t.windowId === q.windowId && (q.active === undefined || !!t.active === !!q.active))
        }
        return tabs
      },
      update: async () => undefined,
      remove: async () => undefined,
    } as unknown as ChromeApi['tabs'],
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window],
    } as unknown as ChromeApi['windows'],
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) storage.set(k, v)
        },
      },
    } as unknown as ChromeApi['storage'],
  } as ChromeApi
}

it.effect('getTabHistorySnapshot populates lastActivatedAt from the activity log', () => {
  // Anchor to the live clock: getTabHistorySnapshot prunes activity older than
  // ACTIVITY_RETENTION_MS (30 days) relative to Date.now(), so a hardcoded past
  // date rots out of the window and the record disappears.
  const now = Date.now()
  let activity = emptyWorkingSetActivity()
  activity = recordWorkingSetActivity(activity, {
    kind: 'activation',
    at: now - 1000,
    tab: { url: 'https://example.com/a', rawUrl: 'https://example.com/a', title: 'A' },
  })

  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 10 }], index: 0 },
    tabs: [{ id: 10, windowId: 1, url: 'https://example.com/a', title: 'A', active: true } as chrome.tabs.Tab],
    activity,
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot()
    assert.equal(snapshot.entries.length, 1)
    assert.equal(valueAt(snapshot.entries, 0).lastActivatedAt, now - 1000)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history preserves intentional blank titles through snapshot normalization', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'chrome://newtab/', title: '\u200e', active: true },
    { id: 20, windowId: 1, url: 'chrome://new-tab-page/', title: 'New Tab', active: false },
    { id: 30, windowId: 1, url: 'https://example.test/', title: '', active: false },
  ] as chrome.tabs.Tab[]
  const chromeApi = makeChromeApi({
    history: { stack: tabs.map((tab) => ({ windowId: 1, tabId: tab.id! })), index: 0 },
    tabs,
  })
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = normalizeTabHistorySnapshot(yield* service.getTabHistorySnapshot())
    const titles = new Map(snapshot.entries.map((entry) => [entry.tabId, entry.title]))
    assert.equal(titles.get(10), '\u200e')
    assert.equal(titles.get(20), 'New Tab')
    assert.equal(titles.get(30), 'example.test/')
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('getTabHistorySnapshot sets lastActivatedAt to null when the URL has no activity record', () => {
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 10 }], index: 0 },
    tabs: [{ id: 10, windowId: 1, url: 'https://example.com/a', title: 'A', active: true } as chrome.tabs.Tab],
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot()
    assert.equal(valueAt(snapshot.entries, 0).lastActivatedAt, null)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('getTabHistorySnapshot marks only live awake loading tabs as loading', () => {
  const suspendedRawUrl = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/suspended.html#ttl=Example&uri=https%3A%2F%2Fexample.test%2Fsuspended'
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 11 },
        { windowId: 1, tabId: 12 },
      ],
      index: 0,
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://example.test/loading', title: 'Loading', status: 'loading', active: true } as chrome.tabs.Tab,
      { id: 11, windowId: 1, url: 'https://example.test/complete', title: 'Complete', status: 'complete' } as chrome.tabs.Tab,
      { id: 12, windowId: 1, url: suspendedRawUrl, title: 'Suspended', status: 'loading' } as chrome.tabs.Tab,
    ],
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot()
    const byTabId = new Map(snapshot.entries.map((entry) => [entry.tabId, entry]))

    assert.equal(byTabId.get(10)?.loading, true)
    assert.equal(byTabId.get(11)?.loading, false)
    assert.equal(byTabId.get(12)?.loading, false)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('getTabHistorySnapshot can use an already-read activity snapshot', () => {
  // Anchor to the live clock: getTabHistorySnapshot prunes activity older than
  // ACTIVITY_RETENTION_MS (30 days) relative to Date.now(), so a hardcoded past
  // date rots out of the window and the record disappears.
  const now = Date.now()
  let activity = emptyWorkingSetActivity()
  activity = recordWorkingSetActivity(activity, {
    kind: 'activation',
    at: now - 500,
    tab: { url: 'https://example.test/b', rawUrl: 'https://example.test/b', title: 'B' },
  })

  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/b', title: 'B', active: true } as chrome.tabs.Tab],
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot(activity)
    assert.equal(valueAt(snapshot.entries, 0).lastActivatedAt, now - 500)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history capture reads all tabs and windows once and returns the exact browser generation it rendered', () => {
  const tabs = [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab]
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs,
  })
  let allTabsReads = 0
  let allWindowsReads = 0
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (Object.keys(queryInfo).length === 0) allTabsReads += 1
    return tabs
  }
  chromeApi.windows.getAll = async () => {
    allWindowsReads += 1
    return [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
  }

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const capture = yield* service.getTabHistorySnapshotCapture(emptyWorkingSetActivity())
    assert.equal(allTabsReads, 1)
    assert.equal(allWindowsReads, 1)
    assert.equal(capture.openTabsSnapshot?.tabs, tabs)
    assert.equal(capture.tabHistory.activeTabId, 11)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history capture starts required browser reads together before either settles', () => {
  const tabs = [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab]
  const windows = [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs,
  })
  const started: string[] = []
  const { promise: tabsRead, resolve: resolveTabs } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const { promise: windowsRead, resolve: resolveWindows } = Promise.withResolvers<chrome.windows.Window[]>()
  chromeApi.tabs.query = async () => {
    started.push('tabs')
    return tabsRead
  }
  chromeApi.windows.getAll = async () => {
    started.push('windows')
    return windowsRead
  }

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const captureFiber = yield* service.getTabHistorySnapshotCapture(emptyWorkingSetActivity()).pipe(
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Effect.yieldNow
    assert.deepEqual(started, ['tabs', 'windows'])
    resolveTabs(tabs)
    resolveWindows(windows)

    const capture = yield* Fiber.join(captureFiber)
    assert.equal(capture.openTabsSnapshot.tabs, tabs)
    assert.equal(capture.openTabsSnapshot.windows, windows)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history snapshot rejects unknown window state instead of returning a partial generation', () => {
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab],
  })
  chromeApi.windows.getAll = async () => { throw new Error('windows unavailable') }

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const failure = yield* Effect.result(service.getTabHistorySnapshot(emptyWorkingSetActivity()))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.match(String(failure.failure.cause), /windows unavailable/)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history snapshot rejects a focused window missing from the captured tabs generation', () => {
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab],
  })
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
    { id: 2, focused: true, type: 'normal' } as chrome.windows.Window,
  ]

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const failure = yield* Effect.result(service.getTabHistorySnapshot(emptyWorkingSetActivity()))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.match(String(failure.failure.cause), /focus state is unavailable/)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history mutation retries persisted state after a transient initial storage read failure', () => {
  const tabs = [
    { id: 1, windowId: 1, url: 'https://example.test/one', title: 'One', active: false } as chrome.tabs.Tab,
    { id: 2, windowId: 1, url: 'https://example.test/two', title: 'Two', active: true } as chrome.tabs.Tab,
  ]
  let persisted: any = {
    version: 2,
    stack: [{ windowId: 1, tabId: 1, url: 'https://example.test/one' }],
    index: 0,
    pending: [],
  }
  let readAttempts = 0
  let writeAttempts = 0
  const readFailure = new Error('storage temporarily unavailable')
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = (async (key: string) => {
    readAttempts += 1
    if (readAttempts === 1) throw readFailure
    return { [key]: persisted }
  }) as typeof chromeApi.storage.local.get
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writeAttempts += 1
    persisted = entries.globalTabHistory
  }
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory

    const failure = yield* Effect.result(service.recordTabActivation(1, 2))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.equal(failure.failure.cause, readFailure)
    assert.equal(writeAttempts, 0)
    assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1])

    yield* service.recordTabActivation(1, 2)
    assert.equal(writeAttempts, 1)
    assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1, 2])
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history mutation does not advance its cache until the storage write succeeds', () => {
  const tabs = [
    { id: 1, windowId: 1, url: 'https://example.test/one', title: 'One', active: false } as chrome.tabs.Tab,
    { id: 2, windowId: 1, url: 'https://example.test/two', title: 'Two', active: true } as chrome.tabs.Tab,
  ]
  let persisted: any = {
    version: 2,
    stack: [{ windowId: 1, tabId: 1, url: 'https://example.test/one' }],
    index: 0,
    pending: [],
  }
  let writeAttempts = 0
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = (async (key: string) => ({ [key]: persisted })) as typeof chromeApi.storage.local.get
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writeAttempts += 1
    if (writeAttempts === 1) throw new Error('storage write failed')
    persisted = entries.globalTabHistory
  }
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory

    const failure = yield* Effect.result(service.recordTabActivation(1, 2))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.match(String(failure.failure.cause), /storage write failed/)
    assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1])

    yield* service.recordTabActivation(1, 2)
    assert.equal(writeAttempts, 2)
    assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1, 2])
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history treats an absent first-run storage key as known empty state', () => {
  const tab = { id: 1, windowId: 1, url: 'https://example.test/first', title: 'First', active: true } as chrome.tabs.Tab
  const chromeApi = makeChromeApi({ tabs: [tab] })
  chromeApi.storage.local.get = async () => ({})

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    assert.equal(snapshot.activeTabId, 1)
    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [1])
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('legacy ID-only persisted history resets once into the identity-bearing schema', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://reused.example.test/', title: 'Reused', active: false } as chrome.tabs.Tab,
  ]
  let persisted: unknown = {
    stack: [
      { windowId: 1, tabId: 10 },
      { windowId: 1, tabId: 20 },
    ],
    index: 1,
    pending: [{ windowId: 1, tabId: 30, createdAt: 123 }],
  }
  let writes = 0
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writes += 1
    persisted = entries.globalTabHistory
  }

  return Effect.gen(function* () {
    const firstSnapshot = yield* Effect.gen(function* () {
      const service = yield* TabHistoryService.TabHistory
      return yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))

    assert.deepEqual(firstSnapshot.entries.map((entry) => entry.tabId), [10])
    assert.deepEqual(persisted, {
      version: 2,
      stack: [{ windowId: 1, tabId: 10, url: 'https://current.example.test/' }],
      index: 0,
      pending: [],
    })
    assert.equal(writes, 2)

    const secondSnapshot = yield* Effect.gen(function* () {
      const service = yield* TabHistoryService.TabHistory
      return yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))

    assert.deepEqual(secondSnapshot.entries.map((entry) => entry.tabId), [10])
    assert.equal(writes, 2)
  })
})

it.effect('malformed versioned history resets instead of retaining a partial store', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://previous.example.test/', title: 'Previous', active: false } as chrome.tabs.Tab,
  ]
  let persisted: unknown = {
    version: 2,
    stack: [{ windowId: 1, tabId: 20, url: 'https://previous.example.test/' }],
    index: 0,
    pending: [{ windowId: 1, tabId: 30, url: 'https://pending.example.test/', createdAt: Number.POSITIVE_INFINITY }],
  }
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    persisted = entries.globalTabHistory
  }

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
    assert.deepEqual(persisted, {
      version: 2,
      stack: [{ windowId: 1, tabId: 10, url: 'https://current.example.test/' }],
      index: 0,
      pending: [],
    })
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('missed browser startup prunes reused tab IDs whose effective URLs changed', () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10, url: 'https://previous-session.example.test/current' },
        { windowId: 1, tabId: 20, url: 'https://previous-session.example.test/next' },
      ],
      index: 1,
      pending: [
        { windowId: 1, tabId: 30, url: 'https://previous-session.example.test/pending', createdAt: 123 },
      ],
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://new-session.example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://new-session.example.test/unrelated', title: 'Unrelated', active: false } as chrome.tabs.Tab,
      { id: 30, windowId: 1, url: 'https://new-session.example.test/other', title: 'Other', active: false } as chrome.tabs.Tab,
    ],
  })
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
    assert.equal(snapshot.previousIndex, -1)
    assert.equal(snapshot.nextIndex, -1)
    assert.equal(snapshot.pendingSize, 0)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history switch prunes a reused target before cursor repair can focus it', () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10, url: 'https://previous-session.example.test/target' },
        { windowId: 1, tabId: 20, url: 'https://example.test/current' },
      ],
      index: 1,
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://new-session.example.test/unrelated', title: 'Unrelated', active: false } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
    ],
  })
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    yield* service.switchTabHistory(-1)
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [20])
    assert.equal(snapshot.previousIndex, -1)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history switch does not mutate an opener before fresh target validation', () => {
  const capturedTabs = [
    { id: 10, windowId: 1, url: 'https://example.test/target', title: 'Target', active: false } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
  ]
  const liveTabs = capturedTabs.map((tab) => ({ ...tab }))
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10, url: 'https://example.test/target' },
        { windowId: 1, tabId: 20, url: 'https://example.test/current' },
      ],
      index: 1,
    },
    tabs: capturedTabs,
  })
  let fullTabReads = 0
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (Object.keys(queryInfo).length === 0) {
      fullTabReads += 1
      return (fullTabReads === 1 ? capturedTabs : liveTabs).map((tab) => ({ ...tab }))
    }
    return liveTabs.filter((tab) => (
      (typeof queryInfo.windowId !== 'number' || tab.windowId === queryInfo.windowId) &&
      (queryInfo.active === undefined || tab.active === queryInfo.active)
    ))
  }
  chromeApi.windows.getAll = async () => {
    const firstLiveTab = valueAt(liveTabs, 0)
    liveTabs[0] = {
      ...firstLiveTab,
      url: 'https://example.test/unrelated',
      title: 'Unrelated',
    }
    return [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
  }
  const openerUpdates: Array<{ tabId: number, openerTabId?: number }> = []
  chromeApi.tabs.update = (async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    openerUpdates.push(updateProperties.openerTabId === undefined
      ? { tabId }
      : { tabId, openerTabId: updateProperties.openerTabId })
    return liveTabs.find((tab) => tab.id === tabId)
  }) as typeof chromeApi.tabs.update
  vi.stubGlobal('chrome', chromeApi)
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const failure = yield* Effect.result(service.switchTabHistory(-1))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) {
      assert.match(String(failure.failure.cause), /Could not activate tab history target/)
    }
    assert.deepEqual(openerUpdates, [])
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('history switch fails closed when the last-focused active-tab read is unknown', () => {
  const tabs = [
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
  ]
  const chromeApi = makeChromeApi({ tabs })
  const queryTabs = chromeApi.tabs.query.bind(chromeApi.tabs)
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (queryInfo.active && queryInfo.lastFocusedWindow) {
      throw new Error('Last-focused tab unavailable')
    }
    return queryTabs(queryInfo)
  }
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
  ]
  let updateCalls = 0
  chromeApi.tabs.update = async () => {
    updateCalls += 1
    return tabs[0]
  }
  chromeApi.windows.update = async () => ({
    id: 1,
    focused: true,
    type: 'normal',
  } as chrome.windows.Window)
  vi.stubGlobal('chrome', chromeApi)
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const failure = yield* Effect.result(service.switchTabHistory(-1))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.match(String(failure.failure.cause), /focus state is unavailable/)
    assert.equal(updateCalls, 0)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('versioned activation and pending history survive an extension reload when identities still match', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://example.test/first', title: 'First', active: false } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
    {
      id: 30,
      windowId: 1,
      url: 'https://example.test/pending',
      title: 'Pending',
      active: false,
      openerTabId: 20,
    } as chrome.tabs.Tab,
  ]
  let persisted: unknown = { version: 2, stack: [], index: -1, pending: [] }
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    persisted = entries.globalTabHistory
  }

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* TabHistoryService.TabHistory
      yield* service.recordTabActivation(1, 10)
      yield* service.recordTabActivation(1, 20)
      yield* service.recordTabCreation(valueAt(tabs, 2))
    }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))

    const reloadedSnapshot = yield* Effect.gen(function* () {
      const service = yield* TabHistoryService.TabHistory
      return yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())
    }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))

    assert.deepEqual(
      reloadedSnapshot.entries.map((entry) => ({ tabId: entry.tabId, pending: entry.pending })),
      [
        { tabId: 10, pending: false },
        { tabId: 20, pending: false },
        { tabId: 30, pending: true },
      ],
    )
    assert.deepEqual(
      (persisted as { stack: Array<{ url: string }>, pending: Array<{ url: string }> }).stack.map((entry) => entry.url),
      ['https://example.test/first', 'https://example.test/current'],
    )
    assert.deepEqual(
      (persisted as { pending: Array<{ url: string }> }).pending.map((entry) => entry.url),
      ['https://example.test/pending'],
    )
  })
})

it.effect('a trusted pending tab keeps its FIFO entry when its effective URL redirects', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
    {
      id: 30,
      windowId: 1,
      url: 'about:blank',
      title: '',
      active: false,
      openerTabId: 10,
    } as chrome.tabs.Tab,
  ]
  const chromeApi = makeChromeApi({
    history: {
      stack: [{ windowId: 1, tabId: 10 }],
      index: 0,
    },
    tabs,
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const pendingTab = valueAt(tabs, 1)
    yield* service.recordTabCreation(pendingTab)
    pendingTab.url = 'https://example.test/final'
    yield* service.recordTabNavigation(30, { url: pendingTab.url }, pendingTab)
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())

    assert.deepEqual(
      snapshot.entries.map((entry) => ({ tabId: entry.tabId, url: entry.url, pending: entry.pending })),
      [
        { tabId: 10, url: 'https://example.test/current', pending: false },
        { tabId: 30, url: 'https://example.test/final', pending: true },
      ],
    )
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('a trusted inactive activation-history tab keeps its position when it navigates', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://example.test/first', title: 'First', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: false } as chrome.tabs.Tab,
  ]
  const chromeApi = makeChromeApi({ tabs })
  const firstTab = valueAt(tabs, 0)
  const secondTab = valueAt(tabs, 1)

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    yield* service.recordTabActivation(1, 10)
    firstTab.active = false
    secondTab.active = true
    yield* service.recordTabActivation(1, 20)
    firstTab.url = 'https://example.test/first-after-navigation'
    yield* service.recordTabNavigation(10, { url: firstTab.url }, firstTab)
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())

    assert.deepEqual(
      snapshot.entries.map((entry) => ({ tabId: entry.tabId, url: entry.url })),
      [
        { tabId: 10, url: 'https://example.test/first-after-navigation' },
        { tabId: 20, url: 'https://example.test/current' },
      ],
    )
    assert.equal(snapshot.currentIndex, 1)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('an untrusted navigation cannot rebase a reused id from a previous browser session', () => {
  const reusedTab = {
    id: 30,
    windowId: 1,
    url: 'https://new-session.example.test/unrelated',
    title: 'Unrelated',
    active: false,
  } as chrome.tabs.Tab
  const chromeApi = makeChromeApi({
    history: {
      stack: [{ windowId: 1, tabId: 10, url: 'https://example.test/current' }],
      index: 0,
      pending: [{
        windowId: 1,
        tabId: 30,
        url: 'https://previous-session.example.test/pending',
        createdAt: 123,
      }],
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
      reusedTab,
    ],
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    assert.ok(reusedTab.url)
    yield* service.recordTabNavigation(30, { url: reusedTab.url }, reusedTab)
    const snapshot = yield* service.getTabHistorySnapshot(emptyWorkingSetActivity())

    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
    assert.equal(snapshot.pendingSize, 0)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

test('history comparison treats effective URL identity changes as mutations', () => {
  const first = {
    stack: [{ windowId: 1, tabId: 10, url: 'https://example.test/first' }],
    index: 0,
    pending: [{ windowId: 1, tabId: 20, url: 'https://example.test/pending', createdAt: 1 }],
  }

  assert.equal(historyChanged(first, first), false)
  assert.equal(historyChanged(first, {
    ...first,
    stack: [{ ...first.stack[0], url: 'https://example.test/reused' }],
  }), true)
  assert.equal(historyChanged(first, {
    ...first,
    pending: [{ ...first.pending[0], url: 'https://example.test/reused-pending' }],
  }), true)
})

test('background tab creation replaces a stale same-id history entry with the new pending lifetime', () => {
  const result = historyForBackgroundTabCreation({
    stack: [
      { windowId: 1, tabId: 10, url: 'https://example.test/current' },
      { windowId: 1, tabId: 30, url: 'https://previous-session.example.test/stale' },
    ],
    index: 1,
    pending: [],
  }, {
    windowId: 2,
    tabId: 30,
    url: 'https://example.test/new-pending',
    createdAt: 123,
  })

  assert.deepEqual(result.history, {
    stack: [{ windowId: 1, tabId: 10, url: 'https://example.test/current' }],
    index: 0,
    pending: [{
      windowId: 2,
      tabId: 30,
      url: 'https://example.test/new-pending',
      createdAt: 123,
    }],
  })
  assert.equal(result.changed, true)
})

it.effect('activated history reserves the bounded index budget before pending tabs', () => {
  const stack = Array.from({ length: 47 }, (_, index) => ({
    windowId: 1,
    tabId: index + 1,
  }))
  const pending = Array.from({ length: 3 }, (_, index) => ({
    windowId: 1,
    tabId: index + 48,
    createdAt: index + 1,
  }))
  const tabs = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    url: `https://tab-${index + 1}.example/`,
    title: `Tab ${index + 1}`,
    active: index === 46,
  } as chrome.tabs.Tab))
  const chromeApi = makeChromeApi({
    history: { stack, index: 46, pending },
    tabs,
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const snapshot = yield* service.getTabHistorySnapshot()
    assert.equal(snapshot.stackSize, 47)
    assert.equal(snapshot.pendingSize, 1)
    assert.equal(snapshot.entries.length, 48)
    assert.equal(snapshot.entries.at(-1)?.tabId, 48)
    assert.equal(snapshot.entries.at(-1)?.pending, true)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

test('normalizeTabHistorySnapshot preserves lastActivatedAt on entries', () => {
  const result = normalizeTabHistorySnapshot({
    stackSize: 1,
    maxSize: 24,
    cursorIndex: 0,
    currentIndex: 0,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: 10,
    activeWindowId: 1,
    activeWasInserted: false,
    entries: [
      {
        index: 0,
        tabId: 10,
        windowId: 1,
        exists: true,
        active: true,
        activeInOtherWindow: false,
        isApp: false,
        pinned: false,
        discarded: false,
        suspended: false,
        cursor: true,
        current: true,
        previousTarget: false,
        nextTarget: false,
        title: 'A',
        url: 'https://example.com/a',
        rawUrl: 'https://example.com/a',
        displayUrl: 'example.com/a',
        favIconUrl: '',
        lastActivatedAt: 1_700_000_000,
      },
    ],
  })
  assert.equal(valueAt(result.entries, 0).lastActivatedAt, 1_700_000_000)
})

test('normalizeTabHistorySnapshot defaults missing lastActivatedAt to null', () => {
  const result = normalizeTabHistorySnapshot({
    entries: [{ tabId: 10, windowId: 1 } as unknown as never],
  })
  assert.equal(valueAt(result.entries, 0).lastActivatedAt, null)
})

it.effect('focused-window history preserves event order when captured active-tab lookups resolve out of order', () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://one.example.test/', title: 'One', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 2, url: 'https://two.example.test/', title: 'Two', active: true } as chrome.tabs.Tab,
  ]
  const { promise: windowOneLookup, resolve: resolveWindowOne } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const { promise: windowTwoLookup, resolve: resolveWindowTwo } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (typeof queryInfo.windowId === 'number') {
      throw new Error('captured focus events must not repeat the active-tab lookup')
    }
    return tabs
  }
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
    { id: 2, focused: true, type: 'normal' } as chrome.windows.Window,
  ]
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const firstFocus = yield* service.recordFocusedWindowActiveTab(
      1,
      windowOneLookup.then((resolvedTabs) => resolvedTabs[0] ?? null),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    const secondFocus = yield* service.recordFocusedWindowActiveTab(
      2,
      windowTwoLookup.then((resolvedTabs) => resolvedTabs[0] ?? null),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    resolveWindowTwo([valueAt(tabs, 1)])
    yield* Effect.yieldNow
    resolveWindowOne([valueAt(tabs, 0)])
    yield* Fiber.joinAll([firstFocus, secondFocus])

    const snapshot = yield* service.getTabHistorySnapshot()
    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10, 20])
    assert.equal(snapshot.currentIndex, 1)
    assert.equal(snapshot.previousIndex, 0)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('browser startup resets ID-only history before Chrome can reuse old tab ids', () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 20 },
      ],
      index: 0,
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://new-session.example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://new-session.example.test/unrelated', title: 'Unrelated', active: false } as chrome.tabs.Tab,
    ],
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    yield* service.resetForBrowserStartup()
    const snapshot = yield* service.getTabHistorySnapshot()

    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
    assert.equal(snapshot.previousIndex, -1)
    assert.equal(snapshot.nextIndex, -1)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('browser startup reset clears stale IDs before activation without depending on a storage read', () => {
  let readAttempts = 0
  let persisted: unknown = {
    stack: [{ windowId: 1, tabId: 10 }],
    index: 0,
    pending: [],
  }
  const chromeApi = makeChromeApi({
    tabs: [
      { id: 20, windowId: 1, url: 'https://new-session.example.test/active', title: 'Active', active: true } as chrome.tabs.Tab,
    ],
  })
  chromeApi.storage.local.get = async () => {
    readAttempts += 1
    throw new Error('history read unavailable')
  }
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    persisted = entries.globalTabHistory
  }
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    yield* service.resetForBrowserStartup()
    yield* service.recordTabActivation(1, 20)

    assert.equal(readAttempts, 0)
    assert.deepEqual(persisted, {
      version: 2,
      stack: [{ windowId: 1, tabId: 20, url: 'https://new-session.example.test/active' }],
      index: 0,
      pending: [],
    })
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('failed browser startup reset remains a barrier before the next activation', () => {
  let persisted: unknown = {
    stack: [{ windowId: 1, tabId: 10 }],
    index: 0,
    pending: [],
  }
  let writeAttempts = 0
  const chromeApi = makeChromeApi({
    tabs: [
      { id: 20, windowId: 1, url: 'https://new-session.example.test/active', title: 'Active', active: true } as chrome.tabs.Tab,
    ],
  })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writeAttempts += 1
    if (writeAttempts === 1) throw new Error('history reset write unavailable')
    persisted = entries.globalTabHistory
  }
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    const failure = yield* Effect.result(service.resetForBrowserStartup())
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) {
      assert.match(String(failure.failure.cause), /history reset write unavailable/)
    }
    yield* service.recordTabActivation(1, 20)

    assert.equal(writeAttempts, 3)
    assert.deepEqual(persisted, {
      version: 2,
      stack: [{ windowId: 1, tabId: 20, url: 'https://new-session.example.test/active' }],
      index: 0,
      pending: [],
    })
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('tab replacement preserves activated history position under the new tab id', () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 20 },
      ],
      index: 0,
    },
    tabs: [
      { id: 30, windowId: 2, url: 'https://replacement.example.test/', title: 'Replacement', active: true } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://other.example.test/', title: 'Other', active: false } as chrome.tabs.Tab,
    ],
  })
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
    { id: 2, focused: true, type: 'normal' } as chrome.windows.Window,
  ]
  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    yield* service.replaceTabId(30, 10)
    const snapshot = yield* service.getTabHistorySnapshot()

    assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [30, 20])
    assert.equal(valueAt(snapshot.entries, 0).windowId, 2)
    assert.equal(snapshot.currentIndex, 0)
    assert.equal(snapshot.entries.some((entry) => entry.tabId === 10), false)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})

it.effect('tab replacement preserves a pending target under the new tab id', () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [{ windowId: 1, tabId: 20 }],
      index: 0,
      pending: [{ windowId: 1, tabId: 10, createdAt: 123 }],
    },
    tabs: [
      { id: 20, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true } as chrome.tabs.Tab,
      { id: 30, windowId: 1, url: 'https://pending.example.test/', title: 'Pending', active: false } as chrome.tabs.Tab,
    ],
  })

  return Effect.gen(function* () {
    const service = yield* TabHistoryService.TabHistory
    yield* service.replaceTabId(30, 10)
    const snapshot = yield* service.getTabHistorySnapshot()
    const pendingEntry = snapshot.entries.find((entry) => entry.pending)

    assert.equal(pendingEntry?.tabId, 30)
    assert.equal(pendingEntry?.createdAt, 123)
    assert.equal(snapshot.entries.some((entry) => entry.tabId === 10), false)
  }).pipe(Effect.provide(tabHistoryLayer(chromeApi)))
})
