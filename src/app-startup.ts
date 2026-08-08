import type { DashboardLocalState } from './extension/dashboard-local-state.js'
import { appDashboardStore } from './extension/dashboard-intake.js'
import type { ClosedGhostDismissals } from './extension/closed-ghost-dismissals.js'
import type { DashboardStartupSnapshot } from './extension/startup-snapshot.js'
import type { DashboardSource } from './extension/types.js'

export type AppStartupFrame = {
  closedGhostDismissals: ClosedGhostDismissals
  historyRange: string
  localState: DashboardLocalState
  snapshot: DashboardStartupSnapshot
  source: DashboardSource
}

export type AppStartupState = { phase: 'ready' } & AppStartupFrame

let currentStartupState: AppStartupState | null = null
const startupListeners = new Set<() => void>()
let startupMaterialChangeHandler: ((delayMs?: number) => void) | null = null
let startupFilterIntent = ''

function publishAppStartup(nextState: AppStartupState | null): void {
  currentStartupState = nextState
  for (const listener of startupListeners) listener()
}

export function applyAppStartup(frame: AppStartupFrame): void {
  currentStartupState = { phase: 'ready', ...frame }
  appDashboardStore.applyStartup({
    historyRange: frame.historyRange,
    snapshot: frame.snapshot,
    source: frame.source
  })
  for (const listener of startupListeners) listener()
}

export function updateAppStartupClosedGhostDismissals(
  dismissals: ClosedGhostDismissals
): boolean {
  if (currentStartupState?.phase !== 'ready') return false
  publishAppStartup({
    ...currentStartupState,
    closedGhostDismissals: dismissals
  })
  return true
}

export function resetAppStartupShell(): void {
  publishAppStartup(null)
}

export function setAppStartupMaterialChangeHandler(
  handler: ((delayMs?: number) => void) | null
): void {
  startupMaterialChangeHandler = handler
}

export function notifyAppStartupMaterialChange(delayMs = 0): void {
  startupMaterialChangeHandler?.(delayMs)
}

export function setAppStartupFilterIntent(filter: string): boolean {
  if (startupFilterIntent === filter) return false
  startupFilterIntent = filter
  return true
}

export function readAppStartupFilterIntent(): string {
  return startupFilterIntent
}

export function subscribeAppStartup(listener: () => void): () => void {
  startupListeners.add(listener)
  return () => startupListeners.delete(listener)
}

export function readAppStartup(): AppStartupState | null {
  return currentStartupState
}

export function readBuildTimeAppStartup(): null {
  return null
}
