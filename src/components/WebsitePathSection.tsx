import { websitePathPinId } from '../extension/section-pins.js'
import { closeExactTabSection } from '../extension/tab-actions'
import { useDomainCardContext } from './DomainCardContext'
import { FlatSection } from './FlatSection'
import { PathgroupSection } from './PathgroupSection'
import { SectionPinButton } from './SectionPinButton'
import { TitleSuppressionSummary } from './TitleSuppressionSummary'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import { emptyTitleSuppressionToneScope } from './title-suppression'
import type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression'
import type { DashboardChipData, DashboardClusterVM, DashboardTitleSuppression, TogglePinnedSectionHandler } from './types'

interface WebsitePathSectionCloseButtonProps {
  count: number
  isFirstContent?: boolean
  onClick: () => void | Promise<void>
}

interface WebsitePathSectionProps {
  // Pin context defaults to empty / false so call sites and test mocks
  // that predate the pin feature still compile. The pin button only
  // renders when onTogglePinnedSection is supplied.
  domain?: string | undefined
  subdomainKey?: string | undefined
  websitePathKey?: string | undefined
  isPinned?: boolean | undefined
  onTogglePinnedSection?: TogglePinnedSectionHandler | null | undefined
  label: string
  sectionCount: number
  sectionClosableUrls: string[]
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  suppressedTitleParts?: DashboardTitleSuppression[] | undefined
  clusters: Array<DashboardClusterVM & {
    titleSuppressionToneScope?: TitleSuppressionToneScope
    suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
  }>
  className?: string | undefined
  isFirstContent?: boolean | undefined
  filter?: string | undefined
  useSuppressionTokenTones?: boolean | undefined
  suppressedTitleToneIndexByText?: Readonly<Record<string, number>> | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
}

const EMPTY_SUPPRESSED_TITLE_PARTS: DashboardTitleSuppression[] = []
const EMPTY_SUPPRESSION_TONE_INDEX: Readonly<Record<string, number>> = {}

function WebsitePathSectionCloseButton({ count, isFirstContent = false, onClick }: WebsitePathSectionCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className={cn(
          'website-path-section-close-btn absolute top-1/2 right-0 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-tab-card p-0 text-muted-foreground opacity-0 transition-[opacity,background] duration-150 group-hover/website-path-section:opacity-100 hover:bg-[#ededed] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
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

export function WebsitePathSection({
  domain = '',
  subdomainKey = '',
  websitePathKey = '',
  isPinned = false,
  onTogglePinnedSection = null,
  label,
  sectionCount,
  sectionClosableUrls,
  hasFlat,
  flatVisibleChips,
  flatHiddenChips,
  flatHiddenCount,
  suppressedTitleParts = EMPTY_SUPPRESSED_TITLE_PARTS,
  clusters,
  className,
  isFirstContent = false,
  filter = '',
  useSuppressionTokenTones = false,
  suppressedTitleToneIndexByText = EMPTY_SUPPRESSION_TONE_INDEX,
  suppressedTitleToneByText,
}: WebsitePathSectionProps) {
  const { activeSuppressedTitle, setActiveSuppressedTitle } = useDomainCardContext()
  const hasClose = sectionClosableUrls && sectionClosableUrls.length > 0
  const canPin = typeof onTogglePinnedSection === 'function'
  const sectionLayoutKey = websitePathPinId(domain, subdomainKey, websitePathKey)
  const sectionLayoutScope = `website-path|${domain}|${subdomainKey}`

  async function onCloseWebsitePathSection() {
    if (!sectionClosableUrls || sectionClosableUrls.length === 0) return
    await closeExactTabSection({ urls: sectionClosableUrls })
  }

  async function onTogglePin() {
    await onTogglePinnedSection?.(sectionLayoutKey)
  }

  return (
    <div
      data-tabout="website-path-section"
      data-tabout-layout-anchor=""
      data-tabout-layout-item=""
      data-tabout-layout-key={sectionLayoutKey}
      data-tabout-layout-scope={sectionLayoutScope}
      data-tabout-removal-anchor=""
      data-tabout-removal-item=""
      data-tabout-removal-key={`section:${sectionLayoutKey}`}
      className={cn('website-path-section group/website-path-section flex flex-col', className)}
    >
      <div
        className={cn(
          'website-path-section-header relative flex items-center gap-1.5 pr-6 pb-0.5 pl-0',
          isFirstContent ? 'pt-0' : 'pt-0.75',
        )}
      >
        <span className="website-path-section-label inline-block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold tracking-wide text-muted-foreground align-baseline">
          {label}
        </span>
        <span className="website-path-section-header-count text-xs tabular-nums text-muted-foreground">{sectionCount}</span>
        {canPin && (
          <SectionPinButton
            pinned={isPinned}
            label={label}
            onClick={onTogglePin}
            className="group-hover/website-path-section:opacity-100"
          />
        )}
        {hasClose && <WebsitePathSectionCloseButton count={sectionClosableUrls.length} isFirstContent={isFirstContent} onClick={onCloseWebsitePathSection} />}
      </div>
      <TitleSuppressionSummary
        suppressedTitleParts={suppressedTitleParts}
        activeSuppressedTitle={activeSuppressedTitle}
        setActiveSuppressedTitle={setActiveSuppressedTitle}
        useSuppressionTokenTones={useSuppressionTokenTones}
        suppressedTitleToneIndexByText={suppressedTitleToneIndexByText}
        className="pb-1"
      />
      {hasFlat && (
        <FlatSection
          visibleChips={flatVisibleChips}
          hiddenChips={flatHiddenChips}
          hiddenCount={flatHiddenCount}
          filter={filter}
          suppressedTitleToneByText={suppressedTitleToneByText}
        />
      )}
      {clusters.map((cluster, index) => {
        const clusterSuppressedTitleParts = cluster.suppressedTitleParts ?? []
        const clusterSuppressionToneScope = cluster.titleSuppressionToneScope ?? emptyTitleSuppressionToneScope()
        const clusterSuppressedTitleToneByText = cluster.suppressedTitleToneByText ?? suppressedTitleToneByText
        return (
          <PathgroupSection
            key={cluster.key}
            domain={domain}
            subdomainKey={subdomainKey}
            websitePathKey={websitePathKey}
            pathgroupKey={cluster.key}
            isPinned={cluster.isPinned}
            onTogglePinnedSection={onTogglePinnedSection}
            label={cluster.label}
            isPR={cluster.isPR}
            count={cluster.count}
            closableUrls={cluster.closableUrls}
            visibleChips={cluster.visibleChips}
            hiddenChips={cluster.hiddenChips}
            hiddenCount={cluster.hiddenCount}
            className={hasFlat || index > 0 ? 'mt-0.5' : undefined}
            isFirstContent={!hasFlat && index === 0}
            filter={filter}
            suppressedTitleParts={clusterSuppressedTitleParts}
            useSuppressionTokenTones={clusterSuppressionToneScope.useSuppressionTokenTones}
            suppressedTitleToneIndexByText={clusterSuppressionToneScope.suppressedTitleToneIndexByText}
            suppressedTitleToneByText={clusterSuppressedTitleToneByText}
          />
        )
      })}
    </div>
  )
}
