import { Context, Effect, Layer, Schema } from 'effect'

import {
  emptyOpenSurfaceInventory,
  OPEN_SURFACE_FAVICON_MAX_LENGTH,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
  OPEN_SURFACE_TITLE_MAX_CODE_POINTS,
  type OpenSurfaceInventory
} from './open-surface-inventory.js'
import {
  createRetainedPageIdentity,
  isRetainedPageCaptureEligible,
  type RetainedPageIdentity,
  type RetainedPageIdentityCandidate,
  type RetainedPageIdentityOptions
} from './retained-page-identity.js'

export const OPEN_SURFACE_SESSION_STORAGE_KEY = 'tabOutOpenSurfacesSessionV1'
export const OPEN_SURFACE_DURABLE_STORAGE_KEY = 'tabOutOpenSurfacesDurableV1'

export interface OpenSurfaceInventoryStorageBackend {
  readonly readSession: () => PromiseLike<unknown>
  readonly writeSession: (inventory: OpenSurfaceInventory) => PromiseLike<void>
  readonly readDurable: () => PromiseLike<unknown>
  readonly writeDurable: (inventory: OpenSurfaceInventory) => PromiseLike<void>
}

export interface OpenSurfaceInventoryStorageOptions extends RetainedPageIdentityOptions {
  /** Re-derive persisted identity fields from each entry's exact URL + surface. */
  readonly reindexIdentities?: boolean
}

export class OpenSurfaceInventoryStorageError extends Schema.TaggedErrorClass<OpenSurfaceInventoryStorageError>()(
  'OpenSurfaceInventoryStorageError',
  {
    operation: Schema.Literals([
      'read-session',
      'write-session',
      'read-durable',
      'write-durable'
    ]),
    cause: Schema.Defect()
  }
) {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isPersistedTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasBoundedTitle(value: unknown): value is string {
  return typeof value === 'string' &&
    Array.from(value).length <= OPEN_SURFACE_TITLE_MAX_CODE_POINTS
}

function isReusableFavicon(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= OPEN_SURFACE_FAVICON_MAX_LENGTH &&
    URL.parse(value)?.protocol !== 'blob:'
  )
}

const inventoryKeys = new Set(['schemaVersion', 'identityVersion', 'entries'])
const entryKeys = new Set([
  'tabId',
  'closureToken',
  'identityDigest',
  'surfaceKind',
  'canonicalKey',
  'url',
  'title',
  'favIconUrl',
  'closedAt'
])

function isLegacyOpenSurfaceInventoryValue(stored: unknown): boolean {
  return isRecord(stored) &&
    stored.schemaVersion === 1 &&
    stored.identityVersion === 1
}

function normalizeLegacyOpenSurfaceInventoryValue(stored: unknown): unknown {
  if (!isRecord(stored) || !isRecord(stored.entries)) return stored
  const entries = Object.fromEntries(Object.entries(stored.entries).map(([tabId, entry]) => {
    if (!isRecord(entry)) return [tabId, entry]
    return [tabId, {
      ...entry,
      identityDigest: isNonEmptyString(entry.identityDigest)
        ? entry.identityDigest
        : `legacy-identity-${tabId}`,
      canonicalKey: isNonEmptyString(entry.canonicalKey)
        ? entry.canonicalKey
        : `legacy-canonical-${tabId}`
    }]
  }))
  return { ...stored, entries }
}

export type OpenSurfaceInventoryParseResult =
  | { status: 'missing'; inventory: OpenSurfaceInventory }
  | { status: 'valid'; inventory: OpenSurfaceInventory }
  | { status: 'malformed'; inventory: OpenSurfaceInventory }
  | { status: 'newer'; raw: unknown }

type ResolveRetainedPageIdentities = (
  candidates: readonly RetainedPageIdentityCandidate[]
) => Promise<readonly (RetainedPageIdentity | null)[]>

function createCachedIdentityBatchResolver(
  options: RetainedPageIdentityOptions
): ResolveRetainedPageIdentities {
  // Session and durable copies are read concurrently and usually contain the
  // same entries. Keep only the current and previous batches while publishing
  // in-flight hashes synchronously for the concurrent peer read to share.
  let previous = new Map<string, Promise<RetainedPageIdentity | null>>()
  let current = new Map<string, Promise<RetainedPageIdentity | null>>()
  return (candidates) => {
    const priorCurrent = current
    const next = new Map<string, Promise<RetainedPageIdentity | null>>()
    const identities = candidates.map((candidate) => {
      const cacheKey = JSON.stringify([candidate.surfaceKind, candidate.url])
      const identity = next.get(cacheKey) ?? priorCurrent.get(cacheKey) ??
        previous.get(cacheKey) ?? createRetainedPageIdentity(candidate, options)
      next.set(cacheKey, identity)
      void identity.catch(() => {
        if (current.get(cacheKey) === identity) current.delete(cacheKey)
        if (previous.get(cacheKey) === identity) previous.delete(cacheKey)
      })
      return identity
    })
    previous = priorCurrent
    current = next
    return Promise.all(identities)
  }
}

async function reindexOpenSurfaceInventory(
  inventory: OpenSurfaceInventory,
  resolveIdentities: ResolveRetainedPageIdentities
): Promise<{ readonly inventory: OpenSurfaceInventory; readonly changed: boolean }> {
  const storedEntries = Object.entries(inventory.entries)
  const identities = await resolveIdentities(storedEntries.map(([, entry]) => ({
    surfaceKind: entry.surfaceKind,
    url: entry.url
  })))
  const entries: Record<string, OpenSurfaceInventory['entries'][string]> = {}
  let changed = inventory.schemaVersion !== OPEN_SURFACE_INVENTORY_SCHEMA_VERSION

  for (const [index, [tabId, entry]] of storedEntries.entries()) {
    const identity = identities[index] ?? null
    if (!identity) {
      changed = true
      continue
    }
    const reindexed = {
      ...entry,
      identityDigest: identity.identityDigest,
      surfaceKind: identity.surfaceKind,
      canonicalKey: identity.canonicalKey,
      url: identity.url
    }
    entries[tabId] = reindexed
    if (
      reindexed.identityDigest !== entry.identityDigest ||
      reindexed.surfaceKind !== entry.surfaceKind ||
      reindexed.canonicalKey !== entry.canonicalKey ||
      reindexed.url !== entry.url
    ) changed = true
  }

  return changed
    ? {
        changed: true,
        inventory: {
          schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
          identityVersion: 1,
          entries
        }
      }
    : { changed: false, inventory }
}

function parseInventoryEntry(
  stored: unknown,
  tabIdKey: string,
  now: number
): OpenSurfaceInventory['entries'][string] | null {
  if (!isRecord(stored) || !hasOnlyKeys(stored, entryKeys)) return null
  if (
    typeof stored.tabId !== 'number' ||
    !Number.isSafeInteger(stored.tabId) ||
    stored.tabId < 0 ||
    String(stored.tabId) !== tabIdKey ||
    !isNonEmptyString(stored.closureToken) ||
    !isNonEmptyString(stored.identityDigest) ||
    (stored.surfaceKind !== 'normal-tab' && stored.surfaceKind !== 'app') ||
    !isNonEmptyString(stored.canonicalKey) ||
    !isNonEmptyString(stored.url) ||
    !isRetainedPageCaptureEligible({
      surfaceKind: stored.surfaceKind,
      url: stored.url
    }) ||
    !hasBoundedTitle(stored.title) ||
    !isReusableFavicon(stored.favIconUrl) ||
    (stored.closedAt !== undefined && (
      !isPersistedTime(stored.closedAt) || stored.closedAt > now
    ))
  ) return null

  return {
    tabId: stored.tabId,
    closureToken: stored.closureToken,
    identityDigest: stored.identityDigest,
    surfaceKind: stored.surfaceKind,
    canonicalKey: stored.canonicalKey,
    url: stored.url,
    title: stored.title,
    ...(stored.favIconUrl === undefined ? {} : { favIconUrl: stored.favIconUrl }),
    ...(stored.closedAt === undefined ? {} : { closedAt: stored.closedAt })
  }
}

export function parseOpenSurfaceInventoryValue(
  stored: unknown,
  now = Date.now()
): OpenSurfaceInventoryParseResult {
  if (stored === undefined) {
    return { status: 'missing', inventory: emptyOpenSurfaceInventory() }
  }
  if (
    isRecord(stored) &&
    typeof stored.schemaVersion === 'number' &&
    Number.isFinite(stored.schemaVersion) &&
    typeof stored.identityVersion === 'number' &&
    Number.isFinite(stored.identityVersion) &&
    (
      stored.schemaVersion > OPEN_SURFACE_INVENTORY_SCHEMA_VERSION ||
      stored.identityVersion > 1
    )
  ) {
    return { status: 'newer', raw: stored }
  }
  if (
    !isRecord(stored) ||
    (stored.schemaVersion !== 1 &&
      stored.schemaVersion !== OPEN_SURFACE_INVENTORY_SCHEMA_VERSION) ||
    stored.identityVersion !== 1 ||
    !isRecord(stored.entries)
  ) {
    return { status: 'malformed', inventory: emptyOpenSurfaceInventory() }
  }

  let malformed = !hasOnlyKeys(stored, inventoryKeys)
  const entries: Record<string, OpenSurfaceInventory['entries'][string]> = {}
  for (const [tabId, value] of Object.entries(stored.entries)) {
    const entry = parseInventoryEntry(value, tabId, now)
    if (entry) entries[tabId] = entry
    else malformed = true
  }
  const inventory: OpenSurfaceInventory = {
    schemaVersion: stored.schemaVersion,
    identityVersion: 1,
    entries
  }
  return malformed
    ? { status: 'malformed', inventory }
    : { status: 'valid', inventory }
}

export class OpenSurfaceInventoryStorage extends Context.Service<OpenSurfaceInventoryStorage, {
  readonly readSession: () => Effect.Effect<
    OpenSurfaceInventoryParseResult,
    OpenSurfaceInventoryStorageError
  >
  readonly writeSession: (
    inventory: OpenSurfaceInventory
  ) => Effect.Effect<void, OpenSurfaceInventoryStorageError>
  readonly readDurable: () => Effect.Effect<
    OpenSurfaceInventoryParseResult,
    OpenSurfaceInventoryStorageError
  >
  readonly writeDurable: (
    inventory: OpenSurfaceInventory
  ) => Effect.Effect<void, OpenSurfaceInventoryStorageError>
}>()('@tab-out/background/OpenSurfaceInventoryStorage') {
  static layer(
    backend: OpenSurfaceInventoryStorageBackend,
    options: OpenSurfaceInventoryStorageOptions = {}
  ): Layer.Layer<OpenSurfaceInventoryStorage> {
    const resolveIdentities = createCachedIdentityBatchResolver(options)
    const readSession = Effect.fn('OpenSurfaceInventoryStorage.readSession')(function*() {
      const stored = yield* Effect.tryPromise({
        try: backend.readSession,
        catch: (cause) => OpenSurfaceInventoryStorageError.make({
          operation: 'read-session',
          cause
        })
      })
      const originalParsed = parseOpenSurfaceInventoryValue(stored)
      if (originalParsed.status === 'newer') return originalParsed
      const legacy = options.reindexIdentities &&
        isLegacyOpenSurfaceInventoryValue(stored)
      const parsed = legacy
        ? parseOpenSurfaceInventoryValue(normalizeLegacyOpenSurfaceInventoryValue(stored))
        : originalParsed
      if (
        !legacy ||
        (parsed.status !== 'valid' && parsed.status !== 'malformed') ||
        parsed.inventory.schemaVersion === OPEN_SURFACE_INVENTORY_SCHEMA_VERSION
      ) return parsed
      const reindexed = yield* Effect.tryPromise({
        try: () => reindexOpenSurfaceInventory(parsed.inventory, resolveIdentities),
        catch: (cause) => OpenSurfaceInventoryStorageError.make({
          operation: 'read-session',
          cause
        })
      })
      if (parsed.status === 'valid' && reindexed.changed) {
        yield* Effect.tryPromise({
          try: () => backend.writeSession(reindexed.inventory),
          catch: (cause) => OpenSurfaceInventoryStorageError.make({
            operation: 'write-session',
            cause
          })
        })
      }
      return parsed.status === 'valid'
        ? { status: 'valid' as const, inventory: reindexed.inventory }
        : { status: 'malformed' as const, inventory: reindexed.inventory }
    })
    const writeSession = Effect.fn('OpenSurfaceInventoryStorage.writeSession')(function*(
      inventory: OpenSurfaceInventory
    ) {
      yield* Effect.tryPromise({
        try: () => backend.writeSession(inventory),
        catch: (cause) => OpenSurfaceInventoryStorageError.make({
          operation: 'write-session',
          cause
        })
      })
    })
    const readDurable = Effect.fn('OpenSurfaceInventoryStorage.readDurable')(function*() {
      const stored = yield* Effect.tryPromise({
        try: backend.readDurable,
        catch: (cause) => OpenSurfaceInventoryStorageError.make({
          operation: 'read-durable',
          cause
        })
      })
      const originalParsed = parseOpenSurfaceInventoryValue(stored)
      if (originalParsed.status === 'newer') return originalParsed
      const legacy = options.reindexIdentities &&
        isLegacyOpenSurfaceInventoryValue(stored)
      const parsed = legacy
        ? parseOpenSurfaceInventoryValue(normalizeLegacyOpenSurfaceInventoryValue(stored))
        : originalParsed
      if (
        !legacy ||
        (parsed.status !== 'valid' && parsed.status !== 'malformed') ||
        parsed.inventory.schemaVersion === OPEN_SURFACE_INVENTORY_SCHEMA_VERSION
      ) return parsed
      const reindexed = yield* Effect.tryPromise({
        try: () => reindexOpenSurfaceInventory(parsed.inventory, resolveIdentities),
        catch: (cause) => OpenSurfaceInventoryStorageError.make({
          operation: 'read-durable',
          cause
        })
      })
      if (parsed.status === 'valid' && reindexed.changed) {
        yield* Effect.tryPromise({
          try: () => backend.writeDurable(reindexed.inventory),
          catch: (cause) => OpenSurfaceInventoryStorageError.make({
            operation: 'write-durable',
            cause
          })
        })
      }
      return parsed.status === 'valid'
        ? { status: 'valid' as const, inventory: reindexed.inventory }
        : { status: 'malformed' as const, inventory: reindexed.inventory }
    })
    const writeDurable = Effect.fn('OpenSurfaceInventoryStorage.writeDurable')(function*(
      inventory: OpenSurfaceInventory
    ) {
      yield* Effect.tryPromise({
        try: () => backend.writeDurable(inventory),
        catch: (cause) => OpenSurfaceInventoryStorageError.make({
          operation: 'write-durable',
          cause
        })
      })
    })

    return Layer.succeed(OpenSurfaceInventoryStorage, OpenSurfaceInventoryStorage.of({
      readSession,
      writeSession,
      readDurable,
      writeDurable
    }))
  }
}
