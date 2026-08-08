import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdjacentCloseBatcher } from '../src/extension/background/adjacent-close-batcher.js'

test('adjacent close batching drains one deduplicated transaction without a timer', () => {
  const scheduled: Array<() => void> = []
  const batches: number[][] = []
  const batcher = createAdjacentCloseBatcher(
    (tabIds) => { batches.push([...tabIds]) },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(1)
  batcher.enqueue(2)
  batcher.enqueue(1)

  assert.equal(scheduled.length, 1)
  assert.deepEqual(batches, [])
  scheduled.shift()?.()
  assert.deepEqual(batches, [[1, 2]])
})

test('a close arriving after the drain boundary starts a new immediate batch', () => {
  const scheduled: Array<() => void> = []
  const batches: number[][] = []
  const batcher = createAdjacentCloseBatcher(
    (tabIds) => { batches.push([...tabIds]) },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(1)
  scheduled.shift()?.()
  batcher.enqueue(2)
  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()

  assert.deepEqual(batches, [[1], [2]])
})

test('close events arriving during an asynchronous write drain together after it settles', async () => {
  const scheduled: Array<() => void> = []
  const batches: number[][] = []
  const releases: Array<() => void> = []
  const batcher = createAdjacentCloseBatcher(
    (tabIds) => {
      batches.push([...tabIds])
      return new Promise<void>((resolve) => releases.push(resolve))
    },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(1)
  scheduled.shift()?.()
  batcher.enqueue(2)
  batcher.enqueue(3)
  batcher.enqueue(2)

  assert.deepEqual(batches, [[1]])
  assert.equal(scheduled.length, 0)

  releases.shift()?.()
  await Promise.resolve()
  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()

  assert.deepEqual(batches, [[1], [2, 3]])
  releases.shift()?.()
  await Promise.resolve()
})

test('a rejected asynchronous batch still releases the next accumulated drain', async () => {
  const scheduled: Array<() => void> = []
  const batches: number[][] = []
  const rejections: Array<(cause?: unknown) => void> = []
  const batcher = createAdjacentCloseBatcher(
    (tabIds) => {
      batches.push([...tabIds])
      if (batches.length > 1) return
      return new Promise<void>((_resolve, reject) => { rejections.push(reject) })
    },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(1)
  scheduled.shift()?.()
  batcher.enqueue(2)
  rejections.shift()?.(new Error('write failed'))
  await Promise.resolve()

  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()
  assert.deepEqual(batches, [[1], [2]])
})

test('settlement waits for the async batch and reuses its recent completion', async () => {
  const scheduled: Array<() => void> = []
  const releases: Array<() => void> = []
  const batches: number[][] = []
  const batcher = createAdjacentCloseBatcher(
    (tabIds) => {
      batches.push([...tabIds])
      return new Promise<void>((resolve) => releases.push(resolve))
    },
    { schedule: (drain) => scheduled.push(drain) }
  )

  batcher.enqueue(7)
  const firstSettlement = batcher.whenSettled(7)
  const secondSettlement = batcher.whenSettled(7)
  let settled = false
  void Promise.all([firstSettlement, secondSettlement]).then(() => { settled = true })

  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()
  assert.deepEqual(batches, [[7]])
  await Promise.resolve()
  assert.equal(settled, false)

  releases.shift()?.()
  await Promise.all([firstSettlement, secondSettlement])
  assert.equal(settled, true)

  await batcher.whenSettled(7)
  batcher.enqueue(7)
  assert.equal(scheduled.length, 0)
  assert.deepEqual(batches, [[7]])
})

test('settlement queues a missing event and releases even when capture rejects', async () => {
  const scheduled: Array<() => void> = []
  const batcher = createAdjacentCloseBatcher(
    () => Promise.reject(new Error('capture failed')),
    { schedule: (drain) => scheduled.push(drain) }
  )

  const settlement = batcher.whenSettled(9)
  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()

  await settlement
  await batcher.whenSettled(9)
  assert.equal(scheduled.length, 0)
})
