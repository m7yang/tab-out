import { Effect, Result } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { decodeDashboardRetainedPagesWire } from './dashboard-retained-pages-wire.js'
import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './dashboard-service-messages.js'
import type { CapturedDashboardServiceState } from './dashboard-service-messages.js'
import { parseDashboardServiceStateResponse } from './dashboard-service-state-schema.js'
import { reportRetentionHealthEpisode } from './retention-health-client.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { emptyWorkingSetActivity, normalizeWorkingSetActivity } from './working-set.js'
import type { ChromeOpenTabsSnapshot } from './tabs.js'

type DashboardServiceState = Omit<CapturedDashboardServiceState, 'openTabsSnapshot'> & {
  openTabsSnapshot: ChromeOpenTabsSnapshot | null
}
export type DashboardServiceStateResult =
  | { ok: true; value: DashboardServiceState }
  | { ok: false; value: DashboardServiceState }
function emptyDashboardServiceState(): DashboardServiceState {
  return {
    tabHistory: normalizeTabHistorySnapshot(null),
    workingSetActivity: emptyWorkingSetActivity(),
    openTabsSnapshot: null,
    retainedPages: [],
    retentionHealth: null
  }
}

export const fetchDashboardServiceStateResultEffect = Effect.fn(
  'dashboardServiceState.fetch'
)(function*() {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: false, value: emptyDashboardServiceState() }
  }

  const response = yield* Effect.result(Effect.tryPromise({
    try: () => chrome.runtime.sendMessage({ type: DASHBOARD_SERVICE_STATE_GET_MESSAGE }),
    catch: (cause) => cause
  }))
  if (Result.isFailure(response)) {
    return { ok: false, value: emptyDashboardServiceState() }
  }
  const parsed = parseDashboardServiceStateResponse(response.success)
  if (!parsed) {
    return { ok: false, value: emptyDashboardServiceState() }
  }
  const retainedPagesResult = yield* Effect.result(Effect.tryPromise({
    try: () => decodeDashboardRetainedPagesWire(parsed.retainedPages),
    catch: (cause) => cause
  }))
  if (Result.isFailure(retainedPagesResult)) {
    return { ok: false, value: emptyDashboardServiceState() }
  }
  yield* Effect.sync(() => reportRetentionHealthEpisode(parsed.retentionHealth)).pipe(
    Effect.catchCause(() => Effect.void)
  )

  return {
    ok: true,
    value: {
      tabHistory: normalizeTabHistorySnapshot(parsed.tabHistory),
      workingSetActivity: normalizeWorkingSetActivity(parsed.workingSetActivity),
      openTabsSnapshot: parsed.openTabsSnapshot,
      retainedPages: retainedPagesResult.success,
      retentionHealth: parsed.retentionHealth
    }
  }
})

export function fetchDashboardServiceStateResult(): Promise<DashboardServiceStateResult> {
  return getAppRuntime().runPromise(fetchDashboardServiceStateResultEffect())
}
