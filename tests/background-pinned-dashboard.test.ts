import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import FakeTimers from '@sinonjs/fake-timers'
import { STARTUP_SNAPSHOT_DEBOUNCE_MS } from '../src/extension/background/startup-snapshot-service.js'
import { RETAINED_PAGES_EXPIRY_ALARM } from '../src/extension/background/retained-pages-expiry-alarm.js'
import { CLOSED_TAB_RESTORE_STATE_MESSAGE } from '../src/extension/closed-tabs.js'
import {
  decodeDashboardRetainedPagesWire,
  type DashboardRetainedPagesWire
} from '../src/extension/dashboard-retained-pages-wire.js'
import {
  CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
  RETAINED_PAGE_ACTIVATE_MESSAGE,
  RETAINED_PAGE_REMOVE_MESSAGE,
  SAVED_PAGE_ACTIVATE_MESSAGE
} from '../src/extension/runtime-messages.js'
import { SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import type { CapturedDashboardServiceState } from '../src/extension/dashboard-service-messages.js'
import { RETENTION_HEALTH_STORAGE_KEY } from '../src/extension/retention-health.js'
import {
  OPEN_SURFACE_DURABLE_STORAGE_KEY,
  OPEN_SURFACE_SESSION_STORAGE_KEY,
  parseOpenSurfaceInventoryValue
} from '../src/extension/open-surface-inventory-storage.js'
import { seedOpenSurfaceInventory } from '../src/extension/open-surface-inventory.js'
import {
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageLedger,
  type RetainedPageRecord,
  type RetainedPageRemovalBoundary
} from '../src/extension/retained-pages-ledger.js'
import {
  RETAINED_PAGES_STORAGE_KEY,
  RETAINED_PAGES_STORAGE_ENCODING,
  decodeRetainedPageLedgerStorageValue,
  encodeRetainedPageLedgerStorageValue,
  parseRetainedPageLedgerValue
} from '../src/extension/retained-pages-storage.js'
import {
  DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY,
  type DashboardStartupSeed
} from '../src/extension/startup-snapshot.js'
import { parseDashboardStartupSeedBoundary } from '../src/extension/startup-snapshot-schema.js'
import { normalizeChromeOpenTabs } from '../src/extension/tabs.js'
import type { TabHistorySnapshot } from '../src/extension/types'
import { buildWorkingSetSnapshot } from '../src/extension/working-set.js'

const backgroundUrl = new URL('../src/extension/background.ts', import.meta.url)
const extensionUrl = 'chrome-extension://tab-out/index.html'
let backgroundImportId = 0
const backgroundClock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })

type BackgroundMockCalls = {
  alarmsClear: string[]
  alarmsCreate: Array<{ name: string; alarmInfo: chrome.alarms.AlarmCreateInfo }>
  badgeColor: chrome.action.BadgeColorDetails[]
  badgeText: chrome.action.BadgeTextDetails[]
  badgeTitle: chrome.action.TitleDetails[]
  create: chrome.tabs.CreateProperties[]
  nativeHostNames: string[]
  nativeMessages: unknown[]
  remove: number[]
  runtimeMessages: Array<{ extensionId: string; message: unknown }>
  storageAccess: Array<{ area: 'local' | 'session'; accessLevel: string }>
  tabGet: number[]
  tabQuery: chrome.tabs.QueryInfo[]
  update: Array<{
    tabId: number
    updateProperties: chrome.tabs.UpdateProperties
  }>
  windowCreate: chrome.windows.CreateData[]
  windowsGetAll: chrome.windows.QueryOptions[]
  windowUpdate: Array<{
    windowId: number
    updateInfo: chrome.windows.UpdateInfo
  }>
}

type DashboardServiceMessageResponse =
  | ({ ok: true } & CapturedDashboardServiceState)
  | {
      ok: false
      openTabsSnapshot: null
      retainedPages: null
      retentionHealth: null
      tabHistory: null
      workingSetActivity: null
    }

type DashboardServiceWireResponse =
  | ({
      ok: true
      retainedPages: DashboardRetainedPagesWire
    } & Omit<CapturedDashboardServiceState, 'retainedPages'>)
  | Exclude<DashboardServiceMessageResponse, { ok: true }>

type TabHistoryMessageResponse =
  | { ok: true; snapshot: TabHistorySnapshot }
  | { ok: false; snapshot: null }

type RuntimeMessageListener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean

type BackgroundRuntimeMessageMock = {
  listeners: {
    runtimeOnMessage: RuntimeMessageListener[]
  }
}

test.after(() => backgroundClock.uninstall())
test.beforeEach(() => backgroundClock.reset())

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

function requireHistorySnapshot(response: TabHistoryMessageResponse): TabHistorySnapshot {
  assert.equal(response.ok, true, 'expected a successful tab-history response')
  return response.snapshot
}

function requireStartupSeed(value: unknown): DashboardStartupSeed {
  const seed = parseDashboardStartupSeedBoundary(value)
  assert.ok(seed, 'expected a compact startup seed')
  return seed
}

async function parseStoredRetainedPageLedger(value: unknown) {
  return parseRetainedPageLedgerValue(
    await decodeRetainedPageLedgerStorageValue(value)
  )
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createEventSlot() {
  const listeners: any[] = []
  return {
    listeners,
    api: {
      addListener(fn: any) {
        listeners.push(fn)
      }
    }
  }
}

function createStorageArea(
  values: Record<string, any>,
  area: 'local' | 'session',
  accessCalls: BackgroundMockCalls['storageAccess']
) {
  return {
    async setAccessLevel({ accessLevel }: { accessLevel: string }) {
      accessCalls.push({ area, accessLevel })
    },
    async get(keys: string | string[] | Record<string, any> | null = null) {
      if (typeof keys === 'string') return { [keys]: clone(values[keys]) }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, clone(values[key])]))
      }
      if (keys && typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, defaultValue]) => [
            key,
            values[key] === undefined ? clone(defaultValue) : clone(values[key])
          ])
        )
      }
      return clone(values)
    },
    async set(items: Record<string, any>) {
      Object.assign(values, clone(items))
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    }
  }
}

function normalizeWindowTabs(state: any, windowId: number) {
  const tabs = Object.values(state.tabsById as Record<string, any>).filter((tab) => tab.windowId === windowId)
  const pinned = tabs.filter((tab) => tab.pinned).sort((a, b) => a.index - b.index || a.id - b.id)
  const unpinned = tabs.filter((tab) => !tab.pinned).sort((a, b) => a.index - b.index || a.id - b.id)

  ;[...pinned, ...unpinned].forEach((tab, index) => {
    tab.index = index
  })
}

function normalizeAllTabs(state: any) {
  const windowIds = new Set(Object.values(state.tabsById as Record<string, any>).map((tab) => tab.windowId))
  for (const windowId of windowIds) {
    normalizeWindowTabs(state, windowId)
  }
}

function focusWindow(state: any, windowId: number) {
  Object.values(state.windowsById as Record<string, any>).forEach((win) => {
    win.focused = win.id === windowId
  })
  state.lastFocusedWindowId = windowId
}

function createChromeMock(initialTabs: any[], options: any = {}) {
  const runtimeOnInstalled = createEventSlot()
  const runtimeOnMessage = createEventSlot()
  const runtimeOnStartup = createEventSlot()
  const tabsOnCreated = createEventSlot()
  const tabsOnActivated = createEventSlot()
  const tabsOnRemoved = createEventSlot()
  const tabsOnMoved = createEventSlot()
  const tabsOnAttached = createEventSlot()
  const tabsOnDetached = createEventSlot()
  const tabsOnReplaced = createEventSlot()
  const tabsOnUpdated = createEventSlot()
  const windowsOnFocusChanged = createEventSlot()
  const tabGroupsOnCreated = createEventSlot()
  const tabGroupsOnUpdated = createEventSlot()
  const tabGroupsOnRemoved = createEventSlot()
  const tabGroupsOnMoved = createEventSlot()
  const commandsOnCommand = createEventSlot()
  const alarmsOnAlarm = createEventSlot()
  const actionOnClicked = createEventSlot()
  const sessionsOnChanged = createEventSlot()
  const storageOnChanged = createEventSlot()
  const nativePortOnMessage = createEventSlot()
  const nativePortOnDisconnect = createEventSlot()

  const initialWindowIds = [...new Set(initialTabs.map((tab) => tab.windowId))]
  const initialLastFocusedWindowId = initialTabs[0]?.windowId || 1
  const state: any = {
    tabsById: Object.fromEntries(initialTabs.map((tab) => [tab.id, { ...tab }])),
    windowsById: Object.fromEntries(
      initialWindowIds.map((windowId) => {
        const firstTab = initialTabs.find((tab) => tab.windowId === windowId)
        return [windowId, {
          id: windowId,
          type: firstTab?.windowType || 'normal',
          focused: windowId === initialLastFocusedWindowId,
          ...(firstTab?.windowBounds || {})
        }]
      })
    ),
    nextTabId: Math.max(...initialTabs.map((tab) => tab.id)) + 1,
    nextWindowId: Math.max(1, ...initialWindowIds) + 1,
    lastFocusedWindowId: initialLastFocusedWindowId
  }
  state.windowsById[initialLastFocusedWindowId] ||= {
    id: initialLastFocusedWindowId,
    type: 'normal',
    focused: true
  }
  normalizeAllTabs(state)

  const calls: BackgroundMockCalls = {
    alarmsClear: [],
    alarmsCreate: [],
    create: [],
    nativeHostNames: [],
    nativeMessages: [],
    windowCreate: [],
    remove: [],
    update: [],
    windowUpdate: [],
    runtimeMessages: [],
    storageAccess: [],
    badgeText: [],
    badgeColor: [],
    badgeTitle: [],
    tabGet: [],
    tabQuery: [],
    windowsGetAll: []
  }
  const storageValues = {
    local: clone(options.storageValues?.local || {}),
    session: clone(options.storageValues?.session || {})
  }
  const recentlyClosed = clone(options.recentlyClosed || [])
  const alarmsByName = new Map<string, chrome.alarms.Alarm>()
  let nextTabQueryFailure: Error | null = null

  const chrome: any = {
    runtime: {
      id: 'tab-out',
      onMessage: runtimeOnMessage.api,
      onInstalled: runtimeOnInstalled.api,
      onStartup: runtimeOnStartup.api,
      connectNative(hostName: string) {
        calls.nativeHostNames.push(hostName)
        return {
          onMessage: nativePortOnMessage.api,
          onDisconnect: nativePortOnDisconnect.api,
          postMessage(message: unknown) {
            calls.nativeMessages.push(clone(message))
          }
        }
      },
      async sendMessage(extensionId: string, message: any) {
        calls.runtimeMessages.push({ extensionId, message: clone(message) })
        if (extensionId === 'blocked') throw new Error('Cannot message extension')
        if (extensionId === 'rejects') return 'Error: tab is not suspended'
        return undefined
      }
    },
    system: {
      display: {
        async getInfo() {
          return clone(options.displays || [])
        }
      }
    },
    storage: {
      local: createStorageArea(storageValues.local, 'local', calls.storageAccess),
      session: createStorageArea(storageValues.session, 'session', calls.storageAccess),
      onChanged: storageOnChanged.api
    },
    alarms: {
      async create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) {
        calls.alarmsCreate.push({ name, alarmInfo: clone(alarmInfo) })
        alarmsByName.set(name, {
          name,
          scheduledTime: alarmInfo.when ?? Date.now()
        })
      },
      async get(name: string) {
        return clone(alarmsByName.get(name))
      },
      async clear(name: string) {
        calls.alarmsClear.push(name)
        return alarmsByName.delete(name)
      },
      onAlarm: alarmsOnAlarm.api
    },
    sessions: {
      getRecentlyClosed: async () => clone(recentlyClosed),
      onChanged: sessionsOnChanged.api
    },
    action: {
      onClicked: actionOnClicked.api,
      async setBadgeText(payload: chrome.action.BadgeTextDetails) {
        calls.badgeText.push(clone(payload))
      },
      async setBadgeBackgroundColor(payload: chrome.action.BadgeColorDetails) {
        calls.badgeColor.push(clone(payload))
      },
      async setTitle(payload: chrome.action.TitleDetails) {
        calls.badgeTitle.push(clone(payload))
      }
    },
    tabs: {
      async get(tabId: number) {
        calls.tabGet.push(tabId)
        const tab = state.tabsById[tabId]
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return clone(tab)
      },
      async query(queryInfo: any = {}) {
        calls.tabQuery.push(clone(queryInfo))
        if (nextTabQueryFailure) {
          const failure = nextTabQueryFailure
          nextTabQueryFailure = null
          throw failure
        }
        let tabs = Object.values(state.tabsById as Record<string, any>)
        if (queryInfo.windowId != null) tabs = tabs.filter((tab) => tab.windowId === queryInfo.windowId)
        if (queryInfo.active != null) tabs = tabs.filter((tab) => tab.active === queryInfo.active)
        if (queryInfo.lastFocusedWindow) tabs = tabs.filter((tab) => tab.windowId === state.lastFocusedWindowId)
        return tabs.sort((a, b) => a.index - b.index || a.id - b.id).map((tab) => clone(tab))
      },
      async update(
        tabId: number,
        updateProperties: chrome.tabs.UpdateProperties
      ) {
        const tab = state.tabsById[tabId]
        if (!tab) throw new Error(`Missing tab ${tabId}`)

        calls.update.push({ tabId, updateProperties: clone(updateProperties) })

        if (updateProperties.url !== undefined) {
          tab.url = updateProperties.url
          delete tab.pendingUrl
        }
        if (updateProperties.pinned !== undefined) {
          tab.pinned = updateProperties.pinned
        }
        if (updateProperties.openerTabId !== undefined) {
          tab.openerTabId = updateProperties.openerTabId
        }
        if (updateProperties.active) {
          Object.values(state.tabsById as Record<string, any>)
            .filter((candidate) => candidate.windowId === tab.windowId)
            .forEach((candidate) => {
              candidate.active = candidate.id === tabId
            })
          state.lastFocusedWindowId = tab.windowId
        }

        normalizeAllTabs(state)
        return clone(tab)
      },
      async create(createProperties: chrome.tabs.CreateProperties) {
        const windowId = createProperties.windowId ?? state.lastFocusedWindowId
        state.windowsById[windowId] ||= { id: windowId, type: 'normal', focused: false }
        const existingTabs = Object.values(state.tabsById as Record<string, any>).filter((tab) => tab.windowId === windowId)
        const nextIndex =
          typeof createProperties.index === 'number'
            ? createProperties.index
            : existingTabs.reduce((max, tab) => Math.max(max, tab.index), -1) + 1

        const tab: any = {
          id: state.nextTabId++,
          windowId,
          url: createProperties.url || 'chrome://newtab/',
          title: '',
          favIconUrl: '',
          active: createProperties.active !== false,
          pinned: !!createProperties.pinned,
          groupId: -1,
          index: nextIndex
        }
        if (typeof createProperties.openerTabId === 'number') {
          tab.openerTabId = createProperties.openerTabId
        }

        if (tab.active) {
          existingTabs.forEach((candidate) => {
            candidate.active = false
          })
          focusWindow(state, windowId)
        }

        state.tabsById[tab.id] = tab
        calls.create.push(clone(createProperties))
        normalizeAllTabs(state)
        for (const listener of tabsOnCreated.listeners) {
          listener(clone(tab))
        }
        return clone(tab)
      },
      async remove(tabIds: number | number[]) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        calls.remove.push(...ids)
        const removedTabs = []
        for (const tabId of ids) {
          if (state.tabsById[tabId]) removedTabs.push(clone(state.tabsById[tabId]))
          delete state.tabsById[tabId]
        }

        for (const tab of removedTabs) {
          if (!tab.active) continue
          const remainingTabs = Object.values(state.tabsById as Record<string, any>)
            .filter((candidate) => candidate.windowId === tab.windowId)
            .sort((a, b) => a.index - b.index || a.id - b.id)
          const opener = remainingTabs.find((candidate) => candidate.id === tab.openerTabId)
          const neighbor = remainingTabs.find((candidate) => candidate.index > tab.index) || remainingTabs.at(-1)
          const nextActive = opener || neighbor
          if (!nextActive) continue
          remainingTabs.forEach((candidate) => {
            candidate.active = candidate.id === nextActive.id
          })
          state.lastFocusedWindowId = nextActive.windowId
        }

        normalizeAllTabs(state)
        for (const tab of removedTabs) {
          for (const listener of tabsOnRemoved.listeners) {
            listener(tab.id, { windowId: tab.windowId, isWindowClosing: false })
          }
        }
      },
      onCreated: tabsOnCreated.api,
      onActivated: tabsOnActivated.api,
      onRemoved: tabsOnRemoved.api,
      onMoved: tabsOnMoved.api,
      onAttached: tabsOnAttached.api,
      onDetached: tabsOnDetached.api,
      onReplaced: tabsOnReplaced.api,
      onUpdated: tabsOnUpdated.api
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: windowsOnFocusChanged.api,
      async getLastFocused(queryOptions: any = {}) {
        let windows = Object.values(state.windowsById as Record<string, any>)
        if (queryOptions.windowTypes) windows = windows.filter((win) => queryOptions.windowTypes.includes(win.type))
        const focusedWindow = windows.find((win) => win.id === state.lastFocusedWindowId) || windows.find((win) => win.focused) || windows[0]
        if (!focusedWindow) throw new Error('No matching focused window')
        return clone(focusedWindow)
      },
      async getCurrent() {
        const currentWindow = state.windowsById[state.lastFocusedWindowId] ||
          Object.values(state.windowsById as Record<string, any>).find((win) => win.focused)
        if (!currentWindow) throw new Error('No current window')
        return clone(currentWindow)
      },
      async getAll(queryOptions: any = {}) {
        calls.windowsGetAll.push(clone(queryOptions))
        let windows = Object.values(state.windowsById as Record<string, any>)
        if (queryOptions.windowTypes) windows = windows.filter((win) => queryOptions.windowTypes.includes(win.type))
        return windows.map((win) => clone(win))
      },
      async update(
        windowId: number,
        updateInfo: chrome.windows.UpdateInfo
      ) {
        const win = state.windowsById[windowId]
        if (!win) throw new Error(`Missing window ${windowId}`)
        calls.windowUpdate.push({ windowId, updateInfo: clone(updateInfo) })
        for (const property of ['height', 'left', 'state', 'top', 'width'] as const) {
          if (updateInfo[property] !== undefined) win[property] = updateInfo[property]
        }
        if (updateInfo.focused) focusWindow(state, windowId)
        return clone(win)
      },
      async create(createData: any = {}) {
        const windowId = state.nextWindowId++
        state.windowsById[windowId] = {
          id: windowId,
          type: createData.type || 'normal',
          state: createData.state || 'normal',
          focused: false,
          left: createData.left,
          top: createData.top,
          width: createData.width,
          height: createData.height
        }
        if (createData.focused !== false) focusWindow(state, windowId)
        calls.windowCreate.push(clone(createData))
        return clone(state.windowsById[windowId])
      }
    },
    tabGroups: {
      onCreated: tabGroupsOnCreated.api,
      onUpdated: tabGroupsOnUpdated.api,
      onRemoved: tabGroupsOnRemoved.api,
      onMoved: tabGroupsOnMoved.api
    },
    commands: {
      onCommand: commandsOnCommand.api
    }
  }

  return {
    chrome,
    calls,
    state,
    storageValues,
    recentlyClosed,
    listeners: {
      actionOnClicked: actionOnClicked.listeners,
      alarmsOnAlarm: alarmsOnAlarm.listeners,
      runtimeOnInstalled: runtimeOnInstalled.listeners,
      runtimeOnMessage: runtimeOnMessage.listeners,
      runtimeOnStartup: runtimeOnStartup.listeners,
      nativePortOnMessage: nativePortOnMessage.listeners,
      tabsOnCreated: tabsOnCreated.listeners,
      tabsOnActivated: tabsOnActivated.listeners,
      tabsOnRemoved: tabsOnRemoved.listeners,
      tabsOnReplaced: tabsOnReplaced.listeners,
      tabsOnUpdated: tabsOnUpdated.listeners,
      windowsOnFocusChanged: windowsOnFocusChanged.listeners,
      sessionsOnChanged: sessionsOnChanged.listeners,
      commandsOnCommand: commandsOnCommand.listeners
    },
    getWindowTabs(windowId: number) {
      return Object.values(state.tabsById as Record<string, any>)
        .filter((tab) => tab.windowId === windowId)
        .sort((a, b) => a.index - b.index || a.id - b.id)
        .map((tab) => clone(tab))
    },
    blurAllWindows(lastFocusedWindowId = state.lastFocusedWindowId) {
      state.lastFocusedWindowId = lastFocusedWindowId
      Object.values(state.windowsById as Record<string, any>).forEach((win) => {
        win.focused = false
      })
    },
    failNextTabQuery(message = 'Tab query unavailable') {
      nextTabQueryFailure = new Error(message)
    },
    activateTab(tabId: number) {
      const tab = state.tabsById[tabId]
      if (!tab) throw new Error(`Missing tab ${tabId}`)
      Object.values(state.tabsById as Record<string, any>)
        .filter((candidate) => candidate.windowId === tab.windowId)
        .forEach((candidate) => {
          candidate.active = candidate.id === tabId
        })
      focusWindow(state, tab.windowId)
    },
    closeTabForWindow(tabId: number) {
      const tab = state.tabsById[tabId]
      if (!tab) throw new Error(`Missing tab ${tabId}`)
      delete state.tabsById[tabId]
      normalizeAllTabs(state)
      for (const listener of tabsOnRemoved.listeners) {
        listener(tab.id, { windowId: tab.windowId, isWindowClosing: true })
      }
    },
    async replaceTab(removedTabId: number, addedTabId: number) {
      const removedTab = state.tabsById[removedTabId]
      if (!removedTab) throw new Error(`Missing tab ${removedTabId}`)
      delete state.tabsById[removedTabId]
      state.tabsById[addedTabId] = { ...removedTab, id: addedTabId }
      state.nextTabId = Math.max(state.nextTabId, addedTabId + 1)
      const tasks = tabsOnReplaced.listeners.map((listener) => listener(addedTabId, removedTabId))
      await Promise.all(tasks.filter((task) => task instanceof Promise))
    }
  }
}

function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: { type: 'tab-out:get-dashboard-service-state' }
): Promise<DashboardServiceMessageResponse>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: typeof CLOSED_TAB_RETENTION_SETTLE_MESSAGE
    tabId: number
  }
): Promise<{ ok: boolean }>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: 'tab-out:get-tab-history' | 'tab-out:switch-tab-history'
    direction?: -1 | 1
  }
): Promise<TabHistoryMessageResponse>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: typeof CLOSED_TAB_RESTORE_STATE_MESSAGE
    phase: 'settled' | 'started'
    restoreId: string
  }
): Promise<{ ok: boolean }>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: typeof RETAINED_PAGE_ACTIVATE_MESSAGE
    identityDigest: string
    closureToken: string
    disposition: 'focus-tab' | 'foreground-tab' | 'background-tab' | 'new-window'
  }
): Promise<{ ok: boolean; outcome?: string }>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: typeof SAVED_PAGE_ACTIVATE_MESSAGE
    url: string
    surfaceKind: 'normal-tab' | 'app'
    disposition: 'focus-tab' | 'foreground-tab' | 'background-tab' | 'new-window'
  }
): Promise<{ ok: boolean; outcome?: string }>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: typeof RETAINED_PAGE_REMOVE_MESSAGE
    identityDigest: string
    closureToken: string
  }
): Promise<{ ok: boolean; outcome?: string }>
async function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: Record<string, unknown>
): Promise<unknown> {
  const response = await sendRawRuntimeMessage(mock, message)
  if (
    message.type === 'tab-out:get-dashboard-service-state' &&
    typeof response === 'object' && response !== null &&
    Reflect.get(response, 'ok') === true
  ) {
    const wireResponse = response as DashboardServiceWireResponse & { ok: true }
    return {
      ...wireResponse,
      retainedPages: await decodeDashboardRetainedPagesWire(
        wireResponse.retainedPages
      )
    }
  }
  return response
}

function sendRawRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: Record<string, unknown>
): Promise<unknown> {
  const onMessage = mock.listeners.runtimeOnMessage[0]
  assert.ok(onMessage, 'expected a registered runtime message listener')
  return new Promise((resolve) => {
    const keepAlive = onMessage(message, {}, resolve)
    assert.equal(keepAlive, true)
  })
}

function buildWorkingSetFromServiceState(response: CapturedDashboardServiceState) {
  const focusedWindow = response.openTabsSnapshot.windows.find((win: chrome.windows.Window) => win.focused)
  return buildWorkingSetSnapshot({
    tabs: normalizeChromeOpenTabs(response.openTabsSnapshot),
    activity: response.workingSetActivity,
    currentWindowId: focusedWindow?.id ?? null
  })
}

async function flushBackgroundWork() {
  for (let pass = 0; pass < 6; pass += 1) await setImmediate()
}

async function loadBackground(initialTabs: any[], options: any = {}) {
  const mock = createChromeMock(initialTabs, options)
  ;(globalThis as any).chrome = mock.chrome
  await import(`${backgroundUrl.href}?test=${backgroundImportId++}`)
  if (!options.deferInitialOpenSurfaceReconciliation) {
    await backgroundClock.tickAsync(0)
  }
  await flushBackgroundWork()
  return mock
}

async function loadBackgroundWithPendingLinkTabs() {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  onFocusChanged(1)
  await flushBackgroundWork()

  for (const url of ['https://bravo.example/', 'https://charlie.example/']) {
    await mock.chrome.tabs.create({
      windowId: 1,
      url,
      active: false,
      openerTabId: 81
    })
  }
  await flushBackgroundWork()
  return mock
}

test('retention storage is restricted to trusted extension contexts before use', async () => {
  const mock = await loadBackground([{
    id: 10,
    windowId: 1,
    url: 'https://example.test/article',
    title: 'Example article',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }])

  assert.deepEqual(mock.calls.storageAccess, [
    { area: 'local', accessLevel: 'TRUSTED_CONTEXTS' },
    { area: 'session', accessLevel: 'TRUSTED_CONTEXTS' }
  ])
})

test('pinned Tab Out navigation follows Chrome default without dashboard replacement', async () => {
  const mock = await loadBackground([
    {
      id: 11,
      windowId: 1,
      url: 'chrome://newtab/',
      title: 'New Tab',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 12,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onUpdated, 'function')

  await onUpdated(11, { status: 'loading' }, { ...clone(mock.state.tabsById[11]), pendingUrl: 'https://example.com/docs' })
  await flushBackgroundWork()
  mock.state.tabsById[11].url = 'https://example.com/docs'
  delete mock.state.tabsById[11].pendingUrl
  await onUpdated(11, { url: 'https://example.com/docs', status: 'loading' }, clone(mock.state.tabsById[11]))
  await flushBackgroundWork()

  const windowTabs = mock.getWindowTabs(1)

  assert.equal(mock.calls.create.length, 0)
  assert.equal(mock.calls.update.some((call) => call.updateProperties.pinned === false), false)
  assert.equal(windowTabs[0].id, 11)
  assert.equal(windowTabs[0].url, 'https://example.com/docs')
  assert.equal(windowTabs[0].pinned, true)
  assert.equal(windowTabs[0].active, true)
})

test('service worker lifecycle does not rewrite native new tabs into extension URLs', async () => {
  const mock = await loadBackground([
    {
      id: 21,
      windowId: 1,
      url: 'chrome://newtab/',
      title: 'New Tab',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === extensionUrl), false)

  await mock.listeners.runtimeOnStartup[0]()
  await flushBackgroundWork()
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === extensionUrl), false)

  await mock.listeners.runtimeOnInstalled[0]({ reason: 'install' })
  await flushBackgroundWork()
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === extensionUrl), false)
})

test('metadata-only tab updates do not trigger redundant badge tab queries', async () => {
  const mock = await loadBackground([
    {
      id: 25,
      windowId: 1,
      url: 'https://example.test/',
      title: 'Example',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onUpdated, 'function')
  const queriesBeforeUpdate = mock.calls.tabQuery.length

  onUpdated(25, { title: 'Updated', status: 'complete' }, { ...mock.state.tabsById[25], title: 'Updated' })
  await flushBackgroundWork()
  assert.equal(mock.calls.tabQuery.length, queriesBeforeUpdate)

  onUpdated(25, { url: 'https://example.test/next' }, { ...mock.state.tabsById[25], url: 'https://example.test/next' })
  await flushBackgroundWork()
  assert.equal(mock.calls.tabQuery.length, queriesBeforeUpdate + 1)
})

test('toolbar badge counts closable duplicates and clicking it runs global dedupe', async () => {
  const duplicateUrl = 'https://duplicate.example.test/docs'
  const groupedUrl = 'https://grouped.example.test/docs'
  const mock = await loadBackground([
    {
      id: 41,
      windowId: 1,
      url: duplicateUrl,
      title: 'Current copy',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 42,
      windowId: 1,
      url: duplicateUrl,
      title: 'Duplicate copy',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 43,
      windowId: 1,
      url: groupedUrl,
      title: 'Group one',
      active: false,
      pinned: false,
      groupId: 7,
      index: 2
    },
    {
      id: 44,
      windowId: 1,
      url: groupedUrl,
      title: 'Group two',
      active: false,
      pinned: false,
      groupId: 8,
      index: 3
    }
  ])

  assert.deepEqual(mock.calls.badgeText.at(-1), { text: '1' })
  assert.deepEqual(mock.calls.badgeTitle.at(-1), { title: 'Dedupe 1 duplicate tab' })
  const onClicked = mock.listeners.actionOnClicked[0]
  assert.equal(typeof onClicked, 'function')

  await onClicked(clone(mock.state.tabsById[41]))
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.remove, [42])
  assert.deepEqual(mock.getWindowTabs(1).map((tab: any) => tab.id), [41, 43, 44])
  assert.deepEqual(mock.calls.badgeText.at(-1), { text: '' })
  assert.deepEqual(mock.calls.badgeTitle.at(-1), { title: 'Tab Out: no duplicates to dedupe' })
})

test('dashboard service state captures tabs and windows once for both open tabs and history', async () => {
  const mock = await loadBackground([
    {
      id: 26,
      windowId: 1,
      url: 'https://example.test/current',
      title: 'Current',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const allTabsReadsBefore = mock.calls.tabQuery.filter((query: any) => Object.keys(query).length === 0).length
  const allWindowsReadsBefore = mock.calls.windowsGetAll.length

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })

  assert.equal(response.ok, true)
  assert.deepEqual(response.openTabsSnapshot.tabs.map((tab: any) => tab.id), [26])
  assert.equal(response.tabHistory.activeTabId, 26)
  assert.equal(
    mock.calls.tabQuery.filter((query: any) => Object.keys(query).length === 0).length - allTabsReadsBefore,
    1
  )
  assert.equal(mock.calls.windowsGetAll.length - allWindowsReadsBefore, 1)
})

test('dashboard service state transports retained pages only through its projection wire', async () => {
  const mock = await loadBackground([{
    id: 27,
    windowId: 1,
    url: 'https://example.test/current',
    title: 'Current',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }])

  const response = await sendRawRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  }) as DashboardServiceWireResponse

  assert.equal(response.ok, true)
  assert.equal(Array.isArray(response.retainedPages), false)
  assert.deepEqual(Object.keys(response.retainedPages).sort(), [
    'data',
    'encoding',
    'identityVersion',
    'schemaVersion'
  ])
  assert.deepEqual(
    await decodeDashboardRetainedPagesWire(response.retainedPages),
    []
  )
})

test('dashboard service state exposes the session-only retention health episode', async () => {
  const episode = {
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry',
    startedAt: 100,
    lastFailedAt: 150
  }
  const mock = await loadBackground([{
    id: 26,
    windowId: 1,
    url: 'https://example.test/current',
    title: 'Current',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }], {
    storageValues: {
      session: { [RETENTION_HEALTH_STORAGE_KEY]: episode }
    }
  })

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  })

  assert.equal(response.ok, true)
  assert.deepEqual(response.retentionHealth, episode)
  assert.equal(mock.storageValues.local[RETENTION_HEALTH_STORAGE_KEY], undefined)
})

test('background captures a physical close and activates its exact retained snapshot', async () => {
  const exactUrl = 'https://retained.example.test/article?view=exact#comment'
  const mock = await loadBackground([
    {
      id: 259,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 260,
      windowId: 1,
      url: exactUrl,
      title: 'Retained article',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])
  let retainedLedgerWrites = 0
  let retainedLedgerReads = 0
  const originalLocalGet = mock.chrome.storage.local.get.bind(mock.chrome.storage.local)
  const originalLocalSet = mock.chrome.storage.local.set.bind(mock.chrome.storage.local)
  mock.chrome.storage.local.get = async (keys: unknown) => {
    if (
      keys === RETAINED_PAGES_STORAGE_KEY ||
      (Array.isArray(keys) && keys.includes(RETAINED_PAGES_STORAGE_KEY))
    ) retainedLedgerReads += 1
    return originalLocalGet(keys)
  }
  mock.chrome.storage.local.set = async (items: Record<string, unknown>) => {
    if (Object.hasOwn(items, RETAINED_PAGES_STORAGE_KEY)) retainedLedgerWrites += 1
    await originalLocalSet(items)
  }

  mock.closeTabForWindow(260)
  const settled = await Promise.all([1, 2].map(() => sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
    tabId: 260
  })))
  assert.deepEqual(settled, [{ ok: true }, { ok: true }])
  assert.equal(retainedLedgerWrites, 1)
  assert.equal(retainedLedgerReads, 1)
  await flushBackgroundWork()
  const captured = await sendRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  })
  assert.equal(captured.ok, true)
  assert.equal(captured.retainedPages.length, 1)
  const retained = captured.retainedPages[0]
  assert.ok(retained)
  assert.equal(retained.url, exactUrl)

  const activated = await sendRuntimeMessage(mock, {
    type: RETAINED_PAGE_ACTIVATE_MESSAGE,
    identityDigest: retained.identityDigest,
    closureToken: retained.closureToken,
    disposition: 'foreground-tab'
  })
  await flushBackgroundWork()

  assert.deepEqual(activated, { ok: true, outcome: 'activated' })
  assert.equal(mock.calls.create.at(-1)?.url, exactUrl)
  const after = await sendRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  })
  assert.equal(after.ok, true)
  assert.deepEqual(after.retainedPages, [])
})

test('a delayed tab update checkpoint contributes the newest target before physical close', async () => {
  const originalUrl = 'https://example.test/original'
  const mock = await loadBackground([{
    id: 262,
    windowId: 1,
    url: originalUrl,
    title: 'Original',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }])
  let resolveWindow: ((window: chrome.windows.Window) => void) | undefined
  mock.chrome.windows.get = () => new Promise<chrome.windows.Window>((resolve) => {
    resolveWindow = resolve
  })
  const onUpdated = valueAt(mock.listeners.tabsOnUpdated, 0)
  onUpdated(262, {
    url: 'https://example.test/late-update'
  }, {
    ...clone(mock.state.tabsById[262]),
    url: 'https://example.test/late-update',
    title: 'Late update'
  })
  // Let the adjacent checkpoint enter its asynchronous window capture before
  // Chrome immediately delivers the physical close.
  await setImmediate()

  await mock.chrome.tabs.remove(262)
  resolveWindow?.({ id: 1, type: 'normal' } as chrome.windows.Window)
  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
    tabId: 262
  }), { ok: true })

  const session = parseOpenSurfaceInventoryValue(
    mock.storageValues.session[OPEN_SURFACE_SESSION_STORAGE_KEY]
  )
  const durable = parseOpenSurfaceInventoryValue(
    mock.storageValues.local[OPEN_SURFACE_DURABLE_STORAGE_KEY]
  )
  const ledger = await parseStoredRetainedPageLedger(
    mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
  )
  assert.equal(session.status, 'valid')
  assert.equal(durable.status, 'valid')
  assert.equal(ledger.status, 'valid')
  assert.deepEqual(session.inventory.entries, {})
  assert.deepEqual(durable.inventory.entries, {})
  assert.equal(
    Object.values(ledger.ledger.pages)[0]?.url,
    'https://example.test/late-update'
  )
})

test('a delayed checkpoint lookup failure preserves the prior target for physical close', async () => {
  const originalUrl = 'https://example.test/original-before-failed-checkpoint'
  const mock = await loadBackground([{
    id: 264,
    windowId: 1,
    url: originalUrl,
    title: 'Original target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }])
  let rejectWindow: ((cause: Error) => void) | undefined
  mock.chrome.windows.get = () => new Promise<chrome.windows.Window>((_resolve, reject) => {
    rejectWindow = reject
  })
  const onUpdated = valueAt(mock.listeners.tabsOnUpdated, 0)
  onUpdated(264, {
    url: 'https://example.test/unconfirmed-update'
  }, {
    ...clone(mock.state.tabsById[264]),
    url: 'https://example.test/unconfirmed-update',
    title: 'Unconfirmed update'
  })
  await setImmediate()

  await mock.chrome.tabs.remove(264)
  rejectWindow?.(new Error('Window metadata disappeared'))
  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
    tabId: 264
  }), { ok: true })

  const ledger = await parseStoredRetainedPageLedger(
    mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
  )
  assert.equal(ledger.status, 'valid')
  assert.equal(Object.values(ledger.ledger.pages)[0]?.url, originalUrl)
})

test('an immediately closed pending navigation retains its newest effective target', async () => {
  const originalUrl = 'https://example.test/original'
  const pendingUrl = 'https://example.test/pending-target'
  const mock = await loadBackground([{
    id: 263,
    windowId: 1,
    url: originalUrl,
    title: 'Original',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }])
  mock.chrome.windows.get = async (windowId: number) => {
    const window = mock.state.windowsById[windowId]
    if (!window) throw new Error(`Missing window ${windowId}`)
    return clone(window)
  }
  const onUpdated = valueAt(mock.listeners.tabsOnUpdated, 0)

  onUpdated(263, { status: 'loading' }, {
    ...clone(mock.state.tabsById[263]),
    pendingUrl,
    title: 'Navigating'
  })
  await mock.chrome.tabs.remove(263)
  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
    tabId: 263
  }), { ok: true })

  const ledger = await parseStoredRetainedPageLedger(
    mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
  )
  assert.equal(ledger.status, 'valid')
  assert.equal(Object.values(ledger.ledger.pages)[0]?.url, pendingUrl)
})

test('background removes one exact retained snapshot without a browser action', async () => {
  const mock = await loadBackground([
    {
      id: 259,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 261,
      windowId: 1,
      url: 'https://retained.example.test/remove',
      title: 'Remove retained',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  mock.closeTabForWindow(261)
  await flushBackgroundWork()
  const captured = await sendRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  })
  assert.equal(captured.ok, true)
  const retained = captured.retainedPages[0]
  assert.ok(retained)
  const createCount = mock.calls.create.length

  const removed = await sendRuntimeMessage(mock, {
    type: RETAINED_PAGE_REMOVE_MESSAGE,
    identityDigest: retained.identityDigest,
    closureToken: retained.closureToken
  })
  await flushBackgroundWork()

  assert.deepEqual(removed, { ok: true, outcome: 'removed' })
  assert.equal(mock.calls.create.length, createCount)
  const after = await sendRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  })
  assert.equal(after.ok, true)
  assert.deepEqual(after.retainedPages, [])
})

for (const action of ['explicit removal', 'activation consumption'] as const) {
  test(`over-quota ${action} preserves the compressed retained ledger atomically`, async () => {
    const identityDigest = 'a'.repeat(64)
    const closureToken = 'b'.repeat(32)
    const priorBoundaryToken = 'c'.repeat(32)
    const url = 'https://quota.example.test/article'
    const closedAt = Date.now()
    const page: RetainedPageRecord = {
      identityDigest,
      surfaceKind: 'normal-tab',
      canonicalKey: url,
      url,
      title: 'Quota-preserved page',
      closedAt,
      closureToken
    }
    const priorBoundary: RetainedPageRemovalBoundary = {
      identityDigest,
      closureToken: priorBoundaryToken,
      expiresAt: closedAt + RETAINED_PAGE_LIFETIME_MS
    }
    // This older lifetime of the same identity is already replay-blocked. A
    // successful action would atomically replace its boundary with the current
    // lifetime's boundary; quota rejection must preserve the prior guard and
    // the still-visible current snapshot together.
    const ledger: RetainedPageLedger = {
      schemaVersion: 1,
      identityVersion: 1,
      pages: { [identityDigest]: page },
      removalBoundaries: { [priorBoundaryToken]: priorBoundary }
    }
    const compressed = await encodeRetainedPageLedgerStorageValue(ledger)
    const mock = await loadBackground([{
      id: 269,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    }], {
      storageValues: {
        local: { [RETAINED_PAGES_STORAGE_KEY]: compressed }
      }
    })
    const storedBefore = Buffer.from(JSON.stringify(
      mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
    ), 'utf8')
    const attemptedRetainedValues: unknown[] = []
    const originalLocalSet = mock.chrome.storage.local.set.bind(
      mock.chrome.storage.local
    )
    mock.chrome.storage.local.set = async (items: Record<string, unknown>) => {
      if (Object.hasOwn(items, RETAINED_PAGES_STORAGE_KEY)) {
        attemptedRetainedValues.push(clone(items[RETAINED_PAGES_STORAGE_KEY]))
        throw new Error('QUOTA_BYTES quota exceeded')
      }
      return originalLocalSet(items)
    }

    const response = action === 'explicit removal'
      ? await sendRuntimeMessage(mock, {
          type: RETAINED_PAGE_REMOVE_MESSAGE,
          identityDigest,
          closureToken
        })
      : await sendRuntimeMessage(mock, {
          type: RETAINED_PAGE_ACTIVATE_MESSAGE,
          identityDigest,
          closureToken,
          disposition: 'foreground-tab'
        })
    await flushBackgroundWork()

    assert.deepEqual(
      response,
      action === 'explicit removal'
        ? { ok: false }
        : { ok: true, outcome: 'activated-unconsumed' }
    )
    if (action === 'activation consumption') {
      assert.equal(mock.calls.create.at(-1)?.url, url)
    }
    assert.equal(attemptedRetainedValues.length, 1, 'explicit writes must not retry')

    const attempted = await parseStoredRetainedPageLedger(
      attemptedRetainedValues[0]
    )
    assert.equal(attempted.status, 'valid')
    if (attempted.status !== 'valid') return
    assert.equal(attempted.ledger.pages[identityDigest], undefined)
    assert.deepEqual(attempted.ledger.removalBoundaries, {
      [closureToken]: {
        identityDigest,
        closureToken,
        expiresAt: closedAt + RETAINED_PAGE_LIFETIME_MS
      }
    })

    const storedAfter = Buffer.from(JSON.stringify(
      mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
    ), 'utf8')
    assert.deepEqual(storedAfter, storedBefore)
    assert.match(storedAfter.toString('utf8'), new RegExp(
      `"encoding":"${RETAINED_PAGES_STORAGE_ENCODING}"`
    ))
    const preserved = await parseStoredRetainedPageLedger(
      mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
    )
    assert.equal(preserved.status, 'valid')
    if (preserved.status !== 'valid') return
    assert.deepEqual(preserved.ledger.pages, { [identityDigest]: page })
    assert.deepEqual(preserved.ledger.removalBoundaries, {
      [priorBoundaryToken]: priorBoundary
    })

    await backgroundClock.tickAsync(60_000)
    await flushBackgroundWork()
    assert.equal(
      attemptedRetainedValues.length,
      1,
      'quota failure must not schedule a later retained-ledger retry'
    )
  })
}

test('background opens an exact closed Saved Page without mutating saved state', async () => {
  const savedUrl = 'chrome://settings/privacy'
  const savedStore = {
    version: 2,
    pages: {
      [savedUrl]: {
        key: savedUrl,
        surfaceKind: 'normal-tab',
        url: savedUrl,
        title: 'Privacy settings',
        savedAt: 100,
        updatedAt: 100
      }
    }
  }
  const mock = await loadBackground([{
    id: 263,
    windowId: 1,
    url: extensionUrl,
    title: 'Tab Out',
    active: true,
    pinned: true,
    groupId: -1,
    index: 0
  }], {
    storageValues: {
      local: { [SAVED_PAGES_STORAGE_KEY]: savedStore }
    }
  })

  const opened = await sendRuntimeMessage(mock, {
    type: SAVED_PAGE_ACTIVATE_MESSAGE,
    url: savedUrl,
    surfaceKind: 'normal-tab',
    disposition: 'foreground-tab'
  })
  const createCount = mock.calls.create.length
  const blocked = await sendRuntimeMessage(mock, {
    type: SAVED_PAGE_ACTIVATE_MESSAGE,
    url: 'javascript:alert(1)',
    surfaceKind: 'normal-tab',
    disposition: 'foreground-tab'
  })

  assert.deepEqual(opened, { ok: true, outcome: 'activated' })
  assert.equal(mock.calls.create.at(-1)?.url, savedUrl)
  assert.deepEqual(blocked, { ok: true, outcome: 'failed' })
  assert.equal(mock.calls.create.length, createCount)
  assert.deepEqual(
    mock.storageValues.local[SAVED_PAGES_STORAGE_KEY],
    savedStore
  )
})

test('tab activation shares one captured tab across history and Working Set', async () => {
  const tab = {
    id: 27,
    windowId: 1,
    url: 'https://activation.example.test/current',
    title: 'Activation target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }
  const mock = await loadBackground([tab])
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')
  const tabGetsBefore = mock.calls.tabGet.length
  const tabQueriesBefore = mock.calls.tabQuery.length

  onActivated({ tabId: tab.id, windowId: tab.windowId })
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.tabGet.slice(tabGetsBefore), [tab.id])
  assert.deepEqual(
    mock.calls.tabQuery.slice(tabQueriesBefore),
    [{}],
    'history and Working Set share the exact-tab lookup while the badge reads global dedupe eligibility'
  )

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(response.ok, true)
  assert.equal(response.tabHistory.entries.some((entry: any) => entry.tabId === tab.id), true)
  assert.equal(
    Object.values(response.workingSetActivity.records).some((record: any) => record.url === tab.url),
    true
  )
})

test('failed shared activation capture falls back without dropping either service update', async () => {
  const tab = {
    id: 29,
    windowId: 1,
    url: 'https://activation.example.test/fallback',
    title: 'Activation fallback target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }
  const mock = await loadBackground([tab])
  const originalGet = mock.chrome.tabs.get.bind(mock.chrome.tabs)
  let firstLookup = true
  mock.chrome.tabs.get = async (tabId: number) => {
    if (firstLookup) {
      firstLookup = false
      throw new Error('transient shared tab capture failure')
    }
    return originalGet(tabId)
  }
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')

  onActivated({ tabId: tab.id, windowId: tab.windowId })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(response.ok, true)
  assert.equal(response.tabHistory.entries.some((entry: any) => entry.tabId === tab.id), true)
  assert.equal(
    Object.values(response.workingSetActivity.records).some((record: any) => record.url === tab.url),
    true
  )
})

test('window focus shares one active-tab query across history and Working Set', async () => {
  const tab = {
    id: 28,
    windowId: 1,
    url: 'https://focus.example.test/current',
    title: 'Focus target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }
  const mock = await loadBackground([tab])
  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  const tabGetsBefore = mock.calls.tabGet.length
  const tabQueriesBefore = mock.calls.tabQuery.length

  onFocusChanged(tab.windowId)
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.tabGet.slice(tabGetsBefore), [])
  assert.deepEqual(mock.calls.tabQuery.slice(tabQueriesBefore), [
    {},
    { windowId: tab.windowId, active: true }
  ])

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(response.ok, true)
  assert.equal(response.tabHistory.entries.some((entry: any) => entry.tabId === tab.id), true)
  assert.equal(
    Object.values(response.workingSetActivity.records).some((record: any) => record.url === tab.url),
    true
  )
})

test('filter shortcut opens a fresh focus-ready Tab Out tab from a normal page', async () => {
  const mock = await loadBackground([
    {
      id: 31,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create.at(-1), {
    windowId: 1,
    url: `${extensionUrl}?focusFilter=1`,
    active: true
  })

  const createdTab = Object.values(mock.state.tabsById as Record<string, any>).find((tab) => tab.url === `${extensionUrl}?focusFilter=1`)
  assert.ok(createdTab)
  assert.equal(createdTab.active, true)
  assert.equal(createdTab.pinned, false)
})

test('filter shortcut opens a fresh focus-ready Tab Out tab from an existing Tab Out page', async () => {
  const mock = await loadBackground([
    {
      id: 41,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 42,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 1,
      url: `${extensionUrl}?focusFilter=1`,
      active: true
    }
  ])
  assert.deepEqual(mock.calls.remove, [])
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === `${extensionUrl}?focusFilter=1`), false)
  assert.equal(mock.state.tabsById[41].url, extensionUrl)
  assert.equal(mock.state.tabsById[41].active, false)
  assert.equal(mock.state.tabsById[41].pinned, false)
  assert.equal(mock.state.tabsById[42].active, false)
  assert.equal(mock.state.tabsById[43].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[43].active, true)
  assert.equal(mock.state.tabsById[43].pinned, false)
})

test('filter shortcut opens an unpinned fresh Tab Out tab from a pinned active dashboard', async () => {
  const mock = await loadBackground([
    {
      id: 61,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 62,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 1,
      url: `${extensionUrl}?focusFilter=1`,
      active: true
    }
  ])
  assert.deepEqual(mock.calls.remove, [])
  assert.equal(mock.state.tabsById[61].url, extensionUrl)
  assert.equal(mock.state.tabsById[61].active, false)
  assert.equal(mock.state.tabsById[61].pinned, true)
  assert.equal(mock.state.tabsById[62].active, false)
  assert.equal(mock.state.tabsById[63].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[63].active, true)
  assert.equal(mock.state.tabsById[63].pinned, false)
})

test('filter shortcut opens in a normal browser window when a standalone app window is focused', async () => {
  const mock = await loadBackground([
    {
      id: 71,
      windowId: 10,
      windowType: 'popup',
      url: 'https://mail.google.com/mail/u/0/',
      title: 'Inbox',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 72,
      windowId: 2,
      windowType: 'normal',
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 2,
      url: `${extensionUrl}?focusFilter=1`,
      active: true
    }
  ])
  assert.deepEqual(mock.calls.windowUpdate.at(-1), {
    windowId: 2,
    updateInfo: { focused: true }
  })
  assert.equal(mock.state.tabsById[73].windowId, 2)
  assert.equal(mock.state.tabsById[73].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[73].active, true)
})

test('global new-tab shortcut opens a native new tab in the last focused normal window', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  mock.blurAllWindows()
  onCommand('open-new-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create.at(-1), {
    windowId: 1,
    active: true
  })
  assert.deepEqual(mock.calls.windowUpdate.at(-1), {
    windowId: 1,
    updateInfo: { focused: true }
  })

  const createdTab = Object.values(mock.state.tabsById as Record<string, any>).find((tab) => tab.url === 'chrome://newtab/')
  assert.ok(createdTab)
  assert.equal(createdTab.active, true)
  assert.equal(createdTab.pinned, false)
})

test('global new-tab shortcut opens a normal browser window when no normal window exists', async () => {
  const mock = await loadBackground([
    {
      id: 91,
      windowId: 10,
      windowType: 'popup',
      url: 'https://mail.example.com/',
      title: 'Inbox',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-new-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [])
  assert.deepEqual(mock.calls.windowCreate, [
    {
      type: 'normal',
      focused: true
    }
  ])
})

test('native placement bridge directly places a requested window without focusing Chrome', async () => {
  const mock = await loadBackground([
    {
      id: 92,
      windowId: 1,
      windowBounds: { left: 100, top: 100, width: 1200, height: 700 },
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ], {
    displays: [
      {
        id: 'remote-display',
        isEnabled: true,
        bounds: { left: 0, top: 0, width: 1440, height: 900 },
        workArea: { left: 0, top: 25, width: 1440, height: 875 }
      },
      {
        id: 'target-display',
        isEnabled: true,
        bounds: { left: -1920, top: 0, width: 1920, height: 1080 },
        workArea: { left: -1920, top: 0, width: 1920, height: 1080 }
      }
    ]
  })

  const onNativeMessage = mock.listeners.nativePortOnMessage[0]
  assert.equal(typeof onNativeMessage, 'function')

  onNativeMessage({
    version: 1,
    type: 'create-window',
    requestId: 'hs-bridge-test-1',
    expiresAtMs: Date.now() + 12_000,
    operation: 'filter',
    targetBounds: { left: -1920, top: 0, width: 1920, height: 1080 }
  })
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [])
  assert.deepEqual(mock.calls.update, [])
  assert.deepEqual(mock.calls.windowUpdate, [])
  assert.deepEqual(mock.calls.windowCreate, [
    {
      type: 'normal',
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      focused: false,
      left: -1820,
      top: 75,
      width: 1200,
      height: 700
    }
  ])
  assert.equal(mock.state.windowsById[1].focused, true)
  assert.equal(mock.state.windowsById[2].focused, false)
  assert.equal(mock.state.windowsById[2].state, 'normal')
  assert.deepEqual(mock.calls.nativeHostNames, ['com.tabout.native_bridge'])
  assert.deepEqual(mock.calls.nativeMessages, [{
    version: 1,
    type: 'response',
    requestId: 'hs-bridge-test-1',
    status: 'accepted'
  }])
})

test('background command listener settles every rejected async command', async () => {
  const mock = await loadBackground([
    {
      id: 101,
      windowId: 1,
      url: 'https://example.test/',
      title: 'Example',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  mock.chrome.tabs.query = async () => {
    throw new Error('Tab query failed')
  }
  mock.chrome.tabs.create = async () => {
    throw new Error('Tab creation failed')
  }
  mock.chrome.windows.getLastFocused = async () => {
    throw new Error('Window lookup failed')
  }
  mock.chrome.windows.getAll = async () => []
  mock.chrome.windows.create = async () => {
    throw new Error('Window creation failed')
  }

  for (const command of [
    'switch-to-last-tab',
    'switch-to-next-tab',
    'open-filter-tab',
    'open-new-tab'
  ]) {
    const commandTask = onCommand(command)
    assert.ok(commandTask instanceof Promise)
    await assert.doesNotReject(() => commandTask)
  }
})

test('browser startup clears persisted tab-id history before refreshing the startup snapshot', async () => {
  const mock = await loadBackground(
    [
      {
        id: 111,
        windowId: 1,
        url: 'https://current.example.test/',
        title: 'Current',
        active: true,
        pinned: false,
        groupId: -1,
        index: 0
      }
    ],
    {
      deferInitialOpenSurfaceReconciliation: true,
      storageValues: {
        local: {
          globalTabHistory: {
            stack: [
              { windowId: 1, tabId: 111 },
              { windowId: 1, tabId: 222 }
            ],
            index: 1,
            pending: [{ windowId: 1, tabId: 333 }]
          }
        }
      }
    }
  )

  const onStartup = mock.listeners.runtimeOnStartup[0]
  assert.equal(typeof onStartup, 'function')
  const startup = onStartup()
  await backgroundClock.tickAsync(0)
  await startup
  await flushBackgroundWork()

  assert.deepEqual(mock.storageValues.local.globalTabHistory, {
    version: 2,
    stack: [{ windowId: 1, tabId: 111, url: 'https://current.example.test/' }],
    index: 0,
    pending: []
  })
})

test('failed initial open-surface reconciliation retries on the next readiness wait', async () => {
  const mock = await loadBackground([{
    id: 111,
    windowId: 1,
    url: 'https://current.example.test/',
    title: 'Current',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }], {
    deferInitialOpenSurfaceReconciliation: true
  })

  mock.failNextTabQuery('Initial inventory capture unavailable')
  await backgroundClock.tickAsync(0)
  await flushBackgroundWork()

  assert.equal(
    mock.storageValues.session[OPEN_SURFACE_SESSION_STORAGE_KEY],
    undefined
  )
  assert.equal(
    mock.calls.alarmsClear.filter((name) => name === RETAINED_PAGES_EXPIRY_ALARM).length,
    1
  )

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:get-dashboard-service-state'
  })
  assert.equal(response.ok, true)

  const session = parseOpenSurfaceInventoryValue(
    mock.storageValues.session[OPEN_SURFACE_SESSION_STORAGE_KEY]
  )
  assert.equal(session.status, 'valid')
  assert.deepEqual(Object.keys(session.inventory.entries), ['111'])
  assert.equal(
    mock.calls.alarmsClear.filter((name) => name === RETAINED_PAGES_EXPIRY_ALARM).length,
    2
  )
})

test('browser startup owns retained-page reconciliation before worker-resume can rewrite durable lifetimes', async () => {
  const priorInventory = await seedOpenSurfaceInventory([{
    tabId: 77,
    surfaceKind: 'normal-tab',
    url: 'https://restored.example.test/article',
    title: 'Prior browser lifetime'
  }], {
    closureTokenFactory: () => 'prior-browser-lifetime'
  })
  const mock = await loadBackground(
    [{
      id: 111,
      windowId: 1,
      url: 'https://restored.example.test/article',
      title: 'Restored current lifetime',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }],
    {
      deferInitialOpenSurfaceReconciliation: true,
      storageValues: {
        local: {
          [OPEN_SURFACE_DURABLE_STORAGE_KEY]: priorInventory
        }
      }
    }
  )

  const onStartup = mock.listeners.runtimeOnStartup[0]
  assert.equal(typeof onStartup, 'function')
  const startup = onStartup()
  await backgroundClock.tickAsync(0)
  await startup
  await flushBackgroundWork()

  const ledger = await parseStoredRetainedPageLedger(
    mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
  )
  const session = parseOpenSurfaceInventoryValue(
    mock.storageValues.session[OPEN_SURFACE_SESSION_STORAGE_KEY]
  )
  const durable = parseOpenSurfaceInventoryValue(
    mock.storageValues.local[OPEN_SURFACE_DURABLE_STORAGE_KEY]
  )
  assert.equal(ledger.status, 'valid')
  assert.equal(session.status, 'valid')
  assert.equal(durable.status, 'valid')
  assert.deepEqual(Object.keys(ledger.ledger.pages).length, 1)
  assert.equal(
    Object.values(ledger.ledger.pages)[0]?.closureToken,
    'prior-browser-lifetime'
  )
  assert.notEqual(
    session.inventory.entries['111']?.closureToken,
    'prior-browser-lifetime'
  )
  assert.equal(
    durable.inventory.entries['111']?.closureToken,
    session.inventory.entries['111']?.closureToken
  )

  await backgroundClock.tickAsync(0)
  await flushBackgroundWork()
  const afterDeferredFallback = await parseStoredRetainedPageLedger(
    mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
  )
  assert.equal(afterDeferredFallback.status, 'valid')
  assert.equal(
    Object.values(afterDeferredFallback.ledger.pages)[0]?.closureToken,
    'prior-browser-lifetime'
  )
})

test('first installation seeds current surfaces before the deferred worker-resume fallback', async () => {
  const impossiblePriorInventory = await seedOpenSurfaceInventory([{
    tabId: 77,
    surfaceKind: 'normal-tab',
    url: 'https://prior.example.test/article',
    title: 'Prior durable lifetime'
  }], {
    closureTokenFactory: () => 'must-not-be-retained-on-install'
  })
  const mock = await loadBackground(
    [{
      id: 111,
      windowId: 1,
      url: 'https://current.example.test/article',
      title: 'Current install lifetime',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }],
    {
      deferInitialOpenSurfaceReconciliation: true,
      storageValues: {
        local: {
          [OPEN_SURFACE_DURABLE_STORAGE_KEY]: impossiblePriorInventory
        }
      }
    }
  )

  const onInstalled = mock.listeners.runtimeOnInstalled[0]
  assert.equal(typeof onInstalled, 'function')
  onInstalled({ reason: 'install' })
  await flushBackgroundWork()
  await backgroundClock.tickAsync(0)
  await flushBackgroundWork()

  assert.equal(mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY], undefined)
  const session = parseOpenSurfaceInventoryValue(
    mock.storageValues.session[OPEN_SURFACE_SESSION_STORAGE_KEY]
  )
  const durable = parseOpenSurfaceInventoryValue(
    mock.storageValues.local[OPEN_SURFACE_DURABLE_STORAGE_KEY]
  )
  assert.equal(session.status, 'valid')
  assert.equal(durable.status, 'valid')
  assert.deepEqual(Object.keys(session.inventory.entries), ['111'])
  assert.deepEqual(durable.inventory, session.inventory)
})

test('extension update owns initial reconciliation and preserves surviving live lifetimes', async () => {
  let nextToken = 0
  const priorInventory = await seedOpenSurfaceInventory([
    {
      tabId: 111,
      surfaceKind: 'normal-tab',
      url: 'https://surviving.example.test/article',
      title: 'Surviving lifetime'
    },
    {
      tabId: 77,
      surfaceKind: 'normal-tab',
      url: 'https://missing.example.test/article',
      title: 'Missing lifetime'
    }
  ], {
    closureTokenFactory: () => `prior-update-lifetime-${++nextToken}`
  })
  const mock = await loadBackground(
    [{
      id: 111,
      windowId: 1,
      url: 'https://surviving.example.test/article',
      title: 'Surviving lifetime after update',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }],
    {
      deferInitialOpenSurfaceReconciliation: true,
      storageValues: {
        local: {
          [OPEN_SURFACE_DURABLE_STORAGE_KEY]: priorInventory
        }
      }
    }
  )

  const onInstalled = mock.listeners.runtimeOnInstalled[0]
  assert.equal(typeof onInstalled, 'function')
  onInstalled({ reason: 'update' })
  await flushBackgroundWork()
  await backgroundClock.tickAsync(0)
  await flushBackgroundWork()

  const ledger = await parseStoredRetainedPageLedger(
    mock.storageValues.local[RETAINED_PAGES_STORAGE_KEY]
  )
  const session = parseOpenSurfaceInventoryValue(
    mock.storageValues.session[OPEN_SURFACE_SESSION_STORAGE_KEY]
  )
  assert.equal(ledger.status, 'valid')
  assert.equal(session.status, 'valid')
  assert.equal(
    Object.values(ledger.ledger.pages)[0]?.closureToken,
    priorInventory.entries['77']?.closureToken
  )
  assert.equal(
    session.inventory.entries['111']?.closureToken,
    priorInventory.entries['111']?.closureToken
  )
  assert.deepEqual(Object.keys(session.inventory.entries), ['111'])
})

test('tab replacement rebases live state while the URL-keyed Warm seed remains stable', async () => {
  const mock = await loadBackground([
    {
      id: 201,
      windowId: 1,
      url: 'https://one.example.test/',
      title: 'One',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 202,
      windowId: 1,
      url: 'https://two.example.test/',
      title: 'Two',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 203,
      windowId: 1,
      url: 'https://three.example.test/',
      title: 'Three',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onInstalled = mock.listeners.runtimeOnInstalled[0]
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onInstalled, 'function')

  for (const tabId of [202, 203, 201]) {
    mock.activateTab(tabId)
    onActivated({ tabId, windowId: 1 })
  }
  await flushBackgroundWork()
  onInstalled({ reason: 'install' })
  await flushBackgroundWork()

  const warmBefore = requireStartupSeed(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.ok(warmBefore.workingSetPriority.keys.includes('https://one.example.test/'))

  await mock.replaceTab(201, 211)
  await flushBackgroundWork()
  await backgroundClock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
  await flushBackgroundWork()

  const warmAfter = requireStartupSeed(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.deepEqual(warmAfter.cardOrder, warmBefore.cardOrder)
  assert.deepEqual(warmAfter.workingSetPriority, warmBefore.workingSetPriority)
  const liveState = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(liveState.ok, true)
  if (!liveState.ok) return
  assert.equal(liveState.tabHistory.entries.some((entry) => entry.tabId === 201), false)
  assert.ok(liveState.tabHistory.entries.some((entry) => entry.tabId === 211))
  const liveWorkingSet = buildWorkingSetFromServiceState(liveState)
  assert.equal(liveWorkingSet.items.some((item) => item.tabId === 201), false)
  assert.ok(liveWorkingSet.items.some((item) => item.tabId === 211))
})

test('tab lifecycle events invalidate session-only title retention before the debounced rebuild', async () => {
  const retainedTitle = (tabId: number, domain: string) => ({
    tabId,
    url: `https://${domain}/docs`,
    title: `${domain} docs`,
    kind: 'suspended'
  })
  const mock = await loadBackground([
    {
      id: 701,
      windowId: 1,
      url: 'https://created.example/docs',
      title: 'Created',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 702,
      windowId: 1,
      url: 'https://removed.example/docs',
      title: 'Removed',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 703,
      windowId: 1,
      url: 'https://replaced.example/docs',
      title: 'Replaced',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ], {
    storageValues: {
      session: {
        [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
          schemaVersion: 2,
          savedAt: 10,
          captureStartedAt: 10,
          cardOrder: ['domain-example'],
          workingSetPriority: { epoch: 10, keys: [] },
          titleRetention: [
            retainedTitle(701, 'created.example'),
            retainedTitle(702, 'removed.example'),
            retainedTitle(703, 'replaced.example'),
            retainedTitle(704, 'replacement.example')
          ]
        }
      }
    }
  })

  const onCreated = valueAt(mock.listeners.tabsOnCreated, 0)
  onCreated(clone(mock.state.tabsById[701]))
  await flushBackgroundWork()
  assert.deepEqual(
    requireStartupSeed(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY])
      .titleRetention?.map((entry) => entry.tabId),
    [702, 703, 704]
  )

  await mock.chrome.tabs.remove(702)
  await flushBackgroundWork()
  assert.deepEqual(
    requireStartupSeed(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY])
      .titleRetention?.map((entry) => entry.tabId),
    [703, 704]
  )

  await mock.replaceTab(703, 704)
  await flushBackgroundWork()
  assert.equal(
    requireStartupSeed(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY])
      .titleRetention,
    undefined
  )
})

test('active tab is primed to close back to the previous same-window tab without fallback flash', async () => {
  const mock = await loadBackground([
    {
      id: 71,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 72,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 73,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  onActivated({ tabId: 72, windowId: 1 })
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.update.at(-1), {
    tabId: 72,
    updateProperties: { openerTabId: 71 }
  })
  assert.equal(mock.state.tabsById[72].openerTabId, 71)

  await mock.chrome.tabs.remove(72)
  await flushBackgroundWork()

  assert.equal(mock.state.tabsById[71].active, true)
  assert.equal(mock.state.tabsById[73].active, false)
  assert.equal(
    mock.calls.update.some((call) => call.updateProperties.active === true && call.tabId === 71),
    false
  )
})

test('tab history snapshot exposes previous and next command targets', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 82,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 83,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(82, { active: true })
  onActivated({ tabId: 82, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(83, { active: true })
  onActivated({ tabId: 83, windowId: 1 })
  await flushBackgroundWork()

  const initialResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const initialSnapshot = requireHistorySnapshot(initialResponse)
  assert.equal(initialSnapshot.maxSize, 48)
  assert.equal(initialSnapshot.currentIndex, 2)
  assert.equal(initialSnapshot.previousIndex, 1)
  assert.equal(initialSnapshot.nextIndex, -1)
  assert.equal(valueAt(initialSnapshot.entries, 1).previousTarget, true)
  assert.equal(valueAt(initialSnapshot.entries, 2).current, true)
  assert.equal(valueAt(initialSnapshot.entries, 2).active, true)

  const updateTab = mock.chrome.tabs.update.bind(mock.chrome.tabs)
  mock.chrome.tabs.update = async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    const updatedTab = await updateTab(tabId, updateProperties)
    if (updateProperties.active) onActivated({ tabId, windowId: updatedTab.windowId })
    return updatedTab
  }
  const switchedResponse = await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  const switchedSnapshot = requireHistorySnapshot(switchedResponse)
  assert.equal(mock.state.tabsById[82].active, true)
  assert.equal(switchedSnapshot.currentIndex, 1)
  assert.equal(switchedSnapshot.previousIndex, 0)
  assert.equal(switchedSnapshot.nextIndex, 2)
  assert.equal(valueAt(switchedSnapshot.entries, 0).previousTarget, true)
  assert.equal(valueAt(switchedSnapshot.entries, 1).current, true)
  assert.equal(valueAt(switchedSnapshot.entries, 2).nextTarget, true)
})

test('tab history keeps a valid target when activation succeeds but window focus fails', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 82,
      windowId: 2,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.windows.update(2, { focused: true })
  onFocusChanged(2)
  await flushBackgroundWork()

  let rejectedFocusAttempts = 0
  mock.chrome.windows.update = async () => {
    rejectedFocusAttempts += 1
    throw new Error('Window focus unavailable')
  }

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: -1
  })
  await flushBackgroundWork()

  assert.equal(response.ok, true)
  assert.equal(rejectedFocusAttempts, 1)
  assert.equal(mock.state.tabsById[81].active, true)
  assert.deepEqual(response.snapshot.entries.map((entry) => entry.tabId), [81, 82])
})

test('background-created link tabs become FIFO indexed next history targets', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })

  assert.equal(response.ok, true)
  assert.equal(response.snapshot.stackSize, 1)
  assert.equal(response.snapshot.pendingSize, 2)
  assert.equal(response.snapshot.currentIndex, 0)
  assert.equal(response.snapshot.nextIndex, 1)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      index: entry.index,
      pending: entry.pending,
      nextTarget: entry.nextTarget
    }))),
    [
      { tabId: 81, index: 0, pending: false, nextTarget: false },
      { tabId: 82, index: 1, pending: true, nextTarget: true },
      { tabId: 83, index: 2, pending: true, nextTarget: false }
    ]
  )
})

test('a background-created pending target survives a redirect before first activation', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://example.test/current',
      title: 'Current',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  onFocusChanged(1)
  await flushBackgroundWork()

  const pendingTab = await mock.chrome.tabs.create({
    windowId: 1,
    url: 'https://example.test/redirect-start',
    active: false,
    openerTabId: 81
  })
  await flushBackgroundWork()
  mock.state.tabsById[pendingTab.id].url = 'https://example.test/redirect-final'
  onUpdated(
    pendingTab.id,
    { url: 'https://example.test/redirect-final' },
    clone(mock.state.tabsById[pendingTab.id])
  )
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })

  assert.equal(response.ok, true)
  assert.equal(response.snapshot.pendingSize, 1)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      url: entry.url,
      pending: entry.pending
    }))),
    [
      { tabId: 81, url: 'https://example.test/current', pending: false },
      { tabId: pendingTab.id, url: 'https://example.test/redirect-final', pending: true }
    ]
  )
})

test('failed pending-tab activation does not promote or advance history', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()
  const updateTab = mock.chrome.tabs.update.bind(mock.chrome.tabs)
  let rejectedActivationAttempts = 0
  mock.chrome.tabs.update = async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    if (updateProperties.active) {
      rejectedActivationAttempts += 1
      throw new Error('Tab activation unavailable')
    }
    return updateTab(tabId, updateProperties)
  }

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: 1
  })
  const snapshotResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })

  assert.equal(response.ok, false)
  assert.equal(rejectedActivationAttempts, 1)
  assert.equal(mock.state.tabsById[81].active, true)
  assert.equal(mock.state.tabsById[82].active, false)
  assert.equal(snapshotResponse.ok, true)
  assert.equal(snapshotResponse.snapshot.stackSize, 1)
  assert.equal(snapshotResponse.snapshot.pendingSize, 2)
  assert.equal(snapshotResponse.snapshot.currentIndex, 0)
  assert.deepEqual(
    clone(snapshotResponse.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      pending: entry.pending,
      current: entry.current,
      nextTarget: entry.nextTarget
    }))),
    [
      { tabId: 81, pending: false, current: true, nextTarget: false },
      { tabId: 82, pending: true, current: false, nextTarget: true },
      { tabId: 83, pending: true, current: false, nextTarget: false }
    ]
  )
})

test('forward history promotes the first pending tab and advances to the next one', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: 1
  })
  await flushBackgroundWork()

  assert.equal(response.ok, true)
  assert.equal(mock.state.tabsById[82].active, true)
  assert.equal(response.snapshot.stackSize, 2)
  assert.equal(response.snapshot.pendingSize, 1)
  assert.equal(response.snapshot.currentIndex, 1)
  assert.equal(response.snapshot.nextIndex, 2)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      index: entry.index,
      pending: entry.pending,
      current: entry.current,
      nextTarget: entry.nextTarget
    }))),
    [
      { tabId: 81, index: 0, pending: false, current: false, nextTarget: false },
      { tabId: 82, index: 1, pending: false, current: true, nextTarget: false },
      { tabId: 83, index: 2, pending: true, current: false, nextTarget: true }
    ]
  )
})

test('activated forward history stays ahead of pending background tabs', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 82,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 83,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(82, { active: true })
  onActivated({ tabId: 82, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(83, { active: true })
  onActivated({ tabId: 83, windowId: 1 })
  await flushBackgroundWork()
  await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  await mock.chrome.tabs.create({
    windowId: 1,
    url: 'https://delta.example/',
    active: false,
    openerTabId: 82
  })
  await flushBackgroundWork()

  const beforeSwitch = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const beforeSwitchSnapshot = requireHistorySnapshot(beforeSwitch)
  const beforeSwitchTarget = valueAt(beforeSwitchSnapshot.entries, 2)
  const pendingEntry = valueAt(beforeSwitchSnapshot.entries, 3)
  assert.equal(beforeSwitchSnapshot.currentIndex, 1)
  assert.equal(beforeSwitchSnapshot.nextIndex, 2)
  assert.equal(beforeSwitchTarget.tabId, 83)
  assert.equal(beforeSwitchTarget.nextTarget, true)
  assert.equal(pendingEntry.tabId, 84)
  assert.equal(pendingEntry.pending, true)

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: 1
  })
  await flushBackgroundWork()

  const switchedSnapshot = requireHistorySnapshot(response)
  const switchedPendingEntry = valueAt(switchedSnapshot.entries, 3)
  assert.equal(mock.state.tabsById[83].active, true)
  assert.equal(switchedSnapshot.currentIndex, 2)
  assert.equal(switchedSnapshot.nextIndex, 3)
  assert.equal(switchedPendingEntry.tabId, 84)
  assert.equal(switchedPendingEntry.pending, true)
  assert.equal(switchedPendingEntry.nextTarget, true)
})

test('manual activation promotes only the selected pending background tab', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()
  const onActivated = mock.listeners.tabsOnActivated[0]

  await mock.chrome.tabs.update(83, { active: true })
  onActivated({ tabId: 83, windowId: 1 })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)

  assert.equal(snapshot.stackSize, 2)
  assert.equal(snapshot.pendingSize, 1)
  assert.equal(snapshot.currentIndex, 1)
  assert.equal(snapshot.nextIndex, 2)
  assert.deepEqual(
    clone(snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      pending: entry.pending,
      current: entry.current
    }))),
    [
      { tabId: 81, pending: false, current: false },
      { tabId: 83, pending: false, current: true },
      { tabId: 82, pending: true, current: false }
    ]
  )
})

test('closing a pending background tab removes it from indexed history', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()

  await mock.chrome.tabs.remove(82)
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)
  const pendingEntry = valueAt(snapshot.entries, 1)

  assert.equal(snapshot.stackSize, 1)
  assert.equal(snapshot.pendingSize, 1)
  assert.equal(snapshot.nextIndex, 1)
  assert.deepEqual(
    clone(snapshot.entries.map((entry) => entry.tabId)),
    [81, 83]
  )
  assert.equal(pendingEntry.pending, true)
  assert.equal(pendingEntry.nextTarget, true)
})

test('inactive tabs without an opener do not enter pending history', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.create({
    windowId: 1,
    url: 'https://restored.example/',
    active: false
  })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)

  assert.equal(snapshot.pendingSize, 0)
  assert.deepEqual(
    clone(snapshot.entries.map((entry) => entry.tabId)),
    [81]
  )
})

test('tab history command unsuspends the selected history target', async () => {
  const suspendedUrl = 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const mock = await loadBackground([
    {
      id: 86,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 87,
      windowId: 1,
      url: suspendedUrl,
      title: 'Suspended Docs',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 88,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: true,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(87, { active: true })
  onActivated({ tabId: 87, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(88, { active: true })
  onActivated({ tabId: 88, windowId: 1 })
  await flushBackgroundWork()

  const switchedResponse = await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  assert.equal(switchedResponse.ok, true)
  assert.deepEqual(mock.calls.runtimeMessages, [
    {
      extensionId: 'blocked',
      message: { action: 'unsuspend', tabId: 87 }
    }
  ])
  assert.deepEqual(mock.calls.update.findLast((call) => call.updateProperties.active === true && call.tabId === 87), {
    tabId: 87,
    updateProperties: { active: true, url: 'https://example.com/docs' }
  })
  assert.deepEqual(mock.calls.update.at(-1), {
    tabId: 87,
    updateProperties: { openerTabId: 88 }
  })
  assert.equal(mock.state.tabsById[87].url, 'https://example.com/docs')
  assert.equal(mock.state.tabsById[87].active, true)
})

test('tab history snapshot marks standalone app entries', async () => {
  const mock = await loadBackground([
    {
      id: 84,
      windowId: 1,
      url: 'https://example.com/',
      title: 'Normal',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 85,
      windowId: 2,
      windowType: 'popup',
      url: 'https://app.example.com/',
      title: 'Standalone App',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  mock.activateTab(85)
  onFocusChanged(2)
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.equal(response.snapshot.entries.find((entry) => entry.tabId === 84)?.isApp, false)
  assert.equal(response.snapshot.entries.find((entry) => entry.tabId === 85)?.isApp, true)
})

test('tab history snapshot exposes effective and raw URLs for suspended tabs', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const mock = await loadBackground([
    {
      id: 89,
      windowId: 1,
      url: suspendedUrl,
      title: 'chrome-extension://marvellous/suspended.html',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  onFocusChanged(1)
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const entry = valueAt(requireHistorySnapshot(response).entries, 0)

  assert.equal(entry.title, 'Docs')
  assert.equal(entry.url, 'https://example.com/docs')
  assert.equal(entry.rawUrl, suspendedUrl)
  assert.equal(entry.displayUrl, 'example.com/docs')
})

test('combined service state ranks activated and actively navigated open tabs', async () => {
  const originalDateNow = Date.now
  let now = Date.UTC(2026, 4, 17, 12)
  Date.now = () => now
  const mock = await loadBackground([
    {
      id: 401,
      windowId: 1,
      url: 'https://alpha.example/docs',
      title: 'Alpha docs',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 402,
      windowId: 1,
      url: 'https://bravo.example/home',
      title: 'Bravo home',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 403,
      windowId: 1,
      url: 'https://charlie.example/report',
      title: 'Charlie report',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    },
    {
      id: 404,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: false,
      pinned: false,
      groupId: -1,
      index: 3
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onUpdated, 'function')

  try {
    onFocusChanged(1)
    await flushBackgroundWork()
    now += 60_000
    await mock.chrome.tabs.update(402, { active: true })
    onActivated({ tabId: 402, windowId: 1 })
    await flushBackgroundWork()

    now += 60_000
    mock.state.tabsById[402].url = 'https://bravo.example/issues/123?utm_source=mail#comments'
    mock.state.tabsById[402].title = 'Bravo issue 123'
    onUpdated(402, { url: mock.state.tabsById[402].url, title: mock.state.tabsById[402].title }, clone(mock.state.tabsById[402]))
    await flushBackgroundWork()

    now += 60_000
    await mock.chrome.tabs.update(403, { active: true })
    onActivated({ tabId: 403, windowId: 1 })
    await flushBackgroundWork()

    const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
    assert.equal(response.ok, true)
    const snapshot = buildWorkingSetFromServiceState(response)
    assert.deepEqual(
      snapshot.items.map((item) => item.tabId),
      [403, 402, 401]
    )
    assert.equal(valueAt(snapshot.items, 1).displayUrl, 'bravo.example/issues/123')
    assert.equal(snapshot.items.some((item) => item.title === 'Tab Out'), false)
  } finally {
    Date.now = originalDateNow
  }
})

test('combined service state ignores a same-page refresh signal', async () => {
  const mock = await loadBackground([
    {
      id: 501,
      windowId: 1,
      url: 'https://example.test/workflows',
      title: 'Workflows',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onUpdated, 'function')

  onActivated({ tabId: 501, windowId: 1 })
  await flushBackgroundWork()
  const before = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })

  onUpdated(
    501,
    { url: mock.state.tabsById[501].url, status: 'loading' },
    clone(mock.state.tabsById[501])
  )
  await flushBackgroundWork()
  const after = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })

  assert.equal(before.ok, true)
  assert.equal(after.ok, true)
  const workflowRecord = after.workingSetActivity.records['https://example.test/workflows']
  assert.ok(workflowRecord)
  assert.deepEqual(
    workflowRecord.events.map((event) => event.kind),
    ['activation']
  )
  assert.deepEqual(
    after.tabHistory.entries.map((entry) => entry.tabId),
    before.tabHistory.entries.map((entry) => entry.tabId)
  )
  assert.equal(after.tabHistory.currentIndex, before.tabHistory.currentIndex)
})

test('combined service state ignores title-only updates so idle tabs do not reshuffle', async () => {
  const originalDateNow = Date.now
  let now = Date.UTC(2026, 4, 17, 12)
  Date.now = () => now
  const mock = await loadBackground([
    {
      id: 601,
      windowId: 1,
      url: 'https://alpha.example/docs',
      title: 'Alpha docs',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 602,
      windowId: 2,
      url: 'https://bravo.example/home',
      title: 'Bravo home',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 603,
      windowId: 1,
      url: 'https://charlie.example/report',
      title: 'Charlie report',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onUpdated, 'function')

  try {
    onFocusChanged(2)
    await flushBackgroundWork()

    now += 60_000
    onFocusChanged(1)
    await flushBackgroundWork()

    now += 60_000
    await mock.chrome.tabs.update(603, { active: true })
    onActivated({ tabId: 603, windowId: 1 })
    await flushBackgroundWork()

    const before = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
    assert.equal(before.ok, true)
    const beforeSnapshot = buildWorkingSetFromServiceState(before)
    assert.deepEqual(
      beforeSnapshot.items.map((item) => item.tabId),
      [603, 601, 602]
    )

    now += 60_000
    mock.state.tabsById[602].title = 'Bravo home (1)'
    onUpdated(602, { title: mock.state.tabsById[602].title }, clone(mock.state.tabsById[602]))
    await flushBackgroundWork()

    const after = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
    assert.equal(after.ok, true)
    const afterSnapshot = buildWorkingSetFromServiceState(after)
    assert.deepEqual(
      afterSnapshot.items.map((item) => item.tabId),
      beforeSnapshot.items.map((item) => item.tabId)
    )
  } finally {
    Date.now = originalDateNow
  }
})

test('recently closed session changes do not rewrite the compact Warm seed', async () => {
  const mock = await loadBackground([
    {
      id: 511,
      windowId: 1,
      url: 'https://open.example.test/',
      title: 'Open page',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onInstalled = mock.listeners.runtimeOnInstalled[0]
  const onSessionsChanged = mock.listeners.sessionsOnChanged[0]
  assert.equal(typeof onInstalled, 'function')
  assert.equal(typeof onSessionsChanged, 'function')

  onInstalled({ reason: 'install' })
  await flushBackgroundWork()
  const beforeSeed = requireStartupSeed(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  const tabQueriesBefore = mock.calls.tabQuery.length

  mock.recentlyClosed.push({
    lastModified: 1_700_000_000,
    tab: {
      sessionId: 'closed-report',
      id: 512,
      windowId: 1,
      url: 'https://closed.example.test/report',
      title: 'Closed report',
      favIconUrl: ''
    }
  })
  onSessionsChanged()
  await backgroundClock.tickAsync(150 + STARTUP_SNAPSHOT_DEBOUNCE_MS)
  await flushBackgroundWork()

  const afterSeed = requireStartupSeed(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.deepEqual(afterSeed, beforeSeed)
  assert.equal(mock.calls.tabQuery.length, tabQueriesBefore)
})

test('background restore messages remain acknowledged without scheduling seed work', async () => {
  const mock = await loadBackground([
    {
      id: 521,
      windowId: 1,
      url: 'https://open.example.test/',
      title: 'Open page',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ], {
    recentlyClosed: [{
      lastModified: 1_700_000_000,
      tab: {
        sessionId: 'closed-slow',
        id: 522,
        windowId: 1,
        url: 'https://closed.example.test/slow',
        title: 'Slow restore',
        favIconUrl: ''
      }
    }]
  })
  const onSessionsChanged = mock.listeners.sessionsOnChanged[0]
  assert.equal(typeof onSessionsChanged, 'function')

  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId: 'restore-slow',
    phase: 'started'
  }), { ok: true })
  onSessionsChanged()

  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId: 'restore-slow',
    phase: 'settled'
  }), { ok: true })
  await backgroundClock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS * 2)
  await flushBackgroundWork()
  assert.equal(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)
})

test('background rejects malformed restore message envelopes', async () => {
  const mock = await loadBackground([])

  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId: '',
    phase: 'started'
  }), { ok: false })
})

test('tab history survives extension reload through persistent storage', async () => {
  const mock = await loadBackground([
    {
      id: 301,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 302,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 303,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(302, { active: true })
  onActivated({ tabId: 302, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(303, { active: true })
  onActivated({ tabId: 303, windowId: 1 })
  await flushBackgroundWork()

  assert.deepEqual(
    clone(mock.storageValues.local.globalTabHistory.stack.map((entry: { tabId: number }) => entry.tabId)),
    [301, 302, 303]
  )

  const reloadedTabs = Object.values(mock.state.tabsById).map((tab) => clone(tab))
  const reloadedMock = await loadBackground(reloadedTabs, { storageValues: mock.storageValues })

  const response = await sendRuntimeMessage(reloadedMock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [301, 302, 303]
  )
  assert.equal(response.snapshot.currentIndex, 2)
  assert.equal(response.snapshot.previousIndex, 1)
  assert.equal(valueAt(response.snapshot.entries, 2).active, true)
})

test('tab history keeps only the latest entry for a repeated tab id', async () => {
  const mock = await loadBackground([
    {
      id: 101,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 102,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 103,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(102, { active: true })
  onActivated({ tabId: 102, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(103, { active: true })
  onActivated({ tabId: 103, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(101, { active: true })
  onActivated({ tabId: 101, windowId: 1 })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [102, 103, 101]
  )
  assert.equal(response.snapshot.stackSize, 3)
  assert.equal(response.snapshot.currentIndex, 2)
  assert.equal(response.snapshot.previousIndex, 1)

  const secondResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const secondSnapshot = requireHistorySnapshot(secondResponse)
  assert.deepEqual(
    clone(secondSnapshot.entries.map((entry) => entry.tabId)),
    [102, 103, 101]
  )
})

test('tab history serializes rapid activation events in order', async () => {
  const mock = await loadBackground([
    {
      id: 131,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 132,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 133,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')

  mock.activateTab(131)
  onActivated({ tabId: 131, windowId: 1 })
  mock.activateTab(132)
  onActivated({ tabId: 132, windowId: 1 })
  mock.activateTab(133)
  onActivated({ tabId: 133, windowId: 1 })

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [131, 132, 133]
  )
  assert.equal(response.snapshot.currentIndex, 2)
  assert.equal(response.snapshot.previousIndex, 1)
})

test('history shortcut focuses the current Chrome tab first when Chrome is not focused', async () => {
  const mock = await loadBackground([
    {
      id: 111,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 112,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 113,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onCommand, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(112, { active: true })
  onActivated({ tabId: 112, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(113, { active: true })
  onActivated({ tabId: 113, windowId: 1 })
  await flushBackgroundWork()

  mock.blurAllWindows()
  const updateCount = mock.calls.update.length
  const windowUpdateCount = mock.calls.windowUpdate.length

  onCommand('switch-to-last-tab')
  await flushBackgroundWork()

  const commandUpdates = mock.calls.update.slice(updateCount)
  assert.equal(mock.state.tabsById[113].active, true)
  assert.equal(mock.state.tabsById[112].active, false)
  assert.deepEqual(
    commandUpdates.filter((call) => call.updateProperties.active === true).map((call) => call.tabId),
    [113]
  )
  assert.deepEqual(mock.calls.windowUpdate.slice(windowUpdateCount), [
    {
      windowId: 1,
      updateInfo: { focused: true }
    }
  ])

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)
  assert.equal(snapshot.currentIndex, 2)
  assert.equal(snapshot.previousIndex, 1)
})

test('history shortcut does not move or rewrite the cursor when focused-window state is unknown', async () => {
  const mock = await loadBackground([
    {
      id: 116,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 117,
      windowId: 2,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.windows.update(2, { focused: true })
  onFocusChanged(2)
  await flushBackgroundWork()

  const getAll = mock.chrome.windows.getAll.bind(mock.chrome.windows)
  let getAllCalls = 0
  mock.chrome.windows.getAll = async (queryOptions: Record<string, unknown> = {}) => {
    getAllCalls += 1
    if (getAllCalls === 1) throw new Error('Focused-window state unavailable')
    return getAll(queryOptions)
  }
  const updateCount = mock.calls.update.length
  const windowUpdateCount = mock.calls.windowUpdate.length

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: -1
  })

  assert.equal(response.ok, false)
  assert.equal(mock.state.tabsById[116].active, true)
  assert.equal(mock.state.tabsById[117].active, true)
  assert.deepEqual(mock.calls.update.slice(updateCount), [])
  assert.deepEqual(mock.calls.windowUpdate.slice(windowUpdateCount), [])
})

test('history shortcut prefers current history tab over stale last-focused window', async () => {
  const mock = await loadBackground([
    {
      id: 121,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 122,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 123,
      windowId: 2,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onCommand, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(122, { active: true })
  onActivated({ tabId: 122, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.windows.update(2, { focused: true })
  await mock.chrome.tabs.update(123, { active: true })
  onActivated({ tabId: 123, windowId: 2 })
  await flushBackgroundWork()

  mock.blurAllWindows(1)
  const updateCount = mock.calls.update.length
  const windowUpdateCount = mock.calls.windowUpdate.length

  onCommand('switch-to-last-tab')
  await flushBackgroundWork()

  const commandUpdates = mock.calls.update.slice(updateCount)
  assert.equal(mock.state.tabsById[123].active, true)
  assert.equal(mock.state.windowsById[2].focused, true)
  assert.equal(mock.state.windowsById[1].focused, false)
  assert.deepEqual(
    commandUpdates.filter((call) => call.updateProperties.active === true).map((call) => call.tabId),
    [123]
  )
  assert.deepEqual(mock.calls.windowUpdate.slice(windowUpdateCount), [
    {
      windowId: 2,
      updateInfo: { focused: true }
    }
  ])
})

test('window-closing tabs are removed before they consume history slots', async () => {
  const tabs = Array.from({ length: 25 }, (_, index) => {
    const id = 201 + index
    return {
      id,
      windowId: 1,
      url: `https://tab-${id}.example/`,
      title: `Tab ${id}`,
      active: index === 0,
      pinned: false,
      groupId: -1,
      index
    }
  })
  const mock = await loadBackground(tabs)

  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')

  for (const tab of tabs.slice(0, 24)) {
    mock.activateTab(tab.id)
    onActivated({ tabId: tab.id, windowId: tab.windowId })
    await flushBackgroundWork()
  }

  mock.closeTabForWindow(212)
  mock.activateTab(225)
  onActivated({ tabId: 225, windowId: 1 })

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  const historyIds = clone(response.snapshot.entries.map((entry) => entry.tabId))
  assert.equal(response.snapshot.stackSize, 24)
  assert.equal(historyIds.includes(201), true)
  assert.equal(historyIds.includes(212), false)
  assert.equal(historyIds.at(-1), 225)
})

test('tab history snapshot prunes missing tabs before returning entries', async () => {
  const mock = await loadBackground([
    {
      id: 91,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 92,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 93,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(92, { active: true })
  onActivated({ tabId: 92, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(93, { active: true })
  onActivated({ tabId: 93, windowId: 1 })
  await flushBackgroundWork()

  delete mock.state.tabsById[92]

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [91, 93]
  )
  assert.equal(response.snapshot.stackSize, 2)
  assert.equal(response.snapshot.currentIndex, 1)
  assert.equal(response.snapshot.previousIndex, 0)
  assert.equal(response.snapshot.entries.every((entry) => entry.exists), true)

  const secondResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const secondSnapshot = requireHistorySnapshot(secondResponse)
  assert.deepEqual(
    clone(secondSnapshot.entries.map((entry) => entry.tabId)),
    [91, 93]
  )
})
