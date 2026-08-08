import { createHash } from 'node:crypto'

import { Layer, ManagedRuntime } from 'effect'

import { RetainedPages } from '../../src/extension/background/retained-pages-service.js'
import {
  pruneRetainedPageLedger,
  recordRetainedPageClosure,
  RETAINED_PAGE_CAPACITY,
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageLedger,
  type RetainedPageRemovalBoundary,
  type RetainedPageRecord
} from '../../src/extension/retained-pages-ledger.js'
import {
  OPEN_SURFACE_DURABLE_STORAGE_KEY,
  OpenSurfaceInventoryStorage,
  parseOpenSurfaceInventoryValue,
  type OpenSurfaceInventoryStorageBackend
} from '../../src/extension/open-surface-inventory-storage.js'
import {
  emptyOpenSurfaceInventory,
  type OpenSurfaceInventory,
  type OpenSurfaceInventoryEntry
} from '../../src/extension/open-surface-inventory.js'
import {
  RETAINED_PAGES_STORAGE_KEY,
  RetainedPageLedgerStorage,
  decodeRetainedPageLedgerStorageValue,
  encodeRetainedPageLedgerStorageValue,
  parseRetainedPageLedgerValue,
  type RetainedPageLedgerStorageBackend
} from '../../src/extension/retained-pages-storage.js'
import { RetentionHealth } from '../../src/extension/retention-health.js'

const RETAINED_STORAGE_PROFILE_NOW = 1_800_000_000_000
export const RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES = 10_000
export const RETAINED_STORAGE_PROFILE_DURABLE_SURFACES = 1_000

export interface DurableSurfaceSizeBand {
  readonly count: number
  readonly url: number
  readonly title: number
  readonly favicon: number
}

export const RETAINED_STORAGE_PROFILE_DURABLE_SIZE_BANDS = [
  { count: 700, url: 256, title: 80, favicon: 256 },
  { count: 250, url: 1_024, title: 256, favicon: 1_024 },
  { count: 50, url: 2_048, title: 512, favicon: 2_048 }
] as const satisfies readonly DurableSurfaceSizeBand[]

export interface RetainedStorageSerializedMeasurements {
  readonly retainedLedgerValue: number
  readonly retainedLedgerStorageItem: number
  readonly durableInventoryValue: number
  readonly durableInventoryStorageItem: number
  readonly combinedRetainedLocalItems: number
  readonly retainedLedgerSha256: string
  readonly durableInventorySha256: string
}

export interface RetainedStorageBatchMeasurements {
  readonly closeEvents: number
  readonly outcomes: Readonly<Record<string, number>>
  readonly resultingPages: number
  readonly resultingSessionSurfaces: number
  readonly resultingDurableSurfaces: number
  readonly ledgerWrites: number
  readonly sessionWrites: number
  readonly durableWrites: number
  readonly totalWrites: number
}

export interface RetainedStorageTransitionMeasurements {
  readonly capacityBefore: number
  readonly capacityAfter: number
  readonly capacityEvictedOldest: boolean
  readonly capacityAcceptedNewest: boolean
  readonly pagesBeforeExpiry: number
  readonly pagesAtExpiry: number
  readonly boundariesBeforeExpiry: number
  readonly boundariesAtExpiry: number
}

function fixedHex(index: number, length: number): string {
  return index.toString(16).padStart(length, '0')
}

function exactLengthUrl(prefix: string, length: number): string {
  if (prefix.length > length) {
    throw new Error(`Fixture URL prefix exceeds requested length ${length}`)
  }
  return `${prefix}${'x'.repeat(length - prefix.length)}`
}

function exactCodePointTitle(length: number): string {
  // A four-byte code point makes the fixture exercise the code-point contract,
  // rather than accidentally treating the limit as UTF-16 code units or bytes.
  return '🧪'.repeat(length)
}

function retainedPageFixture(index: number): RetainedPageRecord {
  const label = String(index).padStart(3, '0')
  const url = exactLengthUrl(
    `https://page-${label}.example.test/article?fixture=`,
    2_048
  )
  return {
    identityDigest: fixedHex(index + 1, 64),
    surfaceKind: index < 450 ? 'normal-tab' : 'app',
    canonicalKey: url,
    url,
    title: exactCodePointTitle(512),
    favIconUrl: exactLengthUrl(
      `https://assets.example.test/favicon-${label}?fixture=`,
      2_048
    ),
    closedAt: RETAINED_STORAGE_PROFILE_NOW - (RETAINED_PAGE_CAPACITY - index),
    closureToken: fixedHex(index + 1, 32)
  }
}

function durableBandAt(index: number): DurableSurfaceSizeBand {
  let bandStart = 0
  for (const band of RETAINED_STORAGE_PROFILE_DURABLE_SIZE_BANDS) {
    const bandEnd = bandStart + band.count
    if (index < bandEnd) return band
    bandStart = bandEnd
  }
  throw new Error(`No durable inventory size band for index ${index}`)
}

function durableSurfaceFixture(index: number): OpenSurfaceInventoryEntry {
  const band = durableBandAt(index)
  const label = String(index).padStart(4, '0')
  const url = exactLengthUrl(
    `https://surface-${label}.example.test/page?fixture=`,
    band.url
  )
  return {
    tabId: index + 1,
    closureToken: fixedHex(20_000 + index, 32),
    identityDigest: fixedHex(20_000 + index, 64),
    surfaceKind: index < 900 ? 'normal-tab' : 'app',
    canonicalKey: url,
    url,
    title: exactCodePointTitle(band.title),
    favIconUrl: exactLengthUrl(
      `https://assets.example.test/surface-${label}?fixture=`,
      band.favicon
    )
  }
}

export function buildSaturatedRetainedPageLedger(): RetainedPageLedger {
  const pages: Record<string, RetainedPageRecord> = {}
  for (let index = 0; index < RETAINED_PAGE_CAPACITY; index += 1) {
    const page = retainedPageFixture(index)
    pages[page.identityDigest] = page
  }

  const removalBoundaries: Record<string, RetainedPageRemovalBoundary> = {}
  for (
    let index = 0;
    index < RETAINED_STORAGE_PROFILE_REMOVAL_BOUNDARIES;
    index += 1
  ) {
    const identityDigest = fixedHex(100_000 + index, 64)
    const closureToken = fixedHex(100_000 + index, 32)
    const closedAt = RETAINED_STORAGE_PROFILE_NOW - index
    removalBoundaries[closureToken] = {
      identityDigest,
      closureToken,
      expiresAt: closedAt + RETAINED_PAGE_LIFETIME_MS
    }
  }

  return {
    schemaVersion: 1,
    identityVersion: 1,
    pages,
    removalBoundaries
  }
}

export function buildRepresentativeDurableInventory(): OpenSurfaceInventory {
  const entries: Record<string, OpenSurfaceInventoryEntry> = {}
  for (
    let index = 0;
    index < RETAINED_STORAGE_PROFILE_DURABLE_SURFACES;
    index += 1
  ) {
    const entry = durableSurfaceFixture(index)
    entries[String(entry.tabId)] = entry
  }
  return {
    ...emptyOpenSurfaceInventory(),
    entries
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function sha256(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex')
}

export async function measureRetainedStorageProfile(
  ledger: RetainedPageLedger,
  durableInventory: OpenSurfaceInventory
): Promise<RetainedStorageSerializedMeasurements> {
  const persistedLedger = await encodeRetainedPageLedgerStorageValue(ledger)
  const serializedLedger = JSON.stringify(persistedLedger)
  const serializedInventory = JSON.stringify(durableInventory)
  return {
    retainedLedgerValue: Buffer.byteLength(serializedLedger, 'utf8'),
    retainedLedgerStorageItem: serializedBytes({
      [RETAINED_PAGES_STORAGE_KEY]: persistedLedger
    }),
    durableInventoryValue: Buffer.byteLength(serializedInventory, 'utf8'),
    durableInventoryStorageItem: serializedBytes({
      [OPEN_SURFACE_DURABLE_STORAGE_KEY]: durableInventory
    }),
    combinedRetainedLocalItems: serializedBytes({
      [RETAINED_PAGES_STORAGE_KEY]: persistedLedger,
      [OPEN_SURFACE_DURABLE_STORAGE_KEY]: durableInventory
    }),
    retainedLedgerSha256: sha256(serializedLedger),
    durableInventorySha256: sha256(serializedInventory)
  }
}

export async function roundTripRetainedStorageProfile(
  ledger: RetainedPageLedger,
  durableInventory: OpenSurfaceInventory
): Promise<{
  readonly ledger: ReturnType<typeof parseRetainedPageLedgerValue>
  readonly durableInventory: ReturnType<typeof parseOpenSurfaceInventoryValue>
}> {
  const persistedLedger = await encodeRetainedPageLedgerStorageValue(ledger)
  return {
    ledger: parseRetainedPageLedgerValue(
      await decodeRetainedPageLedgerStorageValue(
        JSON.parse(JSON.stringify(persistedLedger))
      ),
      RETAINED_STORAGE_PROFILE_NOW
    ),
    durableInventory: parseOpenSurfaceInventoryValue(
      JSON.parse(JSON.stringify(durableInventory)),
      RETAINED_STORAGE_PROFILE_NOW
    )
  }
}

export function exerciseRetainedStorageTransitions(
  saturatedLedger: RetainedPageLedger
): RetainedStorageTransitionMeasurements {
  const oldestIdentity = retainedPageFixture(0).identityDigest
  const newest = retainedPageFixture(RETAINED_PAGE_CAPACITY)
  const capped = recordRetainedPageClosure(saturatedLedger, {
    ...newest,
    closedAt: RETAINED_STORAGE_PROFILE_NOW + 1,
    closureToken: fixedHex(RETAINED_PAGE_CAPACITY + 1, 32)
  }).ledger

  const expiringPage = {
    ...retainedPageFixture(0),
    closedAt: RETAINED_STORAGE_PROFILE_NOW - RETAINED_PAGE_LIFETIME_MS
  }
  const survivingPage = {
    ...retainedPageFixture(1),
    closedAt: expiringPage.closedAt + 1,
    closureToken: fixedHex(2, 32)
  }
  const expiringBoundaryToken = fixedHex(200_000, 32)
  const survivingBoundaryToken = fixedHex(200_001, 32)
  const expiryLedger: RetainedPageLedger = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: {
      [expiringPage.identityDigest]: expiringPage,
      [survivingPage.identityDigest]: survivingPage
    },
    removalBoundaries: {
      [expiringBoundaryToken]: {
        identityDigest: fixedHex(200_000, 64),
        closureToken: expiringBoundaryToken,
        expiresAt: RETAINED_STORAGE_PROFILE_NOW
      },
      [survivingBoundaryToken]: {
        identityDigest: fixedHex(200_001, 64),
        closureToken: survivingBoundaryToken,
        expiresAt: RETAINED_STORAGE_PROFILE_NOW + 1
      }
    }
  }
  const beforeExpiry = pruneRetainedPageLedger(
    expiryLedger,
    RETAINED_STORAGE_PROFILE_NOW - 1
  ).ledger
  const atExpiry = pruneRetainedPageLedger(
    expiryLedger,
    RETAINED_STORAGE_PROFILE_NOW
  ).ledger

  return {
    capacityBefore: Object.keys(saturatedLedger.pages).length,
    capacityAfter: Object.keys(capped.pages).length,
    capacityEvictedOldest: capped.pages[oldestIdentity] === undefined,
    capacityAcceptedNewest: capped.pages[newest.identityDigest] !== undefined,
    pagesBeforeExpiry: Object.keys(beforeExpiry.pages).length,
    pagesAtExpiry: Object.keys(atExpiry.pages).length,
    boundariesBeforeExpiry: Object.keys(beforeExpiry.removalBoundaries).length,
    boundariesAtExpiry: Object.keys(atExpiry.removalBoundaries).length
  }
}

function batchInventory(): OpenSurfaceInventory {
  const entries: Record<string, OpenSurfaceInventoryEntry> = {}
  for (let index = 0; index < RETAINED_PAGE_CAPACITY; index += 1) {
    const page = retainedPageFixture(index)
    const tabId = index + 1
    entries[String(tabId)] = {
      tabId,
      closureToken: page.closureToken,
      identityDigest: page.identityDigest,
      surfaceKind: page.surfaceKind,
      canonicalKey: page.canonicalKey,
      url: page.url,
      title: page.title,
      ...(page.favIconUrl ? { favIconUrl: page.favIconUrl } : {})
    }
  }
  return { ...emptyOpenSurfaceInventory(), entries }
}

export async function measureRetainedStorageBatchWrites(): Promise<RetainedStorageBatchMeasurements> {
  let ledgerStored: unknown
  let sessionStored: unknown = batchInventory()
  let durableStored: unknown = sessionStored
  let ledgerWrites = 0
  let sessionWrites = 0
  let durableWrites = 0

  const ledgerBackend: RetainedPageLedgerStorageBackend = {
    read: async () => ledgerStored,
    write: async (value) => {
      ledgerWrites += 1
      ledgerStored = value
    }
  }
  const inventoryBackend: OpenSurfaceInventoryStorageBackend = {
    readSession: async () => sessionStored,
    writeSession: async (value) => {
      sessionWrites += 1
      sessionStored = value
    },
    readDurable: async () => durableStored,
    writeDurable: async (value) => {
      durableWrites += 1
      durableStored = value
    }
  }
  const dependencies = Layer.mergeAll(
    RetainedPageLedgerStorage.layer(ledgerBackend),
    OpenSurfaceInventoryStorage.layer(inventoryBackend),
    RetentionHealth.layer({
      read: async () => undefined,
      write: async () => undefined,
      clear: async () => undefined
    }, () => RETAINED_STORAGE_PROFILE_NOW)
  )
  const runtime = ManagedRuntime.make(
    RetainedPages.layer({ now: () => RETAINED_STORAGE_PROFILE_NOW }).pipe(
      Layer.provide(dependencies)
    )
  )

  try {
    const captured = await runtime.runPromise(
      runtime.runSync(RetainedPages).captureClosedSurfaces(
        Array.from({ length: RETAINED_PAGE_CAPACITY }, (_, index) => index + 1)
      )
    )
    const outcomes: Record<string, number> = {}
    for (const result of captured.results) {
      outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1
    }
    const ledger = parseRetainedPageLedgerValue(
      ledgerStored,
      RETAINED_STORAGE_PROFILE_NOW
    )
    const session = parseOpenSurfaceInventoryValue(
      sessionStored,
      RETAINED_STORAGE_PROFILE_NOW
    )
    const durable = parseOpenSurfaceInventoryValue(
      durableStored,
      RETAINED_STORAGE_PROFILE_NOW
    )
    return {
      closeEvents: captured.results.length,
      outcomes,
      resultingPages: ledger.status === 'newer'
        ? -1
        : Object.keys(ledger.ledger.pages).length,
      resultingSessionSurfaces: session.status === 'newer'
        ? -1
        : Object.keys(session.inventory.entries).length,
      resultingDurableSurfaces: durable.status === 'newer'
        ? -1
        : Object.keys(durable.inventory.entries).length,
      ledgerWrites,
      sessionWrites,
      durableWrites,
      totalWrites: ledgerWrites + sessionWrites + durableWrites
    }
  } finally {
    await runtime.dispose()
  }
}
