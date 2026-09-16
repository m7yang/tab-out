import { LoaderCircle } from 'lucide-react'
import type { HistorySearchSummary } from '../extension/types'
import { historySearchStatusCopy } from './history-search-status-copy'

type HistorySearchStatusProps = {
  onRetry?: () => void
  summary: HistorySearchSummary
}

export function HistorySearchStatus({ onRetry, summary }: HistorySearchStatusProps) {
  const copy = historySearchStatusCopy(summary)
  const busy = summary.phase === 'searching' || summary.phase === 'updating'

  return (
    <div
      data-tabout="history-search-status"
      data-tabout-history-phase={summary.phase}
      className="history-search-status flex h-9.5 max-w-full min-w-0 text-[13px] leading-4 font-normal normal-case tracking-normal"
    >
      <output
        className="grid min-w-0 flex-auto grid-rows-2 text-right"
        aria-atomic="true"
        aria-busy={busy}
        aria-live="polite"
      >
        <div className="flex min-w-0 items-start justify-end">
          <span
            data-tabout-part="summary-title"
            className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-foreground"
          >
            {copy.title}
          </span>
        </div>
        <div className="flex min-w-0 items-end justify-end">
          <span
            data-tabout-part="summary-detail"
            className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
          >
            {copy.detail}
          </span>
        </div>
      </output>
      {(busy || summary.phase === 'error') && (
        <div className="z-1 flex w-10.5 shrink-0 items-center justify-end">
          {busy && (
            <LoaderCircle
              data-tabout-part="loading-indicator"
              className="size-3.5 animate-spin rounded-full bg-background ring-4 ring-background motion-reduce:animate-none"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          )}
          {summary.phase === 'error' && (
            <button
              type="button"
              data-tabout-part="retry-button"
              className="h-6 rounded-full bg-background px-2 text-[13px] leading-6 font-medium text-foreground ring-1 ring-foreground/10 transition-colors hover:bg-[rgba(82,82,82,0.06)] focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}
