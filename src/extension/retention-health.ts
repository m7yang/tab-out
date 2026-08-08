import { Context, Effect, Layer, Schema, Semaphore } from 'effect'

export const RETENTION_HEALTH_STORAGE_KEY = 'tabOutRetentionHealthV1'

export const retentionHealthEpisodeSchema = Schema.Struct({
  failureKind: Schema.Literals(['capture', 'restore']),
  operationKind: Schema.Literals([
    'automatic-capture',
    'retained-ledger-reset',
    'durable-inventory-reset',
    'open-surface-coverage'
  ]),
  retryState: Schema.Literals([
    'exhausted-after-one-retry',
    'not-applicable'
  ]),
  startedAt: Schema.Finite,
  lastFailedAt: Schema.Finite
})

export type RetentionHealthEpisode = typeof retentionHealthEpisodeSchema.Type
export type RetentionHealthFailure = Pick<
  RetentionHealthEpisode,
  'failureKind' | 'operationKind' | 'retryState'
>
export type RetentionHealthOperationKind = RetentionHealthEpisode['operationKind']

export interface RetentionHealthStorageBackend {
  readonly read: () => PromiseLike<unknown>
  readonly write: (episode: RetentionHealthEpisode) => PromiseLike<void>
  readonly clear: () => PromiseLike<void>
}

const isRetentionHealthEpisode = Schema.is(retentionHealthEpisodeSchema)

export function parseRetentionHealthEpisodeValue(
  stored: unknown
): RetentionHealthEpisode | null {
  if (!isRetentionHealthEpisode(stored)) return null
  const allowedKeys = new Set([
    'failureKind',
    'operationKind',
    'retryState',
    'startedAt',
    'lastFailedAt'
  ])
  return Object.keys(stored).every((key) => allowedKeys.has(key)) ? stored : null
}

export class RetentionHealth extends Context.Service<RetentionHealth, {
  readonly getEpisode: () => Effect.Effect<RetentionHealthEpisode | null>
  readonly recordFailure: (
    failure: RetentionHealthFailure
  ) => Effect.Effect<void>
  readonly recordRecovery: (
    operationKind: RetentionHealthOperationKind
  ) => Effect.Effect<void>
}>()('@tab-out/background/RetentionHealth') {
  static layer(
    backend: RetentionHealthStorageBackend,
    now: () => number = Date.now
  ): Layer.Layer<RetentionHealth> {
    const semaphore = Semaphore.makeUnsafe(1)

    const read = Effect.fn('RetentionHealth.read')(function*() {
      const stored = yield* Effect.tryPromise({
        try: backend.read,
        catch: (cause) => cause
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      return parseRetentionHealthEpisodeValue(stored)
    })

    const getEpisode = Effect.fn('RetentionHealth.getEpisode')(function*() {
      return yield* semaphore.withPermit(read())
    })

    const recordFailure = Effect.fn('RetentionHealth.recordFailure')(function*(
      failure: RetentionHealthFailure
    ) {
      yield* semaphore.withPermit(Effect.gen(function*() {
        const current = yield* read()
        const failedAt = now()
        const sameEpisode = current?.failureKind === failure.failureKind &&
          current.operationKind === failure.operationKind &&
          current.retryState === failure.retryState
        const episode: RetentionHealthEpisode = {
          ...failure,
          startedAt: sameEpisode
            ? current.startedAt
            : failedAt,
          lastFailedAt: sameEpisode
            ? Math.max(current.lastFailedAt, failedAt)
            : failedAt
        }
        yield* Effect.tryPromise({
          try: () => backend.write(episode),
          catch: (cause) => cause
        }).pipe(Effect.catchCause(() => Effect.void))
      }))
    })

    const recordRecovery = Effect.fn('RetentionHealth.recordRecovery')(function*(
      operationKind: RetentionHealthOperationKind
    ) {
      yield* semaphore.withPermit(Effect.gen(function*() {
        const current = yield* read()
        if (current?.operationKind !== operationKind) return
        yield* Effect.tryPromise({
          try: backend.clear,
          catch: (cause) => cause
        }).pipe(Effect.catchCause(() => Effect.void))
      }))
    })

    return Layer.succeed(RetentionHealth, RetentionHealth.of({
      getEpisode,
      recordFailure,
      recordRecovery
    }))
  }
}
