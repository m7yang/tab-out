import { Effect, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'

import {
  emptySavedPagesStore,
  SAVED_PAGES_STORAGE_KEY,
  savedPageKeyForUrl,
  type SavedPageRecord,
  type SavedPageSurfaceKind,
  type SavedPagesStore,
  type SavedPagesStoreLoadResult
} from './saved-pages.js'

const savedPagesStoreEnvelopeV1Schema = Schema.Struct({
  version: Schema.Literals([1]),
  pages: Schema.Record(Schema.String, Schema.Unknown)
})

const savedPagesStoreEnvelopeV2Schema = Schema.Struct({
  version: Schema.Literals([2]),
  pages: Schema.Record(Schema.String, Schema.Unknown)
})

const savedPageRecordV1CandidateSchema = Schema.Struct({
  key: Schema.String,
  url: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.Unknown),
  favIconUrl: Schema.optionalKey(Schema.Unknown),
  savedAt: Schema.optionalKey(Schema.Unknown),
  updatedAt: Schema.optionalKey(Schema.Unknown),
  lastSeenOpenAt: Schema.optionalKey(Schema.Unknown)
})

const savedPageRecordV2CandidateSchema = Schema.Struct({
  key: Schema.String,
  surfaceKind: Schema.Literals(['normal-tab', 'app']),
  url: Schema.String,
  title: Schema.optionalKey(Schema.Unknown),
  favIconUrl: Schema.optionalKey(Schema.Unknown),
  savedAt: Schema.optionalKey(Schema.Unknown),
  updatedAt: Schema.optionalKey(Schema.Unknown),
  lastSeenOpenAt: Schema.optionalKey(Schema.Unknown)
})

type SavedPagesStoreEnvelopeV1 = typeof savedPagesStoreEnvelopeV1Schema.Type
type SavedPagesStoreEnvelopeV2 = typeof savedPagesStoreEnvelopeV2Schema.Type

const isSavedPagesStoreEnvelopeV1 = Schema.is(savedPagesStoreEnvelopeV1Schema)
const isSavedPagesStoreEnvelopeV2 = Schema.is(savedPagesStoreEnvelopeV2Schema)
const isSavedPageRecordV1Candidate = Schema.is(savedPageRecordV1CandidateSchema)
const isSavedPageRecordV2Candidate = Schema.is(savedPageRecordV2CandidateSchema)

class SavedPagesStoreReadError extends Schema.TaggedErrorClass<SavedPagesStoreReadError>()(
  'SavedPagesStoreReadError',
  { cause: Schema.Defect() }
) {}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

type SavedPageRecordFields = {
  readonly key: string
  readonly url?: string
  readonly title?: unknown
  readonly favIconUrl?: unknown
  readonly savedAt?: unknown
  readonly updatedAt?: unknown
  readonly lastSeenOpenAt?: unknown
}

function normalizeSavedPageRecord(
  record: SavedPageRecordFields,
  surfaceKind: SavedPageSurfaceKind
): SavedPageRecord | null {
  const recordUrl = record.url || ''
  const key = savedPageKeyForUrl(recordUrl || record.key, surfaceKind)
  if (!key || key !== record.key) return null
  const savedAt = finiteNumberOr(record.savedAt, 0)
  const updatedAt = finiteNumberOr(record.updatedAt, savedAt)
  return {
    key,
    surfaceKind,
    url: recordUrl || (surfaceKind === 'normal-tab' ? key : ''),
    title: String(record.title || ''),
    ...(record.favIconUrl ? { favIconUrl: String(record.favIconUrl) } : {}),
    savedAt,
    updatedAt,
    ...(typeof record.lastSeenOpenAt === 'number' && Number.isFinite(record.lastSeenOpenAt)
      ? { lastSeenOpenAt: record.lastSeenOpenAt }
      : {})
  }
}

function normalizeSavedPagesStoreEnvelopeV1(store: SavedPagesStoreEnvelopeV1): SavedPagesStore {
  const pages: Record<string, SavedPageRecord> = {}
  for (const record of Object.values(store.pages)) {
    if (!isSavedPageRecordV1Candidate(record)) continue
    const normalized = normalizeSavedPageRecord(record, 'normal-tab')
    if (normalized) pages[normalized.key] = normalized
  }
  return { version: 2, pages }
}

function normalizeSavedPagesStoreEnvelopeV2(store: SavedPagesStoreEnvelopeV2): SavedPagesStore {
  const pages: Record<string, SavedPageRecord> = {}
  for (const record of Object.values(store.pages)) {
    if (!isSavedPageRecordV2Candidate(record)) continue
    const normalized = normalizeSavedPageRecord(record, record.surfaceKind)
    if (normalized) pages[normalized.key] = normalized
  }
  return { version: 2, pages }
}

export function parseSavedPagesStoreValue(stored: unknown): SavedPagesStoreLoadResult {
  if (stored === undefined) return { ok: true, value: emptySavedPagesStore() }
  if (isSavedPagesStoreEnvelopeV2(stored)) {
    return { ok: true, value: normalizeSavedPagesStoreEnvelopeV2(stored) }
  }
  if (isSavedPagesStoreEnvelopeV1(stored)) {
    return { ok: true, value: normalizeSavedPagesStoreEnvelopeV1(stored) }
  }
  return { ok: false, value: emptySavedPagesStore() }
}

function savedPagesStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Saved Pages storage is unavailable')
  }
  return chrome.storage.local
}

export const loadSavedPagesStoreResultEffect = Effect.fn(
  'savedPages.loadStore'
)(function*() {
  const stored = yield* Effect.result(Effect.tryPromise({
    try: () => savedPagesStorageArea().get(SAVED_PAGES_STORAGE_KEY),
    catch: (cause) => SavedPagesStoreReadError.make({ cause })
  }))
  if (Result.isFailure(stored)) {
    return { ok: false, value: emptySavedPagesStore() }
  }
  return parseSavedPagesStoreValue(stored.success[SAVED_PAGES_STORAGE_KEY])
})

export function loadSavedPagesStoreResult(): Promise<SavedPagesStoreLoadResult> {
  return getAppRuntime().runPromise(loadSavedPagesStoreResultEffect())
}

/** Compatibility loader for optional consumers that intentionally accept empty fallback state. */
export const loadSavedPagesStoreEffect = Effect.fn(
  'savedPages.loadStoreValue'
)(function*() {
  return (yield* loadSavedPagesStoreResultEffect()).value
})

export function loadSavedPagesStore(): Promise<SavedPagesStore> {
  return getAppRuntime().runPromise(loadSavedPagesStoreEffect())
}
