import type { ChromeOpenTabsSnapshot } from './tabs.js'
import type { RetainedPageRecord } from './retained-pages-ledger.js'
import type { RetentionHealthEpisode } from './retention-health.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from './types'

export { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './runtime-messages.js'

/** One worker-owned browser generation shared by dashboard, history, and Working Set composition. */
export type CapturedDashboardServiceState = {
  tabHistory: TabHistorySnapshot
  workingSetActivity: WorkingSetActivityStore
  openTabsSnapshot: ChromeOpenTabsSnapshot
  retainedPages: readonly RetainedPageRecord[]
  retentionHealth: RetentionHealthEpisode | null
}
