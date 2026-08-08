import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ManagedRuntime } from 'effect'

import {
  RetentionHealth,
  parseRetentionHealthEpisodeValue,
  type RetentionHealthStorageBackend
} from '../src/extension/retention-health.js'

function makeRuntime(
  t: TestContext,
  backend: RetentionHealthStorageBackend,
  now: () => number
) {
  const runtime = ManagedRuntime.make(RetentionHealth.layer(backend, now))
  t.after(() => runtime.dispose())
  return runtime
}

test('retention health keeps one metadata-free failure episode', async (t) => {
  let stored: unknown
  let timestamp = 100
  const runtime = makeRuntime(t, {
    read: async () => stored,
    write: async (episode) => {
      stored = episode
    },
    clear: async () => {
      stored = undefined
    }
  }, () => timestamp)
  const health = runtime.runSync(RetentionHealth)

  await runtime.runPromise(health.recordFailure({
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry'
  }))
  timestamp = 150
  await runtime.runPromise(health.recordFailure({
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry'
  }))

  assert.deepEqual(stored, {
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry',
    startedAt: 100,
    lastFailedAt: 150
  })
  const episode = parseRetentionHealthEpisodeValue(stored)
  assert.ok(episode)
  assert.deepEqual(Object.keys(episode).sort(), [
    'failureKind',
    'lastFailedAt',
    'operationKind',
    'retryState',
    'startedAt'
  ])
})

test('retention health clears silently only after the matching operation recovers', async (t) => {
  let stored: unknown
  let clearCount = 0
  const runtime = makeRuntime(t, {
    read: async () => stored,
    write: async (episode) => {
      stored = episode
    },
    clear: async () => {
      clearCount += 1
      stored = undefined
    }
  }, () => 100)
  const health = runtime.runSync(RetentionHealth)

  await runtime.runPromise(health.recordFailure({
    failureKind: 'restore',
    operationKind: 'durable-inventory-reset',
    retryState: 'not-applicable'
  }))
  await runtime.runPromise(health.recordRecovery('automatic-capture'))
  assert.equal(clearCount, 0)
  assert.ok(await runtime.runPromise(health.getEpisode()))

  await runtime.runPromise(health.recordRecovery('durable-inventory-reset'))
  assert.equal(clearCount, 1)
  assert.equal(await runtime.runPromise(health.getEpisode()), null)
})

test('retention health storage unavailability never fails its callers', async (t) => {
  const runtime = makeRuntime(t, {
    read: async () => {
      throw new Error('session storage unavailable')
    },
    write: async () => {
      throw new Error('session storage unavailable')
    },
    clear: async () => {
      throw new Error('session storage unavailable')
    }
  }, () => 100)
  const health = runtime.runSync(RetentionHealth)

  assert.equal(await runtime.runPromise(health.getEpisode()), null)
  await assert.doesNotReject(runtime.runPromise(health.recordFailure({
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry'
  })))
  await assert.doesNotReject(runtime.runPromise(
    health.recordRecovery('automatic-capture')
  ))
})

test('retention health rejects malformed or metadata-bearing session values', () => {
  assert.equal(parseRetentionHealthEpisodeValue({
    failureKind: 'capture',
    operationKind: 'automatic-capture',
    retryState: 'exhausted-after-one-retry',
    startedAt: 100,
    lastFailedAt: 100,
    url: 'https://example.test/private'
  }), null)
  assert.equal(parseRetentionHealthEpisodeValue(undefined), null)
})
