import assert from 'node:assert/strict'
import test from 'node:test'
import { ManagedRuntime } from 'effect'

import {
  emptyRetainedPageLedger,
  RETAINED_PAGE_LIFETIME_MS,
  recordRetainedPageClosure
} from '../src/extension/retained-pages-ledger.js'
import {
  RetainedPageLedgerStorage,
  createRetainedPageLedgerStorageDecodeCache,
  decodeRetainedPageLedgerStorageValue,
  encodeRetainedPageLedgerStorageValue,
  parseRetainedPageLedgerValue
} from '../src/extension/retained-pages-storage.js'
import { createRetainedPageIdentity } from '../src/extension/retained-page-identity.js'

test('Retained Page Ledger decoding treats missing storage as empty and accepts a valid envelope', () => {
  const missing = parseRetainedPageLedgerValue(undefined)
  assert.equal(missing.status, 'missing')
  assert.deepEqual(missing.ledger, emptyRetainedPageLedger())

  const stored = recordRetainedPageClosure(emptyRetainedPageLedger(), {
    identityDigest: 'identity-example',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/article',
    url: 'https://example.test/article?view=exact#comment',
    title: 'Example article',
    favIconUrl: 'https://example.test/favicon.ico',
    closedAt: 1_000,
    closureToken: 'lifetime-example'
  }).ledger
  const valid = parseRetainedPageLedgerValue(stored)

  assert.equal(valid.status, 'valid')
  assert.deepEqual(valid.ledger, stored)
})

test('Retained Page Ledger storage reindexes expanded identities and keeps the newest collision', async (t) => {
  const url = 'https://example.test/reindexed'
  const boundaryExpiry = Date.now() + RETAINED_PAGE_LIFETIME_MS
  let stored: unknown = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      'legacy-identity-old': {
        identityDigest: 'legacy-field-disagrees-with-map-key',
        surfaceKind: 'normal-tab',
        canonicalKey: 'legacy-canonical-old',
        url,
        title: 'Older snapshot',
        closedAt: 1_000,
        closureToken: 'lifetime-old'
      },
      'legacy-identity-new': {
        identityDigest: 'legacy-identity-new',
        surfaceKind: 'normal-tab',
        canonicalKey: 'legacy-canonical-new',
        url,
        title: 'Newer snapshot',
        closedAt: 2_000,
        closureToken: 'lifetime-new'
      }
    },
    removalBoundaries: {
      'removed-old': {
        identityDigest: 'legacy-identity-old',
        closureToken: 'removed-old',
        expiresAt: boundaryExpiry
      },
      'removed-new': {
        identityDigest: 'legacy-identity-new',
        closureToken: 'removed-new',
        expiresAt: boundaryExpiry
      }
    }
  }
  let writes = 0
  const runtime = ManagedRuntime.make(RetainedPageLedgerStorage.layer({
    read: async () => stored,
    write: async (ledger) => {
      writes += 1
      stored = ledger
    }
  }, {
    reindexExpandedIdentities: true,
    runtimeId: 'tab-out-id'
  }))
  t.after(() => runtime.dispose())

  const result = await runtime.runPromise(runtime.runSync(RetainedPageLedgerStorage).read())
  const identity = await createRetainedPageIdentity({
    surfaceKind: 'normal-tab',
    url
  }, { runtimeId: 'tab-out-id' })
  assert.ok(identity)

  assert.equal(result.status, 'valid')
  assert.deepEqual(Object.keys(result.ledger.pages), [identity.identityDigest])
  assert.equal(result.ledger.pages[identity.identityDigest]?.closureToken, 'lifetime-new')
  assert.equal(result.ledger.pages[identity.identityDigest]?.canonicalKey, identity.canonicalKey)
  assert.deepEqual(
    Object.values(result.ledger.removalBoundaries).map((boundary) => boundary.identityDigest),
    [identity.identityDigest, identity.identityDigest]
  )
  assert.equal(writes, 1)
})

test('Retained Page Ledger storage merges expanded collisions before enforcing capacity', async (t) => {
  const pages = Object.fromEntries(Array.from({ length: 501 }, (_, index) => {
    const identityDigest = `legacy-identity-${String(index).padStart(3, '0')}`
    const url = index >= 499
      ? 'https://example.test/capacity-collision'
      : `https://example.test/capacity-${index}`
    return [identityDigest, {
      identityDigest,
      surfaceKind: 'normal-tab',
      canonicalKey: `legacy-canonical-${index}`,
      url,
      title: `Expanded page ${index}`,
      closedAt: 1_000 + index,
      closureToken: `lifetime-${String(index).padStart(3, '0')}`
    }]
  }))
  let stored: unknown = {
    schemaVersion: 1,
    identityVersion: 1,
    pages,
    removalBoundaries: {}
  }
  let writes = 0
  const runtime = ManagedRuntime.make(RetainedPageLedgerStorage.layer({
    read: async () => stored,
    write: async (ledger) => {
      writes += 1
      stored = ledger
    }
  }, {
    reindexExpandedIdentities: true,
    runtimeId: 'tab-out-id'
  }))
  t.after(() => runtime.dispose())

  const result = await runtime.runPromise(runtime.runSync(RetainedPageLedgerStorage).read())
  assert.equal(result.status, 'valid')
  assert.equal(Object.keys(result.ledger.pages).length, 500)
  assert.ok(Object.values(result.ledger.pages).some((page) => page.closureToken === 'lifetime-000'))
  assert.ok(Object.values(result.ledger.pages).some((page) => page.closureToken === 'lifetime-500'))
  assert.equal(writes, 1)
})

test('Retained Page Ledger storage trusts current compact keys and leaves newer data opaque', async (t) => {
  const compact = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      'writer-owned-identity': {
        surfaceKind: 'normal-tab',
        url: 'https://example.test/current-compact',
        title: 'Current compact record',
        closedAt: 1_000,
        closureToken: 'lifetime-current'
      }
    },
    removalBoundaries: {}
  }
  let stored: unknown = compact
  let writes = 0
  let hashCalls = 0
  const runtime = ManagedRuntime.make(RetainedPageLedgerStorage.layer({
    read: async () => stored,
    write: async () => {
      writes += 1
    }
  }, {
    reindexExpandedIdentities: true,
    runtimeId: 'tab-out-id',
    sha256: async (input) => {
      hashCalls += 1
      return globalThis.crypto.subtle.digest('SHA-256', input)
    }
  }))
  t.after(() => runtime.dispose())
  const storage = runtime.runSync(RetainedPageLedgerStorage)

  const current = await runtime.runPromise(storage.read())
  assert.equal(current.status, 'valid')
  assert.ok('writer-owned-identity' in current.ledger.pages)
  assert.equal(hashCalls, 0)
  assert.equal(writes, 0)

  stored = {
    schemaVersion: 2,
    identityVersion: 1,
    pages: {
      future: {
        identityDigest: 'future-derived-field',
        surfaceKind: 'normal-tab',
        url: 'https://example.test/future'
      }
    },
    removalBoundaries: {}
  }
  const newer = await runtime.runPromise(storage.read())
  assert.equal(newer.status, 'newer')
  assert.equal(newer.raw, stored)
  assert.equal(hashCalls, 0)
  assert.equal(writes, 0)
})

test('Retained Page Ledger storage compression round-trips the compact field allowlist', async () => {
  const ledger = recordRetainedPageClosure(emptyRetainedPageLedger(), {
    identityDigest: 'identity-example',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/article',
    url: 'https://example.test/article',
    title: 'Example article',
    favIconUrl: 'https://example.test/favicon.ico',
    closedAt: 1_000,
    closureToken: 'lifetime-example'
  }).ledger
  const encoded = await encodeRetainedPageLedgerStorageValue(ledger)
  assert.deepEqual(Object.keys(encoded as Record<string, unknown>).sort(), [
    'data',
    'encoding',
    'identityVersion',
    'schemaVersion'
  ])

  const decoded = await decodeRetainedPageLedgerStorageValue(encoded)
  const parsed = parseRetainedPageLedgerValue(decoded)
  assert.equal(parsed.status, 'valid')
  assert.deepEqual(parsed.ledger, ledger)
})

test('compressed ledger decoding fails closed while preserving unknown newer envelopes', async () => {
  const corrupted = {
    schemaVersion: 1,
    identityVersion: 1,
    encoding: 'gzip-base64-json-v1',
    data: 'not-gzip'
  }
  const decodedCorrupted = await decodeRetainedPageLedgerStorageValue(corrupted)
  assert.equal(decodedCorrupted, corrupted)
  assert.equal(parseRetainedPageLedgerValue(decodedCorrupted).status, 'malformed')

  const newer = {
    schemaVersion: 2,
    identityVersion: 1,
    encoding: 'future-encoding',
    data: 'opaque'
  }
  const decodedNewer = await decodeRetainedPageLedgerStorageValue(newer)
  assert.equal(decodedNewer, newer)
  assert.equal(parseRetainedPageLedgerValue(decodedNewer).status, 'newer')
})

test('compressed ledger cache reuses only an exact known persisted envelope', async () => {
  const firstLedger = recordRetainedPageClosure(emptyRetainedPageLedger(), {
    identityDigest: 'identity-first',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/first',
    url: 'https://example.test/first',
    title: 'First page',
    closedAt: 1_000,
    closureToken: 'lifetime-first'
  }).ledger
  const secondLedger = recordRetainedPageClosure(firstLedger, {
    identityDigest: 'identity-second',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/second',
    url: 'https://example.test/second',
    title: 'Second page',
    closedAt: 2_000,
    closureToken: 'lifetime-second'
  }).ledger
  const firstEncoded = await encodeRetainedPageLedgerStorageValue(firstLedger)
  const secondEncoded = await encodeRetainedPageLedgerStorageValue(secondLedger)
  const cache = createRetainedPageLedgerStorageDecodeCache()

  const firstDecoded = await cache.decode(firstEncoded)
  const repeated = await cache.decode(structuredClone(firstEncoded))
  const changed = await cache.decode(secondEncoded)
  const missing = await cache.decode(undefined)
  const corruptedInput = {
    schemaVersion: 1,
    identityVersion: 1,
    encoding: 'gzip-base64-json-v1',
    data: 'not-gzip'
  }
  const corrupted = await cache.decode(corruptedInput)
  const futureInput = {
    schemaVersion: 2,
    identityVersion: 1,
    encoding: 'future-encoding',
    data: 'opaque'
  }
  const future = await cache.decode(futureInput)
  const returnedToFirst = await cache.decode(structuredClone(firstEncoded))

  assert.equal(repeated, firstDecoded)
  assert.notEqual(changed, firstDecoded)
  assert.equal(missing, undefined)
  assert.equal(corrupted, corruptedInput)
  assert.equal(future, futureInput)
  assert.notEqual(returnedToFirst, firstDecoded)
  assert.deepEqual(returnedToFirst, firstDecoded)
  const parsedChanged = parseRetainedPageLedgerValue(changed)
  assert.notEqual(parsedChanged.status, 'newer')
  if (parsedChanged.status === 'newer') return
  assert.deepEqual(parsedChanged.ledger, secondLedger)
})

test('compressed ledger cache never memoizes undecodable or outer-unknown envelopes', async () => {
  const cache = createRetainedPageLedgerStorageDecodeCache()
  const corrupted = {
    schemaVersion: 1,
    identityVersion: 1,
    encoding: 'gzip-base64-json-v1',
    data: 'not-gzip'
  }
  const newer = {
    schemaVersion: 2,
    identityVersion: 1,
    encoding: 'future-encoding',
    data: 'opaque'
  }

  const firstCorrupted = await cache.decode(corrupted)
  const repeatedCorruptedInput = structuredClone(corrupted)
  const repeatedCorrupted = await cache.decode(repeatedCorruptedInput)
  const firstNewer = await cache.decode(newer)
  const repeatedNewerInput = structuredClone(newer)
  const repeatedNewer = await cache.decode(repeatedNewerInput)

  assert.equal(firstCorrupted, corrupted)
  assert.equal(repeatedCorrupted, repeatedCorruptedInput)
  assert.equal(firstNewer, newer)
  assert.equal(repeatedNewer, repeatedNewerInput)
})

test('compressed ledger cache matches a fresh worker and the persisted compact projection', async () => {
  const ledger = recordRetainedPageClosure(emptyRetainedPageLedger(), {
    identityDigest: 'identity-projected',
    surfaceKind: 'normal-tab',
    canonicalKey: 'intentionally-stale',
    url: 'https://example.test/projected?view=exact',
    title: 'Projected page',
    closedAt: 1_000,
    closureToken: 'lifetime-projected'
  }).ledger
  const encoded = await encodeRetainedPageLedgerStorageValue(ledger)
  const warmCache = createRetainedPageLedgerStorageDecodeCache()
  const restartedCache = createRetainedPageLedgerStorageDecodeCache()

  const warmDecoded = await warmCache.decode(encoded)
  const repeatedWarmDecoded = await warmCache.decode(structuredClone(encoded))
  const restartedDecoded = await restartedCache.decode(structuredClone(encoded))
  const warmParsed = parseRetainedPageLedgerValue(warmDecoded)
  const restartedParsed = parseRetainedPageLedgerValue(restartedDecoded)

  assert.equal(repeatedWarmDecoded, warmDecoded)
  assert.notEqual(restartedDecoded, warmDecoded)
  assert.notEqual(warmParsed.status, 'newer')
  assert.notEqual(restartedParsed.status, 'newer')
  if (warmParsed.status === 'newer' || restartedParsed.status === 'newer') return
  assert.deepEqual(warmParsed.ledger, restartedParsed.ledger)
  assert.equal(
    warmParsed.ledger.pages['identity-projected']?.canonicalKey,
    'https://example.test/projected?view=exact'
  )
})

test('Retained Page Ledger decoding identifies malformed current data for an isolated reset', () => {
  const malformed = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      'identity-example': {
        identityDigest: 'identity-example',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/article',
        url: 'https://example.test/article',
        title: 'Example article',
        closedAt: Number.NaN,
        closureToken: 'lifetime-example'
      }
    },
    removalBoundaries: {}
  })

  assert.equal(malformed.status, 'malformed')
  assert.deepEqual(malformed.ledger, emptyRetainedPageLedger())
})

test('Retained Page Ledger decoding preserves an unknown newer envelope without resetting it', () => {
  const stored = {
    schemaVersion: 2,
    identityVersion: 1,
    pages: { future: { shape: 'unknown' } },
    removalBoundaries: {}
  }
  const newer = parseRetainedPageLedgerValue(stored)

  assert.equal(newer.status, 'newer')
  assert.equal(newer.raw, stored)
})

test('Retained Page Ledger decoding rejects records whose persisted map keys do not match their identities', () => {
  const mismatchedPage = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      'wrong-identity': {
        identityDigest: 'identity-example',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/article',
        url: 'https://example.test/article',
        title: 'Example article',
        closedAt: 1_000,
        closureToken: 'lifetime-example'
      }
    },
    removalBoundaries: {}
  })
  const mismatchedBoundary = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages: {},
    removalBoundaries: {
      'wrong-lifetime': {
        identityDigest: 'identity-example',
        closureToken: 'lifetime-example',
        expiresAt: 1_000 + 30 * 24 * 60 * 60 * 1_000
      }
    }
  })

  assert.equal(mismatchedPage.status, 'malformed')
  assert.equal(mismatchedBoundary.status, 'malformed')
})

test('Retained Page Ledger decoding salvages valid records while dropping invalid timestamps', () => {
  const stored = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      valid: {
        identityDigest: 'valid',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/valid',
        url: 'https://example.test/valid',
        title: 'Valid page',
        closedAt: 900,
        closureToken: 'valid-lifetime'
      },
      future: {
        identityDigest: 'future',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/future',
        url: 'https://example.test/future',
        title: 'Future page',
        closedAt: 1_001,
        closureToken: 'future-lifetime'
      },
      unsafe: {
        identityDigest: 'unsafe',
        surfaceKind: 'app',
        canonicalKey: 'https://example.test/unsafe',
        url: 'https://example.test/unsafe',
        title: 'Unsafe page',
        closedAt: Number.MAX_VALUE,
        closureToken: 'unsafe-lifetime'
      }
    },
    removalBoundaries: {}
  }

  const parsed = parseRetainedPageLedgerValue(stored, 1_000)

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(Object.keys(parsed.ledger.pages), ['valid'])
  assert.deepEqual(parsed.ledger.pages.valid, stored.pages.valid)
})

test('Retained Page Ledger decoding strips metadata-bearing envelopes and records', () => {
  const parsed = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      valid: {
        identityDigest: 'valid',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/valid',
        url: 'https://example.test/valid',
        title: 'Valid page',
        closedAt: 900,
        closureToken: 'valid-lifetime'
      },
      metadata: {
        identityDigest: 'metadata',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/metadata',
        url: 'https://example.test/metadata',
        title: 'Metadata-bearing page',
        closedAt: 900,
        closureToken: 'metadata-lifetime',
        privateNote: 'must not persist'
      }
    },
    removalBoundaries: {},
    privateNote: 'must not persist'
  }, 1_000)

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(Object.keys(parsed.ledger.pages), ['valid'])
  assert.equal('privateNote' in parsed.ledger, false)
})

test('Removal Boundary decoding accepts only its minimal field allowlist', () => {
  const validExpiresAt = 900 + 30 * 24 * 60 * 60 * 1_000
  const parsed = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages: {},
    removalBoundaries: {
      valid: {
        identityDigest: 'identity-valid',
        closureToken: 'valid',
        expiresAt: validExpiresAt
      },
      metadata: {
        identityDigest: 'identity-metadata',
        closureToken: 'metadata',
        expiresAt: validExpiresAt,
        closedAt: 900
      }
    }
  }, 1_000)

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(parsed.ledger.removalBoundaries, {
    valid: {
      identityDigest: 'identity-valid',
      closureToken: 'valid',
      expiresAt: validExpiresAt
    }
  })
})

test('Retained Page Ledger restore enforces metadata bounds and stable fields', () => {
  const base = {
    identityDigest: 'valid',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/valid',
    url: 'https://example.test/valid',
    title: 'Valid page',
    closedAt: 900,
    closureToken: 'valid-lifetime'
  } as const
  const parsed = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      valid: base,
      'empty-token': { ...base, identityDigest: 'empty-token', closureToken: '' },
      'long-title': { ...base, identityDigest: 'long-title', title: 'x'.repeat(513) },
      'blob-favicon': {
        ...base,
        identityDigest: 'blob-favicon',
        favIconUrl: 'blob:https://example.test/private'
      },
      'long-favicon': {
        ...base,
        identityDigest: 'long-favicon',
        favIconUrl: `https://example.test/${'x'.repeat(2_100)}`
      }
    },
    removalBoundaries: {}
  }, 1_000)

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(Object.keys(parsed.ledger.pages), ['valid'])
})

test('Retained Page Ledger restore keeps only the 500 newest valid identities', () => {
  const pages = Object.fromEntries(Array.from({ length: 502 }, (_, index) => {
    const identityDigest = `identity-${index}`
    return [identityDigest, {
      identityDigest,
      surfaceKind: 'normal-tab',
      canonicalKey: `https://example.test/${index}`,
      url: `https://example.test/${index}`,
      title: `Page ${index}`,
      closedAt: index,
      closureToken: `lifetime-${index}`
    }]
  }))
  const parsed = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages,
    removalBoundaries: {}
  }, 1_000)

  assert.equal(parsed.status, 'malformed')
  assert.equal(Object.keys(parsed.ledger.pages).length, 500)
  assert.equal(parsed.ledger.pages['identity-0'], undefined)
  assert.equal(parsed.ledger.pages['identity-1'], undefined)
  assert.ok(parsed.ledger.pages['identity-501'])
})

test('Retained Page Ledger storage reads and writes through one typed background boundary', async (t) => {
  let stored: unknown
  const runtime = ManagedRuntime.make(RetainedPageLedgerStorage.layer({
    read: async () => stored,
    write: async (value) => {
      stored = value
    }
  }))
  t.after(() => runtime.dispose())
  const storage = runtime.runSync(RetainedPageLedgerStorage)
  const ledger = emptyRetainedPageLedger()

  await runtime.runPromise(storage.write(ledger))
  const loaded = await runtime.runPromise(storage.read())

  assert.equal(loaded.status, 'valid')
  assert.deepEqual(loaded.ledger, ledger)
})

test('Retained Page Ledger storage reuses only a byte-identical decoded valid parse', async (t) => {
  let stored: unknown = recordRetainedPageClosure(emptyRetainedPageLedger(), {
    identityDigest: 'identity-cached',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/cached',
    url: 'https://example.test/cached',
    title: 'Cached page',
    closedAt: 1_000,
    closureToken: 'lifetime-cached'
  }).ledger
  const runtime = ManagedRuntime.make(RetainedPageLedgerStorage.layer({
    read: async () => stored,
    write: async (value) => {
      stored = value
    }
  }))
  t.after(() => runtime.dispose())
  const storage = runtime.runSync(RetainedPageLedgerStorage)

  const first = await runtime.runPromise(storage.read())
  const repeated = await runtime.runPromise(storage.read())
  assert.equal(first.status, 'valid')
  assert.equal(repeated, first)

  stored = structuredClone(stored)
  const equalButNew = await runtime.runPromise(storage.read())
  assert.equal(equalButNew.status, 'valid')
  assert.notEqual(equalButNew, first)

  stored = { schemaVersion: 1, identityVersion: 1, pages: { broken: true }, removalBoundaries: {} }
  const malformed = await runtime.runPromise(storage.read())
  const repeatedMalformed = await runtime.runPromise(storage.read())
  assert.equal(malformed.status, 'malformed')
  assert.notEqual(repeatedMalformed, malformed)
})
