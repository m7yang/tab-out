/* ================================================================
   Chrome tabs — fetch / close / focus / snapshot

   `openTabs` is the module-private in-memory cache of all open
   tabs, refreshed by fetchOpenTabsSnapshot() and kept for title
   retention across suspensions, reloads, and startup seeding.
   Consumers receive tab snapshots as explicit inputs instead of
   reading this cache.
   ================================================================ */

import { Effect } from 'effect'

import { omitUndefined } from '../lib/omit-undefined.js'
import { getAppRuntime } from './app-runtime.js'
import { getTab } from './browser-tabs-gateway.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { normalizeChromeTabToDashboardItem } from './dashboard-tab-normalization.js'
import { isSuspended, rememberSuspendTargetFromTabsEffect, unwrapSuspenderUrl } from './suspension.js'
import { compareForKeep, isGroupedTab, fetchTabGroupColorsEffect } from './groups.js'
import { pickDuplicateTabsToClose } from './tab-dedupe-policy.js'
import { canonicalDedupeKey } from './url-canonical.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import { focusExactTabTargetEffect, focusTabTargetEffect } from './tab-focus.js'
import { isBrowserInternalUrl } from './browser-url-policy.js'
import { liveTabByValidatedId, liveTabUrlForIdentity } from './live-tab-matching.js'
import type { DashboardTab, DashboardTabMutationTarget, TabSnapshot } from './types'

type SnapshotTab = Pick<chrome.tabs.Tab, 'url' | 'pendingUrl' | 'title' | 'pinned' | 'groupId' | 'windowId' | 'index'>
type SnapshotOptions = {
  includeTabOutUrls?: boolean
}
type ResolvedCloseOptions = SnapshotOptions & {
  isSingleRemoveStillEligible?: (tab: chrome.tabs.Tab) => boolean | Promise<boolean>
}
type CloseOptions = {
  preserveGroups?: boolean
  preservePinnedTabOut?: boolean
}
type TargetCloseOptions = CloseOptions & {
  allowedWindowIds?: ReadonlySet<number>
  requireSuspended?: boolean
}
type DedupeOptions = {
  currentWindowId?: number
  preservePinned?: boolean
  preservePinnedTabOut?: boolean
}
export type ChromeOpenTabsSnapshot = {
  tabs: chrome.tabs.Tab[]
  windows: chrome.windows.Window[]
}
type TabCloseMutationStatus = 'complete' | 'partial' | 'failed' | 'unknown'
export type TabCloseResult = {
  ok: boolean
  status: TabCloseMutationStatus
  value: TabSnapshot[]
  attemptedCount: number
  removedCount: number
  failedCount: number
}

let openTabs: DashboardTab[] = []
let seededOpenTabsTitleHistory: DashboardTab[] = []

function tabIds(tabs: chrome.tabs.Tab[]): number[] {
  return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number')
}

/**
 * snapshotChromeTabs(chromeTabs) — captures enough info per tab to
 * recreate it later via chrome.tabs.create() (used by undo). `url` is
 * the effective URL used by the dashboard for matching; `rawUrl` is
 * Chrome's actual tab URL, which lets undo preserve suspended tabs.
 * Skips chrome:// and chrome-extension:// URLs by default since those
 * aren't worth recreating, except for Tab Out's new-tab URLs when the
 * caller explicitly opts in.
 *
 * @param {Array<{ url?: string, pendingUrl?: string, title?: string, pinned?: boolean, groupId?: number, windowId: number, index?: number }>} chromeTabs
 * @param {{ includeTabOutUrls?: boolean }} [opts]
 * @returns {TabSnapshot[]}
 */
export function snapshotChromeTabs(chromeTabs: SnapshotTab[], opts: SnapshotOptions = {}): TabSnapshot[] {
  const { includeTabOutUrls = false } = opts
  return chromeTabs
    .map((t) => {
      const rawUrl = liveTabUrlForIdentity(t)
      return {
        url: unwrapSuspenderUrl(rawUrl),
        rawUrl,
        title: t.title || '',
        pinned: !!t.pinned,
        groupId: typeof t.groupId === 'number' ? t.groupId : -1,
        windowId: t.windowId,
        ...(typeof t.index === 'number' ? { index: t.index } : {}),
      }
    })
    .filter((s) => {
      if (!s.url) return false
      if (s.url.startsWith('chrome://')) return includeTabOutUrls && s.url === 'chrome://newtab/'
      if (!s.url.startsWith('chrome-extension://')) return true
      return includeTabOutUrls && isTabOutPageUrl(s.url)
    })
}

const fetchChromeOpenTabsSnapshotEffect = Effect.fn('tabs.fetchChromeSnapshot')(function* () {
  const browserTabs = yield* BrowserTabs
  const [tabsResult, windowsResult] = yield* Effect.all([
    browserTabs.queryAllTabsResult(),
    browserTabs.getAllWindowsResult(),
    fetchTabGroupColorsEffect(),
  ], { concurrency: 'unbounded' })
  return {
    ok: tabsResult.ok && windowsResult.ok,
    snapshot: { tabs: tabsResult.value, windows: windowsResult.value },
  }
})

export function normalizeChromeOpenTabs({ tabs, windows }: ChromeOpenTabsSnapshot, previousTabs: readonly DashboardTab[] = []): DashboardTab[] {
  const windowTypeById = new Map(windows.filter((w) => typeof w.id === 'number').map((w) => [w.id, w.type]))
  const previousTabById = new Map(
    previousTabs
      .filter((tab): tab is DashboardTab & { id: number } => typeof tab.id === 'number')
      .map((tab) => [tab.id, tab] as const),
  )
  const runtimeId = globalThis.chrome?.runtime?.id ?? null
  return tabs.map((tab) => {
    const previousTab = typeof tab.id === 'number' ? previousTabById.get(tab.id) : undefined
    const windowType = windowTypeById.get(tab.windowId)
    return normalizeChromeTabToDashboardItem(tab, omitUndefined({
      previousTab,
      runtimeId,
      windowType,
    }))
  })
}

function replaceOpenTabs(nextOpenTabs: DashboardTab[]): void {
  openTabs = nextOpenTabs
}

export function seedOpenTabsTitleHistory(tabs: readonly DashboardTab[]): void {
  if (openTabs.length > 0 || seededOpenTabsTitleHistory.length > 0) return
  seededOpenTabsTitleHistory = tabs.filter((tab) => typeof tab.id === 'number')
}

export const fetchOpenTabsSnapshotEffect = Effect.fn('tabs.fetchOpenSnapshot')(function* (
  capturedBrowserSnapshot: ChromeOpenTabsSnapshot | null = null,
) {
  const fallbackTabs = openTabs.length > 0 ? openTabs : seededOpenTabsTitleHistory
  return yield* Effect.gen(function* () {
    let result: { ok: boolean, snapshot: ChromeOpenTabsSnapshot }
    if (capturedBrowserSnapshot) {
      yield* fetchTabGroupColorsEffect()
      result = { ok: true, snapshot: capturedBrowserSnapshot }
    } else {
      result = yield* fetchChromeOpenTabsSnapshotEffect()
    }
    if (!result.ok) return { ok: false, tabs: fallbackTabs }
    const previousTabs = openTabs.length > 0 ? openTabs : seededOpenTabsTitleHistory
    const nextOpenTabs = normalizeChromeOpenTabs(result.snapshot, previousTabs)
    seededOpenTabsTitleHistory = []
    replaceOpenTabs(nextOpenTabs)
    yield* rememberSuspendTargetFromTabsEffect(nextOpenTabs)
    return { ok: true, tabs: nextOpenTabs }
  }).pipe(
    Effect.catchDefect(() => Effect.succeed({ ok: false, tabs: fallbackTabs })),
  )
})

export function fetchOpenTabsSnapshot(): Promise<DashboardTab[]> {
  return getAppRuntime().runPromise(fetchOpenTabsSnapshotEffect().pipe(
    Effect.map((result) => result.tabs),
  ))
}

export function getDashboardTabsFromOpenTabs(tabs: readonly DashboardTab[]): DashboardTab[] {
  return tabs.filter((tab) => {
    if (tab.isTabOut) return true
    return !isBrowserInternalUrl(tab.url)
  })
}

function emptyTabCloseResult(status: 'complete' | 'unknown'): TabCloseResult {
  return {
    ok: status === 'complete',
    status,
    value: [],
    attemptedCount: 0,
    removedCount: 0,
    failedCount: 0,
  }
}

/**
 * Close an already-resolved physical-tab set and report the exact accepted and
 * rejected writes. `value` contains Undo snapshots for confirmed removals.
 */
export const closeResolvedTabsEffect = Effect.fn('tabs.closeResolved')(function* (
  tabs: readonly chrome.tabs.Tab[],
  {
    includeTabOutUrls = false,
    isSingleRemoveStillEligible,
  }: ResolvedCloseOptions = {},
) {
  const seenIds = new Set<number>()
  const attemptedTabs = tabs.filter((tab) => {
    if (typeof tab.id !== 'number' || seenIds.has(tab.id)) return false
    seenIds.add(tab.id)
    return true
  })
  if (attemptedTabs.length === 0) return emptyTabCloseResult('complete')

  const attemptedTabsById = new Map(
    attemptedTabs.flatMap((tab) => typeof tab.id === 'number' ? [[tab.id, tab] as const] : []),
  )
  const browserTabs = yield* BrowserTabs
  const removedIds = new Set(yield* browserTabs.removeTabs(tabIds(attemptedTabs), {
    // Every close has its own acknowledgement. Revalidate the original physical
    // page before each write, including the first, so delayed removals cannot
    // close a tab that has navigated or gained a protection in the meantime.
    beforeSingleRemove: async (tabId) => {
      const expectedTab = attemptedTabsById.get(tabId)
      const liveTab = await getTab(tabId)
      if (!expectedTab || !liveTab) return false
      const validatedTab = liveTabByValidatedId([liveTab], {
        tabId,
        url: liveTabUrlForIdentity(expectedTab),
      })
      if (!validatedTab) return false
      return isSingleRemoveStillEligible
        ? isSingleRemoveStillEligible(validatedTab)
        : true
    },
  }))
  const removedTabs = attemptedTabs.filter((tab) => typeof tab.id === 'number' && removedIds.has(tab.id))
  const removedCount = removedTabs.length
  const failedCount = attemptedTabs.length - removedCount
  const status: TabCloseMutationStatus = failedCount === 0
    ? 'complete'
    : removedCount === 0 ? 'failed' : 'partial'

  return {
    ok: status === 'complete',
    status,
    value: snapshotChromeTabs(removedTabs, { includeTabOutUrls }),
    attemptedCount: attemptedTabs.length,
    removedCount,
    failedCount,
  }
})

/**
 * closeTabsExactResult(urls, opts) — closes tabs by exact URL match.
 * Used for filter-narrowed bulk close paths so we don't accidentally
 * close unrelated tabs from the same hostname.
 *
 * @param {string[]} urls
 * Pinned Tab Out/new-tab pages are preserved by default. Their URL is shared
 * with ordinary Tab Out copies, so URL-scoped bulk actions must apply that
 * physical-tab policy again after reading the live tabs.
 *
 * @param {{ preserveGroups?: boolean, preservePinnedTabOut?: boolean }} [opts]
 * @returns {Promise<TabCloseResult>} confirmed snapshots plus mutation status
 * and attempted, removed, and failed counts
 */
export const closeTabsExactEffect = Effect.fn('tabs.closeExact')(function* (
  urls: string[],
  opts: CloseOptions = {},
) {
  if (!urls || urls.length === 0) return emptyTabCloseResult('complete')
  const { preserveGroups = false, preservePinnedTabOut = true } = opts
  const urlSet = new Set(urls)
  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return emptyTabCloseResult('unknown')
  const allTabs = allTabsResult.value
  const targetRemainsEligible = (tab: chrome.tabs.Tab) => {
    const effectiveUrl = unwrapSuspenderUrl(liveTabUrlForIdentity(tab))
    if (!urlSet.has(effectiveUrl)) return false
    if (preserveGroups && isGroupedTab(tab)) return false
    return !(preservePinnedTabOut && tab.pinned && isTabOutPageUrl(effectiveUrl))
  }
  const toCloseTabs = allTabs.filter(targetRemainsEligible)
  return yield* closeResolvedTabsEffect(toCloseTabs, {
    includeTabOutUrls: true,
    isSingleRemoveStillEligible: targetRemainsEligible,
  })
})

export function closeTabsExactResult(
  urls: string[],
  opts: CloseOptions = {},
): Promise<TabCloseResult> {
  return getAppRuntime().runPromise(closeTabsExactEffect(urls, opts))
}

/**
 * Close an exact render-derived set. The URL guard prevents a stale tab id
 * (including one revived from a startup snapshot after an id reuse) from
 * closing a page that no longer matches the action the user selected. Callers
 * can additionally require that each matching live tab is still suspended.
 * Returns confirmed snapshots plus mutation status and attempted/removed/failed
 * counts.
 */
export const closeTabsByTargetsEffect = Effect.fn('tabs.closeByTargets')(function* (
  targets: readonly DashboardTabMutationTarget[],
  opts: TargetCloseOptions = {},
) {
  if (targets.length === 0) return emptyTabCloseResult('complete')
  const {
    allowedWindowIds,
    preserveGroups = false,
    preservePinnedTabOut = true,
    requireSuspended = false,
  } = opts
  const expectedUrlById = new Map(targets.map((target) => [target.tabId, target.tabUrl]))
  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return emptyTabCloseResult('unknown')
  const allTabs = allTabsResult.value
  const targetRemainsEligible = (tab: chrome.tabs.Tab) => {
    if (typeof tab.id !== 'number') return false
    if (allowedWindowIds && !allowedWindowIds.has(tab.windowId)) return false
    const expectedUrl = expectedUrlById.get(tab.id)
    if (!expectedUrl) return false
    const rawUrl = liveTabUrlForIdentity(tab)
    const effectiveUrl = unwrapSuspenderUrl(rawUrl)
    if (effectiveUrl !== expectedUrl) return false
    if (requireSuspended && !isSuspended(rawUrl, effectiveUrl)) return false
    if (preserveGroups && isGroupedTab(tab)) return false
    return !(preservePinnedTabOut && tab.pinned && isTabOutPageUrl(effectiveUrl))
  }
  const toCloseTabs = allTabs.filter(targetRemainsEligible)
  return yield* closeResolvedTabsEffect(toCloseTabs, {
    includeTabOutUrls: true,
    isSingleRemoveStillEligible: targetRemainsEligible,
  })
})

export function closeTabsByTargetsResult(
  targets: readonly DashboardTabMutationTarget[],
  opts: TargetCloseOptions = {},
): Promise<TabCloseResult> {
  return getAppRuntime().runPromise(closeTabsByTargetsEffect(targets, opts))
}

/**
 * focusTab(url) — switch Chrome to the tab matching `url` (exact first,
 * hostname fallback) and focus its window.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function focusTab(url: string): Promise<boolean> {
  return getAppRuntime().runPromise(focusTabTargetEffect(url))
}

export type ExactTabFocusOrOpenResult =
  | { status: 'focused' | 'activated' | 'failed' | 'unknown' }
  | { status: 'opened' | 'open-failed' }

function exactTabFocusOrOpenResult(
  status: ExactTabFocusOrOpenResult['status'],
): ExactTabFocusOrOpenResult {
  return { status }
}

/** Open only when a successful browser read proves no matching tab exists. */
const focusExactTabOrOpenEffect = Effect.fn('tabs.focusExactOrOpen')(function* (url: string) {
  const result = yield* focusExactTabTargetEffect(url)
  if (result.status === 'not-found') {
    return exactTabFocusOrOpenResult(
      (yield* openTabUrlEffect(url)) ? 'opened' : 'open-failed',
    )
  }
  return exactTabFocusOrOpenResult(result.status)
})

export function focusExactTabOrOpenResult(url: string): Promise<ExactTabFocusOrOpenResult> {
  return getAppRuntime().runPromise(focusExactTabOrOpenEffect(url))
}

/**
 * openTabUrl(url, opts) — open a URL in a new tab in the current window.
 * Defaults to an active (foreground) tab; pass { active: false } to open it
 * in the background and keep the current tab focused.
 *
 * @param {string} url
 * @param {{ active?: boolean }} [opts]
 * @returns {Promise<boolean>} whether Chrome created the tab
 */
export const openTabUrlEffect = Effect.fn('tabs.openUrl')(function* (
  url: string,
  opts: { active?: boolean } = {},
) {
  if (!url) return false
  const { active = true } = opts
  const browserTabs = yield* BrowserTabs
  return !!(yield* browserTabs.createTab({ url, active }))
})

export function openTabUrl(url: string, opts: { active?: boolean } = {}): Promise<boolean> {
  return getAppRuntime().runPromise(openTabUrlEffect(url, opts))
}

/**
 * openTabUrlInNewWindow(url) — open a URL in a new focused Chrome window.
 *
 * @param {string} url
 * @returns {Promise<boolean>} whether Chrome created the window
 */
export const openTabUrlInNewWindowEffect = Effect.fn('tabs.openUrlInNewWindow')(function* (url: string) {
  if (!url) return false
  const browserTabs = yield* BrowserTabs
  return !!(yield* browserTabs.createWindow({ url, focused: true, type: 'normal' }))
})

export function openTabUrlInNewWindow(url: string): Promise<boolean> {
  return getAppRuntime().runPromise(openTabUrlInNewWindowEffect(url))
}

/**
 * closeDuplicateTabsResult(urls, keepOne) — closes duplicate tabs of each
 * URL according to the dedup policy (mirrors renderDomainCard's button
 * count math):
 *   • Mixed grouped + ungrouped → close every ungrouped (grouped is the keep).
 *   • All ungrouped (≥2)        → keep one ungrouped, close the rest.
 *   • All grouped, single group → keep one, close the rest within that group.
 *   • All grouped, multi groups → skip (would empty a slot in each group).
 * Returns confirmed Undo snapshots plus mutation status and
 * attempted/removed/failed counts.
 *
 * @param {string[]} urls
 * @param {boolean} [keepOne=true]
 * @param {{ currentWindowId?: number, preservePinned?: boolean, preservePinnedTabOut?: boolean }} [opts]
 * @returns {Promise<TabCloseResult>}
 */
export const closeDuplicateTabsEffect = Effect.fn('tabs.closeDuplicates')(function* (
  urls: string[],
  keepOne = true,
  opts: DedupeOptions = {},
) {
  const requestedUrls = [...new Set(urls.map(canonicalDedupeKey).filter(Boolean))]
  if (requestedUrls.length === 0) return emptyTabCloseResult('complete')
  const { preservePinned = false, preservePinnedTabOut = false } = opts
  const suppliedCurrentWindowId = opts.currentWindowId
  const hasSuppliedCurrentWindow =
    typeof suppliedCurrentWindowId === 'number' &&
    Number.isInteger(suppliedCurrentWindowId) &&
    suppliedCurrentWindowId >= 0
  let currentWindowId = hasSuppliedCurrentWindow
    ? suppliedCurrentWindowId
    : -1
  let currentWindowKnown = currentWindowId >= 0
  const browserTabs = yield* BrowserTabs
  if (!currentWindowKnown) {
    const currentWindowResult = yield* browserTabs.getCurrentWindowResult()
    currentWindowId = currentWindowResult.value?.id ?? -1
    currentWindowKnown = currentWindowResult.ok && currentWindowId >= 0
  }
  if (!currentWindowKnown && requestedUrls.some((url) => isTabOutPageUrl(url))) {
    return emptyTabCloseResult('unknown')
  }
  // Keep the live-tab inventory as the final awaited read before selecting
  // removals. A slow current-window lookup must not leave a stale URL snapshot
  // that can close a tab which started navigating in the meantime.
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return emptyTabCloseResult('unknown')
  const allTabs = allTabsResult.value
  const requestedUrlSet = new Set(requestedUrls)
  const tabsByDedupeKey = new Map<string, chrome.tabs.Tab[]>()
  for (const tab of allTabs) {
    const key = canonicalDedupeKey(unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))
    if (!requestedUrlSet.has(key)) continue
    tabsByDedupeKey.getOrInsertComputed(key, () => []).push(tab)
  }
  const toCloseTabs: chrome.tabs.Tab[] = []
  const closeGuardByTabId = new Map<number, {
    key: string
    survivorId: number | undefined
    stopped: boolean
  }>()

  for (const url of requestedUrls) {
    const matching = tabsByDedupeKey.get(url) ?? []
    const closeTargets = pickDuplicateTabsToClose(matching, {
      keepOne,
      currentWindowId,
      preservePinned,
      preservePinnedTabOut,
      isTabOutUrl: isTabOutPageUrl,
    })
    if (closeTargets.length === 0) continue
    const closeIds = new Set(tabIds(closeTargets))
    const groupedTarget = closeTargets.find(isGroupedTab)
    const survivor = matching
      .filter((tab) => typeof tab.id === 'number' && !closeIds.has(tab.id) &&
        (!groupedTarget || tab.groupId === groupedTarget.groupId))
      .toSorted((a, b) => compareForKeep(a, b, currentWindowId))[0]
    const guard = { key: url, survivorId: survivor?.id, stopped: false }
    for (const tabId of closeIds) closeGuardByTabId.set(tabId, guard)
    toCloseTabs.push(...closeTargets)
  }

  return yield* closeResolvedTabsEffect(toCloseTabs, {
    includeTabOutUrls: true,
    isSingleRemoveStillEligible: async (tab) => {
      if (typeof tab.id !== 'number') return false
      const guard = closeGuardByTabId.get(tab.id)
      if (!guard || guard.stopped) return false
      const survivor = typeof guard.survivorId === 'number'
        ? await getTab(guard.survivorId)
        : null
      if ((keepOne || typeof guard.survivorId === 'number') && (
        !survivor || canonicalDedupeKey(unwrapSuspenderUrl(liveTabUrlForIdentity(survivor))) !== guard.key
      )) {
        guard.stopped = true
        return false
      }
      // The survivor read awaited Chrome. Read the target again before applying
      // its current protections and closing it; never select a replacement keep.
      const liveTab = await getTab(tab.id)
      const validatedTab = liveTab && liveTabByValidatedId([liveTab], {
        tabId: tab.id,
        url: liveTabUrlForIdentity(tab),
      })
      if (!validatedTab) return false
      const isTabOut = isTabOutPageUrl(unwrapSuspenderUrl(liveTabUrlForIdentity(validatedTab)))
      if (validatedTab.pinned && (preservePinned || (preservePinnedTabOut && isTabOut))) return false
      if (preservePinnedTabOut && isTabOut && validatedTab.active && validatedTab.windowId === currentWindowId) return false
      return !isGroupedTab(validatedTab) || (!keepOne && !survivor) || (
        !!survivor && isGroupedTab(survivor) && survivor.groupId === validatedTab.groupId
      )
    },
  })
})

export function closeDuplicateTabsResult(
  urls: string[],
  keepOne = true,
  opts: DedupeOptions = {},
): Promise<TabCloseResult> {
  return getAppRuntime().runPromise(closeDuplicateTabsEffect(urls, keepOne, opts))
}
