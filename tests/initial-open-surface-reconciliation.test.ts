import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createInitialOpenSurfaceReconciliationCoordinator,
  type DeferredTaskScheduler
} from '../src/extension/background/initial-open-surface-reconciliation.js'
import type { OpenSurfaceReconciliationMode } from '../src/extension/open-surface-reconciliation.js'

function createManualScheduler() {
  let task: (() => void) | null = null
  let cancelled = false
  const scheduler: DeferredTaskScheduler = (deferredTask) => {
    task = deferredTask
    return () => {
      cancelled = true
    }
  }
  return {
    scheduler,
    flush() {
      if (!cancelled) task?.()
    }
  }
}

test('browser startup claims initial reconciliation before the deferred worker-resume fallback', async () => {
  const scheduled = createManualScheduler()
  const modes: OpenSurfaceReconciliationMode[] = []
  const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: async (mode) => {
      modes.push(mode)
    },
    defer: scheduled.scheduler
  })

  const startup = coordinator.claim('browser-startup')
  scheduled.flush()

  await Promise.all([startup, coordinator.whenReady()])
  assert.deepEqual(modes, ['browser-startup'])
})

test('installation and update select their explicit initial reconciliation modes', async () => {
  for (const mode of ['first-install', 'extension-reload'] as const) {
    const scheduled = createManualScheduler()
    const modes: OpenSurfaceReconciliationMode[] = []
    const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
      reconcile: async (selectedMode) => {
        modes.push(selectedMode)
      },
      defer: scheduled.scheduler
    })

    const reconciliation = coordinator.claim(mode)
    scheduled.flush()
    await Promise.all([reconciliation, coordinator.whenReady()])

    assert.deepEqual(modes, [mode])
  }
})

test('ordinary worker resume owns initial reconciliation only after one deferred task', async () => {
  const scheduled = createManualScheduler()
  const modes: OpenSurfaceReconciliationMode[] = []
  const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: async (mode) => {
      modes.push(mode)
    },
    defer: scheduled.scheduler
  })

  assert.deepEqual(modes, [])
  scheduled.flush()
  await coordinator.whenReady()

  assert.deepEqual(modes, ['worker-resume'])
})

test('late lifecycle claims join the already-selected initial reconciliation', async () => {
  const scheduled = createManualScheduler()
  const modes: OpenSurfaceReconciliationMode[] = []
  const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: async (mode) => {
      modes.push(mode)
    },
    defer: scheduled.scheduler
  })

  scheduled.flush()
  await Promise.all([
    coordinator.whenReady(),
    coordinator.claim('browser-startup'),
    coordinator.claim('extension-reload')
  ])

  assert.deepEqual(modes, ['worker-resume'])
})

test('browser startup outranks an extension reload when both callbacks arrive before reconciliation', async () => {
  for (const claims of [
    ['extension-reload', 'browser-startup'],
    ['browser-startup', 'extension-reload']
  ] as const) {
    const scheduled = createManualScheduler()
    const modes: OpenSurfaceReconciliationMode[] = []
    const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
      reconcile: async (mode) => {
        modes.push(mode)
      },
      defer: scheduled.scheduler
    })

    const pending = claims.map((mode) => coordinator.claim(mode))
    scheduled.flush()
    await Promise.all(pending)

    assert.deepEqual(modes, ['browser-startup'])
  }
})

test('first install remains seed-only when another lifecycle callback is co-delivered', async () => {
  const scheduled = createManualScheduler()
  const modes: OpenSurfaceReconciliationMode[] = []
  const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: async (mode) => {
      modes.push(mode)
    },
    defer: scheduled.scheduler
  })

  const pending = [
    coordinator.claim('browser-startup'),
    coordinator.claim('first-install')
  ]
  scheduled.flush()
  await Promise.all(pending)

  assert.deepEqual(modes, ['first-install'])
})

test('failed reconciliation rejects only that readiness attempt and whenReady retries', async () => {
  const scheduled = createManualScheduler()
  const modes: OpenSurfaceReconciliationMode[] = []
  let attempts = 0
  const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: async (mode) => {
      modes.push(mode)
      attempts += 1
      if (attempts === 1) throw new Error('inventory unavailable')
    },
    defer: scheduled.scheduler
  })

  const firstAttempt = coordinator.whenReady()
  scheduled.flush()

  await assert.rejects(firstAttempt, /inventory unavailable/)
  await coordinator.whenReady()

  assert.deepEqual(modes, ['worker-resume', 'worker-resume'])
})

test('concurrent claims share one retry after failed reconciliation', async () => {
  const scheduled = createManualScheduler()
  const modes: OpenSurfaceReconciliationMode[] = []
  let attempts = 0
  const coordinator = createInitialOpenSurfaceReconciliationCoordinator({
    reconcile: async (mode) => {
      modes.push(mode)
      attempts += 1
      if (attempts === 1) throw new Error('inventory unavailable')
    },
    defer: scheduled.scheduler
  })

  const firstAttempt = coordinator.claim('browser-startup')
  scheduled.flush()
  await assert.rejects(firstAttempt, /inventory unavailable/)

  await Promise.all([
    coordinator.claim('browser-startup'),
    coordinator.whenReady(),
    coordinator.claim('extension-reload')
  ])

  assert.deepEqual(modes, ['browser-startup', 'browser-startup'])
})
