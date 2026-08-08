export interface AdjacentCloseBatcher {
  readonly enqueue: (tabId: number) => void
  readonly whenSettled: (tabId: number) => Promise<void>
}

export interface AdjacentCloseBatcherOptions {
  readonly schedule?: (drain: () => void) => void
}

/**
 * Drain the close events already adjacent in the current event turn. While an
 * asynchronous batch is being persisted, later Chrome removal events collect
 * behind that one in-flight write and drain together when it settles. This is
 * work-conserving rather than time-debounced: an idle batch starts at the next
 * microtask, and no timer delays a lone physical close.
 */
export function createAdjacentCloseBatcher(
  drainBatch: (tabIds: readonly number[]) => void | PromiseLike<void>,
  options: AdjacentCloseBatcherOptions = {}
): AdjacentCloseBatcher {
  const schedule = options.schedule ?? queueMicrotask
  const pending = new Set<number>()
  const settled = new Set<number>()
  const settledOrder: number[] = []
  const settlementWaiters = new Map<number, Set<() => void>>()
  let draining = false
  let scheduled = false
  const settledCapacity = 4_096

  function scheduleDrain(): void {
    if (draining || scheduled || pending.size === 0) return
    scheduled = true
    schedule(drain)
  }

  function finishDrain(tabIds: readonly number[]): void {
    for (const tabId of tabIds) {
      if (!settled.has(tabId)) {
        settled.add(tabId)
        settledOrder.push(tabId)
      }
      const waiters = settlementWaiters.get(tabId)
      if (waiters) {
        settlementWaiters.delete(tabId)
        for (const resolve of waiters) resolve()
      }
    }
    while (settledOrder.length > settledCapacity) {
      const oldest = settledOrder.shift()
      if (oldest !== undefined) settled.delete(oldest)
    }
    draining = false
    scheduleDrain()
  }

  function drain(): void {
    scheduled = false
    if (draining) return
    const tabIds = [...pending]
    pending.clear()
    if (tabIds.length === 0) return

    draining = true
    let result: void | PromiseLike<void>
    try {
      result = drainBatch(tabIds)
    } catch (error) {
      finishDrain(tabIds)
      throw error
    }

    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).then(
        () => finishDrain(tabIds),
        () => finishDrain(tabIds)
      )
      return
    }
    finishDrain(tabIds)
  }

  function enqueue(tabId: number): void {
    if (!Number.isInteger(tabId)) return
    if (settled.has(tabId)) return
    pending.add(tabId)
    scheduleDrain()
  }

  function whenSettled(tabId: number): Promise<void> {
    if (!Number.isInteger(tabId) || settled.has(tabId)) return Promise.resolve()
    return new Promise((resolve) => {
      settlementWaiters.getOrInsertComputed(tabId, () => new Set()).add(resolve)
      enqueue(tabId)
    })
  }

  return { enqueue, whenSettled }
}
