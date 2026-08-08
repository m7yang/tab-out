import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRetainedPageLedgerPruneCache,
  emptyRetainedPageLedger,
  pruneRetainedPageLedger,
  recordRetainedPageClosure,
  recordRetainedPageClosures,
  removeRetainedPageSnapshot,
  RETAINED_PAGE_CAPACITY,
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageClosure
} from '../src/extension/retained-pages-ledger.js'

const closure: RetainedPageClosure = {
  identityDigest: 'identity-example',
  surfaceKind: 'normal-tab',
  canonicalKey: 'https://example.test/article',
  url: 'https://example.test/article',
  title: 'Example article',
  favIconUrl: 'https://example.test/favicon.ico',
  closedAt: 1_000,
  closureToken: 'lifetime-example'
}

test('a genuine closure creates one retained page and replaying its lifetime is a no-op', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)

  assert.equal(inserted.outcome, 'inserted')
  assert.equal(inserted.changed, true)
  assert.deepEqual(Object.keys(inserted.ledger.pages), ['identity-example'])
  assert.equal(inserted.ledger.pages['identity-example']?.closedAt, 1_000)

  const replayed = recordRetainedPageClosure(inserted.ledger, {
    ...closure,
    closedAt: 9_000
  })

  assert.equal(replayed.outcome, 'replayed')
  assert.equal(replayed.changed, false)
  assert.equal(replayed.ledger, inserted.ledger)
  assert.equal(replayed.ledger.pages['identity-example']?.closedAt, 1_000)
})

test('a newer closure refreshes one identity while an older delayed closure cannot move it backward', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const refreshed = recordRetainedPageClosure(inserted.ledger, {
    ...closure,
    title: 'Updated article',
    closedAt: 3_000,
    closureToken: 'lifetime-newer'
  })

  assert.equal(refreshed.outcome, 'refreshed')
  assert.equal(refreshed.changed, true)
  assert.deepEqual(Object.keys(refreshed.ledger.pages), ['identity-example'])
  assert.equal(refreshed.ledger.pages['identity-example']?.title, 'Updated article')
  assert.equal(refreshed.ledger.pages['identity-example']?.closedAt, 3_000)

  const delayed = recordRetainedPageClosure(refreshed.ledger, {
    ...closure,
    title: 'Delayed stale article',
    closedAt: 2_000,
    closureToken: 'lifetime-delayed'
  })

  assert.equal(delayed.outcome, 'stale')
  assert.equal(delayed.changed, false)
  assert.equal(delayed.ledger, refreshed.ledger)
  assert.equal(delayed.ledger.pages['identity-example']?.title, 'Updated article')
  assert.equal(delayed.ledger.pages['identity-example']?.closedAt, 3_000)
})

test('a newer closure updates its target while preserving useful prior metadata', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const { favIconUrl: _favIconUrl, ...closureWithoutFavicon } = closure
  const refreshed = recordRetainedPageClosure(inserted.ledger, {
    ...closureWithoutFavicon,
    url: 'https://example.test/article?new-target',
    title: '',
    closedAt: 2_000,
    closureToken: 'lifetime-new-target'
  })

  assert.equal(refreshed.outcome, 'refreshed')
  assert.deepEqual(refreshed.ledger.pages['identity-example'], {
    ...closure,
    url: 'https://example.test/article?new-target',
    closedAt: 2_000,
    closureToken: 'lifetime-new-target'
  })
})

test('equal-time closures use their stable lifetime tokens as a deterministic tie-breaker', () => {
  const first = recordRetainedPageClosure(emptyRetainedPageLedger(), {
    ...closure,
    closureToken: 'lifetime-middle'
  })
  const earlierTie = recordRetainedPageClosure(first.ledger, {
    ...closure,
    title: 'Lower token',
    closureToken: 'lifetime-before'
  })
  const laterTie = recordRetainedPageClosure(first.ledger, {
    ...closure,
    title: 'Higher token',
    closureToken: 'lifetime-zed'
  })

  assert.equal(earlierTie.outcome, 'stale')
  assert.equal(earlierTie.changed, false)
  assert.equal(earlierTie.ledger, first.ledger)
  assert.equal(laterTie.outcome, 'refreshed')
  assert.equal(laterTie.ledger.pages['identity-example']?.title, 'Higher token')
})

test('retained pages expire at 30 days but remain visible inside the lifetime', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)

  const stillActive = pruneRetainedPageLedger(
    inserted.ledger,
    closure.closedAt + RETAINED_PAGE_LIFETIME_MS - 1
  )
  assert.equal(stillActive.changed, false)
  assert.equal(stillActive.ledger, inserted.ledger)
  assert.equal(
    stillActive.nextExpiryAt,
    closure.closedAt + RETAINED_PAGE_LIFETIME_MS
  )

  const expired = pruneRetainedPageLedger(
    inserted.ledger,
    closure.closedAt + RETAINED_PAGE_LIFETIME_MS
  )
  assert.equal(expired.changed, true)
  assert.equal(expired.removedPages, 1)
  assert.equal(expired.nextExpiryAt, null)
  assert.deepEqual(expired.ledger.pages, {})
})

test('retained-page prune cache reuses a ledger only before its next expiry', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const prune = createRetainedPageLedgerPruneCache()
  const first = prune(inserted.ledger, 2_000)
  const repeated = prune(inserted.ledger, 3_000)

  assert.equal(repeated, first)

  const atExpiry = prune(
    inserted.ledger,
    closure.closedAt + RETAINED_PAGE_LIFETIME_MS
  )
  assert.notEqual(atExpiry, first)
  assert.equal(atExpiry.changed, true)

  const rollbackPrune = createRetainedPageLedgerPruneCache()
  const later = rollbackPrune(inserted.ledger, 3_000)
  const earlier = rollbackPrune(inserted.ledger, 2_000)
  assert.notEqual(earlier, later)
})

test('the global capacity keeps the 500 most recently closed identities', () => {
  let ledger = emptyRetainedPageLedger()
  for (let index = 0; index <= RETAINED_PAGE_CAPACITY; index += 1) {
    const identity = `identity-${String(index).padStart(3, '0')}`
    ledger = recordRetainedPageClosure(ledger, {
      ...closure,
      identityDigest: identity,
      canonicalKey: `https://example.test/${index}`,
      url: `https://example.test/${index}`,
      closedAt: closure.closedAt + index,
      closureToken: `lifetime-${index}`
    }).ledger
  }

  assert.equal(Object.keys(ledger.pages).length, RETAINED_PAGE_CAPACITY)
  assert.equal(ledger.pages['identity-000'], undefined)
  assert.equal(ledger.pages[`identity-${RETAINED_PAGE_CAPACITY}`]?.closedAt, 1_500)
  assert.deepEqual(ledger.removalBoundaries['lifetime-0'], {
    identityDigest: 'identity-000',
    closureToken: 'lifetime-0',
    expiresAt: closure.closedAt + RETAINED_PAGE_LIFETIME_MS
  })
})

test('bulk recording applies mixed ordered outcomes and capacity boundaries', () => {
  let ledger = emptyRetainedPageLedger()
  for (let index = 0; index < RETAINED_PAGE_CAPACITY; index += 1) {
    ledger = recordRetainedPageClosure(ledger, {
      ...closure,
      identityDigest: `identity-${index}`,
      canonicalKey: `https://example.test/${index}`,
      url: `https://example.test/${index}`,
      closedAt: 2_000 + index,
      closureToken: `lifetime-${index}`
    }).ledger
  }
  ledger = removeRetainedPageSnapshot(
    ledger,
    'identity-250',
    'lifetime-250'
  ).ledger

  const closures: RetainedPageClosure[] = [
    {
      ...closure,
      identityDigest: 'identity-new',
      canonicalKey: 'https://example.test/new',
      url: 'https://example.test/new',
      closedAt: 3_000,
      closureToken: 'lifetime-new'
    },
    {
      ...closure,
      identityDigest: 'identity-400',
      canonicalKey: 'https://example.test/400',
      url: 'https://example.test/400?newest',
      title: 'Newest 400',
      closedAt: 4_000,
      closureToken: 'lifetime-400-new'
    },
    {
      ...closure,
      identityDigest: 'identity-250',
      canonicalKey: 'https://example.test/250',
      url: 'https://example.test/250',
      closedAt: 2_250,
      closureToken: 'lifetime-250'
    },
    {
      ...closure,
      identityDigest: 'identity-too-old',
      canonicalKey: 'https://example.test/too-old',
      url: 'https://example.test/too-old',
      closedAt: 1,
      closureToken: 'lifetime-too-old'
    }
  ]

  const bulk = recordRetainedPageClosures(ledger, closures)

  assert.deepEqual(bulk.results, [
    { changed: true, outcome: 'inserted' },
    { changed: true, outcome: 'refreshed' },
    { changed: false, outcome: 'blocked' },
    { changed: true, outcome: 'stale' }
  ])
  assert.equal(bulk.changed, true)
  assert.equal(Object.keys(bulk.ledger.pages).length, RETAINED_PAGE_CAPACITY)
  assert.equal(bulk.ledger.pages['identity-new']?.closureToken, 'lifetime-new')
  assert.equal(bulk.ledger.pages['identity-400']?.url, 'https://example.test/400?newest')
  assert.equal(bulk.ledger.pages['identity-250'], undefined)
  assert.equal(bulk.ledger.pages['identity-too-old'], undefined)
  assert.deepEqual(bulk.ledger.removalBoundaries['lifetime-too-old'], {
    identityDigest: 'identity-too-old',
    closureToken: 'lifetime-too-old',
    expiresAt: 1 + RETAINED_PAGE_LIFETIME_MS
  })
})

test('bulk recording keeps replay, stale, and equal-time ordering deterministic', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const bulk = recordRetainedPageClosures(inserted.ledger, [
    { ...closure, closedAt: 9_000 },
    { ...closure, closedAt: 500, closureToken: 'lifetime-older' },
    { ...closure, closedAt: 1_000, closureToken: 'lifetime-zed' },
    {
      ...closure,
      identityDigest: 'identity-second',
      canonicalKey: 'https://example.test/second',
      url: 'https://example.test/second',
      closedAt: 1_500,
      closureToken: 'lifetime-second'
    }
  ])

  assert.deepEqual(bulk.results.map((result) => result.outcome), [
    'replayed',
    'stale',
    'refreshed',
    'inserted'
  ])
  assert.equal(bulk.ledger.pages['identity-example']?.closureToken, 'lifetime-zed')
  assert.equal(bulk.ledger.pages['identity-second']?.closedAt, 1_500)
})

test('an all-no-op bulk preserves the original ledger reference', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const bulk = recordRetainedPageClosures(inserted.ledger, [
    { ...closure, closedAt: 9_000 },
    { ...closure, closedAt: 500, closureToken: 'lifetime-older' }
  ])

  assert.equal(bulk.changed, false)
  assert.equal(bulk.ledger, inserted.ledger)
  assert.deepEqual(bulk.results.map((result) => result.outcome), [
    'replayed',
    'stale'
  ])
})

test('a delayed candidate older than a saturated ledger gets a replay boundary', () => {
  let ledger = emptyRetainedPageLedger()
  for (let index = 0; index < RETAINED_PAGE_CAPACITY; index += 1) {
    ledger = recordRetainedPageClosure(ledger, {
      ...closure,
      identityDigest: `identity-${index}`,
      canonicalKey: `https://example.test/${index}`,
      url: `https://example.test/${index}`,
      closedAt: 1_000 + index,
      closureToken: `lifetime-${index}`
    }).ledger
  }
  ledger = {
    ...ledger,
    removalBoundaries: {
      'lifetime-delayed-older': {
        identityDigest: 'identity-delayed',
        closureToken: 'lifetime-delayed-older',
        expiresAt: 400 + RETAINED_PAGE_LIFETIME_MS
      }
    }
  }

  const delayed = recordRetainedPageClosure(ledger, {
    ...closure,
    identityDigest: 'identity-delayed',
    canonicalKey: 'https://example.test/delayed',
    url: 'https://example.test/delayed',
    closedAt: 500,
    closureToken: 'lifetime-delayed'
  })

  assert.equal(delayed.outcome, 'stale')
  assert.equal(delayed.changed, true)
  assert.equal(delayed.ledger.pages['identity-delayed'], undefined)
  assert.deepEqual(delayed.ledger.removalBoundaries['lifetime-delayed'], {
    identityDigest: 'identity-delayed',
    closureToken: 'lifetime-delayed',
    expiresAt: 500 + RETAINED_PAGE_LIFETIME_MS
  })
  assert.equal(
    delayed.ledger.removalBoundaries['lifetime-delayed-older'],
    undefined
  )

  const withSpace = {
    ...delayed.ledger,
    pages: Object.fromEntries(
      Object.entries(delayed.ledger.pages).slice(1)
    )
  }
  const replayed = recordRetainedPageClosure(withSpace, {
    ...closure,
    identityDigest: 'identity-delayed',
    canonicalKey: 'https://example.test/delayed',
    url: 'https://example.test/delayed',
    closedAt: 500,
    closureToken: 'lifetime-delayed'
  })

  assert.equal(replayed.outcome, 'blocked')
  assert.equal(replayed.changed, false)
  assert.equal(replayed.ledger, withSpace)
  assert.equal(replayed.ledger.pages['identity-delayed'], undefined)
})

test('pruning keeps only the newest replay boundary for one identity', () => {
  const ledger = {
    ...emptyRetainedPageLedger(),
    removalBoundaries: {
      older: {
        identityDigest: 'identity-example',
        closureToken: 'older',
        expiresAt: 1_000 + RETAINED_PAGE_LIFETIME_MS
      },
      newer: {
        identityDigest: 'identity-example',
        closureToken: 'newer',
        expiresAt: 2_000 + RETAINED_PAGE_LIFETIME_MS
      }
    }
  }

  const pruned = pruneRetainedPageLedger(ledger, 3_000)

  assert.equal(pruned.changed, true)
  assert.equal(pruned.removedBoundaries, 1)
  assert.deepEqual(Object.keys(pruned.ledger.removalBoundaries), ['newer'])
})

test('removal keeps only a replay boundary and a genuinely newer closure can return', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const removed = removeRetainedPageSnapshot(
    inserted.ledger,
    closure.identityDigest,
    closure.closureToken
  )

  assert.equal(removed.outcome, 'removed')
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.ledger.pages, {})
  assert.deepEqual(removed.ledger.removalBoundaries['lifetime-example'], {
    identityDigest: 'identity-example',
    closureToken: 'lifetime-example',
    expiresAt: 1_000 + RETAINED_PAGE_LIFETIME_MS
  })

  const replayed = recordRetainedPageClosure(removed.ledger, {
    ...closure,
    closedAt: 9_000
  })
  assert.equal(replayed.outcome, 'blocked')
  assert.equal(replayed.changed, false)
  assert.equal(replayed.ledger, removed.ledger)

  const newer = recordRetainedPageClosure(removed.ledger, {
    ...closure,
    title: 'Newly closed article',
    closedAt: 10_000,
    closureToken: 'lifetime-after-removal'
  })
  assert.equal(newer.outcome, 'inserted')
  assert.equal(newer.changed, true)
  assert.equal(newer.ledger.pages['identity-example']?.title, 'Newly closed article')
  assert.deepEqual(newer.ledger.removalBoundaries, {})
})

test('a removed lifetime stays blocked when a known identity reindex changes its digest', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const removed = removeRetainedPageSnapshot(
    inserted.ledger,
    closure.identityDigest,
    closure.closureToken
  )

  const replayedAfterReindex = recordRetainedPageClosure(removed.ledger, {
    ...closure,
    identityDigest: 'identity-reindexed',
    canonicalKey: 'https://example.test/article-canonical-v2',
    closedAt: 9_000
  })

  assert.equal(replayedAfterReindex.outcome, 'blocked')
  assert.equal(replayedAfterReindex.changed, false)
  assert.equal(replayedAfterReindex.ledger, removed.ledger)
  assert.deepEqual(replayedAfterReindex.ledger.pages, {})
})

test('a removal boundary expires at the removed snapshot original horizon', () => {
  const inserted = recordRetainedPageClosure(emptyRetainedPageLedger(), closure)
  const removed = removeRetainedPageSnapshot(
    inserted.ledger,
    closure.identityDigest,
    closure.closureToken
  )

  const stillProtected = pruneRetainedPageLedger(
    removed.ledger,
    closure.closedAt + RETAINED_PAGE_LIFETIME_MS - 1
  )
  assert.equal(stillProtected.changed, false)
  assert.equal(stillProtected.ledger, removed.ledger)

  const expired = pruneRetainedPageLedger(
    removed.ledger,
    closure.closedAt + RETAINED_PAGE_LIFETIME_MS
  )
  assert.equal(expired.changed, true)
  assert.equal(expired.removedPages, 0)
  assert.equal(expired.removedBoundaries, 1)
  assert.deepEqual(expired.ledger.removalBoundaries, {})
})
