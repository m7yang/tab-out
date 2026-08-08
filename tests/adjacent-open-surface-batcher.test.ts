import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAdjacentOpenSurfaceBatcher,
  type GuardedOpenSurfaceCapture
} from '../src/extension/background/adjacent-open-surface-batcher.js'

test('adjacent observation batching keeps the newest checkpoint per tab', async () => {
  const scheduled: Array<() => void> = []
  const batches: Array<PromiseLike<readonly GuardedOpenSurfaceCapture[]>> = []
  const batcher = createAdjacentOpenSurfaceBatcher(
    (observations) => { batches.push(observations) },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(1, Promise.resolve({
    status: 'captured',
    observation: {
      tabId: 1,
      surfaceKind: 'normal-tab',
      url: 'https://one.example.test/',
      title: 'Old title'
    }
  }))
  batcher.enqueue(2, Promise.resolve({
    status: 'captured',
    observation: {
      tabId: 2,
      surfaceKind: 'normal-tab',
      url: 'https://two.example.test/',
      title: 'Two'
    }
  }))
  batcher.enqueue(1, Promise.resolve({
    status: 'captured',
    observation: {
      tabId: 1,
      surfaceKind: 'normal-tab',
      url: 'https://one.example.test/',
      title: 'Newest title'
    }
  }))

  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()
  const capturedBatch = batches[0]
  assert.ok(capturedBatch)
  const captured = await capturedBatch
  assert.deepEqual(captured.map(({ capture }) => capture), [
    {
      status: 'captured',
      observation: {
        tabId: 1,
        surfaceKind: 'normal-tab',
        url: 'https://one.example.test/',
        title: 'Newest title'
      }
    },
    {
      status: 'captured',
      observation: {
        tabId: 2,
        surfaceKind: 'normal-tab',
        url: 'https://two.example.test/',
        title: 'Two'
      }
    }
  ])
  assert.deepEqual(captured.map(({ isCurrent }) => isCurrent()), [true, true])
})

test('ineligible captures are retained so stale inventory can be invalidated', async () => {
  const scheduled: Array<() => void> = []
  let batch: PromiseLike<readonly GuardedOpenSurfaceCapture[]> | undefined
  const batcher = createAdjacentOpenSurfaceBatcher(
    (observations) => {
      batch = observations
    },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(1, Promise.resolve({ status: 'ineligible' }))
  scheduled.shift()?.()

  const captured = await batch
  assert.equal(captured?.[0]?.tabId, 1)
  assert.deepEqual(captured?.[0]?.capture, { status: 'ineligible' })
  assert.equal(captured?.[0]?.isCurrent(), true)
})

test('invalidating a tab cancels an observation that is already draining', async () => {
  const scheduled: Array<() => void> = []
  let resolveObservation: ((value: {
    status: 'captured'
    observation: {
      tabId: number
      surfaceKind: 'normal-tab'
      url: string
    }
  }) => void) | undefined
  const observation = new Promise<{
    status: 'captured'
    observation: {
      tabId: number
      surfaceKind: 'normal-tab'
      url: string
    }
  }>((resolve) => { resolveObservation = resolve })
  let batch: PromiseLike<readonly GuardedOpenSurfaceCapture[]> | undefined
  const batcher = createAdjacentOpenSurfaceBatcher(
    (captures) => { batch = captures },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(9, observation)
  scheduled.shift()?.()
  batcher.invalidate(9)
  resolveObservation?.({
    status: 'captured',
    observation: {
      tabId: 9,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/late'
    }
  })

  const captured = await batch
  assert.equal(captured?.[0]?.isCurrent(), false)
})

test('settlement waits for the current checkpoint drain', async () => {
  const scheduled: Array<() => void> = []
  let releaseDrain: (() => void) | undefined
  const batcher = createAdjacentOpenSurfaceBatcher(
    async (captures) => {
      await captures
      await new Promise<void>((resolve) => { releaseDrain = resolve })
    },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(10, Promise.resolve({
    status: 'captured',
    observation: {
      tabId: 10,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/newest'
    }
  }))
  const settlement = batcher.whenSettled(10)
  let settled = false
  void settlement.then(() => { settled = true })

  scheduled.shift()?.()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  assert.ok(releaseDrain)
  releaseDrain?.()
  await settlement
  assert.equal(settled, true)
})
