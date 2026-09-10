import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { historyEntryFromClosedTab, historyEntryFromWorkingSetItem } from '../extension/tab-history.js'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import { closedGhostDismissalKey, dismissClosedGhost, restoreClosedGhost, subscribeClosedGhostDismissals, type ClosedGhostDismissals } from '../extension/closed-ghost-dismissals.js'
import { showToast } from '../extension/toast.js'
import { useDocumentEvent } from '../hooks/useGlobalEvent'
import { highlightTermsForFilter } from './filter-highlight-text'
import { cn } from '@/lib/utils'
import type { CSSVariableProperties } from '@/lib/css-properties'
import type { HoverUrlChangeHandler, SnapshotChangeHandler, TabHistorySnapshot, TabsChangeHandler } from './types'
import type { RetainedPageSurfaceMatch, WorkingSetSnapshot } from '../extension/types'
import { useHistoryPanelRows, type HistoryPanelRow } from '../hooks/useHistoryPanelRows.js'
import { useHistoryScrollbar, type HistoryScrollbar } from '../hooks/useHistoryScrollbar.js'
import { useDashboardActions } from './DashboardInteractionContext'
import { animateHistoryEntryMoves, snapshotHistoryEntryPositions } from '../extension/history-entry-move-animation.js'
import { HistoryEntry, flushHistoryTitleMeasurementJobs, historyEntryIndexLabel } from './history-entry'

const EMPTY_CLOSED_TABS: readonly ClosedTabEntry[] = []
const EMPTY_RETAINED_PAGE_SURFACE_MATCHES: readonly RetainedPageSurfaceMatch[] = []

type VisibleHistoryLayoutSnapshot = {
  filter: string
  positions: ReturnType<typeof snapshotHistoryEntryPositions>
  root: HTMLElement
  width: number
}

interface TabHistoryPanelProps {
  snapshot: TabHistorySnapshot | null
  workingSet?: WorkingSetSnapshot | null | undefined
  closedTabs?: readonly ClosedTabEntry[] | undefined
  dismissedClosedGhosts?: ClosedGhostDismissals | null | undefined
  filter?: string | undefined
  savedKeys?: readonly string[] | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  onSnapshotChange?: SnapshotChangeHandler | undefined
  onTabsChange?: TabsChangeHandler | undefined
}

function syncVisibleHistoryLayout(
  root: HTMLElement | null,
  previous: VisibleHistoryLayoutSnapshot | null,
  filter: string,
  animate: boolean,
): VisibleHistoryLayoutSnapshot | null {
  if (!root || document.visibilityState !== 'visible') return previous

  const width = Math.round(root.getBoundingClientRect().width * 100) / 100
  const moveInProgress = root.querySelector('.history-entry-layout-moving') !== null
  // The first snapshot preserves the current transformed rectangles and cancels
  // stale ownership; a second read records the settled DOM as the next baseline.
  const visualPositions = snapshotHistoryEntryPositions(root)
  const positions = moveInProgress
    ? snapshotHistoryEntryPositions(root)
    : visualPositions
  const current = { filter, positions, root, width }

  if (
    animate &&
    previous &&
    previous.root === root &&
    previous.filter === filter &&
    Math.abs(previous.width - width) < 1
  ) {
    animateHistoryEntryMoves(root, moveInProgress ? visualPositions : previous.positions)
  }

  return current
}

function HistoryEntryScrollbar({ scrollbar }: { scrollbar: HistoryScrollbar }) {
  const { metrics, active, dragging, trackRef, onThumbPointerDown, onTrackPointerDown, onPointerEnter, onPointerLeave } = scrollbar
  if (!metrics.visible) return null

  const scrollbarStyle: CSSVariableProperties = {
    '--history-entry-scrollbar-thumb-height': `${metrics.thumbHeight}px`,
    '--history-entry-scrollbar-thumb-top': `${metrics.thumbTop}px`,
  }

  return (
    <div
      data-tabout-part="history-scrollbar"
      className="history-entry-scrollbar pointer-events-none absolute top-0 right-0 bottom-0 z-20 w-(--dashboard-scrollbar-size) select-none max-[980px]:right-[calc(0px-var(--dashboard-scrollbar-inset))]"
      style={scrollbarStyle}
      aria-hidden="true"
    >
      <div
        ref={trackRef}
        className="history-entry-scrollbar-track pointer-events-auto absolute top-(--dashboard-scrollbar-padding) right-0 bottom-(--dashboard-scrollbar-padding) w-(--dashboard-scrollbar-size)"
        onPointerDown={onTrackPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <div
          data-dragging={dragging || undefined}
          className={cn(
            'history-entry-scrollbar-thumb absolute top-0 right-0 w-(--dashboard-scrollbar-size) rounded-(--dashboard-scrollbar-radius) border-(length:--dashboard-scrollbar-padding) border-transparent bg-(--dashboard-scrollbar-thumb-bg) bg-clip-content [transition:opacity_300ms_ease-out,border-width_var(--dashboard-scrollbar-grow-duration)_ease-out] h-(--history-entry-scrollbar-thumb-height) transform-[translateY(var(--history-entry-scrollbar-thumb-top))] hover:border-(length:--dashboard-scrollbar-padding-hover)',
            active ? 'opacity-100' : 'opacity-0',
            dragging && 'border-(length:--dashboard-scrollbar-padding-hover)',
          )}
          onPointerDown={onThumbPointerDown}
        />
      </div>
    </div>
  )
}

export function TabHistoryPanel({
  snapshot,
  workingSet = null,
  closedTabs = EMPTY_CLOSED_TABS,
  dismissedClosedGhosts: admittedClosedGhostDismissals = null,
  filter = '',
  savedKeys,
  retainedPageSurfaceMatches = EMPTY_RETAINED_PAGE_SURFACE_MATCHES,
  onSnapshotChange,
  onTabsChange,
}: TabHistoryPanelProps) {
  const { onHoverUrlChange } = useDashboardActions()
  const [observedClosedGhostDismissals, setObservedClosedGhostDismissals] = useState<ClosedGhostDismissals | null>(null)
  const dismissedClosedGhosts = observedClosedGhostDismissals ?? admittedClosedGhostDismissals
  const closedGhostMutationRevisionRef = useRef(0)
  useEffect(() => {
    return subscribeClosedGhostDismissals((dismissals) => {
      closedGhostMutationRevisionRef.current += 1
      setObservedClosedGhostDismissals(dismissals)
    })
  }, [])

  async function handleForgetClosedGhost(closed: ClosedTabEntry) {
    const mutationRevision = closedGhostMutationRevisionRef.current
    let dismissals: Map<string, number>
    try {
      dismissals = await dismissClosedGhost(closed)
    } catch {
      showToast('Could not remove from recently closed')
      return
    }

    const expectedDismissedAt = dismissals.get(closedGhostDismissalKey(closed))
    if (typeof expectedDismissedAt !== 'number') {
      showToast('Could not remove from recently closed')
      return
    }

    if (closedGhostMutationRevisionRef.current === mutationRevision) {
      closedGhostMutationRevisionRef.current += 1
      setObservedClosedGhostDismissals(dismissals)
    }
    showToast('Removed from recently closed', {
      label: 'Undo',
      description: 'You can undo this action.',
      onClick: async () => {
        const undoRevision = closedGhostMutationRevisionRef.current
        try {
          const restoredDismissals = await restoreClosedGhost(closed, expectedDismissedAt)
          if (closedGhostMutationRevisionRef.current === undoRevision) {
            closedGhostMutationRevisionRef.current += 1
            setObservedClosedGhostDismissals(restoredDismissals)
          }
        } catch {
          showToast('Could not restore recently closed page')
        }
      },
    })
  }

  const rows = useHistoryPanelRows({ snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts })
  const savedKeySet = useMemo(() => new Set(savedKeys ?? []), [savedKeys])
  const highlightTerms = useMemo(() => highlightTermsForFilter(filter), [filter])
  const historyListRef = useRef<HTMLDivElement | null>(null)
  const historyContentRef = useRef<HTMLDivElement | null>(null)
  const lastVisibleHistoryLayoutRef = useRef<VisibleHistoryLayoutSnapshot | null>(null)
  const currentHistoryFilterRef = useRef(filter)
  const scrollbar = useHistoryScrollbar(historyListRef)

  function settleVisibleHistoryLayout() {
    lastVisibleHistoryLayoutRef.current = syncVisibleHistoryLayout(
      historyContentRef.current,
      lastVisibleHistoryLayoutRef.current,
      currentHistoryFilterRef.current,
      false,
    )
  }

  // Row layout effects queue natural title reads. As their parent, this layout
  // effect runs after every row has queued but before ancestor masonry effects,
  // keeping the read phase together and the resulting clamp writes pre-paint.
  useLayoutEffect(() => {
    flushHistoryTitleMeasurementJobs()
  })

  useLayoutEffect(() => {
    currentHistoryFilterRef.current = filter
    lastVisibleHistoryLayoutRef.current = syncVisibleHistoryLayout(
      historyContentRef.current,
      lastVisibleHistoryLayoutRef.current,
      filter,
      true,
    )
  }, [filter, rows])

  useDocumentEvent('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    lastVisibleHistoryLayoutRef.current = syncVisibleHistoryLayout(
      historyContentRef.current,
      lastVisibleHistoryLayoutRef.current,
      filter,
      true,
    )
  })

  return (
    <section
      data-tabout="activation-history"
      className="tab-history-panel sticky top-0 z-30 col-start-1 flex h-screen max-h-screen min-w-0 flex-col overflow-visible pl-(--dashboard-history-edge-gutter) max-[980px]:relative max-[980px]:ml-0 max-[980px]:mr-(--dashboard-scrollbar-inset) max-[980px]:h-auto max-[980px]:max-h-65 max-[980px]:border-b max-[980px]:border-(--warm-gray) max-[980px]:pr-0 max-[980px]:pb-0 max-[980px]:[.dashboard-shell.has-history_&]:col-1"
      aria-label="Activation history"
    >
      <div
        ref={historyListRef}
        className="history-entry-list pointer-events-none relative flex min-h-0 w-[calc(100vw-var(--dashboard-history-edge-gutter))] min-w-0 flex-auto overflow-x-hidden overflow-y-auto scrollbar-gutter-stable scrollbar-none min-[981px]:ml-[calc(var(--dashboard-page-gutter)-var(--dashboard-edge-bleed)-var(--dashboard-history-edge-gutter))] min-[981px]:pl-[calc(var(--dashboard-edge-bleed)-var(--dashboard-page-gutter)+var(--dashboard-history-edge-gutter))] max-[980px]:w-auto max-[980px]:mr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))]"
      >
        <div className="history-entry-scroll-hit-area-frame pointer-events-none sticky top-0 z-0 ml-[calc(var(--dashboard-page-gutter)-var(--dashboard-edge-bleed)-var(--dashboard-history-edge-gutter))] h-0 w-[calc(var(--dashboard-edge-bleed)-var(--dashboard-page-gutter)+var(--dashboard-history-edge-gutter))] flex-none max-[980px]:hidden" aria-hidden="true">
          <div
            data-tabout-part="history-scroll-hit-area"
            className="history-entry-scroll-hit-area h-screen w-full pointer-events-auto"
          />
        </div>
        <div ref={historyContentRef} className="history-entry-list-content pointer-events-auto flex self-start w-65 min-w-0 flex-col gap-[2.5px] pt-3 pr-3.5 pb-10 max-[980px]:w-full max-[980px]:pr-0 max-[980px]:pb-3">
          {rows.map((row) => {
            const layoutKey = historyPanelRowLayoutKey(row)
            return (
              <HistoryPanelRow
                key={historyPanelRowRenderKey(row)}
                row={row}
                layoutKey={layoutKey}
                snapshot={snapshot}
                savedKeys={savedKeySet}
                retainedPageSurfaceMatches={retainedPageSurfaceMatches}
                highlightTerms={highlightTerms}
                onSnapshotChange={onSnapshotChange}
                onHistoryLayoutSettled={settleVisibleHistoryLayout}
                onHoverUrlChange={onHoverUrlChange}
                onTabsChange={onTabsChange}
                onForgetClosedGhost={handleForgetClosedGhost}
              />
            )
          })}
        </div>
      </div>
      <HistoryEntryScrollbar scrollbar={scrollbar} />
    </section>
  )
}

function historyPanelRowRenderKey(row: HistoryPanelRow): string {
  if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}:${row.entry.index}`
  if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
  return `closed-ghost:${row.closed.sessionId}`
}

function historyPanelRowLayoutKey(row: HistoryPanelRow): string {
  if (row.kind === 'stack') return `stack:${row.entry.windowId}:${row.entry.tabId}`
  if (row.kind === 'open-ghost') return `open-ghost:${row.item.key}`
  return `closed-ghost:${row.closed.sessionId}`
}

function HistoryPanelRow({
  row,
  layoutKey,
  snapshot,
  savedKeys,
  retainedPageSurfaceMatches,
  highlightTerms,
  onSnapshotChange,
  onHistoryLayoutSettled,
  onHoverUrlChange,
  onTabsChange,
  onForgetClosedGhost,
}: {
  row: HistoryPanelRow
  layoutKey: string
  snapshot: TabHistorySnapshot | null
  savedKeys: ReadonlySet<string>
  retainedPageSurfaceMatches: readonly RetainedPageSurfaceMatch[]
  highlightTerms: readonly string[]
  onSnapshotChange?: SnapshotChangeHandler | undefined
  onHistoryLayoutSettled?: (() => void) | undefined
  onHoverUrlChange?: HoverUrlChangeHandler | undefined
  onTabsChange?: TabsChangeHandler | undefined
  onForgetClosedGhost?: ((closed: ClosedTabEntry) => void) | undefined
}): ReactNode {
  if (row.kind === 'stack') {
    return (
      <HistoryEntry
        entry={row.entry}
        layoutKey={layoutKey}
        indexLabel={historyEntryIndexLabel(row.entry, snapshot, row.entry.index + 1)}
        kind="stack"
        savedKeys={savedKeys}
        retainedPageSurfaceMatches={retainedPageSurfaceMatches}
        highlightTerms={highlightTerms}
        onSnapshotChange={onSnapshotChange}
        onHistoryLayoutSettled={onHistoryLayoutSettled}
        onHoverUrlChange={onHoverUrlChange}
        onTabsChange={onTabsChange}
      />
    )
  }
  if (row.kind === 'open-ghost') {
    return (
      <HistoryEntry
        entry={historyEntryFromWorkingSetItem(row.item)}
        layoutKey={layoutKey}
        indexLabel={null}
        kind="open-ghost"
        workingSetItem={row.item}
        savedKeys={savedKeys}
        retainedPageSurfaceMatches={retainedPageSurfaceMatches}
        highlightTerms={highlightTerms}
        onSnapshotChange={onSnapshotChange}
        onHistoryLayoutSettled={onHistoryLayoutSettled}
        onHoverUrlChange={onHoverUrlChange}
        onTabsChange={onTabsChange}
      />
    )
  }
  return (
    <HistoryEntry
      entry={historyEntryFromClosedTab(row.closed)}
      layoutKey={layoutKey}
      indexLabel={null}
      kind="closed-ghost"
      closedTab={row.closed}
      savedKeys={savedKeys}
      retainedPageSurfaceMatches={retainedPageSurfaceMatches}
      highlightTerms={highlightTerms}
      onSnapshotChange={onSnapshotChange}
      onHistoryLayoutSettled={onHistoryLayoutSettled}
      onHoverUrlChange={onHoverUrlChange}
      onTabsChange={onTabsChange}
      onForgetClosedGhost={onForgetClosedGhost}
    />
  )
}
