import { useEffect, useId, useLayoutEffect, useState, type ReactNode, type TransitionEvent } from 'react'
import { pageTargetMatchesHover } from '../extension/page-target.js'
import { resolveSameTitlePageChip } from '../extension/same-title-page-chip-plan.js'
import { useDomainCardContext } from './DomainCardContext'
import { useDashboardActions, useHoverStateSelector, type HoverState } from './DashboardInteractionContext'
import { PageChip } from './PageChip'
import { attachCapsuleBorder } from './capsule-border'
import { cn } from '@/lib/utils'
import { TITLE_SUPPRESSION_MARKER_SYMBOL, countHiddenSuppressedTitleMatches, titleSuppressionBadgeClass, titleSuppressionOverflowHighlightClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData } from './types'

type OverflowContainerClassName =
  | string
  | ((state: { expanded: boolean }) => string | undefined)

interface PageChipOverflowOptions {
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  filter?: string | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
  overflowContainerClassName?: OverflowContainerClassName | undefined
  overflowButtonClassName?: string | undefined
}

const OVERFLOW_BUTTON_CLASS_NAME =
  "page-chip page-chip-overflow clickable relative flex cursor-pointer items-start gap-2 border-0 [--capsule-fill:transparent] bg-(--capsule-fill) py-[5px] pr-1 text-left text-[13px] leading-tight tabular-nums text-muted-foreground [font-family:inherit] transition-[color,box-shadow,opacity] duration-100 ease-swift after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,color-mix(in_srgb,var(--card-bg)_92%,rgb(82_82_82))_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] hover:[--capsule-fill:rgba(82,82,82,0.08)] [&:has(.chip-actions):hover::after]:opacity-100"

function resolveClassName(className: OverflowContainerClassName | undefined, expanded: boolean) {
  return typeof className === 'function' ? className({ expanded }) : className
}

function shareChromeGroup(a: DashboardChipData, b: DashboardChipData | undefined): boolean {
  const aGroup = a.sameTitlePageChipPlan ? a.sameTitlePageChipPlan.view.chromeGroupId : a.chromeGroupId
  const bGroup = b?.sameTitlePageChipPlan ? b.sameTitlePageChipPlan.view.chromeGroupId : b?.chromeGroupId
  return !!b && a.isGrouped && b.isGrouped && !a.iconOnly && !b.iconOnly &&
    aGroup != null && aGroup !== -1 && aGroup === bGroup
}

function chipMatchesActiveHover(chip: DashboardChipData, state: HoverState): boolean {
  const sameTitleMatch = chip.sameTitlePageChipPlan
    ? resolveSameTitlePageChip(chip.sameTitlePageChipPlan, {
        kind: 'hover-match',
        matchUrls: state.urls,
        url: state.url,
      })
    : null
  return (
    pageTargetMatchesHover(chip, state.url, state.urls, state.tabIds) ||
    sameTitleMatch?.kind === 'hover-match' && sameTitleMatch.rowMatches.some(Boolean) ||
    !!chip.envs?.some((env) => (
      pageTargetMatchesHover(env, state.url, state.urls, state.tabIds)
    ))
  )
}

export function pageChipRenderKey(
  chip: Pick<DashboardChipData, 'rawUrl' | 'renderKey' | 'pagePinId'>,
): string {
  return chip.renderKey ?? chip.pagePinId ?? `url:${chip.rawUrl}`
}

export function usePageChipOverflow({
  visibleChips,
  hiddenChips,
  hiddenCount,
  filter = '',
  suppressedTitleToneByText,
  overflowContainerClassName,
  overflowButtonClassName,
}: PageChipOverflowOptions): { expanded: boolean, pageChips: ReactNode } {
  const [expansionPhase, setExpansionPhase] = useState<'collapsed' | 'fading' | 'expanded'>('collapsed')
  const layoutScope = `page-chip:${useId()}`
  const expanded = expansionPhase === 'expanded'
  const { activeSuppressedTitle } = useDomainCardContext()
  const hiddenHoverMatched = useHoverStateSelector((state) => (
    !!state.source &&
    state.source !== 'chip' &&
    !!state.url &&
    hiddenChips.some((chip) => chipMatchesActiveHover(chip, state))
  ))
  const { onLayoutChange } = useDashboardActions()
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const hiddenSuppressionMatchCount = countHiddenSuppressedTitleMatches(hiddenChips, activeSuppressedTitle)
  const hiddenSuppressionCoversAll = hiddenSuppressionMatchCount > 0 && hiddenSuppressionMatchCount === hiddenCount

  function finishExpansion() {
    setExpansionPhase('expanded')
  }

  function onExpand() {
    if (expansionPhase !== 'collapsed') return
    setExpansionPhase('fading')
  }

  function onExpanderTransitionEnd(e: TransitionEvent<HTMLButtonElement>) {
    if (e.target !== e.currentTarget || e.propertyName !== 'opacity') return
    finishExpansion()
  }

  useEffect(() => {
    if (expansionPhase !== 'fading') return
    const fallback = window.setTimeout(() => {
      setExpansionPhase('expanded')
    }, 140)
    return () => window.clearTimeout(fallback)
  }, [expansionPhase])

  useLayoutEffect(() => {
    if (expansionPhase !== 'expanded') return
    onLayoutChange?.()
  }, [expansionPhase, onLayoutChange])

  const displayedChips = expanded ? [...visibleChips, ...hiddenChips] : visibleChips

  function renderChip(chip: DashboardChipData, index: number) {
    return (
      <PageChip
        key={pageChipRenderKey(chip)}
        chip={chip}
        filter={filter}
        layoutScope={layoutScope}
        groupContinuesAbove={shareChromeGroup(chip, displayedChips[index - 1])}
        groupContinuesBelow={shareChromeGroup(chip, displayedChips[index + 1])}
        suppressedTitleToneByText={suppressedTitleToneByText}
      />
    )
  }

  const pageChips = (
    <>
      {visibleChips.map(renderChip)}
      {hiddenCount > 0 && (
        <div
          // `display: contents` visually continues the Page Chip run, but the
          // wrapper still breaks the slots' adjacent-sibling seam selector.
          // Pull its first full-width child up by the same 1px so the reveal
          // boundary paints one shared trim line too.
          className={cn('page-chips-overflow page-chips-overflow-reveal [&>.chip-slot-row:first-child]:-mt-px', resolveClassName(overflowContainerClassName, expanded), expanded ? 'contents' : 'hidden')}
        >
          {expansionPhase !== 'collapsed' && hiddenChips.map((chip, index) => renderChip(chip, visibleChips.length + index))}
        </div>
      )}
      {expansionPhase !== 'expanded' && hiddenCount > 0 && (
        <button
          type="button"
          data-tabout-part="overflow-expander"
          ref={attachCapsuleBorder}
          className={cn(
            OVERFLOW_BUTTON_CLASS_NAME,
            expansionPhase === 'fading' && 'pointer-events-none opacity-0',
            hiddenHoverMatched && 'page-chip-overflow-hover-match outline-1 outline-offset-1 outline-(--accent-amber)',
            hiddenSuppressionCoversAll && cn('page-chip-overflow-suppression-highlighted', titleSuppressionOverflowHighlightClass(activeSuppressionTone)),
            overflowButtonClassName,
          )}
          onClick={onExpand}
          onTransitionEnd={onExpanderTransitionEnd}
        >
          <span className="chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal text-[13px] max-h-[calc(2lh)] [hyphenate-character:'']">+{hiddenCount} more</span>
          {hiddenSuppressionMatchCount > 0 && (
            <span className={cn('page-chip-overflow-suppression-badge relative z-2 inline-flex h-4 min-w-4 items-center justify-center rounded-lg border border-transparent px-1 text-xs leading-none font-semibold text-foreground [corner-shape:squircle]', titleSuppressionBadgeClass(activeSuppressionTone))}>
              {TITLE_SUPPRESSION_MARKER_SYMBOL}{hiddenSuppressionMatchCount}
            </span>
          )}
        </button>
      )}
    </>
  )

  return { expanded, pageChips }
}
