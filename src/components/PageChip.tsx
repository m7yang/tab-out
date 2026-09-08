import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, RefObject } from 'react'
import { X } from 'lucide-react'
import { isClosedSavedDashboardTab, isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'
import { groupCloseActionLabel, pageChipTargetActionPolicy } from '../extension/page-chip-target-policy.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../extension/page-target.js'
import { activateRetainedPageTarget, removeRetainedPageTarget } from '../extension/retained-page-actions.js'
import { activateSavedPageTarget } from '../extension/saved-page-activation.js'
import { savePageTarget, removeSavedPageTarget } from '../extension/saved-page-actions.js'
import { focusExistingTabTargetResult, tabFocusResultToastMessage } from '../extension/tab-focus.js'
import { chipActivationMode, performDashboardItemActivation, shouldSuppressSelectionForGesture } from '../extension/tab-activation.js'
import type { ChipActivationModifiers } from '../extension/tab-activation.js'
import { filterResultCandidateForTarget } from '../extension/filter-result-navigation.js'
import { resolveSameTitlePageChip } from '../extension/same-title-page-chip-plan.js'
import type { SameTitlePageChipRemovalDecision } from '../extension/same-title-page-chip-plan.js'
import { focusExactTabOrOpenResult } from '../extension/tabs.js'
import { closeChipTarget, deleteHistoryUrls, duplicateTabTarget, reloadTabTarget, setChipTargetMuted, suspendChipTarget } from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'
import { nextMutedForAudioState } from '../extension/tab-audio.js'
import { DefaultFavicon } from './DefaultFavicon'
import { FaviconImage } from './FaviconImage'
import { useDomainCardContext } from './DomainCardContext'
import { useDashboardActions, useHoverStateSelector, type HoverState } from './DashboardInteractionContext'
import { startPageChipCloseAnimation } from './PageChipCloseAnimation'
import { capturePageChipFocusRecovery, type PageChipFocusRecovery } from './PageChipFocusRecovery'
import { TooltipAnchor } from './ui/tooltip'
import { PageChipContextMenu } from './PageChipContextMenu'
import { isOutsidePressInsideElement } from './context-menu-outside-press'
import type { ContextMenuChangeEventDetails } from './context-menu-outside-press'
import { SavedPageIcon } from './SavedPageIcon'
import { TabAudioButton } from './TabAudioButton'
import { TabLoadingIndicator } from './TabLoadingIndicator'
import { ProgressiveFoldedEnvList } from './ProgressiveFoldedEnvList'
import { cn } from '@/lib/utils'
import { omitUndefined } from '@/lib/omit-undefined'
import type { CSSVariableProperties } from '@/lib/css-properties'
import { createBionicTitleTextRenderer, isUrlLikeTitle } from './bionic-title-text'
import { highlightTermsForFilter, highlightedTextNodes } from './filter-highlight-text'
import { titleSuppressionChipHighlightClass, titleSuppressionMarkerClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import { clampedTitleLineNodes, createTitleExpansionLane, expansionLineNodesFromHtml, syncClampedTitleFadeEnd, useTitleExpansionController } from './title-expansion'
import { chipTrim, CHIP_TRIM_TOKENS } from './chip-trim'
import { FAVICON_DIM_CLASS_NAME, VARIANT_LABEL_DIM_CLASS_NAME } from './liveness-dim'
import type { DashboardChipData } from './types'
import type { DashboardChipEnv, DashboardSegment, SameTitlePageChipPlan, SameTitlePageChipRowView } from '../extension/types'
import { foldedTabCloseTargets, historyDeleteFullyRemoved } from './chip-close-targets.js'
import { chipCanShowSuspend, chipSuspendableTargetCount } from './chip-suspend-targets.js'
import { registerPageChipTextLayoutValidation, type PageChipTextLayoutMeasurementJob } from './page-chip-layout-validation.js'
import { applyChipTextLayout, chipExpansionGeometryEqual, chipExpansionLineMarkup, chipSlotSizeEqual, chipTextHasExpandableContent, chipTextLayoutEqual, chipTextMeasuredSizes, chipTextMetricsEqual, chipTextTruncationCallbacks, clampForKey, decidePackedRevalidation, getChipTextMasonryCardWidth, getChipTextMetrics, getChipTextResizeObserver, getChipTextWidth, getPageChipExpansionGeometry, measureChipTextLayout, packedWidthWithinTolerance, readChipTextLayout, roundedElementSize, waitsForInitialMasonryWidth, DEFAULT_CHIP_EXPANSION_GEOMETRY, DEFAULT_CHIP_SLOT_SIZE, DEFAULT_CHIP_TEXT_LAYOUT_STATE, PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME, PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME, type ChipTextMeasurement } from './page-chip-text-layout'
import { subscribeFontMetricsInvalidation } from './font-metrics-invalidation.js'

const PAGE_CHIP_TARGET_INTERACTION_BG = 'color-mix(in oklab, var(--color-neutral-600) 14%, transparent)'
const DESTRUCTIVE_ICON_ACTION_CLASS_NAME = 'hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'

interface PageChipProps {
  chip: DashboardChipData
  filter?: string | undefined
  layoutScope?: string | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
}

function chipMatchesHoverState(target: DashboardChipData, state: HoverState): boolean {
  return (
    pageTargetMatchesHover(target, state.url, state.urls) ||
    !!target.envs?.some((env) => pageTargetMatchesHover(env, state.url, state.urls))
  )
}

function pageChipHoverMatchKey(
  state: HoverState,
  chip: DashboardChipData,
  sameTitlePageChipPlan: SameTitlePageChipPlan | undefined,
): string {
  if (!state.url || !state.source || state.source === 'chip') return ''
  const hoverDecision = sameTitlePageChipPlan
    ? resolveSameTitlePageChip(sameTitlePageChipPlan, {
        kind: 'hover-match',
        matchUrls: state.urls,
        url: state.url,
      })
    : null
  const matches = [
    chipMatchesHoverState(chip, state),
    ...(hoverDecision?.kind === 'hover-match' ? hoverDecision.rowMatches : []),
  ]
  return matches.some(Boolean) ? matches.map((matched) => matched ? '1' : '0').join('') : ''
}

type ChipTextRenderMode = 'chip' | 'tooltip'
type RenderTitleContentOptions = {
  includePathSuffix?: boolean
}
type StopPropagationEvent = {
  stopPropagation: () => void
}

const pageChipExpansionLane = createTitleExpansionLane()

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
}

function titleTextForChip(target: Pick<DashboardChipData, 'title' | 'tooltip' | 'tabUrl'>): string {
  return (target.title || target.tooltip || target.tabUrl).trim()
}

function titleTextForEnv(env: DashboardChipEnv, parent: Pick<DashboardChipData, 'title' | 'tooltip'>): string {
  return (env.title || parent.title || parent.tooltip || env.tabUrl).trim()
}

function isTitleSuppressionSegment(segment: DashboardSegment): segment is { titleSuppression: string } {
  return typeof segment !== 'string' && 'titleSuppression' in segment
}

function isStructuralPlaceholderSegment(segment: DashboardSegment): segment is { placeholder: true, label?: string } {
  return typeof segment !== 'string' && 'placeholder' in segment
}

type ChipFaviconFrameProps = {
  chip: DashboardChipData
  dupeCount: number
  showDefaultFavicon: boolean
  showFaviconCloseAction: boolean
  dedupeBadgesClosing: boolean
  closeActionLabel: string
  closeActionDestructive: boolean
  onCloseAction: (e: MouseEvent<HTMLButtonElement>) => void
  onToggleAudio: () => void
}

/**
 * ChipFaviconFrame — the chip's favicon cell: dupe-stack layers, the favicon
 * (or default), the page-pin badge, the hover-revealed close action, and the
 * icon-only audio toggle. The favicon image dims when no live tab backs the
 * chip — the image itself, not the frame, so dupe-stack rings and badges
 * keep their weight.
 */
function ChipFaviconFrame({ chip, dupeCount, showDefaultFavicon, showFaviconCloseAction, dedupeBadgesClosing, closeActionLabel, closeActionDestructive, onCloseAction, onToggleAudio }: ChipFaviconFrameProps) {
  const faviconDimmed = !!chip.suspended || isClosedSavedDashboardTab(chip)
  return (
    <span
      className={cn(
        'chip-favicon-frame group/favicon-frame relative grid size-4 shrink-0 place-items-center',
        chip.iconOnly ? 'self-center' : 'self-start',
        !chip.isApp && 'min-h-4 min-w-4 max-h-4 max-w-4',
        // Titled app chips ring their favicon with the same 20px ring as
        // history app rows, CENTERED on the plain favicon's 16px slot: the
        // symmetric negative margins keep a 16px layout footprint (title x
        // and chip height unchanged) while the ring overflows 2px on every
        // side, so its center-line sits on the same axis as plain favicons.
        chip.isApp && !chip.iconOnly && 'size-5 -mx-0.5 -my-0.5',
        !chip.iconOnly && dupeCount > 1 && 'chip-favicon-stack',
        chip.isApp && 'is-app',
        showFaviconCloseAction && 'pointer-events-none',
      )}
    >
      {!chip.iconOnly && dupeCount > 2 && (
        <span
          className={cn(
            'chip-favicon-stack-layer pointer-events-none absolute top-0 left-0 z-0 size-4 max-h-4 max-w-4 translate-x-1 translate-y-1 rounded-sm bg-(--card-bg) ring-1 ring-neutral-300/45 shadow-[0_1px_2px_rgba(10,10,10,0.12)] [corner-shape:squircle] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
            dedupeBadgesClosing && 'closing',
          )}
          aria-hidden="true"
        />
      )}
      {!chip.iconOnly && dupeCount > 1 && (
        <span
          className={cn(
            'chip-favicon-stack-layer pointer-events-none absolute top-0 left-0 z-1 size-4 max-h-4 max-w-4 translate-x-0.5 translate-y-0.5 rounded-sm bg-(--card-bg) ring-1 ring-neutral-300/55 shadow-[0_1px_2px_rgba(10,10,10,0.1)] [corner-shape:squircle] [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
            dedupeBadgesClosing && 'closing',
          )}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          'chip-favicon-content relative z-2 grid size-4 place-items-center',
          chip.isApp && !chip.iconOnly && 'chip-app-favicon-ring h-full w-full place-content-center overflow-hidden rounded-lg border border-[rgba(115,115,115,0.32)] p-0.5 [corner-shape:squircle]',
          !chip.iconOnly && dupeCount > 1 && 'rounded-sm bg-(--card-bg) ring-1 ring-neutral-300/45 shadow-[0_1px_2px_rgba(10,10,10,0.08)] [corner-shape:squircle]',
          showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
        )}
        aria-hidden="true"
      >
        {chip.loading ? (
          <TabLoadingIndicator />
        ) : chip.faviconUrl ? (
          <FaviconImage className={cn('chip-favicon block h-full w-full rounded-none object-cover', faviconDimmed && FAVICON_DIM_CLASS_NAME)} src={chip.faviconUrl} alt="" />
        ) : showDefaultFavicon ? (
          <DefaultFavicon className={faviconDimmed ? FAVICON_DIM_CLASS_NAME : ''} />
        ) : null}
      </span>
      {!chip.iconOnly && chip.pagePinned && (
        <span
          data-tabout-part="page-pin"
          data-pinned="true"
          className={cn(
            'chip-page-pin-badge pointer-events-none absolute -top-1.5 -right-1.5 z-3 inline-flex size-3.5 items-center justify-center rounded-full border border-tab-card bg-(--card-bg) text-muted-foreground opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.16)] data-[pinned=true]:opacity-100',
            showFaviconCloseAction && 'group-hover/favicon-frame:opacity-0',
          )}
          aria-hidden="true"
        >
          <span className="icon-[lucide--pin] size-2.5" aria-hidden="true" />
        </span>
      )}
      {showFaviconCloseAction && (
        <span
          data-tabout-part="close-hit-owner"
          className="chip-close-hit-owner pointer-events-auto absolute top-1/2 left-1/2 z-3 size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full"
          aria-hidden="true"
        />
      )}
      {showFaviconCloseAction && (
        <button
          type="button"
          data-tabout-part="close-button"
          className={cn(
            'chip-action chip-close chip-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-4 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 group-hover/favicon-frame:pointer-events-auto group-hover/favicon-frame:opacity-100 hover:bg-neutral-600/10 hover:text-foreground hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-(--card-bg) focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
            closeActionDestructive && DESTRUCTIVE_ICON_ACTION_CLASS_NAME,
          )}
          aria-label={closeActionLabel}
          onClick={onCloseAction}
        >
          <X className="size-3.75" strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
      {chip.iconOnly && chip.audioState && (
        <TabAudioButton
          state={chip.audioState}
          onToggle={onToggleAudio}
          className="absolute right-0 bottom-0 z-4 size-3.5 rounded-full bg-(--card-bg) shadow-[0_1px_2px_rgba(10,10,10,0.16)] [corner-shape:squircle]"
        />
      )}
    </span>
  )
}

function usePageChipElement({ chip, filter = '', layoutScope = '', suppressedTitleToneByText }: PageChipProps) {
  const { activeSuppressedTitle, dedupeBadgesClosing, highlightTerms: cardHighlightTerms } = useDomainCardContext()
  const { onHoverUrlChange, onLayoutChange, onTogglePinnedPageChip } = useDashboardActions()
  const envs = Array.isArray(chip.envs) ? chip.envs : []
  const isFolded = envs.length > 0
  const foldedCloseTargets = foldedTabCloseTargets(envs)
  const sameTitlePageChipPlan = chip.sameTitlePageChipPlan
  const sameTitlePageChipView = sameTitlePageChipPlan?.view
  const sameTitleRows = sameTitlePageChipView?.rows ?? []
  const hoverMatchKey = useHoverStateSelector((state) => pageChipHoverMatchKey(state, chip, sameTitlePageChipPlan))
  const isTitleVariantGroup = !!sameTitlePageChipPlan
  const chipFilterResultCandidate = filterResultCandidateForTarget(chip)
  const chipLayoutKey = chip.pagePinId || chip.rawUrl
  const progressiveFoldedEnvResetKey = JSON.stringify([
    chip.sourceType,
    chipLayoutKey,
    filter,
  ])
  const variantCloseCount = (sameTitlePageChipView?.groupRemoval?.historyCount ?? 0) +
    (sameTitlePageChipView?.groupRemoval?.tabCount ?? 0)
  const parentInteractive = !isFolded && !isTitleVariantGroup
  const hasFilter = filter.trim().length > 0
  const isHistorySource = chip.sourceType === 'history'
  const isClosedSavedPage = isClosedSavedDashboardTab(chip)
  const highlightTerms = cardHighlightTerms ?? highlightTermsForFilter(filter)
  const isReadOnlySource = isReadOnlyDashboardSourceType(chip.sourceType)
  const readOnlyFilterResult = hasFilter && isReadOnlySource
  const primaryPreviewUrl = pageTargetUrl(chip)
  const suppressedTitleParts = chip.suppressedTitleParts || []
  const activeSuppressedTitleKey = activeSuppressedTitle.trim().toLowerCase()
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const suppressionHighlighted = activeSuppressedTitleKey !== '' && suppressedTitleParts.some((part) => part.toLowerCase() === activeSuppressedTitleKey)
  const chipTextClampEligible = !chip.iconOnly && !isFolded && !isTitleVariantGroup
  const chipTextClampKey = JSON.stringify([
    chip.displaySegments,
    chip.leadPrefix ?? '',
    chip.pathGroupLabel ?? '',
    chip.pathSuffix ?? '',
    suppressedTitleParts,
    highlightTerms,
    sameTitleRows.map((row) => [row.id, row.label, row.duplicateCount, row.exactTargetCount]),
  ])
  const chipExpansionId = useId()
  const chipSlotRef = useRef<HTMLDivElement | null>(null)
  const chipTextRef = useRef<HTMLSpanElement | null>(null)
  const updateChipTextMeasurementsRef = useRef<(textEl: HTMLElement | null) => void>(() => {})
  const chipTextMeasurementRef = useRef<ChipTextMeasurement | null>(null)
  const contextMenuOpenRef = useRef(false)
  const chipMenuHoldRef = useRef<(() => void) | null>(null)
  const envMenuHoldRef = useRef<(() => void) | null>(null)
  const variantMenuHoldRef = useRef<(() => void) | null>(null)
  const chipFocusHoldRef = useRef<(() => void) | null>(null)
  const contextMenuFocusRecoveryRef = useRef<PageChipFocusRecovery | null>(null)
  const chipExpandedRef = useRef(false)
  const [chipTooltipOpen, setChipTooltipOpen] = useState(false)
  const [chipExpanded, setChipExpandedState] = useState(false)
  const [chipSlotSize, setChipSlotSize] = useState(DEFAULT_CHIP_SLOT_SIZE)
  const [chipExpansionGeometry, setChipExpansionGeometry] = useState(DEFAULT_CHIP_EXPANSION_GEOMETRY)
  const [chipTextLayout, setChipTextLayout] = useState(DEFAULT_CHIP_TEXT_LAYOUT_STATE)
  const chipTextMetrics = chipTextLayout.metrics
  const chipTextClamp = clampForKey(chipTextLayout, chipTextClampKey)
  const { hasExpandableContent } = chipTextMetrics

  useEffect(() => () => {
    contextMenuFocusRecoveryRef.current?.cancel()
  }, [])

  const setChipExpanded = useCallback((nextExpanded: boolean) => {
    chipExpandedRef.current = nextExpanded
    setChipExpandedState(nextExpanded)
  }, [])

  // Page Chips close synchronously on pointer exit; the controller's
  // ownership holds keep the expansion open past that. Each of the chip's
  // menus (chip, env pill, title variant) holds 'context-menu' through its
  // own ref so overlapping menus refcount instead of fighting one boolean,
  // and root keyboard focus holds 'keyboard-focus' so pointer departure
  // cannot collapse a focused chip. contextMenuOpenRef stays for the
  // URL-preview retention guards only.
  const chipExpansionController = useTitleExpansionController({
    id: chipExpansionId,
    lane: pageChipExpansionLane,
    closeDelayMs: 0,
    onExpandedChange: setChipExpanded,
  })

  function updateMenuExpansionHold(holdRef: RefObject<(() => void) | null>, open: boolean) {
    contextMenuOpenRef.current = open
    holdRef.current?.()
    holdRef.current = open ? chipExpansionController.hold('context-menu') : null
  }

  const updateChipTextMeasurements = useCallback((textEl: HTMLElement | null) => {
    const nextMetrics = getChipTextMetrics(textEl)
    setChipTextLayout((current) => (
      chipTextMetricsEqual(current.metrics, nextMetrics)
        ? current
        : { ...current, metrics: nextMetrics }
    ))
  }, [])

  const updateChipSlotMeasurements = useCallback((chipElArg?: HTMLElement | null) => {
    const chipEl = chipElArg !== undefined ? chipElArg : chipSlotRef.current?.querySelector<HTMLElement>('.page-chip') || null
    const nextSize = roundedElementSize(chipEl)
    const textEl = chipTextRef.current?.querySelector<HTMLElement>('.chip-title-row') || chipTextRef.current
    const nextGeometry = getPageChipExpansionGeometry(chipEl, textEl)
    setChipSlotSize((current) => chipSlotSizeEqual(current, nextSize) ? current : nextSize)
    setChipExpansionGeometry((current) => chipExpansionGeometryEqual(current, nextGeometry) ? current : nextGeometry)
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- callback reads only stable refs; eslint-plugin-react-hooks (the enforced gate) exempts refs.
  }, [])

  useEffect(() => {
    updateChipTextMeasurementsRef.current = updateChipTextMeasurements
  }, [updateChipTextMeasurements])

  // Truncated chips swap to captured-line rows so the tail fills to the box
  // edge under the fade (see the matching history-title clamp effect for the
  // invalidate-then-recapture contract). The capture keeps marker elements
  // raw and the row renderer revives suppression pills as live React nodes,
  // so their glyph and hover tone survive the swap. Folded and variant-group
  // chips never clamp (their layouts are unclamped by design), and their
  // render branches ignore any clamp a prior eligible shape left behind.
  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl || chipExpandedRef.current) return

    if (chipTextClamp) {
      textEl.classList.add('chip-text-truncated')
      syncClampedTitleFadeEnd(textEl, chipTextClamp.width)
      return
    }

    const previousMeasurement = chipTextMeasurementRef.current
    if (
      previousMeasurement?.element === textEl &&
      previousMeasurement.key === chipTextClampKey &&
      previousMeasurement.clampEligible === chipTextClampEligible &&
      chipTextMetricsEqual(previousMeasurement.metrics, chipTextMetrics)
    ) {
      return
    }

    // The parent masonry layout assigns the card's final inline width later in
    // this same layout-effect phase. Measuring its unconstrained grid width here
    // would be discarded immediately by the post-pack validation below.
    if (waitsForInitialMasonryWidth(textEl)) return

    const nextLayout = measureChipTextLayout(textEl, chipTextClampEligible, chipTextClampKey)
    chipTextMeasurementRef.current = {
      clampEligible: chipTextClampEligible,
      element: textEl,
      key: chipTextClampKey,
      masonryCardWidth: getChipTextMasonryCardWidth(textEl),
      metrics: nextLayout.metrics,
    }
    setChipTextLayout((current) => chipTextLayoutEqual(current, nextLayout) ? current : nextLayout)
    // Resize-observer metrics carry width changes back through chipTextMetrics,
    // which invalidates the captured rows without re-reading unchanged titles.
  }, [chipExpanded, chipTextClamp, chipTextClampEligible, chipTextClampKey, chipTextMetrics])

  // The parent masonry pass owns the card's final width. Its pre-paint callback
  // measures initially deferred titles once, while later packs remeasure only
  // titles whose live width actually changed.
  useLayoutEffect(() => {
    const textEl = chipTextRef.current
    if (!textEl) return

    const createPackedLayoutMeasurement = (): PageChipTextLayoutMeasurementJob => ({
      read() {
        const masonryCardWidth = getChipTextMasonryCardWidth(textEl)
        const reading = readChipTextLayout(textEl, chipTextClampEligible, chipTextClampKey)
        return () => {
          if (chipTextRef.current !== textEl || chipExpandedRef.current) return
          const nextLayout = applyChipTextLayout(textEl, reading)
          chipTextMeasurementRef.current = {
            clampEligible: chipTextClampEligible,
            element: textEl,
            key: chipTextClampKey,
            masonryCardWidth,
            metrics: nextLayout.metrics,
          }
          setChipTextLayout((current) => chipTextLayoutEqual(current, nextLayout) ? current : nextLayout)
        }
      },
    })
    const validatePackedWidth = (): PageChipTextLayoutMeasurementJob | null => {
      if (chipTextRef.current !== textEl || chipExpandedRef.current) return null
      const previousMeasurement = chipTextMeasurementRef.current
      const decision = decidePackedRevalidation({
        clampEligible: chipTextClampEligible,
        key: chipTextClampKey,
        masonryCardWidth: getChipTextMasonryCardWidth(textEl),
        previous: previousMeasurement?.element === textEl ? previousMeasurement : null,
      })
      if (decision === 'skip') return null
      if (decision === 'remeasure') return createPackedLayoutMeasurement()
      const width = getChipTextWidth(textEl)
      if (previousMeasurement && packedWidthWithinTolerance(previousMeasurement.metrics.width, width)) {
        return null
      }
      return createPackedLayoutMeasurement()
    }
    return registerPageChipTextLayoutValidation(textEl, validatePackedWidth)
  }, [chipTextClampEligible, chipTextClampKey])

  // Folded and title-variant text can still remount when shouldExpandChip flips,
  // so a mount-once registration would keep observing the dead element and
  // resize-driven metric updates would stop. Re-register against the current
  // element on every render instead.
  const observedChipTextElRef = useRef<HTMLElement | null>(null)
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the observer stays attached across renders by design; the unmount-only effect below unobserves the current element.
  useEffect(() => {
    const textEl = chipTextRef.current
    const previous = observedChipTextElRef.current
    if (previous === textEl) return

    const observer = getChipTextResizeObserver()
    if (previous) {
      observer.unobserve(previous)
      chipTextTruncationCallbacks.delete(previous)
    }
    observedChipTextElRef.current = textEl
    if (!textEl) return

    chipTextTruncationCallbacks.set(textEl, ({ hasExpandableContent, isTruncated, titleVariantLabelTruncationKey, width }) => {
      setChipTextLayout((current) => {
        const nextMetrics = { hasExpandableContent, isTruncated, titleVariantLabelTruncationKey, width }
        return chipTextMetricsEqual(current.metrics, nextMetrics)
          ? current
          : { ...current, metrics: nextMetrics }
      })
    })
    observer.observe(textEl, chipTextMeasuredSizes.get(textEl))
  })

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- the cleanup reads observedChipTextElRef at unmount time deliberately: it must unobserve whichever element is registered THEN, not the mount-time one.
  useEffect(() => {
    let disposed = false
    const onFontsDone = () => {
      if (disposed) return
      chipTextMeasurementRef.current = null
      setChipTextLayout((current) => current.clamp ? { ...current, clamp: null } : current)
      updateChipTextMeasurementsRef.current(chipTextRef.current)
    }
    const unsubscribeFontMetrics = subscribeFontMetricsInvalidation(onFontsDone)

    return () => {
      disposed = true
      unsubscribeFontMetrics()
      const observed = observedChipTextElRef.current
      if (observed) {
        getChipTextResizeObserver().unobserve(observed)
        chipTextTruncationCallbacks.delete(observed)
        observedChipTextElRef.current = null
      }
    }
  }, [])

  function isKeyboardActivation(e: KeyboardEvent<HTMLElement>) {
    return e.key === 'Enter' || e.key === ' '
  }

  async function focusChipUrl(
    targetUrl: string | undefined,
    target?: { rawUrl?: string, tabId?: number | string },
  ) {
    if (!targetUrl) return
    if (typeof target?.tabId === 'number') {
      // A rendered numeric id represents one physical tab. Every result other
      // than focused is still terminal here: widening a stale/failed exact
      // target to another URL on the same host can activate the wrong chip.
      const result = await focusExistingTabTargetResult(omitUndefined({
        tabId: target.tabId,
        url: targetUrl,
        rawUrl: target.rawUrl,
      }))
      const message = tabFocusResultToastMessage(result.status)
      if (message) showToast(message)
      return
    }
    // Synthetic/read-only/closed-saved chips have no physical id. Their URL
    // fallback is exact and opens only after a confirmed no-match read.
    const result = await focusExactTabOrOpenResult(targetUrl)
    if (result.status === 'opened') return
    if (result.status === 'open-failed') {
      showToast('Could not open page')
      return
    }
    const message = tabFocusResultToastMessage(result.status)
    if (message) showToast(message)
  }

  async function activateChipTarget(
    e: ChipActivationModifiers | undefined,
    targetUrl: string | undefined,
    sourceType: DashboardChipData['sourceType'],
    target?: {
      rawUrl?: string
      tabId?: number | string
      isApp?: boolean
      retainedPageIdentity?: string
      retainedPageClosureToken?: string
    },
    focusOrigin?: EventTarget | null,
  ) {
    if (!targetUrl && sourceType !== 'retained-page') return
    await setPreview('')
    const mode = chipActivationMode(e)
    if (sourceType === 'retained-page') {
      const focusRecovery = capturePageChipFocusRecovery(focusOrigin)
      const targetDisappears = await activateRetainedPageTarget(target || {}, mode)
      focusRecovery?.complete(targetDisappears)
      return
    }
    if (sourceType === 'saved-page') {
      await activateSavedPageTarget({ tabUrl: targetUrl || '', isApp: !!target?.isApp }, mode)
      return
    }
    if (!targetUrl) return
    const activationResult = await performDashboardItemActivation(mode, omitUndefined({
      tabUrl: targetUrl,
      tabId: target?.tabId,
      rawUrl: target?.rawUrl,
    }))
    if (activationResult === 'unhandled') await focusChipUrl(targetUrl, target)
  }

  function previewDefaultTitleVariant() {
    previewTitleVariant()
  }

  function titleVariantEventTargetsExactVariant(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('.chip-title-variant, .chip-title-variant-actions, .chip-title-variant-action')
  }

  function titleVariantEventTargetsDefaultSurfaceBlocker(target: EventTarget | null) {
    if (!(target instanceof Element)) return false
    if (titleVariantEventTargetsExactVariant(target)) return true
    if (target.closest('[data-tabout-part="audio-toggle"]')) return true
    const faviconFrame = target.closest('.chip-favicon-frame')
    return !!faviconFrame?.querySelector('.chip-close-favicon')
  }

  function setDefaultVariantSurfaceHover(active: boolean) {
    chipSlotRef.current?.toggleAttribute('data-tabout-default-surface-hover', active)
  }

  function previewDefaultTitleVariantSurface(target: EventTarget | null) {
    if (titleVariantEventTargetsDefaultSurfaceBlocker(target)) {
      setDefaultVariantSurfaceHover(false)
      return false
    }
    setDefaultVariantSurfaceHover(true)
    previewDefaultTitleVariant()
    return true
  }

  async function onFocus(e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    if (isFolded) return
    await activateChipTarget(e, chip.tabUrl, chip.sourceType, chip, e?.currentTarget)
  }

  async function onPageChipTooltipClick(e: MouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (!parentInteractive) return
    await onFocus(e)
  }

  async function onChipKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    await onFocus(e)
  }

  function onChipPointerDown(e: MouseEvent<HTMLDivElement>) {
    // Shift-click moves the tab into a new window; ⌘-click moves it into this window.
    // Cancel the browser's native text selection for those gestures only so the chip behaves
    // like a link (a plain click still drag-selects). See tab-activation.ts.
    if (shouldSuppressSelectionForGesture(e)) e.preventDefault()
  }

  // The whole grouped-chip surface is the default-variant target: clicks on
  // the exact pills, their action rails, the favicon close, and the audio
  // toggle never reach these handlers (each stops propagation), so only
  // title/blank-surface clicks activate the default variant.
  async function onVariantGroupChipClick(e: MouseEvent<HTMLDivElement>) {
    if (titleVariantEventTargetsExactVariant(e.target)) return
    if (!sameTitlePageChipPlan) return
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, { kind: 'activate' })
    if (decision.kind !== 'activate') return
    const { target } = decision
    await activateChipTarget(e, target.tabUrl, target.sourceType, target, e.currentTarget)
  }

  function onVariantGroupChipMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (shouldSuppressSelectionForGesture(e)) e.preventDefault()
  }

  function onVariantGroupChipMouseEnter(e: MouseEvent<HTMLDivElement>) {
    if (!previewDefaultTitleVariantSurface(e.target)) return
    openChipExpansion()
  }

  function onVariantGroupChipMouseMove(e: MouseEvent<HTMLDivElement>) {
    if (!previewDefaultTitleVariantSurface(e.target)) return
    if (chipExpandedRef.current) return
    openChipExpansion()
  }

  function onVariantGroupChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  async function onEnvClick(e: MouseEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    e.stopPropagation()
    await activateChipTarget(e, env.tabUrl, env.sourceType || chip.sourceType, env, e.currentTarget)
  }

  async function onEnvKeyDown(e: KeyboardEvent<HTMLButtonElement>, env: DashboardChipEnv) {
    if (!isKeyboardActivation(e)) return
    e.preventDefault()
    e.stopPropagation()
    await activateChipTarget(e, env.tabUrl, env.sourceType || chip.sourceType, env, e.currentTarget)
  }

  function setPreview(url: string, matchUrls: readonly string[] = [url], target?: Pick<DashboardChipData, 'tabId'>) {
    const tabId = typeof target?.tabId === 'number' ? target.tabId : undefined
    return onHoverUrlChange?.(url || '', 'chip', matchUrls, tabId)
  }

  function previewUrlsForChip(target: DashboardChipData): string[] {
    return pageTargetMatchUrls(target)
  }

  function previewTitleVariant(rowId?: string) {
    if (!sameTitlePageChipPlan) return
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, omitUndefined({
      kind: 'preview',
      rowId,
    }))
    if (decision.kind !== 'preview') return
    setPreview(decision.url, decision.matchUrls, decision)
  }

  function captureContextMenuFocusRecovery() {
    contextMenuFocusRecoveryRef.current?.cancel()
    contextMenuFocusRecoveryRef.current = capturePageChipFocusRecovery(
      document.activeElement,
    )
  }

  function onChipContextMenuOpenChange(open: boolean, details: ContextMenuChangeEventDetails) {
    updateMenuExpansionHold(chipMenuHoldRef, open)
    if (open) {
      captureContextMenuFocusRecovery()
      openChipExpansion()
      if (isTitleVariantGroup) {
        previewDefaultTitleVariant()
      } else {
        setPreview(primaryPreviewUrl, previewUrlsForChip(chip), chip)
      }
      return
    }
    const currentChip = chipSlotRef.current?.querySelector<HTMLElement>('.page-chip')
    if (!isOutsidePressInsideElement(details, currentChip)) closeChipExpansion()
    setPreview('')
  }

  function onEnvContextMenuOpenChange(open: boolean, env: DashboardChipEnv) {
    updateMenuExpansionHold(envMenuHoldRef, open)
    if (open) {
      captureContextMenuFocusRecovery()
      setPreview(env.tabUrl, [env.tabUrl, env.rawUrl], env)
      return
    }
    setPreview('')
  }

  function onTitleVariantContextMenuOpenChange(open: boolean, row: SameTitlePageChipRowView) {
    updateMenuExpansionHold(variantMenuHoldRef, open)
    if (open) {
      captureContextMenuFocusRecovery()
      previewTitleVariant(row.id)
      return
    }
    setPreview('')
  }

  function onChipMouseEnter() {
    if (isFolded) return
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip), chip)
  }

  function onChipMouseLeave(e: MouseEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function openChipExpansion() {
    if (chip.iconOnly) return
    const textEl = chipTextRef.current
    const measuredExpandable = hasTitleSuppressionMarkers || hasStructuralPlaceholders || chipTextHasExpandableContent(textEl)
    if (!measuredExpandable) return
    // Expansion geometry is intentionally measured only when the interaction
    // opens it. Measuring every collapsed chip on mount and resize multiplies
    // layout work across the whole dashboard before any expansion is needed.
    // Only measure from the collapsed source DOM. Re-measuring while already
    // expanded feeds the hydrated expanded markers (whose suppressed text is now
    // a real text node) back into getExpandedPageChipLineHtml, which re-captures
    // the marker on two adjacent line ranges and duplicates it.
    if (!chipExpandedRef.current) {
      updateChipTextMeasurements(textEl)
      updateChipSlotMeasurements()
    }
    chipExpansionController.open()
  }

  function closeChipExpansion() {
    chipExpansionController.close({ delayed: false })
  }

  useEffect(() => {
    if (!chipExpanded) return
    const closeNow = () => {
      chipExpansionController.closeNow()
    }
    const closeOnPointerMove = (event: globalThis.PointerEvent) => {
      // Measure the EXPANDED chip, not the original slot: the expanded chip floats
      // wider/taller than its 1:1 slot, so testing the slot rect collapsed the chip
      // the instant the pointer crossed into the revealed overflow — blinking it shut
      // at the border before the revealed content could be reached. The expanded
      // bounding box is the complete pointer region; leaving it closes immediately,
      // vetoed inside the controller while a menu or root keyboard focus holds it.
      const expandedChipEl = chipSlotRef.current?.querySelector<HTMLElement>('.page-chip')
      const rect = expandedChipEl?.getBoundingClientRect() ?? chipSlotRef.current?.getBoundingClientRect()
      if (!rect) return
      const insideExpandedChip =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      if (!insideExpandedChip) chipExpansionController.close({ delayed: false })
    }
    const closeOnVisibilityChange = () => {
      if (document.hidden) closeNow()
    }
    window.addEventListener('blur', closeNow)
    window.addEventListener('pointermove', closeOnPointerMove, true)
    document.addEventListener('visibilitychange', closeOnVisibilityChange)
    return () => {
      window.removeEventListener('blur', closeNow)
      window.removeEventListener('pointermove', closeOnPointerMove, true)
      document.removeEventListener('visibilitychange', closeOnVisibilityChange)
    }
  }, [chipExpanded, chipExpansionController])

  function onChipTextPointerEnter(e: PointerEvent<HTMLSpanElement>) {
    updateChipTextMeasurements(e.currentTarget)
  }

  function onChipTooltipOpenChange(open: boolean) {
    setChipTooltipOpen(open)
  }

  function onChipFocus(e: FocusEvent<HTMLDivElement>) {
    const rootKeyboardFocus = e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')
    if (rootKeyboardFocus && chipFocusHoldRef.current === null) {
      chipFocusHoldRef.current = chipExpansionController.hold('keyboard-focus')
    }
    if (isFolded) return
    if (rootKeyboardFocus) openChipExpansion()
    setPreview(primaryPreviewUrl, previewUrlsForChip(chip), chip)
  }

  function onChipBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      chipFocusHoldRef.current?.()
      chipFocusHoldRef.current = null
    }
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    closeChipExpansion()
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function onChipPointerLeave(e: PointerEvent<HTMLDivElement>) {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    if (chipExpandedRef.current) {
      const rect = e.currentTarget.getBoundingClientRect()
      const insideExpandedBounds =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      // Rounded corners can stop DOM hover while the pointer is still inside
      // the visible expansion bounds. Let the window pointer tracker close it
      // once the pointer genuinely leaves that box.
      if (insideExpandedBounds) return
    }
    closeChipExpansion()
  }

  function onChipPointerEnter() {
    openChipExpansion()
  }

  function isPointerInsideChipSlot(e: PointerEvent<HTMLDivElement>) {
    const slotRect = chipSlotRef.current?.getBoundingClientRect()
    if (!slotRect) return true
    return (
      e.clientX >= slotRect.left &&
      e.clientX <= slotRect.right &&
      e.clientY >= slotRect.top &&
      e.clientY <= slotRect.bottom
    )
  }

  function onChipPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (chipExpandedRef.current) return
    if (!isPointerInsideChipSlot(e)) return
    openChipExpansion()
  }

  function onEnvMouseEnter(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl], env)
  }

  function onEnvMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl, [primaryPreviewUrl], chip)
      return
    }
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  function onEnvFocus(env: DashboardChipEnv) {
    setPreview(env.tabUrl, [env.tabUrl, env.rawUrl], env)
  }

  function onEnvBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (!isFolded && chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      setPreview(primaryPreviewUrl, [primaryPreviewUrl], chip)
      return
    }
    if (contextMenuOpenRef.current) return
    setPreview('')
  }

  async function onClose(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()

    await closeChipTarget(omitUndefined({
      tabUrl: chip.tabUrl,
      tabId: chip.tabId,
      expectedPinned: chip.chromePinned,
      expectedGroupId: chip.chromeGroupId,
      envs: isFolded ? foldedCloseTargets : envs,
      onAfterClose: () => {
        setPreview('')
      },
    }))
  }

  async function onDeleteHistory(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget
    const urls = Array.from(new Set(isFolded ? envs.flatMap((env) => env.tabUrl ? [env.tabUrl] : []) : chip.tabUrl ? [chip.tabUrl] : []))
    if (urls.length === 0) return

    const result = await deleteHistoryUrls({ urls })
    if (historyDeleteFullyRemoved(urls.length, result)) {
      startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
    }
    setPreview('')
  }

  function onToggleChipAudio() {
    if (!chip.audioState) return
    void setChipTargetMuted({
      tabUrl: chip.tabUrl,
      envs: chip.envs,
      muted: nextMutedForAudioState(chip.audioState),
    })
  }

  function onToggleChipSuspend(e: StopPropagationEvent) {
    e.stopPropagation()
    void suspendChipTarget({ tabUrl: chip.tabUrl, envs: chip.envs })
  }

  function onReloadPageTarget(e: StopPropagationEvent, target: Pick<DashboardChipData, 'tabId' | 'tabUrl'>) {
    e.stopPropagation()
    void reloadTabTarget(target)
  }

  function onDuplicatePageTarget(e: StopPropagationEvent, target: Pick<DashboardChipData, 'tabId' | 'tabUrl'>) {
    e.stopPropagation()
    void duplicateTabTarget(target)
  }

  async function onRemoveRetainedPage(
    e: StopPropagationEvent,
    target: Pick<
      DashboardChipData,
      'retainedPageIdentity' | 'retainedPageClosureToken'
    >,
  ) {
    e.stopPropagation()
    const focusRecovery = contextMenuFocusRecoveryRef.current
    contextMenuFocusRecoveryRef.current = null
    const targetDisappears = await removeRetainedPageTarget(target)
    focusRecovery?.complete(targetDisappears)
    setPreview('')
  }

  async function onToggleSavedPage(e: StopPropagationEvent) {
    e.stopPropagation()
    if (chip.saved) {
      await removeSavedPageTarget(chip.savedPageKey || chip.tabUrl)
    } else {
      await savePageTarget({
        url: chip.tabUrl,
        rawUrl: chip.rawUrl,
        title: chip.actionTitle || chip.title || chip.tooltip,
        favIconUrl: chip.actionFaviconUrl || chip.faviconUrl,
        isTabOut: false,
        isApp: chip.isApp,
      })
    }
    setPreview('')
  }

  async function onTogglePagePin(e: StopPropagationEvent) {
    e.stopPropagation()
    if (!chip.pagePinId) return
    await onTogglePinnedPageChip?.(chip.pagePinId)
    onLayoutChange?.({ animate: true })
    setPreview('')
  }

  async function onCopyTitleText(e: StopPropagationEvent, titleText: string) {
    e.stopPropagation()
    if (!titleText) return

    try {
      await navigator.clipboard.writeText(titleText)
      showToast('Page title copied')
    } catch {
      showToast('Could not copy page title')
    }
  }

  async function onCopyUrlText(e: StopPropagationEvent, urlText: string) {
    e.stopPropagation()
    if (!urlText) return

    try {
      await navigator.clipboard.writeText(urlText)
      showToast('Page URL copied')
    } catch {
      showToast('Could not copy page URL')
    }
  }

  async function onTitleVariantFocus(e: MouseEvent<HTMLButtonElement>, row: SameTitlePageChipRowView) {
    e.stopPropagation()
    if (!sameTitlePageChipPlan) return
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, {
      kind: 'activate',
      rowId: row.id,
    })
    if (decision.kind !== 'activate') return
    const { target } = decision
    await activateChipTarget(e, target.tabUrl, target.sourceType, target, e.currentTarget)
  }

  function onTitleVariantMouseEnter(row: SameTitlePageChipRowView) {
    setDefaultVariantSurfaceHover(false)
    previewTitleVariant(row.id)
  }

  function onTitleVariantMouseLeave(e: MouseEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) {
      if (!titleVariantEventTargetsDefaultSurfaceBlocker(e.relatedTarget)) {
        previewDefaultTitleVariantSurface(e.relatedTarget)
      } else {
        setDefaultVariantSurfaceHover(false)
      }
      return
    }
    if (contextMenuOpenRef.current) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  function onTitleVariantFocusIn(row: SameTitlePageChipRowView) {
    setDefaultVariantSurfaceHover(false)
    previewTitleVariant(row.id)
  }

  function onTitleVariantBlur(e: FocusEvent<HTMLElement>) {
    const chipEl = e.currentTarget.closest('.page-chip')
    if (chipEl && e.relatedTarget instanceof Node && chipEl.contains(e.relatedTarget)) return
    setDefaultVariantSurfaceHover(false)
    setPreview('')
  }

  async function executeTitleVariantRemoval(
    decision: SameTitlePageChipRemovalDecision,
    clearPreviewAfterEach: boolean,
    tabsFirst = false,
  ) {
    const removeHistory = () => decision.historyUrls.length > 0
      ? deleteHistoryUrls(omitUndefined({
          urls: Array.from(decision.historyUrls),
          onAfterDelete: clearPreviewAfterEach ? async () => setPreview('') : undefined,
        }))
      : Promise.resolve(null)
    const closeTabs = () => decision.tabClose?.kind === 'single'
      ? closeChipTarget(omitUndefined({
          tabUrl: decision.tabClose.target.tabUrl,
          tabId: decision.tabClose.target.tabId,
          expectedPinned: decision.tabClose.target.chromePinned,
          expectedGroupId: decision.tabClose.target.chromeGroupId,
          onAfterClose: clearPreviewAfterEach ? async () => setPreview('') : undefined,
        }))
      : decision.tabClose?.kind === 'many'
        ? closeChipTarget(omitUndefined({
            tabUrl: decision.tabClose.representativeUrl,
            envs: Array.from(decision.tabClose.envs),
            onAfterClose: clearPreviewAfterEach ? async () => setPreview('') : undefined,
          }))
        : Promise.resolve(null)
    if (tabsFirst) {
      await closeTabs()
      return removeHistory()
    }
    const historyResult = await removeHistory()
    await closeTabs()
    return historyResult
  }

  async function onCloseTitleVariant(e: MouseEvent<HTMLButtonElement>, row: SameTitlePageChipRowView) {
    e.stopPropagation()
    if (!sameTitlePageChipPlan) return
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, {
      action: 'close',
      kind: 'action',
      rowId: row.id,
    })
    if (decision.kind !== 'remove') return
    await executeTitleVariantRemoval(decision, true)
  }

  async function onCloseAllVariants(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const chipEl = e.currentTarget.closest('.page-chip')
    const focusWasInsideClosingChip = e.currentTarget.ownerDocument.activeElement === e.currentTarget
    if (!sameTitlePageChipPlan) return
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, {
      action: 'close',
      kind: 'action',
    })
    if (decision.kind !== 'remove') return

    // Close tabs and delete history without each call running its own removal
    // animation; animate the whole group chip out once, after both resolve.
    const historyResult = await executeTitleVariantRemoval(decision, false, true)

    if (
      decision.tabClose === null &&
      !decision.leavesSavedPage &&
      chipEl &&
      historyDeleteFullyRemoved(decision.historyUrls.length, historyResult)
    ) {
      startPageChipCloseAnimation(chipEl, onLayoutChange, undefined, focusWasInsideClosingChip)
    }
    setPreview('')
  }

  function titleVariantTargetAction(
    row: SameTitlePageChipRowView,
    action: 'duplicate' | 'reload' | 'remove-retained' | 'toggle-saved',
  ) {
    if (!sameTitlePageChipPlan) return undefined
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, {
      action,
      kind: 'action',
      rowId: row.id,
    })
    return decision.kind === 'target-action' ? decision.target : undefined
  }

  function onReloadTitleVariant(e: StopPropagationEvent, row: SameTitlePageChipRowView) {
    const target = titleVariantTargetAction(row, 'reload')
    if (!target) {
      e.stopPropagation()
      return
    }
    onReloadPageTarget(e, target)
  }

  function onDuplicateTitleVariant(e: StopPropagationEvent, row: SameTitlePageChipRowView) {
    const target = titleVariantTargetAction(row, 'duplicate')
    if (!target) {
      e.stopPropagation()
      return
    }
    onDuplicatePageTarget(e, target)
  }

  async function onRemoveRetainedTitleVariant(e: StopPropagationEvent, row: SameTitlePageChipRowView) {
    const target = titleVariantTargetAction(row, 'remove-retained')
    if (!target) {
      e.stopPropagation()
      return
    }
    await onRemoveRetainedPage(e, target)
  }

  async function onToggleSavedTitleVariant(e: StopPropagationEvent, row: SameTitlePageChipRowView) {
    e.stopPropagation()
    const variant = titleVariantTargetAction(row, 'toggle-saved')
    if (!variant) return
    if (variant.saved) {
      await removeSavedPageTarget(variant.savedPageKey || variant.tabUrl)
    } else {
      await savePageTarget({
        url: variant.tabUrl,
        rawUrl: variant.rawUrl,
        title: variant.actionTitle || variant.title || variant.tooltip,
        favIconUrl: variant.actionFaviconUrl || variant.faviconUrl,
        isTabOut: false,
        isApp: variant.isApp,
      })
    }
    setPreview('')
  }

  async function onTogglePinnedTitleVariant(e: StopPropagationEvent, row: SameTitlePageChipRowView) {
    e.stopPropagation()
    if (!sameTitlePageChipPlan) return
    const decision = resolveSameTitlePageChip(sameTitlePageChipPlan, {
      action: 'toggle-pin',
      kind: 'action',
      rowId: row.id,
    })
    if (decision.kind !== 'toggle-pin') return
    await onTogglePinnedPageChip?.(decision.pagePinId)
    onLayoutChange?.({ animate: true })
    setPreview('')
  }

  async function onToggleSavedEnv(e: StopPropagationEvent, env: DashboardChipEnv) {
    e.stopPropagation()
    if (env.saved) {
      await removeSavedPageTarget(env.savedPageKey || env.tabUrl)
    } else {
      await savePageTarget({
        url: env.tabUrl,
        rawUrl: env.rawUrl,
        title: env.actionTitle || env.title || chip.actionTitle || chip.title || chip.tooltip,
        favIconUrl: env.actionFaviconUrl || env.faviconUrl || chip.actionFaviconUrl || chip.faviconUrl,
        isTabOut: false,
        isApp: !!env.isApp,
      })
    }
    setPreview('')
  }

  const trim = chipTrim({
    activeChipFrame: !!chip.activeChipFrame,
    activeInOtherWindow: !!chip.activeInOtherWindow,
    isCurrentTabOut: !!chip.isCurrentTabOut,
    closedSavedPage: isClosedSavedPage,
    readOnlyFilterResult,
    folded: isFolded,
    titleVariantGroup: isTitleVariantGroup,
    iconOnly: !!chip.iconOnly,
    isApp: !!chip.isApp,
    expanded: chipExpanded ? { grewTaller: chipExpansionGeometry.grewTaller, y: chipExpansionGeometry.y } : null,
  })
  const dupeCount = chip.sourceType === 'retained-page' ? 1 : (chip.dupeCount || 1)
  const duplicateLabel = dupeCount > 1 ? `${dupeCount} open copies` : ''
  const loadingLabel = chip.loading ? 'Loading' : ''
  const pinnedLabel = chip.pagePinned ? 'Pinned' : ''
  const activeLabel = chip.activeInOtherWindow ? 'Active in another window' : ''
  const savedLabel = chip.saved ? (isClosedSavedPage ? 'Closed saved page' : 'Saved page') : ''
  const hiddenTitleLabel = suppressedTitleParts.length > 0 ? `Suppressed title text: ${suppressedTitleParts.join(' · ')}` : ''
  const titleVariantLabel = isTitleVariantGroup
    ? sameTitlePageChipView?.summaryLabel ?? ''
    : ''
  const chipLabel = [chip.tooltip, loadingLabel, pinnedLabel, titleVariantLabel, hiddenTitleLabel, duplicateLabel, activeLabel, savedLabel].filter(Boolean).join(' · ')
  const closeTabCount = isTitleVariantGroup
    ? sameTitlePageChipView?.groupRemoval?.tabCount ?? 0
    : isFolded
      ? foldedCloseTargets.length
      : isHistorySource
        ? 0
        : 1
  const closeHistoryCount = isTitleVariantGroup
    ? sameTitlePageChipView?.groupRemoval?.historyCount ?? 0
    : isHistorySource
      ? 1
      : 0
  const closeActionDeletesHistory = closeHistoryCount > 0
  const closeActionLabel = isTitleVariantGroup
    ? sameTitlePageChipView?.groupRemoval?.label ?? groupCloseActionLabel({ tabCount: closeTabCount, historyCount: closeHistoryCount })
    : groupCloseActionLabel({ tabCount: closeTabCount, historyCount: closeHistoryCount })
  const savedActionLabel = chip.saved ? 'Remove saved page' : 'Save page'
  const pagePinActionLabel = chip.pagePinned ? 'Unpin' : 'Pin'
  const chipTitleText = titleTextForChip(chip)
  const chipUrlText = pageTargetUrl(chip)
  const {
    canClose: canCloseChip,
    canRemoveRetained,
    canToggleSaved: canToggleSavedPage,
    canUseChromeTabActions,
    showSavedHint,
  } = pageChipTargetActionPolicy(chip, { interactive: parentInteractive })
  const canTogglePagePin = !!chip.pagePinId && typeof onTogglePinnedPageChip === 'function'
  // Unlike the other can* flags, canShowSuspend intentionally does NOT gate on
  // parentInteractive: folded groups (not parentInteractive) still expose Suspend.
  const canShowSuspend = chipCanShowSuspend(chip)
  const suspendEnabled = chipSuspendableTargetCount(chip) > 0
  const canCloseFoldedGroup = isFolded && foldedCloseTargets.length > 0
  const canCloseVariantGroup = isTitleVariantGroup && variantCloseCount > 0
  const canUseCopyContextMenu = parentInteractive && (!!chipTitleText || !!chipUrlText)
  const showFaviconCloseAction = !chip.iconOnly && (canCloseChip || canCloseFoldedGroup || canCloseVariantGroup)
  const showDefaultFavicon = !chip.faviconUrl && (!isReadOnlySource || isClosedSavedPage)
  const showFaviconFrame = !!chip.faviconUrl || showDefaultFavicon || dupeCount > 1 || showFaviconCloseAction
  const rightActionCount = showSavedHint ? 1 : 0
  const chipHoverFadeWidth = rightActionCount === 0 ? '0px' : rightActionCount === 1 ? '56px' : '88px'
  const style: CSSVariableProperties = omitUndefined({
    '--chip-hover-fade-bg': trim.styleVars.fadeBg,
    '--chip-hover-fade-width': chipHoverFadeWidth,
    '--chip-hover-border': trim.styleVars.hoverBorder,
    '--chip-interaction-bg': trim.styleVars.interactionBg,
    '--chip-target-interaction-bg': PAGE_CHIP_TARGET_INTERACTION_BG,
    '--chip-rest-bg': trim.styleVars.restBg,
    '--group-color': chip.isGrouped ? chip.groupDotColor ?? undefined : undefined,
  })
  const hasTitleSuppressionMarkers = suppressedTitleParts.length > 0 || chip.displaySegments.some(isTitleSuppressionSegment)
  const hasStructuralPlaceholders = chip.displaySegments.some((segment) => isStructuralPlaceholderSegment(segment) && !!(segment.label || chip.pathGroupLabel))
  const shouldExpandChip = !chip.iconOnly && (hasExpandableContent || hasTitleSuppressionMarkers || hasStructuralPlaceholders)
  const chipSlotStyle: CSSVariableProperties | undefined = chipExpanded && chipSlotSize.width > 0 && chipSlotSize.height > 0 ? {
    height: `${chipSlotSize.height}px`,
    width: `${chipSlotSize.width}px`,
  } : undefined
  const chipExpandedMaxWidth = chipExpansionGeometry.maxWidth > 0 ? `${chipExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const chipExpandedWidth = chipExpansionGeometry.width > 0 ? `${chipExpansionGeometry.width}px` : chipExpandedMaxWidth
  const chipStyle: CSSVariableProperties = {
    ...style,
    ...(chipExpanded ? {
      '--page-chip-expanded-max-width': chipExpandedMaxWidth,
      '--page-chip-expanded-width': chipExpandedWidth,
      maxWidth: chipExpandedMaxWidth,
      width: chipExpandedWidth,
    } : {}),
  }
  const chipTooltipStyle: CSSVariableProperties = {
    '--page-chip-tooltip-max-width': 'calc(100vw - 16px)',
    maxWidth: 'min(var(--page-chip-tooltip-max-width), calc(100vw - 16px))',
  }
  // Folded environment rows can mix live and closed targets under one parent,
  // so a closed child needs its own filter-result fill. Same-title URL rows
  // deliberately keep the shared target fill across Sources and filter state.
  function filterResultEnvInteractionStyle(
    target: Pick<DashboardChipEnv, 'sourceType' | 'closedSaved'>,
  ): CSSVariableProperties | undefined {
    const sourceType = target.sourceType ?? chip.sourceType
    const isClosedTarget = isReadOnlyDashboardSourceType(sourceType) || isClosedSavedDashboardTab(omitUndefined({
      sourceType,
      closedSaved: target.closedSaved,
    }))
    if (!hasFilter || !isClosedTarget) return undefined
    return { '--chip-target-interaction-bg': trim.styleVars.closedInteractionBg }
  }
  const hoverMatched = hoverMatchKey !== ''

  function suppressionMarkerNode(part: string, mode: ChipTextRenderMode, key: string, markerClassName = '') {
    const partKey = part.trim().toLowerCase()
    const active = activeSuppressedTitleKey !== '' && partKey === activeSuppressedTitleKey
    const tone = active ? activeSuppressionTone : titleSuppressionToneForText(part, suppressedTitleToneByText)
    const label = `Suppressed title text: ${part}`
    const marker = (
      <span
        key={key}
        className={cn(
          'chip-title-suppression-marker inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-[7px] border border-transparent bg-[rgba(115,115,115,0.08)] px-0.75 text-[12px] leading-3 text-muted-foreground align-middle [corner-shape:squircle] group-[.page-chip-expanded]/page-chip:h-auto group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:items-baseline group-[.page-chip-expanded]/page-chip:rounded-lg group-[.page-chip-expanded]/page-chip:border-0 group-[.page-chip-expanded]/page-chip:px-1 group-[.page-chip-expanded]/page-chip:leading-[inherit] group-[.page-chip-expanded]/page-chip:font-medium group-[.page-chip-expanded]/page-chip:align-baseline group-[.page-chip-expanded]/page-chip:[box-decoration-break:clone]',
          markerClassName,
          titleSuppressionMarkerClass(tone, active),
        )}
        aria-label={label}
      >
        <svg className="chip-title-suppression-glyph h-1.75 w-2 group-[.page-chip-expanded]/page-chip:hidden" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.25 5.4c1.25-1.45 2.5-1.45 3.75 0s2.5 1.45 3.75 0" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
        <span className="chip-title-suppression-label hidden group-[.page-chip-expanded]/page-chip:inline">
          {highlightedTextNodes(part, highlightTerms, `${key}-label`)}
        </span>
      </span>
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={key}
          className={cn(
            PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME,
            markerClassName,
            titleSuppressionMarkerClass(tone, active),
          )}
          aria-label={label}
        >
          {highlightedTextNodes(part, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function trailingSuppressionMarkerNodes(mode: ChipTextRenderMode, target: DashboardChipData = chip, keyPrefix: string = mode) {
    const targetSuppressedTitleParts = target.suppressedTitleParts || []
    if (targetSuppressedTitleParts.length === 0) return null

    const inlineSuppressedTitleKeys = new Set(
      target.displaySegments.flatMap((segment) => (
        isTitleSuppressionSegment(segment)
          ? [segment.titleSuppression.trim().toLowerCase()]
          : []
      )),
    )
    const trailingParts = targetSuppressedTitleParts.filter((part) => !inlineSuppressedTitleKeys.has(part.trim().toLowerCase()))

    return trailingParts.map((part, index) => {
      const markerSpacingClass = mode === 'chip' ? (index === 0 ? 'ml-1' : 'ml-0.5') : ''
      const marker = suppressionMarkerNode(
        part,
        mode,
        `${keyPrefix}-trailing-title-suppression-marker-${part}`,
        markerSpacingClass,
      )

      if (mode === 'tooltip') {
        return (
          <span key={`${keyPrefix}-trailing-title-suppression-${part}-${index}`}>
            {' '}
            {marker}
          </span>
        )
      }

      return marker
    })
  }

  function structuralPlaceholderNode(segment: { placeholder: true, label?: string }, mode: ChipTextRenderMode, key: string, fallbackLabelArg?: string) {
    const fallbackLabel = fallbackLabelArg !== undefined ? fallbackLabelArg : chip.pathGroupLabel
    const hiddenLabel = segment.label || fallbackLabel
    const marker = (
      <span
        key={key}
        className="chip-strip-indicator inline-flex size-4 items-center justify-center rounded-full bg-[rgba(115,115,115,0.1)] text-xs leading-none font-medium text-muted-foreground align-baseline group-[.page-chip-expanded]/page-chip:h-auto group-[.page-chip-expanded]/page-chip:w-auto group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:rounded-lg group-[.page-chip-expanded]/page-chip:px-1.5 group-[.page-chip-expanded]/page-chip:leading-[inherit] group-[.page-chip-expanded]/page-chip:[corner-shape:squircle]"
        aria-hidden={hiddenLabel ? undefined : true}
        aria-label={hiddenLabel || undefined}
      >
        <span className={hiddenLabel ? 'chip-strip-indicator-glyph group-[.page-chip-expanded]/page-chip:hidden' : undefined}>/</span>
        {hiddenLabel && (
          <span className="chip-strip-indicator-label hidden group-[.page-chip-expanded]/page-chip:inline">
            {highlightedTextNodes(hiddenLabel, highlightTerms, `${key}-label`)}
          </span>
        )}
      </span>
    )

    if (mode === 'tooltip' && hiddenLabel) {
      return (
        <span
          key={key}
          className={PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME}
          aria-label={hiddenLabel}
        >
          {highlightedTextNodes(hiddenLabel, highlightTerms, `${key}-label`)}
        </span>
      )
    }
    return marker
  }

  function envLabelNode(env: DashboardChipEnv, mode: ChipTextRenderMode) {
    const envSourceType = env.sourceType || chip.sourceType || 'tab'
    const envClosed = isClosedSavedDashboardTab({
      sourceType: envSourceType,
      closedSaved: !!env.closedSaved,
    })
    const envLabel = envClosed
      ? `Open ${env.prefix} closed page`
      : `Focus ${env.prefix} tab${env.activeInOtherWindow ? ' (active in another window)' : ''}`
    const envSavedActionLabel = env.saved ? 'Remove saved page' : 'Save page'
    const {
      canRemoveRetained: canRemoveRetainedEnv,
      canToggleSaved: canToggleSavedEnv,
      canUseChromeTabActions: envCanUseChromeTabActions,
      showSavedHint: showSavedEnvHint,
    } = pageChipTargetActionPolicy(env)
    const envTitleText = titleTextForEnv(env, chip)
    const envKey = env.rawUrl || env.tabUrl
    const envFilterResultCandidate = filterResultCandidateForTarget(env, chip.sourceType)
    const envClassName = cn(
      "chip-env inline-flex items-center rounded-lg border-0 bg-neutral-500/4.5 px-1.5 text-xs leading-[inherit] font-medium text-muted-foreground [corner-shape:squircle] after:ml-px after:font-normal after:opacity-45 after:content-['.']",
      isFolded && 'h-6 rounded-[7px] px-2',
      mode === 'chip' && 'clickable cursor-default transition-[background,color,box-shadow] duration-150 ease-[ease] hover:bg-(--chip-target-interaction-bg) hover:text-tab-live focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) data-[tabout-filter-result-selected=true]:bg-(--chip-target-interaction-bg) data-[tabout-filter-result-selected=true]:outline-1 data-[tabout-filter-result-selected=true]:outline-offset-1 data-[tabout-filter-result-selected=true]:outline-(--accent-amber) [&.page-chip-context-menu-open]:bg-(--chip-target-interaction-bg) [&.page-chip-context-menu-open]:text-tab-live',
      env.activeInOtherWindow && 'bg-neutral-600/7.5 text-tab-live shadow-[inset_0_0_0_1px_rgba(115,115,115,0.22)]',
    )

    if (mode === 'tooltip') {
      return (
        <span key={envKey} className={envClassName}>
          {highlightedTextNodes(env.prefix, highlightTerms, `tooltip-env-${env.prefix}`)}
        </span>
      )
    }

    const envFocusButton = (
      <button
        type="button"
        id={hasFilter ? envFilterResultCandidate.domId : undefined}
        data-tabout-retained-page-identity={envSourceType === 'retained-page' ? env.retainedPageIdentity : undefined}
        data-tabout-retained-page-closure-token={envSourceType === 'retained-page' ? env.retainedPageClosureToken : undefined}
        data-tabout-filter-result={hasFilter ? '' : undefined}
        data-tabout-filter-result-key={hasFilter ? envFilterResultCandidate.key : undefined}
        data-tabout-removal-key={`page:${env.rawUrl}`}
        className={envClassName}
        style={filterResultEnvInteractionStyle(env)}
        aria-label={envLabel}
        onClick={(e) => onEnvClick(e, env)}
        onKeyDown={(e) => onEnvKeyDown(e, env)}
        onMouseEnter={() => onEnvMouseEnter(env)}
        onMouseLeave={onEnvMouseLeave}
        onFocus={() => onEnvFocus(env)}
        onBlur={onEnvBlur}
      >
        {highlightedTextNodes(env.prefix, highlightTerms, `env-${env.prefix}`)}
      </button>
    )
    const envCanUseContextMenu = canToggleSavedEnv || canRemoveRetainedEnv || !!envTitleText || !!env.tabUrl
    const envFocusTarget = envCanUseContextMenu ? (
      <PageChipContextMenu
        savedActionLabel={canToggleSavedEnv ? envSavedActionLabel : undefined}
        saved={!!env.saved}
        onSavedSelect={canToggleSavedEnv ? (e) => onToggleSavedEnv(e, env) : undefined}
        onRemoveFromTabsSelect={canRemoveRetainedEnv ? (e) => onRemoveRetainedPage(e, env) : undefined}
        onReloadSelect={envCanUseChromeTabActions ? (e) => onReloadPageTarget(e, env) : undefined}
        onDuplicateSelect={envCanUseChromeTabActions ? (e) => onDuplicatePageTarget(e, env) : undefined}
        titleText={envTitleText}
        onCopyTitle={(e) => onCopyTitleText(e, envTitleText)}
        urlText={env.tabUrl}
        onCopyUrl={(e) => onCopyUrlText(e, env.tabUrl)}
        onOpenChange={(open) => onEnvContextMenuOpenChange(open, env)}
      >
        {envFocusButton}
      </PageChipContextMenu>
    ) : envFocusButton

    if (!showSavedEnvHint) return <span key={envKey} className="chip-env-shell relative inline-flex items-center">{envFocusTarget}</span>

    return (
      <span key={envKey} className="chip-env-shell group/env relative inline-flex items-center">
        {envFocusTarget}
        <span
          className="chip-env-saved-hint pointer-events-none absolute -top-1.5 -right-1.5 z-2 inline-flex size-4 cursor-default items-center justify-center rounded-full border border-tab-card bg-(--card-bg) p-0 text-(--accent-amber) opacity-0 shadow-[0_1px_2px_rgba(10,10,10,0.14)] group-hover/env:pointer-events-auto group-hover/env:opacity-100"
          aria-hidden="true"
        >
          <SavedPageIcon saved className="size-2.5" />
        </span>
      </span>
    )
  }

  function titleContentNode(mode: ChipTextRenderMode, target: DashboardChipData = chip, keyPrefix: string = mode, options: RenderTitleContentOptions = {}) {
    const includePathSuffix = options.includePathSuffix ?? true

    return (
      <>
        {target.pathGroupLabel && (
          <span className="chip-pathgroup mr-1.5 inline-block rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium text-muted-foreground align-baseline [corner-shape:squircle]">
            {highlightedTextNodes(pathGroupDisplayLabel(target.pathGroupLabel), highlightTerms, `${keyPrefix}-pathgroup`)}
          </span>
        )}
        {target.displaySegments.map((seg, index) => {
          if (typeof seg === 'string') {
            // A URL title has no spaces and only structural break points (/, -).
            // Under the chip's default `break-normal` it refuses to break at "/"
            // and overflows one clipped line, stranding a short tail (e.g.
            // "US.json") alone on line 2. overflow-wrap:break-word lets it wrap at
            // the "/" boundaries into balanced lines. Prose titles keep bionic +
            // the tuned break-normal path so short words never break awkwardly.
            return isUrlLikeTitle(seg)
              ? (
                  <span key={`${keyPrefix}-url-${seg}`} className="chip-url-title wrap-break-word">
                    {highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`)}
                  </span>
                )
              : highlightedTextNodes(seg, highlightTerms, `${keyPrefix}-segment-${index}`, createBionicTitleTextRenderer(seg))
          }
          if (isTitleSuppressionSegment(seg)) return suppressionMarkerNode(seg.titleSuppression, mode, `${keyPrefix}-inline-title-suppression-${index}`)
          if (isStructuralPlaceholderSegment(seg)) return structuralPlaceholderNode(seg, mode, `${keyPrefix}-structural-placeholder-${index}`, target.pathGroupLabel)
          return null
        })}
        {trailingSuppressionMarkerNodes(mode, target, keyPrefix)}
        {includePathSuffix && target.pathSuffix && (
          <>
            {' '}
            <span
              className={cn(
                'chip-path font-normal text-muted-foreground',
                mode === 'chip'
                  ? 'inline-block whitespace-nowrap group-[.page-chip-expanded]/page-chip:max-w-full group-[.page-chip-expanded]/page-chip:whitespace-normal group-[.page-chip-expanded]/page-chip:wrap-break-word'
                  : 'inline-block max-w-[calc(100%-6px)] whitespace-normal break-normal w-max wrap-break-word',
              )}
            >
              {highlightedTextNodes(target.pathSuffix, highlightTerms, `${keyPrefix}-path`)}
            </span>
          </>
        )}
      </>
    )
  }

  function titleVariantNode(row: SameTitlePageChipRowView, index: number, mode: ChipTextRenderMode) {
    const variantTargetCount = row.exactTargetCount
    const singleTarget = variantTargetCount === 1
    const variantHoverMatched = hoverMatchKey[index + 1] === '1'
    // Static marker consumed only by base.css: hovering the group's non-URL
    // surface highlights this pill via :hover CSS so it swaps with the exact
    // pill's own :hover inside one style recalc. Routing this highlight
    // through React state paints a one-frame rest-background flash instead.
    const variantCanClose = !!row.actions.close
    const variantCanRemoveRetained = row.actions.removeRetained
    const variantCanToggleSaved = !!row.actions.saved
    const variantCanUseChromeTabActions = row.actions.chromeTabActions
    const variantShowSavedHint = row.actions.showSavedHint
    const variantActionCount = (variantShowSavedHint ? 1 : 0) + (variantCanClose ? 1 : 0)
    const variantPagePinOwnSlot = singleTarget && row.pagePinned && !variantCanClose
    const variantActionSlotCount = variantActionCount + (variantPagePinOwnSlot ? 1 : 0)
    const variantCanTogglePagePin = !!row.actions.pin && typeof onTogglePinnedPageChip === 'function'
    const variantCanUseContextMenu = singleTarget && (
      variantCanToggleSaved ||
      variantCanRemoveRetained ||
      variantCanTogglePagePin ||
      !!row.copyTitle ||
      !!row.copyUrl
    )
    const variantLabelTruncated = mode === 'chip' && chipTextMetrics.titleVariantLabelTruncationKey[index] === '1'
    // Variant rows carry no favicon, so the label text carries the liveness
    // signal the favicon would: dim when this variant has no awake tab.
    const labelContent = (
      <>
        <span className={cn(
          'chip-title-variant-label min-w-0 overflow-hidden text-left whitespace-nowrap [&.chip-title-variant-label-truncated]:mask-(--title-fade-mask)',
          variantLabelTruncated && (chipExpanded ? 'text-ellipsis' : 'chip-title-variant-label-truncated'),
          row.dimmed && VARIANT_LABEL_DIM_CLASS_NAME,
        )}
        >
          {highlightedTextNodes(row.label, highlightTerms, `${mode}-title-variant-${index}`)}
        </span>
        {row.duplicateCount > 1 && (
          <span className="chip-title-variant-dupe inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[rgba(254,243,199,0.95)] px-1 text-[9px] leading-none font-bold tabular-nums text-[rgb(120,53,15)]">
            {row.duplicateCount}
          </span>
        )}
        {variantTargetCount > 1 && (
          <span className="chip-title-variant-target-count inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-neutral-500/10 px-1 text-[9px] leading-none font-bold tabular-nums text-muted-foreground">
            {variantTargetCount}
          </span>
        )}
      </>
    )
    const variantFocusButton = (
      <button
        type="button"
        id={hasFilter ? row.filterCandidate.domId : undefined}
        data-tabout-retained-page-identity={row.sourceType === 'retained-page' ? row.retainedPageIdentity : undefined}
        data-tabout-retained-page-closure-token={row.sourceType === 'retained-page' ? row.retainedPageClosureToken : undefined}
        data-tabout-filter-result={hasFilter ? '' : undefined}
        data-tabout-filter-result-key={hasFilter ? row.filterCandidate.key : undefined}
        data-tabout-layout-anchor={layoutScope ? '' : undefined}
        data-tabout-layout-key={layoutScope ? row.layoutKey : undefined}
        data-tabout-layout-scope={layoutScope || undefined}
        data-tabout-removal-anchor=""
        data-tabout-removal-key={row.removalKey}
        data-tabout-default-variant={row.id === sameTitlePageChipView?.defaultRowId ? 'true' : undefined}
        className={cn(
          'chip-title-variant clickable flex w-full max-w-full min-w-0 cursor-default items-center gap-1 rounded-none border-0 bg-transparent px-1.5 py-0.75 [font-size:inherit] leading-tight font-normal text-neutral-600 hover:bg-(--chip-target-interaction-bg) hover:text-tab-live focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) data-[tabout-filter-result-selected=true]:bg-(--chip-target-interaction-bg) data-[tabout-filter-result-selected=true]:outline-1 data-[tabout-filter-result-selected=true]:outline-offset-1 data-[tabout-filter-result-selected=true]:outline-(--accent-amber)',
          '[&.page-chip-context-menu-open]:bg-(--chip-target-interaction-bg) [&.page-chip-context-menu-open]:text-tab-live',
          row.active && 'bg-neutral-600/7.5 text-tab-live',
          row.current && 'bg-neutral-100 text-tab-live shadow-[inset_2px_0_0_0_var(--accent-amber)]',
          variantHoverMatched && 'bg-(--chip-target-interaction-bg) text-tab-live',
        )}
        aria-label={row.ariaLabel}
        onClick={(e) => onTitleVariantFocus(e, row)}
        onMouseEnter={() => onTitleVariantMouseEnter(row)}
        onMouseLeave={onTitleVariantMouseLeave}
        onFocus={() => onTitleVariantFocusIn(row)}
        onBlur={onTitleVariantBlur}
      >
        {labelContent}
      </button>
    )
    const variantFocusTarget = variantCanUseContextMenu ? (
      <PageChipContextMenu
        savedActionLabel={row.actions.saved?.label}
        saved={row.saved}
        onSavedSelect={variantCanToggleSaved ? (e) => onToggleSavedTitleVariant(e, row) : undefined}
        onRemoveFromTabsSelect={variantCanRemoveRetained ? (e) => onRemoveRetainedTitleVariant(e, row) : undefined}
        onReloadSelect={variantCanUseChromeTabActions ? (e) => onReloadTitleVariant(e, row) : undefined}
        onDuplicateSelect={variantCanUseChromeTabActions ? (e) => onDuplicateTitleVariant(e, row) : undefined}
        pagePinActionLabel={variantCanTogglePagePin ? row.actions.pin?.label : undefined}
        pagePinned={row.pagePinned}
        onPagePinSelect={variantCanTogglePagePin ? (e) => onTogglePinnedTitleVariant(e, row) : undefined}
        titleText={row.copyTitle}
        onCopyTitle={(e) => onCopyTitleText(e, row.copyTitle)}
        urlText={row.copyUrl}
        onCopyUrl={(e) => onCopyUrlText(e, row.copyUrl)}
        onOpenChange={(open) => onTitleVariantContextMenuOpenChange(open, row)}
      >
        {variantFocusButton}
      </PageChipContextMenu>
    ) : (
      variantFocusButton
    )

    if (mode === 'tooltip') {
      return (
        <span
          key={row.id}
          className="chip-title-variant inline-flex max-w-full items-center gap-1 rounded-lg bg-neutral-500/4.5 px-1.5 py-0.5 leading-tight font-normal text-neutral-600 [corner-shape:squircle]"
        >
          {labelContent}
        </span>
      )
    }

    return (
      <span
        key={row.id}
        className="chip-title-variant-shell relative flex w-full max-w-full min-w-0 items-center"
      >
        {variantFocusTarget}
        {variantActionSlotCount > 0 && (
          <span className={cn(
            'chip-title-variant-actions group/title-variant-actions absolute top-0 bottom-0 z-2 my-auto flex h-4.75 items-center gap-0.5',
            variantActionSlotCount === 1 && 'left-[-25.5px]',
            variantActionSlotCount > 1 && 'left-[-46.5px]',
          )}
          >
            {variantShowSavedHint && (
              <span
                className="chip-title-variant-saved-hint pointer-events-none inline-flex size-4.75 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-0 text-(--accent-amber) opacity-0 group-hover/title-variant-actions:pointer-events-auto group-hover/title-variant-actions:opacity-100"
                aria-hidden="true"
              >
                <SavedPageIcon saved className="size-3.5" />
              </span>
            )}
            {variantCanClose && (
              <span
                data-tabout-part="variant-close-hit-owner"
                className="chip-title-variant-close-hit-owner group/title-variant-close-owner relative inline-flex size-4.75 shrink-0 cursor-pointer items-center justify-center rounded-full"
              >
                <button
                  type="button"
                  data-tabout-part="variant-close-button"
                  className={cn(
                    'chip-title-variant-action pointer-events-none absolute inset-0 inline-flex size-4.75 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 group-hover/title-variant-close-owner:pointer-events-auto group-hover/title-variant-close-owner:opacity-100 hover:bg-neutral-600/10 hover:text-foreground hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
                    row.actions.close?.destructive && DESTRUCTIVE_ICON_ACTION_CLASS_NAME,
                  )}
                  aria-label={row.actions.close?.label}
                  onClick={(e) => onCloseTitleVariant(e, row)}
                  onMouseEnter={() => onTitleVariantMouseEnter(row)}
                  onMouseLeave={onTitleVariantMouseLeave}
                  onFocus={() => onTitleVariantFocusIn(row)}
                  onBlur={onTitleVariantBlur}
                >
                  <svg className="size-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            )}
            {singleTarget && row.pagePinned && (
              <span className={cn(
                'chip-title-variant-page-pin-slot pointer-events-none inline-flex size-4.75 shrink-0 items-center justify-center',
                variantCanClose && 'absolute top-0 right-0 group-hover/title-variant-actions:opacity-0 group-focus-within/title-variant-actions:opacity-0',
              )}
              >
                <span
                  data-tabout-part="variant-page-pin"
                  data-pinned="true"
                  className="chip-title-variant-page-pin icon-[lucide--pin] size-2.5 text-muted-foreground"
                  aria-hidden="true"
                />
              </span>
            )}
          </span>
        )}
      </span>
    )
  }

  function titleVariantListNode(mode: ChipTextRenderMode) {
    if (!isTitleVariantGroup) return null
    return (
      <span className="chip-title-variant-list flex w-full max-w-full flex-col items-stretch pr-1.25 pb-1 divide-y divide-neutral-500/15">
        {sameTitleRows.map((row, index) => titleVariantNode(row, index, mode))}
      </span>
    )
  }

  function expandedTitleContentNode(keyPrefix: string) {
    if (!chipExpanded || chipExpansionGeometry.lineHtml.length === 0) return null
    return expansionLineNodesFromHtml(
      chipExpansionLineMarkup(chipExpansionGeometry.lineHtml, chipExpansionGeometry.viewportConstrained),
      keyPrefix,
    )
  }

  function titleRowContentNode(mode: ChipTextRenderMode, keyPrefix: string) {
    const expandedContent = expandedTitleContentNode(keyPrefix)
    if (expandedContent) return expandedContent
    return (
      <>
        {chip.leadPrefix && (
          <span className="chip-subdomain mr-1.5 font-medium text-muted-foreground after:ml-1.5 after:opacity-50 after:content-['·']">
            {highlightedTextNodes(chip.leadPrefix, highlightTerms, `${mode}-lead`)}
          </span>
        )}
        {titleContentNode(mode)}
      </>
    )
  }

  function titleVariantTitleRowNode(mode: ChipTextRenderMode) {
    return (
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleRowContentNode(mode, `${mode}-expanded-title-variant-title`)}
      </span>
    )
  }

  function chipTextContentNode(mode: ChipTextRenderMode) {
    if (isFolded) {
      return (
        <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
          <span className="chip-title-row block min-w-0 max-w-full">
            {titleRowContentNode(mode, `${mode}-expanded-folded-title`)}
          </span>
          <span className="chip-env-row flex max-w-full flex-wrap items-center gap-1">
            {envs.map((env) => envLabelNode(env, mode))}
          </span>
        </span>
      )
    }

    if (isTitleVariantGroup) {
      return (
        <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
          {titleVariantTitleRowNode(mode)}
          {titleVariantListNode(mode)}
        </span>
      )
    }

    if (mode === 'chip' && !chipExpanded && chipTextClamp && chipTextClamp.key === chipTextClampKey && chipTextClamp.lineHtml.length > 1) {
      return clampedTitleLineNodes(
        chipTextClamp.lineHtml,
        'chip-text',
        hasTitleSuppressionMarkers ? rebuildClampedChipMarker : undefined,
      )
    }

    return (
      titleRowContentNode(mode, `${mode}-expanded-title`)
    )
  }

  // Captured suppression pills come back as live nodes: the static rebuild
  // would drop their SVG glyph and freeze the context-driven hover tone. The
  // trailing-marker spacing class rides along from the captured element.
  function rebuildClampedChipMarker(element: Element, key: string) {
    if (!element.classList.contains('chip-title-suppression-marker')) return undefined
    const part = (element.getAttribute('aria-label') || '').replace(/^Suppressed title text:\s*/, '')
    if (!part) return undefined
    const markerSpacingClass = element.classList.contains('ml-1') ? 'ml-1' : element.classList.contains('ml-0.5') ? 'ml-0.5' : ''
    return suppressionMarkerNode(part, 'chip', key, markerSpacingClass)
  }

  const chipTooltipContent = chip.iconOnly ? (
    <span
      className={cn(
        "chip-text block min-w-0 max-w-[calc(100vw-32px)] hyphens-auto break-normal text-[13px] leading-tight text-tab-live font-[inherit] [hyphenate-character:'']",
        'whitespace-normal wrap-break-word',
        hasFilter && 'text-[color-mix(in_srgb,var(--color-tab-live)_72%,var(--color-muted-foreground))]',
      )}
    >
      {chipTextContentNode('tooltip')}
    </span>
  ) : undefined

  const foldedTitleExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-1.25 flex min-w-0 py-1.25"
    >
      <span className="chip-title-row block min-w-0 max-w-full">
        {titleRowContentNode('chip', 'chip-expanded-folded-title-trigger')}
      </span>
    </span>
  )

  const foldedChipTextContent = (
    <span className="chip-folded-content flex min-w-0 flex-col items-start gap-0.5">
      {shouldExpandChip ? (
        foldedTitleExpansionTriggerElement
      ) : (
        <span className="chip-title-row block min-w-0 max-w-full">
          {titleRowContentNode('chip', 'chip-expanded-folded-title-rest')}
        </span>
      )}
      <span className="chip-env-row relative flex max-w-full flex-wrap items-center gap-1">
        <ProgressiveFoldedEnvList
          key={progressiveFoldedEnvResetKey}
          envs={envs}
          renderEnv={(env) => envLabelNode(env, 'chip')}
        />
      </span>
    </span>
  )

  const titleVariantTitleExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-1.25 flex min-w-0 py-1.25"
    >
      {titleVariantTitleRowNode('chip')}
    </span>
  )

  const titleVariantChipTextContent = (
    <span className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0.5">
      {shouldExpandChip ? (
        titleVariantTitleExpansionTriggerElement
      ) : (
        titleVariantTitleRowNode('chip')
      )}
      {titleVariantListNode('chip')}
    </span>
  )

  const chipTextClampAvailable =
    !isFolded &&
    !isTitleVariantGroup &&
    chipTextClamp?.key === chipTextClampKey &&
    chipTextClamp.lineHtml.length > 1
  const chipTextContentKey = chipTextClampAvailable ? 'captured' : 'natural'
  // Fallback emoji and tall symbols can paint slightly outside the tight line
  // box. Extend the clip edge without shifting the title or changing clamp
  // height; the expansion hit-area padding sits outside this clipping element.
  const chipTextElement = (
    <span
      className={cn(
        "chip-text block min-w-0 flex-1 overflow-clip [overflow-clip-margin:2px] hyphens-auto break-normal max-h-[calc(2lh)] [hyphenate-character:''] [&.chip-text-truncated]:mask-(--title-fade-mask)",
        hasFilter && !isClosedSavedPage && 'text-[color-mix(in_srgb,var(--color-tab-live)_72%,var(--color-muted-foreground))]',
        chip.pathSuffix && 'max-h-[calc(3lh)]',
        isTitleVariantGroup && 'max-h-none overflow-visible!',
        isFolded && 'max-h-none',
        chipExpanded && 'max-h-none! max-w-none! flex-1! overflow-visible! mask-none! whitespace-normal wrap-break-word',
      )}
      ref={chipTextRef}
      onPointerEnter={onChipTextPointerEnter}
    >
      <span
        key={chipTextContentKey}
        className="captured-title-content-root contents"
      >
        {isFolded ? foldedChipTextContent : isTitleVariantGroup ? titleVariantChipTextContent : chipTextContentNode('chip')}
      </span>
    </span>
  )

  const chipTextExpansionTriggerElement = (
    <span
      className="chip-text-expansion-hit-area -my-1.25 flex min-w-0 flex-1 py-1.25"
    >
      {chipTextElement}
    </span>
  )

  const chipInteractionProps = parentInteractive
    ? {
        tabIndex: 0,
        onClick: onFocus,
        onMouseDown: onChipPointerDown,
        onKeyDown: onChipKeyDown,
        onMouseEnter: onChipMouseEnter,
        onMouseLeave: onChipMouseLeave,
        onFocus: onChipFocus,
        onBlur: onChipBlur,
      } as const
    : {}

  // The grouped chip stays keyboard-inert (no role/tabIndex — the URL variant
  // buttons are the keyboard targets), but its whole mouse surface targets the
  // default variant. These live on the rectangular `.chip-slot`, NOT the
  // `.page-chip`: the chip is rounded (`rounded-[10px] [corner-shape:squircle]`)
  // so clicks at its corners fall through to the slot underneath; owning them
  // on the slot makes the corner gutter activate the default variant too (the
  // base.css hover highlight is keyed off the slot for the same reason). The
  // exact pills, their action rails, the favicon close, and the audio toggle
  // each stop propagation, so only title/blank-surface clicks reach here.
  const variantGroupInteractionProps = isTitleVariantGroup
    ? {
        onClick: onVariantGroupChipClick,
        onMouseDown: onVariantGroupChipMouseDown,
        onMouseEnter: onVariantGroupChipMouseEnter,
        onMouseMove: onVariantGroupChipMouseMove,
        onMouseLeave: onVariantGroupChipMouseLeave,
      } as const
    : {}

  const chipElement = (
    <div
      role={parentInteractive ? 'button' : 'group'}
      id={hasFilter && parentInteractive ? chipFilterResultCandidate.domId : undefined}
      data-tabout="page-chip"
      data-tabout-retained-page-identity={chip.sourceType === 'retained-page' ? chip.retainedPageIdentity : undefined}
      data-tabout-retained-page-closure-token={chip.sourceType === 'retained-page' ? chip.retainedPageClosureToken : undefined}
      data-tabout-filter-result={hasFilter && parentInteractive ? '' : undefined}
      data-tabout-filter-result-key={hasFilter && parentInteractive ? chipFilterResultCandidate.key : undefined}
      data-expanded={chipExpanded ? 'true' : undefined}
      data-loading={chip.loading ? 'true' : undefined}
      className={cn(
        "page-chip group/page-chip relative flex items-start gap-2 rounded-[10px] border-0 bg-transparent py-1.25 pr-1 pl-3 text-left text-[13px] leading-tight text-tab-live font-[inherit] [corner-shape:squircle] transition-[color] duration-100 before:pointer-events-none before:absolute before:top-1.75 before:bottom-1.75 before:left-1 before:w-0.5 before:rounded-[1px] before:bg-(--group-color,transparent) before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-(--chip-hover-fade-width) after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--chip-hover-fade-bg)_34%,var(--chip-hover-fade-bg)_100%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transform-[scale(0.96)] motion-reduce:[&.closing]:transform-none",
        !chip.iconOnly && 'w-full',
        parentInteractive && 'clickable cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-amber) data-[tabout-filter-result-selected=true]:bg-(--chip-interaction-bg) data-[tabout-filter-result-selected=true]:outline-1 data-[tabout-filter-result-selected=true]:outline-offset-2 data-[tabout-filter-result-selected=true]:outline-(--accent-amber)',
        chipTooltipOpen && CHIP_TRIM_TOKENS.tooltipOpen,
        chipExpanded && 'page-chip-expanded absolute z-30 min-w-0 max-w-(--page-chip-expanded-max-width) overflow-visible! transition-none! w-(--page-chip-expanded-width) [&.page-chip-expanded]:shadow-[0_3px_10px_rgba(10,10,10,0.055)]',
        chipExpanded && 'left-0',
        chipExpanded && (chipExpansionGeometry.y === 'up' ? 'bottom-0' : 'top-0'),
        trim.chipClasses,
        isTitleVariantGroup && 'cursor-default',
        isFolded && `${CHIP_TRIM_TOKENS.folded} cursor-default after:hidden`,
        chip.saved && 'page-chip-saved',
        hoverMatched && `${CHIP_TRIM_TOKENS.hoverMatch} outline-1 outline-offset-1 outline-(--accent-amber)`,
        suppressionHighlighted && cn('page-chip-suppression-highlighted', titleSuppressionChipHighlightClass(activeSuppressionTone)),
        chip.iconOnly && 'page-chip-icon-only h-6 min-h-6 w-6 min-w-6 items-center justify-center gap-0 rounded-xl bg-transparent p-0 [corner-shape:squircle] before:hidden after:hidden',
        trim.iconChipClasses,
      )}
      aria-label={chipLabel}
      aria-busy={chip.loading ? true : undefined}
      style={chipStyle}
      onPointerEnter={onChipPointerEnter}
      onPointerMove={onChipPointerMove}
      onPointerLeave={onChipPointerLeave}
      {...chipInteractionProps}
    >
      {trim.expandedFill && (
        <span
          aria-hidden="true"
          className={trim.expandedFill.classes}
          style={{
            top: trim.expandedFill.top,
            bottom: trim.expandedFill.bottom,
            backgroundColor: trim.expandedFill.background,
          }}
        />
      )}
      {trim.frame && (
        <span className={trim.frame.classes} aria-hidden="true" />
      )}
      {showFaviconFrame && (
        <ChipFaviconFrame
          chip={chip}
          dupeCount={dupeCount}
          showDefaultFavicon={showDefaultFavicon}
          showFaviconCloseAction={showFaviconCloseAction}
          dedupeBadgesClosing={dedupeBadgesClosing}
          closeActionLabel={closeActionLabel}
          closeActionDestructive={closeActionDeletesHistory}
          onCloseAction={isTitleVariantGroup ? onCloseAllVariants : isHistorySource ? onDeleteHistory : onClose}
          onToggleAudio={onToggleChipAudio}
        />
      )}
      {!chip.iconOnly && chip.audioState && (
        <TabAudioButton
          state={chip.audioState}
          onToggle={onToggleChipAudio}
          className="mt-px self-start"
        />
      )}
      {!chip.iconOnly && chip.chromePinned && (
        <span
          data-tabout-part="chrome-pin"
          className="chip-chrome-pin icon-[lucide--pin] mt-px size-3 shrink-0 text-muted-foreground opacity-70"
          aria-hidden="true"
        />
      )}
      {!chip.iconOnly && (
        isFolded || isTitleVariantGroup ? chipTextElement : chipTextExpansionTriggerElement
      )}
      {!chip.iconOnly && showSavedHint && (
        <div className="chip-actions absolute top-1/2 right-2 z-2 flex -translate-y-1/2 items-center gap-0.5">
          <span
            className="chip-action chip-saved-hint pointer-events-none inline-flex shrink-0 cursor-default items-center justify-center rounded-full border-0 bg-transparent p-1 text-(--accent-amber) opacity-0 group-hover/page-chip:pointer-events-auto group-hover/page-chip:opacity-100 group-[.page-chip-expanded]/page-chip:pointer-events-auto group-[.page-chip-expanded]/page-chip:opacity-100 group-[.page-chip-context-menu-open]/page-chip:pointer-events-auto group-[.page-chip-context-menu-open]/page-chip:opacity-100 group-[.page-chip-tooltip-open]/page-chip:pointer-events-auto group-[.page-chip-tooltip-open]/page-chip:opacity-100"
            aria-hidden="true"
          >
            <SavedPageIcon saved className="size-3.5" />
          </span>
        </div>
      )}
    </div>
  )
  const chipElementWithContextMenu = !chip.iconOnly && (canToggleSavedPage || canRemoveRetained || canTogglePagePin || canUseChromeTabActions || canShowSuspend || canUseCopyContextMenu) ? (
    <PageChipContextMenu
      savedActionLabel={canToggleSavedPage ? savedActionLabel : undefined}
      saved={!!chip.saved}
      onSavedSelect={canToggleSavedPage ? onToggleSavedPage : undefined}
      onRemoveFromTabsSelect={canRemoveRetained ? (e) => onRemoveRetainedPage(e, chip) : undefined}
      pagePinActionLabel={canTogglePagePin ? pagePinActionLabel : undefined}
      pagePinned={!!chip.pagePinned}
      onPagePinSelect={canTogglePagePin ? onTogglePagePin : undefined}
      onReloadSelect={canUseChromeTabActions ? (e) => onReloadPageTarget(e, chip) : undefined}
      onDuplicateSelect={canUseChromeTabActions ? (e) => onDuplicatePageTarget(e, chip) : undefined}
      suspendEnabled={suspendEnabled}
      onSuspendSelect={canShowSuspend ? onToggleChipSuspend : undefined}
      titleText={chipTitleText}
      onCopyTitle={(e) => onCopyTitleText(e, chipTitleText)}
      urlText={chipUrlText}
      onCopyUrl={(e) => onCopyUrlText(e, chipUrlText)}
      onOpenChange={onChipContextMenuOpenChange}
    >
      {chipElement}
    </PageChipContextMenu>
  ) : chipElement

  const renderedChipElement = chip.iconOnly && chipTooltipContent ? (
    <TooltipAnchor
      content={chipTooltipContent}
      className="page-chip-tooltip max-w-[calc(100vw-16px)] text-[13px] leading-tight wrap-break-word cursor-default select-none"
      instant
      onClick={onPageChipTooltipClick}
      onOpenChange={onChipTooltipOpenChange}
      style={chipTooltipStyle}
    >
      {chipElement}
    </TooltipAnchor>
  ) : chipElementWithContextMenu

  return (
    <div
      data-tabout-part="slot"
      data-tabout-layout-anchor={layoutScope ? '' : undefined}
      data-tabout-layout-item={layoutScope ? '' : undefined}
      data-tabout-layout-key={layoutScope ? chipLayoutKey : undefined}
      data-tabout-layout-scope={layoutScope || undefined}
      data-tabout-removal-anchor=""
      data-tabout-removal-item=""
      data-tabout-removal-key={`page:${chip.rawUrl}`}
      // The hover-match slot lift (z-3) stays below the interacting-slot
      // lift (z-4, inside trim.slotClasses) by specificity, so a deliberate
      // interaction always wins over passive hover-match at the seam.
      className={cn('chip-slot relative min-w-0', chip.iconOnly ? 'inline-flex' : `${trim.slotClasses} flex w-full`, hoverMatched && 'z-3')}
      style={chipSlotStyle}
      ref={chipSlotRef}
      {...variantGroupInteractionProps}
    >
      {renderedChipElement}
    </div>
  )
}

export function PageChip(props: PageChipProps) {
  return usePageChipElement(props)
}
