import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { setAppStartupFilterIntent } from '../src/app-startup.js'
import { getAppRuntime } from '../src/extension/app-runtime.js'
import { CLOSED_GHOST_DISMISSAL_STORAGE_KEY } from '../src/extension/closed-ghost-dismissals.js'
import { appDashboardStore } from '../src/extension/dashboard-intake.js'
import { encodeDashboardRetainedPagesWire } from '../src/extension/dashboard-retained-pages-wire.js'
import { captureAppStartupFrameEffect } from '../src/extension/startup-frame.js'

function installChrome(options: {
  failDismissalRead?: boolean
  bookmarks?: chrome.bookmarks.BookmarkTreeNode[]
  localReadBarrier?: Promise<void>
  onServiceStateRequest?: () => void
} = {}) {
  let historySearchCount = 0
  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => {
        options.onServiceStateRequest?.()
        return {
          ok: true,
          openTabsSnapshot: {
            tabs: [],
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
          workingSetActivity: { version: 1, records: {} },
          retainedPages: await encodeDashboardRetainedPagesWire([]),
          retentionHealth: null
        }
      }
    },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    bookmarks: { getTree: async () => options.bookmarks ?? [] },
    history: {
      search: async () => {
        historySearchCount += 1
        throw new Error('History unavailable')
      }
    },
    storage: {
      session: { get: async () => ({}) },
      local: {
        get: async (keys: unknown) => {
          await options.localReadBarrier
          if (options.failDismissalRead && keys === CLOSED_GHOST_DISMISSAL_STORAGE_KEY) {
            throw new Error('Dismissals unavailable')
          }
          return {}
        },
        set: async () => {}
      }
    }
  }
  return { historySearchCount: () => historySearchCount }
}

test('startup frame admits confirmed-empty live authorities as one complete value', async () => {
  installChrome()
  appDashboardStore.selectStartupSource('tabs')
  setAppStartupFilterIntent('')

  const frame = await getAppRuntime().runPromise(captureAppStartupFrameEffect())

  assert.equal(frame.source, 'tabs')
  assert.deepEqual(frame.snapshot.dashboard.realTabs, [])
  assert.deepEqual(frame.snapshot.closedTabs, [])
  assert.deepEqual(frame.snapshot.tabHistory.entries, [])
  assert.deepEqual(frame.snapshot.workingSet.items, [])
  assert.equal(frame.closedGhostDismissals.size, 0)
  assert.equal(frame.localState.loaded, true)
})

test('startup frame rejects an unknown semantic authority instead of admitting empty state', async () => {
  installChrome({ failDismissalRead: true })
  appDashboardStore.selectStartupSource('tabs')
  setAppStartupFilterIntent('')

  await assert.rejects(
    getAppRuntime().runPromise(captureAppStartupFrameEffect()),
    (error: any) => error?._tag === 'StartupFrameAuthorityError' &&
      error.authority === 'closed-row dismissals'
  )
})

test('startup frame begins its service-state request while local authorities are loading', async () => {
  const localReads = Promise.withResolvers<void>()
  const serviceRequest = Promise.withResolvers<void>()
  installChrome({
    localReadBarrier: localReads.promise,
    onServiceStateRequest: () => serviceRequest.resolve()
  })
  appDashboardStore.selectStartupSource('tabs')
  setAppStartupFilterIntent('')

  const frame = getAppRuntime().runPromise(captureAppStartupFrameEffect())
  const requestStartedBeforeRelease = await Promise.race([
    serviceRequest.promise.then(() => true),
    delay(50, false)
  ])
  localReads.resolve()
  await frame

  assert.equal(requestStartedBeforeRelease, true)
})

test('Bookmarks startup follows the latest source without requiring hidden Tabs companions', async () => {
  const chromeState = installChrome({
    bookmarks: [{
      id: 'root',
      title: '',
      syncing: false,
      children: [{
        id: 'bookmark-1',
        title: 'Example Needle',
        syncing: false,
        url: 'https://example.test/needle'
      }]
    }]
  })
  appDashboardStore.selectStartupSource('bookmarks')
  setAppStartupFilterIntent('needle')

  const frame = await getAppRuntime().runPromise(captureAppStartupFrameEffect())

  assert.equal(frame.source, 'bookmarks')
  assert.deepEqual(frame.snapshot.dashboard.realTabs.map((tab) => tab.url), [
    'https://example.test/needle'
  ])
  assert.equal(chromeState.historySearchCount(), 0)

  appDashboardStore.selectStartupSource('tabs')
  setAppStartupFilterIntent('')
})
