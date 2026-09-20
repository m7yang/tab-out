import { Effect, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import type { BrowserReadResult } from './browser-tabs-gateway.js'
import { BrowserTabs } from './browser-tabs-service.js'

export type NativeTabHighlightDependencies = {
  getTab(tabId: number): Promise<chrome.tabs.Tab | null>
  getWindow(windowId: number): Promise<chrome.windows.Window | null>
  highlightTabs(windowId: number, tabIndexes: number[]): Promise<boolean>
  queryTabsInWindowResult(windowId: number): Promise<BrowserReadResult<chrome.tabs.Tab[]>>
}

export type NativeTabHighlightController = {
  clear(): Promise<void>
  setTarget(tabId: number | null | undefined): Promise<void>
}

type DisplayedTarget = {
  owned: boolean
  tabId: number
  windowId: number
}

type ResolvedTarget = Omit<DisplayedTarget, 'owned'>

type TargetResolution =
  | { status: 'ready', target: ResolvedTarget }
  | { status: 'invalid' }
  | { status: 'stale' }

const INVALID_TARGET_RESOLUTION: TargetResolution = { status: 'invalid' }
const STALE_TARGET_RESOLUTION: TargetResolution = { status: 'stale' }

function readyTargetResolution(tabId: number, windowId: number): TargetResolution {
  return { status: 'ready', target: { tabId, windowId } }
}

class NativeTabHighlightBrowserError extends Schema.TaggedError<NativeTabHighlightBrowserError>()(
  'NativeTabHighlightBrowserError',
  { cause: Schema.Defect() },
) {}

function normalizedTabId(tabId: number | null | undefined): number | null {
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : null
}

function numericTabId(tab: chrome.tabs.Tab | undefined): number | null {
  return typeof tab?.id === 'number' && Number.isInteger(tab.id) ? tab.id : null
}

function numericTabIndex(tab: chrome.tabs.Tab | undefined): number | null {
  return typeof tab?.index === 'number' && Number.isInteger(tab.index) && tab.index >= 0 ? tab.index : null
}

function sameIndexSelection(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  const rightIndexes = new Set(right)
  return left.every((index) => rightIndexes.has(index))
}

/**
 * Owns the one extra Chrome-native selection used for Tab Out's live target
 * preview. Requests are serialized and coalesced so a late chrome.* response
 * cannot leave a previously hovered tab selected.
 */
export function createNativeTabHighlightController(
  dependencies?: NativeTabHighlightDependencies,
): NativeTabHighlightController {
  let desiredTabId: number | null = null
  let displayedTarget: DisplayedTarget | null = null
  let requestRevision = 0
  let runner: Promise<void> | null = null

  function requestIsCurrent(revision: number): boolean {
    return revision === requestRevision
  }

  const getTabEffect = Effect.fn('nativeTabHighlight.getTab')(function* (tabId: number) {
    if (dependencies) {
      return yield* Effect.tryPromise({
        try: () => dependencies.getTab(tabId),
        catch: (cause) => NativeTabHighlightBrowserError.make({ cause }),
      })
    }
    const browserTabs = yield* BrowserTabs
    return yield* browserTabs.getTab(tabId)
  })

  const getWindowEffect = Effect.fn('nativeTabHighlight.getWindow')(function* (windowId: number) {
    if (dependencies) {
      return yield* Effect.tryPromise({
        try: () => dependencies.getWindow(windowId),
        catch: (cause) => NativeTabHighlightBrowserError.make({ cause }),
      })
    }
    const browserTabs = yield* BrowserTabs
    return yield* browserTabs.getWindow(windowId)
  })

  const highlightTabsEffect = Effect.fn('nativeTabHighlight.highlightTabs')(function* (
    windowId: number,
    tabIndexes: number[],
  ) {
    if (dependencies) {
      return yield* Effect.tryPromise({
        try: () => dependencies.highlightTabs(windowId, tabIndexes),
        catch: (cause) => NativeTabHighlightBrowserError.make({ cause }),
      })
    }
    const browserTabs = yield* BrowserTabs
    return yield* browserTabs.highlightTabs(windowId, tabIndexes)
  })

  const queryTabsInWindowEffect = Effect.fn('nativeTabHighlight.queryTabsInWindow')(function* (
    windowId: number,
  ) {
    if (dependencies) {
      return yield* Effect.tryPromise({
        try: () => dependencies.queryTabsInWindowResult(windowId),
        catch: (cause) => NativeTabHighlightBrowserError.make({ cause }),
      })
    }
    const browserTabs = yield* BrowserTabs
    return yield* browserTabs.queryTabsInWindowResult(windowId)
  })

  const resolveTarget = Effect.fn('nativeTabHighlight.resolveTarget')(function* (
    tabId: number,
    revision: number,
  ) {
    const tab = yield* getTabEffect(tabId)
    if (!requestIsCurrent(revision)) return STALE_TARGET_RESOLUTION
    if (numericTabId(tab ?? undefined) !== tabId || typeof tab?.windowId !== 'number') {
      return INVALID_TARGET_RESOLUTION
    }

    const targetWindow = yield* getWindowEffect(tab.windowId)
    if (!requestIsCurrent(revision)) return STALE_TARGET_RESOLUTION
    // Standalone app/PWA and popup windows do not expose the normal tab rail
    // this preview is intended to annotate.
    if (!targetWindow || targetWindow.type !== 'normal') return INVALID_TARGET_RESOLUTION

    return readyTargetResolution(tabId, tab.windowId)
  })

  const updateWindowSelection = Effect.fn('nativeTabHighlight.updateWindowSelection')(function* (
    previous: DisplayedTarget | null,
    next: ResolvedTarget | null,
    revision: number,
  ) {
    const windowId = next?.windowId ?? previous?.windowId
    if (typeof windowId !== 'number') {
      displayedTarget = null
      return true
    }

    if (previous && !previous.owned && !next) {
      displayedTarget = null
      return true
    }

    const result = yield* queryTabsInWindowEffect(windowId)
    if (!requestIsCurrent(revision)) return false
    if (!result.ok) return false

    const windowTabs = result.value.filter((tab) => tab.windowId === windowId)
    // A closed window has no selection left to restore. Keep failed reads
    // retryable above, but do not let a successful empty read block the next
    // window's preview forever.
    if (windowTabs.length === 0) {
      displayedTarget = null
      return true
    }
    const activeTab = windowTabs.find((tab) => tab.active)
    const activeTabId = numericTabId(activeTab)
    const activeTabIndex = numericTabIndex(activeTab)
    if (activeTabId === null || activeTabIndex === null) return false

    const highlightedTabs = windowTabs.filter((tab) => tab.active || tab.highlighted)
    if (highlightedTabs.some((tab) => numericTabId(tab) === null || numericTabIndex(tab) === null)) {
      return false
    }

    const highlightedTabIds = new Set<number>()
    const currentIndexes: number[] = []
    for (const tab of highlightedTabs) {
      const id = numericTabId(tab)
      const index = numericTabIndex(tab)
      if (id === null || index === null) return false
      highlightedTabIds.add(id)
      currentIndexes.push(index)
    }
    const selectedTabIds = new Set(highlightedTabIds)
    const previousTab = previous
      ? windowTabs.find((tab) => numericTabId(tab) === previous.tabId)
      : undefined

    if (previous?.owned && previousTab?.highlighted && !previousTab.active) {
      selectedTabIds.delete(previous.tabId)
    }

    const nextTabId = next?.tabId
    const nextTabCandidate = nextTabId !== undefined
      ? windowTabs.find((tab) => numericTabId(tab) === nextTabId)
      : undefined
    const nextTab = numericTabIndex(nextTabCandidate) !== null ? nextTabCandidate : undefined
    const nextWasHighlighted = nextTabId !== undefined && !!nextTab && highlightedTabIds.has(nextTabId)
    const nextOwned = !!nextTab && !nextWasHighlighted && !nextTab.active
    if (nextTabId !== undefined && nextTab) selectedTabIds.add(nextTabId)
    selectedTabIds.add(activeTabId)

    const additionalIndexes: number[] = []
    for (const tab of windowTabs) {
      const id = numericTabId(tab)
      const index = numericTabIndex(tab)
      if (id !== null && index !== null && id !== activeTabId && selectedTabIds.has(id)) {
        additionalIndexes.push(index)
      }
    }
    additionalIndexes.sort((left, right) => left - right)
    const nextIndexes = [activeTabIndex, ...additionalIndexes]

    if (!sameIndexSelection(currentIndexes, nextIndexes)) {
      const highlighted = yield* highlightTabsEffect(windowId, nextIndexes)
      if (!highlighted) return false
    }

    displayedTarget = nextTab && next
      ? { ...next, owned: nextOwned }
      : null
    return true
  })

  const transitionTo = Effect.fn('nativeTabHighlight.transitionTo')(function* (
    next: ResolvedTarget | null,
    revision: number,
  ) {
    const previous = displayedTarget
    if (previous && next && previous.tabId === next.tabId && previous.windowId === next.windowId) return

    if (previous && next && previous.windowId === next.windowId) {
      yield* updateWindowSelection(previous, next, revision)
      return
    }

    if (previous) {
      const released = yield* updateWindowSelection(previous, null, revision)
      if (!released || !requestIsCurrent(revision)) return
    }

    if (next) yield* updateWindowSelection(null, next, revision)
  })

  const reconcileNativeTabHighlight = Effect.fn('nativeTabHighlight.reconcile')(function* (
    tabId: number | null,
    revision: number,
  ) {
    if (tabId === null) {
      yield* transitionTo(null, revision)
      return
    }

    const resolution: TargetResolution = yield* resolveTarget(tabId, revision)
    if (resolution.status === 'stale') return
    yield* transitionTo(resolution.status === 'ready' ? resolution.target : null, revision)
  })

  const runNativeTabHighlightRequests = Effect.fn('nativeTabHighlight.runRequests')(function* () {
    while (true) {
      const revision = requestRevision
      const tabId = desiredTabId
      yield* reconcileNativeTabHighlight(tabId, revision).pipe(
        // Hover feedback is best-effort. URL preview and all tab actions remain
        // usable when Chrome rejects a transient selection read or mutation.
        Effect.catchTag('NativeTabHighlightBrowserError', () => Effect.void),
      )
      if (requestIsCurrent(revision)) {
        runner = null
        return
      }
    }
  })

  function setTarget(tabId: number | null | undefined): Promise<void> {
    const nextTabId = normalizedTabId(tabId)
    const alreadyDisplayed = nextTabId === null
      ? displayedTarget === null
      : displayedTarget?.tabId === nextTabId

    if (desiredTabId === nextTabId && runner) return runner
    if (desiredTabId === nextTabId && alreadyDisplayed) return Promise.resolve()

    desiredTabId = nextTabId
    requestRevision += 1
    if (runner) return runner
    // Publish the flight before starting it: clearing an unowned selection can
    // finish synchronously, including resetting runner inside the Effect.
    runner = Promise.resolve().then(() => getAppRuntime().runPromise(runNativeTabHighlightRequests()))
    return runner
  }

  return {
    clear() {
      return setTarget(null)
    },
    setTarget,
  }
}
