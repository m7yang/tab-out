import { useState } from 'react'
import { pathgroupPinId } from '../extension/section-pins.js'
import { closeExactTabSection } from '../extension/tab-actions'
import { useDomainCardContext } from './DomainCardContext'
import { usePageChipOverflow } from './PageChipOverflow'
import { SectionPinButton } from './SectionPinButton'
import { TitleSuppressionSummary } from './TitleSuppressionSummary'
import { TooltipAnchor } from './ui/tooltip'
import { subscribeFontMetricsInvalidation } from './font-metrics-invalidation.js'
import { cn } from '@/lib/utils'
import type { Dispatch, SetStateAction } from 'react'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData, DashboardTitleSuppression, TogglePinnedSectionHandler } from './types'

let pathgroupLabelResizeObserver: ResizeObserver | null = null
const pathgroupLabelTruncationCallbacks = new WeakMap<
  HTMLElement,
  (isTruncated: boolean) => void
>()

interface PathgroupCloseButtonProps {
  count: number
  isFirstContent?: boolean
  onClick: () => void | Promise<void>
}

interface PathgroupSectionProps {
  // Pin context defaults to empty / false so call sites and test mocks
  // that predate the pin feature still compile. The pin button only
  // renders when onTogglePinnedSection is supplied.
  domain?: string | undefined
  subdomainKey?: string | undefined
  // Empty when the pathgroup is rendered directly under a subdomain. Set
  // when nested inside a website-path section.
  websitePathKey?: string | undefined
  // Cluster identity used for the pin id — matches cluster.key from the
  // view-model (e.g. 'acme/repo' or 'acme/repo:pr').
  pathgroupKey?: string | undefined
  isPinned?: boolean | undefined
  onTogglePinnedSection?: TogglePinnedSectionHandler | null | undefined
  label: string
  isPR: boolean
  count: number
  closableUrls: string[]
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  className?: string | undefined
  isFirstContent?: boolean | undefined
  filter?: string | undefined
  suppressedTitleParts?: DashboardTitleSuppression[] | undefined
  useSuppressionTokenTones?: boolean | undefined
  suppressedTitleToneIndexByText?: Readonly<Record<string, number>> | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
}

const EMPTY_SUPPRESSED_TITLE_PARTS: DashboardTitleSuppression[] = []
const EMPTY_SUPPRESSION_TONE_INDEX: Readonly<Record<string, number>> = {}

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
}

function isPathgroupLabelTruncated(labelEl: HTMLElement | null) {
  if (!labelEl) return false
  return labelEl.scrollWidth - labelEl.clientWidth > 1
}

function syncPathgroupLabelTruncation(labelEl: HTMLElement | null) {
  const isTruncated = isPathgroupLabelTruncated(labelEl)
  if (labelEl) pathgroupLabelTruncationCallbacks.get(labelEl)?.(isTruncated)
  return isTruncated
}

function updatePathgroupLabelTruncation(
  labelEl: HTMLElement | null,
  setPathgroupLabelTruncated: Dispatch<SetStateAction<boolean>>,
) {
  const isTruncated = syncPathgroupLabelTruncation(labelEl)
  setPathgroupLabelTruncated((current) => current === isTruncated ? current : isTruncated)
}

function getPathgroupLabelResizeObserver() {
  pathgroupLabelResizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) syncPathgroupLabelTruncation(entry.target)
    }
  })
  return pathgroupLabelResizeObserver
}

/**
 * Follows one mounted label: the shared ResizeObserver reports its truncation
 * and font settlement re-measures it. Returns the detach cleanup that React's
 * callback-ref lifecycle runs when the element leaves the tree.
 */
function attachPathgroupLabelTruncation(
  labelEl: HTMLElement,
  setPathgroupLabelTruncated: Dispatch<SetStateAction<boolean>>,
): () => void {
  let disposed = false
  const observer = getPathgroupLabelResizeObserver()
  pathgroupLabelTruncationCallbacks.set(labelEl, (isTruncated) => {
    if (disposed) return
    setPathgroupLabelTruncated((current) => current === isTruncated ? current : isTruncated)
  })
  observer.observe(labelEl)
  const unsubscribeFontMetrics = subscribeFontMetricsInvalidation(() => {
    if (!disposed) updatePathgroupLabelTruncation(labelEl, setPathgroupLabelTruncated)
  })

  return () => {
    disposed = true
    observer.unobserve(labelEl)
    pathgroupLabelTruncationCallbacks.delete(labelEl)
    unsubscribeFontMetrics()
  }
}

function PathgroupCloseButton({ count, isFirstContent = false, onClick }: PathgroupCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className={cn(
          'pathgroup-close-btn absolute top-1/2 right-0 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-tab-card p-0 text-muted-foreground opacity-0 transition-[opacity,background] duration-150 group-hover/pathgroup-section:opacity-100 hover:bg-[#ededed] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
          isFirstContent && 'top-[calc(50%-1px)]',
        )}
        aria-label={title}
        onClick={onClick}
      >
        <svg className="block size-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </TooltipAnchor>
  )
}

export function PathgroupSection({ domain = '', subdomainKey = '', websitePathKey = '', pathgroupKey = '', isPinned = false, onTogglePinnedSection = null, label, isPR, count, closableUrls, visibleChips, hiddenChips, hiddenCount, className, isFirstContent = false, filter = '', suppressedTitleParts = EMPTY_SUPPRESSED_TITLE_PARTS, useSuppressionTokenTones = false, suppressedTitleToneIndexByText = EMPTY_SUPPRESSION_TONE_INDEX, suppressedTitleToneByText }: PathgroupSectionProps) {
  const [pathgroupLabelTruncated, setPathgroupLabelTruncated] = useState(false)
  // The observer follows the label element itself through a callback ref with
  // cleanup, so it re-attaches on its own when TooltipAnchor swaps its tree
  // once tooltip content appears. The compiler memoizes this callback (its only
  // input is the stable state setter), and verify:compiler guards that; a fresh
  // identity would only re-run detach and attach, never change the result.
  const observePathgroupLabel = (labelEl: HTMLSpanElement | null) => {
    if (!labelEl) return undefined
    return attachPathgroupLabelTruncation(labelEl, setPathgroupLabelTruncated)
  }
  const { activeSuppressedTitle, setActiveSuppressedTitle } = useDomainCardContext()
  const displayLabel = pathGroupDisplayLabel(label)
  const pathgroupLabelTooltipContent = pathgroupLabelTruncated ? (
    <span className="text-[13px] leading-tight">{displayLabel}</span>
  ) : undefined
  const canPin = typeof onTogglePinnedSection === 'function'
  const sectionLayoutKey = pathgroupPinId(domain, subdomainKey, websitePathKey, pathgroupKey)
  const sectionLayoutScope = `pathgroup|${domain}|${subdomainKey}|${websitePathKey}`
  const { expanded, pageChips } = usePageChipOverflow({
    visibleChips,
    hiddenChips,
    hiddenCount,
    filter,
    suppressedTitleToneByText,
    overflowButtonClassName: 'pl-3',
  })

  async function onTogglePin() {
    await onTogglePinnedSection?.(sectionLayoutKey)
  }

  async function onCloseCluster() {
    if (!closableUrls || closableUrls.length === 0) return
    await closeExactTabSection({ urls: closableUrls })
  }

  return (
    <div
      data-tabout="path-group"
      data-tabout-layout-anchor=""
      data-tabout-layout-item=""
      data-tabout-layout-key={sectionLayoutKey}
      data-tabout-layout-scope={sectionLayoutScope}
      data-tabout-removal-anchor=""
      data-tabout-removal-item=""
      data-tabout-removal-key={`section:${sectionLayoutKey}`}
      data-expanded={expanded ? 'true' : undefined}
      className={cn('pathgroup-section group/pathgroup-section flex flex-col', className)}
    >
      <div
        className={cn(
          'pathgroup-header relative flex items-center gap-1.5 pr-6 pb-0.5 pl-0',
          isFirstContent ? 'pt-0' : 'pt-0.75',
        )}
      >
        <TooltipAnchor content={pathgroupLabelTooltipContent}>
          <span ref={observePathgroupLabel} className="chip-pathgroup inline-block min-w-0 overflow-hidden rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-ellipsis whitespace-nowrap text-xs font-medium text-muted-foreground align-baseline [corner-shape:squircle]">
            {displayLabel}
          </span>
        </TooltipAnchor>
        {isPR && (
          <span className="chip-pathgroup chip-pathgroup-pr -ml-0.5 inline-block rounded-lg bg-[rgba(115,115,115,0.18)] px-1.25 text-xs font-semibold text-foreground align-baseline [corner-shape:squircle]">
            PRs
          </span>
        )}
        <span className="pathgroup-header-count text-xs tabular-nums text-muted-foreground">{count}</span>
        {canPin && (
          <SectionPinButton
            pinned={isPinned}
            label={displayLabel}
            onClick={onTogglePin}
            className="group-hover/pathgroup-section:opacity-100"
          />
        )}
        {closableUrls && closableUrls.length > 0 && <PathgroupCloseButton count={closableUrls.length} isFirstContent={isFirstContent} onClick={onCloseCluster} />}
      </div>
      <TitleSuppressionSummary
        suppressedTitleParts={suppressedTitleParts}
        activeSuppressedTitle={activeSuppressedTitle}
        setActiveSuppressedTitle={setActiveSuppressedTitle}
        useSuppressionTokenTones={useSuppressionTokenTones}
        suppressedTitleToneIndexByText={suppressedTitleToneIndexByText}
        className="pb-1"
      />
      {pageChips}
    </div>
  )
}
