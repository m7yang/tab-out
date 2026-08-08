import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RETAINED_PAGE_CAPACITY,
  RETAINED_PAGE_LIFETIME_MS
} from '../src/extension/retained-pages-ledger.js'
import {
  buildRepresentativeDurableInventory,
  buildSaturatedRetainedPageLedger,
  exerciseRetainedStorageTransitions,
  measureRetainedStorageBatchWrites,
  measureRetainedStorageProfile,
  RETAINED_STORAGE_PROFILE_DURABLE_SIZE_BANDS,
  RETAINED_STORAGE_PROFILE_DURABLE_SURFACES,
  RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES,
  roundTripRetainedStorageProfile
} from './helpers/retained-storage-profile.js'

const CHROME_LOCAL_QUOTA_BYTES = 10 * 1_024 * 1_024

test('the deterministic retained-storage profile round-trips exact saturated counts and sizes', async (t) => {
  const ledger = buildSaturatedRetainedPageLedger()
  const durableInventory = buildRepresentativeDurableInventory()
  const measurements = await measureRetainedStorageProfile(ledger, durableInventory)
  const roundTrip = await roundTripRetainedStorageProfile(ledger, durableInventory)

  assert.equal(roundTrip.ledger.status, 'valid')
  assert.equal(roundTrip.durableInventory.status, 'valid')
  if (roundTrip.ledger.status !== 'valid') return
  if (roundTrip.durableInventory.status !== 'valid') return

  assert.equal(Object.keys(roundTrip.ledger.ledger.pages).length, RETAINED_PAGE_CAPACITY)
  assert.equal(
    Object.keys(roundTrip.ledger.ledger.removalBoundaries).length,
    RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES
  )
  for (const page of Object.values(roundTrip.ledger.ledger.pages)) {
    assert.equal(page.url.length, 2_048)
    assert.equal(page.canonicalKey.length, 2_048)
    assert.equal(Array.from(page.title).length, 512)
    assert.equal(page.favIconUrl?.length, 2_048)
  }

  const entries = Object.values(roundTrip.durableInventory.inventory.entries)
  assert.equal(entries.length, RETAINED_STORAGE_PROFILE_DURABLE_SURFACES)
  assert.equal(entries.filter((entry) => entry.surfaceKind === 'normal-tab').length, 900)
  assert.equal(entries.filter((entry) => entry.surfaceKind === 'app').length, 100)
  let bandStart = 0
  for (const band of RETAINED_STORAGE_PROFILE_DURABLE_SIZE_BANDS) {
    const bandEntries = entries.slice(bandStart, bandStart + band.count)
    assert.equal(bandEntries.length, band.count)
    for (const entry of bandEntries) {
      assert.equal(entry.url.length, band.url)
      assert.equal(entry.canonicalKey.length, band.url)
      assert.equal(Array.from(entry.title).length, band.title)
      assert.equal(entry.favIconUrl?.length, band.favicon)
    }
    bandStart += band.count
  }

  assert.ok(measurements.retainedLedgerValue > 0)
  assert.ok(measurements.durableInventoryValue > 0)
  assert.ok(measurements.combinedRetainedLocalItems > measurements.retainedLedgerValue)
  assert.ok(
    measurements.combinedRetainedLocalItems <= CHROME_LOCAL_QUOTA_BYTES * 0.5,
    'the deterministic retained keys must stay within half of Chrome local quota'
  )
  assert.match(measurements.retainedLedgerSha256, /^[0-9a-f]{64}$/)
  assert.match(measurements.durableInventorySha256, /^[0-9a-f]{64}$/)
  t.diagnostic(`deterministic retained-storage measurements: ${JSON.stringify({
    profile: {
      retainedPages: RETAINED_PAGE_CAPACITY,
      retainedPageSizes: { url: 2_048, titleCodePoints: 512, favicon: 2_048 },
      removalBoundaries: RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES,
      durableInventorySurfaces: RETAINED_STORAGE_PROFILE_DURABLE_SURFACES,
      durableInventoryBands: RETAINED_STORAGE_PROFILE_DURABLE_SIZE_BANDS
    },
    serializedBytes: measurements,
    authority: 'Node UTF-8 JSON bytes only; Chrome getBytesInUse and quota share require the installed-extension probe.'
  })}`)
})

test('the deterministic retained ledger crosses expiry and capacity boundaries exactly', (t) => {
  const measurements = exerciseRetainedStorageTransitions(
    buildSaturatedRetainedPageLedger()
  )

  assert.deepEqual(measurements, {
    capacityBefore: RETAINED_PAGE_CAPACITY,
    capacityAfter: RETAINED_PAGE_CAPACITY,
    capacityEvictedOldest: true,
    capacityAcceptedNewest: true,
    pagesBeforeExpiry: 2,
    pagesAtExpiry: 1,
    boundariesBeforeExpiry: 2,
    boundariesAtExpiry: 1
  })
  assert.equal(RETAINED_PAGE_LIFETIME_MS, 30 * 24 * 60 * 60 * 1_000)
  t.diagnostic(`deterministic retained-storage transitions: ${JSON.stringify(measurements)}`)
})

test('a deterministic 500-close batch uses one ledger write and bounded two-phase inventory writes', async (t) => {
  const measurements = await measureRetainedStorageBatchWrites()

  assert.equal(measurements.closeEvents, 500)
  assert.deepEqual(measurements.outcomes, { inserted: 500 })
  assert.equal(measurements.resultingPages, 500)
  assert.equal(measurements.resultingSessionSurfaces, 0)
  assert.equal(measurements.resultingDurableSurfaces, 0)
  assert.ok(measurements.ledgerWrites <= 3)
  assert.equal(measurements.ledgerWrites, 1)
  assert.equal(measurements.sessionWrites, 2)
  assert.equal(measurements.durableWrites, 2)
  assert.equal(measurements.totalWrites, 5)
  t.diagnostic(`deterministic retained-storage 500-close batch: ${JSON.stringify({
    ...measurements,
    authority: 'Write counts only; one-second p95 requires five warmups and 30 installed-extension measurements.'
  })}`)
})
