import { subdomainPinId } from '../extension/section-pins.js'
import { closeExactTabSection } from '../extension/tab-actions'
import { useDomainCardContext } from './DomainCardContext'
import { FlatSection } from './FlatSection'
import { PathgroupSection } from './PathgroupSection'
import { SectionPinButton } from './SectionPinButton'
import { TitleSuppressionSummary } from './TitleSuppressionSummary'
import { WebsitePathSection } from './WebsitePathSection'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import { emptyTitleSuppressionToneScope } from './title-suppression'
import type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression'
import type { DashboardChipData, DashboardClusterVM, DashboardTitleSuppression, DashboardWebsitePathSectionVM, TogglePinnedSectionHandler } from './types'

interface SubdomainCloseButtonProps {
  count: number
  onClick: () => void | Promise<void>
}

interface SubdomainSectionProps {
  // Pin context defaults to empty / false so existing call sites and test
  // mocks that predate the pin feature still compile. The pin button only
  // renders when onTogglePinnedSection is supplied.
  domain?: string | undefined
  subdomainKey: string
  isPinned?: boolean | undefined
  isShared?: boolean | undefined
  onTogglePinnedSection?: TogglePinnedSectionHandler | null | undefined
  position?: 'first' | 'later' | undefined
  headerType: 'hidden' | 'subdomain' | 'port'
  sectionCount: number
  sectionClosableUrls: string[]
  flatSection: {
    visibleChips: DashboardChipData[]
    hiddenChips: DashboardChipData[]
    hiddenCount: number
  } | null
  suppressedTitleParts?: DashboardTitleSuppression[] | undefined
  websitePathSections: Array<DashboardWebsitePathSectionVM & {
    titleSuppressionToneScope?: TitleSuppressionToneScope
    suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
    clusters: Array<DashboardClusterVM & {
      titleSuppressionToneScope?: TitleSuppressionToneScope
      suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
    }>
  }>
  clusters: Array<DashboardClusterVM & {
    titleSuppressionToneScope?: TitleSuppressionToneScope
    suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
  }>
  filter?: string | undefined
  useSuppressionTokenTones?: boolean | undefined
  suppressedTitleToneIndexByText?: Readonly<Record<string, number>> | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
}

const EMPTY_SUPPRESSED_TITLE_PARTS: DashboardTitleSuppression[] = []
const EMPTY_SUPPRESSION_TONE_INDEX: Readonly<Record<string, number>> = {}

function SubdomainCloseButton({ count, onClick }: SubdomainCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className="subdomain-close-btn grid size-4.5 flex-[0_0_18px] cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 leading-0 text-muted-foreground opacity-0 transition-[opacity,background] duration-150 group-hover/subdomain-section:opacity-100 hover:bg-[#ededed] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
        aria-label={title}
        onClick={onClick}
      >
        <svg className="block size-3 flex-none" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </TooltipAnchor>
  )
}

export function SubdomainSection({
  domain = '',
  subdomainKey,
  isPinned = false,
  isShared = false,
  onTogglePinnedSection = null,
  position = 'later',
  headerType,
  sectionCount,
  sectionClosableUrls,
  flatSection,
  suppressedTitleParts = EMPTY_SUPPRESSED_TITLE_PARTS,
  websitePathSections,
  clusters,
  filter = '',
  useSuppressionTokenTones = false,
  suppressedTitleToneIndexByText = EMPTY_SUPPRESSION_TONE_INDEX,
  suppressedTitleToneByText,
}: SubdomainSectionProps) {
  const { activeSuppressedTitle, setActiveSuppressedTitle } = useDomainCardContext()
  const isFirst = position === 'first'
  const isPort = headerType === 'port'
  const showHeader = headerType !== 'hidden'
  const hasFlat = flatSection !== null
  const hasClose = showHeader && sectionClosableUrls && sectionClosableUrls.length > 0
  const headerLabel = subdomainKey
  const sectionLayoutKey = subdomainPinId(domain, subdomainKey)
  const sectionLayoutScope = `subdomain|${domain}`
  // Pinning a virtual section (cross-env shared, apps card) wouldn't have a
  // stable identity, so skip the affordance there. The pin button itself
  // only renders when the parent card supplies a toggle handler.
  const canPin = !isShared && showHeader && typeof onTogglePinnedSection === 'function'

  async function onCloseSubdomain() {
    if (!sectionClosableUrls || sectionClosableUrls.length === 0) return
    await closeExactTabSection({ urls: sectionClosableUrls })
  }

  async function onTogglePin() {
    await onTogglePinnedSection?.(sectionLayoutKey)
  }

  return (
    <div
      data-tabout="subdomain-section"
      data-tabout-layout-anchor=""
      data-tabout-layout-item=""
      data-tabout-layout-key={sectionLayoutKey}
      data-tabout-layout-scope={sectionLayoutScope}
      data-tabout-removal-anchor=""
      data-tabout-removal-item=""
      data-tabout-removal-key={`section:${sectionLayoutKey}`}
      className={cn(
        'subdomain-section group/subdomain-section flex flex-col',
        !isFirst && 'mt-1.5',
      )}
      data-kind={isPort ? 'port' : undefined}
    >
      {showHeader && (
        <div
          className={cn(
            'subdomain-header flex items-center gap-1.5 pb-0.5 text-xs font-semibold tracking-[0.2px] text-muted-foreground',
            isFirst ? 'pt-0.5' : 'pt-1.5',
          )}
        >
          <span
            className={cn(
              'subdomain-header-name',
              isPort
                ? "before:content-[':']"
                : "after:ml-px after:content-['.']",
            )}
          >
            {headerLabel}
          </span>
          <span className="subdomain-header-count font-medium tabular-nums">{sectionCount}</span>
          {canPin && (
            <SectionPinButton
              pinned={isPinned}
              label={headerLabel}
              onClick={onTogglePin}
              className="group-hover/subdomain-section:opacity-100"
            />
          )}
          {hasClose && <SubdomainCloseButton count={sectionClosableUrls.length} onClick={onCloseSubdomain} />}
        </div>
      )}
      <TitleSuppressionSummary
        suppressedTitleParts={suppressedTitleParts}
        activeSuppressedTitle={activeSuppressedTitle}
        setActiveSuppressedTitle={setActiveSuppressedTitle}
        useSuppressionTokenTones={useSuppressionTokenTones}
        suppressedTitleToneIndexByText={suppressedTitleToneIndexByText}
        className={cn('pb-1', !isFirst && !showHeader && 'pt-1.5')}
      />
      {hasFlat && (
        <FlatSection
          visibleChips={flatSection.visibleChips}
          hiddenChips={flatSection.hiddenChips}
          hiddenCount={flatSection.hiddenCount}
          afterSeparator={!isFirst && !showHeader}
          filter={filter}
          suppressedTitleToneByText={suppressedTitleToneByText}
        />
      )}
      {websitePathSections.map((websitePathSection, index) => (
        <WebsitePathSection
          key={websitePathSection.key}
          domain={domain}
          subdomainKey={subdomainKey}
          websitePathKey={websitePathSection.key}
          isPinned={websitePathSection.isPinned}
          onTogglePinnedSection={onTogglePinnedSection}
          label={websitePathSection.label}
          sectionCount={websitePathSection.sectionCount}
          sectionClosableUrls={websitePathSection.sectionClosableUrls}
          hasFlat={websitePathSection.hasFlat}
          flatVisibleChips={websitePathSection.flatVisibleChips}
          flatHiddenChips={websitePathSection.flatHiddenChips}
          flatHiddenCount={websitePathSection.flatHiddenCount}
          suppressedTitleParts={websitePathSection.suppressedTitleParts ?? []}
          clusters={websitePathSection.clusters}
          className={hasFlat || index > 0 ? 'mt-0.5' : undefined}
          isFirstContent={(isFirst || showHeader) && !hasFlat && index === 0}
          filter={filter}
          useSuppressionTokenTones={websitePathSection.titleSuppressionToneScope?.useSuppressionTokenTones ?? false}
          suppressedTitleToneIndexByText={websitePathSection.titleSuppressionToneScope?.suppressedTitleToneIndexByText ?? EMPTY_SUPPRESSION_TONE_INDEX}
          suppressedTitleToneByText={websitePathSection.suppressedTitleToneByText}
        />
      ))}
      {clusters.map((cluster, index) => {
        const clusterSuppressedTitleParts = cluster.suppressedTitleParts ?? []
        const clusterSuppressionToneScope = cluster.titleSuppressionToneScope ?? emptyTitleSuppressionToneScope()
        const clusterSuppressedTitleToneByText = cluster.suppressedTitleToneByText ?? suppressedTitleToneByText
        return (
          <PathgroupSection
            key={cluster.key}
            domain={domain}
            subdomainKey={subdomainKey}
            websitePathKey=""
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
            className={hasFlat || websitePathSections.length > 0 || index > 0 ? 'mt-0.5' : undefined}
            isFirstContent={(isFirst || showHeader) && !hasFlat && websitePathSections.length === 0 && index === 0}
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
