import { useMemo } from 'react'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import { isClosedGhostDismissed, type ClosedGhostDismissals } from '../extension/closed-ghost-dismissals.js'
import { tabMatchesFilter } from '../extension/filter-match.js'
import { isTabOutPageUrl } from '../extension/tab-out-url.js'
import { pageIdentityForWorkingSet } from '../extension/working-set.js'

export type HistoryPanelRow =
  | { kind: 'stack', entry: TabHistoryEntry, lastTouchedAt: number }
  | { kind: 'open-ghost', item: WorkingSetItem, lastTouchedAt: number }
  | { kind: 'closed-ghost', closed: ClosedTabEntry, lastTouchedAt: number }

export interface UseHistoryPanelRowsArgs {
  snapshot: TabHistorySnapshot | null
  workingSet: WorkingSetSnapshot | null
  closedTabs: readonly ClosedTabEntry[]
  filter: string
  dismissedClosedGhosts?: ClosedGhostDismissals | null
}

type HistoryPanelRowCandidate = {
  row: HistoryPanelRow
  /** Falsy identities skip dedupe but still consume a row slot. */
  identity: string
}

const DEFAULT_HISTORY_PANEL_ROW_LIMIT = 48

function historyPanelRowLimit(snapshot: TabHistorySnapshot | null): number {
  const maxSize = snapshot?.maxSize
  return typeof maxSize === 'number' && Number.isInteger(maxSize) && maxSize > 0 ? maxSize : DEFAULT_HISTORY_PANEL_ROW_LIMIT
}

export function buildHistoryPanelRows({ snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts }: UseHistoryPanelRowsArgs): HistoryPanelRow[] {
  const filterActive = filter.trim() !== ''
  const rowLimit = historyPanelRowLimit(snapshot)

  const stackEntries = snapshot?.entries ?? []
  const stackBaseTimestamp = stackEntries.reduce(
    (max, entry) => Math.max(max, entry.lastActivatedAt ?? entry.createdAt ?? 0),
    0,
  )
  const stackCursorIndex = snapshot?.currentIndex ?? stackEntries.length - 1

  // Descending indexes also give descending signed offsets from the cursor.
  // Real timestamps (or a cursor-distance fallback) place supplemental rows.
  const rawStackCandidates = stackEntries
    .filter((entry) => !filterActive || tabMatchesFilter({ title: entry.title, url: entry.url, isTabOut: isTabOutPageUrl(entry.url) }, filter))
    .map((entry) => {
      const cursorDistance = Math.abs(entry.index - stackCursorIndex)
      const synthesizedTouchedAt = stackBaseTimestamp > 0
        ? stackBaseTimestamp - cursorDistance
        : -cursorDistance
      return {
        entry,
        base: entry.lastActivatedAt ?? entry.createdAt ?? synthesizedTouchedAt,
      }
    })
    .toSorted((a, b) => b.entry.index - a.entry.index)

  // Cross-tab activity timestamps must not reorder indexed navigation targets.
  // Clamp in display order so the final timestamp sort preserves signed order
  // while supplemental rows can still interleave by their own timestamps.
  const activatedCandidates: HistoryPanelRowCandidate[] = []
  const pendingCandidates: HistoryPanelRowCandidate[] = []
  let previousStackEffective = Number.POSITIVE_INFINITY
  for (const { entry, base } of rawStackCandidates) {
    const lastTouchedAt = Math.min(base, previousStackEffective - 1)
    previousStackEffective = lastTouchedAt
    const candidates = entry.pending ? pendingCandidates : activatedCandidates
    candidates.push({
      row: { kind: 'stack', entry, lastTouchedAt },
      identity: pageIdentityForWorkingSet(entry.url) || entry.url,
    })
  }

  const openGhostCandidates: HistoryPanelRowCandidate[] = (workingSet?.items ?? [])
    .filter((item) => !filterActive || tabMatchesFilter({ title: item.title, url: item.tabUrl, isTabOut: isTabOutPageUrl(item.tabUrl) }, filter))
    .map((item) => ({
      row: { kind: 'open-ghost', item, lastTouchedAt: item.lastActivatedAt },
      identity: item.key || item.tabUrl,
    }))

  // `null` is an explicit unknown state used by the mounted panel while its
  // durable dismissal read is unresolved or failed. Showing Chrome's
  // recently-closed rows then could briefly revive pages the user forgot.
  // An omitted value remains the pure builder's backwards-compatible
  // "no dismissal filtering requested" behavior.
  const closedGhostCandidates: HistoryPanelRowCandidate[] = dismissedClosedGhosts === null
    ? []
    : closedTabs
        .filter((closed) => !filterActive || tabMatchesFilter({ title: closed.title, url: closed.url, isTabOut: isTabOutPageUrl(closed.url) }, filter))
        .filter((closed) => !isClosedGhostDismissed(dismissedClosedGhosts, closed))
        .map((closed) => ({
          row: { kind: 'closed-ghost', closed, lastTouchedAt: closed.lastClosedAt },
          identity: pageIdentityForWorkingSet(closed.url) || closed.url,
        }))

  // Every indexed physical tab keeps its own row, including duplicate URLs.
  // Reserve capacity for activated history, then pending tabs in FIFO order.
  // Both kinds suppress supplemental duplicates; admission does not determine
  // the final display order.
  const seen = new Set<string>()
  const rows: HistoryPanelRow[] = []
  for (const { row, identity } of [...activatedCandidates, ...pendingCandidates.toReversed(), ...openGhostCandidates, ...closedGhostCandidates]) {
    if (rows.length >= rowLimit) break
    if (row.kind !== 'stack' && identity && seen.has(identity)) continue
    if (identity) seen.add(identity)
    rows.push(row)
  }

  return rows.toSorted((a, b) => b.lastTouchedAt - a.lastTouchedAt)
}

export function useHistoryPanelRows({ snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts }: UseHistoryPanelRowsArgs): HistoryPanelRow[] {
  return useMemo(
    () => buildHistoryPanelRows({
      snapshot,
      workingSet,
      closedTabs,
      filter,
      ...(dismissedClosedGhosts === undefined ? {} : { dismissedClosedGhosts }),
    }),
    [snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts],
  )
}
