import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DASHBOARD_RETAINED_PAGES_WIRE_ENCODING,
  DashboardRetainedPagesWireError,
  createDashboardRetainedPagesWireEncodeCache,
  decodeDashboardRetainedPagesWire,
  encodeDashboardRetainedPagesWire
} from '../src/extension/dashboard-retained-pages-wire.js'
import {
  RETAINED_PAGE_CAPACITY,
  type RetainedPageRecord
} from '../src/extension/retained-pages-ledger.js'
import {
  decodeGzipBase64Json,
  encodeGzipBase64Json
} from '../src/extension/gzip-base64-json.js'
import { buildSaturatedRetainedPageLedger } from './helpers/retained-storage-profile.js'

const now = 1_800_000_000_000

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function objectValue(value: unknown): object {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value
}

function arrayValue(value: unknown): unknown[] {
  assert.ok(Array.isArray(value))
  return value
}

test('dashboard retained-pages wire round-trips an empty projection', async () => {
  const wire = await encodeDashboardRetainedPagesWire([])

  assert.deepEqual(Object.keys(wire).sort(), [
    'data',
    'encoding',
    'identityVersion',
    'schemaVersion'
  ])
  assert.equal(wire.encoding, DASHBOARD_RETAINED_PAGES_WIRE_ENCODING)
  assert.deepEqual(await decodeDashboardRetainedPagesWire(wire, now), [])
})

test('dashboard retained-pages wire preserves every maximum-profile field and order', async () => {
  const pages = Object.values(buildSaturatedRetainedPageLedger().pages)
  const { favIconUrl: _favIconUrl, ...firstPage } = pages[0]!
  const special: RetainedPageRecord = {
    ...firstPage,
    canonicalKey: 'https://example.test/canonical'
  }
  const expected = [special, ...pages.slice(1)]

  const wire = await encodeDashboardRetainedPagesWire(expected)
  const serialized = await decodeGzipBase64Json(wire.data)
  const decoded = await decodeDashboardRetainedPagesWire(wire, now)

  const compact = objectValue(serialized)
  assert.deepEqual(Object.keys(compact).sort(), ['pages', 'titles'])
  assert.deepEqual(Reflect.get(compact, 'titles'), [special.title])
  const compactPages = arrayValue(Reflect.get(compact, 'pages'))
  assert.equal(compactPages.length, RETAINED_PAGE_CAPACITY)
  assert.equal(arrayValue(compactPages[0])[7], special.canonicalKey)
  assert.equal(arrayValue(compactPages[1])[7], null)
  assert.equal(decoded.length, RETAINED_PAGE_CAPACITY)
  assert.deepEqual(decoded, expected)
  assert.ok(
    bytes(wire) < bytes(expected) * 0.1,
    'wire should stay below ten percent of the raw semantic projection'
  )
  assert.equal(JSON.stringify(wire).includes('removalBoundaries'), false)
})

test('dashboard retained-pages wire shares repeated titles by dictionary index', async () => {
  const pages = Object.values(buildSaturatedRetainedPageLedger().pages).slice(0, 3)
  const expected = pages.map((page, index) => ({
    ...page,
    title: index === 1 ? 'Beta title' : 'Alpha title'
  }))

  const wire = await encodeDashboardRetainedPagesWire(expected)
  const compact = objectValue(await decodeGzipBase64Json(wire.data))
  const compactPages = arrayValue(Reflect.get(compact, 'pages'))

  assert.deepEqual(Reflect.get(compact, 'titles'), ['Alpha title', 'Beta title'])
  assert.deepEqual(compactPages.map((page) => arrayValue(page)[3]), [0, 1, 0])
  assert.deepEqual(await decodeDashboardRetainedPagesWire(wire, now), expected)
})

test('dashboard retained-pages wire decodes the earlier expanded v1 payload', async () => {
  const page = Object.values(buildSaturatedRetainedPageLedger().pages)[0]!
  const { canonicalKey: _canonicalKey, ...legacyProjection } = page
  const wire = {
    schemaVersion: 1,
    identityVersion: 1,
    encoding: DASHBOARD_RETAINED_PAGES_WIRE_ENCODING,
    data: await encodeGzipBase64Json([legacyProjection])
  }

  assert.deepEqual(await decodeDashboardRetainedPagesWire(wire, now), [page])
})

test('dashboard retained-pages wire rejects unsupported or corrupt envelopes', async () => {
  const valid = await encodeDashboardRetainedPagesWire([])
  const invalidValues = [
    undefined,
    [],
    { ...valid, schemaVersion: 2 },
    { ...valid, identityVersion: 2 },
    { ...valid, encoding: 'plain-json-v1' },
    { ...valid, data: 'not-base64!' },
    { ...valid, extra: true }
  ]

  for (const value of invalidValues) {
    await assert.rejects(
      decodeDashboardRetainedPagesWire(value, now),
      DashboardRetainedPagesWireError
    )
  }
})

test('dashboard retained-pages wire rejects invalid records and capacity overflow', async () => {
  const page = Object.values(buildSaturatedRetainedPageLedger().pages)[0]!
  const malformedWire = await encodeDashboardRetainedPagesWire([
    { ...page, url: 'javascript:alert(1)' }
  ])
  await assert.rejects(
    decodeDashboardRetainedPagesWire(malformedWire, now),
    DashboardRetainedPagesWireError
  )

  await assert.rejects(
    encodeDashboardRetainedPagesWire(
      Array.from({ length: RETAINED_PAGE_CAPACITY + 1 }, (_, index) => ({
        ...page,
        identityDigest: `${index}`.padStart(64, '0'),
        closureToken: `${index}`.padStart(32, '0')
      }))
    ),
    DashboardRetainedPagesWireError
  )
})

test('dashboard retained-pages wire rejects malformed compact dictionaries and tuples', async () => {
  const page = Object.values(buildSaturatedRetainedPageLedger().pages)[0]!
  const compactPage = [
    page.identityDigest,
    0,
    page.url,
    0,
    page.favIconUrl ?? null,
    page.closedAt,
    page.closureToken,
    null
  ]
  const invalidPayloads = [
    { titles: [page.title], pages: [[...compactPage, 'extra']] },
    { titles: [page.title], pages: [compactPage.with(3, 1)] },
    { titles: [page.title, 'Unused title'], pages: [compactPage] },
    { titles: [page.title, page.title], pages: [compactPage] },
    { titles: [page.title], pages: [compactPage, compactPage] },
    { titles: [], pages: [], extra: true }
  ]

  for (const payload of invalidPayloads) {
    await assert.rejects(
      decodeDashboardRetainedPagesWire({
        schemaVersion: 1,
        identityVersion: 1,
        encoding: DASHBOARD_RETAINED_PAGES_WIRE_ENCODING,
        data: await encodeGzipBase64Json(payload)
      }, now),
      DashboardRetainedPagesWireError
    )
  }
})

test('dashboard retained-pages wire cache reuses only exact semantic JSON', async () => {
  const page = Object.values(buildSaturatedRetainedPageLedger().pages)[0]!
  const changedTitle = `${[...page.title].slice(0, -1).join('')}x`
  const cache = createDashboardRetainedPagesWireEncodeCache()
  const firstFlight = cache.encode([page])

  assert.equal(cache.encode([page]), firstFlight)
  const first = await firstFlight

  const changedFlight = cache.encode([{ ...page, title: changedTitle }])
  assert.notEqual(changedFlight, firstFlight)
  const changed = await changedFlight
  assert.equal(
    (await decodeDashboardRetainedPagesWire(changed, now))[0]?.title,
    changedTitle
  )

  const returned = await cache.encode([page])
  assert.deepEqual(returned, first)
  assert.notEqual(returned, changed)
})

test('dashboard retained-pages wire cache skips reserializing the same immutable records', async () => {
  const page = Object.values(buildSaturatedRetainedPageLedger().pages)[0]!
  let fieldReads = 0
  const observedPage = new Proxy(page, {
    get(target, property, receiver) {
      fieldReads += 1
      return Reflect.get(target, property, receiver)
    }
  })
  const cache = createDashboardRetainedPagesWireEncodeCache()
  const firstFlight = cache.encode([observedPage])
  const firstEncodeReads = fieldReads

  assert.ok(firstEncodeReads > 0)
  assert.equal(cache.encode([observedPage]), firstFlight)
  assert.equal(fieldReads, firstEncodeReads)
  await firstFlight
})
