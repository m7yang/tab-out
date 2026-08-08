import assert from 'node:assert/strict'
import test from 'node:test'

import { Effect } from 'effect'

import {
  RETAINED_PAGES_EXPIRY_ALARM,
  earliestRetainedPageExpiry,
  scheduleRetainedPagesExpiryAlarm
} from '../src/extension/background/retained-pages-expiry-alarm.js'
import {
  emptyRetainedPageLedger,
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageLedger,
  type RetainedPageRecord
} from '../src/extension/retained-pages-ledger.js'

function page(identityDigest: string, closedAt: number): RetainedPageRecord {
  return {
    identityDigest,
    surfaceKind: 'normal-tab',
    canonicalKey: `https://${identityDigest}.example.test/`,
    url: `https://${identityDigest}.example.test/`,
    title: identityDigest,
    closedAt,
    closureToken: `lifetime-${identityDigest}`
  }
}

function ledgerWith(...pages: RetainedPageRecord[]): RetainedPageLedger {
  return {
    ...emptyRetainedPageLedger(),
    pages: Object.fromEntries(pages.map((record) => [record.identityDigest, record]))
  }
}

test('earliestRetainedPageExpiry selects the earliest visible-page expiry deterministically', () => {
  const ledger = ledgerWith(
    page('later', 30_000),
    page('earliest', 10_000),
    page('middle', 20_000)
  )

  assert.equal(
    earliestRetainedPageExpiry(ledger),
    10_000 + RETAINED_PAGE_LIFETIME_MS
  )
})

test('expiry scheduling creates exactly one deterministic alarm at the earliest expiry', async () => {
  const creates: Array<{ name: string; info: chrome.alarms.AlarmCreateInfo }> = []
  const clears: string[] = []
  const ledger = ledgerWith(page('later', 30_000), page('earliest', 10_000))

  await Effect.runPromise(scheduleRetainedPagesExpiryAlarm({
    create: async (name, info) => { creates.push({ name, info }) },
    clear: async (name) => {
      clears.push(name)
      return true
    }
  }, ledger))

  assert.deepEqual(creates, [{
    name: RETAINED_PAGES_EXPIRY_ALARM,
    info: { when: 10_000 + RETAINED_PAGE_LIFETIME_MS }
  }])
  assert.deepEqual(clears, [])
})

test('expiry scheduling clears the named alarm when no retained pages remain', async () => {
  const creates: Array<{ name: string; info: chrome.alarms.AlarmCreateInfo }> = []
  const clears: string[] = []

  await Effect.runPromise(scheduleRetainedPagesExpiryAlarm({
    create: async (name, info) => { creates.push({ name, info }) },
    clear: async (name) => {
      clears.push(name)
      return false
    }
  }, emptyRetainedPageLedger()))

  assert.deepEqual(creates, [])
  assert.deepEqual(clears, [RETAINED_PAGES_EXPIRY_ALARM])
})

test('invisible removal boundaries do not keep the visible-page expiry alarm alive', async () => {
  const clears: string[] = []
  const ledger: RetainedPageLedger = {
    ...emptyRetainedPageLedger(),
    removalBoundaries: {
      'removed-lifetime': {
        identityDigest: 'removed',
        closureToken: 'removed-lifetime',
        expiresAt: 1_000 + RETAINED_PAGE_LIFETIME_MS
      }
    }
  }

  assert.equal(earliestRetainedPageExpiry(ledger), null)
  await Effect.runPromise(scheduleRetainedPagesExpiryAlarm({
    create: async () => assert.fail('must not schedule an alarm for a boundary alone'),
    clear: async (name) => {
      clears.push(name)
      return true
    }
  }, ledger))
  assert.deepEqual(clears, [RETAINED_PAGES_EXPIRY_ALARM])
})

test('alarm transport failures stay typed for service-owned recovery policy', async () => {
  const failure = await Effect.runPromiseExit(scheduleRetainedPagesExpiryAlarm({
    create: async () => { throw new Error('alarm unavailable') },
    clear: async () => true
  }, ledgerWith(page('example', 1_000))))

  assert.equal(failure._tag, 'Failure')
  if (failure._tag === 'Failure') {
    assert.equal(String(failure.cause).includes('RetainedPagesExpiryAlarmError'), true)
  }
})
