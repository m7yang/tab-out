import { Context, Effect, Layer, Schema } from 'effect'

import {
  emptyRetainedPageLedger,
  enforceRetainedPageCapacity,
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageRecord,
  type RetainedPageRemovalBoundary,
  type RetainedPageLedger
} from './retained-pages-ledger.js'
import {
  OPEN_SURFACE_FAVICON_MAX_LENGTH,
  OPEN_SURFACE_TITLE_MAX_CODE_POINTS
} from './open-surface-inventory.js'
import {
  createRetainedPageIdentity,
  isRetainedPageCaptureEligible,
  type RetainedPageIdentity,
  type RetainedPageIdentityCandidate,
  type RetainedPageIdentityOptions
} from './retained-page-identity.js'
import { canonicalDedupeKey } from './url-canonical.js'
import {
  decodeGzipBase64Json,
  encodeGzipBase64Json
} from './gzip-base64-json.js'

export const RETAINED_PAGES_STORAGE_KEY = 'tabOutRetainedPagesV1'
export const RETAINED_PAGES_STORAGE_ENCODING = 'gzip-base64-json-v1'

interface RetainedPageLedgerStorageEnvelope {
  readonly schemaVersion: 1
  readonly identityVersion: 1
  readonly encoding: typeof RETAINED_PAGES_STORAGE_ENCODING
  readonly data: string
}

export interface RetainedPageLedgerStorageBackend {
  readonly read: () => PromiseLike<unknown>
  readonly write: (ledger: RetainedPageLedger) => PromiseLike<void>
}

export interface RetainedPageLedgerStorageOptions extends RetainedPageIdentityOptions {
  /** Rewrite the earlier expanded v1 shape using identity derived from URL + surface. */
  readonly reindexExpandedIdentities?: boolean
}

export class RetainedPageLedgerStorageError extends Schema.TaggedErrorClass<RetainedPageLedgerStorageError>()(
  'RetainedPageLedgerStorageError',
  {
    operation: Schema.Literals(['read', 'write']),
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

function hasCachedBoundedTitle(
  value: unknown,
  validityByTitle: Map<string, boolean>
): value is string {
  if (typeof value !== 'string') return false
  return validityByTitle.getOrInsertComputed(value, () => hasBoundedTitle(value))
}

function isReusableFavicon(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= OPEN_SURFACE_FAVICON_MAX_LENGTH &&
    URL.parse(value)?.protocol !== 'blob:'
  )
}

const ledgerKeys = new Set([
  'schemaVersion',
  'identityVersion',
  'pages',
  'removalBoundaries'
])
const pageKeys = new Set([
  'identityDigest',
  'surfaceKind',
  'canonicalKey',
  'url',
  'title',
  'favIconUrl',
  'closedAt',
  'closureToken'
])
const boundaryKeys = new Set([
  'identityDigest',
  'closureToken',
  'expiresAt'
])
const storageEnvelopeKeys = new Set([
  'schemaVersion',
  'identityVersion',
  'encoding',
  'data'
])

function knownStorageEnvelope(
  stored: unknown
): RetainedPageLedgerStorageEnvelope | null {
  if (
    !isRecord(stored) ||
    stored.schemaVersion !== 1 ||
    stored.identityVersion !== 1 ||
    stored.encoding !== RETAINED_PAGES_STORAGE_ENCODING ||
    typeof stored.data !== 'string' ||
    !hasOnlyKeys(stored, storageEnvelopeKeys)
  ) return null
  return {
    schemaVersion: 1,
    identityVersion: 1,
    encoding: RETAINED_PAGES_STORAGE_ENCODING,
    data: stored.data
  }
}

function storageEnvelopesEqual(
  left: RetainedPageLedgerStorageEnvelope,
  right: RetainedPageLedgerStorageEnvelope
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.identityVersion === right.identityVersion &&
    left.encoding === right.encoding &&
    left.data === right.data
}

function isExpandedRetainedPageLedgerValue(stored: unknown): boolean {
  if (!isRecord(stored)) return false
  const hasExpandedPage = isRecord(stored.pages) &&
    Object.values(stored.pages).some((page) =>
      isRecord(page) && ('identityDigest' in page || 'canonicalKey' in page)
    )
  const hasExpandedBoundary = isRecord(stored.removalBoundaries) &&
    Object.values(stored.removalBoundaries).some((boundary) =>
      isRecord(boundary) && 'closureToken' in boundary
    )
  return hasExpandedPage || hasExpandedBoundary
}

function normalizeExpandedRetainedPageLedgerValue(stored: unknown): unknown {
  if (!isRecord(stored)) return stored
  const pages = isRecord(stored.pages)
    ? Object.fromEntries(Object.entries(stored.pages).map(([identityDigest, page]) => {
        if (!isRecord(page)) return [identityDigest, page]
        const normalized = { ...page }
        delete normalized.identityDigest
        delete normalized.canonicalKey
        return [identityDigest, normalized]
      }))
    : stored.pages
  const removalBoundaries = isRecord(stored.removalBoundaries)
    ? Object.fromEntries(Object.entries(stored.removalBoundaries).map(([closureToken, boundary]) => {
        if (!isRecord(boundary)) return [closureToken, boundary]
        const normalized = { ...boundary }
        delete normalized.closureToken
        return [closureToken, normalized]
      }))
    : stored.removalBoundaries
  return { ...stored, pages, removalBoundaries }
}

type ResolveRetainedPageIdentities = (
  candidates: readonly RetainedPageIdentityCandidate[]
) => Promise<readonly (RetainedPageIdentity | null)[]>

function createCachedIdentityBatchResolver(
  options: RetainedPageIdentityOptions
): ResolveRetainedPageIdentities {
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

function compareReindexedPageOrder(
  left: { readonly page: RetainedPageRecord; readonly oldIdentityDigest: string },
  right: { readonly page: RetainedPageRecord; readonly oldIdentityDigest: string }
): number {
  return left.page.closedAt - right.page.closedAt ||
    left.page.closureToken.localeCompare(right.page.closureToken) ||
    left.oldIdentityDigest.localeCompare(right.oldIdentityDigest)
}

async function reindexRetainedPageLedger(
  ledger: RetainedPageLedger,
  resolveIdentities: ResolveRetainedPageIdentities
): Promise<RetainedPageLedger> {
  const storedPages = Object.entries(ledger.pages)
  const identities = await resolveIdentities(storedPages.map(([, page]) => ({
    surfaceKind: page.surfaceKind,
    url: page.url
  })))
  const digestByOldDigest = new Map<string, string | null>()
  const winnerByDigest = new Map<string, {
    readonly page: RetainedPageRecord
    readonly oldIdentityDigest: string
  }>()

  for (const [index, [oldIdentityDigest, page]] of storedPages.entries()) {
    const identity = identities[index] ?? null
    digestByOldDigest.set(oldIdentityDigest, identity?.identityDigest ?? null)
    if (!identity) continue
    const candidate = {
      oldIdentityDigest,
      page: {
        ...page,
        identityDigest: identity.identityDigest,
        surfaceKind: identity.surfaceKind,
        canonicalKey: identity.canonicalKey,
        url: identity.url
      }
    }
    const existing = winnerByDigest.get(identity.identityDigest)
    if (!existing || compareReindexedPageOrder(candidate, existing) > 0) {
      winnerByDigest.set(identity.identityDigest, candidate)
    }
  }

  const pages: Record<string, RetainedPageRecord> = {}
  for (const [identityDigest, winner] of winnerByDigest) {
    pages[identityDigest] = winner.page
  }
  const removalBoundaries: Record<string, RetainedPageRemovalBoundary> = {}
  for (const [closureToken, boundary] of Object.entries(ledger.removalBoundaries)) {
    const reindexedDigest = digestByOldDigest.get(boundary.identityDigest)
    if (reindexedDigest === null) continue
    removalBoundaries[closureToken] = reindexedDigest === undefined
      ? boundary
      : { ...boundary, identityDigest: reindexedDigest }
  }
  return {
    schemaVersion: 1,
    identityVersion: 1,
    pages: enforceRetainedPageCapacity(pages),
    removalBoundaries
  }
}

function parseRetainedPageRecord(
  stored: unknown,
  identityDigest: string,
  now: number,
  titleValidityByValue: Map<string, boolean>
): RetainedPageRecord | null {
  if (!isRecord(stored) || !hasOnlyKeys(stored, pageKeys)) return null
  if (
    (stored.identityDigest !== undefined && stored.identityDigest !== identityDigest) ||
    (stored.surfaceKind !== 'normal-tab' && stored.surfaceKind !== 'app') ||
    !isNonEmptyString(identityDigest) ||
    (stored.canonicalKey !== undefined && !isNonEmptyString(stored.canonicalKey)) ||
    !isNonEmptyString(stored.url) ||
    !isRetainedPageCaptureEligible({
      surfaceKind: stored.surfaceKind,
      url: stored.url
    }) ||
    !hasCachedBoundedTitle(stored.title, titleValidityByValue) ||
    !isReusableFavicon(stored.favIconUrl) ||
    !isPersistedTime(stored.closedAt) ||
    stored.closedAt > now ||
    !isNonEmptyString(stored.closureToken)
  ) return null

  return {
    identityDigest,
    surfaceKind: stored.surfaceKind,
    canonicalKey: stored.canonicalKey ?? canonicalDedupeKey(stored.url),
    url: stored.url,
    title: stored.title,
    ...(stored.favIconUrl === undefined ? {} : { favIconUrl: stored.favIconUrl }),
    closedAt: stored.closedAt,
    closureToken: stored.closureToken
  }
}

function parseRemovalBoundary(
  stored: unknown,
  closureToken: string,
  now: number
): RetainedPageRemovalBoundary | null {
  if (!isRecord(stored) || !hasOnlyKeys(stored, boundaryKeys)) return null
  if (
    !isNonEmptyString(stored.identityDigest) ||
    !isNonEmptyString(closureToken) ||
    (stored.closureToken !== undefined && stored.closureToken !== closureToken) ||
    !isPersistedTime(stored.expiresAt)
  ) return null
  const closedAt = stored.expiresAt - RETAINED_PAGE_LIFETIME_MS
  if (!isPersistedTime(closedAt) || closedAt > now) return null
  return {
    identityDigest: stored.identityDigest,
    closureToken,
    expiresAt: stored.expiresAt
  }
}

/**
 * Persist only fields that are not already encoded by a record's map key.
 * `canonicalKey` is deterministically reconstructed from the exact effective
 * URL. The parser remains compatible with the earlier expanded v1 envelope.
 */
function serializeRetainedPageLedgerValue(
  ledger: RetainedPageLedger
): unknown {
  return {
    schemaVersion: ledger.schemaVersion,
    identityVersion: ledger.identityVersion,
    pages: Object.fromEntries(Object.entries(ledger.pages).map(([
      identityDigest,
      page
    ]) => [identityDigest, {
      surfaceKind: page.surfaceKind,
      url: page.url,
      title: page.title,
      ...(page.favIconUrl ? { favIconUrl: page.favIconUrl } : {}),
      closedAt: page.closedAt,
      closureToken: page.closureToken
    }])),
    removalBoundaries: Object.fromEntries(Object.entries(ledger.removalBoundaries).map(([
      closureToken,
      boundary
    ]) => [closureToken, {
      identityDigest: boundary.identityDigest,
      expiresAt: boundary.expiresAt
    }]))
  }
}

/** Encode the compact v1 ledger for the quota-constrained Chrome local store. */
export async function encodeRetainedPageLedgerStorageValue(
  ledger: RetainedPageLedger
): Promise<unknown> {
  return {
    schemaVersion: ledger.schemaVersion,
    identityVersion: ledger.identityVersion,
    encoding: RETAINED_PAGES_STORAGE_ENCODING,
    data: await encodeGzipBase64Json(serializeRetainedPageLedgerValue(ledger))
  }
}

/**
 * Decode only the known compressed v1 envelope. Unknown newer versions remain
 * opaque so an older extension never replaces them with an empty ledger.
 */
export async function decodeRetainedPageLedgerStorageValue(
  stored: unknown
): Promise<unknown> {
  const envelope = knownStorageEnvelope(stored)
  if (!envelope) return stored

  try {
    return await decodeGzipBase64Json(envelope.data)
  } catch {
    return stored
  }
}

/**
 * Keep one decoded known envelope warm for the MV3 worker lifetime. Reads still
 * consult Chrome storage first, so external writes and unknown versions remain
 * authoritative; only a byte-identical compressed value skips repeated decode.
 */
export function createRetainedPageLedgerStorageDecodeCache() {
  let cached: {
    readonly envelope: RetainedPageLedgerStorageEnvelope
    readonly decoded: unknown
  } | null = null

  return {
    async decode(stored: unknown): Promise<unknown> {
      const envelope = knownStorageEnvelope(stored)
      if (
        envelope &&
        cached &&
        storageEnvelopesEqual(envelope, cached.envelope)
      ) return cached.decoded

      const decoded = await decodeRetainedPageLedgerStorageValue(stored)
      if (envelope && decoded !== stored) cached = { envelope, decoded }
      return decoded
    }
  }
}

export type RetainedPageLedgerParseResult =
  | { status: 'missing'; ledger: RetainedPageLedger }
  | { status: 'valid'; ledger: RetainedPageLedger }
  | { status: 'malformed'; ledger: RetainedPageLedger }
  | { status: 'newer'; raw: unknown }

function parseRetainedPageLedgerValueInternal(
  stored: unknown,
  now: number,
  enforceCapacity: boolean
): RetainedPageLedgerParseResult {
  if (stored === undefined) {
    return { status: 'missing', ledger: emptyRetainedPageLedger() }
  }
  if (
    isRecord(stored) &&
    typeof stored.schemaVersion === 'number' &&
    Number.isFinite(stored.schemaVersion) &&
    typeof stored.identityVersion === 'number' &&
    Number.isFinite(stored.identityVersion) &&
    (stored.schemaVersion > 1 || stored.identityVersion > 1)
  ) {
    return { status: 'newer', raw: stored }
  }
  if (
    !isRecord(stored) ||
    stored.schemaVersion !== 1 ||
    stored.identityVersion !== 1 ||
    !isRecord(stored.pages) ||
    !isRecord(stored.removalBoundaries)
  ) {
    return { status: 'malformed', ledger: emptyRetainedPageLedger() }
  }

  let malformed = !hasOnlyKeys(stored, ledgerKeys)
  const pages: Record<string, RetainedPageRecord> = {}
  const titleValidityByValue = new Map<string, boolean>()
  for (const [identityDigest, value] of Object.entries(stored.pages)) {
    const page = parseRetainedPageRecord(
      value,
      identityDigest,
      now,
      titleValidityByValue
    )
    if (page) pages[identityDigest] = page
    else malformed = true
  }
  const removalBoundaries: Record<string, RetainedPageRemovalBoundary> = {}
  for (const [closureToken, value] of Object.entries(stored.removalBoundaries)) {
    const boundary = parseRemovalBoundary(value, closureToken, now)
    if (boundary) removalBoundaries[closureToken] = boundary
    else malformed = true
  }
  const capacityPages = enforceCapacity ? enforceRetainedPageCapacity(pages) : pages
  if (enforceCapacity && Object.keys(capacityPages).length !== Object.keys(pages).length) {
    malformed = true
  }
  const ledger: RetainedPageLedger = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: capacityPages,
    removalBoundaries
  }
  return malformed
    ? { status: 'malformed', ledger }
    : { status: 'valid', ledger }
}

export function parseRetainedPageLedgerValue(
  stored: unknown,
  now = Date.now()
): RetainedPageLedgerParseResult {
  return parseRetainedPageLedgerValueInternal(stored, now, true)
}

export class RetainedPageLedgerStorage extends Context.Service<RetainedPageLedgerStorage, {
  readonly read: () => Effect.Effect<
    RetainedPageLedgerParseResult,
    RetainedPageLedgerStorageError
  >
  readonly write: (
    ledger: RetainedPageLedger
  ) => Effect.Effect<void, RetainedPageLedgerStorageError>
}>()('@tab-out/background/RetainedPageLedgerStorage') {
  static layer(
    backend: RetainedPageLedgerStorageBackend,
    options: RetainedPageLedgerStorageOptions = {}
  ): Layer.Layer<RetainedPageLedgerStorage> {
    let cachedValidParse: {
      readonly source: unknown
      readonly result: Extract<RetainedPageLedgerParseResult, { status: 'valid' }>
    } | null = null
    const resolveIdentities = createCachedIdentityBatchResolver(options)
    const read = Effect.fn('RetainedPageLedgerStorage.read')(function*() {
      const stored = yield* Effect.tryPromise({
        try: backend.read,
        catch: (cause) => RetainedPageLedgerStorageError.make({ operation: 'read', cause })
      })
      const cached = cachedValidParse
      if (cached !== null && cached.source === stored) return cached.result
      const now = Date.now()
      const originalParsed = parseRetainedPageLedgerValueInternal(stored, now, true)
      if (originalParsed.status === 'newer') {
        cachedValidParse = null
        return originalParsed
      }
      const expanded = options.reindexExpandedIdentities &&
        isExpandedRetainedPageLedgerValue(stored)
      // Earlier expanded v1 fields were derived data. The map keys and exact
      // URL + surface are authoritative while those fields are recomputed.
      const parsed = expanded
        ? parseRetainedPageLedgerValueInternal(
            normalizeExpandedRetainedPageLedgerValue(stored),
            now,
            false
          )
        : originalParsed
      if (
        expanded &&
        (parsed.status === 'valid' || parsed.status === 'malformed')
      ) {
        const ledger = yield* Effect.tryPromise({
          try: () => reindexRetainedPageLedger(parsed.ledger, resolveIdentities),
          catch: (cause) => RetainedPageLedgerStorageError.make({ operation: 'read', cause })
        })
        const reindexed = parsed.status === 'valid'
          ? { status: 'valid' as const, ledger }
          : { status: 'malformed' as const, ledger }
        if (reindexed.status === 'valid') {
          yield* Effect.tryPromise({
            try: () => backend.write(ledger),
            catch: (cause) => RetainedPageLedgerStorageError.make({ operation: 'write', cause })
          })
        }
        cachedValidParse = null
        return reindexed
      }
      cachedValidParse = parsed.status === 'valid'
        ? { source: stored, result: parsed }
        : null
      return parsed
    })
    const write = Effect.fn('RetainedPageLedgerStorage.write')(function*(
      ledger: RetainedPageLedger
    ) {
      yield* Effect.tryPromise({
        try: () => backend.write(ledger),
        catch: (cause) => RetainedPageLedgerStorageError.make({ operation: 'write', cause })
      })
      cachedValidParse = null
    })
    return Layer.succeed(RetainedPageLedgerStorage, RetainedPageLedgerStorage.of({ read, write }))
  }
}
