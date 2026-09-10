import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { notifyAppStartupMaterialChange, readAppStartup, readBuildTimeAppStartup, setAppStartupFilterIntent, subscribeAppStartup, type AppStartupState } from '../app-startup.js'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import type { ClosedGhostDismissals } from '../extension/closed-ghost-dismissals.js'
import { useMissionsMasonry } from '../extension/layout.js'
import { showToast } from '../extension/toast.js'
import { HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled } from '../extension/history-range.js'
import { saveHistoryRangePreference } from '../extension/history-range-storage.js'
import { animateDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import { animateQueuedPageChipRefreshMoves } from '../extension/intra-card-move-animation.js'
import { createDashboardMoveChoreography, type DashboardMoveChoreography } from '../extension/card-move-choreography.js'
import { closeFilteredTabs, dedupeTabs } from '../extension/tab-actions'
import { buildFilterResultCandidates, type FilterResultCandidate } from '../extension/filter-result-navigation.js'
import { dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { appDashboardStore, settleDashboardRefresh, type MissionOrderMap } from '../extension/dashboard-intake.js'
import { useDashboardIntakeSnapshot } from '../hooks/useDashboardIntakeSnapshot'
import { useDashboardRefresh } from '../hooks/useDashboardRefresh'
import { useDashboardLocalState } from '../hooks/useDashboardLocalState'
import { useDashboardViewModels, useMissionOrderMemory, type DashboardChipOrderMemoryMap } from '../hooks/useDashboardViewModels'
import { useDashboardViewRouting } from '../hooks/useDashboardViewRouting'
import { FILTER_SEARCH_UPDATE_DELAY_MS, useFilterRouting } from '../hooks/useFilterRouting'
import { useHoverMatch } from '../hooks/useHoverMatch'
import type { UrlPreviewStore } from '../hooks/useUrlPreview'
import { HeaderBar } from './HeaderBar'
import { HistorySearchStatus } from './HistorySearchStatus'
import { MissionBlock } from './MissionBlock'
import { validatePageChipTextLayoutsAfterMasonry } from './page-chip-text-layout'
import { TabHistoryPanel } from './TabHistoryPanel'
import { TooltipProvider } from './ui/tooltip'
import { UrlPreview } from './UrlPreview'
import { AppErrorBoundary } from './AppErrorBoundary'
import { DesktopWindowMergeHost } from './DesktopWindowMergeHost'
import { DashboardActionsProvider, HoverStateProvider } from './DashboardInteractionContext'
import { useStartupOrderDebug } from './use-startup-order-debug'
import { cn } from '@/lib/utils'
import type {
  DashboardCardEntry,
  DashboardSource,
  DashboardStats,
  TabHistorySnapshot,
} from './types'
import { dashboardSourceForView, dashboardViewOptionId, type DashboardView } from '../extension/dashboard-view.js'
import type { HistorySearchSummary, RetainedPageSurfaceMatch, WorkingSetSnapshot } from '../extension/types'
import type { MissionContainer } from '../extension/card-move-animation'

type MissionContainerRef = {
  current: HTMLDivElement | null
}

const EMPTY_CLOSED_TABS: readonly ClosedTabEntry[] = []
const FILTER_QUERY_INPUT_SELECTOR = '[data-tabout="filter-query"] [data-tabout-part="input"]'

// Module-stable dispatch: every Dashboard arrival applies through the intake
// store, and the alias stays non-reactive for hook dependency purposes.
const dispatchAppDashboard = appDashboardStore.dispatch

type HistoryRangeSelectModule = typeof import('./HistoryRangeSelect')

let historyRangeSelectImport: Promise<HistoryRangeSelectModule> | null = null

function loadHistoryRangeSelect(): Promise<HistoryRangeSelectModule> {
  return historyRangeSelectImport ??= import('./HistoryRangeSelect')
}

const HistoryRangeSelect = lazy(() => loadHistoryRangeSelect().then((module) => ({ default: module.HistoryRangeSelect })))

type DashboardMissionSection = {
  cards: DashboardCardEntry[]
  emptyStateHint?: string | undefined
  emptyStateLabel?: string | undefined
  filter?: string
  gridEmpty?: boolean
  gridId: string
  gridRef?: Ref<HTMLDivElement>
  historySearchSummary?: HistorySearchSummary | null
  label?: string
  sectionClassName?: string
  sectionId?: string
  showEmptyState: boolean
  source: DashboardSource
}
type DashboardMissionSectionsOptions = {
  bookmarkMatchedCards: DashboardCardEntry[]
  bookmarkMatchesFlush: boolean
  bookmarkMissionsRef: Ref<HTMLDivElement>
  filter: string
  historyMatchedCards: DashboardCardEntry[]
  historyMatchesFlush: boolean
  historyMissionsRef: Ref<HTMLDivElement>
  historyResultsFilter: string
  historySearchSummary: HistorySearchSummary | null
  isReady: boolean
  matchedCards: DashboardCardEntry[]
  primaryEmptyStateHint?: string | undefined
  primaryEmptyStateLabel?: string | undefined
  primaryMissionsEmpty: boolean
  primaryMissionsRef: Ref<HTMLDivElement>
  showBookmarkMatches: boolean
  showHistoryMatches: boolean
  showHistoryRange: boolean
  showPrimaryEmptyState: boolean
  source: DashboardSource
}
type DashboardMissionsListProps = {
  filter: string
  historyRangeAction?: ReactNode
  onRetryHistorySearch: () => void
  sections: DashboardMissionSection[]
}
function readMissionContainers(...refs: MissionContainerRef[]): MissionContainer[] {
  return refs.map((ref) => ref.current)
}

function MissionsDivider({ action, label, status }: { action?: ReactNode, label: string, status?: ReactNode }) {
  return (
    <div className={cn('missions-divider mb-4 flex items-center gap-3 text-xs font-medium tracking-[0.6px] text-muted-foreground uppercase', (action || status) && 'min-h-(--header-control-height)')}>
      <span className="missions-divider-label pointer-events-none shrink-0 whitespace-nowrap">{label}</span>
      {action && <div className="missions-divider-action shrink-0 text-foreground normal-case tracking-normal font-normal">{action}</div>}
      <div className={cn('missions-divider-rail relative min-w-0 flex-1', status ? 'h-9.5' : 'h-px')}>
        <hr className="missions-divider-rule absolute inset-x-0 top-1/2 h-px -translate-y-1/2 border-0 bg-(--warm-gray)" />
        {status && <div className="missions-divider-status absolute inset-y-0 right-0 z-1 w-70 max-w-full normal-case tracking-normal">{status}</div>}
      </div>
    </div>
  )
}

function HistoryRangeSelectFallback({ value }: { value: string }) {
  const label = HISTORY_RANGE_OPTIONS.find((option) => option.value === value)?.label || 'History range'
  return (
    <span
      data-tabout="history-range"
      className="box-border flex h-(--header-control-height) w-fit items-center justify-between gap-1.5 whitespace-nowrap rounded-(--header-control-radius) border border-(--warm-gray) bg-tab-card py-0 pr-2 pl-2.5 text-(length:--header-control-font-size) leading-(--header-control-line-height) [corner-shape:squircle]"
      aria-hidden="true"
    >
      <span>{label}</span>
      <svg className="size-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  )
}

function dashboardMissionSections({
  bookmarkMatchedCards,
  bookmarkMatchesFlush,
  bookmarkMissionsRef,
  historyMatchedCards,
  historyMatchesFlush,
  historyMissionsRef,
  historyResultsFilter,
  historySearchSummary,
  isReady,
  matchedCards,
  primaryEmptyStateHint,
  primaryEmptyStateLabel,
  primaryMissionsEmpty,
  primaryMissionsRef,
  showBookmarkMatches,
  showHistoryMatches,
  showHistoryRange,
  showPrimaryEmptyState,
  source,
}: DashboardMissionSectionsOptions): DashboardMissionSection[] {
  if (!isReady) return []

  const sections: DashboardMissionSection[] = [
    {
      cards: matchedCards,
      emptyStateHint: primaryEmptyStateHint,
      emptyStateLabel: primaryEmptyStateLabel,
      gridEmpty: primaryMissionsEmpty,
      gridId: 'openTabsMissions',
      gridRef: primaryMissionsRef,
      showEmptyState: showPrimaryEmptyState,
      source,
    },
  ]

  if (showHistoryRange || showHistoryMatches) {
    sections.push({
      cards: historyMatchedCards,
      filter: historyResultsFilter,
      gridId: 'historyMatchesMissions',
      gridRef: historyMissionsRef,
      historySearchSummary,
      label: 'History',
      sectionClassName: cn('missions-other missions-history mt-6', historyMatchesFlush && 'mt-0'),
      sectionId: 'historyMatchesSection',
      showEmptyState: false,
      source: 'history',
    })
  }

  if (showBookmarkMatches) {
    sections.push({
      cards: bookmarkMatchedCards,
      gridId: 'bookmarkMatchesMissions',
      gridRef: bookmarkMissionsRef,
      label: 'Bookmarks',
      sectionClassName: cn('missions-other missions-bookmarks mt-6', bookmarkMatchesFlush && 'mt-0'),
      sectionId: 'bookmarkMatchesSection',
      showEmptyState: false,
      source: 'bookmarks',
    })
  }

  return sections
}

function DashboardMissionsList({ filter, historyRangeAction, onRetryHistorySearch, sections }: DashboardMissionsListProps) {
  if (sections.length === 0) return null

  return (
    <>
      {sections.map((section) => {
        const block = (
          <MissionBlock
            key={section.gridId}
            cards={section.cards}
            emptyStateHint={section.emptyStateHint}
            emptyStateLabel={section.emptyStateLabel}
            filter={section.filter ?? filter}
            gridEmpty={section.gridEmpty}
            gridId={section.gridId}
            gridRef={section.gridRef}
            showEmptyState={section.showEmptyState}
            source={section.source}
          />
        )

        if (!section.label) return block
        const action = section.sectionId === 'historyMatchesSection' ? historyRangeAction : undefined
        const status = section.historySearchSummary ? (
          <HistorySearchStatus
            summary={section.historySearchSummary}
            onRetry={onRetryHistorySearch}
          />
        ) : undefined
        return (
          <div className={section.sectionClassName} id={section.sectionId} key={section.sectionId}>
            <MissionsDivider action={action} label={section.label} status={status} />
            {block}
          </div>
        )
      })}
    </>
  )
}

type DashboardShellProps = {
  closedTabs: readonly ClosedTabEntry[]
  dashboardView: DashboardView
  dashboardViewSelection: DashboardView
  dismissedClosedGhosts: ClosedGhostDismissals | null
  savedKeys?: readonly string[] | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  filter: string
  filterInput: string
  filterResultCandidates: readonly FilterResultCandidate[]
  filterResultSearchSettled: boolean
  historyRange: string
  isReady: boolean
  missionSections: DashboardMissionSection[]
  onCloseFiltered: () => void
  onDedupAll: () => void
  onRetryHistorySearch: () => void
  onDashboardViewChange: (nextView: DashboardView) => void
  onTabsChange: () => void
  setFilterInput: (value: string) => void
  setHistoryRange: (value: string) => void
  setTabHistory: (snapshot: TabHistorySnapshot | null) => void
  showHistoryRange: boolean
  source: DashboardSource
  sourceSelection: DashboardSource
  stats: DashboardStats
  tabHistory: TabHistorySnapshot | null
  urlPreviewStore: UrlPreviewStore
  workingSet: WorkingSetSnapshot | null
}

function DashboardShell({
  closedTabs,
  dashboardView,
  dashboardViewSelection,
  dismissedClosedGhosts,
  savedKeys,
  retainedPageSurfaceMatches,
  filter,
  filterInput,
  filterResultCandidates,
  filterResultSearchSettled,
  historyRange,
  isReady,
  missionSections,
  onCloseFiltered,
  onDedupAll,
  onRetryHistorySearch,
  onDashboardViewChange,
  onTabsChange,
  setFilterInput,
  setHistoryRange,
  setTabHistory,
  showHistoryRange,
  source,
  sourceSelection,
  stats,
  tabHistory,
  urlPreviewStore,
  workingSet,
}: DashboardShellProps) {
  const headerRef = useRef<HTMLDivElement>(null)
  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const scrollSentinelRef = useRef<HTMLSpanElement>(null)
  const dashboardPanelHadKeyboardFocusRef = useRef(false)

  useEffect(() => {
    const header = headerRef.current
    const scrollRegion = scrollRegionRef.current
    const scrollSentinel = scrollSentinelRef.current
    if (!header || !scrollRegion || !scrollSentinel) return

    header.toggleAttribute('data-scrolled', scrollRegion.scrollTop >= 1)
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      header.toggleAttribute('data-scrolled', entry.intersectionRatio < 1)
    }, {
      root: scrollRegion,
      threshold: 1,
    })
    observer.observe(scrollSentinel)

    return () => observer.disconnect()
  }, [])

  // Reserve the Tabs-source history column during the initial dashboard fetch so
  // the header does not shift when the first snapshot arrives.
  const showTabHistory = source === 'tabs'
  const historyWorkingSet = source === 'tabs' ? workingSet : null
  const dashboardPanelNeedsFocusTarget = !showHistoryRange
    && missionSections.some((section) => section.showEmptyState && section.cards.length === 0)
    && missionSections.every((section) => section.cards.length === 0 && !section.historySearchSummary)
  useLayoutEffect(() => {
    if (dashboardPanelNeedsFocusTarget || !dashboardPanelHadKeyboardFocusRef.current) return

    dashboardPanelHadKeyboardFocusRef.current = false
    const panel = scrollRegionRef.current
    if (!panel) return
    const ownerDocument = panel.ownerDocument
    if (ownerDocument.visibilityState !== 'visible' || !ownerDocument.hasFocus()) return
    const activeElement = ownerDocument.activeElement
    if (
      activeElement &&
      activeElement !== panel &&
      activeElement !== ownerDocument.body &&
      activeElement !== ownerDocument.documentElement
    ) return

    Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled):not([aria-disabled="true"])'))
      .find((element) => !element.closest('[inert]') && element.getClientRects().length > 0)
      ?.focus({ preventScroll: true })
  }, [dashboardPanelNeedsFocusTarget])
  return (
    <TooltipProvider>
      <div
        data-tabout="dashboard-shell"
        data-dashboard-view={dashboardView}
        data-dashboard-view-selection={dashboardViewSelection}
        data-source={source}
        className={cn(
          'dashboard-shell relative z-1 mx-auto grid min-h-0 w-full max-w-(--dashboard-shell-max-width) flex-auto',
          showTabHistory
            ? 'has-history items-stretch gap-4 grid-cols-[minmax(calc(220px+var(--dashboard-history-edge-gutter)),calc(260px+var(--dashboard-history-edge-gutter)))_minmax(0,1fr)] max-[980px]:[--dashboard-page-gutter:20px] max-[980px]:[--dashboard-history-edge-gutter:12px] max-[980px]:[--dashboard-scrollbar-inset:var(--dashboard-scrollbar-size)] max-[980px]:[&.has-history]:grid-cols-[minmax(0,1fr)] max-[980px]:[&.has-history]:gap-0'
            : 'grid-cols-[minmax(0,1fr)]',
          source === 'bookmarks' && 'is-bookmarks',
        )}
      >
        {showTabHistory && (
          <TabHistoryPanel
            snapshot={tabHistory}
            closedTabs={closedTabs}
            dismissedClosedGhosts={dismissedClosedGhosts}
            onSnapshotChange={setTabHistory}
            workingSet={historyWorkingSet}
            filter={filter}
            savedKeys={savedKeys}
            retainedPageSurfaceMatches={retainedPageSurfaceMatches}
            onTabsChange={onTabsChange}
          />
        )}
        <main
          aria-label="Dashboard"
          className={cn(
            'dashboard-main flex min-h-0 min-w-0 flex-col',
            showTabHistory
              ? 'col-2 pr-(--dashboard-page-gutter) pl-0 max-[980px]:[.dashboard-shell.has-history_&]:col-1 max-[980px]:[.dashboard-shell.has-history_&]:px-(--dashboard-page-gutter)'
              : 'col-1 px-(--dashboard-page-gutter)',
          )}
        >
          <div
            ref={headerRef}
            className={cn(
              'pinned-top relative z-10 flex-none mr-[calc(0px-var(--dashboard-edge-bleed))] pt-3 pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-scrollbar-size))] pb-3 [--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-scrollbar-size))] [--header-shadow-left-reserve:56px] [--header-shadow-left-fade:18px]',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))]'
                : 'ml-[calc(0px-var(--header-shadow-left-reserve))] pl-(--header-shadow-left-reserve)',
              showTabHistory && '[clip-path:inset(0_0_-16px_calc(0px-var(--header-shadow-left-reserve)))] focus-within:[clip-path:inset(-4px_-4px_-16px_calc(0px-var(--header-shadow-left-reserve)-4px))] max-[980px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)+var(--dashboard-scrollbar-size))] max-[980px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-left-reserve:var(--dashboard-edge-bleed)] max-[980px]:[.dashboard-shell.has-history_.dashboard-main_>&]:ml-[calc(0px-var(--dashboard-edge-bleed))] max-[980px]:[.dashboard-shell.has-history_.dashboard-main_>&]:pl-(--dashboard-edge-bleed) max-[980px]:[.dashboard-shell.has-history_.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scrollbar-size))]',
            )}
          >
            <HeaderBar
              dashboardView={dashboardViewSelection}
              source={source}
              sourceSelection={sourceSelection}
              stats={stats}
              ready={isReady}
              filter={filterInput}
              filterResultCandidates={filterResultCandidates}
              filterResultSearchSettled={filterResultSearchSettled}
              historyRange={historyRange}
              onFilterChange={setFilterInput}
              onDashboardViewChange={onDashboardViewChange}
              onCloseFiltered={onCloseFiltered}
              onDedupAll={onDedupAll}
            />
          </div>

          <div
            ref={scrollRegionRef}
            id="dashboardMissions"
            role="tabpanel"
            tabIndex={dashboardPanelNeedsFocusTarget ? 0 : undefined}
            data-tabout-part="scroll-region"
            aria-busy={(source !== sourceSelection && sourceSelection === 'bookmarks') || undefined}
            aria-labelledby={dashboardViewOptionId(dashboardViewSelection)}
            className={cn(
              'scroll-region group/dashboard-panel relative z-1 flex-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-x-none overscroll-y-contain mr-[calc(0px-var(--dashboard-edge-bleed))] pt-1.5 pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))] pb-12.5 scrollbar-gutter-stable focus-visible:outline-none max-[980px]:[.dashboard-main_>&]:mr-[calc(var(--dashboard-scrollbar-size)-var(--dashboard-scrollbar-thumb-size)-var(--dashboard-edge-bleed))] max-[980px]:[.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-size)+var(--dashboard-scrollbar-thumb-size))]',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed)-var(--dashboard-card-shadow-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-card-shadow-bleed))]'
                : 'ml-[calc(0px-var(--dashboard-card-shadow-bleed))] pl-(--dashboard-card-shadow-bleed)',
            )}
            onFocus={(event) => {
              if (event.target !== event.currentTarget) return
              dashboardPanelHadKeyboardFocusRef.current = event.currentTarget.matches(':focus-visible')
            }}
          >
            <span
              ref={scrollSentinelRef}
              data-tabout-part="scroll-sentinel"
              className="pointer-events-none absolute top-0 left-0 size-px"
              aria-hidden="true"
            />
            <DashboardMissionsList
              filter={filter}
              historyRangeAction={showHistoryRange ? (
                <Suspense fallback={<HistoryRangeSelectFallback value={historyRange} />}>
                  <HistoryRangeSelect
                    items={HISTORY_RANGE_OPTIONS}
                    value={historyRange}
                    onValueChange={setHistoryRange}
                  />
                </Suspense>
              ) : undefined}
              onRetryHistorySearch={onRetryHistorySearch}
              sections={missionSections}
            />
          </div>
        </main>
      </div>

      <UrlPreview store={urlPreviewStore} />
    </TooltipProvider>
  )
}

export function App() {
  const startupState = useSyncExternalStore(
    subscribeAppStartup,
    readAppStartup,
    readBuildTimeAppStartup,
  )
  const startupReady = startupState?.phase === 'ready'
  const appDashboard = useDashboardIntakeSnapshot()
  const { closedTabs, dashboard, historyRange, historySearchPending, source, sourceSelection, startupPriorityWorkingSet, tabHistory, workingSet } = appDashboard
  const {
    dashboardViewRoutingReady,
    dashboardViewSelection,
    setDashboardViewSelection,
    visibleDashboardView,
  } = useDashboardViewRouting({
    source,
    sourceSelection,
  })
  const { hoverStateStore, urlPreviewStore, handleHoverUrlChange, clearHoverUrlNow } = useHoverMatch()
  const setHistoryRange = useCallback(async function setHistoryRange(nextHistoryRange: string) {
    dispatchAppDashboard({ type: 'historyRange', historyRange: nextHistoryRange })
    try {
      await saveHistoryRangePreference(nextHistoryRange)
    } catch {
      showToast("Couldn't remember History range")
    }
  }, [])
  const setTabHistory = useCallback(function setTabHistory(nextTabHistory: TabHistorySnapshot | null) {
    dispatchAppDashboard({ type: 'tabHistory', tabHistory: nextTabHistory })
  }, [])
  const previousOrderRef = useRef<MissionOrderMap>({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map(),
  })
  const chipOrderRef = useRef<DashboardChipOrderMemoryMap>({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map(),
  })
  const primaryMissionsRef = useRef<HTMLDivElement | null>(null)
  const bookmarkMissionsRef = useRef<HTMLDivElement | null>(null)
  const historyMissionsRef = useRef<HTMLDivElement | null>(null)
  const [dashboardContentVisible, setDashboardContentVisible] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDashboardContentVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const dynamicContentVisible = dashboardContentVisible && startupReady && dashboardViewRoutingReady
  const visibleDashboard = dynamicContentVisible ? dashboard : null
  const isReady = !!visibleDashboard
  const historyFilterEnabled = isHistoryFilterEnabled(historyRange)

  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, {
    onAfterLayout: validatePageChipTextLayoutsAfterMasonry,
    onBeforePack: prepareDomainCardMoveAnimation,
    onAfterPack: animateDomainCardMoves,
  })

  const currentMissionContainers = useCallback(function currentMissionContainers() {
    return readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef)
  }, [])

  // Created lazily at first use: every consumer is an event handler or
  // effect, and deferring creation keeps the mission refs out of render.
  const cardMovesRef = useRef<DashboardMoveChoreography | null>(null)
  const getCardMoves = useCallback(function getCardMoves() {
    if (!cardMovesRef.current) {
      cardMovesRef.current = createDashboardMoveChoreography({ containers: currentMissionContainers })
    }
    return cardMovesRef.current
  }, [currentMissionContainers])

  const handleBeforeFilterChange = useCallback(function handleBeforeFilterChange() {
    appDashboardStore.clearStartupPriority()
    getCardMoves().primeFilterCardMove()
  }, [getCardMoves])
  const { filterInput, filter, filterSearch, setFilterInput } = useFilterRouting({ onBeforeFilterChange: handleBeforeFilterChange })
  const handleFilterInputChange = useCallback(function handleFilterInputChange(nextFilterInput: string) {
    if (nextFilterInput.trim()) void loadHistoryRangeSelect().catch(() => {})
    if (!startupReady && setAppStartupFilterIntent(nextFilterInput)) {
      notifyAppStartupMaterialChange(
        nextFilterInput.trim() ? FILTER_SEARCH_UPDATE_DELAY_MS : 0,
      )
    }
    setFilterInput(nextFilterInput)
  }, [setFilterInput, startupReady])
  const effectiveStartupPriorityWorkingSet = source === 'tabs' && filter.trim() === '' ? startupPriorityWorkingSet : null
  const visibleWorkingSet = dynamicContentVisible ? effectiveStartupPriorityWorkingSet ?? workingSet : null
  const historyPanelWorkingSet = dynamicContentVisible ? workingSet : null
  function resetMissionOrder() {
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    chipOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
  }
  const {
    localStateLoaded,
    pinnedDomains,
    pinnedSections,
    pinnedPageChips,
    applyStartupState,
    togglePinnedDomain,
    reorderPinnedDomain,
    togglePinnedSection,
    togglePinnedPageChip,
  } = useDashboardLocalState({
    waitForInitialState: !startupReady,
    onBeforeApplyPinnedDomains: ({ animate }) => {
      resetMissionOrder()
      if (animate) getCardMoves().primeCardMove()
    },
    onBeforeApplyPinnedSections: (sectionId) => {
      getCardMoves().prepareIntraCardMove(sectionId)
    },
    onBeforeApplyPinnedPageChips: (pageChipPinId) => {
      getCardMoves().prepareIntraCardMove(pageChipPinId)
    },
    onDomainPinSaveError: () => showToast('Could not save pinned domain'),
    onSectionPinSaveError: () => showToast('Could not save pinned section'),
    onPageChipPinSaveError: () => showToast('Could not save pinned page'),
  })
  const appliedStartupStateRef = useRef<AppStartupState | null>(null)
  useLayoutEffect(() => {
    if (startupState?.phase !== 'ready' || appliedStartupStateRef.current === startupState) return
    appliedStartupStateRef.current = startupState
    applyStartupState(startupState.localState)
  }, [applyStartupState, startupState])
  // react-doctor-disable-next-line react-hooks-js/refs -- the order/chip refs are mutable caches the refresh reads at call time, intentionally outside React's render-tracked state.
  const { refreshDashboard } = useDashboardRefresh({
    bookmarkFilter: filter,
    dashboard,
    source,
    filter: filterSearch,
    historyRange,
    historyFilterEnabled,
    pinnedDomains,
    localStateLoaded,
    initialDashboardIncludesPinnedDomains: startupReady,
    // react-doctor-disable-next-line react-hooks-js/refs -- previousOrder is a mutable ordering cache read at refresh time, not render-derived state.
    previousOrder: previousOrderRef.current,
    onBeforePinnedRefresh: clearHoverUrlNow,
  })
  useEffect(() => {
    return appDashboardStore.subscribeBeforeApply(getCardMoves().onBeforeStoreApply)
  }, [getCardMoves])
  const retryHistorySearch = useCallback(function retryHistorySearch() {
    void refreshDashboard().catch(() => showToast('Could not update History'))
  }, [refreshDashboard])

  useLayoutEffect(() => {
    if (!isReady) return
    clearHoverUrlNow()
    getCardMoves().commitDashboardLayout({ pack: () => packMissionsMasonryNow({ unpin: true }) })
  }, [visibleDashboard, visibleDashboardView, filter, source, isReady, historyFilterEnabled, clearHoverUrlNow, packMissionsMasonryNow, getCardMoves])

  useLayoutEffect(() => {
    animateQueuedPageChipRefreshMoves()
  }, [visibleDashboard])

  const {
    dashboardVm,
    stats,
    matchedCards,
    bookmarkMatchedCards,
    historyMatchedCards,
    historyResultsFilter,
    historySearchSummary,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange,
    showPrimaryEmptyState,
    retainedPagesAvailable,
    hiddenRetainedFilterMatch,
  } = useDashboardViewModels({
    dashboard: visibleDashboard,
    source,
    view: visibleDashboardView,
    filter,
    historyRange,
    historyFilterEnabled,
    historySearchPending,
    isReady,
    // react-doctor-disable-next-line react-hooks-js/refs -- chipOrder is a mutable per-source ordering cache read at view-model build time, not render-derived state.
    chipOrder: chipOrderRef.current,
    workingSet: visibleWorkingSet,
    freezeTabsChipOrder: dynamicContentVisible && !!effectiveStartupPriorityWorkingSet,
    pinnedSections,
    pinnedPageChips,
  })
  const filterResultCandidates = useMemo(
    () => filter.trim()
      ? buildFilterResultCandidates({
          primaryMatches: matchedCards,
          historyMatches: showHistoryMatches ? historyMatchedCards : [],
          bookmarkMatches: showBookmarkMatches ? bookmarkMatchedCards : [],
        })
      : [],
    [
      bookmarkMatchedCards,
      filter,
      historyMatchedCards,
      matchedCards,
      showBookmarkMatches,
      showHistoryMatches,
    ],
  )
  const filterResultSearchSettled = isReady && !dashboardNeedsFilterSearchRefresh(visibleDashboard, {
    source,
    filter,
    historyRange,
    historyFilterEnabled,
  })
  const showSettledEmptyState = showPrimaryEmptyState &&
    filterResultSearchSettled &&
    historySearchSummary?.phase !== 'error'

  useLayoutEffect(() => {
    getCardMoves().commitPreparedIntraCardMove()
  }, [pinnedSections, pinnedPageChips, getCardMoves])

  useStartupOrderDebug({
    dashboard: visibleDashboard,
    source,
    filter,
    isReady,
    matchedCards,
    workingSet: visibleWorkingSet,
    startupReady,
  })

  const onCloseFiltered = useCallback(async function onCloseFiltered() {
    const targets = dashboardVm.filteredCloseTargets
    const activeElement = document.activeElement
    const closeTrigger = activeElement instanceof HTMLElement &&
      activeElement.matches('[data-tabout-part="close-filtered-button"]')
      ? activeElement
      : null
    const result = await closeFilteredTabs(targets)
    if (targets.length > 0 && result.removedCount === targets.length) {
      const nextActiveElement = document.activeElement
      const focusCanStillTransfer =
        !nextActiveElement ||
        nextActiveElement === document.body ||
        nextActiveElement === document.documentElement ||
        nextActiveElement === closeTrigger
      if (focusCanStillTransfer) {
        document.querySelector<HTMLInputElement>(FILTER_QUERY_INPUT_SELECTOR)?.focus()
      }
    }
  }, [dashboardVm.filteredCloseTargets])

  const onDedupAll = useCallback(async function onDedupAll() {
    await dedupeTabs({ urls: dashboardVm.globalDedupeUrls, preservePinnedTabOut: true })
  }, [dashboardVm.globalDedupeUrls])

  const onTabsChange = useCallback(function onTabsChange() {
    void settleDashboardRefresh(refreshDashboard({ animateCards: true }))
  }, [refreshDashboard])

  const onDashboardViewChange = useCallback(function onDashboardViewChange(nextView: DashboardView) {
    if (nextView === dashboardViewSelection) return
    const nextSource = dashboardSourceForView(nextView)
    setDashboardViewSelection(nextView)
    if (!startupReady) {
      if (nextSource !== sourceSelection) {
        appDashboardStore.selectStartupSource(nextSource)
        notifyAppStartupMaterialChange()
      }
      return
    }
    if (nextSource === source) {
      getCardMoves().runViewMoveNow(() => {
        appDashboardStore.clearStartupPriority()
        clearHoverUrlNow()
        appDashboardStore.switchSource(nextSource)
      })
      return
    }
    if (nextSource === sourceSelection) {
      return
    }
    getCardMoves().runSourceSwitchMove(() => {
      appDashboardStore.clearStartupPriority()
      clearHoverUrlNow()
      return appDashboardStore.switchSource(nextSource)
    })
  }, [getCardMoves, clearHoverUrlNow, dashboardViewSelection, setDashboardViewSelection, source, sourceSelection, startupReady])

  const primaryMissionsEmpty = matchedCards.length === 0
  const showHistorySection = showHistoryRange || showHistoryMatches
  const bookmarkMatchesFlush = primaryMissionsEmpty && !showHistorySection
  const historyMatchesFlush = primaryMissionsEmpty
  const primaryEmptyStateLabel = visibleDashboardView === 'open-saved' && !filter.trim() && retainedPagesAvailable
    ? 'No open or saved pages.'
    : undefined
  const primaryEmptyStateHint = visibleDashboardView === 'open-saved'
    ? filter.trim()
      ? hiddenRetainedFilterMatch
        ? 'Retained matches are available in All Tabs.'
        : undefined
      : retainedPagesAvailable
        ? 'Retained pages are available in All Tabs.'
        : undefined
    : undefined
  // react-doctor-disable-next-line react-hooks-js/refs -- the mission grid refs are forwarded to the masonry container elements; they're attached by React, not read for render output.
  const missionSections = useMemo(() => dashboardMissionSections({
    bookmarkMatchedCards,
    bookmarkMatchesFlush,
    bookmarkMissionsRef,
    filter,
    historyMatchedCards,
    historyMatchesFlush,
    historyMissionsRef,
    historyResultsFilter,
    historySearchSummary,
    isReady,
    matchedCards,
    primaryEmptyStateHint,
    primaryEmptyStateLabel,
    primaryMissionsEmpty,
    primaryMissionsRef,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange,
    showPrimaryEmptyState: showSettledEmptyState,
    source,
  }), [bookmarkMatchedCards, bookmarkMatchesFlush, filter, historyMatchedCards, historyMatchesFlush, historyResultsFilter, historySearchSummary, isReady, matchedCards, primaryEmptyStateHint, primaryEmptyStateLabel, primaryMissionsEmpty, showBookmarkMatches, showHistoryMatches, showHistoryRange, showSettledEmptyState, source])

  useMissionOrderMemory({
    previousOrderRef,
    chipOrderRef,
    enabled: dynamicContentVisible,
    source,
    view: visibleDashboardView,
    filter,
    matchedCards,
    bookmarkMatchedCards,
    historyMatchedCards,
  })

  // App bails out of React Compiler (the render-time ordering-cache ref reads
  // above are deliberate), so this context value is memoized manually — the
  // stable-actions contract in DashboardInteractionContext depends on it.
  const dashboardActions = useMemo(() => ({
    onHoverUrlChange: handleHoverUrlChange,
    onLayoutChange: scheduleMissionsMasonry,
    onTogglePinnedDomain: togglePinnedDomain,
    onReorderPinnedDomain: reorderPinnedDomain,
    onTogglePinnedSection: togglePinnedSection,
    onTogglePinnedPageChip: togglePinnedPageChip,
  }), [handleHoverUrlChange, scheduleMissionsMasonry, togglePinnedDomain, reorderPinnedDomain, togglePinnedSection, togglePinnedPageChip])

  return (
    <DashboardActionsProvider value={dashboardActions}>
      <HoverStateProvider store={hoverStateStore}>
        <DashboardShell
          closedTabs={dynamicContentVisible ? closedTabs : EMPTY_CLOSED_TABS}
          dashboardView={visibleDashboardView}
          dashboardViewSelection={dashboardViewSelection}
          dismissedClosedGhosts={startupReady ? startupState.closedGhostDismissals : null}
          savedKeys={visibleDashboard?.savedKeys}
          retainedPageSurfaceMatches={visibleDashboard?.retainedPageSurfaceMatches}
          filter={filter}
          filterInput={filterInput}
          filterResultCandidates={filterResultCandidates}
          filterResultSearchSettled={filterResultSearchSettled}
          historyRange={historyRange}
          isReady={isReady}
          missionSections={missionSections}
          onCloseFiltered={onCloseFiltered}
          onDedupAll={onDedupAll}
          onRetryHistorySearch={retryHistorySearch}
          onDashboardViewChange={onDashboardViewChange}
          onTabsChange={onTabsChange}
          setFilterInput={handleFilterInputChange}
          setHistoryRange={setHistoryRange}
          setTabHistory={setTabHistory}
          showHistoryRange={startupReady && showHistoryRange}
          source={source}
          sourceSelection={sourceSelection}
          stats={stats}
          tabHistory={dynamicContentVisible ? tabHistory : null}
          urlPreviewStore={urlPreviewStore}
          workingSet={historyPanelWorkingSet}
        />
      </HoverStateProvider>
    </DashboardActionsProvider>
  )
}

export function AppRoot() {
  return (
    <AppErrorBoundary>
      <App />
      <DesktopWindowMergeHost />
    </AppErrorBoundary>
  )
}

export function attachApp() {
  const el = document.getElementById('appRoot')
  if (!el) return
  hydrateRoot(el, <AppRoot />, {
    // Safety net for throws the boundary cannot catch (errors inside the
    // boundary/fallback itself) — keep the evidence in the console.
    onUncaughtError: (error, errorInfo) => {
      console.error('[tab-out] uncaught render error', error, errorInfo.componentStack)
    },
    onRecoverableError: (error, errorInfo) => {
      console.error('[tab-out] recoverable hydration error', error, errorInfo.componentStack)
    },
  })
}
