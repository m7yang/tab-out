import {
  createClosureToken,
  createRetainedPageIdentity,
  RETAINED_PAGE_IDENTITY_VERSION,
  type RetainedPageSurfaceKind
} from './retained-page-identity.js'

export const OPEN_SURFACE_INVENTORY_SCHEMA_VERSION = 2
export const OPEN_SURFACE_TITLE_MAX_CODE_POINTS = 512
export const OPEN_SURFACE_FAVICON_MAX_LENGTH = 2_048

export interface OpenSurfaceObservation {
  tabId: number
  surfaceKind: RetainedPageSurfaceKind
  url: string
  rawUrl?: string
  title?: string
  favIconUrl?: string
  incognito?: boolean
}

export interface OpenSurfaceInventoryEntry {
  tabId: number
  closureToken: string
  identityDigest: string
  surfaceKind: RetainedPageSurfaceKind
  canonicalKey: string
  /** Exact effective target; never truncated or replaced by the canonical key. */
  url: string
  title: string
  favIconUrl?: string
  /** Assigned once when this physical lifetime is first observed closing. */
  closedAt?: number
}

export interface OpenSurfaceInventory {
  /** Schema 1 is accepted only as a legacy, pre-owner-derived checkpoint. */
  schemaVersion: 1 | typeof OPEN_SURFACE_INVENTORY_SCHEMA_VERSION
  identityVersion: 1
  entries: Readonly<Record<string, OpenSurfaceInventoryEntry>>
}

export interface OpenSurfaceInventoryOptions {
  runtimeId?: string | null
  closureTokenFactory?: () => string
}

export interface ObserveOpenSurfaceResult {
  inventory: OpenSurfaceInventory
  entry: OpenSurfaceInventoryEntry | null
  changed: boolean
}

export type RemoveOpenSurfaceResult = ObserveOpenSurfaceResult

export type MarkOpenSurfaceClosureResult = ObserveOpenSurfaceResult

export interface OpenSurfaceClosureMark {
  tabId: number
  closedAt: number
  closureToken?: string
}

export interface MarkOpenSurfaceClosuresResult {
  inventory: OpenSurfaceInventory
  entries: readonly (OpenSurfaceInventoryEntry | null)[]
  changed: boolean
}

export interface OpenSurfaceLifetimeReference {
  tabId: number
  closureToken: string
}

export interface RemoveOpenSurfaceLifetimesResult {
  inventory: OpenSurfaceInventory
  entries: readonly (OpenSurfaceInventoryEntry | null)[]
  changed: boolean
}

export interface TransferOpenSurfaceLifetimeResult extends ObserveOpenSurfaceResult {
  transferred: boolean
}

export function emptyOpenSurfaceInventory(): OpenSurfaceInventory {
  return {
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
    identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
    entries: {}
  }
}

function entryKey(tabId: number): string {
  return String(tabId)
}

function isValidTabId(tabId: number): boolean {
  return Number.isInteger(tabId) && tabId >= 0
}

function boundedTitle(title: string | undefined): string {
  return Array.from(title || '').slice(0, OPEN_SURFACE_TITLE_MAX_CODE_POINTS).join('')
}

function reusableFaviconUrl(favIconUrl: string | undefined): string | undefined {
  if (!favIconUrl || favIconUrl.length > OPEN_SURFACE_FAVICON_MAX_LENGTH) return undefined
  const parsed = URL.parse(favIconUrl)
  if (parsed?.protocol === 'blob:') return undefined
  return favIconUrl
}

function identityOptions(
  options: OpenSurfaceInventoryOptions
): { runtimeId?: string | null } {
  return options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }
}

async function entryFromObservation(
  observation: OpenSurfaceObservation,
  previous: OpenSurfaceInventoryEntry | undefined,
  existingClosureToken: string | undefined,
  existingClosedAt: number | undefined,
  options: OpenSurfaceInventoryOptions
): Promise<OpenSurfaceInventoryEntry | null> {
  // Incognito is rejected before URL normalization, hashing, or metadata work.
  if (observation.incognito || !isValidTabId(observation.tabId)) return null

  const identity = await createRetainedPageIdentity({
    surfaceKind: observation.surfaceKind,
    url: observation.url,
    ...(observation.rawUrl === undefined ? {} : { rawUrl: observation.rawUrl })
  }, identityOptions(options))
  if (!identity) return null
  const closureToken = existingClosureToken || (options.closureTokenFactory || createClosureToken)()

  const sameIdentity = previous?.identityDigest === identity.identityDigest
  const observedTitle = boundedTitle(observation.title)
  const observedFaviconUrl = reusableFaviconUrl(observation.favIconUrl)
  const title = observedTitle || (sameIdentity ? previous.title : '')
  const favIconUrl = observedFaviconUrl || (sameIdentity ? previous.favIconUrl : undefined)

  return {
    tabId: observation.tabId,
    closureToken,
    identityDigest: identity.identityDigest,
    surfaceKind: identity.surfaceKind,
    canonicalKey: identity.canonicalKey,
    url: identity.url,
    title,
    ...(favIconUrl ? { favIconUrl } : {}),
    ...(existingClosedAt === undefined ? {} : { closedAt: existingClosedAt })
  }
}

function entriesEqual(
  left: OpenSurfaceInventoryEntry,
  right: OpenSurfaceInventoryEntry
): boolean {
  return (
    left.tabId === right.tabId &&
    left.closureToken === right.closureToken &&
    left.identityDigest === right.identityDigest &&
    left.surfaceKind === right.surfaceKind &&
    left.canonicalKey === right.canonicalKey &&
    left.url === right.url &&
    left.title === right.title &&
    left.favIconUrl === right.favIconUrl &&
    left.closedAt === right.closedAt
  )
}

export function openSurfaceInventoriesEqual(
  left: OpenSurfaceInventory,
  right: OpenSurfaceInventory
): boolean {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.identityVersion !== right.identityVersion
  ) return false
  const leftKeys = Object.keys(left.entries)
  const rightKeys = Object.keys(right.entries)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => {
    const leftEntry = left.entries[key]
    const rightEntry = right.entries[key]
    return !!leftEntry && !!rightEntry && entriesEqual(leftEntry, rightEntry)
  })
}

function withoutEntry(
  entries: Readonly<Record<string, OpenSurfaceInventoryEntry>>,
  tabId: number
): Readonly<Record<string, OpenSurfaceInventoryEntry>> {
  const key = entryKey(tabId)
  if (!entries[key]) return entries
  const next: Record<string, OpenSurfaceInventoryEntry> = {}
  for (const [candidateKey, entry] of Object.entries(entries)) {
    if (candidateKey !== key) next[candidateKey] = entry
  }
  return next
}

export async function observeOpenSurface(
  inventory: OpenSurfaceInventory,
  observation: OpenSurfaceObservation,
  options: OpenSurfaceInventoryOptions = {}
): Promise<ObserveOpenSurfaceResult> {
  const key = entryKey(observation.tabId)
  const previous = inventory.entries[key]
  const entry = await entryFromObservation(
    observation,
    previous,
    previous?.closureToken,
    previous?.closedAt,
    options
  )

  if (!entry) {
    if (!previous) return { inventory, entry: null, changed: false }
    return {
      inventory: { ...inventory, entries: withoutEntry(inventory.entries, observation.tabId) },
      entry: null,
      changed: true
    }
  }
  if (previous && entriesEqual(previous, entry)) {
    return { inventory, entry: previous, changed: false }
  }

  return {
    inventory: {
      ...inventory,
      entries: { ...inventory.entries, [key]: entry }
    },
    entry,
    changed: true
  }
}

export async function seedOpenSurfaceInventory(
  observations: readonly OpenSurfaceObservation[],
  options: OpenSurfaceInventoryOptions = {}
): Promise<OpenSurfaceInventory> {
  let inventory = emptyOpenSurfaceInventory()
  for (const observation of observations) {
    inventory = (await observeOpenSurface(inventory, observation, options)).inventory
  }
  return inventory
}

export function removeOpenSurface(
  inventory: OpenSurfaceInventory,
  tabId: number
): RemoveOpenSurfaceResult {
  const entry = inventory.entries[entryKey(tabId)]
  if (!entry) return { inventory, entry: null, changed: false }
  return {
    inventory: { ...inventory, entries: withoutEntry(inventory.entries, tabId) },
    entry,
    changed: true
  }
}

export function markOpenSurfaceClosure(
  inventory: OpenSurfaceInventory,
  tabId: number,
  closedAt: number,
  closureToken?: string
): MarkOpenSurfaceClosureResult {
  const result = markOpenSurfaceClosures(inventory, [{
    tabId,
    closedAt,
    ...(closureToken === undefined ? {} : { closureToken })
  }])
  return {
    inventory: result.inventory,
    entry: result.entries[0] ?? null,
    changed: result.changed
  }
}

/** Mark a close batch while cloning the inventory entries at most once. */
export function markOpenSurfaceClosures(
  inventory: OpenSurfaceInventory,
  marks: readonly OpenSurfaceClosureMark[]
): MarkOpenSurfaceClosuresResult {
  let nextEntries: Record<string, OpenSurfaceInventoryEntry> | null = null
  const entries: Array<OpenSurfaceInventoryEntry | null> = []

  for (const mark of marks) {
    const key = entryKey(mark.tabId)
    const entry = (nextEntries ?? inventory.entries)[key]
    if (
      !entry ||
      (mark.closureToken !== undefined && entry.closureToken !== mark.closureToken) ||
      entry.closedAt !== undefined
    ) {
      entries.push(entry || null)
      continue
    }
    const marked = { ...entry, closedAt: mark.closedAt }
    nextEntries ??= { ...inventory.entries }
    nextEntries[key] = marked
    entries.push(marked)
  }

  if (!nextEntries) return { inventory, entries, changed: false }
  return {
    inventory: { ...inventory, entries: nextEntries },
    entries,
    changed: true
  }
}

/** Remove only the exact captured lifetimes while cloning entries at most once. */
export function removeOpenSurfaceLifetimes(
  inventory: OpenSurfaceInventory,
  lifetimes: readonly OpenSurfaceLifetimeReference[]
): RemoveOpenSurfaceLifetimesResult {
  let nextEntries: Record<string, OpenSurfaceInventoryEntry> | null = null
  const entries: Array<OpenSurfaceInventoryEntry | null> = []

  for (const lifetime of lifetimes) {
    const key = entryKey(lifetime.tabId)
    const entry = (nextEntries ?? inventory.entries)[key]
    if (!entry || entry.closureToken !== lifetime.closureToken) {
      entries.push(null)
      continue
    }
    nextEntries ??= { ...inventory.entries }
    delete nextEntries[key]
    entries.push(entry)
  }

  if (!nextEntries) return { inventory, entries, changed: false }
  return {
    inventory: { ...inventory, entries: nextEntries },
    entries,
    changed: true
  }
}

export async function transferOpenSurfaceLifetime(
  inventory: OpenSurfaceInventory,
  removedTabId: number,
  replacement: OpenSurfaceObservation,
  options: OpenSurfaceInventoryOptions = {}
): Promise<TransferOpenSurfaceLifetimeResult> {
  const removedEntry = inventory.entries[entryKey(removedTabId)]
  if (!removedEntry) {
    const observed = await observeOpenSurface(inventory, replacement, options)
    return { ...observed, transferred: false }
  }

  const withoutRemoved = withoutEntry(inventory.entries, removedTabId)
  const withoutReplacement = withoutEntry(withoutRemoved, replacement.tabId)
  const previousReplacement = inventory.entries[entryKey(replacement.tabId)]
  const entry = await entryFromObservation(
    replacement,
    previousReplacement || removedEntry,
    removedEntry.closureToken,
    removedEntry.closedAt,
    options
  )

  if (!entry) {
    return {
      inventory: { ...inventory, entries: withoutReplacement },
      entry: null,
      changed: true,
      transferred: true
    }
  }

  return {
    inventory: {
      ...inventory,
      entries: { ...withoutReplacement, [entryKey(replacement.tabId)]: entry }
    },
    entry,
    changed: true,
    transferred: true
  }
}
