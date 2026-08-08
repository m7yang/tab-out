import { Schema } from 'effect'

import {
  RETAINED_PAGE_CAPACITY,
  type RetainedPageRecord
} from './retained-pages-ledger.js'
import { parseRetainedPageLedgerValue } from './retained-pages-storage.js'
import {
  decodeGzipBase64Json,
  encodeGzipBase64Text
} from './gzip-base64-json.js'

export const DASHBOARD_RETAINED_PAGES_WIRE_ENCODING = 'gzip-base64-json-v1'

export interface DashboardRetainedPagesWire {
  readonly schemaVersion: 1
  readonly identityVersion: 1
  readonly encoding: typeof DASHBOARD_RETAINED_PAGES_WIRE_ENCODING
  readonly data: string
}

export const dashboardRetainedPagesWireSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  identityVersion: Schema.Literals([1]),
  encoding: Schema.Literals([DASHBOARD_RETAINED_PAGES_WIRE_ENCODING]),
  data: Schema.String
})

export class DashboardRetainedPagesWireError extends Schema.TaggedErrorClass<DashboardRetainedPagesWireError>()(
  'DashboardRetainedPagesWireError',
  {
    operation: Schema.Literals(['encode', 'decode']),
    cause: Schema.Defect()
  }
) {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const wireKeys = new Set([
  'schemaVersion',
  'identityVersion',
  'encoding',
  'data'
])
const compactPayloadKeys = new Set(['pages', 'titles'])

type CompactSurfaceKind = 0 | 1

type CompactRetainedPage = readonly [
  identityDigest: string,
  surfaceKind: CompactSurfaceKind,
  url: string,
  titleIndex: number,
  favIconUrl: string | null,
  closedAt: number,
  closureToken: string,
  canonicalKeyOverride: string | null
]

interface CompactRetainedPagesPayload {
  readonly titles: readonly string[]
  readonly pages: readonly CompactRetainedPage[]
}

function parseWire(value: unknown): DashboardRetainedPagesWire | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.identityVersion !== 1 ||
    value.encoding !== DASHBOARD_RETAINED_PAGES_WIRE_ENCODING ||
    typeof value.data !== 'string' ||
    Object.keys(value).some((key) => !wireKeys.has(key))
  ) return null
  return {
    schemaVersion: 1,
    identityVersion: 1,
    encoding: DASHBOARD_RETAINED_PAGES_WIRE_ENCODING,
    data: value.data
  }
}

function validateDecodedPages(
  value: unknown,
  now: number
): RetainedPageRecord[] {
  if (!Array.isArray(value) || value.length > RETAINED_PAGE_CAPACITY) {
    throw new Error('Invalid retained-page projection size')
  }

  const pages: Record<string, unknown> = {}
  const identities: string[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.identityDigest !== 'string') {
      throw new Error('Invalid retained-page projection record')
    }
    const identityDigest = candidate.identityDigest
    if (Object.hasOwn(pages, identityDigest)) {
      throw new Error('Duplicate retained-page projection identity')
    }
    pages[identityDigest] = candidate
    identities.push(identityDigest)
  }

  const parsed = parseRetainedPageLedgerValue({
    schemaVersion: 1,
    identityVersion: 1,
    pages,
    removalBoundaries: {}
  }, now)
  if (
    parsed.status !== 'valid' ||
    Object.keys(parsed.ledger.pages).length !== identities.length
  ) {
    throw new Error('Invalid retained-page projection records')
  }
  return identities.map((identityDigest) => {
    const page = parsed.ledger.pages[identityDigest]
    if (!page) throw new Error('Missing retained-page projection record')
    return page
  })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Expand the compact transient projection into the existing semantic record
 * shape. An array is the earlier expanded v1 payload and remains supported
 * while already-issued startup requests can still be in flight.
 */
function expandDashboardRetainedPagesPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !compactPayloadKeys.has(key)) ||
    !isStringArray(value.titles) ||
    !Array.isArray(value.pages) ||
    value.titles.length > RETAINED_PAGE_CAPACITY ||
    value.pages.length > RETAINED_PAGE_CAPACITY ||
    new Set(value.titles).size !== value.titles.length
  ) {
    throw new Error('Invalid compact retained-page projection')
  }

  const titles = value.titles
  const usedTitleIndexes = new Set<number>()
  const pages = value.pages.map((candidate): RetainedPageRecord => {
    if (!Array.isArray(candidate) || candidate.length !== 8) {
      throw new Error('Invalid compact retained-page projection record')
    }

    const [
      identityDigest,
      surfaceKind,
      url,
      titleIndex,
      favIconUrl,
      closedAt,
      closureToken,
      canonicalKeyOverride
    ] = candidate
    if (
      typeof identityDigest !== 'string' ||
      (surfaceKind !== 0 && surfaceKind !== 1) ||
      typeof url !== 'string' ||
      !Number.isSafeInteger(titleIndex) ||
      titleIndex < 0 ||
      titleIndex >= titles.length ||
      (favIconUrl !== null && typeof favIconUrl !== 'string') ||
      typeof closedAt !== 'number' ||
      typeof closureToken !== 'string' ||
      (canonicalKeyOverride !== null && typeof canonicalKeyOverride !== 'string')
    ) {
      throw new Error('Invalid compact retained-page projection record')
    }

    const title = titles[titleIndex]
    if (title === undefined) {
      throw new Error('Missing compact retained-page projection title')
    }
    usedTitleIndexes.add(titleIndex)
    return {
      identityDigest,
      surfaceKind: surfaceKind === 0 ? 'normal-tab' : 'app',
      canonicalKey: canonicalKeyOverride ?? url,
      url,
      title,
      ...(favIconUrl === null ? {} : { favIconUrl }),
      closedAt,
      closureToken
    }
  })

  if (usedTitleIndexes.size !== titles.length) {
    throw new Error('Unused compact retained-page projection title')
  }
  return pages
}

function serializeDashboardRetainedPages(
  pages: readonly RetainedPageRecord[]
): string {
  if (pages.length > RETAINED_PAGE_CAPACITY) {
    throw new Error('Retained-page projection exceeds capacity')
  }

  const titles: string[] = []
  const titleIndexes = new Map<string, number>()
  const compactPages: CompactRetainedPage[] = pages.map((page) => {
    let titleIndex = titleIndexes.get(page.title)
    if (titleIndex === undefined) {
      titleIndex = titles.length
      titles.push(page.title)
      titleIndexes.set(page.title, titleIndex)
    }
    return [
      page.identityDigest,
      page.surfaceKind === 'normal-tab' ? 0 : 1,
      page.url,
      titleIndex,
      page.favIconUrl ?? null,
      page.closedAt,
      page.closureToken,
      page.canonicalKey === page.url ? null : page.canonicalKey
    ]
  })
  const payload: CompactRetainedPagesPayload = {
    titles,
    pages: compactPages
  }
  return JSON.stringify(payload)
}

async function encodeSerializedDashboardRetainedPages(
  serialized: string
): Promise<DashboardRetainedPagesWire> {
  try {
    return {
      schemaVersion: 1,
      identityVersion: 1,
      encoding: DASHBOARD_RETAINED_PAGES_WIRE_ENCODING,
      data: await encodeGzipBase64Text(serialized)
    }
  } catch (cause) {
    throw DashboardRetainedPagesWireError.make({ operation: 'encode', cause })
  }
}

export function encodeDashboardRetainedPagesWire(
  pages: readonly RetainedPageRecord[]
): Promise<DashboardRetainedPagesWire> {
  try {
    return encodeSerializedDashboardRetainedPages(
      serializeDashboardRetainedPages(pages)
    )
  } catch (cause) {
    return Promise.reject(
      DashboardRetainedPagesWireError.make({ operation: 'encode', cause })
    )
  }
}

export function createDashboardRetainedPagesWireEncodeCache() {
  let cached: {
    readonly pages: readonly RetainedPageRecord[]
    readonly serialized: string
    readonly flight: Promise<DashboardRetainedPagesWire>
  } | null = null

  return {
    encode(
      pages: readonly RetainedPageRecord[]
    ): Promise<DashboardRetainedPagesWire> {
      if (
        cached?.pages.length === pages.length &&
        cached.pages.every((page, index) => page === pages[index])
      ) return cached.flight

      let serialized: string
      try {
        serialized = serializeDashboardRetainedPages(pages)
      } catch (cause) {
        return Promise.reject(
          DashboardRetainedPagesWireError.make({ operation: 'encode', cause })
        )
      }
      if (cached?.serialized === serialized) {
        cached = { ...cached, pages: [...pages] }
        return cached.flight
      }

      const flight = encodeSerializedDashboardRetainedPages(serialized)
      cached = { pages: [...pages], serialized, flight }
      void flight.catch(() => {
        if (cached?.flight === flight) cached = null
      })
      return flight
    }
  }
}

export async function decodeDashboardRetainedPagesWire(
  value: unknown,
  now = Date.now()
): Promise<RetainedPageRecord[]> {
  try {
    const wire = parseWire(value)
    if (!wire) throw new Error('Invalid retained-page projection envelope')
    return validateDecodedPages(
      expandDashboardRetainedPagesPayload(
        await decodeGzipBase64Json(wire.data)
      ),
      now
    )
  } catch (cause) {
    throw DashboardRetainedPagesWireError.make({ operation: 'decode', cause })
  }
}
