import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNativeTabHighlightController,
  type NativeTabHighlightDependencies,
} from '../src/extension/native-tab-highlight.js'
import { setChromeTabsApi } from '../src/extension/browser-tabs-gateway.js'

type HighlightCall = {
  tabIndexes: number[]
  windowId: number
}

function fakeTab(
  id: number,
  windowId: number,
  index: number,
  { active = false, highlighted = active }: { active?: boolean, highlighted?: boolean } = {},
): chrome.tabs.Tab {
  return {
    id,
    windowId,
    index,
    active,
    highlighted,
    pinned: false,
    groupId: -1,
  } as chrome.tabs.Tab
}

function fakeWindow(id: number, type: chrome.windows.Window['type'] = 'normal', focused = false): chrome.windows.Window {
  return {
    id,
    type,
    focused,
    alwaysOnTop: false,
    incognito: false,
  }
}

function createHarness(tabs: chrome.tabs.Tab[], windows: chrome.windows.Window[]) {
  const calls: HighlightCall[] = []
  const dependencies: NativeTabHighlightDependencies = {
    async getTab(tabId) {
      return tabs.find((tab) => tab.id === tabId) ?? null
    },
    async getWindow(windowId) {
      return windows.find((window) => window.id === windowId) ?? null
    },
    async highlightTabs(windowId, tabIndexes) {
      const windowTabs = tabs.filter((tab) => tab.windowId === windowId)
      const firstIndex = tabIndexes[0]
      if (!windowTabs.some((tab) => tab.index === firstIndex)) return false
      calls.push({ windowId, tabIndexes: tabIndexes.slice() })
      const selected = new Set(tabIndexes)
      for (const tab of windowTabs) {
        tab.active = tab.index === firstIndex
        tab.highlighted = selected.has(tab.index)
      }
      return true
    },
    async queryTabsInWindowResult(windowId) {
      return { ok: true, value: tabs.filter((tab) => tab.windowId === windowId) }
    },
  }
  return { calls, dependencies }
}

function highlightedIds(tabs: chrome.tabs.Tab[], windowId: number): number[] {
  return tabs
    .filter((tab) => tab.windowId === windowId && tab.highlighted)
    .map((tab) => tab.id as number)
}

test('the default controller resolves live browser operations through BrowserTabs', async (t) => {
  const tabs = [fakeTab(1, 1, 0, { active: true }), fakeTab(2, 1, 1)]
  const window = fakeWindow(1, 'normal', true)
  const calls: HighlightCall[] = []
  setChromeTabsApi({
    tabs: {
      async get(tabId) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('tab not found')
        return tab
      },
      async highlight({ windowId = 1, tabs: tabIndexes }) {
        const indexes = Array.isArray(tabIndexes) ? tabIndexes : [tabIndexes]
        calls.push({ windowId, tabIndexes: indexes })
        const selected = new Set(indexes)
        for (const tab of tabs) {
          tab.active = tab.windowId === windowId && tab.index === indexes[0]
          tab.highlighted = tab.windowId === windowId && selected.has(tab.index)
        }
        return window
      },
      async query({ windowId }) {
        return tabs.filter((tab) => windowId === undefined || tab.windowId === windowId)
      },
    },
    windows: {
      async get(windowId) {
        if (windowId !== window.id) throw new Error('window not found')
        return window
      },
    },
  })
  t.after(() => setChromeTabsApi(null))

  const controller = createNativeTabHighlightController()
  await controller.setTarget(2)

  assert.deepEqual(calls, [{ windowId: 1, tabIndexes: [0, 1] }])
})

test('native preview preserves the active tab and an existing multi-selection', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(2, 1, 1),
    fakeTab(3, 1, 2, { highlighted: true }),
  ]
  const harness = createHarness(tabs, [fakeWindow(1, 'normal', true)])
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(2)
  assert.deepEqual(harness.calls, [{ windowId: 1, tabIndexes: [0, 1, 2] }])
  assert.equal(tabs.find((tab) => tab.id === 1)?.active, true)

  await controller.clear()
  assert.deepEqual(harness.calls[1], { windowId: 1, tabIndexes: [0, 2] })
  assert.deepEqual(highlightedIds(tabs, 1), [1, 3])
})

test('moving between targets replaces the owned highlight in one window update', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(2, 1, 1),
    fakeTab(3, 1, 2),
  ]
  const harness = createHarness(tabs, [fakeWindow(1, 'normal', true)])
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(2)
  await controller.setTarget(3)

  assert.deepEqual(harness.calls, [
    { windowId: 1, tabIndexes: [0, 1] },
    { windowId: 1, tabIndexes: [0, 2] },
  ])
  assert.deepEqual(highlightedIds(tabs, 1), [1, 3])
})

test('cross-window preview changes only the target window selection', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(10, 2, 0, { active: true }),
    fakeTab(11, 2, 1),
    fakeTab(12, 2, 2, { highlighted: true }),
  ]
  const windows = [fakeWindow(1, 'normal', true), fakeWindow(2, 'normal', false)]
  const harness = createHarness(tabs, windows)
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(11)
  assert.deepEqual(harness.calls, [{ windowId: 2, tabIndexes: [0, 1, 2] }])
  assert.deepEqual(windows.map((window) => window.focused), [true, false])

  await controller.clear()
  assert.deepEqual(harness.calls[1], { windowId: 2, tabIndexes: [0, 2] })
})

test('clear removes only the owned target and preserves later native selections', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(2, 1, 1),
    fakeTab(3, 1, 2),
  ]
  const harness = createHarness(tabs, [fakeWindow(1, 'normal', true)])
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(2)
  const userSelectedTab = tabs.find((tab) => tab.id === 3)
  if (userSelectedTab) userSelectedTab.highlighted = true
  await controller.clear()

  assert.deepEqual(harness.calls[1], { windowId: 1, tabIndexes: [0, 2] })
  assert.deepEqual(highlightedIds(tabs, 1), [1, 3])
})

test('clear leaves a target alone when the user makes it active', async () => {
  const tabs = [fakeTab(1, 1, 0, { active: true }), fakeTab(2, 1, 1)]
  const harness = createHarness(tabs, [fakeWindow(1, 'normal', true)])
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(2)
  for (const tab of tabs) {
    tab.active = tab.id === 2
    tab.highlighted = tab.id === 2
  }
  await controller.clear()

  assert.equal(harness.calls.length, 1)
  assert.equal(tabs.find((tab) => tab.id === 2)?.active, true)
})

test('a stale zero-delay hover request cannot land after a newer target', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(2, 1, 1),
    fakeTab(3, 1, 2),
  ]
  const harness = createHarness(tabs, [fakeWindow(1, 'normal', true)])
  const { promise: firstRead, resolve: releaseFirstRead } = Promise.withResolvers<void>()
  const dependencies: NativeTabHighlightDependencies = {
    ...harness.dependencies,
    async getTab(tabId) {
      if (tabId === 2) await firstRead
      return harness.dependencies.getTab(tabId)
    },
  }
  const controller = createNativeTabHighlightController(dependencies)

  const first = controller.setTarget(2)
  await Promise.resolve()
  const second = controller.setTarget(3)
  releaseFirstRead()
  await Promise.all([first, second])

  assert.deepEqual(harness.calls, [{ windowId: 1, tabIndexes: [0, 2] }])
})

test('targets in windows without a normal tab rail are ignored', async () => {
  const tabs = [fakeTab(20, 9, 0, { active: true }), fakeTab(21, 9, 1)]
  const harness = createHarness(tabs, [fakeWindow(9, 'app', true)])
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(21)
  assert.deepEqual(harness.calls, [])
})

test('a rejected browser read does not wedge later highlight requests', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(2, 1, 1),
    fakeTab(3, 1, 2),
  ]
  const harness = createHarness(tabs, [fakeWindow(1, 'normal', true)])
  let rejectNextRead = true
  const controller = createNativeTabHighlightController({
    ...harness.dependencies,
    getTab(tabId) {
      if (rejectNextRead) {
        rejectNextRead = false
        return Promise.reject(new Error('transient tab read failure'))
      }
      return harness.dependencies.getTab(tabId)
    },
  })

  await controller.setTarget(2)
  await controller.setTarget(3)

  assert.deepEqual(harness.calls, [{ windowId: 1, tabIndexes: [0, 2] }])
})

for (const targetId of [1, 2]) {
  test(`clearing an already selected target (${targetId}) does not wedge later hovers`, async () => {
    const tabs = [
      fakeTab(1, 1, 0, { active: true }),
      fakeTab(2, 1, 1, { highlighted: true }),
      fakeTab(3, 1, 2),
    ]
    const harness = createHarness(tabs, [fakeWindow(1)])
    const controller = createNativeTabHighlightController(harness.dependencies)

    await controller.setTarget(targetId)
    await controller.clear()
    await controller.setTarget(3)

    assert.deepEqual(highlightedIds(tabs, 1), [1, 2, 3])
    await controller.clear()
    assert.deepEqual(highlightedIds(tabs, 1), [1, 2])
  })
}

test('closing the preview window does not block hovers in another window', async () => {
  const tabs = [
    fakeTab(1, 1, 0, { active: true }),
    fakeTab(2, 1, 1),
    fakeTab(10, 2, 0, { active: true }),
    fakeTab(11, 2, 1),
  ]
  const windows = [fakeWindow(1), fakeWindow(2)]
  const harness = createHarness(tabs, windows)
  const controller = createNativeTabHighlightController(harness.dependencies)

  await controller.setTarget(2)
  tabs.splice(0, 2)
  windows.splice(0, 1)
  await controller.setTarget(11)

  assert.deepEqual(highlightedIds(tabs, 2), [10, 11])
  await controller.clear()
  assert.deepEqual(highlightedIds(tabs, 2), [10])
})

test('a failed cleanup read retains ownership so a later clear can retry', async () => {
  const tabs = [fakeTab(1, 1, 0, { active: true }), fakeTab(2, 1, 1)]
  const harness = createHarness(tabs, [fakeWindow(1)])
  let failRead = false
  const controller = createNativeTabHighlightController({
    ...harness.dependencies,
    async queryTabsInWindowResult(windowId) {
      return failRead ? { ok: false, value: [] } : harness.dependencies.queryTabsInWindowResult(windowId)
    },
  })

  await controller.setTarget(2)
  failRead = true
  await controller.clear()
  assert.deepEqual(highlightedIds(tabs, 1), [1, 2])
  failRead = false
  await controller.clear()
  assert.deepEqual(highlightedIds(tabs, 1), [1])
})

test('clearing during a pending highlight removes the selection once Chrome applies it', async () => {
  const tabs = [fakeTab(1, 1, 0, { active: true }), fakeTab(2, 1, 1)]
  const harness = createHarness(tabs, [fakeWindow(1)])
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const controller = createNativeTabHighlightController({
    ...harness.dependencies,
    async highlightTabs(windowId, indexes) {
      started.resolve()
      await finish.promise
      return harness.dependencies.highlightTabs(windowId, indexes)
    },
  })

  const preview = controller.setTarget(2)
  await started.promise
  const clear = controller.clear()
  finish.resolve()
  await Promise.all([preview, clear])
  assert.deepEqual(highlightedIds(tabs, 1), [1])
})
