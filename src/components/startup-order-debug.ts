import type { DashboardCardEntry, DashboardData, DashboardSource } from './types'
import type { WorkingSetSnapshot } from '../extension/types'

const STARTUP_ORDER_DEBUG_KEY = 'tab-out:debug-startup-order'

export type StartupOrderDebugCapture = {
  enabledAt: string
  samples: unknown[]
  shifts: unknown[]
  timings: StartupTiming[]
}
export type StartupTiming = {
  kind: 'timing'
  label: string
  t: number
  durationMs?: number
  detail?: Record<string, unknown>
}
type StartupTimingOptions = {
  startedAt?: number
  detail?: Record<string, unknown>
}
type StartupOrderDebugWindow = Window & {
  __tabOutStartupOrderDebug?: StartupOrderDebugCapture
}
export type StartupOrderVmSampleOptions = {
  dashboard: DashboardData | null
  filter: string
  isReady: boolean
  matchedCards: DashboardCardEntry[]
  source: DashboardSource
  workingSet?: WorkingSetSnapshot | null
}

type StartupOrderDebugDetails = typeof import('./startup-order-debug-heavy')

let startupOrderDebugDetailsPromise: Promise<StartupOrderDebugDetails> | null = null

function loadStartupOrderDebugDetails(): Promise<StartupOrderDebugDetails> {
  startupOrderDebugDetailsPromise ??= import('./startup-order-debug-heavy')
  return startupOrderDebugDetailsPromise
}

function startupOrderDebugEnabled(): boolean {
  try {
    return localStorage.getItem(STARTUP_ORDER_DEBUG_KEY) === '1' || new URLSearchParams(location.search).has('taboutStartupOrderDebug')
  } catch {
    return false
  }
}

export function startupDebugNow(): number {
  return performance.now()
}

function startupOrderDebugCapture(): StartupOrderDebugCapture | null {
  if (!startupOrderDebugEnabled()) return null
  const debugWindow = window as StartupOrderDebugWindow
  if (debugWindow.__tabOutStartupOrderDebug) return debugWindow.__tabOutStartupOrderDebug

  const capture: StartupOrderDebugCapture = {
    enabledAt: new Date().toISOString(),
    samples: [],
    shifts: [],
    timings: []
  }
  debugWindow.__tabOutStartupOrderDebug = capture
  void loadStartupOrderDebugDetails().then(({ initializeStartupOrderDebug }) => {
    initializeStartupOrderDebug(capture)
  })
  return capture
}

export const STARTUP_ORDER_DEBUG_CAPTURE = typeof window === 'undefined' ? null : startupOrderDebugCapture()

export function recordStartupTiming(capture: StartupOrderDebugCapture | null, label: string, options: StartupTimingOptions = {}): void {
  if (!capture) return
  const now = startupDebugNow()
  const timing: StartupTiming = {
    kind: 'timing',
    label,
    t: Math.round(now)
  }
  if (options.startedAt !== undefined) timing.durationMs = Math.max(0, Math.round(now - options.startedAt))
  if (options.detail) timing.detail = options.detail
  capture.timings.push(timing)
}

export function recordStartupOrderDebugVmSample(capture: StartupOrderDebugCapture | null, options: StartupOrderVmSampleOptions): void {
  if (!capture) return
  void loadStartupOrderDebugDetails().then(({ recordStartupOrderDebugVmSample: recordVmSample }) => {
    recordVmSample(capture, options)
  })
}

export function startStartupOrderDebugDomSampling(capture: StartupOrderDebugCapture | null): () => void {
  if (!capture) return () => {}
  let active = true
  let stopSampling = () => {}
  void loadStartupOrderDebugDetails().then(({ startStartupOrderDebugDomSampling: startDomSampling }) => {
    if (!active) return
    stopSampling = startDomSampling(capture)
  })
  return () => {
    active = false
    stopSampling()
  }
}
