/* ================================================================
   Suspension — everything Tab Out knows about third-party tab
   suspenders (The Marvellous Suspender, The Great Suspender, etc.),
   behind one seam:

   • unwrapSuspenderUrl / unwrapSuspenderTitle — suspenders rewrite a
     tab's URL to chrome-extension://<id>/suspended.html#...&uri=<real>
     with the real URL in the fragment's `uri=` param. Because the
     real URL can itself contain `&` and `#`, it is always the LAST
     param — so we split on the literal `&uri=` marker (or leading
     `uri=`) instead of URLSearchParams, which would truncate at the
     first inner `&`.

   • isSuspended — THE predicate for "this item is a suspended tab".
     A raw URL differs from its unwrapped effective URL only when a
     suspender rewrote it; callers that already carry both URLs pass
     the pair, everyone else lets the default unwrap derive it.

   • Suspend Target memory + buildSuspendUrl — remembers which
     suspender the user runs (extension id + an observed
     suspended.html URL used as a format template) and rebuilds
     suspend URLs for new tabs. buildSuspendUrl is the inverse of the
     unwrap helpers: it keeps the observed suspender's fragment shape,
     swaps the `ttl=` (URL-encoded title) and trailing `uri=` (raw
     real URL, always last) values, and zeroes any `pos=` scroll
     offset, so the result round-trips through unwrapSuspenderUrl /
     unwrapSuspenderTitle.
   ================================================================ */

import { Effect, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { runPromiseExclusiveEffect } from './promise-exclusive-effect.js'

export const SUSPEND_TARGET_STORAGE_KEY = 'tabOutSuspendTargetV1'
const SUSPEND_TARGET_STORAGE_WRITE_LOCK = 'tab-out:suspend-target-write'
const SUSPENDED_PATH_SUFFIX = '/suspended.html'

export function unwrapSuspenderUrl(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return url || ''
  const parsed = URL.parse(url)
  if (!parsed || !parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return url
  const frag = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : ''
  const marker = '&uri='
  let encoded
  const idx = frag.indexOf(marker)
  if (idx >= 0) encoded = frag.slice(idx + marker.length)
  else if (frag.startsWith('uri=')) encoded = frag.slice(4)
  else return url
  try {
    return decodeURIComponent(encoded) || url
  } catch {
    return url
  }
}

/**
 * unwrapSuspenderTitle(url) — pull the `ttl=` param out of a suspender
 * fragment. The Marvellous/Great Suspender store the original page
 * title there, which is what we want to render on the chip — Chrome's
 * own `tab.title` for a not-yet-rendered suspended tab is unreliable
 * (sometimes the full suspender URL, sometimes empty, sometimes a
 * stale cached value). Returns '' when the URL isn't a suspender URL
 * or when no `ttl=` fragment is present.
 *
 * Unlike `uri=` which is always the LAST fragment param (since the
 * real URL can itself contain `&`), `ttl=` values are URL-encoded so
 * any literal `&` in the title shows up as `%26` — safe to split at
 * the next raw `&`.
 */
export function unwrapSuspenderTitle(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return ''
  const parsed = URL.parse(url)
  if (!parsed || !parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return ''
  const frag = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : ''
  const match = frag.match(/(?:^|&)ttl=([^&]*)/)
  if (!match) return ''
  try {
    return decodeURIComponent(match[1] || '') || ''
  } catch {
    return ''
  }
}

/**
 * isSuspended(rawUrl, effectiveUrl) — true when a suspender rewrote
 * this item's URL. `rawUrl` is Chrome's actual tab URL; `effectiveUrl`
 * is the unwrapped real page URL and defaults to unwrapping rawUrl,
 * so callers that already carry both (normalized tabs, history
 * entries, chip envs) pass the pair and skip the re-unwrap.
 */
export function isSuspended(rawUrl: string | undefined, effectiveUrl = unwrapSuspenderUrl(rawUrl)): boolean {
  return !!rawUrl && rawUrl !== effectiveUrl
}

export interface SuspendTarget {
  id: string
  template: string
}

interface StoredSuspendTarget extends SuspendTarget {
  observedAt: number
}

const suspendTargetSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  template: Schema.NonEmptyString
}) satisfies Schema.Schema<SuspendTarget>

const storedSuspendTargetSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  template: Schema.NonEmptyString,
  observedAt: Schema.Finite
}) satisfies Schema.Schema<StoredSuspendTarget>

const isSuspendTarget = Schema.is(suspendTargetSchema)
const isStoredSuspendTarget = Schema.is(storedSuspendTargetSchema)

interface PendingSuspendTargetSave {
  target: SuspendTarget
  observedAt: number
}

export type SuspendTargetStoreAdapter = {
  now: () => number
  read: () => Promise<unknown>
  runExclusive: <Value>(task: () => Promise<Value>) => Promise<Value>
  write: (value: StoredSuspendTarget) => Promise<void>
}

export type SuspendTargetStore = {
  get: () => Promise<SuspendTarget | null>
  getEffect: () => Effect.Effect<SuspendTarget | null>
  rememberFromTabs: (tabs: readonly { suspended?: boolean; rawUrl?: string }[]) => void
  rememberFromTabsEffect: (
    tabs: readonly { suspended?: boolean; rawUrl?: string }[]
  ) => Effect.Effect<void>
}

class SuspendTargetStoreError extends Schema.TaggedErrorClass<SuspendTargetStoreError>()(
  'SuspendTargetStoreError',
  { cause: Schema.Defect() }
) {}

export function extractSuspenderId(rawUrl: string | undefined): string | null {
  if (!rawUrl || !rawUrl.startsWith('chrome-extension://')) return null
  const parsed = URL.parse(rawUrl)
  if (!parsed || !parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return null
  return parsed.hostname || null
}

export function buildSuspendUrl(target: SuspendTarget, opts: { url: string; title: string }): string {
  const { url, title } = opts
  const hashIndex = target.template.indexOf('#')
  const base = hashIndex >= 0 ? target.template.slice(0, hashIndex) : target.template
  const frag = hashIndex >= 0 ? target.template.slice(hashIndex + 1) : ''

  // Drop everything from the `uri=` marker onward (it is always last); we re-append it.
  const marker = '&uri='
  const markerIndex = frag.indexOf(marker)
  let head = frag
  if (markerIndex >= 0) head = frag.slice(0, markerIndex)
  else if (frag.startsWith('uri=')) head = ''

  // The template's pos= is the observed tab's own scroll offset (Great/
  // Marvellous Suspender convention) — zero it so a freshly suspended tab
  // restores at the top instead of at another page's position.
  head = head.replace(/(^|&)pos=[^&]*/, '$1pos=0')

  const encodedTitle = encodeURIComponent(title)
  let titledHead: string
  if (/(^|&)ttl=/.test(head)) {
    titledHead = head.replace(/(^|&)ttl=[^&]*/, (_match, prefix: string) => `${prefix}ttl=${encodedTitle}`)
  } else if (head) {
    titledHead = `${head}&ttl=${encodedTitle}`
  } else {
    titledHead = `ttl=${encodedTitle}`
  }

  return `${base}#${titledHead}&uri=${url}`
}

function storedSuspendTargetObservedAt(value: unknown): number | null {
  return isStoredSuspendTarget(value) ? value.observedAt : null
}

function nextSuspendTargetObservationAt(): number {
  return performance.timeOrigin + performance.now()
}

export function createSuspendTargetStore(adapter: SuspendTargetStoreAdapter): SuspendTargetStore {
  let cachedTarget: SuspendTarget | null = null
  let cachedTargetRevision = 0

  const saveEffect = Effect.fn('suspendTarget.save')(function*(
    saveRequest: PendingSuspendTargetSave
  ) {
    const storedTarget: StoredSuspendTarget = {
      ...saveRequest.target,
      observedAt: saveRequest.observedAt
    }

    const transaction = Effect.gen(function*() {
      const existingValue = yield* Effect.tryPromise({
        try: adapter.read,
        catch: (cause) => SuspendTargetStoreError.make({ cause })
      })
      const existingObservedAt = storedSuspendTargetObservedAt(existingValue)
      if (existingObservedAt !== null && existingObservedAt > saveRequest.observedAt) return
      yield* Effect.tryPromise({
        try: () => adapter.write(storedTarget),
        catch: (cause) => SuspendTargetStoreError.make({ cause })
      })
    })

    // Request the shared lock as soon as this Effect starts. There is no
    // module-local queue ahead of it, so equal-time observations from separate
    // extension contexts retain the browser lock manager's request order.
    yield* runPromiseExclusiveEffect(
      adapter.runExclusive,
      transaction,
      (cause) => SuspendTargetStoreError.make({ cause })
    ).pipe(
      // Target persistence is an advisory cache. A failed read must abort the
      // write, while any transport/lock failure leaves live-tab memory intact.
      Effect.catchTag('SuspendTargetStoreError', () => Effect.void)
    )
  })

  const getEffect = Effect.fn('suspendTarget.get')(function*() {
    if (cachedTarget) return cachedTarget
    const revisionBeforeLoad = cachedTargetRevision
    let storedTarget: SuspendTarget | null = null
    const value = yield* Effect.tryPromise({
      try: adapter.read,
      catch: (cause) => SuspendTargetStoreError.make({ cause })
    }).pipe(
      Effect.catchTag('SuspendTargetStoreError', () => Effect.succeed(undefined))
    )
    if (isSuspendTarget(value)) storedTarget = { id: value.id, template: value.template }
    // Live tab collection is synchronous and authoritative. Do not let a
    // storage read that started earlier replace a target learned while it waited.
    if (cachedTarget || cachedTargetRevision !== revisionBeforeLoad) return cachedTarget
    cachedTarget = storedTarget
    return cachedTarget
  })

  function get(): Promise<SuspendTarget | null> {
    return getAppRuntime().runPromise(getEffect())
  }

  function observeFromTabs(
    tabs: readonly { suspended?: boolean; rawUrl?: string }[]
  ): Effect.Effect<void> {
    for (const tab of tabs) {
      if (!tab.suspended || !tab.rawUrl) continue
      const id = extractSuspenderId(tab.rawUrl)
      if (!id) continue
      if (cachedTarget?.id === id && cachedTarget.template === tab.rawUrl) return Effect.void
      const idChanged = cachedTarget?.id !== id
      cachedTargetRevision += 1
      cachedTarget = { id, template: tab.rawUrl }
      return idChanged
        ? saveEffect({
          target: cachedTarget,
          observedAt: adapter.now()
        })
        : Effect.void
    }
    return Effect.void
  }

  function rememberFromTabsEffect(
    tabs: readonly { suspended?: boolean; rawUrl?: string }[]
  ): Effect.Effect<void> {
    return Effect.suspend(() => observeFromTabs(tabs))
  }

  function rememberFromTabs(
    tabs: readonly { suspended?: boolean; rawUrl?: string }[]
  ): void {
    // Preserve the original synchronous live-memory update for event callers;
    // only the advisory persistence continues in the shared page runtime.
    void getAppRuntime().runPromise(observeFromTabs(tabs))
  }

  return { get, getEffect, rememberFromTabs, rememberFromTabsEffect }
}

function suspendTargetStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Suspend target storage is unavailable')
  }
  return chrome.storage.local
}

async function readStoredSuspendTarget(): Promise<unknown> {
  const stored = await suspendTargetStorageArea().get(SUSPEND_TARGET_STORAGE_KEY)
  return stored[SUSPEND_TARGET_STORAGE_KEY]
}

async function writeStoredSuspendTarget(value: StoredSuspendTarget): Promise<void> {
  await suspendTargetStorageArea().set({ [SUSPEND_TARGET_STORAGE_KEY]: value })
}

const suspendTargetStore = createSuspendTargetStore({
  now: nextSuspendTargetObservationAt,
  read: readStoredSuspendTarget,
  runExclusive: <Value>(task: () => Promise<Value>) => (
    navigator.locks.request(SUSPEND_TARGET_STORAGE_WRITE_LOCK, task)
  ),
  write: writeStoredSuspendTarget
})

export function getSuspendTarget(): Promise<SuspendTarget | null> {
  return suspendTargetStore.get()
}

export const getSuspendTargetEffect = Effect.fn('suspension.getTarget')(function*() {
  return yield* suspendTargetStore.getEffect()
})

/**
 * Scan normalized open tabs for the first recognizable suspended page and cache
 * it as the target. Persist only when the suspender id changes; a same-id
 * template refresh updates memory without another storage write.
 */
export function rememberSuspendTargetFromTabs(
  tabs: readonly { suspended?: boolean; rawUrl?: string }[]
): void {
  suspendTargetStore.rememberFromTabs(tabs)
}

export const rememberSuspendTargetFromTabsEffect = Effect.fn('suspension.rememberTarget')(function*(
  tabs: readonly { suspended?: boolean; rawUrl?: string }[]
) {
  yield* suspendTargetStore.rememberFromTabsEffect(tabs)
})
