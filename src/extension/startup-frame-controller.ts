export const STARTUP_ADMISSION_TIMEOUT_MS = 5_000

export type StartupAdmissionFailure<Error> =
  | { readonly kind: 'capture'; readonly error: Error }
  | { readonly kind: 'timeout' }

export type StartupAdmissionState<Value, Error> =
  | { readonly phase: 'shell' }
  | {
      readonly phase: 'capturing'
      readonly attempt: number
    }
  | {
      readonly phase: 'failed'
      readonly attempt: number
      readonly failure: StartupAdmissionFailure<Error>
    }
  | {
      readonly phase: 'ready'
      readonly attempt: number
      readonly value: Value
    }

export type StartupAdmissionCaptureResult<Value, Error> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error }

export type StartupAdmissionCaptureRequest = {
  readonly attempt: number
  readonly generation: number
  readonly startedAt: number
  readonly deadlineAt: number
  readonly remainingMs: number
}

export type StartupAdmissionCancellation = {
  cancel(): void
}

export type StartupAdmissionCaptureRunner<Value, Error> = (
  request: StartupAdmissionCaptureRequest,
  settle: (result: StartupAdmissionCaptureResult<Value, Error>) => void
) => StartupAdmissionCancellation

export type StartupAdmissionTimer = {
  cancel(): void
}

export type StartupAdmissionSchedule = (
  delayMs: number,
  callback: () => void
) => StartupAdmissionTimer

export type StartupAdmissionControllerOptions<Value, Error> = {
  readonly capture: StartupAdmissionCaptureRunner<Value, Error>
  readonly now?: () => number
  readonly schedule?: StartupAdmissionSchedule
  readonly timeoutMs?: number
}

export type StartupAdmissionController<Value, Error> = {
  read(): StartupAdmissionState<Value, Error>
  subscribe(listener: () => void): () => void
  start(): void
  visibilityReturned(): void
  materialChanged(delayMs?: number): void
  dispose(): void
}

type ActiveAttempt = {
  readonly id: number
  readonly startedAt: number
  readonly deadlineAt: number
  generation: number
  activeCapture: StartupAdmissionCancellation | null
  activeToken: number | null
  deadlineTimer: StartupAdmissionTimer | null
  recaptureTimer: StartupAdmissionTimer | null
}

const scheduleWithPlatformTimer: StartupAdmissionSchedule = (delayMs, callback) => {
  const timer = globalThis.setTimeout(callback, delayMs)
  return {
    cancel() {
      globalThis.clearTimeout(timer)
    }
  }
}

export function createStartupAdmissionController<Value, Error>(
  options: StartupAdmissionControllerOptions<Value, Error>
): StartupAdmissionController<Value, Error> {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? scheduleWithPlatformTimer
  const timeoutMs = options.timeoutMs ?? STARTUP_ADMISSION_TIMEOUT_MS
  const listeners = new Set<() => void>()

  let state: StartupAdmissionState<Value, Error> = { phase: 'shell' }
  let activeAttempt: ActiveAttempt | null = null
  let attemptSequence = 0
  let tokenSequence = 0
  let disposed = false

  const normalizedDelay = (delayMs: number) =>
    Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0

  const publish = (nextState: StartupAdmissionState<Value, Error>) => {
    if (disposed) return
    state = nextState
    for (const listener of listeners) listener()
  }

  const cancelActiveCapture = (attempt: ActiveAttempt) => {
    attempt.activeToken = null
    const capture = attempt.activeCapture
    attempt.activeCapture = null
    capture?.cancel()
  }

  const cancelTimer = (
    attempt: ActiveAttempt,
    key: 'deadlineTimer' | 'recaptureTimer'
  ) => {
    const timer = attempt[key]
    attempt[key] = null
    timer?.cancel()
  }

  const endAttempt = (attempt: ActiveAttempt) => {
    cancelActiveCapture(attempt)
    cancelTimer(attempt, 'deadlineTimer')
    cancelTimer(attempt, 'recaptureTimer')
    if (activeAttempt === attempt) activeAttempt = null
  }

  const failForTimeout = (attempt: ActiveAttempt) => {
    if (activeAttempt !== attempt || state.phase !== 'capturing') return
    endAttempt(attempt)
    publish({
      phase: 'failed',
      attempt: attempt.id,
      failure: { kind: 'timeout' }
    })
  }

  const settleCapture = (
    attempt: ActiveAttempt,
    token: number,
    result: StartupAdmissionCaptureResult<Value, Error>
  ) => {
    if (
      disposed ||
      activeAttempt !== attempt ||
      attempt.activeToken !== token ||
      state.phase !== 'capturing'
    ) return

    attempt.activeToken = null
    attempt.activeCapture = null

    if (now() >= attempt.deadlineAt) {
      failForTimeout(attempt)
      return
    }

    if (!result.ok) {
      endAttempt(attempt)
      publish({
        phase: 'failed',
        attempt: attempt.id,
        failure: { kind: 'capture', error: result.error }
      })
      return
    }

    endAttempt(attempt)
    publish({ phase: 'ready', attempt: attempt.id, value: result.value })
  }

  const beginCapture = (attempt: ActiveAttempt) => {
    if (
      disposed ||
      activeAttempt !== attempt ||
      state.phase !== 'capturing'
    ) return

    const capturedAt = now()
    if (capturedAt >= attempt.deadlineAt) {
      failForTimeout(attempt)
      return
    }

    const token = ++tokenSequence
    attempt.activeToken = token
    const capture = options.capture({
      attempt: attempt.id,
      generation: attempt.generation,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      remainingMs: attempt.deadlineAt - capturedAt
    }, (result) => {
      settleCapture(attempt, token, result)
    })

    if (
      disposed ||
      activeAttempt !== attempt ||
      attempt.activeToken !== token ||
      state.phase !== 'capturing'
    ) {
      capture.cancel()
      return
    }
    attempt.activeCapture = capture
  }

  const startAttempt = (captureDelayMs = 0) => {
    if (disposed || state.phase === 'ready') return
    if (activeAttempt !== null) endAttempt(activeAttempt)

    const startedAt = now()
    const attempt: ActiveAttempt = {
      id: ++attemptSequence,
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      generation: 0,
      activeCapture: null,
      activeToken: null,
      deadlineTimer: null,
      recaptureTimer: null
    }
    activeAttempt = attempt
    publish({
      phase: 'capturing',
      attempt: attempt.id
    })

    attempt.deadlineTimer = schedule(timeoutMs, () => {
      attempt.deadlineTimer = null
      failForTimeout(attempt)
    })

    const initialCaptureDelayMs = normalizedDelay(captureDelayMs)
    if (initialCaptureDelayMs > 0) {
      attempt.recaptureTimer = schedule(initialCaptureDelayMs, () => {
        attempt.recaptureTimer = null
        beginCapture(attempt)
      })
    } else {
      beginCapture(attempt)
    }
  }

  const materialChanged = (delayMs = 0) => {
    if (disposed || state.phase === 'ready') return
    if (state.phase === 'shell' || state.phase === 'failed') {
      startAttempt(delayMs)
      return
    }

    const attempt = activeAttempt
    if (attempt === null) return
    attempt.generation += 1
    cancelActiveCapture(attempt)

    if (now() >= attempt.deadlineAt) {
      failForTimeout(attempt)
      return
    }

    cancelTimer(attempt, 'recaptureTimer')
    const recaptureDelayMs = normalizedDelay(delayMs)
    attempt.recaptureTimer = schedule(recaptureDelayMs, () => {
      attempt.recaptureTimer = null
      beginCapture(attempt)
    })
  }

  return {
    read() {
      return state
    },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (state.phase === 'shell') startAttempt()
    },
    visibilityReturned() {
      if (state.phase === 'shell' || state.phase === 'failed') {
        startAttempt()
        return
      }
      if (state.phase === 'capturing') materialChanged()
    },
    materialChanged,
    dispose() {
      if (disposed) return
      disposed = true
      if (activeAttempt !== null) endAttempt(activeAttempt)
      listeners.clear()
    }
  }
}
