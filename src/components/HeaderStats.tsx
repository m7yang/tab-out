import { dashboardSourceAllowsTabActions, dashboardSourceItemName } from '../extension/dashboard-source.js'
import { cn } from '@/lib/utils'
import type { DashboardSource, DashboardStats } from './types'

interface HeaderStatsProps extends DashboardStats {
  ready?: boolean
  source?: DashboardSource
  onDedupAll: () => void
  onCloseFiltered: () => void
}

function pluralize(count: number, singular: string) {
  return `${singular}${count === 1 ? '' : 's'}`
}

export function HeaderStats({
  ready = true,
  source = 'tabs',
  totalTabs,
  activeTabs,
  visibleTabs,
  totalWindows,
  visibleWindows,
  totalDomains,
  visibleDomains,
  dedupCount,
  filteredCloseCount,
  hasCards,
  filtering,
  onDedupAll,
  onCloseFiltered
}: HeaderStatsProps) {
  if (!ready) {
    return <div data-tabout="header-stats" className="inline-flex min-h-(--header-control-height) min-w-0 items-center gap-2 text-[13px] font-normal tabular-nums text-muted-foreground" aria-hidden="true" />
  }

  const canUseTabActions = dashboardSourceAllowsTabActions(source)
  const hasDedupeAction = canUseTabActions && dedupCount > 0
  const itemName = dashboardSourceItemName(source)
  const itemLabel = pluralize(totalTabs, itemName)
  const tabsLabel = filtering ? `${visibleTabs}/${totalTabs} ${itemLabel}` : `${totalTabs} ${itemLabel}`
  const windowsCount = visibleWindows === totalWindows ? `${totalWindows}` : `${visibleWindows}/${totalWindows}`
  const domainsLabel =
    visibleDomains === totalDomains ? `${totalDomains} ${pluralize(totalDomains, 'domain')}` : `${visibleDomains}/${totalDomains} ${pluralize(totalDomains, 'domain')}`

  const closeFilteredTitle = `Close ${filteredCloseCount} filtered tab${filteredCloseCount !== 1 ? 's' : ''}`

  return (
    <div data-tabout="header-stats" className="inline-flex min-h-(--header-control-height) min-w-0 items-center gap-2 text-[13px] font-normal tabular-nums text-muted-foreground">
      <span data-tabout-part="tab-count" className="font-medium text-foreground">
        {tabsLabel}
        {activeTabs < totalTabs && <span className="font-normal text-muted-foreground"> ({activeTabs} active)</span>}
      </span>
      {hasDedupeAction && (
        <button
          type="button"
          data-tabout="tab-action"
          data-tabout-part="dedupe-button"
          className="action-btn inline-flex h-(--header-control-height) box-border cursor-pointer items-center gap-1.25 rounded-(--header-control-radius) border border-(--warm-gray) bg-tab-card px-3 py-1.25 font-[inherit] [font-size:var(--header-control-font-size)] leading-(--header-control-line-height) font-medium text-muted-foreground transition-[color,border-color] duration-200 [corner-shape:squircle] hover:border-foreground hover:text-foreground"
          onClick={onDedupAll}
        >
          Dedupe {dedupCount}
        </button>
      )}
      {(canUseTabActions || hasCards) && (
        <span
          data-tabout-part="secondary-counts"
          className={cn('inline-flex items-center gap-2.5', !hasDedupeAction && 'ml-0.5')}
        >
          <span className="sr-only">, </span>
          {canUseTabActions && (
            <span data-tabout-part="window-count" className="inline-flex items-center gap-1 whitespace-nowrap">
              {windowsCount}
              <span className="sr-only"> {pluralize(totalWindows, 'window')}</span>
              <span
                data-tabout-part="window-icon"
                className="icon-[lucide--app-window-mac]"
                aria-hidden="true"
              />
            </span>
          )}
          {canUseTabActions && hasCards && <span className="sr-only">, </span>}
          {hasCards && (
            <span data-tabout-part="domain-count" className="whitespace-nowrap text-[13px] font-normal tabular-nums text-muted-foreground">{domainsLabel}</span>
          )}
        </span>
      )}
      {canUseTabActions && filteredCloseCount > 0 && (
        <button
          type="button"
          data-tabout="tab-action"
          data-tabout-part="close-filtered-button"
          className="action-btn close-tabs inline-flex h-(--header-control-height) box-border cursor-pointer items-center gap-1.25 rounded-(--header-control-radius) border border-[rgba(82,82,82,0.3)] bg-[rgba(82,82,82,0.04)] px-3 py-1.25 font-[inherit] [font-size:var(--header-control-font-size)] leading-(--header-control-line-height) font-medium text-(--accent-amber) transition-[color,border-color,background-color] duration-200 [corner-shape:squircle] hover:border-(--accent-amber) hover:bg-[rgba(82,82,82,0.1)]"
          aria-label={closeFilteredTitle}
          onClick={onCloseFiltered}
        >
          <svg className="size-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Close {filteredCloseCount}
        </button>
      )}
    </div>
  )
}
