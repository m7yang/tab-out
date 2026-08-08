import type { OpenSurfaceCheckpointCapture } from './open-surface-capture.js'

export interface GuardedOpenSurfaceCapture {
  readonly tabId: number
  readonly capture: OpenSurfaceCheckpointCapture
  readonly isCurrent: () => boolean
}

export interface AdjacentOpenSurfaceBatcher {
  readonly enqueue: (
    tabId: number,
    capture: PromiseLike<OpenSurfaceCheckpointCapture>
  ) => void
  /** Cancel pending or already-draining observations for a superseded lifetime. */
  readonly invalidate: (tabId: number) => void
  /** Wait until the newest checkpoint already delivered for this tab settles. */
  readonly whenSettled: (tabId: number) => Promise<void>
}

export interface AdjacentOpenSurfaceBatcherOptions {
  readonly schedule?: (drain: () => void) => void
}

/** Coalesce the newest observation per tab already adjacent in this event turn. */
export function createAdjacentOpenSurfaceBatcher(
  drainBatch: (
    captures: PromiseLike<readonly GuardedOpenSurfaceCapture[]>
  ) => void | PromiseLike<void>,
  options: AdjacentOpenSurfaceBatcherOptions = {}
): AdjacentOpenSurfaceBatcher {
  const schedule = options.schedule ?? queueMicrotask
  const pending = new Map<number, {
    controller: AbortController
    capture: PromiseLike<OpenSurfaceCheckpointCapture>
  }>()
  const current = new Map<number, AbortController>()
  const settlementWaiters = new Map<number, Set<() => void>>()
  let scheduled = false

  function settle(tabId: number, controller?: AbortController): void {
    if (controller && current.get(tabId) !== controller) return
    current.delete(tabId)
    const waiters = settlementWaiters.get(tabId)
    if (!waiters) return
    settlementWaiters.delete(tabId)
    for (const resolve of waiters) resolve()
  }

  function drain(): void {
    scheduled = false
    const captures = [...pending].map(([tabId, value]) => ({ tabId, ...value }))
    pending.clear()
    if (captures.length === 0) return
    const drained = drainBatch(Promise.all(captures.map(async ({
      tabId,
      controller,
      capture
    }): Promise<GuardedOpenSurfaceCapture> => ({
      tabId,
      capture: await capture,
      isCurrent: () => !controller.signal.aborted
    }))))
    void Promise.resolve(drained).finally(() => {
      for (const { tabId, controller } of captures) {
        settle(tabId, controller)
      }
    })
  }

  function enqueue(
    tabId: number,
    capture: PromiseLike<OpenSurfaceCheckpointCapture>
  ): void {
    if (!Number.isInteger(tabId)) return
    current.get(tabId)?.abort()
    const controller = new AbortController()
    current.set(tabId, controller)
    pending.set(tabId, { controller, capture })
    if (scheduled) return
    scheduled = true
    schedule(drain)
  }

  function invalidate(tabId: number): void {
    if (!Number.isInteger(tabId)) return
    current.get(tabId)?.abort()
    pending.delete(tabId)
    settle(tabId)
  }

  function whenSettled(tabId: number): Promise<void> {
    if (!Number.isInteger(tabId) || !current.has(tabId)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = settlementWaiters.get(tabId) ?? new Set<() => void>()
      waiters.add(resolve)
      settlementWaiters.set(tabId, waiters)
    })
  }

  return { enqueue, invalidate, whenSettled }
}
