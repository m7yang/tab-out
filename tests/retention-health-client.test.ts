import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRetentionHealthReporter,
  retentionHealthNotice
} from '../src/extension/retention-health-client.js'
import type { RetentionHealthEpisode } from '../src/extension/retention-health.js'

function exampleEpisode(
  failureKind: RetentionHealthEpisode['failureKind'] = 'capture'
): RetentionHealthEpisode {
  return {
    failureKind,
    operationKind: failureKind === 'capture'
      ? 'automatic-capture'
      : 'retained-ledger-reset',
    retryState: failureKind === 'capture'
      ? 'exhausted-after-one-retry'
      : 'not-applicable',
    startedAt: 100,
    lastFailedAt: 150
  }
}

function createVisibilityHarness(initiallyVisible: boolean) {
  let visible = initiallyVisible
  const listeners = new Set<() => void>()
  return {
    visibility: {
      isVisible: () => visible,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    setVisible(next: boolean) {
      visible = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size
  }
}

test('each Dashboard reporter shows one failure episode independently once', () => {
  const episode = exampleEpisode()
  const firstNotices: string[] = []
  const secondNotices: string[] = []
  const firstVisibility = createVisibilityHarness(true)
  const secondVisibility = createVisibilityHarness(true)
  const first = createRetentionHealthReporter({
    notify: (notice) => firstNotices.push(notice),
    visibility: firstVisibility.visibility
  })
  const second = createRetentionHealthReporter({
    notify: (notice) => secondNotices.push(notice),
    visibility: secondVisibility.visibility
  })

  first(episode)
  first({ ...episode, lastFailedAt: 200 })
  second(episode)

  assert.deepEqual(firstNotices, ["Some closed pages couldn't be retained"])
  assert.deepEqual(secondNotices, ["Some closed pages couldn't be retained"])
})

test('a hidden Dashboard waits until visible and cancels a recovered episode', () => {
  const notices: string[] = []
  const harness = createVisibilityHarness(false)
  const report = createRetentionHealthReporter({
    notify: (notice) => notices.push(notice),
    visibility: harness.visibility
  })

  report(exampleEpisode())
  assert.equal(harness.listenerCount(), 1)
  assert.deepEqual(notices, [])

  report(null)
  harness.setVisible(true)

  assert.equal(harness.listenerCount(), 0)
  assert.deepEqual(notices, [])
})

test('retention health uses the approved restore notice', () => {
  assert.equal(
    retentionHealthNotice(exampleEpisode('restore')),
    "Some closed pages couldn't be restored."
  )
})

test('a toast implementation failure never blocks retention health reporting', () => {
  const harness = createVisibilityHarness(true)
  const report = createRetentionHealthReporter({
    notify: () => {
      throw new Error('toast mount unavailable')
    },
    visibility: harness.visibility
  })

  assert.doesNotThrow(() => report(exampleEpisode()))
})
