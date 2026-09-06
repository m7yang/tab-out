import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect'

import { setChromeTabsApi } from '../../src/extension/browser-tabs-gateway.js'
import { BrowserTabs } from '../../src/extension/browser-tabs-service.js'
import {
  DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY,
  type DesktopWindowMergeJournal,
} from '../../src/extension/desktop-window-merge-contract.js'
import {
  DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID,
  DesktopWindowMerge,
  type DesktopWindowMergeLayerOptions,
} from '../../src/extension/background/desktop-window-merge-service.js'
import {
  NATIVE_MERGE_DESKTOP_CAPABILITY,
  type NativeDesktopControllerStatus,
  NativePlacementBridge,
} from '../../src/extension/background/native-placement-bridge.js'
import type { ChromeApi } from '../../src/extension/background/chrome-api.js'

function makeTab(
  id: number,
  windowId: number,
  index: number,
  extra: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return {
    active: index === 0,
    groupId: -1,
    id,
    index,
    pinned: false,
    title: `Example ${id}`,
    url: `https://example.test/${id}`,
    windowId,
    ...extra,
  } as chrome.tabs.Tab
}

function makeWindow(id: number): chrome.windows.Window {
  return {
    alwaysOnTop: false,
    focused: id === 10,
    id,
    incognito: false,
    state: 'normal',
    type: 'normal',
  }
}

function createMergeHarness(nativeStatus: NativeDesktopControllerStatus = {
  capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
  controllerConnected: true,
  hostConnected: true,
  initialConnectionSettled: true,
  ownerRevision: '11111111-1111-4111-8111-111111111111',
  profileSelection: 'selected',
  profileTransferAvailable: false,
}) {
  const tabs = [
    makeTab(1, 10, 0, { active: true, pinned: true }),
    makeTab(2, 10, 1, { active: false }),
    makeTab(3, 20, 0, { active: true, pinned: true }),
    makeTab(4, 20, 1, { active: false, groupId: 41 }),
    makeTab(5, 20, 2, {
      active: false,
      discarded: true,
      groupId: 41,
      mutedInfo: { muted: true },
    }),
    makeTab(6, 30, 0, { active: true }),
  ]
  const windows = [makeWindow(10), makeWindow(20), makeWindow(30)]
  const groups = [{
    collapsed: true,
    color: 'blue',
    id: 41,
    shared: false,
    title: 'Example group',
    windowId: 20,
  }] as chrome.tabGroups.TabGroup[]
  const stored: Record<string, unknown> = {}
  let beginMergeCount = 0
  let finishMergeCount = 0
  let groupMoveCount = 0
  let resolveCount = 0

  const tabsInWindow = (windowId: number) => tabs
    .filter((tab) => tab.windowId === windowId)
    .sort((left, right) => left.index - right.index)
  const normalizeWindow = (windowId: number) => {
    const current = tabsInWindow(windowId)
    current.forEach((tab, index) => {
      tab.index = index
    })
    if (current.length > 0 && !current.some((tab) => tab.active)) {
      current[0]!.active = true
    }
    const windowIndex = windows.findIndex((window) => window.id === windowId)
    if (current.length === 0 && windowIndex >= 0) windows.splice(windowIndex, 1)
  }
  const detachTab = (tab: chrome.tabs.Tab) => {
    const sourceWindowId = tab.windowId
    const sourceTabs = tabsInWindow(sourceWindowId)
    const sourceIndex = sourceTabs.findIndex((candidate) => candidate.id === tab.id)
    if (sourceIndex >= 0) sourceTabs.splice(sourceIndex, 1)
    normalizeWindow(sourceWindowId)
  }
  const insertTab = (tab: chrome.tabs.Tab, windowId: number, index: number) => {
    const destination = tabsInWindow(windowId).filter((candidate) => candidate.id !== tab.id)
    const targetIndex = index < 0 ? destination.length : Math.min(index, destination.length)
    destination.splice(targetIndex, 0, tab)
    tab.windowId = windowId
    destination.forEach((candidate, candidateIndex) => {
      candidate.index = candidateIndex
    })
  }

  const browserApi = {
    tabs: {
      async query(queryInfo: chrome.tabs.QueryInfo) {
        return queryInfo.windowId == null
          ? tabs.slice()
          : tabsInWindow(queryInfo.windowId)
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('tab missing')
        return tab
      },
      async move(tabId: number, properties: chrome.tabs.MoveProperties) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab || properties.windowId == null) throw new Error('tab missing')
        const sourceWindowId = tab.windowId
        tab.active = false
        detachTab(tab)
        tab.groupId = -1
        tab.pinned = false
        insertTab(tab, properties.windowId, properties.index)
        normalizeWindow(sourceWindowId)
        normalizeWindow(properties.windowId)
        return tab
      },
      async update(tabId: number, properties: chrome.tabs.UpdateProperties) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('tab missing')
        if (properties.pinned != null && tab.pinned !== properties.pinned) {
          const windowId = tab.windowId
          const destination = tabsInWindow(windowId).filter((candidate) => candidate.id !== tabId)
          tab.pinned = properties.pinned
          const targetIndex = properties.pinned
            ? destination.filter((candidate) => candidate.pinned).length
            : destination.length
          destination.splice(targetIndex, 0, tab)
          destination.forEach((candidate, index) => {
            candidate.index = index
          })
        }
        if (properties.active) {
          for (const candidate of tabsInWindow(tab.windowId)) candidate.active = false
          tab.active = true
        }
        return tab
      },
    },
    windows: {
      async getAll() {
        return windows.slice()
      },
      async get(windowId: number) {
        const window = windows.find((candidate) => candidate.id === windowId)
        if (!window) throw new Error('window missing')
        return window
      },
    },
    tabGroups: {
      async query() {
        return groups.slice()
      },
      async move(groupId: number, properties: chrome.tabGroups.MoveProperties) {
        groupMoveCount += 1
        const group = groups.find((candidate) => candidate.id === groupId)
        if (!group || properties.windowId == null) throw new Error('group missing')
        const members = tabsInWindow(group.windowId).filter((tab) => tab.groupId === groupId)
        const sourceWindowId = group.windowId
        for (const member of members) detachTab(member)
        for (const member of members) insertTab(member, properties.windowId, -1)
        group.windowId = properties.windowId
        normalizeWindow(sourceWindowId)
        normalizeWindow(properties.windowId)
        return group
      },
    },
  }
  const chromeApi = {
    runtime: {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      async sendMessage() {},
    },
    storage: {
      session: {
        async get(key: string) {
          return { [key]: stored[key] }
        },
        async set(values: Record<string, unknown>) {
          Object.assign(stored, values)
        },
        async remove(key: string) {
          delete stored[key]
        },
      },
    },
  } as unknown as ChromeApi
  const nativeLayer = Layer.succeed(NativePlacementBridge, NativePlacementBridge.of({
    beginDesktopWindowMerge: () => Effect.sync(() => {
      beginMergeCount += 1
    }),
    finishDesktopWindowMerge: () => Effect.sync(() => {
      finishMergeCount += 1
    }),
    getStatus: () => Effect.succeed(nativeStatus),
    refreshStatus: () => Effect.succeed(nativeStatus),
    selectCurrentProfile: () => Effect.void,
    transferCurrentProfile: () => Effect.succeed({ ok: true }),
    resolveDesktopWindows: () => Effect.sync(() => {
      resolveCount += 1
      return {
        selectionToken: `selection-${resolveCount}`,
        windowIds: [20, 10, 30],
      }
    }),
    revalidateDesktopWindows: (_destinationWindowId, selectionToken) => Effect.succeed({
      selectionToken,
      windowIds: [20, 10, 30],
    }),
  }))
  return {
    beginMergeCount: () => beginMergeCount,
    browserApi,
    chromeApi,
    finishMergeCount: () => finishMergeCount,
    groups,
    groupMoveCount: () => groupMoveCount,
    nativeLayer,
    resolveCount: () => resolveCount,
    stored,
    tabs,
    windows,
  }
}

function buildService(
  harness: ReturnType<typeof createMergeHarness>,
  options: DesktopWindowMergeLayerOptions = {},
) {
  const dependencies = Layer.mergeAll(BrowserTabs.layer(), harness.nativeLayer)
  return DesktopWindowMerge.layer(harness.chromeApi, {
    makeId: (kind) => `${kind}-test`,
    now: () => 1_800_000_000_000,
    runExclusive: (task) => task(),
    ...options,
  }).pipe(Layer.provide(dependencies))
}

it.effect('desktop merge offers profile selection only while the native host is connected', () => Effect.gen(function* () {
  const cases = [
    {
      hostConnected: true,
      initialConnectionSettled: true,
      profileSelection: 'required' as const,
      profileTransferAvailable: false,
      reason: 'profile-selection-required',
    },
    {
      hostConnected: false,
      initialConnectionSettled: true,
      profileSelection: 'required' as const,
      profileTransferAvailable: false,
      reason: 'native-integration-required',
    },
    {
      hostConnected: false,
      initialConnectionSettled: true,
      profileSelection: 'another-profile' as const,
      profileTransferAvailable: true,
      reason: 'another-profile-selected',
    },
    {
      hostConnected: false,
      initialConnectionSettled: true,
      profileSelection: 'another-profile' as const,
      profileTransferAvailable: false,
      reason: 'profile-transfer-update-required',
    },
    {
      hostConnected: false,
      initialConnectionSettled: false,
      profileSelection: 'unknown' as const,
      profileTransferAvailable: false,
      reason: 'native-integration-checking',
    },
    {
      hostConnected: false,
      initialConnectionSettled: true,
      profileSelection: 'unknown' as const,
      profileTransferAvailable: false,
      reason: 'native-integration-required',
    },
  ]

  for (const entry of cases) {
    const harness = createMergeHarness({
      capabilities: [],
      controllerConnected: false,
      hostConnected: entry.hostConnected,
      initialConnectionSettled: entry.initialConnectionSettled,
      ownerRevision: entry.profileSelection === 'another-profile'
        ? '11111111-1111-4111-8111-111111111111'
        : null,
      profileSelection: entry.profileSelection,
      profileTransferAvailable: entry.profileTransferAvailable,
    })
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(buildService(harness), scope)
    const service = Context.get(context, DesktopWindowMerge)

    const status = yield* service.getStatus(1, 10, true)
    assert.deepEqual(status.availability, entry.reason === 'another-profile-selected'
      ? {
          available: false,
          reason: entry.reason,
          ownerRevision: '11111111-1111-4111-8111-111111111111',
        }
      : { available: false, reason: entry.reason })
    yield* Scope.close(scope, Exit.void)
  }
}))

it.effect('desktop merge offers profile selection without session storage', () => Effect.gen(function* () {
  const harness = createMergeHarness({
    capabilities: [],
    controllerConnected: false,
    hostConnected: true,
    initialConnectionSettled: true,
    ownerRevision: null,
    profileSelection: 'required',
    profileTransferAvailable: false,
  })
  Reflect.deleteProperty(harness.chromeApi.storage, 'session')
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const status = yield* service.getStatus(1, 10, true)
  assert.deepEqual(status.availability, {
    available: false,
    reason: 'profile-selection-required',
  })
}))

it.effect('desktop merge offers profile selection without merge coordination', () => Effect.gen(function* () {
  const locksDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: undefined,
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    if (locksDescriptor) {
      Object.defineProperty(globalThis.navigator, 'locks', locksDescriptor)
    } else {
      Reflect.deleteProperty(globalThis.navigator, 'locks')
    }
  }))
  const harness = createMergeHarness({
    capabilities: [],
    controllerConnected: false,
    hostConnected: true,
    initialConnectionSettled: true,
    ownerRevision: null,
    profileSelection: 'required',
    profileTransferAvailable: false,
  })
  const context = yield* Layer.build(buildService(harness, { runExclusive: undefined }))
  const service = Context.get(context, DesktopWindowMerge)

  const status = yield* service.getStatus(1, 10, true)
  assert.deepEqual(status.availability, {
    available: false,
    reason: 'profile-selection-required',
  })
}))

it.effect('desktop merge moves pins and whole groups in deterministic order', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(buildService(harness), scope)
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(1, 10)
  assert.deepEqual(preview, {
    ok: true,
    status: 'ready',
    previewId: 'preview-test',
    sourceWindowCount: 2,
    movingTabCount: 4,
  })
  const completed = yield* service.confirm(1, 10, 'preview-test')
  assert.equal(completed.ok, true)
  assert.equal(completed.ok && completed.status, 'succeeded')
  assert.equal(harness.beginMergeCount(), 1)
  assert.equal(harness.finishMergeCount(), 1)
  assert.deepEqual(
    harness.tabs.slice().sort((left, right) => left.index - right.index).map((tab) => ({
      active: tab.active,
      groupId: tab.groupId,
      id: tab.id,
      pinned: tab.pinned,
      windowId: tab.windowId,
    })),
    [
      { active: true, groupId: -1, id: 1, pinned: true, windowId: 10 },
      { active: false, groupId: -1, id: 3, pinned: true, windowId: 10 },
      { active: false, groupId: -1, id: 2, pinned: false, windowId: 10 },
      { active: false, groupId: 41, id: 4, pinned: false, windowId: 10 },
      { active: false, groupId: 41, id: 5, pinned: false, windowId: 10 },
      { active: false, groupId: -1, id: 6, pinned: false, windowId: 10 },
    ],
  )
  assert.deepEqual(harness.windows.map((window) => window.id), [10])
  assert.equal(harness.groups[0]?.windowId, 10)
  assert.equal(harness.tabs.find((tab) => tab.id === 5)?.discarded, true)
  assert.equal(harness.tabs.find((tab) => tab.id === 5)?.mutedInfo?.muted, true)
  const storedJournal = harness.stored[
    DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY
  ] as DesktopWindowMergeJournal
  assert.equal(storedJournal.status, 'succeeded')
  assert.doesNotMatch(JSON.stringify(storedJournal), /(?:https?:|url|title)/i)
  assert.equal(yield* service.acknowledge(1, 'session-test'), true)
  assert.equal(harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY], undefined)
  yield* Scope.close(scope, Exit.void)
}))

it.effect('a menu-owned preview tolerates toolbar focus before the Tab Out page adopts it', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const destination = harness.windows.find((window) => window.id === 10)
  assert.ok(destination)
  destination.focused = false
  const initialTabs = structuredClone(harness.tabs)
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(buildService(harness), scope)
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID, 10)
  assert.deepEqual(preview, {
    ok: true,
    status: 'ready',
    previewId: 'preview-test',
    sourceWindowCount: 2,
    movingTabCount: 4,
  })
  assert.deepEqual(harness.tabs, initialTabs)
  assert.equal(Object.hasOwn(harness.stored, DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY), false)

  destination.focused = true
  const completed = yield* service.confirm(1, 10, 'preview-test')
  assert.equal(completed.ok && completed.status, 'succeeded')
  const storedJournal = harness.stored[
    DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY
  ] as DesktopWindowMergeJournal
  assert.equal(storedJournal.ownerTabId, 1)
  assert.equal(yield* service.acknowledge(1, 'session-test'), true)
  yield* Scope.close(scope, Exit.void)
}))

it.effect('menu previews do not relax focus checks for page previews or confirmation', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const destination = harness.windows.find((window) => window.id === 10)
  assert.ok(destination)
  destination.focused = false
  const initialTabs = structuredClone(harness.tabs)
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  assert.deepEqual(yield* service.preview(1, 10), {
    ok: false,
    reason: 'desktop-selection-unavailable',
  })
  assert.deepEqual(yield* service.confirm(1, 10, 'preview-test'), {
    ok: false,
    reason: 'desktop-selection-unavailable',
  })
  assert.deepEqual(harness.tabs, initialTabs)
  assert.equal(harness.groupMoveCount(), 0)
  assert.equal(harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY], undefined)
}))

it.effect.each([
  { label: 'private', changes: { incognito: true } },
  { label: 'popup', changes: { type: 'popup' } },
  { label: 'app', changes: { type: 'app' } },
  { label: 'minimized', changes: { state: 'minimized' } },
  { label: 'fullscreen', changes: { state: 'fullscreen' } },
] satisfies Array<{ label: string, changes: Partial<chrome.windows.Window> }>)(
  'menu previews still exclude $label destinations while the toolbar owns focus',
  ({ changes }) => Effect.gen(function* () {
    const harness = createMergeHarness()
    const destination = harness.windows.find((window) => window.id === 10)
    assert.ok(destination)
    Object.assign(destination, { focused: false }, changes)
    const initialTabs = structuredClone(harness.tabs)
    setChromeTabsApi(harness.browserApi)
    yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
    const context = yield* Layer.build(buildService(harness))
    const service = Context.get(context, DesktopWindowMerge)

    assert.deepEqual(yield* service.preview(DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID, 10), {
      ok: false,
      reason: 'desktop-selection-unavailable',
    })
    assert.deepEqual(harness.tabs, initialTabs)
    assert.equal(harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY], undefined)
  }),
)

it.effect('a tab-owned preview still rejects other tab confirmers with a fresh confirmation', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(buildService(harness), scope)
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(2, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  const changed = yield* service.confirm(1, 10, 'preview-test')
  assert.equal(changed.ok && changed.status, 'changed')
  const completed = yield* service.confirm(1, 10, 'preview-test')
  assert.equal(completed.ok && completed.status, 'succeeded')
  yield* Scope.close(scope, Exit.void)
}))

it.effect('desktop merge reports a terminal journal write failure as partial', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const storageSession = harness.chromeApi.storage?.session
  assert.ok(storageSession)
  const originalSet = storageSession.set.bind(storageSession)
  let writeCount = 0
  Object.assign(storageSession, {
    async set(items: Parameters<typeof originalSet>[0]) {
      writeCount += 1
      if (writeCount === 5) throw new Error('terminal journal write failed')
      await originalSet(items)
    },
  })
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(1, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  const completed = yield* service.confirm(1, 10, 'preview-test')

  assert.equal(completed.ok && completed.status, 'partial')
  assert.equal(
    completed.ok && 'journal' in completed && completed.journal.errorCode,
    'session-storage-unavailable',
  )
  assert.equal(
    completed.ok && 'journal' in completed && completed.journal.remainingTabCount,
    0,
  )
  assert.equal(
    (harness.stored[
      DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY
    ] as DesktopWindowMergeJournal).errorCode,
    'session-storage-unavailable',
  )
}))

it.effect('desktop merge replaces a stale preview without moving its frozen tabs', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)
  const preview = yield* service.preview(1, 10)
  assert.equal(preview.ok && preview.status, 'ready')

  harness.tabs.push(makeTab(7, 20, 3, { active: false }))
  const changed = yield* service.confirm(1, 10, 'preview-test')
  assert.deepEqual(changed, {
    ok: true,
    status: 'changed',
    previewId: 'preview-test',
    sourceWindowCount: 2,
    movingTabCount: 5,
  })
  assert.equal(harness.tabs.find((tab) => tab.id === 3)?.windowId, 20)
  assert.equal(harness.resolveCount(), 2)
}))

it.effect('desktop merge rejects a group that gains a member after confirmation', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const moveTab = harness.browserApi.tabs.move.bind(harness.browserApi.tabs)
  harness.browserApi.tabs.move = async (tabId, properties) => {
    const moved = await moveTab(tabId, properties)
    if (tabId === 3) {
      harness.tabs.push(makeTab(7, 20, 2, {
        active: false,
        groupId: 41,
      }))
    }
    return moved
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(1, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  const completed = yield* service.confirm(1, 10, 'preview-test')

  assert.equal(completed.ok && completed.status, 'partial')
  assert.equal(harness.groupMoveCount(), 0)
  assert.equal(harness.tabs.find((tab) => tab.id === 7)?.windowId, 20)
}))

it.effect('desktop merge reports partial when a group changes during its atomic move', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const moveGroup = harness.browserApi.tabGroups.move.bind(harness.browserApi.tabGroups)
  harness.browserApi.tabGroups.move = async (groupId, properties) => {
    harness.tabs.push(makeTab(7, 20, 2, {
      active: false,
      groupId: 41,
    }))
    return moveGroup(groupId, properties)
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(1, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  const completed = yield* service.confirm(1, 10, 'preview-test')

  assert.equal(completed.ok && completed.status, 'partial')
  assert.equal(harness.groupMoveCount(), 1)
}))

it.effect('desktop merge consumes only the expected generated activation', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const moveStarted = Promise.withResolvers<void>()
  const continueMove = Promise.withResolvers<void>()
  const getTab = harness.browserApi.tabs.get.bind(harness.browserApi.tabs)
  const moveTab = harness.browserApi.tabs.move.bind(harness.browserApi.tabs)
  let addedMidMergeTab = false
  harness.browserApi.tabs.get = async (tabId) => {
    const tab = await getTab(tabId)
    if (tabId === 3 && !addedMidMergeTab) {
      addedMidMergeTab = true
      harness.tabs.push(makeTab(7, 20, 3, { active: false }))
    }
    return tab
  }
  harness.browserApi.tabs.move = async (tabId, properties) => {
    moveStarted.resolve()
    await continueMove.promise
    return moveTab(tabId, properties)
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(1, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  const confirmation = yield* Effect.forkChild(service.confirm(1, 10, 'preview-test'))
  yield* Effect.promise(() => moveStarted.promise)

  assert.equal(yield* service.consumeExpectedTabActivation(4, 20), true)
  assert.equal(yield* service.consumeExpectedTabActivation(4, 20), false)
  assert.equal(yield* service.consumeExpectedTabActivation(5, 20), false)
  assert.equal(yield* service.consumeExpectedTabActivation(7, 20), false)
  assert.equal(yield* service.consumeExpectedTabActivation(3, 20), false)
  assert.equal(yield* service.consumeExpectedTabActivation(99, 99), false)

  continueMove.resolve()
  const completed = yield* Fiber.join(confirmation)
  assert.equal(completed.ok && completed.status, 'succeeded')
  assert.equal(yield* service.consumeExpectedTabActivation(3, 10), true)
  assert.equal(yield* service.consumeExpectedTabActivation(3, 10), false)
}))

it.effect('desktop merge activation receipts expire without suppressing later activity', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const moveStarted = Promise.withResolvers<void>()
  const continueMove = Promise.withResolvers<void>()
  const moveTab = harness.browserApi.tabs.move.bind(harness.browserApi.tabs)
  let nowMs = 1_800_000_000_000
  harness.browserApi.tabs.move = async (tabId, properties) => {
    moveStarted.resolve()
    await continueMove.promise
    return moveTab(tabId, properties)
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness, {
    now: () => nowMs,
  }))
  const service = Context.get(context, DesktopWindowMerge)

  const preview = yield* service.preview(1, 10)
  assert.equal(preview.ok && preview.status, 'ready')
  const confirmation = yield* Effect.forkChild(service.confirm(1, 10, 'preview-test'))
  yield* Effect.promise(() => moveStarted.promise)

  nowMs += 2_001
  assert.equal(yield* service.consumeExpectedTabActivation(4, 20), false)

  continueMove.resolve()
  const completed = yield* Fiber.join(confirmation)
  assert.equal(completed.ok && completed.status, 'succeeded')
}))

it.effect('a persisted running session is reported as interrupted and never resumed', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY] = {
    version: 1,
    sessionId: 'session-old',
    status: 'running',
    ownerTabId: 1,
    destinationWindowId: 10,
    sourceWindowCount: 2,
    plannedTabCount: 4,
    movedTabCount: 1,
    remainingTabCount: 3,
    startedAtMs: 1_799_999_999_000,
    updatedAtMs: 1_799_999_999_500,
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const status = yield* service.getStatus(1, 10, true)
  assert.equal(status.session?.journal.status, 'interrupted')
  assert.equal(status.session?.journal.errorCode, 'interrupted')
  assert.equal(harness.tabs.find((tab) => tab.id === 3)?.windowId, 20)
}))

it.effect('session ownership adoption fails closed when the tab inventory is unknown', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const requesterTab = harness.tabs.find((tab) => tab.id === 1)
  assert.ok(requesterTab)
  requesterTab.url = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html'
  harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY] = {
    version: 1,
    sessionId: 'session-old',
    status: 'partial',
    ownerTabId: 99,
    destinationWindowId: 10,
    sourceWindowCount: 2,
    plannedTabCount: 4,
    movedTabCount: 1,
    remainingTabCount: 3,
    startedAtMs: 1_799_999_999_000,
    updatedAtMs: 1_799_999_999_500,
    errorCode: 'browser-mutation-failed',
  }
  const query = harness.browserApi.tabs.query
  harness.browserApi.tabs.query = async () => {
    throw new Error('tab inventory unavailable')
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const unknown = yield* service.getStatus(1, 10, true)
  assert.equal(unknown.session?.isOwner, false)
  assert.equal(unknown.session?.journal.ownerTabId, 99)

  harness.browserApi.tabs.query = query
  const adopted = yield* service.getStatus(1, 10, true)
  assert.equal(adopted.session?.isOwner, true)
  assert.equal(adopted.session?.journal.ownerTabId, 1)
}))

it.effect('only one focused dashboard adopts an orphaned merge journal', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const dashboardUrl = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html'
  const firstRequester = harness.tabs.find((tab) => tab.id === 1)
  const secondRequester = harness.tabs.find((tab) => tab.id === 6)
  assert.ok(firstRequester)
  assert.ok(secondRequester)
  firstRequester.url = dashboardUrl
  secondRequester.url = dashboardUrl
  for (const window of harness.windows) window.focused = true
  harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY] = {
    version: 1,
    sessionId: 'session-old',
    status: 'partial',
    ownerTabId: 99,
    destinationWindowId: 10,
    sourceWindowCount: 2,
    plannedTabCount: 4,
    movedTabCount: 1,
    remainingTabCount: 3,
    startedAtMs: 1_799_999_999_000,
    updatedAtMs: 1_799_999_999_500,
    errorCode: 'browser-mutation-failed',
  }
  let previous = Promise.resolve()
  const runExclusive: NonNullable<DesktopWindowMergeLayerOptions['runExclusive']> = (task) => {
    const predecessor = previous
    const released = Promise.withResolvers<void>()
    previous = released.promise
    return predecessor.then(task).finally(released.resolve)
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness, { runExclusive }))
  const service = Context.get(context, DesktopWindowMerge)

  const statuses = yield* Effect.all([
    service.getStatus(1, 10, true),
    service.getStatus(6, 30, true),
  ], { concurrency: 'unbounded' })

  assert.equal(statuses.filter((status) => status.session?.isOwner).length, 1)
  const storedJournal = harness.stored[
    DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY
  ] as DesktopWindowMergeJournal
  assert.ok(storedJournal.ownerTabId === 1 || storedJournal.ownerTabId === 6)
  assert.equal(
    statuses.find((status) => status.session?.isOwner)?.session?.journal.ownerTabId,
    storedJournal.ownerTabId,
  )
}))

it.effect('an active dashboard in an unfocused window cannot adopt a journal', () => Effect.gen(function* () {
  const harness = createMergeHarness()
  const requesterTab = harness.tabs.find((tab) => tab.id === 6)
  assert.ok(requesterTab)
  requesterTab.url = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html'
  harness.stored[DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY] = {
    version: 1,
    sessionId: 'session-old',
    status: 'partial',
    ownerTabId: 99,
    destinationWindowId: 10,
    sourceWindowCount: 2,
    plannedTabCount: 4,
    movedTabCount: 1,
    remainingTabCount: 3,
    startedAtMs: 1_799_999_999_000,
    updatedAtMs: 1_799_999_999_500,
    errorCode: 'browser-mutation-failed',
  }
  setChromeTabsApi(harness.browserApi)
  yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
  const context = yield* Layer.build(buildService(harness))
  const service = Context.get(context, DesktopWindowMerge)

  const status = yield* service.getStatus(6, 30, true)

  assert.equal(status.session?.isOwner, false)
  assert.equal(status.session?.journal.ownerTabId, 99)
}))
