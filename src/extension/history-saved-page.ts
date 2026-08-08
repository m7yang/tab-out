import {
  isSavedPageEligible,
  savedPageKeyForUrl,
  savedPageSurfaceKindForCandidate,
  type SavedPageSurfaceKind,
  type SavedPageCandidate
} from './saved-pages.js'
import { retainedPageEffectiveUrl } from './retained-page-identity.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import type { RetainedPageSurfaceMatch, TabHistoryEntry } from './types'
import { canonicalDedupeKey } from './url-canonical.js'

export type HistorySavePageTarget = SavedPageCandidate

function historyEntrySaveSurfaceKind(
  entry: TabHistoryEntry,
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[]
): SavedPageSurfaceKind {
  const canonicalKey = canonicalDedupeKey(retainedPageEffectiveUrl(entry))
  if (!canonicalKey) return 'normal-tab'

  let matchedSurface: SavedPageSurfaceKind | null = null
  for (const page of retainedPageSurfaceMatches) {
    if (page.canonicalKey !== canonicalKey) continue
    if (matchedSurface && matchedSurface !== page.surfaceKind) return 'normal-tab'
    matchedSurface = page.surfaceKind
  }

  return matchedSurface === 'app' ? 'app' : 'normal-tab'
}

export function historyEntrySaveTarget(
  entry: TabHistoryEntry,
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[] = []
): HistorySavePageTarget {
  return {
    url: entry.url,
    rawUrl: entry.rawUrl,
    title: entry.title,
    favIconUrl: entry.favIconUrl,
    isTabOut: isTabOutPageUrl(entry.url),
    // History rows cannot reliably preserve the surface after a tab closes.
    // Select app only when the retained ledger resolves that canonical page
    // to app state without a competing normal-tab identity.
    isApp: historyEntrySaveSurfaceKind(entry, retainedPageSurfaceMatches) === 'app'
  }
}

export function isHistoryEntrySaveEligible(
  entry: TabHistoryEntry,
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[] = []
): boolean {
  return isSavedPageEligible(historyEntrySaveTarget(entry, retainedPageSurfaceMatches))
}

export function historyEntrySavedPageKey(
  entry: TabHistoryEntry,
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[] = []
): string {
  return savedPageKeyForUrl(
    entry.url,
    savedPageSurfaceKindForCandidate(historyEntrySaveTarget(entry, retainedPageSurfaceMatches))
  )
}

export function historyEntrySaved(
  entry: TabHistoryEntry,
  savedKeys: ReadonlySet<string> | null | undefined,
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[] = []
): boolean {
  const key = historyEntrySavedPageKey(entry, retainedPageSurfaceMatches)
  return key !== '' && !!savedKeys?.has(key)
}
