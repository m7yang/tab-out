import { useRef } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { useWindowEvent } from '../hooks/useGlobalEvent'
import { HeaderStats } from './HeaderStats'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { dashboardViewOptionId, type DashboardView } from '../extension/dashboard-view.js'
import { isHistoryFilterEnabled } from '../extension/history-range.js'
import { isFilterFocusShortcut } from '../extension/app-url.js'
import type { FilterResultCandidate } from '../extension/filter-result-navigation.js'
import { useFilterResultNavigation } from './filter-result-navigation/use-filter-result-navigation.js'
import { cn } from '@/lib/utils'
import type { DashboardSource, DashboardStats } from './types'

interface DashboardViewSwitchProps {
  dashboardView: DashboardView
  onDashboardViewChange: (dashboardView: DashboardView) => void | Promise<void>
}

const DASHBOARD_VIEW_OPTIONS = [
  { value: 'open-saved', label: 'Open + Saved' },
  { value: 'all-tabs', label: 'All Tabs' },
  { value: 'bookmarks', label: 'Bookmarks' },
] as const

const ALL_TABS_DESCRIPTION_ID = 'dashboard-view-all-tabs-description'
const BOOKMARKS_FILTER_PLACEHOLDER = 'Filter bookmarks…'

function isDashboardViewValue(value: unknown): value is DashboardView {
  return typeof value === 'string' && DASHBOARD_VIEW_OPTIONS.some((option) => option.value === value)
}

interface HeaderBarProps {
  stats: DashboardStats
  filter: string
  filterResultCandidates?: readonly FilterResultCandidate[]
  filterResultSearchSettled?: boolean
  historyRange: string
  onFilterChange: (filter: string) => void
  onCloseFiltered: () => void | Promise<void>
  dashboardView: DashboardView
  onDashboardViewChange: (dashboardView: DashboardView) => void | Promise<void>
  source?: DashboardSource
  sourceSelection?: DashboardSource
  ready?: boolean
}

const EMPTY_FILTER_RESULT_CANDIDATES: readonly FilterResultCandidate[] = []

function DashboardViewSwitch({ dashboardView, onDashboardViewChange }: DashboardViewSwitchProps) {
  function handleDashboardViewChange(nextValue: unknown) {
    if (!isDashboardViewValue(nextValue)) return
    if (nextValue === dashboardView) return
    void onDashboardViewChange(nextValue)
  }

  return (
    <Tabs
      value={dashboardView}
      data-tabout="dashboard-view"
      className="source-switch-root inline-flex box-border h-(--header-control-height) rounded-(--header-control-radius) border border-(--warm-gray) [corner-shape:squircle]"
      onValueChange={handleDashboardViewChange}
    >
      <TabsList
        variant="line"
        className="source-switch relative z-0 flex h-full box-border items-center gap-1 rounded-none px-1 py-0"
        aria-label="Dashboard view"
      >
        {DASHBOARD_VIEW_OPTIONS.map((option) => (
          <TabsTrigger
            key={option.value}
            id={dashboardViewOptionId(option.value)}
            value={option.value}
            data-tabout-part="dashboard-view-option"
            className="source-switch-option relative z-1 inline-flex h-8 flex-none box-border cursor-pointer select-none items-center justify-center whitespace-nowrap border-0 bg-transparent px-2 py-0 text-(length:--header-control-font-size) leading-(--header-control-line-height) font-normal text-muted-foreground outline-none font-[inherit] [transition:color_0.15s_ease] after:hidden before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-1 before:rounded-[calc(var(--header-control-radius)-6px)] before:outline-2 before:-outline-offset-1 before:outline-transparent before:[corner-shape:squircle] before:content-[''] hover:text-foreground focus-visible:ring-0 focus-visible:outline-none focus-visible:before:outline-(--accent-amber) data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
            aria-controls="dashboardMissions"
            aria-describedby={option.value === 'all-tabs' ? ALL_TABS_DESCRIPTION_ID : undefined}
          >
            {option.label}
          </TabsTrigger>
        ))}
        {/* Animates width (not scaleX): scaling would distort the squircle corners mid-slide. */}
        <TabsPrimitive.Indicator className="source-switch-indicator absolute top-1/2 left-0 z-0 h-6 w-(--active-tab-width) rounded-[calc(var(--header-control-radius)-6px)] bg-[rgba(115,115,115,0.12)] [corner-shape:squircle] transform-[translateX(var(--active-tab-left))_translateY(-50%)] transition-[width,transform] duration-200 ease-swift motion-reduce:transition-none" />
      </TabsList>
      <span id={ALL_TABS_DESCRIPTION_ID} className="sr-only">Includes retained pages</span>
    </Tabs>
  )
}

export function HeaderBar({
  dashboardView,
  filter,
  filterResultCandidates = EMPTY_FILTER_RESULT_CANDIDATES,
  filterResultSearchSettled = true,
  historyRange,
  onFilterChange,
  onCloseFiltered,
  onDashboardViewChange,
  source = 'tabs',
  sourceSelection = source,
  ready = true,
  stats,
}: HeaderBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const navigation = useFilterResultNavigation({
    inputRef,
    dashboardView,
    source,
    sourceSelection,
    filter,
    filterResultCandidates,
    filterResultSearchSettled,
    onFilterChange,
  })

  useWindowEvent('keydown', (e) => {
    if (!isFilterFocusShortcut(e)) return
    e.preventDefault()
    inputRef.current?.focus()
    inputRef.current?.select?.()
  })

  const filterPlaceholder = source === 'bookmarks' ? BOOKMARKS_FILTER_PLACEHOLDER : isHistoryFilterEnabled(historyRange) ? 'Filter tabs, bookmarks, history…' : 'Filter tabs and bookmarks…'

  function onClear() {
    navigation.onQueryChange('')
    inputRef.current?.focus()
  }

  return (
    <header className="flex flex-col">
      <div className="header-row flex items-center justify-between gap-4 pl-2">
        <div className="header-left flex min-w-0 flex-1 items-center gap-4">
          <div
            data-tabout="filter-query"
            className={cn(
              "tab-filter-wrap relative isolate inline-flex w-70 shrink-0 items-center min-[981px]:max-[1100px]:[.dashboard-shell.has-history_&]:w-39 before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-page-chip before:border before:border-input before:drop-shadow-xs before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:z-0 after:rounded-page-chip after:border after:border-blue-500 after:opacity-0 after:drop-shadow-md after:drop-shadow-blue-500/50 after:transition-opacity after:duration-150 after:ease-out after:[corner-shape:squircle] after:content-[''] motion-reduce:after:transition-none [&:has(input:focus-visible)::after]:opacity-100",
              filter && 'has-value [&_.tab-filter]:pr-7.5 [&_.tab-filter-clear]:inline-flex',
            )}
          >
            <span
              aria-hidden="true"
              className="bookmarks-filter-startup-placeholder pointer-events-none absolute top-1/2 left-[calc(var(--spacing)*3+1px)] z-2 hidden -translate-y-1/2 select-none whitespace-nowrap text-(length:--header-control-font-size) leading-(--header-control-line-height) text-muted-foreground font-[inherit] md:text-sm"
            >
              {BOOKMARKS_FILTER_PLACEHOLDER}
            </span>
            <input
              ref={inputRef}
              type="search"
              data-slot="input"
              data-tabout-part="input"
              className={cn(
                'h-8 w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
                'tab-filter relative z-1 box-border h-(--header-control-height) w-full rounded-page-chip border border-transparent bg-transparent px-3 py-1 text-(length:--header-control-font-size) leading-(--header-control-line-height) text-foreground caret-blue-500 shadow-none transition-colors outline-none font-[inherit] [corner-shape:squircle] placeholder:select-none placeholder:text-muted-foreground md:text-sm [&::-webkit-search-cancel-button]:[-webkit-appearance:none]',
              )}
              autoComplete="off"
              spellCheck="false"
              aria-label="Filter dashboard"
              placeholder={filterPlaceholder}
              value={filter}
              aria-controls={filter.trim() ? 'dashboardMissions' : undefined}
              onChange={(e) => navigation.onQueryChange(e.currentTarget.value)}
              onKeyDown={navigation.onKeyDown}
            />
            <button
              type="button"
              data-tabout-part="clear-button"
              className="tab-filter-clear absolute top-1/2 right-1.5 z-1 hidden size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-[background,color] duration-150 ease-[ease] hover:bg-[rgba(10,10,10,0.08)] hover:text-foreground [&_svg]:h-3 [&_svg]:w-3"
              aria-label="Clear filter"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClear}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <HeaderStats
            source={source}
            ready={ready}
            {...stats}
            onCloseFiltered={onCloseFiltered}
          />
        </div>
        <div className="header-controls inline-flex items-center gap-2.5">
          <DashboardViewSwitch
            dashboardView={dashboardView}
            onDashboardViewChange={onDashboardViewChange}
          />
        </div>
      </div>
    </header>
  )
}
