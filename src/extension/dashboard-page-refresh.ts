import { mergeDashboardRefreshOptions, type DashboardRefreshOptions } from './dashboard-intake.js'
import { isTabOutPageUrl } from './tab-out-url.js'

const DASHBOARD_PAGE_REFRESH_DELAY_MS = 250

type DashboardPageRefreshSchedulerDeps = {
  isVisible: () => boolean
  refresh: (options: DashboardRefreshOptions) => void
}

export type DashboardPageRefreshScheduler = {
  schedule: (options?: DashboardRefreshOptions) => void
  visibilityChanged: () => void
}

type DashboardTabUpdate = Partial<Pick<
  chrome.tabs.Tab,
  | 'audible'
  | 'discarded'
  | 'favIconUrl'
  | 'groupId'
  | 'mutedInfo'
  | 'pinned'
  | 'status'
  | 'title'
  | 'url'
>>

const DASHBOARD_MATERIAL_TAB_UPDATE_KEYS = [
  'title',
  'url',
  'favIconUrl',
  'groupId',
  'pinned',
  'discarded',
  'audible',
  'mutedInfo',
  'status'
] as const satisfies readonly (keyof DashboardTabUpdate)[]

/** Ignore the Dashboard tab's own load lifecycle; it is never a Dashboard Item. */
export function dashboardTabUpdateRefreshOptions(
  changeInfo: DashboardTabUpdate,
  tab: Pick<chrome.tabs.Tab, 'pendingUrl' | 'url'>,
  runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id
): DashboardRefreshOptions | null {
  const targetUrl = changeInfo.url ?? tab.pendingUrl ?? tab.url
  if (isTabOutPageUrl(targetUrl, runtimeId)) return null
  if (!DASHBOARD_MATERIAL_TAB_UPDATE_KEYS.some((key) => (
    changeInfo[key] !== undefined
  ))) return null
  return {
    animateCards:
      changeInfo.url !== undefined ||
      changeInfo.groupId !== undefined ||
      changeInfo.pinned !== undefined ||
      changeInfo.discarded !== undefined
  }
}

export function createDashboardPageRefreshScheduler(
  deps: DashboardPageRefreshSchedulerDeps
): DashboardPageRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let scheduledOptions: DashboardRefreshOptions = {}
  let hiddenRefreshPending = false
  let hiddenOptions: DashboardRefreshOptions = {}

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function deferWhileHidden(options: DashboardRefreshOptions): void {
    hiddenRefreshPending = true
    hiddenOptions = mergeDashboardRefreshOptions(hiddenOptions, options)
  }

  function moveScheduledRefreshToHidden(): void {
    if (timer === null) return
    clearTimer()
    deferWhileHidden(scheduledOptions)
    scheduledOptions = {}
  }

  function takePendingOptions(): DashboardRefreshOptions {
    const options = mergeDashboardRefreshOptions(hiddenOptions, scheduledOptions)
    hiddenRefreshPending = false
    hiddenOptions = {}
    scheduledOptions = {}
    return options
  }

  function schedule(options: DashboardRefreshOptions = {}): void {
    if (!deps.isVisible()) {
      moveScheduledRefreshToHidden()
      deferWhileHidden(options)
      return
    }
    scheduledOptions = mergeDashboardRefreshOptions(scheduledOptions, options)
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      if (!deps.isVisible()) {
        deferWhileHidden(scheduledOptions)
        scheduledOptions = {}
        return
      }
      deps.refresh(takePendingOptions())
    }, DASHBOARD_PAGE_REFRESH_DELAY_MS)
  }

  function visibilityChanged(): void {
    if (!deps.isVisible()) {
      moveScheduledRefreshToHidden()
      return
    }
    const hadScheduledRefresh = timer !== null
    clearTimer()
    const hadPendingRefresh = hadScheduledRefresh || hiddenRefreshPending
    const options = takePendingOptions()
    // Keep the existing visibility contract: becoming visible always verifies live browser
    // state, even if Chrome did not deliver an event while this page was hidden.
    deps.refresh(hadPendingRefresh ? options : {})
  }

  return { schedule, visibilityChanged }
}
