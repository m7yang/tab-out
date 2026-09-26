import { Effect } from 'effect'

import {
  DESKTOP_WINDOW_MERGE_START_CONFIRM_MESSAGE,
  isDesktopWindowMergeStartConfirmAcknowledgement,
} from '../desktop-window-merge-contract.js'
import { isTabOutDashboardUrl, TAB_OUT_FAVICON_URL, tabOutDashboardCanonicalUrl } from '../tab-out-url.js'
import type { ChromeApi } from './chrome-api.js'

const START_CONFIRM_DELIVERY_ATTEMPTS = 40
const START_CONFIRM_RETRY_DELAY_MILLIS = 250

export type DesktopWindowMergeHandoffOptions = {
  deliveryAttempts?: number
  retryDelayMillis?: number
}

function preferredDashboardTab(
  tabs: readonly chrome.tabs.Tab[],
): chrome.tabs.Tab | undefined {
  return tabs.find((tab) => tab.active) ??
    tabs.find((tab) => tab.pinned) ??
    tabs[0]
}

const queryWindowTabs = Effect.fn(
  'desktopWindowMergeHandoff.queryWindowTabs',
)(function* (chromeApi: ChromeApi, windowId: number) {
  return yield* Effect.tryPromise(() => chromeApi.tabs.query({ windowId })).pipe(
    Effect.catch(() => Effect.succeed<chrome.tabs.Tab[]>([])),
  )
})

const createInactiveDashboardTab = Effect.fn(
  'desktopWindowMergeHandoff.createInactiveDashboardTab',
)(function* (chromeApi: ChromeApi, windowId: number) {
  const url = tabOutDashboardCanonicalUrl(chromeApi.runtime.id)
  if (!url) return null
  const created = yield* Effect.tryPromise(
    () => chromeApi.tabs.create({ windowId, url, active: false }),
  ).pipe(
    Effect.catch(() => Effect.tryPromise(() => chromeApi.tabs.create({ url, active: false }))),
    Effect.catch(() => Effect.succeed(null)),
  )
  return typeof created?.id === 'number' ? created.id : null
})

/**
 * Ensure a Tab Out page exists in the invoking window BEFORE a menu preview
 * freezes the browser snapshot, so the page that will later submit the
 * confirmation is already part of the frozen plan. Never activates anything:
 * every tab's `active` flag is part of the snapshot key, so any focus change
 * between preview and confirmation would force a spurious re-confirmation.
 */
export const ensureDashboardTabInWindowEffect = Effect.fn(
  'desktopWindowMergeHandoff.ensureDashboardTab',
)(function* (chromeApi: ChromeApi, windowId: number) {
  const tabs = yield* queryWindowTabs(chromeApi, windowId)
  // Native new tabs belong in the dashboard, but cannot host its message listener.
  const dashboardTabs = tabs.filter((tab) =>
    isTabOutDashboardUrl(tab.url, chromeApi.runtime.id) ||
    (tab.url === 'chrome://newtab/' && tab.favIconUrl === TAB_OUT_FAVICON_URL),
  )
  const runnable = preferredDashboardTab(
    dashboardTabs.filter((tab) => tab.discarded !== true && tab.frozen !== true),
  )
  if (typeof runnable?.id === 'number') return runnable.id

  const discarded = preferredDashboardTab(
    dashboardTabs.filter((tab) => tab.discarded === true && tab.frozen !== true),
  )
  if (typeof discarded?.id === 'number') {
    const discardedTabId = discarded.id
    const restored = yield* Effect.tryPromise(
      () => chromeApi.tabs.reload(discardedTabId),
    ).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (restored) return discardedTabId
  }
  return yield* createInactiveDashboardTab(chromeApi, windowId)
})

/**
 * Toolbar handoff for a menu-confirmed `Merge windows on this desktop…`:
 * deliver the start-confirm intent to a Tab Out page in the invoking window
 * until its merge host acknowledges it. That page submits the confirmation
 * so it becomes the journal owner and hosts the progress, result, and
 * revalidation surfaces — WITHOUT being focused: the frozen snapshot key
 * includes every tab's `active` flag, so activating the page here would
 * invalidate the menu-approved preview and force a re-confirmation. The
 * merge proceeds beneath the user's current tab, and the page brings itself
 * forward only when a dialog genuinely needs them. A freshly created or
 * reloaded page needs the bounded retry window to finish hydrating its
 * message listener.
 */
export const handoffDesktopWindowMergeToWindowEffect = Effect.fn(
  'desktopWindowMergeHandoff.toWindow',
)(function* (
  chromeApi: ChromeApi,
  windowId: number,
  previewId: string,
  options: DesktopWindowMergeHandoffOptions = {},
) {
  const {
    deliveryAttempts = START_CONFIRM_DELIVERY_ATTEMPTS,
    retryDelayMillis = START_CONFIRM_RETRY_DELAY_MILLIS,
  } = options
  const dashboardTabId = yield* ensureDashboardTabInWindowEffect(chromeApi, windowId)
  if (dashboardTabId === null) return false

  for (let attempt = 0; attempt < deliveryAttempts; attempt += 1) {
    if (attempt > 0) yield* Effect.sleep(retryDelayMillis)
    const response = yield* Effect.tryPromise(
      () => chromeApi.tabs.sendMessage(dashboardTabId, {
        type: DESKTOP_WINDOW_MERGE_START_CONFIRM_MESSAGE,
        previewId,
      }),
    ).pipe(Effect.catch(() => Effect.succeed(null)))
    if (isDesktopWindowMergeStartConfirmAcknowledgement(response)) return true
  }
  return false
})
