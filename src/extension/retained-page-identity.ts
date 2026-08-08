import { unwrapSuspenderUrl } from './suspension.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import { canonicalDedupeKey } from './url-canonical.js'

export const RETAINED_PAGE_IDENTITY_VERSION = 1

export type RetainedPageSurfaceKind = 'normal-tab' | 'app'

export interface RetainedPageIdentityCandidate {
  surfaceKind: RetainedPageSurfaceKind
  url: string
  rawUrl?: string
}

export interface RetainedPageIdentity {
  identityVersion: 1
  identityDigest: string
  surfaceKind: RetainedPageSurfaceKind
  canonicalKey: string
  /** Exact effective URL retained as the activation target. */
  url: string
}

type Sha256Digest = (input: BufferSource) => Promise<ArrayBuffer>

export interface RetainedPageIdentityOptions {
  runtimeId?: string | null
  sha256?: Sha256Digest
}

export type ResolveRetainedPageIdentities = (
  candidates: readonly RetainedPageIdentityCandidate[]
) => Promise<readonly (RetainedPageIdentity | null)[]>

export type RandomByteFiller = (bytes: Uint8Array<ArrayBuffer>) => void

const EPHEMERAL_NON_PAGE_PROTOCOLS = new Set([
  'blob:',
  'data:',
  'javascript:'
])

/**
 * Resolve the exact page behind a possible suspender wrapper. This value is
 * stored unchanged for activation; canonicalization is identity-only.
 */
export function retainedPageEffectiveUrl(
  candidate: Pick<RetainedPageIdentityCandidate, 'url' | 'rawUrl'>
): string {
  const rawUrl = candidate.rawUrl || ''
  const rawEffectiveUrl = unwrapSuspenderUrl(rawUrl)
  if (rawUrl && rawEffectiveUrl !== rawUrl) return rawEffectiveUrl
  return unwrapSuspenderUrl(candidate.url || '')
}

function runtimeIdFrom(options: RetainedPageIdentityOptions): string | null | undefined {
  return options.runtimeId === undefined
    ? globalThis.chrome?.runtime?.id
    : options.runtimeId
}

function isBlankOrNewTabUrl(parsed: URL): boolean {
  if (parsed.protocol === 'about:') {
    return parsed.pathname === 'blank' || parsed.pathname === 'srcdoc'
  }
  if (parsed.protocol === 'chrome:') {
    return parsed.hostname === 'newtab' || parsed.hostname === 'new-tab-page'
  }
  if (parsed.protocol === 'chrome-search:') {
    return parsed.hostname === 'local-ntp' || parsed.hostname === 'new-tab-page'
  }
  return parsed.protocol === 'chrome-untrusted:' && parsed.hostname === 'new-tab-page'
}

function isOwnExtensionUrl(parsed: URL, runtimeId: string | null | undefined): boolean {
  return !!runtimeId && parsed.protocol === 'chrome-extension:' && parsed.hostname === runtimeId
}

/**
 * Capture eligibility is deliberately broader than activation eligibility.
 * Privileged Chrome pages, other extensions, files, and app surfaces remain
 * retainable metadata even when Chrome may later reject a fresh navigation.
 */
export function isRetainedPageCaptureEligible(
  candidate: RetainedPageIdentityCandidate,
  options: RetainedPageIdentityOptions = {}
): boolean {
  const exactEffectiveUrl = retainedPageEffectiveUrl(candidate)
  if (!exactEffectiveUrl) return false

  const parsed = URL.parse(exactEffectiveUrl)
  if (!parsed) return false

  const runtimeId = runtimeIdFrom(options)
  if (
    EPHEMERAL_NON_PAGE_PROTOCOLS.has(parsed.protocol) ||
    isBlankOrNewTabUrl(parsed) ||
    isOwnExtensionUrl(parsed, runtimeId) ||
    isTabOutPageUrl(exactEffectiveUrl, runtimeId)
  ) {
    return false
  }

  return true
}

function identityMaterial(surfaceKind: RetainedPageSurfaceKind, canonicalKey: string): string {
  return JSON.stringify([
    RETAINED_PAGE_IDENTITY_VERSION,
    surfaceKind,
    canonicalKey
  ])
}

function webCryptoSha256(input: BufferSource): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest('SHA-256', input)
}

export async function createRetainedPageIdentity(
  candidate: RetainedPageIdentityCandidate,
  options: RetainedPageIdentityOptions = {}
): Promise<RetainedPageIdentity | null> {
  if (!isRetainedPageCaptureEligible(candidate, options)) return null

  const url = retainedPageEffectiveUrl(candidate)
  const canonicalKey = canonicalDedupeKey(url)
  const encodedIdentity = new TextEncoder().encode(identityMaterial(candidate.surfaceKind, canonicalKey))
  const digest = await (options.sha256 || webCryptoSha256)(encodedIdentity)

  return {
    identityVersion: RETAINED_PAGE_IDENTITY_VERSION,
    identityDigest: new Uint8Array(digest).toHex(),
    surfaceKind: candidate.surfaceKind,
    canonicalKey,
    url
  }
}

export function createCachedRetainedPageIdentityResolver(
  options: RetainedPageIdentityOptions
): ResolveRetainedPageIdentities {
  // Keep the current and previous batches so concurrent storage reads share
  // in-flight hashes without turning this short-lived migration cache global.
  let previous = new Map<string, Promise<RetainedPageIdentity | null>>()
  let current = new Map<string, Promise<RetainedPageIdentity | null>>()
  return (candidates) => {
    const priorCurrent = current
    const next = new Map<string, Promise<RetainedPageIdentity | null>>()
    const identities = candidates.map((candidate) => {
      const cacheKey = JSON.stringify([candidate.surfaceKind, candidate.url])
      const identity = next.get(cacheKey) ?? priorCurrent.get(cacheKey) ??
        previous.get(cacheKey) ?? createRetainedPageIdentity(candidate, options)
      next.set(cacheKey, identity)
      void identity.catch(() => {
        if (current.get(cacheKey) === identity) current.delete(cacheKey)
        if (previous.get(cacheKey) === identity) previous.delete(cacheKey)
      })
      return identity
    })
    previous = priorCurrent
    current = next
    return Promise.all(identities)
  }
}

function fillWithWebCrypto(bytes: Uint8Array<ArrayBuffer>): void {
  globalThis.crypto.getRandomValues(bytes)
}

/** Create the stable 128-random-bit token for one physical open lifetime. */
export function createClosureToken(fillRandomBytes: RandomByteFiller = fillWithWebCrypto): string {
  const bytes = new Uint8Array(16)
  fillRandomBytes(bytes)
  return bytes.toHex()
}
