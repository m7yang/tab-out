import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAppStartup,
  readAppStartup,
  readBuildTimeAppStartup,
  resetAppStartupShell,
  subscribeAppStartup,
  updateAppStartupClosedGhostDismissals
} from '../src/app-startup.js'
import { emptyDashboardLocalState } from '../src/extension/dashboard-local-state.js'
import { appDashboardStore } from '../src/extension/dashboard-intake.js'
import type { DashboardStartupSnapshot } from '../src/extension/startup-snapshot.js'

const emptySnapshot: DashboardStartupSnapshot = {
  closedTabs: [],
  dashboard: { domainGroups: [], realTabs: [], savedKeys: [] },
  tabHistory: {
    stackSize: 0,
    maxSize: 20,
    cursorIndex: -1,
    currentIndex: -1,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: null,
    activeWindowId: null,
    activeWasInserted: false,
    entries: []
  },
  workingSet: { defaultLimit: 5, expandedLimit: 12, items: [] }
}

test('app startup publishes one ready frame and applies it to Dashboard Intake', () => {
  let notifications = 0
  const unsubscribe = subscribeAppStartup(() => { notifications += 1 })
  const startup = {
    closedGhostDismissals: new Map<string, number>(),
    historyRange: 'off',
    localState: emptyDashboardLocalState(true),
    snapshot: emptySnapshot,
    source: 'tabs' as const
  }

  applyAppStartup(startup)
  unsubscribe()

  assert.equal(notifications, 1)
  assert.deepEqual(readAppStartup(), { phase: 'ready', ...startup })
  assert.equal(readBuildTimeAppStartup(), null)
  assert.equal(appDashboardStore.read().historyRange, 'off')
  assert.equal(appDashboardStore.read().startupStateApplied, true)
})

test('post-admission dismissal events update the ready frame without partial startup intake', () => {
  const startup = {
    closedGhostDismissals: new Map<string, number>(),
    historyRange: 'off',
    localState: emptyDashboardLocalState(true),
    snapshot: emptySnapshot,
    source: 'tabs' as const
  }
  applyAppStartup(startup)
  const dismissals = new Map([['https://example.test/closed', 42]])

  assert.equal(updateAppStartupClosedGhostDismissals(dismissals), true)
  const ready = readAppStartup()
  assert.equal(ready?.phase, 'ready')
  if (ready?.phase === 'ready') {
    assert.equal(ready.closedGhostDismissals, dismissals)
    assert.equal(ready.snapshot, emptySnapshot)
  }

  resetAppStartupShell()
  assert.equal(updateAppStartupClosedGhostDismissals(new Map()), false)
})
