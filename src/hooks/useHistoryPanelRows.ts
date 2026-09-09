import { useMemo } from 'react'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import { isClosedGhostDismissed, type ClosedGhostDismissals } from '../extension/closed-ghost-dismissals.js'
import { tabMatchesFilter } from '../extension/filter-match.js'
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
  allowDuplicate?: boolean
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

  // Collect each stack entry with its cursor distance and a "base" timestamp:
  // the real activity-log value when present, else a synthesized fallback
  // derived from cursor distance.
  const rawStackCandidates = stackEntries
    .filter((entry) => !filterActive || tabMatchesFilter({ title: entry.title, url: entry.url, isTabOut: false }, filter))
    .map((entry) => {
      const cursorDistance = Math.abs(entry.index - stackCursorIndex)
      const synthesizedTouchedAt = stackBaseTimestamp > 0
        ? stackBaseTimestamp - cursorDistance
        : -cursorDistance
      return {
        entry,
        cursorDistance,
        base: entry.lastActivatedAt ?? entry.createdAt ?? synthesizedTouchedAt,
      }
    })
    .toSorted((a, b) => a.cursorDistance - b.cursorDistance)

  // These indexed entries form the current tab's linear navigation chain:
  // activated back/forward history first, followed by pending background tabs.
  // A back entry whose URL was recently touched in ANOTHER tab carries a fresh
  // activity-log timestamp that would otherwise float it above closer entries
  // (the Image 11 bug). Walking outward from the cursor and clamping each
  // effective timestamp strictly below the previous one pins the indexed rows
  // into navigation order, while leaving gaps where ghost rows still interleave
  // by their own real timestamps. Each clamp depends on the previous one, so
  // this stays a sequential walk.
  const stackCandidates: HistoryPanelRowCandidate[] = []
  let previousStackEffective = Number.POSITIVE_INFINITY
  for (const { entry, base } of rawStackCandidates) {
    const lastTouchedAt = Math.min(base, previousStackEffective - 1)
    previousStackEffective = lastTouchedAt
    stackCandidates.push({
      row: { kind: 'stack', entry, lastTouchedAt },
      identity: pageIdentityForWorkingSet(entry.url) || entry.url,
      allowDuplicate: !!entry.pending,
    })
  }

  const openGhostCandidates: HistoryPanelRowCandidate[] = (workingSet?.items ?? [])
    .filter((item) => !filterActive || tabMatchesFilter({ title: item.title, url: item.tabUrl, isTabOut: false }, filter))
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
        .filter((closed) => !filterActive || tabMatchesFilter({ title: closed.title, url: closed.url, isTabOut: false }, filter))
        .filter((closed) => !isClosedGhostDismissed(dismissedClosedGhosts, closed))
        .map((closed) => ({
          row: { kind: 'closed-ghost', closed, lastTouchedAt: closed.lastClosedAt },
          identity: pageIdentityForWorkingSet(closed.url) || closed.url,
        }))

  // The row budget is shared in priority order — navigation chain first, then
  // Working Set ghosts, then recently-closed ghosts — while display order
  // comes from the timestamp sort afterwards.
  const seen = new Set<string>()
  const rows: HistoryPanelRow[] = []
  for (const { row, identity, allowDuplicate } of [...stackCandidates, ...openGhostCandidates, ...closedGhostCandidates]) {
    if (rows.length >= rowLimit) break
    if (!allowDuplicate && identity && seen.has(identity)) continue
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
