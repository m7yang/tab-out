import { Context, Deferred, Effect, Exit, Layer, Ref, Schema, Semaphore } from 'effect'

import {
  emptyOpenSurfaceInventory,
  markOpenSurfaceClosures,
  observeOpenSurface as observeOpenSurfaceInventory,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
  openSurfaceInventoriesEqual,
  removeOpenSurface,
  removeOpenSurfaceLifetimes,
  transferOpenSurfaceLifetime,
  type OpenSurfaceInventory,
  type OpenSurfaceInventoryEntry,
  type OpenSurfaceInventoryOptions,
  type OpenSurfaceObservation
} from '../open-surface-inventory.js'
import {
  OpenSurfaceInventoryStorage,
  type OpenSurfaceInventoryParseResult,
  type OpenSurfaceInventoryStorageError
} from '../open-surface-inventory-storage.js'
import {
  reconcileOpenSurfaces as reconcileOpenSurfaceInventories,
  type OpenSurfaceReconciliationMode
} from '../open-surface-reconciliation.js'
import {
  createRetainedPageLedgerPruneCache,
  recordRetainedPageClosure,
  recordRetainedPageClosures,
  removeRetainedPageSnapshot,
  RETAINED_PAGE_LIFETIME_MS,
  type RecordRetainedPageClosureOutcome,
  type RecordRetainedPageClosureResult,
  type RemoveRetainedPageSnapshotResult,
  type RetainedPageClosure,
  type RetainedPageLedger,
  type RetainedPageRecord
} from '../retained-pages-ledger.js'
import {
  RetainedPageLedgerStorage,
  type RetainedPageLedgerStorageError
} from '../retained-pages-storage.js'
import { RetentionHealth } from '../retention-health.js'
import type { RetainedPageActivationDisposition } from '../runtime-messages.js'
import type { GuardedOpenSurfaceCapture } from './adjacent-open-surface-batcher.js'

export type { RetainedPageActivationDisposition } from '../runtime-messages.js'

class RetainedPagesNewerVersionError extends Schema.TaggedErrorClass<RetainedPagesNewerVersionError>()(
  'RetainedPagesNewerVersionError',
  {}
) {}

export interface RetainedPagesOptions {
  readonly now: () => number
  readonly runtimeId?: string | null
  readonly closureTokenFactory?: () => string
  readonly recoverSnapshot?: (
    page: RetainedPageRecord,
    disposition: RetainedPageActivationDisposition,
    currentWindowId?: number
  ) => PromiseLike<boolean>
}

export type ActivateRetainedPageSnapshotResult = {
  readonly outcome:
    | 'activated'
    | 'activated-newer-retained'
    | 'activated-unconsumed'
    | 'stale'
    | 'failed'
}

interface RetainedPageActivationFlight {
  readonly completion: Deferred.Deferred<
    ActivateRetainedPageSnapshotResult,
    RetainedPagesFailure
  >
  readonly shouldStart: boolean
}

export type CaptureClosedSurfaceResult =
  | RecordRetainedPageClosureResult
  | { changed: false; outcome: 'missing' }

type CaptureClosedSurfaceOutcome =
  | RecordRetainedPageClosureOutcome
  | { changed: false; outcome: 'missing' }

export interface CaptureClosedSurfacesResult {
  readonly ledger: RetainedPageLedger | null
  readonly results: readonly CaptureClosedSurfaceOutcome[]
}

type RetainedPagesFailure =
  | OpenSurfaceInventoryStorageError
  | RetainedPageLedgerStorageError
  | RetainedPagesNewerVersionError

interface OpenSurfaceInventoryPair {
  durable: OpenSurfaceInventoryParseResult
  durableAvailable: boolean
  inventory: OpenSurfaceInventory
  session: OpenSurfaceInventoryParseResult
  sessionAvailable: boolean
}

type InventoryWriteState = 'failed' | 'skipped' | 'succeeded'

interface InventoryWriteResult {
  durable: InventoryWriteState
  session: InventoryWriteState
}

export class RetainedPages extends Context.Service<RetainedPages, {
  readonly activateSnapshot: (
    identityDigest: string,
    closureToken: string,
    disposition: RetainedPageActivationDisposition,
    currentWindowId?: number
  ) => Effect.Effect<ActivateRetainedPageSnapshotResult, RetainedPagesFailure>
  readonly captureClosure: (
    closure: RetainedPageClosure
  ) => Effect.Effect<RecordRetainedPageClosureResult, RetainedPagesFailure>
  readonly captureClosedSurface: (
    tabId: number
  ) => Effect.Effect<CaptureClosedSurfaceResult, RetainedPagesFailure>
  readonly captureClosedSurfaces: (
    tabIds: readonly number[]
  ) => Effect.Effect<CaptureClosedSurfacesResult, RetainedPagesFailure>
  readonly checkpointOpenSurfaces: (
    captures: PromiseLike<readonly GuardedOpenSurfaceCapture[]>
  ) => Effect.Effect<void, RetainedPagesFailure>
  readonly getLedger: () => Effect.Effect<RetainedPageLedger, RetainedPagesFailure>
  readonly observeOpenSurface: (
    observation: OpenSurfaceObservation | PromiseLike<OpenSurfaceObservation | null>
  ) => Effect.Effect<void, RetainedPagesFailure>
  readonly observeOpenSurfaces: (
    observations:
      | readonly OpenSurfaceObservation[]
      | PromiseLike<readonly OpenSurfaceObservation[]>
  ) => Effect.Effect<void, RetainedPagesFailure>
  readonly removeSnapshot: (
    identityDigest: string,
    closureToken: string
  ) => Effect.Effect<RemoveRetainedPageSnapshotResult, RetainedPagesFailure>
  readonly reconcileOpenSurfaces: (
    mode: OpenSurfaceReconciliationMode,
    current:
      | readonly OpenSurfaceObservation[]
      | PromiseLike<readonly OpenSurfaceObservation[]>
  ) => Effect.Effect<{ inferredClosures: number }, RetainedPagesFailure>
  readonly replaceOpenSurface: (
    removedTabId: number,
    replacement: OpenSurfaceObservation | PromiseLike<OpenSurfaceObservation | null>
  ) => Effect.Effect<void, RetainedPagesFailure>
}>()('@tab-out/background/RetainedPages') {
  static layer(
    options: RetainedPagesOptions
  ): Layer.Layer<
    RetainedPages,
    never,
    OpenSurfaceInventoryStorage | RetainedPageLedgerStorage | RetentionHealth
  > {
    return makeRetainedPagesLayer(options)
  }
}

function makeRetainedPagesLayer(
  options: RetainedPagesOptions
): Layer.Layer<
  RetainedPages,
  never,
  OpenSurfaceInventoryStorage | RetainedPageLedgerStorage | RetentionHealth
> {
  return Layer.effect(RetainedPages, Effect.gen(function*() {
    const storage = yield* RetainedPageLedgerStorage
    const inventoryStorage = yield* OpenSurfaceInventoryStorage
    const health = yield* RetentionHealth
    const mutationSemaphore = Semaphore.makeUnsafe(1)
    const pruneLedger = createRetainedPageLedgerPruneCache()
    const activationFlights = yield* Ref.make<ReadonlyMap<
      string,
      Deferred.Deferred<ActivateRetainedPageSnapshotResult, RetainedPagesFailure>
    >>(new Map())

    const readLedger = Effect.fn('RetainedPages.readLedger')(function*() {
      const parsed = yield* storage.read()
      if (parsed.status === 'newer') {
        return yield* RetainedPagesNewerVersionError.make()
      }
      if (parsed.status === 'malformed') {
        yield* health.recordFailure({
          failureKind: 'restore',
          operationKind: 'retained-ledger-reset',
          retryState: 'not-applicable'
        })
      }
      return {
        ledger: parsed.ledger,
        malformed: parsed.status === 'malformed'
      }
    })

    function writeAutomaticCapture(
      ledger: RetainedPageLedger,
      recoverLedgerReset: boolean
    ): Effect.Effect<void, RetainedPageLedgerStorageError> {
      return storage.write(ledger).pipe(
        Effect.catchTag('RetainedPageLedgerStorageError', () => storage.write(ledger)),
        Effect.tap(() => health.recordRecovery('automatic-capture').pipe(
          Effect.andThen(recoverLedgerReset
            ? health.recordRecovery('retained-ledger-reset')
            : Effect.void)
        )),
        Effect.catchTag('RetainedPageLedgerStorageError', (error) =>
          health.recordFailure({
            failureKind: 'capture',
            operationKind: 'automatic-capture',
            retryState: 'exhausted-after-one-retry'
          }).pipe(Effect.andThen(Effect.fail(error))))
      )
    }

    function inventoryOptions(): OpenSurfaceInventoryOptions {
      return {
        ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
        ...(options.closureTokenFactory ? {
          closureTokenFactory: options.closureTokenFactory
        } : {})
      }
    }

    function closureFromInventoryEntry(
      entry: OpenSurfaceInventoryEntry,
      fallbackClosedAt: number
    ): RetainedPageClosure {
      return {
        identityDigest: entry.identityDigest,
        surfaceKind: entry.surfaceKind,
        canonicalKey: entry.canonicalKey,
        url: entry.url,
        title: entry.title,
        ...(entry.favIconUrl ? { favIconUrl: entry.favIconUrl } : {}),
        closedAt: entry.closedAt ?? fallbackClosedAt,
        closureToken: entry.closureToken
      }
    }

    const captureInventoryClosures = Effect.fn('RetainedPages.captureInventoryClosures')(
      function*(entries: readonly OpenSurfaceInventoryEntry[], observedAt: number) {
        if (entries.length === 0) return
        const stored = yield* readLedger()
        const pruned = pruneLedger(stored.ledger, observedAt)
        const closures: RetainedPageClosure[] = []
        for (const entry of entries) {
          const closedAt = entry.closedAt ?? observedAt
          if (closedAt + RETAINED_PAGE_LIFETIME_MS <= observedAt) continue
          closures.push(closureFromInventoryEntry(entry, observedAt))
        }
        const recorded = recordRetainedPageClosures(pruned.ledger, closures)
        const changed = stored.malformed || pruned.changed || recorded.changed
        if (changed) yield* writeAutomaticCapture(recorded.ledger, !stored.malformed)
      }
    )

    function inventoryWithMarkedClosures(
      inventory: OpenSurfaceInventory,
      entries: readonly OpenSurfaceInventoryEntry[],
      observedAt: number
    ): OpenSurfaceInventory {
      return markOpenSurfaceClosures(inventory, entries.map((entry) => ({
        tabId: entry.tabId,
        closedAt: entry.closedAt ?? observedAt,
        closureToken: entry.closureToken
      }))).inventory
    }

    function entriesWithStableClosureTime(
      entries: readonly OpenSurfaceInventoryEntry[],
      observedAt: number
    ): OpenSurfaceInventoryEntry[] {
      return entries.map((entry) => entry.closedAt === undefined
        ? { ...entry, closedAt: observedAt }
        : entry)
    }

    function usableInventory(
      parsed: OpenSurfaceInventoryParseResult
    ): OpenSurfaceInventory | null {
      return parsed.status === 'valid' || parsed.status === 'malformed'
        ? parsed.inventory
        : null
    }

    function mergedInventory(
      session: OpenSurfaceInventoryParseResult,
      durable: OpenSurfaceInventoryParseResult
    ): OpenSurfaceInventory {
      const durableInventory = usableInventory(durable)
      const sessionInventory = usableInventory(session)
      const entries: Record<string, OpenSurfaceInventoryEntry> = {}
      const tabIdByClosureToken = new Map<string, string>()

      function installEntry(tabId: string, entry: OpenSurfaceInventoryEntry): void {
        const tokenAliasTabId = tabIdByClosureToken.get(entry.closureToken)
        const tokenAlias = tokenAliasTabId === undefined
          ? undefined
          : entries[tokenAliasTabId]
        const replacedAtTabId = entries[tabId]
        if (
          replacedAtTabId &&
          replacedAtTabId.closureToken !== entry.closureToken &&
          tabIdByClosureToken.get(replacedAtTabId.closureToken) === tabId
        ) {
          tabIdByClosureToken.delete(replacedAtTabId.closureToken)
        }
        if (tokenAliasTabId !== undefined && tokenAliasTabId !== tabId) {
          delete entries[tokenAliasTabId]
        }
        const priorClosedAt = tokenAlias?.closedAt
        const closedAt = priorClosedAt === undefined
          ? entry.closedAt
          : entry.closedAt === undefined
            ? priorClosedAt
            : Math.min(priorClosedAt, entry.closedAt)
        entries[tabId] = {
          ...entry,
          ...(closedAt === undefined ? {} : { closedAt })
        }
        tabIdByClosureToken.set(entry.closureToken, tabId)
      }

      for (const [tabId, entry] of Object.entries(durableInventory?.entries || {})) {
        installEntry(tabId, entry)
      }
      // Session state owns the current tab id and metadata. Matching durable
      // aliases contribute only an earlier checkpointed close time.
      for (const [tabId, entry] of Object.entries(sessionInventory?.entries || {})) {
        installEntry(tabId, entry)
      }
      return {
        schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
        identityVersion: 1,
        entries
      }
    }

    const readInventoryPair = Effect.fn('RetainedPages.readInventoryPair')(
      function*(failureKind: 'capture' | 'restore' = 'capture') {
        const [sessionExit, durableExit] = yield* Effect.all([
          Effect.exit(inventoryStorage.readSession()),
          Effect.exit(inventoryStorage.readDurable())
        ] as const, { concurrency: 'unbounded' })
        const sessionAvailable = Exit.isSuccess(sessionExit)
        const durableAvailable = Exit.isSuccess(durableExit)
        const session: OpenSurfaceInventoryParseResult = sessionAvailable
          ? sessionExit.value
          : { status: 'missing', inventory: emptyOpenSurfaceInventory() }
        const durable: OpenSurfaceInventoryParseResult = durableAvailable
          ? durableExit.value
          : { status: 'missing', inventory: emptyOpenSurfaceInventory() }

        const coverageIncomplete = !sessionAvailable || !durableAvailable ||
          session.status === 'newer' || durable.status === 'newer'
        if (coverageIncomplete) {
          yield* health.recordFailure({
            failureKind,
            operationKind: 'open-surface-coverage',
            retryState: 'not-applicable'
          })
        } else {
          yield* health.recordRecovery('open-surface-coverage')
        }
        if (durableAvailable && durable.status === 'malformed') {
          yield* health.recordFailure({
            failureKind: 'restore',
            operationKind: 'durable-inventory-reset',
            retryState: 'not-applicable'
          })
        } else if (durableAvailable && durable.status === 'valid') {
          yield* health.recordRecovery('durable-inventory-reset')
        }

        return {
          durable,
          durableAvailable,
          inventory: mergedInventory(session, durable),
          session,
          sessionAvailable
        }
      }
    )

    function inventoryNeedsWrite(
      parsed: OpenSurfaceInventoryParseResult,
      inventory: OpenSurfaceInventory
    ): boolean {
      return parsed.status !== 'newer' && (
        parsed.status !== 'valid' ||
        !openSurfaceInventoriesEqual(parsed.inventory, inventory)
      )
    }

    const persistInventoryCopies = Effect.fn('RetainedPages.persistInventoryCopies')(
      function*(
        pair: OpenSurfaceInventoryPair,
        copies: { session: OpenSurfaceInventory; durable: OpenSurfaceInventory },
        failureKind: 'capture' | 'restore' = 'capture',
        force = false
      ) {
        const sessionWrite = pair.sessionAvailable &&
          pair.session.status !== 'newer' &&
          (force || inventoryNeedsWrite(pair.session, copies.session))
          ? Effect.exit(inventoryStorage.writeSession(copies.session))
          : Effect.succeed(null)
        const durableWrite = pair.durableAvailable &&
          pair.durable.status !== 'newer' &&
          (force || inventoryNeedsWrite(pair.durable, copies.durable))
          ? Effect.exit(inventoryStorage.writeDurable(copies.durable))
          : Effect.succeed(null)
        const [sessionExit, durableExit] = yield* Effect.all([
          sessionWrite,
          durableWrite
        ] as const, { concurrency: 'unbounded' })
        const result: InventoryWriteResult = {
          session: sessionExit === null
            ? 'skipped'
            : Exit.isSuccess(sessionExit) ? 'succeeded' : 'failed',
          durable: durableExit === null
            ? 'skipped'
            : Exit.isSuccess(durableExit) ? 'succeeded' : 'failed'
        }
        if (result.session === 'failed' || result.durable === 'failed') {
          yield* health.recordFailure({
            failureKind,
            operationKind: 'open-surface-coverage',
            retryState: 'not-applicable'
          })
        } else if (
          pair.sessionAvailable &&
          pair.durableAvailable &&
          pair.session.status !== 'newer' &&
          pair.durable.status !== 'newer'
        ) {
          yield* health.recordRecovery('open-surface-coverage')
        }
        return result
      }
    )

    const persistObservedInventory = Effect.fn('RetainedPages.persistObservedInventory')(
      function*(
        pair: OpenSurfaceInventoryPair,
        inventory: OpenSurfaceInventory,
        failureKind: 'capture' | 'restore' = 'capture',
        force = false
      ) {
        return yield* persistInventoryCopies(
          pair,
          { session: inventory, durable: inventory },
          failureKind,
          force
        )
      }
    )

    const captureClosure = Effect.fn('RetainedPages.captureClosure')(function*(
      closure: RetainedPageClosure
    ) {
      return yield* mutationSemaphore.withPermit(Effect.gen(function*() {
        const observedAt = options.now()
        const stored = yield* readLedger()
        const pruned = pruneLedger(stored.ledger, observedAt)
        const normalizedClosure = Number.isSafeInteger(closure.closedAt) &&
          closure.closedAt >= 0 && closure.closedAt <= observedAt
          ? closure
          : { ...closure, closedAt: observedAt }
        if (normalizedClosure.closedAt + RETAINED_PAGE_LIFETIME_MS <= observedAt) {
          if (stored.malformed || pruned.changed) {
            yield* writeAutomaticCapture(pruned.ledger, !stored.malformed)
          }
          return {
            ledger: pruned.ledger,
            changed: false,
            outcome: 'stale'
          } as const
        }
        const result = recordRetainedPageClosure(pruned.ledger, normalizedClosure)
        if (stored.malformed || pruned.changed || result.changed) {
          yield* writeAutomaticCapture(result.ledger, !stored.malformed)
        }
        return result
      }))
    })

    const captureClosedSurfaces = Effect.fn('RetainedPages.captureClosedSurfaces')(
      function*(tabIds: readonly number[]) {
        return yield* mutationSemaphore.withPermit(Effect.gen(function*() {
          const uniqueTabIds = [...new Set(tabIds.filter(Number.isInteger))]
          if (uniqueTabIds.length === 0) return { ledger: null, results: [] }

          const pair = yield* readInventoryPair()
          const observedAt = options.now()
          const marked = markOpenSurfaceClosures(
            pair.inventory,
            uniqueTabIds.map((tabId) => {
              const candidate = pair.inventory.entries[String(tabId)]
              return {
                tabId,
                closedAt: candidate?.closedAt ?? observedAt,
                ...(candidate ? { closureToken: candidate.closureToken } : {})
              }
            })
          )
          const markedInventory = marked.inventory
          const candidates = marked.entries
          // Persist the lifetime's first closure time before the ledger commit.
          // If ledger commit or later cleanup is interrupted, replay reuses this
          // timestamp instead of granting the page a fresh 30-day lifetime.
          yield* persistObservedInventory(pair, markedInventory)
          if (candidates.every((candidate) => candidate === null)) {
            return {
              ledger: null,
              results: candidates.map(() => ({
                changed: false as const,
                outcome: 'missing' as const
              }))
            }
          }

          const results: Array<CaptureClosedSurfaceOutcome | null> = []
          const capturedCandidates: OpenSurfaceInventoryEntry[] = []
          const stored = candidates.some(Boolean) ? yield* readLedger() : null
          const pruned = stored
            ? pruneLedger(stored.ledger, observedAt)
            : null
          let ledger = pruned?.ledger
          let ledgerChanged = !!stored?.malformed || !!pruned?.changed
          const closures: RetainedPageClosure[] = []
          const closureResultIndexes: number[] = []

          for (const candidate of candidates) {
            if (!candidate || !ledger) {
              results.push({ changed: false, outcome: 'missing' })
              continue
            }
            capturedCandidates.push(candidate)
            if (
              (candidate.closedAt ?? observedAt) + RETAINED_PAGE_LIFETIME_MS <=
              observedAt
            ) {
              results.push(null)
              continue
            }
            closureResultIndexes.push(results.length)
            closures.push(closureFromInventoryEntry(candidate, observedAt))
            results.push(null)
          }

          if (ledger) {
            const recorded = recordRetainedPageClosures(ledger, closures)
            ledger = recorded.ledger
            ledgerChanged ||= recorded.changed
            for (const [index, result] of recorded.results.entries()) {
              const resultIndex = closureResultIndexes[index]
              if (resultIndex !== undefined) {
                results[resultIndex] = result
              }
            }
            for (const [index, result] of results.entries()) {
              if (result === null) {
                results[index] = { changed: false, outcome: 'replayed' }
              }
            }
          }

          if (ledger && ledgerChanged) {
            yield* writeAutomaticCapture(ledger, !stored?.malformed)
          }

          const cleanedInventory = removeOpenSurfaceLifetimes(
            markedInventory,
            capturedCandidates
          ).inventory
          yield* persistObservedInventory(
            pair,
            cleanedInventory,
            'capture',
            true
          )
          return {
            ledger: ledger ?? null,
            results: results.filter(
              (result): result is CaptureClosedSurfaceOutcome => result !== null
            )
          }
        }))
      }
    )

    const captureClosedSurface = Effect.fn('RetainedPages.captureClosedSurface')(
      function*(tabId: number) {
        const captured = yield* captureClosedSurfaces([tabId])
        const result = captured.results[0]
        if (!result || result.outcome === 'missing' || !captured.ledger) {
          return { changed: false, outcome: 'missing' } as const
        }
        return { ledger: captured.ledger, ...result }
      }
    )

    const getLedger = Effect.fn('RetainedPages.getLedger')(function*() {
      return yield* mutationSemaphore.withPermit(Effect.gen(function*() {
        const stored = yield* readLedger()
        const pruned = pruneLedger(stored.ledger, options.now())
        if (stored.malformed) {
          yield* storage.write(pruned.ledger)
        } else if (pruned.changed) {
          yield* storage.write(pruned.ledger).pipe(
            Effect.tap(() => health.recordRecovery('retained-ledger-reset')),
            Effect.catchTag('RetainedPageLedgerStorageError', () => Effect.void)
          )
        }
        return pruned.ledger
      }))
    })

    const observeOpenSurfaces = Effect.fn('RetainedPages.observeOpenSurfaces')(function*(
      observations:
        | readonly OpenSurfaceObservation[]
        | PromiseLike<readonly OpenSurfaceObservation[]>
    ) {
      yield* mutationSemaphore.withPermit(Effect.gen(function*() {
        const captured = yield* Effect.promise(() => Promise.resolve(observations))
        if (captured.length === 0) return
        const pair = yield* readInventoryPair()
        let inventory = pair.inventory
        for (const observation of captured) {
          const observed = yield* Effect.promise(() => observeOpenSurfaceInventory(
            inventory,
            observation,
            inventoryOptions()
          ))
          inventory = observed.inventory
        }
        yield* persistObservedInventory(pair, inventory)
      }))
    })

    const checkpointOpenSurfaces = Effect.fn('RetainedPages.checkpointOpenSurfaces')(
      function*(captures: PromiseLike<readonly GuardedOpenSurfaceCapture[]>) {
        yield* mutationSemaphore.withPermit(Effect.gen(function*() {
          const captured = yield* Effect.promise(() => Promise.resolve(captures))
          if (!captured.some((candidate) => candidate.isCurrent())) return

          const pair = yield* readInventoryPair()
          let inventory = pair.inventory
          let unavailableCapture = false
          for (const candidate of captured) {
            if (!candidate.isCurrent()) continue
            const capture = candidate.capture
            if (capture.status === 'unavailable') {
              unavailableCapture = true
              continue
            }
            if (capture.status === 'ineligible') {
              inventory = removeOpenSurface(inventory, candidate.tabId).inventory
              continue
            }

            const observed = yield* Effect.promise(() => observeOpenSurfaceInventory(
              inventory,
              capture.observation,
              inventoryOptions()
            ))
            // Identity hashing is asynchronous. A close or newer observation
            // may have invalidated this capture while the digest was pending.
            if (candidate.isCurrent()) inventory = observed.inventory
          }
          yield* persistObservedInventory(pair, inventory)
          if (unavailableCapture) {
            yield* health.recordFailure({
              failureKind: 'capture',
              operationKind: 'open-surface-coverage',
              retryState: 'not-applicable'
            })
          }
        }))
      }
    )

    const observeOpenSurface = Effect.fn('RetainedPages.observeOpenSurface')(function*(
      observation: OpenSurfaceObservation | PromiseLike<OpenSurfaceObservation | null>
    ) {
      yield* observeOpenSurfaces(Promise.resolve(observation).then((captured) =>
        captured ? [captured] : []
      ))
    })

    const removeSnapshot = Effect.fn('RetainedPages.removeSnapshot')(function*(
      identityDigest: string,
      closureToken: string
    ) {
      return yield* mutationSemaphore.withPermit(Effect.gen(function*() {
        const stored = yield* readLedger()
        const pruned = pruneLedger(stored.ledger, options.now())
        const result = removeRetainedPageSnapshot(
          pruned.ledger,
          identityDigest,
          closureToken
        )
        if (stored.malformed || pruned.changed || result.changed) {
          const write = storage.write(result.ledger).pipe(
            Effect.tap(() => stored.malformed
              ? Effect.void
              : health.recordRecovery('retained-ledger-reset'))
          )
          if (
            result.outcome === 'already-absent' &&
            pruned.changed &&
            !stored.malformed
          ) {
            // Expiry is already authoritative for presentation and action
            // semantics. A failed cleanup write may be retried by later
            // material work, but cannot turn an expired removal into failure.
            yield* write.pipe(
              Effect.catchTag('RetainedPageLedgerStorageError', () => Effect.void)
            )
          } else {
            yield* write
          }
        }
        return result
      }))
    })

    const readActivationSnapshot = Effect.fn('RetainedPages.readActivationSnapshot')(
      function*(identityDigest: string, closureToken: string) {
        return yield* mutationSemaphore.withPermit(Effect.gen(function*() {
          const stored = yield* readLedger()
          const pruned = pruneLedger(stored.ledger, options.now())
          if (stored.malformed || pruned.changed) {
            // Activation is user-initiated, so this cleanup write deliberately
            // has no automatic retry. An uncommitted cleanup is unknown state.
            yield* storage.write(pruned.ledger).pipe(
              Effect.tap(() => stored.malformed
                ? Effect.void
                : health.recordRecovery('retained-ledger-reset'))
            )
          }
          const page = pruned.ledger.pages[identityDigest]
          return page?.closureToken === closureToken ? page : null
        }))
      }
    )

    const runActivation = Effect.fn('RetainedPages.runActivation')(function*(
      identityDigest: string,
      closureToken: string,
      disposition: RetainedPageActivationDisposition,
      currentWindowId?: number
    ) {
      const page = yield* readActivationSnapshot(identityDigest, closureToken)
      if (!page) return { outcome: 'stale' } as const

      const recovered = yield* Effect.promise(() => Promise.resolve()
        .then(() => options.recoverSnapshot?.(page, disposition, currentWindowId) ?? false)
        .then(Boolean)
        .catch(() => false))
      if (!recovered) return { outcome: 'failed' } as const

      return yield* removeSnapshot(identityDigest, closureToken).pipe(
        Effect.map((result): ActivateRetainedPageSnapshotResult => ({
          outcome: result.outcome === 'stale'
            ? 'activated-newer-retained'
            : 'activated'
        })),
        Effect.catchCause(() => Effect.succeed({
          outcome: 'activated-unconsumed'
        } as const))
      )
    })

    const activateSnapshot = Effect.fn('RetainedPages.activateSnapshot')(function*(
      identityDigest: string,
      closureToken: string,
      disposition: RetainedPageActivationDisposition,
      currentWindowId?: number
    ) {
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
        const candidate = yield* Deferred.make<
          ActivateRetainedPageSnapshotResult,
          RetainedPagesFailure
        >()
        const flight = yield* Ref.modify(activationFlights, (
          current
        ): readonly [
          RetainedPageActivationFlight,
          ReadonlyMap<
            string,
            Deferred.Deferred<ActivateRetainedPageSnapshotResult, RetainedPagesFailure>
          >
        ] => {
          const existing = current.get(identityDigest)
          if (existing) {
            return [{ completion: existing, shouldStart: false }, current]
          }
          const next = new Map(current)
          next.set(identityDigest, candidate)
          return [{ completion: candidate, shouldStart: true }, next]
        })

        if (flight.shouldStart) {
          const clearFlight = Ref.update(activationFlights, (current) => {
            if (current.get(identityDigest) !== flight.completion) return current
            const next = new Map(current)
            next.delete(identityDigest)
            return next
          })
          yield* Deferred.complete(
            flight.completion,
            restore(runActivation(
              identityDigest,
              closureToken,
              disposition,
              currentWindowId
            )).pipe(
              Effect.ensuring(clearFlight)
            )
          )
        }

        return yield* restore(Deferred.await(flight.completion))
      }))
    })

    const reconcileOpenSurfaces = Effect.fn('RetainedPages.reconcileOpenSurfaces')(
      function*(
        mode: OpenSurfaceReconciliationMode,
        current:
          | readonly OpenSurfaceObservation[]
          | PromiseLike<readonly OpenSurfaceObservation[]>
      ) {
        return yield* mutationSemaphore.withPermit(Effect.gen(function*() {
          const capturedCurrent = yield* Effect.promise(() => Promise.resolve(current)).pipe(
            Effect.tapCause(() => health.recordFailure({
              failureKind: 'restore',
              operationKind: 'open-surface-coverage',
              retryState: 'not-applicable'
            }))
          )
          const pair = yield* readInventoryPair('restore')
          if (mode === 'first-install') {
            const result = yield* Effect.promise(() => reconcileOpenSurfaceInventories({
              mode,
              session: null,
              durable: null,
              current: capturedCurrent,
              options: inventoryOptions()
            }))
            yield* persistObservedInventory(pair, result.inventory, 'restore')
            return { inferredClosures: 0 }
          }

          const sessionInventory = usableInventory(pair.session)
          const durableInventory = usableInventory(pair.durable)
          const effectiveMode = mode === 'worker-resume' &&
            (pair.session.status === 'missing' || pair.session.status === 'newer')
            ? 'extension-reload'
            : mode
          const result = yield* Effect.promise(() => reconcileOpenSurfaceInventories({
            mode: effectiveMode,
            session: sessionInventory,
            durable: durableInventory,
            current: capturedCurrent,
            options: inventoryOptions()
          }))

          const observedAt = options.now()
          const stableClosures = entriesWithStableClosureTime(
            result.inferredClosures,
            observedAt
          )
          if (stableClosures.length > 0) {
            // Checkpoint the first accepted closure time in whichever source
            // inventory owns each lifetime before committing the ledger.
            yield* persistInventoryCopies(pair, {
              session: inventoryWithMarkedClosures(
                pair.session.status === 'newer'
                  ? emptyOpenSurfaceInventory()
                  : pair.session.inventory,
                stableClosures,
                observedAt
              ),
              durable: inventoryWithMarkedClosures(
                pair.durable.status === 'newer'
                  ? emptyOpenSurfaceInventory()
                  : pair.durable.inventory,
                stableClosures,
                observedAt
              )
            }, 'restore', true)
          }
          yield* captureInventoryClosures(stableClosures, observedAt)
          yield* persistObservedInventory(
            pair,
            result.inventory,
            'restore',
            stableClosures.length > 0
          )
          return { inferredClosures: stableClosures.length }
        }))
      }
    )

    const replaceOpenSurface = Effect.fn('RetainedPages.replaceOpenSurface')(function*(
      removedTabId: number,
      replacement: OpenSurfaceObservation | PromiseLike<OpenSurfaceObservation | null>
    ) {
      yield* mutationSemaphore.withPermit(Effect.gen(function*() {
        const captured = yield* Effect.promise(() => Promise.resolve(replacement))
        const pair = yield* readInventoryPair()
        if (!captured) {
          const withoutRemoved = removeOpenSurface(pair.inventory, removedTabId)
          yield* persistObservedInventory(pair, withoutRemoved.inventory)
          yield* health.recordFailure({
            failureKind: 'capture',
            operationKind: 'open-surface-coverage',
            retryState: 'not-applicable'
          })
          return
        }
        const replaced = yield* Effect.promise(() => transferOpenSurfaceLifetime(
          pair.inventory,
          removedTabId,
          captured,
          inventoryOptions()
        ))
        yield* persistObservedInventory(pair, replaced.inventory)
      }))
    })

    return RetainedPages.of({
      activateSnapshot,
      captureClosedSurface,
      captureClosedSurfaces,
      captureClosure,
      checkpointOpenSurfaces,
      getLedger,
      observeOpenSurface,
      observeOpenSurfaces,
      reconcileOpenSurfaces,
      replaceOpenSurface,
      removeSnapshot
    })
  }))
}
