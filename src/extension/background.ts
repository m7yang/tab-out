/**
 * background.ts — Service worker for toolbar dedupe, commands, and tab history
 *
 * Chrome's event-driven background service worker for Tab Out.
 * It keeps the toolbar dedupe action current, handles extension commands, and
 * maintains the activation history used by tab switching / close restore.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts duplicate tabs that the global dedupe policy can close.
 *
 * Color coding gives a quick at-a-glance cleanup signal:
 *   Green  (#3d7a4a) → 1–10 duplicate extras
 *   Amber  (#b8892e) → 11–20 duplicate extras
 *   Red    (#b35a5a) → 21+ duplicate extras
 */

import { Effect, Exit } from 'effect'

import { refreshBadge as refreshBadgeEffect } from './background/badge.js'
import { createAdjacentCloseBatcher } from './background/adjacent-close-batcher.js'
import { createAdjacentOpenSurfaceBatcher } from './background/adjacent-open-surface-batcher.js'
import { OPEN_FILTER_TAB_COMMAND, openFilterTabEffect } from './background/filter-command.js'
import {
  createInitialOpenSurfaceReconciliationCoordinator,
  initialOpenSurfaceReconciliationEffect
} from './background/initial-open-surface-reconciliation.js'
import { OPEN_NEW_TAB_COMMAND, openNewTabEffect } from './background/new-tab-command.js'
import { buildOpenTabDedupePlan } from './open-tab-dedupe-plan.js'
import { closeDuplicateTabsEffect } from './tabs.js'
import { groupColorChanged } from './groups.js'
import { BrowserTabs } from './browser-tabs-service.js'
import {
  captureCurrentOpenSurfaceObservations,
  captureOpenSurfaceCheckpoint,
  captureOpenSurfaceObservation
} from './background/open-surface-capture.js'
import { recoverRetainedPageSnapshot } from './background/retained-page-recovery.js'
import {
  RetainedPages,
  type CaptureClosedSurfacesResult
} from './background/retained-pages-service.js'
import {
  RETAINED_PAGES_EXPIRY_ALARM,
  scheduleRetainedPagesExpiryAlarm
} from './background/retained-pages-expiry-alarm.js'
import * as TabHistory from './background/tab-history-service.js'
import * as WorkingSet from './background/working-set-service.js'
import {
  captureDashboardServiceStateEffect,
  createBackgroundRuntime
} from './background/runtime.js'
import {
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM,
  StartupSnapshot,
  startupSnapshotStorageChangesRequireRefresh
} from './background/startup-snapshot-service.js'
import {
  isClosedTabRestoreMessage,
  isDashboardServiceStateGetMessage,
  isTabHistoryGetMessage,
  parseClosedTabRestoreStateMessage,
  parseClosedTabRetentionSettleMessage,
  parseRetainedPageActivateMessage,
  parseRetainedPageRemoveMessage,
  parseSavedPageActivateMessage,
  parseTabHistorySwitchDirection
} from './runtime-messages.js'

const chromeApi = chrome
const backgroundRuntime = createBackgroundRuntime(chromeApi)
const workingSetService = backgroundRuntime.runSync(WorkingSet.WorkingSet)
const tabHistoryService = backgroundRuntime.runSync(TabHistory.TabHistory)
const startupSnapshotService = backgroundRuntime.runSync(StartupSnapshot)
const retainedPagesService = backgroundRuntime.runSync(RetainedPages)

function settleBackgroundEffect<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<void, never, Requirements> {
  return effect.pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void)
  )
}

function synchronizeRetainedPagesExpiryAlarm(): Effect.Effect<void, never> {
  return retainedPagesService.getLedger().pipe(
    Effect.flatMap((ledger) => scheduleRetainedPagesExpiryAlarm(chromeApi.alarms, ledger)),
    Effect.catchCause(() => Effect.void)
  )
}

function settleRetainedCloseBatchEffect<Failure, Requirements>(
  effect: Effect.Effect<CaptureClosedSurfacesResult, Failure, Requirements>
): Effect.Effect<void, never, Requirements> {
  return Effect.exit(effect).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) {
        const committed = exit.value.ledger
        if (committed) {
          return scheduleRetainedPagesExpiryAlarm(
            chromeApi.alarms,
            committed
          ).pipe(Effect.catchCause(() => Effect.void))
        }
      }
      // A failed commit or all-missing batch has no authoritative new ledger;
      // retry alarm transport from the currently persisted owner state.
      return synchronizeRetainedPagesExpiryAlarm()
    }),
    Effect.catchCause(() => Effect.void)
  )
}

const initialOpenSurfaceReconciliation =
  createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: (mode) => backgroundRuntime.runPromise(
      retainedPagesService.reconcileOpenSurfaces(
        mode,
        captureCurrentOpenSurfaceObservations(chromeApi)
      ).pipe(
        Effect.asVoid,
        Effect.ensuring(synchronizeRetainedPagesExpiryAlarm())
      )
    )
  })

function afterInitialOpenSurfaceReconciliation<Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<Success, Failure, Requirements> {
  return initialOpenSurfaceReconciliationEffect(initialOpenSurfaceReconciliation).pipe(
    Effect.andThen(effect)
  )
}

const openSurfaceCheckpointBatcher = createAdjacentOpenSurfaceBatcher((captures) =>
  backgroundRuntime.runPromise(settleBackgroundEffect(
    afterInitialOpenSurfaceReconciliation(
      retainedPagesService.checkpointOpenSurfaces(captures)
    )
  )))

const retainedCloseBatcher = createAdjacentCloseBatcher((tabIds) =>
  backgroundRuntime.runPromise(settleRetainedCloseBatchEffect(
    Effect.all(
      tabIds.map((tabId) => Effect.tryPromise({
        try: () => openSurfaceCheckpointBatcher.whenSettled(tabId),
        catch: (cause) => cause
      })),
      { concurrency: 'unbounded', discard: true }
    ).pipe(Effect.andThen(afterInitialOpenSurfaceReconciliation(
      retainedPagesService.captureClosedSurfaces(tabIds)
    )))
  ))
)

function sendEffectResponse<Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
  sendResponse: (response?: unknown) => void,
  onSuccess: (value: Value) => unknown,
  onFailure: () => unknown
): Effect.Effect<void, never, Requirements> {
  return Effect.map(Effect.exit(effect), (exit) => {
    sendResponse(Exit.isSuccess(exit) ? onSuccess(exit.value) : onFailure())
  })
}

function refreshBadge() {
  void backgroundRuntime.runPromise(settleBackgroundEffect(refreshBadgeEffect))
}

function scheduleStartupSnapshotRefresh() {
  backgroundRuntime.runSync(startupSnapshotService.scheduleRefresh())
}

async function captureTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chromeApi.tabs.get(tabId)
  } catch {
    return null
  }
}

async function captureActiveTab(windowId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return (await chromeApi.tabs.query({ windowId, active: true }))[0] ?? null
  } catch {
    return null
  }
}

async function captureOpenSurfaceByTabId(tabId: number) {
  const tab = await captureTab(tabId)
  return tab ? captureOpenSurfaceObservation(chromeApi, tab) : null
}

async function captureOpenSurfaceCheckpointByTabId(tabId: number) {
  const tab = await captureTab(tabId)
  return tab
    ? captureOpenSurfaceCheckpoint(chromeApi, tab)
    : { status: 'unavailable' as const }
}

const handleActionClick = Effect.fn('Background.handleActionClick')(function*(
  tab: chrome.tabs.Tab
) {
  const browserTabs = yield* BrowserTabs
  const tabsResult = yield* browserTabs.queryAllTabsResult()
  if (!tabsResult.ok) {
    yield* refreshBadgeEffect
    return
  }

  const plan = buildOpenTabDedupePlan(tabsResult.value, tab.windowId)
  if (plan.urls.length > 0) {
    yield* closeDuplicateTabsEffect(plan.urls, true, {
      currentWindowId: tab.windowId,
      preservePinnedTabOut: true
    })
  }
  yield* refreshBadgeEffect
})

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chromeApi.runtime.onInstalled.addListener((details) => {
  refreshBadge()
  const reconciliationMode = details.reason === 'install'
    ? 'first-install'
    : details.reason === 'chrome_update'
      ? 'browser-startup'
      : 'extension-reload'
  const reconciliation = initialOpenSurfaceReconciliationEffect(
    initialOpenSurfaceReconciliation,
    reconciliationMode
  )
  void backgroundRuntime.runPromise(
    settleBackgroundEffect(
      reconciliation.pipe(Effect.andThen(startupSnapshotService.refreshNow()))
    )
  )
})

// Update badge when Chrome starts up
chromeApi.runtime.onStartup.addListener(() => {
  refreshBadge()
  const reconciliation = initialOpenSurfaceReconciliationEffect(
    initialOpenSurfaceReconciliation,
    'browser-startup'
  )
  return backgroundRuntime.runPromise(settleBackgroundEffect(Effect.gen(function*() {
    yield* reconciliation
    yield* tabHistoryService.resetForBrowserStartup()
    yield* startupSnapshotService.refreshNow()
  })))
})

// Track eligible background link tabs as pending history targets and update
// the dashboard whenever any tab is opened.
chromeApi.tabs.onCreated.addListener((tab) => {
  refreshBadge()
  if (typeof tab.id === 'number') {
    openSurfaceCheckpointBatcher.enqueue(
      tab.id,
      captureOpenSurfaceCheckpoint(chromeApi, tab)
    )
  }
  void backgroundRuntime.runPromise(
    settleBackgroundEffect(Effect.all([
      tabHistoryService.recordTabCreation(tab),
      startupSnapshotService.invalidateTitleRetention(tab.id)
    ], { concurrency: 'unbounded' }))
  )
  scheduleStartupSnapshotRefresh()
})

// Track tab activation history so commands and close-redirect can
// follow the user's actual navigation path.
chromeApi.tabs.onActivated.addListener(({ tabId, windowId }) => {
  refreshBadge()
  const capturedTab = captureTab(tabId)
  void backgroundRuntime.runPromise(settleBackgroundEffect(Effect.all([
    tabHistoryService.recordTabActivation(windowId, tabId, capturedTab),
    workingSetService.recordTabActivation(windowId, tabId, capturedTab)
  ], { concurrency: 'unbounded' })))
  scheduleStartupSnapshotRefresh()
})

chromeApi.windows.onFocusChanged.addListener((windowId) => {
  refreshBadge()
  if (windowId != null && windowId !== chromeApi.windows.WINDOW_ID_NONE) {
    const capturedActiveTab = captureActiveTab(windowId)
    void backgroundRuntime.runPromise(settleBackgroundEffect(Effect.all([
      tabHistoryService.recordFocusedWindowActiveTab(windowId, capturedActiveTab),
      workingSetService.recordFocusedWindowActiveTab(windowId, capturedActiveTab)
    ], { concurrency: 'unbounded' })))
    scheduleStartupSnapshotRefresh()
  }
})

chromeApi.tabs.onMoved.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabs.onAttached.addListener((tabId) => {
  openSurfaceCheckpointBatcher.enqueue(tabId, captureOpenSurfaceCheckpointByTabId(tabId))
  scheduleStartupSnapshotRefresh()
})
chromeApi.tabs.onDetached.addListener(scheduleStartupSnapshotRefresh)

chromeApi.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  refreshBadge()
  openSurfaceCheckpointBatcher.invalidate(removedTabId)
  void backgroundRuntime.runPromise(settleBackgroundEffect(
    afterInitialOpenSurfaceReconciliation(
      retainedPagesService.replaceOpenSurface(
        removedTabId,
        captureOpenSurfaceByTabId(addedTabId)
      )
    )
  ))
  return backgroundRuntime.runPromise(settleBackgroundEffect(
    Effect.all([
      tabHistoryService.replaceTabId(addedTabId, removedTabId),
      workingSetService.replaceTabId(addedTabId, removedTabId),
      startupSnapshotService.invalidateTitleRetention(addedTabId),
      startupSnapshotService.invalidateTitleRetention(removedTabId)
    ], { concurrency: 'unbounded' }).pipe(
      Effect.andThen(startupSnapshotService.scheduleRefresh())
    )
  ))
})

// Update badge whenever a tab is closed
chromeApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
  refreshBadge()
  retainedCloseBatcher.enqueue(tabId)
  void backgroundRuntime.runPromise(settleBackgroundEffect(
    Effect.all([
      tabHistoryService.restorePreviousTabAfterClose(tabId, removeInfo),
      startupSnapshotService.invalidateTitleRetention(tabId)
    ], { concurrency: 'unbounded' })
  ))
  scheduleStartupSnapshotRefresh()
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.url !== undefined ||
    changeInfo.groupId !== undefined ||
    changeInfo.pinned !== undefined
  ) refreshBadge()
  openSurfaceCheckpointBatcher.enqueue(
    tabId,
    captureOpenSurfaceCheckpoint(chromeApi, tab)
  )
  void backgroundRuntime.runPromise(settleBackgroundEffect(Effect.all([
    tabHistoryService.recordTabNavigation(tabId, changeInfo, tab),
    workingSetService.recordTabNavigation(tabId, changeInfo, tab)
  ], { concurrency: 'unbounded' })))
  if (
    changeInfo.title !== undefined ||
    changeInfo.url !== undefined ||
    changeInfo.favIconUrl !== undefined ||
    changeInfo.groupId !== undefined ||
    changeInfo.pinned !== undefined ||
    changeInfo.discarded !== undefined ||
    changeInfo.audible !== undefined ||
    changeInfo.mutedInfo !== undefined ||
    changeInfo.status !== undefined
  )
    scheduleStartupSnapshotRefresh()
})

chromeApi.tabGroups.onCreated.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabGroups.onUpdated.addListener((group) => {
  if (groupColorChanged(group)) scheduleStartupSnapshotRefresh()
})
chromeApi.tabGroups.onRemoved.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabGroups.onMoved.addListener(scheduleStartupSnapshotRefresh)

chromeApi.sessions.onChanged.addListener(() => {
  backgroundRuntime.runSync(startupSnapshotService.sessionsChanged())
})

chromeApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETAINED_PAGES_EXPIRY_ALARM) {
    void backgroundRuntime.runPromise(settleBackgroundEffect(
      afterInitialOpenSurfaceReconciliation(Effect.gen(function*() {
        const ledger = yield* retainedPagesService.getLedger()
        yield* scheduleRetainedPagesExpiryAlarm(chromeApi.alarms, ledger).pipe(
          Effect.catchCause(() => Effect.void)
        )
        yield* startupSnapshotService.refreshNow()
      }))
    ))
    return
  }
  if (alarm.name === STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM) {
    void backgroundRuntime.runPromise(
      settleBackgroundEffect(startupSnapshotService.promoteDurableCheckpoint())
    )
  }
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (startupSnapshotStorageChangesRequireRefresh(changes, areaName)) {
    void backgroundRuntime.runPromise(
      settleBackgroundEffect(afterInitialOpenSurfaceReconciliation(
        startupSnapshotService.refreshNow()
      ))
    )
  }
})

chromeApi.commands.onCommand.addListener((command) => {
  if (command === 'switch-to-last-tab') {
    return backgroundRuntime.runPromise(
      settleBackgroundEffect(tabHistoryService.switchTabHistory(-1))
    )
  } else if (command === 'switch-to-next-tab') {
    return backgroundRuntime.runPromise(
      settleBackgroundEffect(tabHistoryService.switchTabHistory(1))
    )
  } else if (command === OPEN_FILTER_TAB_COMMAND) {
    return backgroundRuntime.runPromise(
      settleBackgroundEffect(openFilterTabEffect(chromeApi))
    )
  } else if (command === OPEN_NEW_TAB_COMMAND) {
    return backgroundRuntime.runPromise(
      settleBackgroundEffect(openNewTabEffect(chromeApi))
    )
  }
  return undefined
})

chromeApi.action.onClicked.addListener((tab) => {
  return backgroundRuntime.runPromise(
    settleBackgroundEffect(handleActionClick(tab))
  )
})

chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isClosedTabRestoreMessage(message)) {
    const restoreState = parseClosedTabRestoreStateMessage(message)
    if (!restoreState) {
      sendResponse({ ok: false })
      return true
    }
    if (restoreState.phase === 'started') {
      backgroundRuntime.runSync(
        startupSnapshotService.sessionRestoreStarted(restoreState.restoreId)
      )
    } else {
      backgroundRuntime.runSync(
        startupSnapshotService.sessionRestoreSettled(restoreState.restoreId)
      )
    }
    sendResponse({ ok: true })
    return true
  }

  const closedTabRetentionSettlement = parseClosedTabRetentionSettleMessage(message)
  if (closedTabRetentionSettlement) {
    void retainedCloseBatcher.whenSettled(closedTabRetentionSettlement.tabId).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    )
    return true
  }

  const retainedPageActivation = parseRetainedPageActivateMessage(message)
  if (retainedPageActivation) {
    void backgroundRuntime.runPromise(settleBackgroundEffect(sendEffectResponse(
      afterInitialOpenSurfaceReconciliation(
        retainedPagesService.activateSnapshot(
          retainedPageActivation.identityDigest,
          retainedPageActivation.closureToken,
          retainedPageActivation.disposition,
          typeof sender.tab?.windowId === 'number'
            ? sender.tab.windowId
            : undefined
        ).pipe(Effect.ensuring(synchronizeRetainedPagesExpiryAlarm()))
      ),
      sendResponse,
      ({ outcome }) => ({ ok: true, outcome }),
      () => ({ ok: false })
    )))
    return true
  }

  const retainedPageRemoval = parseRetainedPageRemoveMessage(message)
  if (retainedPageRemoval) {
    void backgroundRuntime.runPromise(settleBackgroundEffect(sendEffectResponse(
      afterInitialOpenSurfaceReconciliation(
        retainedPagesService.removeSnapshot(
          retainedPageRemoval.identityDigest,
          retainedPageRemoval.closureToken
        ).pipe(Effect.ensuring(synchronizeRetainedPagesExpiryAlarm()))
      ),
      sendResponse,
      ({ outcome }) => ({ ok: true, outcome }),
      () => ({ ok: false })
    )))
    return true
  }

  const savedPageActivation = parseSavedPageActivateMessage(message)
  if (savedPageActivation) {
    const recovery = Effect.tryPromise({
      try: () => recoverRetainedPageSnapshot(
        chromeApi,
        savedPageActivation,
        savedPageActivation.disposition,
        typeof sender.tab?.windowId === 'number'
          ? { currentWindowId: sender.tab.windowId }
          : {}
      ),
      catch: (cause) => cause
    })
    void backgroundRuntime.runPromise(settleBackgroundEffect(sendEffectResponse(
      recovery,
      sendResponse,
      (activated) => ({
        ok: true,
        outcome: activated ? 'activated' : 'failed'
      }),
      () => ({ ok: false })
    )))
    return true
  }

  if (isTabHistoryGetMessage(message)) {
    void backgroundRuntime.runPromise(settleBackgroundEffect(sendEffectResponse(
      tabHistoryService.getTabHistorySnapshot(),
      sendResponse,
      (snapshot) => ({ ok: true, snapshot }),
      () => ({ ok: false, snapshot: null })
    )))
    return true
  }

  const historyDirection = parseTabHistorySwitchDirection(message)
  if (historyDirection !== null) {
    const switchAndCapture = Effect.gen(function*() {
      yield* tabHistoryService.switchTabHistory(historyDirection)
      return yield* tabHistoryService.getTabHistorySnapshot()
    })
    void backgroundRuntime.runPromise(settleBackgroundEffect(sendEffectResponse(
      switchAndCapture,
      sendResponse,
      (snapshot) => ({ ok: true, snapshot }),
      () => ({ ok: false, snapshot: null })
    )))
    return true
  }

  if (isDashboardServiceStateGetMessage(message)) {
    void backgroundRuntime.runPromise(settleBackgroundEffect(sendEffectResponse(
      afterInitialOpenSurfaceReconciliation(captureDashboardServiceStateEffect),
      sendResponse,
      ({
        tabHistory,
        workingSetActivity,
        openTabsSnapshot,
        retainedPagesWire,
        retentionHealth
      }) => ({
        ok: true,
        tabHistory,
        workingSetActivity,
        openTabsSnapshot,
        retainedPages: retainedPagesWire,
        retentionHealth
      }),
      () => ({
        ok: false,
        tabHistory: null,
        workingSetActivity: null,
        openTabsSnapshot: null,
        retainedPages: null,
        retentionHealth: null
      })
    )))
    return true
  }

  return false
})

// ─── Initial run ─────────────────────────────────────────────────────────────

// Badge setup is eager. Open-surface reconciliation is deferred by one event
// turn so onStartup/onInstalled can claim the worker's real lifecycle mode.
refreshBadge()
