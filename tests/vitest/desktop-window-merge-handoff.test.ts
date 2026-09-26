import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { TAB_OUT_FAVICON_URL } from '../../src/extension/tab-out-url.js'

import type { ChromeApi } from '../../src/extension/background/chrome-api.js'
import {
  ensureDashboardTabInWindowEffect,
  handoffDesktopWindowMergeToWindowEffect,
} from '../../src/extension/background/desktop-window-merge-handoff.js'

const DASHBOARD_URL = 'chrome-extension://tab-out/index.html'
const START_CONFIRM_MESSAGE = { type: 'tab-out:start-desktop-window-merge-confirm', previewId: 'preview-test' }

type HandoffApiCalls = {
  tabCreate: chrome.tabs.CreateProperties[]
  tabReload: number[]
  tabUpdate: Array<{ tabId: number, updateProperties: chrome.tabs.UpdateProperties }>
  sentMessages: Array<{ tabId: number, message: unknown }>
}

function createHandoffApi(options: {
  tabs?: chrome.tabs.Tab[]
  createdTabId?: number
  failWindowedCreate?: boolean
  acknowledgeFromAttempt?: number
}) {
  const {
    tabs = [],
    createdTabId = 90,
    failWindowedCreate = false,
    acknowledgeFromAttempt = 1,
  } = options
  const calls: HandoffApiCalls = {
    tabCreate: [],
    tabReload: [],
    tabUpdate: [],
    sentMessages: [],
  }
  const chromeApi = {
    runtime: { id: 'tab-out' },
    tabs: {
      query: async () => tabs,
      update: async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
        calls.tabUpdate.push({ tabId, updateProperties })
        return tabs.find((candidate) => candidate.id === tabId) ?? tab({ id: tabId })
      },
      create: async (createProperties: chrome.tabs.CreateProperties) => {
        if (failWindowedCreate && createProperties.windowId !== undefined) {
          throw new Error('window closed before tab creation')
        }
        calls.tabCreate.push(createProperties)
        return tab({
          active: createProperties.active ?? true,
          id: createdTabId,
          pinned: createProperties.pinned ?? false,
          url: String(createProperties.url ?? 'chrome://newtab/'),
          windowId: createProperties.windowId ?? 2,
        })
      },
      reload: async (tabId: number) => {
        calls.tabReload.push(tabId)
        const existing = tabs.find((candidate) => candidate.id === tabId)
        if (!existing) throw new Error('Tab missing')
        existing.discarded = false
        existing.frozen = false
        existing.status = 'loading'
      },
      sendMessage: async (tabId: number, message: unknown) => {
        calls.sentMessages.push({ tabId, message })
        if (calls.sentMessages.length < acknowledgeFromAttempt) {
          throw new Error('Receiving end does not exist')
        }
        return { ok: true }
      },
    },
  } as unknown as ChromeApi

  return { calls, chromeApi }
}

function tab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: false,
    id: 1,
    incognito: false,
    index: 0,
    lastAccessed: 0,
    pinned: false,
    selected: false,
    url: 'https://example.test/',
    windowId: 7,
    ...overrides,
  }
}

function dashboardTab(overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return tab({ url: DASHBOARD_URL, ...overrides })
}

it.effect('handoff delivers the start-confirm intent without focusing or mutating any tab', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 11, pinned: true }),
      dashboardTab({ id: 12, active: true }),
      tab({ id: 13 }),
    ],
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  // Activating a tab flips `active` flags inside the frozen snapshot and
  // would force a spurious re-confirmation, so the handoff must not update
  // or create anything when a dashboard page already exists.
  assert.deepEqual(calls.tabUpdate, [])
  assert.deepEqual(calls.tabCreate, [])
  assert.deepEqual(calls.sentMessages, [{ tabId: 12, message: START_CONFIRM_MESSAGE }])
}))

it.effect('handoff prefers a pinned dashboard tab when none is active', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 21 }),
      dashboardTab({ id: 22, pinned: true, url: 'chrome://newtab/', favIconUrl: TAB_OUT_FAVICON_URL }),
    ],
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabUpdate, [])
  assert.deepEqual(calls.sentMessages, [{ tabId: 22, message: START_CONFIRM_MESSAGE }])
}))

it.effect('native new tabs never replace the dashboard message host', () => Effect.gen(function* () {
  for (const url of ['chrome://newtab/', 'chrome://new-tab-page/']) {
    for (const hasDashboard of [false, true]) {
      const { calls, chromeApi } = createHandoffApi({
        tabs: [
          tab({ id: 81, url, active: true, pinned: true }),
          ...(hasDashboard ? [dashboardTab({ id: 82 })] : []),
        ],
        createdTabId: 83,
      })
      const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

      assert.equal(delivered, true)
      assert.deepEqual(calls.sentMessages, [{ tabId: hasDashboard ? 82 : 83, message: START_CONFIRM_MESSAGE }])
      assert.deepEqual(calls.tabCreate, hasDashboard ? [] : [{ windowId: 7, url: DASHBOARD_URL, active: false }])
      assert.deepEqual(calls.tabUpdate, [])
      assert.deepEqual(calls.tabReload, [])
    }
  }
}))

it.effect('handoff skips a frozen pinned dashboard for a runnable page', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 23 }),
      dashboardTab({ id: 24, frozen: true, pinned: true }),
    ],
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabReload, [])
  assert.deepEqual(calls.tabCreate, [])
  assert.deepEqual(calls.tabUpdate, [])
  assert.deepEqual(calls.sentMessages, [{ tabId: 23, message: START_CONFIRM_MESSAGE }])
}))

it.effect('handoff creates a runnable page when every dashboard is frozen', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 25, frozen: true, pinned: true }),
      tab({ id: 26, active: true }),
    ],
    createdTabId: 27,
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabReload, [])
  assert.deepEqual(calls.tabCreate, [{ windowId: 7, url: DASHBOARD_URL, active: false }])
  assert.deepEqual(calls.tabUpdate, [])
  assert.deepEqual(calls.sentMessages, [{ tabId: 27, message: START_CONFIRM_MESSAGE }])
}))

it.effect('ensure returns an existing dashboard tab without creating or focusing anything', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 61 }),
      tab({ id: 62, active: true }),
    ],
  })

  const ensuredTabId = yield* ensureDashboardTabInWindowEffect(chromeApi, 7)

  assert.equal(ensuredTabId, 61)
  assert.deepEqual(calls.tabCreate, [])
  assert.deepEqual(calls.tabUpdate, [])
}))

it.effect('ensure reloads a discarded dashboard without activating it before preview', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 63, discarded: true, status: 'unloaded' }),
      tab({ id: 64, active: true }),
    ],
  })

  const ensuredTabId = yield* ensureDashboardTabInWindowEffect(chromeApi, 7)

  assert.equal(ensuredTabId, 63)
  assert.deepEqual(calls.tabReload, [63])
  assert.deepEqual(calls.tabCreate, [])
  assert.deepEqual(calls.tabUpdate, [])
}))

it.effect('ensure creates an inactive dashboard tab before a menu preview freezes the snapshot', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      tab({ id: 71, active: true }),
    ],
    createdTabId: 72,
  })

  const ensuredTabId = yield* ensureDashboardTabInWindowEffect(chromeApi, 7)

  assert.equal(ensuredTabId, 72)
  assert.deepEqual(calls.tabCreate, [{ windowId: 7, url: DASHBOARD_URL, active: false }])
  assert.deepEqual(calls.tabUpdate, [])
}))

it.effect('handoff creates a dashboard tab and retries delivery until the page listener hydrates', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      tab({ id: 31, active: true }),
    ],
    createdTabId: 32,
    acknowledgeFromAttempt: 3,
  })

  const fiber = yield* Effect.forkChild(
    handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test', { retryDelayMillis: 250 }),
  )
  yield* TestClock.adjust(500)
  const delivered = yield* Fiber.join(fiber)

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabCreate, [{ windowId: 7, url: DASHBOARD_URL, active: false }])
  assert.deepEqual(calls.tabUpdate, [])
  assert.equal(calls.sentMessages.length, 3)
  assert.ok(calls.sentMessages.every((sent) => sent.tabId === 32))
}))

it.effect('handoff falls back to a windowless create when the invoking window is gone', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    failWindowedCreate: true,
    createdTabId: 41,
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabCreate, [{ url: DASHBOARD_URL, active: false }])
  assert.deepEqual(calls.sentMessages, [{ tabId: 41, message: START_CONFIRM_MESSAGE }])
}))

it.effect('handoff reports failure after the bounded delivery window closes', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    createdTabId: 51,
    acknowledgeFromAttempt: Number.POSITIVE_INFINITY,
  })

  const fiber = yield* Effect.forkChild(handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test', {
    deliveryAttempts: 3,
    retryDelayMillis: 250,
  }))
  yield* TestClock.adjust(1_000)
  const delivered = yield* Fiber.join(fiber)

  assert.equal(delivered, false)
  assert.equal(calls.sentMessages.length, 3)
}))
