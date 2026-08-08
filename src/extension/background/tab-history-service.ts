import {
  Context,
  Deferred,
  Effect,
  Layer,
  Ref,
  Result,
  Schema
} from 'effect'

import {
  MAX_TAB_HISTORY,
  canonicalizeGlobalHistory,
  displayUrlForHistory,
  effectiveUrlForHistoryIdentity,
  findHistoryTargetIndex,
  findTabForHistoryEntry,
  historyChanged,
  historyForBackgroundTabCreation,
  historyForTabNavigation,
  historyForUserActivation,
  normalizeGlobalHistory,
  pruneMissingHistoryEntries,
  removeTabEntriesFromHistory,
  replaceTabIdInHistory,
  repairHistoryCursorForActiveTab,
  type GlobalTabHistory,
  type GlobalTabHistoryInput
} from './tab-history-state.js'
import { normalizeWorkingSetActivity, pageIdentityForWorkingSet } from '../working-set.js'
import { WORKING_SET_ACTIVITY_KEY } from './working-set-service.js'
import type { ChromeApi } from './chrome-api.js'
import { readChromeStorageValue, writeChromeStorageValue } from './chrome-storage.js'
import {
  focusExistingTabTargetEffect,
  type ExistingTabFocusResult
} from '../tab-focus.js'
import { BrowserTabs } from '../browser-tabs-service.js'
import { isSuspended, unwrapSuspenderTitle, unwrapSuspenderUrl } from '../suspension.js'
import type { ChromeOpenTabsSnapshot } from '../tabs.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from '../types'

export { TAB_HISTORY_GET_MESSAGE, TAB_HISTORY_SWITCH_MESSAGE } from '../runtime-messages.js'

export const TAB_HISTORY_STORAGE_KEY = 'globalTabHistory'
const TAB_HISTORY_KEY = TAB_HISTORY_STORAGE_KEY
const TAB_HISTORY_STORAGE_VERSION = 2

type StoredGlobalTabHistoryV2 = GlobalTabHistory & {
  version: typeof TAB_HISTORY_STORAGE_VERSION
}

const storedTabHistoryEntrySchema = Schema.Struct({
  windowId: Schema.Int,
  tabId: Schema.Int,
  url: Schema.String
})

const storedPendingTabHistoryEntrySchema = Schema.Struct({
  windowId: Schema.Int,
  tabId: Schema.Int,
  url: Schema.String,
  createdAt: Schema.Finite
})

const storedGlobalTabHistoryV2Schema = Schema.Struct({
  version: Schema.Literals([TAB_HISTORY_STORAGE_VERSION]),
  stack: Schema.mutable(Schema.Array(storedTabHistoryEntrySchema)),
  index: Schema.Int,
  pending: Schema.mutable(Schema.Array(storedPendingTabHistoryEntrySchema))
}) satisfies Schema.Schema<StoredGlobalTabHistoryV2>

const isStoredGlobalTabHistoryV2 = Schema.is(storedGlobalTabHistoryV2Schema)

type FocusedWindowLookup = {
  id: number | null
  known: boolean
}
type LastFocusedActiveTabLookup = {
  tab: chrome.tabs.Tab | null
  known: boolean
}
type MutationResult<T> = {
  history?: GlobalTabHistoryInput
  value?: T
  commit?: Effect.Effect<void>
}
type FocusAction = {
  tab: chrome.tabs.Tab
  openerTabId?: number
}
type TabHistorySwitchPlan = {
  storedHistory: GlobalTabHistory
  baseHistory: GlobalTabHistory
  nextHistory: GlobalTabHistory
  focusAction: FocusAction
}
type CapturedTab = Promise<chrome.tabs.Tab | null>

export class TabHistoryTaskError extends Schema.TaggedErrorClass<TabHistoryTaskError>()(
  'TabHistoryTaskError',
  { cause: Schema.Defect() }
) {}

/**
 * The browser state and history view are produced inside one serialized history
 * operation. Required tab/window reads reject together so callers never receive
 * a valid-looking partial generation.
 */
type TabHistorySnapshotCapture = {
  tabHistory: TabHistorySnapshot
  openTabsSnapshot: ChromeOpenTabsSnapshot
}
export class TabHistory extends Context.Service<TabHistory, {
  readonly getTabHistorySnapshot: (
    activity?: WorkingSetActivityStore | null
  ) => Effect.Effect<TabHistorySnapshot, TabHistoryTaskError>
  readonly getTabHistorySnapshotCapture: (
    activity?: WorkingSetActivityStore | null
  ) => Effect.Effect<TabHistorySnapshotCapture, TabHistoryTaskError>
  readonly recordFocusedWindowActiveTab: (
    windowId: number,
    capturedActiveTab?: CapturedTab
  ) => Effect.Effect<void, TabHistoryTaskError>
  readonly recordTabCreation: (tab: chrome.tabs.Tab) => Effect.Effect<void, TabHistoryTaskError>
  readonly recordTabNavigation: (
    tabId: number,
    changeInfo: { url?: string },
    tab: chrome.tabs.Tab
  ) => Effect.Effect<void, TabHistoryTaskError>
  readonly recordTabActivation: (
    windowId: number,
    tabId: number,
    capturedTab?: CapturedTab
  ) => Effect.Effect<void, TabHistoryTaskError>
  readonly removeTabFromHistory: (tabId: number) => Effect.Effect<void, TabHistoryTaskError>
  readonly replaceTabId: (
    addedTabId: number,
    removedTabId: number
  ) => Effect.Effect<void, TabHistoryTaskError>
  readonly resetForBrowserStartup: () => Effect.Effect<void, TabHistoryTaskError>
  readonly restorePreviousTabAfterClose: (
    tabId: number,
    removeInfo: chrome.tabs.OnRemovedInfo
  ) => Effect.Effect<void, TabHistoryTaskError>
  readonly switchTabHistory: (direction: number) => Effect.Effect<void, TabHistoryTaskError>
}>()('@tab-out/background/TabHistory') {
  static layer(chromeApi: ChromeApi): Layer.Layer<TabHistory> {
    return makeTabHistoryLayer(chromeApi).pipe(Layer.provide(BrowserTabs.layer()))
  }
}

function mapTabsById(tabs: chrome.tabs.Tab[]): Map<number, chrome.tabs.Tab> {
  const tabsById = new Map<number, chrome.tabs.Tab>()
  for (const tab of tabs) {
    if (typeof tab.id === 'number') tabsById.set(tab.id, tab)
  }
  return tabsById
}

function mapWindowTypesById(windows: chrome.windows.Window[]): Map<number, string | undefined> {
  const windowTypesById = new Map<number, string | undefined>()
  for (const window of windows) {
    if (typeof window.id === 'number') windowTypesById.set(window.id, window.type)
  }
  return windowTypesById
}

function focusedWindowLookupFromWindows(windows: chrome.windows.Window[]): FocusedWindowLookup {
  const focusedWindow = windows.find((win) => win.focused && typeof win.id === 'number')
  return { id: focusedWindow?.id ?? null, known: true }
}

function isStandaloneAppWindow(windowType?: string) {
  return windowType === 'app' || windowType === 'popup'
}

function emptyGlobalTabHistory(): GlobalTabHistory {
  return { stack: [], index: -1, pending: [] }
}

function storedGlobalTabHistory(history: GlobalTabHistoryInput): StoredGlobalTabHistoryV2 {
  const cleanHistory = canonicalizeGlobalHistory(history).history
  return {
    version: TAB_HISTORY_STORAGE_VERSION,
    ...cleanHistory
  }
}

function historyEntryForTab(tab: chrome.tabs.Tab): { windowId: number; tabId: number; url: string } | null {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return null
  return {
    windowId: tab.windowId,
    tabId: tab.id,
    url: effectiveUrlForHistoryIdentity(tab)
  }
}

function historyEntryMatchesTab(entry: { tabId: number; url: string }, tab: chrome.tabs.Tab | undefined): boolean {
  return !!tab && tab.id === entry.tabId && effectiveUrlForHistoryIdentity(tab) === entry.url
}

const makeTabHistoryEffectService = Effect.fn('TabHistory.make')(function*(
  chromeApi: ChromeApi
) {
  const tabHistoryCache = yield* Ref.make<GlobalTabHistory | null>(null)
  const browserStartupResetPending = yield* Ref.make(false)
  const trustedTabIds = new Set<number>()

  const tryTask = Effect.fn('TabHistory.tryTask')(function*<Value>(
    run: () => PromiseLike<Value>
  ) {
    return yield* Effect.tryPromise({
      try: run,
      catch: (cause) => TabHistoryTaskError.make({ cause })
    })
  })

  function tabHistoryStorageArea(): chrome.storage.StorageArea | null {
    return chromeApi.storage?.local || chromeApi.storage?.session || null
  }

  const readTabHistory = Effect.fn('TabHistory.read')(function*() {
    const cached = yield* Ref.get(tabHistoryCache)
    if (cached) return cached
    const storage = tabHistoryStorageArea()
    if (!storage) {
      const emptyHistory = emptyGlobalTabHistory()
      yield* Ref.set(tabHistoryCache, emptyHistory)
      return emptyHistory
    }

    let storedHistory = yield* tryTask(() => readChromeStorageValue(storage, TAB_HISTORY_KEY))
    let migratedFromSession = false
    const sessionStorage = chromeApi.storage?.session
    if (storedHistory == null && storage === chromeApi.storage?.local && sessionStorage) {
      storedHistory = yield* tryTask(() => readChromeStorageValue(sessionStorage, TAB_HISTORY_KEY))
      migratedFromSession = storedHistory != null
    }

    // The former ID-only schema cannot distinguish an extension reload from a
    // browser restart whose onStartup event was missed while Tab Out was
    // disabled. Reset it once rather than allowing Chrome's reused IDs to point
    // at unrelated pages.
    let storedHistoryInput: GlobalTabHistoryInput
    if (storedHistory == null) {
      storedHistoryInput = storedHistory
    } else if (isStoredGlobalTabHistoryV2(storedHistory)) {
      storedHistoryInput = storedHistory
    } else {
      const emptyHistory = emptyGlobalTabHistory()
      yield* tryTask(() => writeChromeStorageValue(storage, TAB_HISTORY_KEY, storedGlobalTabHistory(emptyHistory)))
      yield* Ref.set(tabHistoryCache, emptyHistory)
      return emptyHistory
    }

    const canonical = canonicalizeGlobalHistory(storedHistoryInput)
    if (canonical.changed || migratedFromSession) {
      yield* tryTask(() => writeChromeStorageValue(storage, TAB_HISTORY_KEY, storedGlobalTabHistory(canonical.history)))
    }
    yield* Ref.set(tabHistoryCache, canonical.history)
    return canonical.history
  })

  const writeTabHistory = Effect.fn('TabHistory.write')(function*(
    nextHistory: GlobalTabHistoryInput
  ) {
    const cleanHistory = canonicalizeGlobalHistory(nextHistory).history
    const storage = tabHistoryStorageArea()
    if (storage) {
      yield* tryTask(() => writeChromeStorageValue(storage, TAB_HISTORY_KEY, storedGlobalTabHistory(cleanHistory)))
    }
    yield* Ref.set(tabHistoryCache, cleanHistory)
  })

  const readActivityTimestamps = Effect.fn('TabHistory.readActivityTimestamps')(function*() {
    const storage = tabHistoryStorageArea()
    if (!storage) return new Map()
    const stored = yield* Effect.result(
      tryTask(() => readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY))
    )
    if (Result.isFailure(stored)) return new Map()
    const activity = normalizeWorkingSetActivity(stored.success)
    const map = new Map<string, number>()
    for (const [key, record] of Object.entries(activity.records)) {
      const ts = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
      if (ts > 0) map.set(key, ts)
    }
    return map
  })

  function activityTimestampsFromStore(activity: WorkingSetActivityStore | null | undefined): Map<string, number> {
    const normalized = normalizeWorkingSetActivity(activity)
    const map = new Map<string, number>()
    for (const [key, record] of Object.entries(normalized.records)) {
      const ts = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
      if (ts > 0) map.set(key, ts)
    }
    return map
  }

  const applyPendingBrowserStartupReset = Effect.fn('TabHistory.applyStartupReset')(function*() {
    if (!(yield* Ref.get(browserStartupResetPending))) return
    yield* writeTabHistory({ stack: [], index: -1, pending: [] })
    yield* Ref.set(browserStartupResetPending, false)
  })

  const runTabHistoryMutation = Effect.fn('TabHistory.mutate')(function*<T>(
    mutator: (
      history: GlobalTabHistory
    ) => Effect.Effect<MutationResult<T> | void, TabHistoryTaskError>
  ) {
    yield* applyPendingBrowserStartupReset()
    const before = canonicalizeGlobalHistory(yield* readTabHistory()).history
    const result = (yield* mutator(before)) || {}
    const requestedHistory = result.history || before
    const cleanHistory = canonicalizeGlobalHistory(requestedHistory).history
    const changed = historyChanged(before, cleanHistory)
    if (changed) yield* writeTabHistory(cleanHistory)
    if (result.commit) yield* result.commit
    return {
      history: cleanHistory,
      changed,
      value: result.value
    }
  })

  const historyAfterTabActivation = Effect.fn('TabHistory.afterActivation')(function*(
    history: GlobalTabHistory,
    tab: chrome.tabs.Tab
  ) {
    const activeEntry = historyEntryForTab(tab)
    if (!activeEntry) return history
    yield* primeNativeCloseTarget(activeEntry.windowId, activeEntry.tabId, history)
    return historyForUserActivation(history, activeEntry).history
  })

  const recordTabActivation = Effect.fn('TabHistory.recordTabActivation')(function*(
    windowId: number,
    tabId: number,
    capturedTab?: CapturedTab
  ) {
    if (typeof windowId !== 'number' || typeof tabId !== 'number') return

    yield* runTabHistoryMutation((history) => Effect.gen(function*() {
      const lookup = yield* Effect.result(tryTask(async () => {
        let activatedTab = capturedTab ? await capturedTab : null
        activatedTab ??= await chromeApi.tabs.get(tabId)
        return activatedTab
      }))
      if (Result.isFailure(lookup)) {
        return { history }
      }
      const activatedTab = lookup.success
      if (activatedTab.id !== tabId || activatedTab.windowId !== windowId) return { history }
      return {
        history: yield* historyAfterTabActivation(history, activatedTab),
        commit: Effect.sync(() => {
          trustedTabIds.add(tabId)
        })
      }
    }))
  })

  const recordTabCreation = Effect.fn('TabHistory.recordTabCreation')(function*(
    tab: chrome.tabs.Tab
  ) {
    const tabId = tab.id
    const windowId = tab.windowId
    if (
      tab.active ||
      typeof tabId !== 'number' ||
      typeof windowId !== 'number' ||
      typeof tab.openerTabId !== 'number'
    ) {
      return
    }

    // A creation event starts a new physical lifetime even if Chrome reused an
    // ID whose removal/startup event the extension did not observe.
    yield* Effect.sync(() => {
      trustedTabIds.delete(tabId)
    })

    yield* runTabHistoryMutation((history) => Effect.succeed({
      history: historyForBackgroundTabCreation(history, {
        windowId,
        tabId,
        url: effectiveUrlForHistoryIdentity(tab),
        createdAt: Date.now()
      }).history,
      commit: Effect.sync(() => {
        trustedTabIds.add(tabId)
      })
    }))
  })

  const recordTabNavigation = Effect.fn('TabHistory.recordTabNavigation')(function*(
    tabId: number,
    changeInfo: { url?: string },
    tab: chrome.tabs.Tab
  ) {
    if (
      changeInfo?.url === undefined ||
      typeof tabId !== 'number' ||
      tab?.id !== tabId ||
      typeof tab.windowId !== 'number'
    ) {
      return
    }

    const navigatedEntry = historyEntryForTab(tab)
    if (!navigatedEntry) return
    yield* runTabHistoryMutation((history) => Effect.succeed({
      // A URL update alone cannot distinguish a legitimate navigation from a
      // reused ID after a missed browser-startup event. Creation, activation,
      // replacement, or an identity-pruned snapshot must establish this tab's
      // current lifetime before its stored identity can move with navigation.
      history: trustedTabIds.has(tabId)
        ? historyForTabNavigation(history, navigatedEntry).history
        : history
    }))
  })

  const findFocusedWindowId = Effect.fn('TabHistory.findFocusedWindow')(function*() {
    const windows = yield* Effect.result(tryTask(() => chromeApi.windows.getAll()))
    return Result.isFailure(windows)
      ? { id: null, known: false } satisfies FocusedWindowLookup
      : focusedWindowLookupFromWindows(windows.success)
  })

  const findLastFocusedActiveTab = Effect.fn('TabHistory.findLastFocusedActiveTab')(function*() {
    const focusedTabs = yield* Effect.result(
      tryTask(() => chromeApi.tabs.query({ active: true, lastFocusedWindow: true }))
    )
    return Result.isFailure(focusedTabs)
      ? { tab: null, known: false } satisfies LastFocusedActiveTabLookup
      : { tab: focusedTabs.success[0] || null, known: true }
  })

  const findActiveTabForHistory = Effect.fn('TabHistory.findActiveTab')(function*(
    tabs: chrome.tabs.Tab[],
    history: GlobalTabHistoryInput,
    capturedFocusedWindow?: FocusedWindowLookup
  ) {
    const focusedWindow = capturedFocusedWindow ?? (yield* findFocusedWindowId())
    if (!focusedWindow.known) {
      return { tab: null, chromeFocused: false, known: false }
    }

    if (focusedWindow.id != null) {
      const focusedActiveTab = tabs.find((tab) => tab.windowId === focusedWindow.id && tab.active)
      return focusedActiveTab
        ? { tab: focusedActiveTab, chromeFocused: true, known: true }
        : { tab: null, chromeFocused: true, known: false }
    }

    const tabsById = mapTabsById(tabs)
    const historyTab = findTabForHistoryEntry(history, tabsById)
    if (historyTab) return { tab: historyTab, chromeFocused: false, known: true }

    const lastFocusedTab = yield* findLastFocusedActiveTab()
    if (!lastFocusedTab.known) return { tab: null, chromeFocused: false, known: false }
    if (!lastFocusedTab.tab) return { tab: null, chromeFocused: false, known: true }
    const capturedTab = typeof lastFocusedTab.tab.id === 'number'
      ? tabsById.get(lastFocusedTab.tab.id)
      : null
    if (
      !capturedTab?.active ||
      capturedTab.windowId !== lastFocusedTab.tab.windowId ||
      effectiveUrlForHistoryIdentity(capturedTab) !== effectiveUrlForHistoryIdentity(lastFocusedTab.tab)
    ) {
      return { tab: null, chromeFocused: false, known: false }
    }
    return { tab: capturedTab, chromeFocused: false, known: true }
  })

  const findPreviousSurvivingTabInWindow = Effect.fn('TabHistory.findPreviousInWindow')(function*(
    history: GlobalTabHistoryInput,
    windowId: number,
    tabId: number
  ) {
    const current = normalizeGlobalHistory(history)
    const previousEntries = []
    for (let i = current.index; i >= 0; i--) {
      const entry = current.stack[i]
      if (entry && entry.windowId === windowId && entry.tabId !== tabId) previousEntries.push(entry)
    }
    if (previousEntries.length === 0) return null

    const query = yield* Effect.result(tryTask(() => chromeApi.tabs.query({ windowId })))
    if (Result.isFailure(query)) return null
    const tabsInWindow = query.success

    const tabsById = mapTabsById(tabsInWindow)
    const currentTab = tabsById.get(tabId)
    if (!currentTab) return null

    for (const entry of previousEntries) {
      const targetTab = tabsById.get(entry.tabId)
      if (targetTab && historyEntryMatchesTab(entry, targetTab)) return { currentTab, targetTab }
    }

    return null
  })

  const primeNativeCloseTarget = Effect.fn('TabHistory.primeNativeCloseTarget')(function*(
    windowId: number,
    tabId: number,
    history: GlobalTabHistoryInput
  ) {
    const match = yield* findPreviousSurvivingTabInWindow(history, windowId, tabId)
    if (!match) return

    const { currentTab, targetTab } = match
    if (currentTab.openerTabId === targetTab.id) return

    // Some browser-managed tabs reject opener changes; the onRemoved restore
    // path below remains the fallback.
    yield* Effect.result(
      tryTask(() => chromeApi.tabs.update(tabId, { openerTabId: targetTab.id }))
    )
  })

  const recordFocusedWindowActiveTab = Effect.fn('TabHistory.recordFocusedWindowActiveTab')(function*(
    windowId: number,
    capturedActiveTab?: CapturedTab
  ) {
    if (windowId == null || windowId === chromeApi.windows.WINDOW_ID_NONE) return
    yield* runTabHistoryMutation((history) => Effect.gen(function*() {
      const lookup = yield* Effect.result(tryTask(async () => {
        let activeTab = capturedActiveTab ? await capturedActiveTab : null
        activeTab ??= (await chromeApi.tabs.query({ windowId, active: true }))[0] ?? null
        return activeTab
      }))
      // Window may have closed or be unavailable; ignore.
      if (Result.isFailure(lookup)) return { history }
      const activeTab = lookup.success
      if (typeof activeTab?.id !== 'number' || activeTab.windowId !== windowId || !activeTab.active) {
        return { history }
      }
      const activeTabId = activeTab.id
      return {
        history: yield* historyAfterTabActivation(history, activeTab),
        commit: Effect.sync(() => {
          trustedTabIds.add(activeTabId)
        })
      }
    }))
  })

  const removeTabFromHistory = Effect.fn('TabHistory.removeTab')(function*(tabId: number) {
    yield* Effect.sync(() => {
      trustedTabIds.delete(tabId)
    })
    yield* runTabHistoryMutation((history) => Effect.succeed({
      history: removeTabEntriesFromHistory(history, tabId)
    }))
  })

  const replaceTabId = Effect.fn('TabHistory.replaceTabId')(function*(
    addedTabId: number,
    removedTabId: number
  ) {
    yield* Effect.sync(() => {
      trustedTabIds.delete(removedTabId)
      trustedTabIds.delete(addedTabId)
    })
    yield* runTabHistoryMutation((history) => Effect.gen(function*() {
      let replacementWindowId: number | undefined
      let replacementUrl: string | undefined
      const lookup = yield* Effect.result(tryTask(() => chromeApi.tabs.get(addedTabId)))
      if (Result.isSuccess(lookup)) {
        const replacementTab = lookup.success
        if (typeof replacementTab?.windowId === 'number') replacementWindowId = replacementTab.windowId
        replacementUrl = effectiveUrlForHistoryIdentity(replacementTab)
      }
      return {
        history: replaceTabIdInHistory(history, addedTabId, removedTabId, replacementWindowId, replacementUrl),
        commit: Effect.sync(() => {
          if (typeof replacementUrl === 'string') trustedTabIds.add(addedTabId)
        })
      }
    }))
  })

  const resetForBrowserStartup = Effect.fn('TabHistory.resetForBrowserStartup')(function*() {
    // Browser startup invalidates every stored tab/window id. Clearing does not
    // depend on reading those stale values first, so a transient read failure
    // must not leave them available for Chrome to reuse in the new session.
    yield* Ref.set(browserStartupResetPending, true)
    yield* Effect.sync(() => {
      trustedTabIds.clear()
    })
    yield* applyPendingBrowserStartupReset()
  })

  const preparePreviousTabAfterClose = Effect.fn('TabHistory.preparePreviousAfterClose')(function*(
    tabId: number,
    removeInfo: chrome.tabs.OnRemovedInfo
  ) {
    yield* Effect.sync(() => {
      trustedTabIds.delete(tabId)
    })
    if (!removeInfo) return null

    const { value: restoreTarget } = yield* runTabHistoryMutation<chrome.tabs.Tab | null>(
      (history) => Effect.gen(function*() {
        const nextHistory = removeTabEntriesFromHistory(history, tabId)
        if (removeInfo.isWindowClosing) return { history: nextHistory }

        const currentEntry = history.stack[history.index]
        if (!currentEntry || currentEntry.tabId !== tabId || currentEntry.windowId !== removeInfo.windowId) {
          return { history: nextHistory }
        }

        const query = yield* Effect.result(
          tryTask(() => chromeApi.tabs.query({ windowId: removeInfo.windowId }))
        )
        if (Result.isFailure(query)) return { history: nextHistory }
        const tabsInWindow = query.success

        const tabsById = mapTabsById(tabsInWindow)
        let targetOldIndex = -1
        for (let i = history.index - 1; i >= 0; i--) {
          const entry = history.stack[i]
          if (!entry) continue
          if (entry.windowId !== removeInfo.windowId) continue
          if (!historyEntryMatchesTab(entry, tabsById.get(entry.tabId))) continue
          targetOldIndex = i
          break
        }

        if (targetOldIndex === -1) return { history: nextHistory }

        const targetEntry = history.stack[targetOldIndex]
        if (!targetEntry) return { history: nextHistory }
        const targetId = targetEntry.tabId
        let targetNewIndex = -1
        for (let i = Math.min(targetOldIndex, nextHistory.stack.length - 1); i >= 0; i--) {
          const entry = nextHistory.stack[i]
          if (entry?.tabId === targetId && entry.windowId === removeInfo.windowId) {
            targetNewIndex = i
            break
          }
        }

        if (targetNewIndex === -1) return { history: nextHistory }

        const targetTab = tabsById.get(targetId)
        if (!targetTab) return { history: nextHistory }

        const finalHistory = {
          stack: nextHistory.stack,
          index: targetNewIndex,
          pending: nextHistory.pending
        }
        const activeTab = tabsInWindow.find((tab) => tab.active)
        return {
          history: finalHistory,
          value: activeTab?.id === targetId ? null : targetTab
        }
      }))

    return restoreTarget ?? null
  })

  const prepareTabHistorySwitch = Effect.fn('TabHistory.prepareSwitch')(function*(
    direction: number
  ) {
    // Keep Chrome activation inside the serialized task. Its onActivated event
    // queues behind this operation, so a confirmed switch commits the cursor
    // first and the event becomes idempotent instead of truncating forward
    // history. A rejected activation leaves the pre-switch cursor/pending queue.
    yield* applyPendingBrowserStartupReset()
    const storedHistory = canonicalizeGlobalHistory(yield* readTabHistory()).history
    const tabs = yield* tryTask(() => chromeApi.tabs.query({}))
    const existingTabs = mapTabsById(tabs)
    const history = canonicalizeGlobalHistory(
      pruneMissingHistoryEntries(storedHistory, existingTabs)
    ).history
    const activeTabLookup = yield* findActiveTabForHistory(tabs, history)
    if (!activeTabLookup.known) {
      return yield* Effect.fail(TabHistoryTaskError.make({
        cause: new Error('Chrome focus state is unavailable')
      }))
    }
    const { tab: activeTab, chromeFocused } = activeTabLookup
    let baseHistory = history
    let nextHistory = history
    let focusAction: FocusAction | null = null

    if (typeof activeTab?.id === 'number') {
      if (!chromeFocused) {
        focusAction = { tab: activeTab }
      } else if (history.stack.length === 0) {
        const activeEntry = historyEntryForTab(activeTab)
        if (activeEntry) {
          nextHistory = {
            stack: [activeEntry],
            index: 0,
            pending: history.pending
          }
        }
      } else {
        const repaired = repairHistoryCursorForActiveTab(history, activeTab)
        const navigationHistory = canonicalizeGlobalHistory(
          pruneMissingHistoryEntries(repaired.history, existingTabs)
        ).history
        baseHistory = navigationHistory
        nextHistory = navigationHistory
        const nextIndex = findHistoryTargetIndex(navigationHistory, direction, existingTabs, activeTab)

        if (nextIndex === -1 && direction > 0) {
          const pendingTarget = navigationHistory.pending.find((entry) => (
            entry.tabId !== activeTab.id &&
            existingTabs.has(entry.tabId)
          ))
          const targetTab = pendingTarget ? existingTabs.get(pendingTarget.tabId) : null
          if (typeof targetTab?.id === 'number') {
            nextHistory = historyForUserActivation(navigationHistory, {
              windowId: targetTab.windowId,
              tabId: targetTab.id,
              url: effectiveUrlForHistoryIdentity(targetTab)
            }).history
            focusAction = {
              tab: targetTab,
              openerTabId: activeTab.id
            }
          }
        } else if (nextIndex !== -1) {
          const targetEntry = navigationHistory.stack[nextIndex]
          const targetTab = targetEntry ? existingTabs.get(targetEntry.tabId) : null
          if (typeof targetTab?.id === 'number') {
            const targetTabId = targetTab.id
            nextHistory = {
              stack: navigationHistory.stack.map((entry, entryIndex) => (entryIndex === nextIndex
                ? {
                    windowId: targetTab.windowId,
                    tabId: targetTabId,
                    url: effectiveUrlForHistoryIdentity(targetTab)
                  }
                : entry)),
              index: nextIndex,
              pending: navigationHistory.pending
            }
            focusAction = {
              tab: targetTab,
              openerTabId: activeTab.id
            }
          }
        }
      }
    }

    if (!focusAction) {
      const cleanHistory = canonicalizeGlobalHistory(nextHistory).history
      if (historyChanged(storedHistory, cleanHistory)) yield* writeTabHistory(cleanHistory)
      return null
    }

    return { storedHistory, baseHistory, nextHistory, focusAction }
  })

  const completeTabHistorySwitch = Effect.fn('TabHistory.completeSwitch')(function*(
    plan: TabHistorySwitchPlan,
    focusResult: ExistingTabFocusResult
  ) {
    const { storedHistory, baseHistory, nextHistory, focusAction } = plan
    const activationConfirmed = focusResult.status === 'focused' || focusResult.status === 'activated'
    const focusTabId = focusAction.tab.id
    if (activationConfirmed && focusAction.openerTabId && typeof focusTabId === 'number') {
      yield* Effect.result(
        tryTask(() => chromeApi.tabs.update(focusTabId, { openerTabId: focusAction.openerTabId }))
      )
    }
    let committedHistory = activationConfirmed ? nextHistory : baseHistory
    if (focusResult.status === 'not-found' && typeof focusTabId === 'number') {
      committedHistory = removeTabEntriesFromHistory(committedHistory, focusTabId)
    }
    const cleanHistory = canonicalizeGlobalHistory(committedHistory).history
    if (historyChanged(storedHistory, cleanHistory)) yield* writeTabHistory(cleanHistory)
    if (!activationConfirmed) {
      return yield* Effect.fail(TabHistoryTaskError.make({
        cause: new Error('Could not activate tab history target')
      }))
    }
  })

  const getTabHistorySnapshotCapture = Effect.fn('TabHistory.captureSnapshot')(function*(
    activity?: WorkingSetActivityStore | null
  ) {
    const { value: capture } = yield* runTabHistoryMutation<TabHistorySnapshotCapture>(
      (storedHistory) => Effect.gen(function*() {
        const [tabs, windows] = yield* Effect.all([
          tryTask(() => chromeApi.tabs.query({})),
          tryTask(() => chromeApi.windows.getAll())
        ], { concurrency: 'unbounded' })
        const windowTypeById = mapWindowTypesById(windows)
        const existingTabs = mapTabsById(tabs)
        const identityPrunedHistory = canonicalizeGlobalHistory(
          pruneMissingHistoryEntries(storedHistory, existingTabs)
        ).history
        const activeTabLookup = yield* findActiveTabForHistory(
          tabs,
          identityPrunedHistory,
          focusedWindowLookupFromWindows(windows)
        )
        if (!activeTabLookup.known) {
          return yield* Effect.fail(TabHistoryTaskError.make({
            cause: new Error('Chrome focus state is unavailable')
          }))
        }
        const { tab: activeTab } = activeTabLookup
        const repairedHistory = repairHistoryCursorForActiveTab(identityPrunedHistory, activeTab)
        const prunedHistory = pruneMissingHistoryEntries(repairedHistory.history, existingTabs)
        const cleanHistory = canonicalizeGlobalHistory(prunedHistory).history
        const previousIndex = findHistoryTargetIndex(cleanHistory, -1, existingTabs, activeTab)
        const stackNextIndex = findHistoryTargetIndex(cleanHistory, 1, existingTabs, activeTab)
        const nextIndex = stackNextIndex === -1 && cleanHistory.pending.length > 0
          ? cleanHistory.stack.length
          : stackNextIndex
        const activityTimestamps = activity
          ? activityTimestampsFromStore(activity)
          : yield* readActivityTimestamps()
        const indexedEntries = [
          ...cleanHistory.stack.map((entry, index) => ({
            entry,
            index,
            pending: false,
            createdAt: null
          })),
          ...cleanHistory.pending.map((entry, pendingIndex) => ({
            entry,
            index: cleanHistory.stack.length + pendingIndex,
            pending: true,
            createdAt: entry.createdAt
          }))
        ]

        return {
          history: cleanHistory,
          commit: Effect.sync(() => {
            for (const tab of tabs) {
              if (typeof tab.id === 'number') trustedTabIds.add(tab.id)
            }
          }),
          value: {
            openTabsSnapshot: { tabs, windows },
            tabHistory: {
              stackSize: cleanHistory.stack.length,
              pendingSize: cleanHistory.pending.length,
              maxSize: MAX_TAB_HISTORY,
              cursorIndex: cleanHistory.index,
              currentIndex: cleanHistory.index,
              previousIndex,
              nextIndex,
              activeTabId: activeTab?.id ?? null,
              activeWindowId: activeTab?.windowId ?? null,
              activeWasInserted: repairedHistory.activeWasInserted,
              entries: indexedEntries.map(({ entry, index, pending, createdAt }) => {
                const tab = existingTabs.get(entry.tabId)
                const rawUrl = tab?.url || ''
                const url = unwrapSuspenderUrl(rawUrl)
                const suspended = isSuspended(rawUrl, url)
                const displayUrl = displayUrlForHistory(url)
                const cleanTitle = (tab?.title || '').replaceAll('\u200E', '').trim()
                const title = unwrapSuspenderTitle(rawUrl) || (cleanTitle ? cleanTitle : displayUrl)
                const activityKey = pageIdentityForWorkingSet(url)
                return {
                  index,
                  tabId: entry.tabId,
                  windowId: entry.windowId,
                  exists: !!tab,
                  active: tab?.id === activeTab?.id,
                  activeInOtherWindow: !!(tab?.active && activeTab && tab.windowId !== activeTab.windowId),
                  isApp: isStandaloneAppWindow(tab ? windowTypeById.get(tab.windowId) : undefined),
                  pinned: !!tab?.pinned,
                  discarded: !!tab?.discarded,
                  suspended,
                  loading: !!tab && !suspended && tab.status === 'loading',
                  audible: !!tab?.audible,
                  muted: !!tab?.mutedInfo?.muted,
                  pending,
                  createdAt,
                  cursor: index === cleanHistory.index,
                  current: index === cleanHistory.index,
                  previousTarget: index === previousIndex,
                  nextTarget: index === nextIndex,
                  title: title || `Tab ${entry.tabId}`,
                  url,
                  rawUrl,
                  displayUrl,
                  favIconUrl: tab?.favIconUrl || '',
                  lastActivatedAt: activityKey ? activityTimestamps.get(activityKey) ?? null : null
                }
              })
            }
          }
        }
      }))

    if (!capture) {
      return yield* Effect.fail(TabHistoryTaskError.make({
        cause: new Error('Tab history snapshot capture was not produced')
      }))
    }
    return capture
  })

  const getTabHistorySnapshot = Effect.fn('TabHistory.getSnapshot')(function*(
    activity?: WorkingSetActivityStore | null
  ) {
    return (yield* getTabHistorySnapshotCapture(activity)).tabHistory
  })

  return {
    getTabHistorySnapshot,
    getTabHistorySnapshotCapture,
    recordFocusedWindowActiveTab,
    recordTabCreation,
    recordTabNavigation,
    recordTabActivation,
    removeTabFromHistory,
    replaceTabId,
    resetForBrowserStartup,
    preparePreviousTabAfterClose,
    prepareTabHistorySwitch,
    completeTabHistorySwitch
  }
})

function makeTabHistoryLayer(chromeApi: ChromeApi) {
  return Layer.effect(TabHistory, Effect.gen(function*() {
    const browserTabs = yield* BrowserTabs
    let taskTail = Deferred.makeUnsafe<void>()
    Deferred.doneUnsafe(taskTail, Effect.void)

    // Reserve each task's place synchronously when Chrome invokes the service.
    // Runtime fibers may start in a different order, so each task awaits the
    // previous invocation's Deferred before touching browser or storage state.
    function serialize<Value>(
      task: Effect.Effect<Value, TabHistoryTaskError>
    ): Effect.Effect<Value, TabHistoryTaskError> {
      const previous = taskTail
      const completion = Deferred.makeUnsafe<void>()
      taskTail = completion
      return Deferred.await(previous).pipe(
        Effect.andThen(task),
        Effect.ensuring(Deferred.succeed(completion, undefined))
      )
    }

    const service = yield* makeTabHistoryEffectService(chromeApi)
    const focusExistingTab = Effect.fn('TabHistory.focusExistingTab')(function*(
      tab: chrome.tabs.Tab | null
    ) {
      if (typeof tab?.id !== 'number') return { status: 'not-found' } as const
      return yield* focusExistingTabTargetEffect({
        tabId: tab.id,
        windowId: tab.windowId,
        url: unwrapSuspenderUrl(tab.url || ''),
        rawUrl: tab.url || ''
      }).pipe(Effect.provideService(BrowserTabs, browserTabs))
    })
    const restorePreviousTabAfterClose = Effect.fn('TabHistory.restorePreviousAfterClose')(
      function*(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) {
        const restoreTarget = yield* service.preparePreviousTabAfterClose(tabId, removeInfo)
        if (!restoreTarget) return
        const focusResult = yield* focusExistingTab(restoreTarget)
        const restoreTargetId = restoreTarget.id
        if (focusResult.status === 'not-found' && typeof restoreTargetId === 'number') {
          yield* service.removeTabFromHistory(restoreTargetId)
        }
      }
    )
    const switchTabHistory = Effect.fn('TabHistory.switch')(function*(direction: number) {
      const plan = yield* service.prepareTabHistorySwitch(direction)
      if (!plan) return
      const focusResult = yield* focusExistingTab(plan.focusAction.tab)
      yield* service.completeTabHistorySwitch(plan, focusResult)
    })
    return TabHistory.of({
      getTabHistorySnapshot: (activity) =>
        serialize(service.getTabHistorySnapshot(activity)),
      getTabHistorySnapshotCapture: (activity) =>
        serialize(service.getTabHistorySnapshotCapture(activity)),
      recordFocusedWindowActiveTab: (windowId, capturedActiveTab) =>
        serialize(service.recordFocusedWindowActiveTab(windowId, capturedActiveTab)),
      recordTabCreation: (tab) => serialize(service.recordTabCreation(tab)),
      recordTabNavigation: (tabId, changeInfo, tab) =>
        serialize(service.recordTabNavigation(tabId, changeInfo, tab)),
      recordTabActivation: (windowId, tabId, capturedTab) =>
        serialize(service.recordTabActivation(windowId, tabId, capturedTab)),
      removeTabFromHistory: (tabId) => serialize(service.removeTabFromHistory(tabId)),
      replaceTabId: (addedTabId, removedTabId) =>
        serialize(service.replaceTabId(addedTabId, removedTabId)),
      resetForBrowserStartup: () => serialize(service.resetForBrowserStartup()),
      restorePreviousTabAfterClose: (tabId, removeInfo) =>
        serialize(restorePreviousTabAfterClose(tabId, removeInfo)),
      switchTabHistory: (direction) => serialize(switchTabHistory(direction))
    })
  }))
}
