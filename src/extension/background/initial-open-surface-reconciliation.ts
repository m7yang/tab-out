import { Effect } from 'effect'

import type { OpenSurfaceReconciliationMode } from '../open-surface-reconciliation.js'

export type DeferredTaskScheduler = (task: () => void) => () => void

export interface InitialOpenSurfaceReconciliationCoordinator {
  readonly claim: (mode: OpenSurfaceReconciliationMode) => Promise<void>
  readonly whenReady: () => Promise<void>
}

/** Keep Promise adaptation behind the lifecycle seam, not in background.ts. */
export function initialOpenSurfaceReconciliationEffect(
  coordinator: InitialOpenSurfaceReconciliationCoordinator,
  mode?: OpenSurfaceReconciliationMode
): Effect.Effect<void> {
  return Effect.promise(() => mode
    ? coordinator.claim(mode)
    : coordinator.whenReady())
}

function deferToNextTask(task: () => void): () => void {
  const timeoutId = setTimeout(task, 0)
  return () => clearTimeout(timeoutId)
}

/**
 * Chooses the one lifecycle mode that owns a worker instance's initial
 * inventory reconciliation. Chrome dispatches the event that woke an extension
 * worker only after its module has registered listeners, so one timer task lets
 * onStartup/onInstalled claim that event without adding a time-based delay. A
 * failed attempt rejects its current waiters but keeps the selected mode so the
 * next readiness wait can retry the same initial lifecycle contract.
 */
export function createInitialOpenSurfaceReconciliationCoordinator(options: {
  readonly reconcile: (mode: OpenSurfaceReconciliationMode) => PromiseLike<void>
  readonly defer?: DeferredTaskScheduler
}): InitialOpenSurfaceReconciliationCoordinator {
  let attempt = Promise.withResolvers<void>()
  let reconciliationReady = false
  let reconciliationStarted = false
  let modeSelectionClosed = false
  let selectedMode: OpenSurfaceReconciliationMode = 'worker-resume'

  const priority: Readonly<Record<OpenSurfaceReconciliationMode, number>> = {
    'worker-resume': 0,
    'extension-reload': 1,
    'browser-startup': 2,
    'first-install': 3
  }

  const startReconciliation = (): void => {
    if (reconciliationReady || reconciliationStarted) return
    modeSelectionClosed = true
    reconciliationStarted = true
    const currentAttempt = attempt
    void Promise.resolve()
      .then(() => options.reconcile(selectedMode))
      .then(
        () => {
          reconciliationReady = true
          reconciliationStarted = false
          currentAttempt.resolve()
        },
        (reason) => {
          reconciliationStarted = false
          currentAttempt.reject(reason)
          if (attempt === currentAttempt) attempt = Promise.withResolvers<void>()
        }
      )
  }

  const waitForReady = (): Promise<void> => {
    if (reconciliationReady) return Promise.resolve()
    if (modeSelectionClosed && !reconciliationStarted) startReconciliation()
    return attempt.promise
  }

  const claim = (mode: OpenSurfaceReconciliationMode): Promise<void> => {
    // Multiple lifecycle callbacks can be queued for the same worker wake. Let
    // the strongest contract win until the deferred reconciliation starts:
    // install seed-only > browser-startup closure > reload preservation >
    // ordinary worker resume.
    if (!modeSelectionClosed && priority[mode] > priority[selectedMode]) {
      selectedMode = mode
    }
    return waitForReady()
  }

  ;(options.defer || deferToNextTask)(() => {
    startReconciliation()
    void attempt.promise.catch(() => undefined)
  })

  return {
    claim,
    whenReady: waitForReady
  }
}
