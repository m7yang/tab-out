import { dashboardSourceAllowsTabActions, dashboardSourceItemName } from '../extension/dashboard-source.js'
import type { DashboardSource, DashboardStats } from './types'

interface HeaderStatsProps extends DashboardStats {
  ready?: boolean
  source?: DashboardSource
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
  hasCards,
  filtering,
}: HeaderStatsProps) {
  if (!ready) {
    return <div data-tabout="header-stats" className="inline-flex min-h-(--header-control-height) min-w-0 overflow-hidden items-center gap-2 text-[13px] font-normal tabular-nums text-muted-foreground" aria-hidden="true" />
  }

  const canUseTabActions = dashboardSourceAllowsTabActions(source)
  const showActiveCount = canUseTabActions && activeTabs < totalTabs
  const itemName = dashboardSourceItemName(source)
  const itemLabel = pluralize(totalTabs, itemName)
  const tabsLabel = filtering ? `${visibleTabs}/${totalTabs} ${itemLabel}` : `${totalTabs} ${itemLabel}`
  const windowsCount = visibleWindows === totalWindows ? `${totalWindows}` : `${visibleWindows}/${totalWindows}`
  const domainsLabel =
    visibleDomains === totalDomains ? `${totalDomains} ${pluralize(totalDomains, 'domain')}` : `${visibleDomains}/${totalDomains} ${pluralize(totalDomains, 'domain')}`

  return (
    <div data-tabout="header-stats" className="inline-flex min-h-(--header-control-height) min-w-0 overflow-hidden items-center gap-2 text-[13px] leading-(--header-control-line-height) font-normal tabular-nums text-muted-foreground">
      <span data-tabout-part="tab-count" className="font-medium text-foreground">
        {showActiveCount && !filtering ? (
          <>
            {activeTabs}
            <span className="font-normal text-muted-foreground"> of {totalTabs} {itemLabel} active</span>
          </>
        ) : (
          <>
            {tabsLabel}
            {showActiveCount && <span className="font-normal text-muted-foreground"> ({activeTabs} active)</span>}
          </>
        )}
      </span>
      {(canUseTabActions || hasCards) && (
        <span
          data-tabout-part="secondary-counts"
          className="ml-0.5 inline-flex items-center gap-2.5"
        >
          <span className="sr-only">, </span>
          {canUseTabActions && (
            <span data-tabout-part="window-count" className="whitespace-nowrap">
              <span data-tabout-part="window-count-value">{windowsCount}</span>
              <span className="sr-only"> {pluralize(totalWindows, 'window')}</span>
              <span
                data-tabout-part="window-icon"
                className="icon-[lucide--app-window-mac] ml-1 align-[-0.125em]"
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
    </div>
  )
}
