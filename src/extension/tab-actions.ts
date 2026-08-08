import { Effect, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { requestDashboardRefresh, settleDashboardRefresh } from './dashboard-intake.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { isGroupedTab } from './groups.js'
import { liveTabMatchesIdentity, liveTabsMatchingTarget, liveTabUrlForIdentity } from './live-tab-matching.js'
import { buildSuspendUrl, getSuspendTargetEffect, isSuspended, unwrapSuspenderUrl, type SuspendTarget } from './suspension.js'
import {
  closeDuplicateTabsEffect,
  closeResolvedTabsEffect,
  closeTabsByTargetsEffect,
  closeTabsExactEffect,
  type TabCloseResult
} from './tabs.js'
import { showToast } from './toast.js'
import { tabMatchesSourceFilter } from './filter-match.js'
import { markClosure } from './undo.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import type { DashboardChipEnv, DashboardTab, DashboardTabMutationTarget, DomainGroup, TabSnapshot } from './types'

type TabActionResult = Omit<TabCloseResult, 'value'> & {
  snapshot: TabSnapshot[]
}

type ChipCloseResult = TabActionResult & {
  shouldAnimateRemoval: boolean
}

type HistoryDeleteResult = {
  ok: boolean
  deletedCount: number
}

type SuspendTabsResult = {
  ok: boolean
  suspendedCount: number
}

type CloseDomainTabsOptions = {
  group: DomainGroup
  filter: string
  displayName: string
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}

type SuspendDomainTabsOptions = {
  group: DomainGroup
  filter: string
}

type CloseExactTabSectionOptions = {
  urls: string[]
}

type ExactTabTargetsOptions = {
  targets: DashboardTabMutationTarget[]
}

type DedupeTabsOptions = {
  urls: string[]
  preservePinnedTabOut?: boolean
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}

type CloseChipTargetOptions = {
  tabUrl: string
  tabId?: number | string
  expectedPinned?: boolean
  expectedGroupId?: number
  envs?: DashboardChipEnv[] | null
  onAfterClose?: (result: ChipCloseResult) => void | Promise<void>
}

type DeleteHistoryUrlsOptions = {
  urls: string[]
  onAfterDelete?: (result: HistoryDeleteResult) => void | Promise<void>
}

type ChromeMenuTabTarget = {
  tabUrl: string
  tabId?: number | string
  rawUrl?: string
}

type ChromeMenuTabResolution =
  | { status: 'matched'; tab: chrome.tabs.Tab }
  | { status: 'not-found'; tab: null }
  | { status: 'unknown'; tab: null }

type ChromeMenuActionResult = boolean | 'unknown'

const CHROME_MENU_TAB_NOT_FOUND: ChromeMenuTabResolution = {
  status: 'not-found',
  tab: null
}
const CHROME_MENU_TAB_UNKNOWN: ChromeMenuTabResolution = {
  status: 'unknown',
  tab: null
}

function matchedChromeMenuTab(tab: chrome.tabs.Tab): ChromeMenuTabResolution {
  return { status: 'matched', tab }
}

function unknownChipCloseResult(): ChipCloseResult {
  return {
    ok: false,
    status: 'unknown',
    snapshot: [],
    attemptedCount: 0,
    removedCount: 0,
    failedCount: 0,
    shouldAnimateRemoval: false
  }
}

class TabActionWorkflowError extends Schema.TaggedErrorClass<TabActionWorkflowError>()(
  'TabActionWorkflowError',
  { cause: Schema.Defect() }
) {}

function runTabAction<Value>(
  workflow: Effect.Effect<Value, TabActionWorkflowError, BrowserTabs>
): Promise<Value> {
  return getAppRuntime().runPromise(workflow.pipe(
    Effect.catchTag('TabActionWorkflowError', (error) => Effect.fail(error.cause))
  ))
}

function runOptionalCallback(
  callback: (() => void | Promise<void>) | undefined
): Effect.Effect<void, TabActionWorkflowError> {
  if (!callback) return Effect.void
  return Effect.tryPromise({
    try: async () => callback(),
    catch: (cause) => TabActionWorkflowError.make({ cause })
  })
}

function closedTabsLabel(count: number): string {
  return `Closed ${count} tab${count !== 1 ? 's' : ''}`
}

function closedDuplicatesLabel(count: number): string {
  return `Closed ${count} duplicate${count !== 1 ? 's' : ''}`
}

export function tabCloseProgressLabel(
  removedCount: number,
  attemptedCount: number,
  kind: 'tabs' | 'duplicates' = 'tabs'
): string {
  const singular = kind === 'duplicates' ? 'duplicate' : 'tab'
  const plural = kind
  if (removedCount === 0) {
    return attemptedCount === 1 ? `Could not close ${singular}` : `Could not close ${attemptedCount} ${plural}`
  }
  if (removedCount < attemptedCount) return `Closed ${removedCount} of ${attemptedCount} ${plural}`
  return kind === 'duplicates' ? closedDuplicatesLabel(removedCount) : closedTabsLabel(removedCount)
}

function showOpenTabsReadError(): void {
  showToast('Could not read open tabs')
}

export function historyDeleteToastMessage(deletedCount: number, requestedCount: number): string {
  if (deletedCount === 0) return 'Could not delete history'
  if (deletedCount < requestedCount) return `Deleted ${deletedCount} of ${requestedCount} history items`
  return deletedCount === 1 ? 'History deleted' : `Deleted ${deletedCount} history items`
}

export function historyEntryMuteFailureToastMessage(muted: boolean): string {
  return muted ? 'Could not mute tab' : 'Could not unmute tab'
}

function refreshDashboardAfterTabAction(): void {
  void settleDashboardRefresh(requestDashboardRefresh({ animateCards: true }))
}

function tabActionResult(closeResult: TabCloseResult): TabActionResult {
  const { value, ...metadata } = closeResult
  return { ...metadata, snapshot: value }
}

function emptyTabActionResult(): TabActionResult {
  return {
    ok: true,
    status: 'complete',
    snapshot: [],
    attemptedCount: 0,
    removedCount: 0,
    failedCount: 0
  }
}

const finishTabCloseAction = Effect.fn('tabActions.finishClose')(function*({
  closeResult,
  kind = 'tabs',
  nothingMessage,
  labelSuffix = '',
  onAfterClose
}: {
  closeResult: TabCloseResult
  kind?: 'tabs' | 'duplicates'
  nothingMessage: string
  labelSuffix?: string
  onAfterClose?: (result: TabActionResult) => void | Promise<void>
}) {
  const result = tabActionResult(closeResult)
  if (closeResult.status === 'unknown') {
    showOpenTabsReadError()
    return result
  }

  if (closeResult.attemptedCount === 0) {
    showToast(nothingMessage)
    yield* runOptionalCallback(onAfterClose ? () => onAfterClose(result) : undefined)
    return result
  }

  const label = `${tabCloseProgressLabel(closeResult.removedCount, closeResult.attemptedCount, kind)}${labelSuffix}`
  if (closeResult.removedCount === 0) {
    showToast(label)
    yield* runOptionalCallback(onAfterClose ? () => onAfterClose(result) : undefined)
    return result
  }

  if (result.snapshot.length > 0) markClosedTabs(result.snapshot, label)
  else showToast(label)
  yield* runOptionalCallback(onAfterClose ? () => onAfterClose(result) : undefined)
  return result
})

function markClosedTabs(snapshot: TabSnapshot[], label: string): void {
  if (snapshot.length === 0) return
  markClosure(snapshot, label)
}

const runCloseFilteredTabs = Effect.fn('tabActions.closeFiltered')(function*(
  targets: DashboardTabMutationTarget[]
) {
  if (targets.length === 0) {
    showToast('Nothing to close')
    return emptyTabActionResult()
  }

  const closeResult = yield* closeTabsByTargetsEffect(targets, { preserveGroups: true })
  return yield* finishTabCloseAction({ closeResult, nothingMessage: 'Nothing to close' })
})

export function closeFilteredTabs(targets: DashboardTabMutationTarget[]): Promise<TabActionResult> {
  return runTabAction(runCloseFilteredTabs(targets))
}

const runCloseDomainTabs = Effect.fn('tabActions.closeDomain')(function*({
  group,
  filter,
  displayName,
  onAfterClose
}: CloseDomainTabsOptions) {
  const scopedTabs = domainMutationTabs({ group, filter })
  const closeResult = yield* closeTabsByTargetsEffect(
    tabMutationTargets(scopedTabs),
    { preserveGroups: true }
  )
  return yield* finishTabCloseAction({
    closeResult,
    nothingMessage: 'Nothing to close',
    labelSuffix: ` from ${displayName}`,
    ...(onAfterClose ? { onAfterClose } : {})
  })
})

export function closeDomainTabs(options: CloseDomainTabsOptions): Promise<TabActionResult> {
  return runTabAction(runCloseDomainTabs(options))
}

function tabMutationTargets(tabs: readonly DashboardTab[]): DashboardTabMutationTarget[] {
  return tabs.flatMap((tab) => typeof tab.id === 'number'
    ? [{ tabId: tab.id, tabUrl: tab.url }]
    : [])
}

function domainMutationTabs({ group, filter }: SuspendDomainTabsOptions): DashboardTab[] {
  const isTabOutGroup = group.domain === '__tab-out__'
  const scopedTabs = filter ? group.tabs.filter((tab) => tabMatchesSourceFilter(tab, filter)) : group.tabs
  return scopedTabs
    .filter((tab) => !isClosedSavedDashboardTab(tab))
    .filter((tab) => !isGroupedTab(tab) && !(isTabOutGroup && tab.pinned))
}

function domainSuspendTargets(options: SuspendDomainTabsOptions): DashboardTabMutationTarget[] {
  return tabMutationTargets(domainMutationTabs(options).filter((tab) => !tab.suspended))
}

export function suspendDomainTabs(options: SuspendDomainTabsOptions): Promise<SuspendTabsResult> {
  return runTabAction(suspendMutationTargetsEffect(domainSuspendTargets(options)))
}

const runCloseSuspendedDomainTabs = Effect.fn('tabActions.closeSuspendedDomain')(function*({
  group,
  filter,
  displayName,
  onAfterClose
}: CloseDomainTabsOptions) {
  const targets = tabMutationTargets(domainMutationTabs({ group, filter }).filter((tab) => tab.suspended))
  const closeResult = yield* closeTabsByTargetsEffect(targets, {
    preserveGroups: true,
    requireSuspended: true
  })
  return yield* finishTabCloseAction({
    closeResult,
    nothingMessage: 'Nothing suspended to close',
    labelSuffix: ` from ${displayName}`,
    ...(onAfterClose ? { onAfterClose } : {})
  })
})

export function closeSuspendedDomainTabs(
  options: CloseDomainTabsOptions
): Promise<TabActionResult> {
  return runTabAction(runCloseSuspendedDomainTabs(options))
}

const suspendMutationTargetsEffect = Effect.fn('tabActions.suspendMutationTargets')(function*(
  targets: readonly DashboardTabMutationTarget[]
) {
  if (targets.length === 0) {
    showToast('Nothing to suspend')
    return { ok: true, suspendedCount: 0 }
  }

  const target = yield* getSuspendTargetEffect()
  if (!target) {
    showToast('No suspender detected')
    return { ok: true, suspendedCount: 0 }
  }

  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return { ok: false, suspendedCount: 0 }
  }
  const liveTargets = liveTabsForMutationTargets(allTabsResult.value, targets)
    .filter((tab) => !isGroupedTab(tab))
    .filter((tab) => !(tab.pinned && isTabOutPageUrl(unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))))
  const updateResult = yield* applySuspendToTabsEffect(liveTargets, target)
  const ok = yield* finishSuspendUpdatesEffect(updateResult)
  return { ok, suspendedCount: updateResult.updatedCount }
})

const runCloseExactTabSection = Effect.fn('tabActions.closeExactSection')(function*(
  { urls }: CloseExactTabSectionOptions
) {
  const closeResult = yield* closeTabsExactEffect(urls, { preserveGroups: true })
  return yield* finishTabCloseAction({ closeResult, nothingMessage: 'Nothing to close' })
})

export function closeExactTabSection(options: CloseExactTabSectionOptions): Promise<TabActionResult> {
  return runTabAction(runCloseExactTabSection(options))
}

const runCloseExactTabTargets = Effect.fn('tabActions.closeExactTargets')(function*(
  { targets }: ExactTabTargetsOptions
) {
  const closeResult = yield* closeTabsByTargetsEffect(targets, { preserveGroups: true })
  return yield* finishTabCloseAction({ closeResult, nothingMessage: 'Nothing to close' })
})

export function closeExactTabTargets(options: ExactTabTargetsOptions): Promise<TabActionResult> {
  return runTabAction(runCloseExactTabTargets(options))
}

const runDedupeTabs = Effect.fn('tabActions.dedupe')(function*({
  urls,
  preservePinnedTabOut = false,
  onAfterClose
}: DedupeTabsOptions) {
  if (urls.length === 0) return emptyTabActionResult()

  const closeResult = yield* closeDuplicateTabsEffect(urls, true, { preservePinnedTabOut })
  return yield* finishTabCloseAction({
    closeResult,
    kind: 'duplicates',
    nothingMessage: 'Nothing to dedupe',
    ...(onAfterClose ? { onAfterClose } : {})
  })
})

export function dedupeTabs(options: DedupeTabsOptions): Promise<TabActionResult> {
  return runTabAction(runDedupeTabs(options))
}

const runCloseChipTarget = Effect.fn('tabActions.closeChipTarget')(function*({
  tabUrl,
  tabId,
  expectedPinned,
  expectedGroupId,
  envs = null,
  onAfterClose
}: CloseChipTargetOptions) {
  const isFolded = Array.isArray(envs) && envs.length > 0
  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return unknownChipCloseResult()
  }
  const matches = liveTabsMatchingTarget(allTabsResult.value, { tabUrl, envs })
  const matchCount = matches.length

  let toCloseList: chrome.tabs.Tab[]
  if (isFolded) {
    toCloseList = matches
  } else {
    const exactTab = typeof tabId === 'number'
      ? matches.find((tab) => (
          tab.id === tabId &&
          (expectedPinned === undefined || !!tab.pinned === expectedPinned) &&
          (expectedGroupId === undefined || tab.groupId === expectedGroupId)
        ))
      : null
    // A numeric id represents one physical Chrome tab. If that tab disappeared
    // or Chrome reused the id for a different URL, do not fall through to a
    // same-URL sibling and close a different chip's target.
    toCloseList = typeof tabId === 'number'
      ? exactTab ? [exactTab] : []
      : matches.slice(0, 1)
  }

  const closeResult = yield* closeResolvedTabsEffect(toCloseList, { includeTabOutUrls: true })

  const result = {
    ...tabActionResult(closeResult),
    shouldAnimateRemoval: closeResult.ok && closeResult.removedCount > 0 && (isFolded ? closeResult.removedCount === matchCount : matchCount <= 1)
  }

  if (closeResult.removedCount > 0) {
    const label = isFolded
      ? `${tabCloseProgressLabel(closeResult.removedCount, closeResult.attemptedCount)} across subdomains`
      : 'Tab closed'
    if (result.snapshot.length > 0) markClosure(result.snapshot, label)
    else showToast(label)
  } else if (closeResult.attemptedCount > 0) {
    showToast(tabCloseProgressLabel(0, closeResult.attemptedCount))
  } else {
    showToast('Nothing to close')
  }

  yield* runOptionalCallback(onAfterClose ? () => onAfterClose(result) : undefined)

  return result
})

export function closeChipTarget(options: CloseChipTargetOptions): Promise<ChipCloseResult> {
  return runTabAction(runCloseChipTarget(options))
}

const runDeleteHistoryUrls = Effect.fn('tabActions.deleteHistoryUrls')(function*({
  urls,
  onAfterDelete
}: DeleteHistoryUrlsOptions) {
  if (urls.length === 0) return { ok: true, deletedCount: 0 }

  const { deleteHistorySourceUrl } = yield* Effect.tryPromise({
    try: () => import('./history-source.js'),
    catch: (cause) => TabActionWorkflowError.make({ cause })
  })
  const results = yield* Effect.forEach(
    urls,
    (url) => Effect.tryPromise({
      try: () => deleteHistorySourceUrl(url),
      catch: (cause) => TabActionWorkflowError.make({ cause })
    }),
    { concurrency: 'unbounded' }
  )
  const deletedCount = results.filter(Boolean).length
  const result = { ok: deletedCount === urls.length, deletedCount }

  if (deletedCount === 0) {
    showToast(historyDeleteToastMessage(deletedCount, urls.length))
    return result
  }

  yield* runOptionalCallback(onAfterDelete ? () => onAfterDelete(result) : undefined)
  refreshDashboardAfterTabAction()
  showToast(historyDeleteToastMessage(deletedCount, urls.length))
  return result
})

export function deleteHistoryUrls(options: DeleteHistoryUrlsOptions): Promise<HistoryDeleteResult> {
  return runTabAction(runDeleteHistoryUrls(options))
}

const resolveChromeMenuTabTarget = Effect.fn('tabActions.resolveChromeMenuTarget')(function*(
  { tabUrl, tabId, rawUrl }: ChromeMenuTabTarget
) {
  const browserTabs = yield* BrowserTabs
  if (tabId !== undefined) {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return CHROME_MENU_TAB_NOT_FOUND
    const tab = yield* browserTabs.getTab(tabId)
    return tab && liveTabMatchesIdentity(tab, { tabId, tabUrl, rawUrl })
      ? matchedChromeMenuTab(tab)
      : CHROME_MENU_TAB_NOT_FOUND
  }
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return CHROME_MENU_TAB_UNKNOWN
  const [match] = liveTabsMatchingTarget(allTabsResult.value, { tabUrl })
  return match ? matchedChromeMenuTab(match) : CHROME_MENU_TAB_NOT_FOUND
})

const runReloadTabTarget = Effect.fn('tabActions.reloadTarget')(function*(
  target: ChromeMenuTabTarget
) {
  const resolution: ChromeMenuTabResolution = yield* resolveChromeMenuTabTarget(target)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  const browserTabs = yield* BrowserTabs
  if (typeof tab?.id !== 'number' || !(yield* browserTabs.reloadTab(tab.id))) {
    showToast('Could not reload tab')
    return false
  }

  void settleDashboardRefresh(requestDashboardRefresh())
  showToast('Tab reloaded')
  return true
})

export function reloadTabTarget(target: ChromeMenuTabTarget): Promise<ChromeMenuActionResult> {
  return runTabAction(runReloadTabTarget(target))
}

const runDuplicateTabTarget = Effect.fn('tabActions.duplicateTarget')(function*(
  target: ChromeMenuTabTarget
) {
  const resolution: ChromeMenuTabResolution = yield* resolveChromeMenuTabTarget(target)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  const browserTabs = yield* BrowserTabs
  if (typeof tab?.id !== 'number' || !(yield* browserTabs.duplicateTab(tab.id))) {
    showToast('Could not duplicate tab')
    return false
  }

  void settleDashboardRefresh(requestDashboardRefresh())
  showToast('Tab duplicated')
  return true
})

export function duplicateTabTarget(target: ChromeMenuTabTarget): Promise<ChromeMenuActionResult> {
  return runTabAction(runDuplicateTabTarget(target))
}

type SetChipMutedOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
  muted: boolean
}

type TabUpdateSummary = {
  attemptedCount: number
  updatedCount: number
}

const revalidateMutationTarget = Effect.fn('tabActions.revalidateMutationTarget')(function*(
  snapshot: chrome.tabs.Tab
) {
  if (typeof snapshot.id !== 'number') return null
  const browserTabs = yield* BrowserTabs
  const liveTab = yield* browserTabs.getTab(snapshot.id)
  if (!liveTab || !liveTabMatchesIdentity(liveTab, {
    tabId: snapshot.id,
    rawUrl: liveTabUrlForIdentity(snapshot)
  })) return null
  return liveTab
})

const applyMutedToTabs = Effect.fn('tabActions.applyMutedToTabs')(function*(
  targets: chrome.tabs.Tab[],
  muted: boolean
) {
  let attemptedCount = 0
  let updatedCount = 0
  const browserTabs = yield* BrowserTabs
  for (const snapshot of targets) {
    if (typeof snapshot.id !== 'number') continue
    attemptedCount += 1
    const liveTab = yield* revalidateMutationTarget(snapshot)
    if (typeof liveTab?.id !== 'number') continue
    if (yield* browserTabs.updateTab(liveTab.id, { muted })) updatedCount += 1
  }
  return { attemptedCount, updatedCount }
})

/**
 * setChipTargetMuted — mute/unmute every open tab a chip represents. Mirrors
 * closeChipTarget's URL matching (effective + raw URL, suspended-aware) but
 * acts on ALL matches so a noisy duplicate can't survive a mute.
 */
const runSetChipTargetMuted = Effect.fn('tabActions.setChipTargetMuted')(function*({
  tabUrl,
  envs = null,
  muted
}: SetChipMutedOptions) {
  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return false
  }
  const targets = liveTabsMatchingTarget(allTabsResult.value, { tabUrl, envs })

  const updateResult = yield* applyMutedToTabs(targets, muted)
  if (updateResult.attemptedCount === 0) return true
  if (updateResult.updatedCount === 0) {
    showToast(muted ? 'Could not mute tabs' : 'Could not unmute tabs')
    return false
  }
  // Passive refresh: muting doesn't reorganize cards, so repaint in place (no card animation).
  void settleDashboardRefresh(requestDashboardRefresh())
  if (updateResult.updatedCount < updateResult.attemptedCount) {
    showToast(`${muted ? 'Muted' : 'Unmuted'} ${updateResult.updatedCount} of ${updateResult.attemptedCount} tabs`)
    return false
  }
  return true
})

export function setChipTargetMuted(options: SetChipMutedOptions): Promise<boolean> {
  return runTabAction(runSetChipTargetMuted(options))
}

/** setHistoryEntryMuted — mute/unmute the single tab behind a history row. */
const runSetHistoryEntryMuted = Effect.fn('tabActions.setHistoryEntryMuted')(function*(
  target: ChromeMenuTabTarget,
  muted: boolean
) {
  const resolution: ChromeMenuTabResolution = yield* resolveChromeMenuTabTarget(target)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  if (typeof tab?.id !== 'number') return false
  const browserTabs = yield* BrowserTabs
  if (!(yield* browserTabs.updateTab(tab.id, { muted }))) {
    showToast(historyEntryMuteFailureToastMessage(muted))
    return false
  }
  // Passive refresh: muting doesn't reorganize cards, so repaint in place (no card animation).
  void settleDashboardRefresh(requestDashboardRefresh())
  return true
})

export function setHistoryEntryMuted(
  target: ChromeMenuTabTarget,
  muted: boolean
): Promise<ChromeMenuActionResult> {
  return runTabAction(runSetHistoryEntryMuted(target, muted))
}

type SuspendChipTargetOptions = {
  tabUrl: string
  envs?: DashboardChipEnv[] | null
}

const applySuspendToTabsEffect = Effect.fn('tabActions.applySuspendToTabs')(function*(
  targets: chrome.tabs.Tab[],
  target: SuspendTarget
) {
  let attemptedCount = 0
  let updatedCount = 0
  const browserTabs = yield* BrowserTabs
  for (const snapshot of targets) {
    if (typeof snapshot.id !== 'number') continue
    if (isSuspended(liveTabUrlForIdentity(snapshot))) continue
    attemptedCount += 1
    const liveTab = yield* revalidateMutationTarget(snapshot)
    const liveUrl = liveTab ? liveTabUrlForIdentity(liveTab) : ''
    if (typeof liveTab?.id !== 'number' || isSuspended(liveUrl)) continue
    const updated = yield* browserTabs.updateTab(liveTab.id, {
      url: buildSuspendUrl(target, { url: liveUrl, title: liveTab.title || '' })
    })
    if (updated) updatedCount += 1
  }
  return { attemptedCount, updatedCount }
})

const finishSuspendUpdatesEffect = Effect.fn('tabActions.finishSuspendUpdates')(function*(
  { attemptedCount, updatedCount }: TabUpdateSummary
) {
  if (attemptedCount === 0) {
    showToast('Nothing to suspend')
    return true
  }
  if (updatedCount === 0) {
    showToast(attemptedCount === 1 ? 'Could not suspend tab' : 'Could not suspend tabs')
    return false
  }

  void settleDashboardRefresh(requestDashboardRefresh())
  if (updatedCount < attemptedCount) {
    showToast(`Suspended ${updatedCount} of ${attemptedCount} tabs`)
    return false
  }
  showToast(updatedCount === 1 ? 'Tab suspended' : `Suspended ${updatedCount} tabs`)
  return true
})

function liveTabsForMutationTargets(
  liveTabs: readonly chrome.tabs.Tab[],
  targets: readonly DashboardTabMutationTarget[]
): chrome.tabs.Tab[] {
  const expectedUrlById = new Map(targets.map((target) => [target.tabId, target.tabUrl]))
  return liveTabs.filter((tab) => typeof tab.id === 'number' &&
    expectedUrlById.get(tab.id) === unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))
}

export function suspendExactTabTargets({ targets }: ExactTabTargetsOptions): Promise<SuspendTabsResult> {
  return runTabAction(suspendMutationTargetsEffect(targets))
}

/**
 * suspendChipTarget — redirect every live, not-already-suspended tab a chip
 * represents into the detected suspender. Mirrors setChipTargetMuted's
 * suspender-aware URL matching (effective + raw URL, folded groups = all matches).
 */
const runSuspendChipTarget = Effect.fn('tabActions.suspendChipTarget')(function*({
  tabUrl,
  envs = null
}: SuspendChipTargetOptions) {
  const target = yield* getSuspendTargetEffect()
  if (!target) {
    showToast('No suspender detected')
    return false
  }

  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) {
    showOpenTabsReadError()
    return false
  }
  const matches = liveTabsMatchingTarget(allTabsResult.value, { tabUrl, envs })

  const updateResult = yield* applySuspendToTabsEffect(matches, target)
  return yield* finishSuspendUpdatesEffect(updateResult)
})

export function suspendChipTarget(options: SuspendChipTargetOptions): Promise<boolean> {
  return runTabAction(runSuspendChipTarget(options))
}

/** suspendHistoryEntry — redirect the single tab behind a history row into the suspender. */
const runSuspendHistoryEntry = Effect.fn('tabActions.suspendHistoryEntry')(function*(
  entryTarget: ChromeMenuTabTarget
) {
  const suspendTarget = yield* getSuspendTargetEffect()
  if (!suspendTarget) {
    showToast('No suspender detected')
    return false
  }
  const resolution: ChromeMenuTabResolution = yield* resolveChromeMenuTabTarget(entryTarget)
  if (resolution.status === 'unknown') {
    showOpenTabsReadError()
    return 'unknown'
  }
  const tab = resolution.tab
  if (!tab || typeof tab.id !== 'number') {
    showToast('Could not suspend tab')
    return false
  }
  const liveUrl = liveTabUrlForIdentity(tab)
  if (isSuspended(liveUrl)) {
    showToast('Already suspended')
    return false
  }
  const browserTabs = yield* BrowserTabs
  const updated = yield* browserTabs.updateTab(tab.id, {
    url: buildSuspendUrl(suspendTarget, { url: liveUrl, title: tab.title || '' })
  })
  if (!updated) {
    showToast('Could not suspend tab')
    return false
  }
  void settleDashboardRefresh(requestDashboardRefresh())
  showToast('Tab suspended')
  return true
})

export function suspendHistoryEntry(
  entryTarget: ChromeMenuTabTarget
): Promise<ChromeMenuActionResult> {
  return runTabAction(runSuspendHistoryEntry(entryTarget))
}
