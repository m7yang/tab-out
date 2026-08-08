import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createStartupAdmissionController
} from '../src/extension/startup-frame-controller.js'
import type {
  StartupAdmissionCaptureRequest,
  StartupAdmissionCaptureResult,
  StartupAdmissionCaptureRunner,
  StartupAdmissionSchedule
} from '../src/extension/startup-frame-controller.js'

type TestTimer = {
  readonly id: number
  readonly at: number
  readonly callback: () => void
  cancelled: boolean
}

function createTestTime() {
  let currentTime = 0
  let timerSequence = 0
  const timers: TestTimer[] = []

  const schedule: StartupAdmissionSchedule = (delayMs, callback) => {
    const timer: TestTimer = {
      id: ++timerSequence,
      at: currentTime + Math.max(0, delayMs),
      callback,
      cancelled: false
    }
    timers.push(timer)
    return {
      cancel() {
        timer.cancelled = true
      }
    }
  }

  const advanceBy = (durationMs: number) => {
    const targetTime = currentTime + durationMs
    while (true) {
      let nextTimer: TestTimer | undefined
      for (const timer of timers) {
        if (
          !timer.cancelled &&
          timer.at <= targetTime &&
          (nextTimer === undefined ||
            timer.at < nextTimer.at ||
            (timer.at === nextTimer.at && timer.id < nextTimer.id))
        ) nextTimer = timer
      }
      if (nextTimer === undefined) break
      nextTimer.cancelled = true
      currentTime = nextTimer.at
      nextTimer.callback()
    }
    currentTime = targetTime
  }

  return {
    now: () => currentTime,
    schedule,
    advanceBy,
    pendingTimerCount: () => timers.filter((timer) => !timer.cancelled).length
  }
}

type PendingCapture<Value, Error> = {
  readonly request: StartupAdmissionCaptureRequest
  readonly settle: (result: StartupAdmissionCaptureResult<Value, Error>) => void
  cancelled: boolean
}

function createCaptureHarness<Value, Error>() {
  const captures: PendingCapture<Value, Error>[] = []
  const capture: StartupAdmissionCaptureRunner<Value, Error> = (request, settle) => {
    const pending: PendingCapture<Value, Error> = {
      request,
      settle,
      cancelled: false
    }
    captures.push(pending)
    return {
      cancel() {
        pending.cancelled = true
      }
    }
  }
  return { capture, captures }
}

test('startup admission stays quiet until the complete frame is ready', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })

  assert.deepEqual(controller.read(), { phase: 'shell' })

  controller.start()
  assert.deepEqual(controller.read(), {
    phase: 'capturing',
    attempt: 1
  })
  assert.deepEqual(harness.captures[0]?.request, {
    attempt: 1,
    generation: 0,
    startedAt: 0,
    deadlineAt: 5_000,
    remainingMs: 5_000
  })

  time.advanceBy(300)
  assert.deepEqual(controller.read(), {
    phase: 'capturing',
    attempt: 1
  })

  harness.captures[0]?.settle({ ok: true, value: 'live frame' })
  assert.deepEqual(controller.read(), {
    phase: 'ready',
    attempt: 1,
    value: 'live frame'
  })
  assert.equal(time.pendingTimerCount(), 0)
})

test('material changes coalesce and recapture inside the original fixed deadline', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })

  controller.start()
  time.advanceBy(1_000)
  controller.materialChanged()
  controller.materialChanged()

  assert.equal(harness.captures.length, 1)
  assert.equal(harness.captures[0]?.cancelled, true)

  time.advanceBy(0)
  assert.equal(harness.captures.length, 2)
  assert.deepEqual(harness.captures[1]?.request, {
    attempt: 1,
    generation: 2,
    startedAt: 0,
    deadlineAt: 5_000,
    remainingMs: 4_000
  })

  harness.captures[0]?.settle({ ok: true, value: 'stale frame' })
  assert.equal(controller.read().phase, 'capturing')

  time.advanceBy(3_999)
  assert.equal(controller.read().phase, 'capturing')
  time.advanceBy(1)
  assert.deepEqual(controller.read(), {
    phase: 'failed',
    attempt: 1,
    failure: { kind: 'timeout' }
  })
  assert.equal(harness.captures[1]?.cancelled, true)

  harness.captures[1]?.settle({ ok: true, value: 'late frame' })
  assert.equal(controller.read().phase, 'failed')
})

test('delayed material changes invalidate immediately and slide recapture within the fixed deadline', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })

  controller.start()
  time.advanceBy(100)
  controller.materialChanged(200)

  assert.equal(harness.captures[0]?.cancelled, true)
  time.advanceBy(150)
  controller.materialChanged(200)
  time.advanceBy(199)
  assert.equal(harness.captures.length, 1)

  time.advanceBy(1)
  assert.deepEqual(harness.captures[1]?.request, {
    attempt: 1,
    generation: 2,
    startedAt: 0,
    deadlineAt: 5_000,
    remainingMs: 4_550
  })
})

test('a delayed material change from failure also coalesces before the fresh capture', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })

  controller.start()
  harness.captures[0]?.settle({ ok: false, error: 'storage unavailable' })
  controller.materialChanged(200)

  assert.deepEqual(controller.read(), {
    phase: 'capturing',
    attempt: 2
  })
  time.advanceBy(100)
  controller.materialChanged(200)
  time.advanceBy(199)
  assert.equal(harness.captures.length, 1)

  time.advanceBy(1)
  assert.deepEqual(harness.captures[1]?.request, {
    attempt: 2,
    generation: 1,
    startedAt: 0,
    deadlineAt: 5_000,
    remainingMs: 4_700
  })
})

test('capture failure stays failed until visibility or material state changes', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })

  controller.start()
  harness.captures[0]?.settle({ ok: false, error: 'storage unavailable' })
  assert.deepEqual(controller.read(), {
    phase: 'failed',
    attempt: 1,
    failure: { kind: 'capture', error: 'storage unavailable' }
  })

  time.advanceBy(20_000)
  assert.equal(harness.captures.length, 1)
  assert.equal(time.pendingTimerCount(), 0)

  controller.materialChanged()
  assert.deepEqual(harness.captures[1]?.request, {
    attempt: 2,
    generation: 0,
    startedAt: 20_000,
    deadlineAt: 25_000,
    remainingMs: 5_000
  })

  harness.captures[1]?.settle({ ok: false, error: 'still unavailable' })
  time.advanceBy(200)
  controller.visibilityReturned()
  assert.deepEqual(harness.captures[2]?.request, {
    attempt: 3,
    generation: 0,
    startedAt: 20_200,
    deadlineAt: 25_200,
    remainingMs: 5_000
  })

  harness.captures[2]?.settle({ ok: false, error: 'again unavailable' })
  time.advanceBy(200)
  controller.materialChanged()
  assert.deepEqual(harness.captures[3]?.request, {
    attempt: 4,
    generation: 0,
    startedAt: 20_400,
    deadlineAt: 25_400,
    remainingMs: 5_000
  })
})

test('visibility return recaptures inside an active attempt without resetting its deadline', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })

  controller.start()
  time.advanceBy(1_250)
  controller.visibilityReturned()

  assert.equal(harness.captures[0]?.cancelled, true)
  time.advanceBy(0)
  assert.deepEqual(harness.captures[1]?.request, {
    attempt: 1,
    generation: 1,
    startedAt: 0,
    deadlineAt: 5_000,
    remainingMs: 3_750
  })

  harness.captures[0]?.settle({ ok: true, value: 'stale attempt' })
  assert.equal(controller.read().phase, 'capturing')
  harness.captures[1]?.settle({ ok: true, value: 'current attempt' })
  assert.deepEqual(controller.read(), {
    phase: 'ready',
    attempt: 1,
    value: 'current attempt'
  })
})

test('dispose is idempotent and rejects every later completion', () => {
  const time = createTestTime()
  const harness = createCaptureHarness<string, string>()
  const controller = createStartupAdmissionController({
    capture: harness.capture,
    now: time.now,
    schedule: time.schedule
  })
  let notifications = 0
  controller.subscribe(() => { notifications += 1 })

  controller.start()
  assert.equal(notifications, 1)
  controller.dispose()
  controller.dispose()
  assert.equal(harness.captures[0]?.cancelled, true)
  assert.equal(time.pendingTimerCount(), 0)

  harness.captures[0]?.settle({ ok: true, value: 'late frame' })
  time.advanceBy(10_000)
  controller.materialChanged()
  controller.visibilityReturned()

  assert.equal(notifications, 1)
  assert.equal(harness.captures.length, 1)
  assert.equal(controller.read().phase, 'capturing')
})
