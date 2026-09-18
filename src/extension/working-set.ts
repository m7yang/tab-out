import { Schema } from 'effect'

import { omitUndefined } from '../lib/omit-undefined.js'
import type {
  DashboardTab,
  WorkingSetActivityEvent,
  WorkingSetActivityKind,
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
  WorkingSetItem,
  WorkingSetSnapshot,
} from './types'
import { compareNumericText } from './numeric-sort.js'
import { unwrapSuspenderUrl } from './suspension.js'
import { pickTabFavicon } from './favicons.js'
import { isBrowserInternalUrl } from './browser-url-policy.js'

const WORKING_SET_DEFAULT_LIMIT = 8
const WORKING_SET_EXPANDED_LIMIT = 16
const WORKING_SET_MIN_ITEMS = 3

export const WORKING_SET_ACTIVITY_VERSION = 1
const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SAME_DAY_MS = 24 * 60 * 60 * 1000
const CURRENT_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EVENTS_PER_RECORD = 80
const WORKING_SET_PAGE_IDENTITY_CACHE_LIMIT = 1024
const workingSetPageIdentityCache = new Map<string, string>()

const workingSetActivityEnvelopeSchema = Schema.Struct({
  version: Schema.Literals([WORKING_SET_ACTIVITY_VERSION]),
  records: Schema.Record(Schema.String, Schema.Unknown),
})

const workingSetActivityVersionedValueSchema = Schema.Struct({
  version: Schema.Finite,
})

const workingSetActivityRecordCandidateSchema = Schema.Struct({
  url: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
  domain: Schema.optionalKey(Schema.Unknown),
  dismissedAt: Schema.optionalKey(Schema.Unknown),
  dismissedUntil: Schema.optionalKey(Schema.Unknown),
  events: Schema.optionalKey(Schema.Unknown),
})

const workingSetActivityEventSchema = Schema.Struct({
  kind: Schema.Literals(['activation', 'navigation']),
  at: Schema.Finite,
}) satisfies Schema.Schema<WorkingSetActivityEvent>

const isWorkingSetActivityEnvelope = Schema.is(workingSetActivityEnvelopeSchema)
const isWorkingSetActivityVersionedValue = Schema.is(workingSetActivityVersionedValueSchema)
const isWorkingSetActivityRecordCandidate = Schema.is(workingSetActivityRecordCandidateSchema)
const isWorkingSetActivityEvent = Schema.is(workingSetActivityEventSchema)
const isUnknownArray = Schema.is(Schema.Array(Schema.Unknown))

const NOISY_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
])
type WorkingSetActivityInput = {
  kind: WorkingSetActivityKind
  at: number
  tab: Pick<DashboardTab, 'url' | 'rawUrl' | 'title'>
}

export type WorkingSetActivityStorageParseResult =
  | { readonly status: 'missing', readonly activity: WorkingSetActivityStore }
  | { readonly status: 'valid', readonly activity: WorkingSetActivityStore }
  | { readonly status: 'malformed' }
  | { readonly status: 'unsupported-version', readonly version: number }

export type WorkingSetActivityRecordMutation = {
  readonly activity: WorkingSetActivityStore
  readonly upsert: WorkingSetActivityRecord | null
  readonly deleteKeys: readonly string[]
}

type WorkingSetSnapshotOptions = {
  tabs: DashboardTab[]
  activity: WorkingSetActivityStore | null | undefined
  now?: number
  defaultLimit?: number
  expandedLimit?: number
  minItems?: number
  currentWindowId?: number | null
}

export function emptyWorkingSetActivity(): WorkingSetActivityStore {
  return { version: WORKING_SET_ACTIVITY_VERSION, records: {} }
}

function normalizeWorkingSetActivityEnvelope(
  value: typeof workingSetActivityEnvelopeSchema.Type,
  now: number,
): WorkingSetActivityStore {
  const minAt = now - ACTIVITY_RETENTION_MS
  const records: Record<string, WorkingSetActivityRecord> = {}
  for (const [key, record] of Object.entries(value.records)) {
    if (!isWorkingSetActivityRecordCandidate(record)) continue
    const normalizedKey = pageIdentityForWorkingSet(
      typeof record.url === 'string' ? record.url : key,
    )
    if (!normalizedKey || normalizedKey !== key) continue
    const events = isUnknownArray(record.events)
      ? record.events
          .filter(isWorkingSetActivityEvent)
          .filter((event) => event.at >= minAt)
          .slice(-MAX_EVENTS_PER_RECORD)
      : []
    if (events.length === 0) continue
    const latestEvent = Math.max(...events.map((event) => event.at))
    const dismissedAt = typeof record.dismissedAt === 'number' && Number.isFinite(record.dismissedAt) ? record.dismissedAt : undefined
    const dismissedUntil = typeof record.dismissedUntil === 'number' && Number.isFinite(record.dismissedUntil) ? record.dismissedUntil : undefined
    const dismissalIsActive = (
      dismissedAt !== undefined &&
      dismissedUntil !== undefined &&
      dismissedUntil > now &&
      latestEvent <= dismissedAt
    )
    const lastActivatedAt = latestEventAt(events, 'activation')
    const lastNavigatedAt = latestEventAt(events, 'navigation')
    records[key] = omitUndefined({
      key,
      url: normalizedKey,
      title: String(record.title || ''),
      domain: typeof record.domain === 'string' && record.domain
        ? record.domain
        : domainForPageIdentity(normalizedKey),
      lastSeenAt: latestEvent,
      lastActivatedAt,
      lastNavigatedAt,
      dismissedAt: dismissalIsActive ? dismissedAt : undefined,
      dismissedUntil: dismissalIsActive ? dismissedUntil : undefined,
      events,
    })
  }
  return { version: WORKING_SET_ACTIVITY_VERSION, records }
}

export function parseWorkingSetActivityStorageValue(
  value: unknown,
  now = Date.now(),
): WorkingSetActivityStorageParseResult {
  if (value === undefined) {
    return { status: 'missing', activity: emptyWorkingSetActivity() }
  }
  if (isWorkingSetActivityEnvelope(value)) {
    return {
      status: 'valid',
      activity: normalizeWorkingSetActivityEnvelope(value, now),
    }
  }
  if (
    isWorkingSetActivityVersionedValue(value) &&
    value.version !== WORKING_SET_ACTIVITY_VERSION
  ) {
    return { status: 'unsupported-version', version: value.version }
  }
  return { status: 'malformed' }
}

export function normalizeWorkingSetActivity(value: unknown, now = Date.now()): WorkingSetActivityStore {
  const parsed = parseWorkingSetActivityStorageValue(value, now)
  return parsed.status === 'missing' || parsed.status === 'valid'
    ? parsed.activity
    : emptyWorkingSetActivity()
}

function computePageIdentityForWorkingSet(url: string): string {
  const effectiveUrl = unwrapSuspenderUrl(url || '')
  if (!effectiveUrl) return ''

  const parsed = URL.parse(effectiveUrl)
  if (!parsed || isBrowserInternalUrl(parsed.href)) return ''
  if (isGoogleSearchResultPage(parsed)) return ''

  if (parsed.search) {
    const paramEntries: [string, string][] = []
    for (const [name, value] of parsed.searchParams) {
      const normalizedName = name.toLowerCase()
      if (normalizedName.startsWith('utm_') || NOISY_QUERY_PARAMS.has(normalizedName)) continue
      paramEntries.push([name, value])
    }
    if (paramEntries.length > 1) {
      paramEntries.sort(([left], [right]) => left.localeCompare(right))
    }
    parsed.search = new URLSearchParams(paramEntries).toString()
  }

  if (parsed.protocol === 'file:') {
    parsed.hash = ''
    return parsed.href
  }

  const pathname = parsed.pathname || '/'
  const path = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const query = parsed.search ? parsed.search : ''
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query}`
}

export function pageIdentityForWorkingSet(url = ''): string {
  const cached = workingSetPageIdentityCache.get(url)
  if (cached !== undefined) return cached

  const identity = computePageIdentityForWorkingSet(url)
  if (workingSetPageIdentityCache.size >= WORKING_SET_PAGE_IDENTITY_CACHE_LIMIT) {
    const oldestUrl = workingSetPageIdentityCache.keys().next().value
    if (oldestUrl !== undefined) workingSetPageIdentityCache.delete(oldestUrl)
  }
  workingSetPageIdentityCache.set(url, identity)
  return identity
}

function isGoogleSearchResultPage(parsed: URL): boolean {
  return (
    (parsed.hostname === 'www.google.com' || parsed.hostname === 'google.com') &&
    parsed.pathname === '/search'
  )
}

export function recordWorkingSetActivity(
  store: Partial<WorkingSetActivityStore> | null | undefined,
  { kind, at, tab }: WorkingSetActivityInput,
): WorkingSetActivityStore {
  return recordWorkingSetActivityMutation(store, { kind, at, tab }).activity
}

export function recordWorkingSetActivityMutation(
  store: Partial<WorkingSetActivityStore> | null | undefined,
  { kind, at, tab }: WorkingSetActivityInput,
): WorkingSetActivityRecordMutation {
  const before = normalizeWorkingSetActivity(store, Number.isFinite(at) ? at : Date.now())
  const key = pageIdentityForWorkingSet(tab.url || tab.rawUrl || '')
  const deleteKeys = Object.keys(store?.records ?? {}).filter(
    (recordKey) => before.records[recordKey] === undefined,
  )
  if (!key || !Number.isFinite(at)) {
    return { activity: before, upsert: null, deleteKeys }
  }

  const existing = before.records[key]
  const events = [...(existing?.events || []), { kind, at }]
    .filter((event) => event.at >= at - ACTIVITY_RETENTION_MS)
    .slice(-MAX_EVENTS_PER_RECORD)
  const upsert: WorkingSetActivityRecord = omitUndefined({
    key,
    url: key,
    title: tab.title || existing?.title || displayUrlForPageIdentity(key),
    domain: domainForPageIdentity(key),
    lastSeenAt: at,
    lastActivatedAt: kind === 'activation' ? at : existing?.lastActivatedAt,
    lastNavigatedAt: kind === 'navigation' ? at : existing?.lastNavigatedAt,
    events,
  })
  return {
    activity: {
      version: WORKING_SET_ACTIVITY_VERSION,
      records: { ...before.records, [key]: upsert },
    },
    upsert,
    deleteKeys: deleteKeys.filter((recordKey) => recordKey !== key),
  }
}

export function buildWorkingSetSnapshot({
  tabs,
  activity,
  now = Date.now(),
  defaultLimit = WORKING_SET_DEFAULT_LIMIT,
  expandedLimit = WORKING_SET_EXPANDED_LIMIT,
  minItems = WORKING_SET_MIN_ITEMS,
  currentWindowId = null,
}: WorkingSetSnapshotOptions): WorkingSetSnapshot {
  const normalizedActivity = normalizeWorkingSetActivity(activity, now)
  const openByKey = new Map<string, DashboardTab[]>()

  for (const tab of tabs) {
    if (tab.isTabOut || tab.isApp || typeof tab.id !== 'number') continue
    const key = pageIdentityForWorkingSet(tab.url || tab.rawUrl || '')
    if (!key) continue
    openByKey.getOrInsertComputed(key, () => []).push(tab)
  }

  const domainActivity = new Map<string, number>()
  for (const record of Object.values(normalizedActivity.records)) {
    domainActivity.set(record.domain, (domainActivity.get(record.domain) || 0) + recentEventCount(record.events, now, CURRENT_WEEK_MS))
  }

  const items: WorkingSetItem[] = []
  for (const [key, groupedTabs] of openByKey) {
    const record = normalizedActivity.records[key]
    if (!record) continue
    if (isWorkingSetRecordDismissed(record, now)) continue
    const score = scoreWorkingSetRecord(record, now, domainActivity.get(record.domain) || 0)
    if (score <= 0) continue

    const representative = pickRepresentativeTab(groupedTabs, currentWindowId)
    if (!representative || typeof representative.id !== 'number') continue
    const url = representative.url || representative.rawUrl || record.url
    items.push({
      key,
      tabId: representative.id,
      windowId: representative.windowId,
      tabUrl: url,
      rawUrl: representative.rawUrl || url,
      title: representative.title || record.title || displayUrlForPageIdentity(key),
      displayUrl: displayUrlForPageIdentity(key),
      faviconUrl: pickTabFavicon({ favIconUrl: representative.favIconUrl, url, suspended: representative.suspended }),
      dupeCount: groupedTabs.length,
      active: !!representative.active,
      activeInOtherWindow: !!(representative.active && currentWindowId != null && representative.windowId !== currentWindowId),
      loading: groupedTabs.some((tab) => !tab.suspended && tab.status === 'loading'),
      audible: !!representative.audible,
      muted: !!representative.muted,
      score,
      lastActivatedAt: Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0),
    })
  }

  const rankedItems = items
    .sort((a, b) => b.score - a.score || compareNumericText(a.displayUrl, b.displayUrl))
    .slice(0, expandedLimit)

  return {
    defaultLimit,
    expandedLimit,
    items: rankedItems.length >= minItems ? rankedItems : [],
  }
}

function isWorkingSetRecordDismissed(record: WorkingSetActivityRecord, now: number): boolean {
  if (
    typeof record.dismissedAt !== 'number' ||
    typeof record.dismissedUntil !== 'number' ||
    !Number.isFinite(record.dismissedAt) ||
    !Number.isFinite(record.dismissedUntil) ||
    record.dismissedUntil <= now
  ) {
    return false
  }

  const latestStrongAt = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
  return latestStrongAt <= record.dismissedAt
}

function pickRepresentativeTab(tabs: DashboardTab[], currentWindowId: number | null): DashboardTab | null {
  return tabs.toSorted((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    const aCurrentWindow = currentWindowId != null && a.windowId === currentWindowId
    const bCurrentWindow = currentWindowId != null && b.windowId === currentWindowId
    if (aCurrentWindow !== bCurrentWindow) return aCurrentWindow ? -1 : 1
    return Number(a.id || 0) - Number(b.id || 0)
  })[0] || null
}

function scoreWorkingSetRecord(record: WorkingSetActivityRecord, now: number, domainEvents: number): number {
  const lastStrongAt = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
  if (!lastStrongAt) return 0

  const recency = 10_000 * Math.exp(-Math.max(0, now - lastStrongAt) / (4 * 60 * 60 * 1000))
  const today = weightedEventCount(record.events, now, SAME_DAY_MS, 50, 60)
  const week = weightedEventCount(record.events, now, CURRENT_WEEK_MS, 8, 10)
  const domainHabit = Math.min(domainEvents, 20) * 2
  return recency + today + week + domainHabit
}

function weightedEventCount(events: WorkingSetActivityEvent[], now: number, windowMs: number, activationWeight: number, navigationWeight: number): number {
  return events
    .filter((event) => now - event.at <= windowMs)
    .reduce((score, event) => score + (event.kind === 'activation' ? activationWeight : navigationWeight), 0)
}

function recentEventCount(events: WorkingSetActivityEvent[], now: number, windowMs: number): number {
  return events.filter((event) => now - event.at <= windowMs).length
}

function latestEventAt(events: WorkingSetActivityEvent[], kind: WorkingSetActivityKind): number | undefined {
  const latest = events.filter((event) => event.kind === kind).reduce((max, event) => Math.max(max, event.at), 0)
  return latest || undefined
}

function domainForPageIdentity(key: string): string {
  return URL.parse(key)?.hostname || ''
}

function displayUrlForPageIdentity(key: string): string {
  const parsed = URL.parse(key)
  if (!parsed) return key
  if (parsed.protocol === 'file:') return parsed.pathname
  return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
}
