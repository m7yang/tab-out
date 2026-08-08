import { Exit } from 'effect'

import './styles/app.css'
import { attachApp } from './components/App'
import {
  applyAppStartup,
  publishAppStartupFailure,
  resetAppStartupShell,
  setAppStartupFilterIntent,
  setAppStartupMaterialChangeHandler,
  updateAppStartupClosedGhostDismissals,
  type AppStartupFrame
} from './app-startup.js'
import { getAppRuntime } from './extension/app-runtime.js'
import { filterInputFromSearch } from './extension/app-url.js'
import { appDashboardStore, requestDashboardRefresh, settleDashboardRefresh, type DashboardRefreshOptions } from './extension/dashboard-intake.js'
import {
  createDashboardPageRefreshScheduler,
  dashboardTabUpdateRefreshOptions
} from './extension/dashboard-page-refresh.js'
import { DASHBOARD_LOCAL_STORAGE_KEYS } from './extension/dashboard-local-state.js'
import { groupColorChanged } from './extension/groups.js'
import { readFilterFocusPendingInput } from './extension/filter-focus-buffer.js'
import { subscribeClosedGhostDismissals } from './extension/closed-ghost-dismissals.js'
import { HISTORY_RANGE_STORAGE_KEY } from './extension/history-range-storage.js'
import { CLOSED_TAB_RETENTION_SETTLE_MESSAGE } from './extension/runtime-messages.js'
import { RETAINED_PAGES_STORAGE_KEY } from './extension/retained-pages-storage.js'
import { reportRetentionHealthEpisode } from './extension/retention-health-client.js'
import { RETENTION_HEALTH_STORAGE_KEY } from './extension/retention-health.js'
import { SAVED_PAGES_STORAGE_KEY } from './extension/saved-pages.js'
import { captureAppStartupFrameEffect } from './extension/startup-frame.js'
import { createStartupAdmissionController } from './extension/startup-frame-controller.js'
import { STARTUP_ORDER_DEBUG_CAPTURE, recordStartupTiming } from './components/startup-order-debug'

recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'app-module-evaluated')
const appRuntime = getAppRuntime()

const startupAdmissionController = createStartupAdmissionController<AppStartupFrame, unknown>({
  capture: (_request, settle) => {
    const interrupt = appRuntime.runCallback(captureAppStartupFrameEffect(), {
      onExit: (exit) => {
        if (Exit.isSuccess(exit)) {
          settle({ ok: true, value: exit.value })
          return
        }
        settle({ ok: false, error: exit.cause })
      }
    })
    return { cancel: () => interrupt() }
  }
})

const dashboardPageRefreshScheduler = createDashboardPageRefreshScheduler({
  isVisible: () => document.visibilityState === 'visible',
  refresh: (options) => {
    void settleDashboardRefresh(requestDashboardRefresh(options))
  }
})

function scheduleDashboardRefresh(options: DashboardRefreshOptions = {}) {
  if (startupAdmissionController.read().phase !== 'ready') {
    startupAdmissionController.materialChanged()
    return
  }
  dashboardPageRefreshScheduler.schedule(options)
}

function scheduleAnimatedDashboardRefresh() {
  scheduleDashboardRefresh({ animateCards: true })
}

function schedulePassiveDashboardRefresh() {
  scheduleDashboardRefresh()
}

chrome.tabs.onCreated.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onActivated.addListener(schedulePassiveDashboardRefresh)
chrome.tabs.onRemoved.addListener((tabId) => {
  // The worker acknowledges this physical lifetime only after retained state
  // is durable (or the capture is known to have failed). Refreshing earlier
  // can transiently remove a chip that should settle into its closed state.
  void chrome.runtime.sendMessage({
    type: CLOSED_TAB_RETENTION_SETTLE_MESSAGE,
    tabId
  }).catch(() => undefined).then(schedulePassiveDashboardRefresh)
})
chrome.tabs.onMoved.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onAttached.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onDetached.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onReplaced.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  const refreshOptions = dashboardTabUpdateRefreshOptions(changeInfo, tab)
  if (refreshOptions) scheduleDashboardRefresh(refreshOptions)
})

chrome.windows.onFocusChanged.addListener(schedulePassiveDashboardRefresh)

chrome.tabGroups.onCreated.addListener(schedulePassiveDashboardRefresh)
chrome.tabGroups.onUpdated.addListener((group) => {
  if (groupColorChanged(group)) scheduleDashboardRefresh()
})
chrome.tabGroups.onRemoved.addListener(schedulePassiveDashboardRefresh)
chrome.tabGroups.onMoved.addListener(schedulePassiveDashboardRefresh)

chrome.bookmarks.onCreated.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onRemoved.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onChanged.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onMoved.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onChildrenReordered.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onImportEnded.addListener(schedulePassiveDashboardRefresh)

chrome.history.onVisited.addListener(schedulePassiveDashboardRefresh)
chrome.history.onVisitRemoved.addListener(schedulePassiveDashboardRefresh)

chrome.sessions?.onChanged?.addListener(() => {
  if (startupAdmissionController.read().phase !== 'ready') {
    startupAdmissionController.materialChanged()
  }
})

const startupLocalStorageKeys = new Set<string>([
  ...DASHBOARD_LOCAL_STORAGE_KEYS,
  HISTORY_RANGE_STORAGE_KEY,
  RETAINED_PAGES_STORAGE_KEY,
  SAVED_PAGES_STORAGE_KEY
])

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'session' &&
    Object.hasOwn(changes, RETENTION_HEALTH_STORAGE_KEY)
  ) {
    if (changes[RETENTION_HEALTH_STORAGE_KEY]?.newValue === undefined) {
      reportRetentionHealthEpisode(null)
    }
    schedulePassiveDashboardRefresh()
    return
  }
  if (areaName !== 'local') return
  if (
    startupAdmissionController.read().phase !== 'ready' &&
    Object.keys(changes).some((key) => startupLocalStorageKeys.has(key))
  ) {
    startupAdmissionController.materialChanged()
    return
  }
  if (
    Object.hasOwn(changes, SAVED_PAGES_STORAGE_KEY) ||
    Object.hasOwn(changes, RETAINED_PAGES_STORAGE_KEY)
  ) {
    // Background retention expiry/capacity/reconciliation is authoritative
    // state convergence, not a direct user removal gesture.
    schedulePassiveDashboardRefresh()
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && startupAdmissionController.read().phase !== 'ready') {
    startupAdmissionController.visibilityReturned()
    return
  }
  dashboardPageRefreshScheduler.visibilityChanged()
})

recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'attach-app')
setAppStartupFilterIntent(
  readFilterFocusPendingInput(filterInputFromSearch(window.location.search))
)
attachApp()

setAppStartupMaterialChangeHandler((delayMs) => startupAdmissionController.materialChanged(delayMs))
let stopClosedTabUpdates: (() => void) | null = null
const stopClosedGhostDismissalSync = subscribeClosedGhostDismissals((dismissals) => {
  if (startupAdmissionController.read().phase === 'ready') {
    updateAppStartupClosedGhostDismissals(dismissals)
    return
  }
  startupAdmissionController.materialChanged()
})
startupAdmissionController.subscribe(() => {
  const state = startupAdmissionController.read()
  if (state.phase === 'capturing') {
    resetAppStartupShell()
    return
  }
  if (state.phase === 'failed') {
    publishAppStartupFailure(() => startupAdmissionController.retry())
    return
  }
  if (state.phase === 'ready') {
    // Install steady-state session updates in the same task that admits the
    // frame. Pre-ready events invalidate capture; no independently fetched
    // closed-tab result can overtake the admitted generation.
    stopClosedTabUpdates ??= appDashboardStore.startClosedTabUpdates()
    recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'startup-frame-ready', {
      detail: {
        closedTabs: state.value.snapshot.closedTabs.length,
        domainGroups: state.value.snapshot.dashboard.domainGroups.length,
        realTabs: state.value.snapshot.dashboard.realTabs.length,
        source: state.value.source,
        workingSet: state.value.snapshot.workingSet.items.length
      }
    })
    applyAppStartup(state.value)
  }
})
recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'initialize-start')
startupAdmissionController.start()

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return
  setAppStartupMaterialChangeHandler(null)
  stopClosedTabUpdates?.()
  stopClosedGhostDismissalSync()
  startupAdmissionController.dispose()
  void appRuntime.dispose()
})
