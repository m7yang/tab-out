import { useLayoutEffect, useRef } from 'react'
import { STARTUP_ORDER_DEBUG_CAPTURE, recordStartupOrderDebugVmSample, recordStartupTiming, startStartupOrderDebugDomSampling } from './startup-order-debug'
import type { StartupOrderVmSampleOptions } from './startup-order-debug'
import type { WorkingSetSnapshot } from '../extension/types'

type UseStartupOrderDebugArgs = Omit<StartupOrderVmSampleOptions, 'workingSet'> & {
  workingSet: WorkingSetSnapshot | null
  startupReady: boolean
}

// Passive startup-order instrumentation: one first-layout timing mark, a
// view-model sample per dashboard commit, and a DOM sampler for the mounted
// panel's lifetime. All three no-op without an active capture; consolidated
// here so App owns dashboard wiring rather than telemetry plumbing.
export function useStartupOrderDebug({ dashboard, source, filter, isReady, matchedCards, workingSet, startupReady }: UseStartupOrderDebugArgs): void {
  const firstDashboardLayoutRecordedRef = useRef(false)

  useLayoutEffect(() => {
    if (firstDashboardLayoutRecordedRef.current || !dashboard) return
    firstDashboardLayoutRecordedRef.current = true
    recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'first-dashboard-layout', {
      detail: {
        startupFrame: startupReady,
        domainGroups: dashboard.domainGroups.length,
        filterActive: filter.trim() !== '',
        matchedCards: matchedCards.length,
        realTabs: dashboard.realTabs.length,
        source,
        workingSet: workingSet?.items.length ?? 0,
      },
    })
  }, [dashboard, filter, matchedCards.length, source, startupReady, workingSet])

  useLayoutEffect(() => {
    recordStartupOrderDebugVmSample(STARTUP_ORDER_DEBUG_CAPTURE, {
      dashboard,
      source,
      filter,
      isReady,
      matchedCards,
      workingSet,
    })
  }, [dashboard, filter, isReady, matchedCards, source, workingSet])

  useLayoutEffect(() => {
    return startStartupOrderDebugDomSampling(STARTUP_ORDER_DEBUG_CAPTURE)
  }, [])
}
