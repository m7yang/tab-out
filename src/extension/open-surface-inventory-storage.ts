import { Context, Effect, Layer, Schema } from 'effect'

import {
  emptyOpenSurfaceInventory,
  OPEN_SURFACE_FAVICON_MAX_LENGTH,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
  OPEN_SURFACE_TITLE_MAX_CODE_POINTS,
  type OpenSurfaceInventory
} from './open-surface-inventory.js'
import {
  createCachedRetainedPageIdentityResolver,
  isRetainedPageCaptureEligible,
  type ResolveRetainedPageIdentities,
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
    const resolveIdentities = createCachedRetainedPageIdentityResolver(options)
    const makeChannel = (channel: {
      readonly readName: string
      readonly writeName: string
      readonly readOperation: 'read-session' | 'read-durable'
      readonly writeOperation: 'write-session' | 'write-durable'
      readonly read: () => PromiseLike<unknown>
      readonly write: (inventory: OpenSurfaceInventory) => PromiseLike<void>
    }) => {
      const read = Effect.fn(channel.readName)(function*() {
        const stored = yield* Effect.tryPromise({
          try: channel.read,
          catch: (cause) => OpenSurfaceInventoryStorageError.make({
            operation: channel.readOperation,
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
            operation: channel.readOperation,
            cause
          })
        })
        if (parsed.status === 'valid' && reindexed.changed) {
          yield* Effect.tryPromise({
            try: () => channel.write(reindexed.inventory),
            catch: (cause) => OpenSurfaceInventoryStorageError.make({
              operation: channel.writeOperation,
              cause
            })
          })
        }
        return parsed.status === 'valid'
          ? { status: 'valid' as const, inventory: reindexed.inventory }
          : { status: 'malformed' as const, inventory: reindexed.inventory }
      })
      const write = Effect.fn(channel.writeName)(function*(inventory: OpenSurfaceInventory) {
        yield* Effect.tryPromise({
          try: () => channel.write(inventory),
          catch: (cause) => OpenSurfaceInventoryStorageError.make({
            operation: channel.writeOperation,
            cause
          })
        })
      })
      return { read, write }
    }

    const session = makeChannel({
      readName: 'OpenSurfaceInventoryStorage.readSession',
      writeName: 'OpenSurfaceInventoryStorage.writeSession',
      readOperation: 'read-session',
      writeOperation: 'write-session',
      read: () => backend.readSession(),
      write: (inventory) => backend.writeSession(inventory)
    })
    const durable = makeChannel({
      readName: 'OpenSurfaceInventoryStorage.readDurable',
      writeName: 'OpenSurfaceInventoryStorage.writeDurable',
      readOperation: 'read-durable',
      writeOperation: 'write-durable',
      read: () => backend.readDurable(),
      write: (inventory) => backend.writeDurable(inventory)
    })

    return Layer.succeed(OpenSurfaceInventoryStorage, OpenSurfaceInventoryStorage.of({
      readSession: session.read,
      writeSession: session.write,
      readDurable: durable.read,
      writeDurable: durable.write
    }))
  }
}
