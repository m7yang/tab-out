import type { RetainedPageSurfaceKind } from './retained-page-identity.js'

export type { RetainedPageSurfaceKind } from './retained-page-identity.js'

export const RETAINED_PAGE_CAPACITY = 500
export const RETAINED_PAGE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000

export interface RetainedPageClosure {
  readonly identityDigest: string
  readonly surfaceKind: RetainedPageSurfaceKind
  readonly canonicalKey: string
  readonly url: string
  readonly title: string
  readonly favIconUrl?: string
  readonly closedAt: number
  readonly closureToken: string
}

export type RetainedPageRecord = RetainedPageClosure

export interface RetainedPageRemovalBoundary {
  identityDigest: string
  closureToken: string
  expiresAt: number
}

export interface RetainedPageLedger {
  schemaVersion: 1
  identityVersion: 1
  pages: Readonly<Record<string, RetainedPageRecord>>
  removalBoundaries: Readonly<Record<string, RetainedPageRemovalBoundary>>
}

export interface RecordRetainedPageClosureResult {
  ledger: RetainedPageLedger
  changed: boolean
  outcome: 'inserted' | 'refreshed' | 'replayed' | 'stale' | 'blocked'
}

export type RecordRetainedPageClosureOutcome = Omit<
  RecordRetainedPageClosureResult,
  'ledger'
>

export interface RecordRetainedPageClosuresResult {
  ledger: RetainedPageLedger
  changed: boolean
  results: readonly RecordRetainedPageClosureOutcome[]
}

export interface RemoveRetainedPageSnapshotResult {
  ledger: RetainedPageLedger
  changed: boolean
  outcome: 'removed' | 'already-absent' | 'stale'
}

export interface PruneRetainedPageLedgerResult {
  ledger: RetainedPageLedger
  changed: boolean
  removedPages: number
  removedBoundaries: number
  nextExpiryAt: number | null
}

export function emptyRetainedPageLedger(): RetainedPageLedger {
  return {
    schemaVersion: 1,
    identityVersion: 1,
    pages: {},
    removalBoundaries: {}
  }
}

export function recordRetainedPageClosure(
  ledger: RetainedPageLedger,
  closure: RetainedPageClosure
): RecordRetainedPageClosureResult {
  const recorded = recordRetainedPageClosures(ledger, [closure])
  return {
    ledger: recorded.ledger,
    ...(recorded.results[0] ?? { changed: false, outcome: 'stale' })
  }
}

interface RemovalBoundaryIndex {
  readonly byToken: Map<string, RetainedPageRemovalBoundary>
  readonly latestByIdentity: Map<string, RetainedPageRemovalBoundary>
  readonly tokensByIdentity: Map<string, Set<string>>
}

function indexRemovalBoundaries(
  boundaries: Readonly<Record<string, RetainedPageRemovalBoundary>>
): RemovalBoundaryIndex {
  const byToken = new Map<string, RetainedPageRemovalBoundary>()
  const latestByIdentity = new Map<string, RetainedPageRemovalBoundary>()
  const tokensByIdentity = new Map<string, Set<string>>()
  for (const [closureToken, boundary] of Object.entries(boundaries)) {
    byToken.set(closureToken, boundary)
    tokensByIdentity.getOrInsertComputed(boundary.identityDigest, () => new Set()).add(closureToken)
    const latest = latestByIdentity.get(boundary.identityDigest)
    if (!latest || compareBoundaryOrder(boundary, latest) > 0) {
      latestByIdentity.set(boundary.identityDigest, boundary)
    }
  }
  return { byToken, latestByIdentity, tokensByIdentity }
}

function removeIndexedBoundariesForIdentity(
  index: RemovalBoundaryIndex,
  identityDigest: string
): void {
  const tokens = index.tokensByIdentity.get(identityDigest)
  if (!tokens) return
  for (const token of tokens) index.byToken.delete(token)
  index.tokensByIdentity.delete(identityDigest)
  index.latestByIdentity.delete(identityDigest)
}

function setIndexedReplayBoundary(
  index: RemovalBoundaryIndex,
  page: RetainedPageRecord
): void {
  removeIndexedBoundariesForIdentity(index, page.identityDigest)
  const boundary = replayBoundaryForPage(page)
  index.byToken.set(boundary.closureToken, boundary)
  index.tokensByIdentity.set(
    boundary.identityDigest,
    new Set([boundary.closureToken])
  )
  index.latestByIdentity.set(boundary.identityDigest, boundary)
}

function compareRetainedPageOrder(
  left: RetainedPageRecord,
  right: RetainedPageRecord
): number {
  return left.closedAt - right.closedAt ||
    left.closureToken.localeCompare(right.closureToken) ||
    left.identityDigest.localeCompare(right.identityDigest)
}

/**
 * Apply one already-adjacent physical-close batch as a single ledger mutation.
 * Results retain input order and the final ledger is identical to applying the
 * single-closure operation repeatedly, without cloning a large boundary map for
 * every capacity eviction.
 */
export function recordRetainedPageClosures(
  ledger: RetainedPageLedger,
  closures: readonly RetainedPageClosure[]
): RecordRetainedPageClosuresResult {
  if (closures.length === 0) return { ledger, changed: false, results: [] }

  const pages = new Map(Object.entries(ledger.pages))
  const boundaries = indexRemovalBoundaries(ledger.removalBoundaries)
  const results: RecordRetainedPageClosureOutcome[] = []
  let ledgerChanged = false

  for (const closure of closures) {
    const tokenBoundary = boundaries.byToken.get(closure.closureToken)
    const identityBoundary = boundaries.latestByIdentity.get(closure.identityDigest)
    if (
      tokenBoundary ||
      (
        identityBoundary &&
        compareClosureOrder(closure, {
          closedAt: identityBoundary.expiresAt - RETAINED_PAGE_LIFETIME_MS,
          closureToken: identityBoundary.closureToken
        }) <= 0
      )
    ) {
      results.push({ changed: false, outcome: 'blocked' })
      continue
    }

    const existing = pages.get(closure.identityDigest)
    if (existing?.closureToken === closure.closureToken) {
      results.push({ changed: false, outcome: 'replayed' })
      continue
    }
    if (existing && compareClosureOrder(closure, existing) < 0) {
      results.push({ changed: false, outcome: 'stale' })
      continue
    }

    const favIconUrl = closure.favIconUrl || existing?.favIconUrl
    const retainedRecord: RetainedPageRecord = {
      identityDigest: closure.identityDigest,
      surfaceKind: closure.surfaceKind,
      canonicalKey: closure.canonicalKey,
      url: closure.url,
      title: closure.title || existing?.title || '',
      closedAt: closure.closedAt,
      closureToken: closure.closureToken,
      ...(favIconUrl ? { favIconUrl } : {})
    }
    pages.set(closure.identityDigest, retainedRecord)

    let evicted: readonly RetainedPageRecord[] = []
    if (pages.size > RETAINED_PAGE_CAPACITY) {
      const capacityCandidates = [...pages.values()]
      const kept = capacityCandidates.toSorted((left, right) =>
        compareRetainedPageOrder(right, left)
      ).slice(0, RETAINED_PAGE_CAPACITY)
      const keptTokens = new Map(kept.map((page) => [
        page.identityDigest,
        page.closureToken
      ]))
      evicted = capacityCandidates.filter((page) =>
        keptTokens.get(page.identityDigest) !== page.closureToken
      )
      pages.clear()
      for (const page of kept) pages.set(page.identityDigest, page)
    }

    const accepted = pages.get(closure.identityDigest)?.closureToken ===
      closure.closureToken
    if (accepted && identityBoundary) {
      removeIndexedBoundariesForIdentity(boundaries, closure.identityDigest)
    }
    for (const candidate of evicted) {
      if (boundaries.byToken.has(candidate.closureToken)) continue
      setIndexedReplayBoundary(boundaries, candidate)
    }

    ledgerChanged = true
    results.push({
      changed: true,
      outcome: accepted ? (existing ? 'refreshed' : 'inserted') : 'stale'
    })
  }

  if (!ledgerChanged) return { ledger, changed: false, results }
  return {
    ledger: {
      ...ledger,
      pages: Object.fromEntries(pages),
      removalBoundaries: Object.fromEntries(boundaries.byToken)
    },
    changed: true,
    results
  }
}

function replayBoundaryForPage(
  page: RetainedPageRecord
): RetainedPageRemovalBoundary {
  return {
    identityDigest: page.identityDigest,
    closureToken: page.closureToken,
    expiresAt: page.closedAt + RETAINED_PAGE_LIFETIME_MS
  }
}

function compareBoundaryOrder(
  left: RetainedPageRemovalBoundary,
  right: RetainedPageRemovalBoundary
): number {
  return left.expiresAt - right.expiresAt ||
    left.closureToken.localeCompare(right.closureToken)
}

function withReplayBoundary(
  boundaries: Readonly<Record<string, RetainedPageRemovalBoundary>>,
  page: RetainedPageRecord
): Readonly<Record<string, RetainedPageRemovalBoundary>> {
  const boundary = replayBoundaryForPage(page)
  return {
    ...omitBoundariesForIdentity(boundaries, page.identityDigest),
    [boundary.closureToken]: boundary
  }
}

export function removeRetainedPageSnapshot(
  ledger: RetainedPageLedger,
  identityDigest: string,
  closureToken: string
): RemoveRetainedPageSnapshotResult {
  const page = ledger.pages[identityDigest]
  if (!page) {
    return { ledger, changed: false, outcome: 'already-absent' }
  }
  if (page.closureToken !== closureToken) {
    return { ledger, changed: false, outcome: 'stale' }
  }

  return {
    ledger: {
      ...ledger,
      pages: omitIdentity(ledger.pages, identityDigest),
      removalBoundaries: withReplayBoundary(ledger.removalBoundaries, page)
    },
    changed: true,
    outcome: 'removed'
  }
}

function omitBoundariesForIdentity(
  boundaries: Readonly<Record<string, RetainedPageRemovalBoundary>>,
  omittedIdentity: string
): Readonly<Record<string, RetainedPageRemovalBoundary>> {
  const next: Record<string, RetainedPageRemovalBoundary> = {}
  for (const [closureToken, boundary] of Object.entries(boundaries)) {
    if (boundary.identityDigest !== omittedIdentity) next[closureToken] = boundary
  }
  return next
}

function compareClosureOrder(
  left: Pick<RetainedPageClosure, 'closedAt' | 'closureToken'>,
  right: Pick<RetainedPageClosure, 'closedAt' | 'closureToken'>
): number {
  return left.closedAt - right.closedAt || left.closureToken.localeCompare(right.closureToken)
}

function omitIdentity<Value>(
  values: Readonly<Record<string, Value>>,
  omittedIdentity: string
): Readonly<Record<string, Value>> {
  const next: Record<string, Value> = {}
  for (const [identity, value] of Object.entries(values)) {
    if (identity !== omittedIdentity) next[identity] = value
  }
  return next
}

export function enforceRetainedPageCapacity(
  pages: Readonly<Record<string, RetainedPageRecord>>
): Readonly<Record<string, RetainedPageRecord>> {
  const records = Object.values(pages)
  if (records.length <= RETAINED_PAGE_CAPACITY) return pages

  const kept = records.toSorted((left, right) =>
    compareRetainedPageOrder(right, left)
  ).slice(0, RETAINED_PAGE_CAPACITY)
  const nextPages: Record<string, RetainedPageRecord> = {}
  for (const page of kept) nextPages[page.identityDigest] = page
  return nextPages
}

export function pruneRetainedPageLedger(
  ledger: RetainedPageLedger,
  now: number
): PruneRetainedPageLedgerResult {
  const pages: Record<string, RetainedPageRecord> = {}
  const removalBoundaries: Record<string, RetainedPageRemovalBoundary> = {}
  const latestBoundaryByIdentity = new Map<string, RetainedPageRemovalBoundary>()
  let removedPages = 0
  let removedBoundaries = 0
  let nextExpiryAt: number | null = null

  function rememberExpiry(expiresAt: number): void {
    if (nextExpiryAt === null || expiresAt < nextExpiryAt) {
      nextExpiryAt = expiresAt
    }
  }

  for (const [identityDigest, page] of Object.entries(ledger.pages)) {
    const expiresAt = page.closedAt + RETAINED_PAGE_LIFETIME_MS
    if (expiresAt <= now) {
      removedPages += 1
    } else {
      pages[identityDigest] = page
      rememberExpiry(expiresAt)
    }
  }

  for (const [closureToken, boundary] of Object.entries(ledger.removalBoundaries)) {
    if (boundary.expiresAt <= now) {
      removedBoundaries += 1
      continue
    }
    rememberExpiry(boundary.expiresAt)
    const previous = latestBoundaryByIdentity.get(boundary.identityDigest)
    if (!previous) {
      removalBoundaries[closureToken] = boundary
      latestBoundaryByIdentity.set(boundary.identityDigest, boundary)
      continue
    }
    removedBoundaries += 1
    if (compareBoundaryOrder(boundary, previous) > 0) {
      delete removalBoundaries[previous.closureToken]
      removalBoundaries[closureToken] = boundary
      latestBoundaryByIdentity.set(boundary.identityDigest, boundary)
    }
  }

  const capacityPages = enforceRetainedPageCapacity(pages)
  removedPages += Object.keys(pages).length - Object.keys(capacityPages).length

  if (removedPages === 0 && removedBoundaries === 0) {
    return {
      ledger,
      changed: false,
      removedPages: 0,
      removedBoundaries: 0,
      nextExpiryAt
    }
  }

  return {
    ledger: { ...ledger, pages: capacityPages, removalBoundaries },
    changed: true,
    removedPages,
    removedBoundaries,
    nextExpiryAt
  }
}

export function createRetainedPageLedgerPruneCache() {
  let cached: {
    readonly observedAt: number
    readonly result: PruneRetainedPageLedgerResult
    readonly source: RetainedPageLedger
  } | null = null

  return (ledger: RetainedPageLedger, now: number): PruneRetainedPageLedgerResult => {
    if (
      cached !== null &&
      cached.source === ledger &&
      now >= cached.observedAt &&
      (cached.result.nextExpiryAt === null || now < cached.result.nextExpiryAt)
    ) return cached.result

    const result = pruneRetainedPageLedger(ledger, now)
    cached = result.changed ? null : { observedAt: now, result, source: ledger }
    return result
  }
}
