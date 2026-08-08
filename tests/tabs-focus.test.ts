import assert from 'node:assert/strict'
import test from 'node:test'

import { replaceDashboardRefreshForTesting } from '../src/extension/dashboard-intake.js'
import { closeChipTarget, closeDomainTabs, closeExactTabSection, closeExactTabTargets, closeFilteredTabs, closeSuspendedDomainTabs, dedupeTabs, tabCloseProgressLabel } from '../src/extension/tab-actions.js'
import { closeHistoryEntry, focusHistoryEntryResult } from '../src/extension/tab-history.js'
import { focusExactTabTargetResult, focusExistingTabTargetResult, tabFocusResultToastMessage } from '../src/extension/tab-focus.js'
import { closeTabsByTargetsResult, closeTabsExactResult, focusExactTabOrOpenResult, focusTab, openTabUrl, openTabUrlInNewWindow, snapshotChromeTabs } from '../src/extension/tabs.js'
import { markClosure, switchToRestoredTab, undoLastClose } from '../src/extension/undo.js'
import { focusWorkingSetItemResult } from '../src/extension/working-set-client.js'

type ChromeMockCalls = {
  create: chrome.tabs.CreateProperties[]
  remove: number[]
  runtimeMessages: Array<{ extensionId: string; message: Record<string, unknown> }>
  tabsQuery: number
  tabsUpdate: Array<{ tabId: number; updateProperties: chrome.tabs.UpdateProperties }>
  windowsCreate: chrome.windows.CreateData[]
  windowsUpdate: Array<{ windowId: number; updateProperties: chrome.windows.UpdateInfo }>
}

function createChromeMock(initialTabs: any[], currentWindowId = 1) {
  const tabs = initialTabs.map((tab) => ({ ...tab }))
  const calls: ChromeMockCalls = {
    create: [],
    remove: [],
    runtimeMessages: [],
    tabsQuery: 0,
    tabsUpdate: [],
    windowsCreate: [],
    windowsUpdate: []
  }

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      async sendMessage(extensionId: string, message: Record<string, unknown>) {
        calls.runtimeMessages.push({ extensionId, message: { ...message } })
        if (extensionId === 'blocked') throw new Error('Cannot message extension')
        if (extensionId === 'rejects') return 'Error: tab is not suspended'
        return undefined
      }
    },
    tabs: {
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error(`No tab with id: ${tabId}`)
        return { ...tab }
      },
      async query() {
        calls.tabsQuery += 1
        return tabs.map((tab) => ({ ...tab }))
      },
      async update(tabId: number, updateProperties: chrome.tabs.UpdateProperties) {
        calls.tabsUpdate.push({ tabId, updateProperties: { ...updateProperties } })
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) return undefined

        if (updateProperties.active) {
          for (const candidate of tabs) {
            if (candidate.windowId === tab.windowId) candidate.active = false
          }
        }
        Object.assign(tab, updateProperties)
        return { ...tab }
      },
      async create(createProperties: chrome.tabs.CreateProperties) {
        calls.create.push({ ...createProperties })
        if (createProperties.url === 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs') {
          throw new Error('Cannot create blocked extension URL')
        }
        const nextId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1
        const windowId = createProperties.windowId ?? currentWindowId
        const windowTabs = tabs.filter((tab) => tab.windowId === windowId)
        const requestedIndex = typeof createProperties.index === 'number' && Number.isInteger(createProperties.index)
          ? createProperties.index
          : windowTabs.length
        const insertionIndex = Math.max(0, Math.min(requestedIndex, windowTabs.length))
        for (const candidate of windowTabs) {
          const candidateIndex = Number.isInteger(candidate.index) ? candidate.index : windowTabs.indexOf(candidate)
          if (candidateIndex >= insertionIndex) candidate.index = candidateIndex + 1
        }
        const tab = {
          id: nextId,
          windowId,
          url: createProperties.url || 'chrome://newtab/',
          title: '',
          active: !!createProperties.active,
          pinned: !!createProperties.pinned,
          groupId: -1,
          index: insertionIndex
        }
        tabs.push(tab)
        return { ...tab }
      },
      async remove(tabIds: number | number[]) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        calls.remove.push(...ids)
        for (const id of ids) {
          const index = tabs.findIndex((tab) => tab.id === id)
          if (index !== -1) tabs.splice(index, 1)
        }
      }
    },
    windows: {
      async getCurrent() {
        return { id: currentWindowId, type: 'normal' }
      },
      async getAll() {
        return Array.from(new Set(tabs.map((tab) => tab.windowId))).map((id) => ({ id, type: 'normal' }))
      },
      async create(createProperties: chrome.windows.CreateData) {
        calls.windowsCreate.push({ ...createProperties })
        const windowId = Math.max(0, ...tabs.map((tab) => Number(tab.windowId) || 0)) + 1
        const nextId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1
        const tab = {
          id: nextId,
          windowId,
          url: createProperties.url || 'chrome://newtab/',
          title: '',
          active: true,
          pinned: false,
          groupId: -1,
          index: 0
        }
        tabs.push(tab)
        return { id: windowId, type: createProperties.type || 'normal', focused: !!createProperties.focused, tabs: [{ ...tab }] }
      },
      async update(windowId: number, updateProperties: chrome.windows.UpdateInfo) {
        calls.windowsUpdate.push({ windowId, updateProperties: { ...updateProperties } })
        return { id: windowId, type: 'normal', focused: !!updateProperties.focused }
      }
    }
  }

  return { calls, tabs }
}

test('focusTab does not pin an existing Tab Out tab when focusing a chip target', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: tabOutUrl, title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: tabOutUrl, title: 'Tab Out', active: false, pinned: false, groupId: -1 },
    { id: 3, windowId: 2, url: 'https://example.com/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.create, [])
  assert.equal(tabs.find((tab) => tab.id === 2).pinned, false)
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 3, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusTab does not create a pinned Tab Out tab when focusing a chip target in another window', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: tabOutUrl, title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: 'https://example.com/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusTab reports failure when Chrome rejects tab activation', async () => {
  createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: 'https://example.test/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.tabs.update = async () => {
    throw new Error('Tab disappeared')
  }

  assert.equal(await focusTab('https://example.test/docs'), false)
})

test('focusTab reports failure when Chrome rejects window focus', async () => {
  createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: 'https://example.test/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.windows.update = async () => {
    throw new Error('Window disappeared')
  }

  assert.equal(await focusTab('https://example.test/docs'), false)
})

test('exact live-tab focus reports activation separately from failed window focus', async () => {
  const url = 'https://example.test/docs'
  createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.windows.update = async () => {
    throw new Error('Window focus unavailable')
  }

  const result = await focusExistingTabTargetResult({ tabId: 2, url })

  assert.deepEqual(result, { status: 'activated' })
})

test('exact live-tab focus follows a tab that moves windows during activation', async () => {
  const url = 'https://example.test/docs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  const updateTab = (globalThis as any).chrome.tabs.update.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.update = async (tabId: number, properties: chrome.tabs.UpdateProperties) => ({
    ...await updateTab(tabId, properties),
    windowId: 3
  })

  const result = await focusExistingTabTargetResult({ tabId: 2, url })

  assert.deepEqual(result, { status: 'focused' })
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 3, updateProperties: { focused: true } }])
})

test('exact focus follows pending navigation identity instead of the stale committed URL', async () => {
  const oldUrl = 'https://example.test/old'
  const pendingUrl = 'https://example.test/pending'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: oldUrl, pendingUrl, title: 'Navigating', active: false, pinned: false, groupId: -1 }
  ])

  assert.deepEqual(
    await focusExistingTabTargetResult({ tabId: 2, url: oldUrl }),
    { status: 'not-found' }
  )
  assert.deepEqual(await focusExactTabTargetResult(oldUrl), { status: 'not-found' })
  assert.deepEqual(await focusExistingTabTargetResult({ tabId: 2, url: pendingUrl }), { status: 'focused' })
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
})

test('exact focus reads tabs after current-window state settles', async () => {
  const targetUrl = 'https://example.test/docs'
  const pendingUrl = 'https://example.test/other'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: targetUrl, title: 'Leaving', active: false, pinned: false, groupId: -1 }
  ])
  const { promise: currentWindowGate, resolve: releaseCurrentWindow } = Promise.withResolvers<void>()
  let navigationStarted = false
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    await currentWindowGate
    navigationStarted = true
    return { id: 1, type: 'normal' }
  }
  ;(globalThis as any).chrome.tabs.query = async () => {
    calls.tabsQuery += 1
    return [{
      id: 2,
      windowId: 2,
      url: targetUrl,
      ...(navigationStarted ? { pendingUrl } : {}),
      title: 'Leaving',
      active: false,
      pinned: false,
      groupId: -1
    }]
  }

  const resultPromise = focusExactTabTargetResult(targetUrl)
  await Promise.resolve()

  assert.equal(calls.tabsQuery, 0)
  releaseCurrentWindow()
  const result = await resultPromise

  assert.deepEqual(result, { status: 'not-found' })
  assert.equal(calls.tabsQuery, 1)
  assert.deepEqual(calls.tabsUpdate, [])
})

test('legacy focus reads tabs after current-window state settles', async () => {
  const targetUrl = 'https://example.test/docs'
  const pendingUrl = 'https://other.example.test/'
  const { calls } = createChromeMock([
    { id: 2, windowId: 2, url: targetUrl, title: 'Leaving', active: false, pinned: false, groupId: -1 }
  ])
  const { promise: currentWindowGate, resolve: releaseCurrentWindow } = Promise.withResolvers<void>()
  let navigationStarted = false
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    await currentWindowGate
    navigationStarted = true
    return { id: 1, type: 'normal' }
  }
  ;(globalThis as any).chrome.tabs.query = async () => {
    calls.tabsQuery += 1
    return [{
      id: 2,
      windowId: 2,
      url: targetUrl,
      ...(navigationStarted ? { pendingUrl } : {}),
      title: 'Leaving',
      active: false,
      pinned: false,
      groupId: -1
    }]
  }

  const resultPromise = focusTab(targetUrl)
  await Promise.resolve()

  assert.equal(calls.tabsQuery, 0)
  releaseCurrentWindow()
  assert.equal(await resultPromise, false)
  assert.equal(calls.tabsQuery, 1)
  assert.deepEqual(calls.tabsUpdate, [])
})

test('exact live-tab focus reports a rejected activation without opening a duplicate', async () => {
  const url = 'https://example.test/docs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.tabs.update = async () => {
    throw new Error('Tab activation unavailable')
  }

  const existingResult = await focusExistingTabTargetResult({ tabId: 2, url })
  const exactResult = await focusExactTabTargetResult(url)
  const openResult = await focusExactTabOrOpenResult(url)

  assert.deepEqual(existingResult, { status: 'failed' })
  assert.deepEqual(exactResult, { status: 'failed' })
  assert.deepEqual(openResult, { status: 'failed' })
  assert.deepEqual(calls.create, [])
})

test('read-only activation preserves partial success without opening a duplicate', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: 'https://example.test/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.windows.update = async () => {
    throw new Error('Window disappeared')
  }

  const result = await focusExactTabOrOpenResult('https://example.test/docs')

  assert.deepEqual(result, { status: 'activated' })
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.create, [])
})

test('tab focus feedback distinguishes partial activation, failure, stale identity, and unreadable inventory', () => {
  assert.equal(tabFocusResultToastMessage('focused'), null)
  assert.equal(tabFocusResultToastMessage('activated'), 'Tab activated, but its window could not be focused')
  assert.equal(tabFocusResultToastMessage('failed'), 'Could not activate tab')
  assert.equal(tabFocusResultToastMessage('not-found'), 'Tab is no longer open')
  assert.equal(tabFocusResultToastMessage('unknown'), 'Could not read open tabs')
})

test('read-only activation reports failure without opening when the tab inventory is unknown', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.tabs.query = async () => {
    throw new Error('tabs unavailable')
  }

  const result = await focusExactTabOrOpenResult('https://example.test/docs')

  assert.deepEqual(result, { status: 'unknown' })
  assert.deepEqual(calls.create, [])
})

test('closeChipTarget closes and can undo the exact represented Tab Out sibling without animating the survivor', async () => {
  const cleanup = replaceDashboardRefreshForTesting(() => {})
  try {
    const tabOutUrl = 'chrome-extension://tab-out/index.html'
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url: tabOutUrl, title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url: tabOutUrl, title: 'Tab Out', active: false, pinned: true, groupId: -1 }
    ])

    const result = await closeChipTarget({ tabUrl: tabOutUrl, tabId: 2 })

    assert.deepEqual(calls.remove, [2])
    assert.equal(calls.tabsQuery, 1)
    assert.deepEqual(tabs.map((tab) => tab.id), [1])
    assert.equal(result.ok, true)
    assert.equal(result.status, 'complete')
    assert.equal(result.attemptedCount, 1)
    assert.equal(result.removedCount, 1)
    assert.equal(result.failedCount, 0)
    assert.deepEqual(result.snapshot.map((tab) => ({ url: tab.url, title: tab.title })), [
      { url: tabOutUrl, title: 'Tab Out' }
    ])
    assert.equal(result.shouldAnimateRemoval, false)

    await undoLastClose()

    assert.equal(calls.create.at(-1)?.url, tabOutUrl)
    assert.equal(calls.create.at(-1)?.active, false)
  } finally {
    cleanup()
  }
})

test('closeChipTarget does not close a same-URL sibling when its exact tab id is stale', async () => {
  const cleanup = replaceDashboardRefreshForTesting(() => {})
  try {
    const tabOutUrl = 'chrome-extension://tab-out/index.html'
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url: tabOutUrl, title: 'Current Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 3, windowId: 1, url: tabOutUrl, title: 'Pinned Tab Out', active: false, pinned: true, groupId: -1 }
    ])

    const result = await closeChipTarget({ tabUrl: tabOutUrl, tabId: 2 })

    assert.deepEqual(calls.remove, [])
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 3])
    assert.deepEqual(result.snapshot, [])
  } finally {
    cleanup()
  }
})

test('closeChipTarget rejects a reused same-URL id whose physical Tab Out state changed', async () => {
  const cleanup = replaceDashboardRefreshForTesting(() => {})
  try {
    const tabOutUrl = 'chrome-extension://tab-out/index.html'
    const { calls, tabs } = createChromeMock([
      { id: 2, windowId: 1, url: tabOutUrl, title: 'Ordinary Tab Out', active: false, pinned: false, groupId: -1 }
    ])

    const result = await closeChipTarget({
      tabUrl: tabOutUrl,
      tabId: 2,
      expectedPinned: true,
      expectedGroupId: -1
    })

    assert.deepEqual(calls.remove, [])
    assert.deepEqual(tabs.map((tab) => tab.id), [2])
    assert.deepEqual(result.snapshot, [])
  } finally {
    cleanup()
  }
})

test('close actions report unknown and preserve tabs when the live inventory cannot be read', async () => {
  let refreshCount = 0
  const cleanup = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  try {
    const url = 'https://example.test/docs'
    const { calls, tabs } = createChromeMock([
      { id: 2, windowId: 1, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])
    ;(globalThis as any).chrome.tabs.query = async () => {
      throw new Error('Tab inventory unavailable')
    }
    const target = { tabId: 2, tabUrl: url }
    const dashboardTab = {
      ...tabs[0],
      rawUrl: url,
      suspended: false,
      favIconUrl: '',
      isTabOut: false,
      isApp: false
    }
    let afterCloseCount = 0
    const onAfterClose = () => {
      afterCloseCount += 1
    }

    const results = [
      await closeFilteredTabs([target]),
      await closeDomainTabs({
        group: { domain: 'example.test', tabs: [dashboardTab] },
        filter: '',
        displayName: 'example.test',
        onAfterClose
      }),
      await closeExactTabSection({ urls: [url] }),
      await closeExactTabTargets({ targets: [target] }),
      await dedupeTabs({ urls: [url], onAfterClose }),
      await closeChipTarget({ tabUrl: url, tabId: 2, onAfterClose })
    ]

    assert.ok(results.every((result) => result.ok === false))
    assert.ok(results.every((result) => result.snapshot.length === 0))
    assert.deepEqual(calls.remove, [])
    assert.deepEqual(tabs.map((tab) => tab.id), [2])
    assert.equal(afterCloseCount, 0)
    assert.equal(refreshCount, 0)
  } finally {
    cleanup()
  }
})

test('confirmed close keeps a working Undo when the follow-up dashboard refresh rejects', async () => {
  const cleanup = replaceDashboardRefreshForTesting(async () => {
    throw new Error('Required refresh state unavailable')
  })
  try {
    const url = 'https://example.test/docs'
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])

    const result = await closeChipTarget({ tabUrl: url, tabId: 2 })
    assert.equal(result.snapshot.length, 1)
    assert.deepEqual(tabs.map((tab) => tab.id), [1])

    await undoLastClose()

    assert.equal(calls.create.at(-1)?.url, url)
    assert.equal(calls.create.at(-1)?.active, false)
  } finally {
    cleanup()
  }
})

test('closeChipTarget preserves a confirmed partial close without animating surviving variants', async () => {
  let refreshCount = 0
  const cleanup = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  try {
    const keptUrl = 'https://alpha.example.test/docs'
    const closedUrl = 'https://beta.example.test/docs'
    const { tabs } = createChromeMock([
      { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url: keptUrl, title: 'Docs', active: false, pinned: false, groupId: -1 },
      { id: 3, windowId: 1, url: closedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])
    const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
    ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
      if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
      if (tabIds === 2) throw new Error('Tab is managed')
      await removeTab(tabIds)
    }

    const result = await closeChipTarget({
      tabUrl: keptUrl,
      envs: [{ tabUrl: keptUrl }, { tabUrl: closedUrl }] as any
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'partial')
    assert.equal(result.attemptedCount, 2)
    assert.equal(result.removedCount, 1)
    assert.equal(result.failedCount, 1)
    assert.deepEqual(result.snapshot.map((tab) => tab.url), [closedUrl])
    assert.equal(result.shouldAnimateRemoval, false)
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
    assert.equal(refreshCount, 0)
  } finally {
    cleanup()
  }
})

test('closeChipTarget reports total write failure without refresh or removal animation', async () => {
  let refreshCount = 0
  const cleanup = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  try {
    const url = 'https://example.test/docs'
    const { tabs } = createChromeMock([
      { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])
    ;(globalThis as any).chrome.tabs.remove = async () => {
      throw new Error('Tab is managed')
    }
    const callbackResults: unknown[] = []

    const result = await closeChipTarget({
      tabUrl: url,
      tabId: 2,
      onAfterClose: (callbackResult) => {
        callbackResults.push(callbackResult)
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.attemptedCount, 1)
    assert.equal(result.removedCount, 0)
    assert.equal(result.failedCount, 1)
    assert.deepEqual(result.snapshot, [])
    assert.equal(result.shouldAnimateRemoval, false)
    assert.deepEqual(callbackResults, [result])
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
    assert.equal(refreshCount, 0)
  } finally {
    cleanup()
  }
})

test('bulk close returns undo snapshots only for tabs Chrome actually removed', async () => {
  const { tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 1, url: 'https://kept.example.test/', title: 'Kept', active: false, pinned: false, groupId: -1 },
    { id: 3, windowId: 1, url: 'https://closed.example.test/', title: 'Closed', active: false, pinned: false, groupId: -1 }
  ])
  const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
    if (Array.isArray(tabIds)) throw new Error('Batch contains a tab Chrome cannot close')
    if (tabIds === 2) throw new Error('Tab is managed')
    await removeTab(tabIds)
  }

  const { value: snapshot } = await closeTabsExactResult([
    'https://kept.example.test/',
    'https://closed.example.test/'
  ])

  assert.deepEqual(snapshot.map((tab) => tab.url), ['https://closed.example.test/'])
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
})

test('closeTabsExactResult reports a rejected removal as a failed mutation', async () => {
  const url = 'https://example.test/docs'
  const { tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 1, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.tabs.remove = async () => {
    throw new Error('Tab is managed')
  }

  const result = await closeTabsExactResult([url])

  assert.deepEqual(result, {
    ok: false,
    status: 'failed',
    value: [],
    attemptedCount: 1,
    removedCount: 0,
    failedCount: 1
  })
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
})

test('closeTabsByTargetsResult preserves confirmed snapshots and reports a partial mutation', async () => {
  const keptUrl = 'https://example.test/kept'
  const closedUrl = 'https://example.test/closed'
  const { tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 1, url: keptUrl, title: 'Kept', active: false, pinned: false, groupId: -1 },
    { id: 3, windowId: 1, url: closedUrl, title: 'Closed', active: false, pinned: false, groupId: -1 }
  ])
  const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
    if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
    if (tabIds === 2) throw new Error('Tab is managed')
    await removeTab(tabIds)
  }

  const result = await closeTabsByTargetsResult([
    { tabId: 2, tabUrl: keptUrl },
    { tabId: 3, tabUrl: closedUrl }
  ])

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial')
  assert.equal(result.attemptedCount, 2)
  assert.equal(result.removedCount, 1)
  assert.equal(result.failedCount, 1)
  assert.deepEqual(result.value.map((tab) => tab.url), [closedUrl])
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
})

test('batch-close fallback revalidates remaining tab identities before retrying', async () => {
  const keptUrl = 'https://example.test/kept'
  const staleTargetUrl = 'https://example.test/stale-target'
  const unrelatedUrl = 'https://example.test/unrelated'
  const { tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 1, url: keptUrl, title: 'Kept', active: false, pinned: false, groupId: -1 },
    { id: 3, windowId: 1, url: staleTargetUrl, title: 'Stale target', active: false, pinned: false, groupId: -1 }
  ])
  const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
    if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
    if (tabIds === 2) {
      const remaining = tabs.find((tab) => tab.id === 3)
      remaining.url = unrelatedUrl
      remaining.pendingUrl = unrelatedUrl
      throw new Error('Tab is managed')
    }
    await removeTab(tabIds)
  }

  const result = await closeTabsByTargetsResult([
    { tabId: 2, tabUrl: keptUrl },
    { tabId: 3, tabUrl: staleTargetUrl }
  ])

  assert.equal(result.status, 'failed')
  assert.equal(result.removedCount, 0)
  assert.deepEqual(result.value, [])
  assert.deepEqual(tabs.map((tab) => ({ id: tab.id, url: tab.url })), [
    { id: 1, url: 'chrome-extension://tab-out/index.html' },
    { id: 2, url: keptUrl },
    { id: 3, url: unrelatedUrl }
  ])
})

test('close paths prefer a pending navigation over the stale committed URL', async () => {
  const targetUrl = 'https://example.test/target'
  const otherUrl = 'https://example.test/other'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 1, url: targetUrl, pendingUrl: otherUrl, title: 'Leaving target', active: false, pinned: false, groupId: -1 },
    { id: 3, windowId: 1, url: otherUrl, pendingUrl: targetUrl, title: 'Entering target', active: false, pinned: false, groupId: -1 }
  ])

  const exactResult = await closeTabsExactResult([targetUrl])

  assert.deepEqual(calls.remove, [3])
  assert.deepEqual(exactResult.value.map((tab) => tab.url), [targetUrl])
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])

  const targetedResult = await closeTabsByTargetsResult([{ tabId: 2, tabUrl: targetUrl }])

  assert.equal(targetedResult.attemptedCount, 0)
  assert.deepEqual(calls.remove, [3])
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
})

test('closeExactTabSection keeps partial Undo and delegates removal refresh to the retention settlement listener', async () => {
  let refreshCount = 0
  const cleanup = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  try {
    const keptUrl = 'https://example.test/kept'
    const closedUrl = 'https://example.test/closed'
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url: keptUrl, title: 'Kept', active: false, pinned: false, groupId: -1 },
      { id: 3, windowId: 1, url: closedUrl, title: 'Closed', active: false, pinned: false, groupId: -1 }
    ])
    const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
    ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
      if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
      if (tabIds === 2) throw new Error('Tab is managed')
      await removeTab(tabIds)
    }

    const result = await closeExactTabSection({ urls: [keptUrl, closedUrl] })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'partial')
    assert.equal(result.attemptedCount, 2)
    assert.equal(result.removedCount, 1)
    assert.equal(result.failedCount, 1)
    assert.deepEqual(result.snapshot.map((tab) => tab.url), [closedUrl])
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
    assert.equal(refreshCount, 0)

    await undoLastClose()

    assert.equal(calls.create.at(-1)?.url, closedUrl)
    assert.equal(calls.create.at(-1)?.active, false)
  } finally {
    cleanup()
  }
})

test('closeExactTabTargets reports total write failure without refreshing', async () => {
  let refreshCount = 0
  const cleanup = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  try {
    const url = 'https://example.test/docs'
    const { tabs } = createChromeMock([
      { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])
    ;(globalThis as any).chrome.tabs.remove = async () => {
      throw new Error('Tab is managed')
    }

    const result = await closeExactTabTargets({ targets: [{ tabId: 2, tabUrl: url }] })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.attemptedCount, 1)
    assert.equal(result.removedCount, 0)
    assert.equal(result.failedCount, 1)
    assert.deepEqual(result.snapshot, [])
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 2])
    assert.equal(refreshCount, 0)
  } finally {
    cleanup()
  }
})

test('tab close feedback distinguishes total, partial, and complete writes', () => {
  assert.equal(tabCloseProgressLabel(0, 1), 'Could not close tab')
  assert.equal(tabCloseProgressLabel(0, 2), 'Could not close 2 tabs')
  assert.equal(tabCloseProgressLabel(1, 2), 'Closed 1 of 2 tabs')
  assert.equal(tabCloseProgressLabel(2, 2), 'Closed 2 tabs')
  assert.equal(tabCloseProgressLabel(1, 2, 'duplicates'), 'Closed 1 of 2 duplicates')
})

test('dedupeTabs reports a partial close, keeps Undo, and delegates removal refresh to retention settlement', async () => {
  let refreshCount = 0
  const cleanup = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  try {
    const url = 'https://example.test/docs'
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url, title: 'Oldest', active: false, pinned: false, groupId: -1, index: 0, lastAccessed: 100 },
      { id: 2, windowId: 1, url, title: 'Middle', active: false, pinned: false, groupId: -1, index: 1, lastAccessed: 200 },
      { id: 3, windowId: 1, url, title: 'Newest', active: true, pinned: false, groupId: -1, index: 2, lastAccessed: 300 }
    ])
    const removeTab = (globalThis as any).chrome.tabs.remove.bind((globalThis as any).chrome.tabs)
    ;(globalThis as any).chrome.tabs.remove = async (tabIds: number | number[]) => {
      if (Array.isArray(tabIds)) throw new Error('Batch removal unavailable')
      if (tabIds === 1) throw new Error('Tab is managed')
      await removeTab(tabIds)
    }
    const callbackResults: unknown[] = []

    const result = await dedupeTabs({
      urls: [url],
      onAfterClose: (callbackResult) => {
        callbackResults.push(callbackResult)
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'partial')
    assert.equal(result.attemptedCount, 2)
    assert.equal(result.removedCount, 1)
    assert.equal(result.failedCount, 1)
    assert.deepEqual(result.snapshot.map((tab) => tab.title), ['Middle'])
    assert.deepEqual(callbackResults, [result])
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 3])
    assert.equal(refreshCount, 0)

    await undoLastClose()

    assert.equal(calls.create.at(-1)?.url, url)
    assert.equal(calls.create.at(-1)?.active, false)
  } finally {
    cleanup()
  }
})

test('bulk close preserves a pinned Tab Out copy and snapshots the ordinary copy for undo', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: tabOutUrl, title: 'Pinned Tab Out', active: false, pinned: true, groupId: -1 },
    { id: 2, windowId: 1, url: tabOutUrl, title: 'Ordinary Tab Out', active: false, pinned: false, groupId: -1 }
  ])

  const { value: snapshot } = await closeTabsExactResult([tabOutUrl], { preserveGroups: true })

  assert.deepEqual(calls.remove, [2])
  assert.deepEqual(tabs.map((tab) => tab.id), [1])
  assert.deepEqual(snapshot.map((tab) => ({ url: tab.url, title: tab.title })), [
    { url: tabOutUrl, title: 'Ordinary Tab Out' }
  ])
})

test('targeted bulk close does not expand one matching duplicate into every same-URL tab', async () => {
  const url = 'https://example.test/shared'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url, title: 'Alpha match', active: false, pinned: false, groupId: -1 },
    { id: 2, windowId: 1, url, title: 'Beta non-match', active: false, pinned: false, groupId: -1 }
  ])

  const { value: snapshot } = await closeTabsByTargetsResult([{ tabId: 1, tabUrl: url }], { preserveGroups: true })

  assert.deepEqual(calls.remove, [1])
  assert.deepEqual(tabs.map((tab) => tab.id), [2])
  assert.deepEqual(snapshot.map((tab) => tab.title), ['Alpha match'])
})

test('filtered domain close keeps a same-URL tab whose title does not match', async () => {
  const cleanup = replaceDashboardRefreshForTesting(() => {})
  const previousDocument = globalThis.document
  ;(globalThis as { document?: unknown }).document = { getElementById: () => null }
  try {
    const url = 'https://example.test/shared'
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url, title: 'Alpha match', active: false, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url, title: 'Beta non-match', active: false, pinned: false, groupId: -1 }
    ])
    const result = await closeDomainTabs({
      group: {
        domain: 'example.test',
        tabs: tabs.map((tab) => ({
          ...tab,
          rawUrl: tab.url,
          suspended: false,
          favIconUrl: '',
          isTabOut: false,
          isApp: false
        }))
      },
      filter: 'alpha',
      displayName: 'example.test'
    })

    assert.deepEqual(calls.remove, [1])
    assert.deepEqual(tabs.map((tab) => tab.id), [2])
    assert.deepEqual(result.snapshot.map((tab) => tab.title), ['Alpha match'])
  } finally {
    cleanup()
    ;(globalThis as { document?: unknown }).document = previousDocument
  }
})

test('close suspended domain tabs closes only live suspended tabs in the bulk-action scope', async () => {
  const cleanup = replaceDashboardRefreshForTesting(() => {})
  const previousDocument = globalThis.document
  ;(globalThis as { document?: unknown }).document = { getElementById: () => null }
  try {
    const activeUrl = 'https://example.test/active'
    const suspendedUrl = 'https://example.test/suspended'
    const groupedUrl = 'https://example.test/grouped'
    const suspendedRawUrl = `chrome-extension://suspender/suspended.html#uri=${encodeURIComponent(suspendedUrl)}`
    const groupedRawUrl = `chrome-extension://suspender/suspended.html#uri=${encodeURIComponent(groupedUrl)}`
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url: activeUrl, title: 'Active', active: false, pinned: false, groupId: -1 },
      { id: 2, windowId: 1, url: suspendedRawUrl, title: 'Suspended', active: false, pinned: false, groupId: -1 },
      { id: 3, windowId: 1, url: groupedRawUrl, title: 'Grouped', active: false, pinned: false, groupId: 7 }
    ])
    const dashboardTabs = [
      { id: 1, url: activeUrl, rawUrl: activeUrl, suspended: false, title: 'Active', favIconUrl: '', windowId: 1, active: false, pinned: false, groupId: -1, isTabOut: false, isApp: false },
      { id: 2, url: suspendedUrl, rawUrl: suspendedRawUrl, suspended: true, title: 'Suspended', favIconUrl: '', windowId: 1, active: false, pinned: false, groupId: -1, isTabOut: false, isApp: false },
      { id: 3, url: groupedUrl, rawUrl: groupedRawUrl, suspended: true, title: 'Grouped', favIconUrl: '', windowId: 1, active: false, pinned: false, groupId: 7, isTabOut: false, isApp: false }
    ]

    const result = await closeSuspendedDomainTabs({
      group: { domain: 'example.test', tabs: dashboardTabs },
      filter: '',
      displayName: 'example.test'
    })

    assert.deepEqual(calls.remove, [2])
    assert.deepEqual(tabs.map((tab) => tab.id), [1, 3])
    assert.deepEqual(result.snapshot.map((tab) => tab.rawUrl), [suspendedRawUrl])
  } finally {
    cleanup()
    ;(globalThis as { document?: unknown }).document = previousDocument
  }
})

test('close suspended domain tabs preserves a target that woke before the action resolved', async () => {
  const cleanup = replaceDashboardRefreshForTesting(() => {})
  const previousDocument = globalThis.document
  ;(globalThis as { document?: unknown }).document = { getElementById: () => null }
  try {
    const url = 'https://example.test/docs'
    const suspendedRawUrl = `chrome-extension://suspender/suspended.html#uri=${encodeURIComponent(url)}`
    const { calls, tabs } = createChromeMock([
      { id: 2, windowId: 1, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])

    const result = await closeSuspendedDomainTabs({
      group: {
        domain: 'example.test',
        tabs: [{
          id: 2,
          url,
          rawUrl: suspendedRawUrl,
          suspended: true,
          title: 'Docs',
          favIconUrl: '',
          windowId: 1,
          active: false,
          pinned: false,
          groupId: -1,
          isTabOut: false,
          isApp: false
        }]
      },
      filter: '',
      displayName: 'example.test'
    })

    assert.deepEqual(calls.remove, [])
    assert.deepEqual(tabs.map((tab) => tab.id), [2])
    assert.deepEqual(result.snapshot, [])
  } finally {
    cleanup()
    ;(globalThis as { document?: unknown }).document = previousDocument
  }
})

test('focusTab asks the owning suspender extension to unsuspend an exact suspended match', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'marvellous',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('suspended-tab focus revalidates identity after external unsuspend messaging', async () => {
  const targetUrl = 'https://example.com/docs'
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'

  for (const messageOutcome of ['success', 'failure'] as const) {
    const { calls, tabs } = createChromeMock([
      { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
      { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
    ])
    const { promise: messageBlocked, resolve: releaseMessage } = Promise.withResolvers<void>()
    const { promise: messageStarted, resolve: markMessageStarted } = Promise.withResolvers<void>()
    ;(globalThis as any).chrome.runtime.sendMessage = async () => {
      markMessageStarted()
      await messageBlocked
      if (messageOutcome === 'failure') throw new Error('Suspender unavailable')
      return undefined
    }

    const focusPromise = focusExistingTabTargetResult({
      tabId: 2,
      url: targetUrl,
      rawUrl: suspendedUrl
    })
    await messageStarted
    const target = tabs.find((tab) => tab.id === 2)
    target.url = 'https://example.test/unrelated'
    target.pendingUrl = 'https://example.test/unrelated'
    releaseMessage()

    assert.deepEqual(await focusPromise, { status: 'not-found' }, messageOutcome)
    assert.deepEqual(calls.tabsUpdate, [], messageOutcome)
    assert.deepEqual(calls.windowsUpdate, [], messageOutcome)
    assert.equal(target.url, 'https://example.test/unrelated', messageOutcome)
  }
})

test('focusTab unsuspends directly when the owning suspender extension cannot be messaged', async () => {
  const suspendedUrl = 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'blocked',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true, url: 'https://example.com/docs' } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2).url, 'https://example.com/docs')
})

test('focusTab unsuspends directly when the owning suspender extension rejects the request', async () => {
  const suspendedUrl = 'chrome-extension://rejects/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'rejects',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true, url: 'https://example.com/docs' } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2).url, 'https://example.com/docs')
})

test('focusHistoryEntry uses the same suspended-tab activation path as page chips', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const result = await focusHistoryEntryResult({
    exists: true,
    tabId: 2,
    windowId: 2,
    url: 'https://example.com/docs',
    rawUrl: suspendedUrl
  } as any)

  assert.deepEqual(result, { status: 'focused' })
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'marvellous',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusHistoryEntryResult exposes a rejected activation to the history UI', async () => {
  const url = 'https://example.test/docs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.tabs.update = async () => {
    throw new Error('Tab activation unavailable')
  }

  const result = await focusHistoryEntryResult({
    exists: true,
    tabId: 2,
    windowId: 2,
    url,
    rawUrl: url
  } as any)

  assert.deepEqual(result, { status: 'failed' })
  assert.deepEqual(calls.windowsUpdate, [])
})

test('focusWorkingSetItem falls back to the effective URL for blocked suspended tabs', async () => {
  const suspendedUrl = 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const result = await focusWorkingSetItemResult({
    tabId: 2,
    windowId: 2,
    tabUrl: 'https://example.com/docs',
    rawUrl: suspendedUrl
  })

  assert.deepEqual(result, { status: 'focused' })
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'blocked',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true, url: 'https://example.com/docs' } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2).url, 'https://example.com/docs')
})

test('focusWorkingSetItemResult preserves activation when window focus fails', async () => {
  const url = 'https://example.test/docs'
  createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])
  ;(globalThis as any).chrome.windows.update = async () => {
    throw new Error('Window focus unavailable')
  }

  const result = await focusWorkingSetItemResult({
    tabId: 2,
    windowId: 2,
    tabUrl: url,
    rawUrl: url
  })

  assert.deepEqual(result, { status: 'activated' })
})

test('closeHistoryEntry removes the exact history tab and returns an undo snapshot', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 },
    { id: 2, windowId: 2, url: 'https://example.com/docs', title: 'Docs', active: false, pinned: true, groupId: 4, index: 3 }
  ])

  const result = await closeHistoryEntry({
    exists: true,
    tabId: 2,
    url: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs'
  } as any)

  assert.equal(result.status, 'closed')
  assert.equal(result.closed, true)
  assert.deepEqual(calls.remove, [2])
  assert.equal(tabs.some((tab) => tab.id === 2), false)
  assert.deepEqual(result.snapshot, [
    {
      url: 'https://example.com/docs',
      rawUrl: 'https://example.com/docs',
      title: 'Docs',
      pinned: true,
      groupId: 4,
      windowId: 2,
      index: 3
    }
  ])
})

test('closeHistoryEntry reports unknown and keeps the tab when inventory cannot be read', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 2, windowId: 2, url: 'https://example.test/docs', title: 'Docs', active: false, pinned: false, groupId: -1, index: 0 }
  ])
  ;(globalThis as any).chrome.tabs.query = async () => {
    throw new Error('Tab inventory unavailable')
  }

  const result = await closeHistoryEntry({
    exists: true,
    tabId: 2,
    url: 'https://example.test/docs',
    rawUrl: 'https://example.test/docs'
  } as any)

  assert.deepEqual(result, { status: 'unknown', closed: false, snapshot: [] })
  assert.deepEqual(calls.remove, [])
  assert.deepEqual(tabs.map((tab) => tab.id), [2])
})

test('undoLastClose restores tabs and requests animated dashboard refresh', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])
  let refreshOptions = null
  const unregister = replaceDashboardRefreshForTesting((options) => {
    refreshOptions = options
  })

  markClosure([
    {
      url: 'https://example.com/docs',
      title: 'Docs',
      pinned: true,
      groupId: -1,
      windowId: 1,
      index: 1
    }
  ])
  await undoLastClose()
  unregister()

  assert.deepEqual(calls.create, [
    {
      url: 'https://example.com/docs',
      windowId: 1,
      index: 1,
      pinned: true,
      active: false
    }
  ])
  assert.equal(tabs.some((tab) => tab.url === 'https://example.com/docs'), true)
  assert.deepEqual(refreshOptions, { animateCards: true })
})

test('delayed Undo Switch ignores a restored tab id that now belongs to another URL', async () => {
  const { calls } = createChromeMock([
    {
      id: 2,
      windowId: 3,
      url: 'https://unrelated.example.test/',
      title: 'Unrelated',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  await switchToRestoredTab({
    tabId: 2,
    snapshot: {
      url: 'https://restored.example.test/',
      title: 'Restored',
      pinned: false,
      groupId: -1,
      windowId: 3,
      index: 0
    }
  })

  assert.deepEqual(calls.tabsUpdate, [])
  assert.deepEqual(calls.windowsUpdate, [])
})

test('Undo Switch accepts matching ordinary and suspended restored targets', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.test%2Fdocs'
  const { calls } = createChromeMock([
    {
      id: 2,
      windowId: 2,
      url: 'https://restored.example.test/',
      title: 'Restored',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 3,
      windowId: 3,
      url: suspendedUrl,
      title: 'Docs',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  await switchToRestoredTab({
    tabId: 2,
    snapshot: {
      url: 'https://restored.example.test/',
      title: 'Restored',
      pinned: false,
      groupId: -1,
      windowId: 2,
      index: 0
    }
  })
  await switchToRestoredTab({
    tabId: 3,
    snapshot: {
      url: 'https://example.test/docs',
      rawUrl: suspendedUrl,
      title: 'Docs',
      pinned: false,
      groupId: -1,
      windowId: 3,
      index: 0
    }
  })

  assert.deepEqual(calls.tabsUpdate, [
    { tabId: 2, updateProperties: { active: true } },
    { tabId: 3, updateProperties: { active: true } }
  ])
  assert.deepEqual(calls.windowsUpdate, [
    { windowId: 2, updateProperties: { focused: true } },
    { windowId: 3, updateProperties: { focused: true } }
  ])
})

test('snapshotChromeTabs stores raw suspended URL for undo and effective URL for matching', () => {
  const rawUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs%3Fq%3D1'

  const snapshot = snapshotChromeTabs([
    {
      url: rawUrl,
      title: rawUrl,
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])

  assert.deepEqual(snapshot, [
    {
      url: 'https://example.com/docs?q=1',
      rawUrl,
      title: rawUrl,
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])
})

test('undoLastClose restores raw suspended URL before falling back to effective URL', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  markClosure([
    {
      url: 'https://example.com/docs',
      rawUrl: 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
      title: 'Docs',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 1
    }
  ])
  await undoLastClose()

  const [firstCreate] = calls.create
  assert.ok(firstCreate)
  assert.equal(firstCreate.url, 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs')
  assert.equal(tabs.some((tab) => tab.url === 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'), true)

  markClosure([
    {
      url: 'https://example.com/docs',
      rawUrl: 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
      title: 'Docs',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])
  await undoLastClose()

  assert.deepEqual(calls.create.slice(-2).map((call) => call.url), [
    'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
    'https://example.com/docs'
  ])
  assert.equal(tabs.some((tab) => tab.url === 'https://example.com/docs'), true)
})

test('undoLastClose restores same-window tabs in their original tab-strip order', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 },
    { id: 2, windowId: 1, url: 'https://charlie.example/', title: 'Charlie', active: false, pinned: false, groupId: -1, index: 1 },
    { id: 3, windowId: 1, url: 'https://echo.example/', title: 'Echo', active: false, pinned: false, groupId: -1, index: 2 }
  ])

  markClosure([
    {
      url: 'https://delta.example/',
      title: 'Delta',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 3
    },
    {
      url: 'https://bravo.example/',
      title: 'Bravo',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 1
    }
  ])
  await undoLastClose()

  assert.deepEqual(calls.create.map(({ url, windowId, index, active }) => ({ url, windowId, index, active })), [
    { url: 'https://bravo.example/', windowId: 1, index: 1, active: false },
    { url: 'https://delta.example/', windowId: 1, index: 3, active: false }
  ])
  assert.equal(tabs.find((tab) => tab.url === 'https://bravo.example/')?.index, 1)
  assert.equal(tabs.find((tab) => tab.url === 'https://delta.example/')?.index, 3)
})

test('undoLastClose ignores a second request while the same closure is restoring', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true, pinned: false, groupId: -1, index: 0 }
  ])
  const createTab = (globalThis as any).chrome.tabs.create.bind((globalThis as any).chrome.tabs)
  const { promise: restoreBlocked, resolve: releaseRestore } = Promise.withResolvers<void>()
  const { promise: restoreStarted, resolve: markRestoreStarted } = Promise.withResolvers<void>()
  ;(globalThis as any).chrome.tabs.create = async (createProperties: chrome.tabs.CreateProperties) => {
    markRestoreStarted()
    await restoreBlocked
    return createTab(createProperties)
  }
  markClosure([{
    url: 'https://restored.example.test/',
    title: 'Restored',
    pinned: false,
    groupId: -1,
    windowId: 1,
    index: 1
  }])

  const firstUndo = undoLastClose()
  await restoreStarted
  await undoLastClose()
  releaseRestore()
  await firstUndo

  assert.equal(calls.create.filter(({ url }) => url === 'https://restored.example.test/').length, 1)
})

test('undoLastClose retries without a stale window id when the original window is gone', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true, pinned: false, groupId: -1, index: 0 }
  ])
  const createTab = (globalThis as any).chrome.tabs.create.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.create = async (createProperties: chrome.tabs.CreateProperties) => {
    if (createProperties.windowId === 99) {
      calls.create.push({ ...createProperties })
      throw new Error('No window with id: 99')
    }
    return createTab(createProperties)
  }
  markClosure([{
    url: 'https://restored.example.test/',
    title: 'Restored',
    pinned: false,
    groupId: -1,
    windowId: 99,
    index: 0
  }])

  await undoLastClose()

  assert.deepEqual(calls.create, [
    { url: 'https://restored.example.test/', windowId: 99, index: 0, pinned: false, active: false },
    { url: 'https://restored.example.test/', index: 0, pinned: false, active: false }
  ])
  assert.equal(tabs.some((tab) => tab.url === 'https://restored.example.test/'), true)
})

test('undoLastClose retries only failed tabs after a partial restore', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true, pinned: false, groupId: -1, index: 0 }
  ])
  const createTab = (globalThis as any).chrome.tabs.create.bind((globalThis as any).chrome.tabs)
  let rejectRetryTab = true
  ;(globalThis as any).chrome.tabs.create = async (createProperties: chrome.tabs.CreateProperties) => {
    if (rejectRetryTab && createProperties.url === 'https://retry.example.test/') {
      calls.create.push({ ...createProperties })
      throw new Error('Transient create failure')
    }
    return createTab(createProperties)
  }
  markClosure([
    {
      url: 'https://restored.example.test/',
      title: 'Restored',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 1
    },
    {
      url: 'https://retry.example.test/',
      title: 'Retry',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])

  await undoLastClose()
  assert.equal(tabs.filter((tab) => tab.url === 'https://restored.example.test/').length, 1)
  assert.equal(tabs.some((tab) => tab.url === 'https://retry.example.test/'), false)

  rejectRetryTab = false
  await undoLastClose()

  assert.equal(tabs.filter((tab) => tab.url === 'https://restored.example.test/').length, 1)
  assert.equal(tabs.filter((tab) => tab.url === 'https://retry.example.test/').length, 1)
  assert.equal(calls.create.filter((call) => call.url === 'https://restored.example.test/').length, 1)
})

test('each closure Undo action restores the tabs represented by its own toast', async () => {
  const { tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true, pinned: false, groupId: -1, index: 0 }
  ])
  const undoFirst = markClosure([{
    url: 'https://first.example.test/',
    title: 'First',
    pinned: false,
    groupId: -1,
    windowId: 1,
    index: 1
  }])
  const undoSecond = markClosure([{
    url: 'https://second.example.test/',
    title: 'Second',
    pinned: false,
    groupId: -1,
    windowId: 1,
    index: 1
  }])

  await undoFirst?.()
  assert.equal(tabs.some((tab) => tab.url === 'https://first.example.test/'), true)
  assert.equal(tabs.some((tab) => tab.url === 'https://second.example.test/'), false)
  await undoSecond?.()
  assert.equal(tabs.some((tab) => tab.url === 'https://second.example.test/'), true)
})

test('openTabUrl opens an active (foreground) tab by default', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  const opened = await openTabUrl('https://example.com/new')

  assert.equal(opened, true)
  assert.deepEqual(calls.create, [{ url: 'https://example.com/new', active: true }])
})

test('openTabUrl opens a background tab when active is false', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  const opened = await openTabUrl('https://example.com/new', { active: false })

  assert.equal(opened, true)
  assert.deepEqual(calls.create, [{ url: 'https://example.com/new', active: false }])
})

test('openTabUrl creates no tab for an empty URL', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  const opened = await openTabUrl('')

  assert.equal(opened, false)
  assert.deepEqual(calls.create, [])
})

test('openTabUrlInNewWindow opens a focused normal window', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  const opened = await openTabUrlInNewWindow('https://example.com/new')

  assert.equal(opened, true)
  assert.deepEqual(calls.windowsCreate, [{ url: 'https://example.com/new', focused: true, type: 'normal' }])
  assert.deepEqual(calls.create, [])
})

test('openTabUrlInNewWindow creates no window for an empty URL', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  const opened = await openTabUrlInNewWindow('')

  assert.equal(opened, false)
  assert.deepEqual(calls.windowsCreate, [])
})
