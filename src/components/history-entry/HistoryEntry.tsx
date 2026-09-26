import { useCallback, useLayoutEffect, useRef } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { EyeOff, X } from 'lucide-react'
import { audioStateForTab, nextMutedForAudioState } from '../../extension/tab-audio.js'
import { duplicateTabTarget, reloadTabTarget, setHistoryEntryMuted, suspendHistoryEntry } from '../../extension/tab-actions'
import { savePageTarget, removeSavedPageTarget } from '../../extension/saved-page-actions.js'
import { historyEntrySaveTarget, historyEntrySaved, historyEntrySavedPageKey, isHistoryEntrySaveEligible } from '../../extension/history-saved-page.js'
import { pageTargetMatchesHover, pageTargetMatchUrls, pageTargetUrl } from '../../extension/page-target.js'
import { showToast } from '../../extension/toast.js'
import { waitForHistoryEntryMoves } from '../../extension/history-entry-move-animation.js'
import { PageChipContextMenu } from '../PageChipContextMenu'
import type { PageChipContextMenuTriggerElement } from '../PageChipContextMenu'
import type { ContextMenuChangeEventDetails } from '../context-menu-outside-press'
import { DefaultFavicon } from '../DefaultFavicon'
import { FaviconImage } from '../FaviconImage'
import { faviconLivenessClassName } from '../liveness-dim'
import { attachPageChipBorder } from '../capsule-border'
import { PAGE_CHIP_CURRENT_CLASSES, PAGE_CHIP_PAINT } from '../page-chip-paint'
import { TabAudioButton } from '../TabAudioButton'
import { TabLoadingIndicator } from '../TabLoadingIndicator'
import { createBionicTitleTextRenderer } from '../bionic-title-text'
import { highlightedTextNodes } from '../filter-highlight-text'
import { clampedTitleLineNodes, expansionLineNodesFromHtml } from '../title-expansion'
import { cn } from '@/lib/utils'
import { omitUndefined } from '@/lib/omit-undefined'
import type { CSSVariableProperties } from '@/lib/css-properties'
import { useHoverStateSelector } from '../DashboardInteractionContext'
import type { HoverUrlSource, TabHistorySnapshot } from '../types'
import type { RetainedPageSurfaceMatch, TabHistoryEntry } from '../../extension/types'
import type { RefObject } from 'react'
import {
  HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME,
  HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME,
  HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME,
  HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME,
} from './title-measurement.js'
import type { HistoryEntryExpansionGeometry } from './title-measurement.js'
import { useHistoryEntryExpansion } from './use-history-entry-expansion.js'
import { startHistoryEntryRemoval, uniqueUrls, useHistoryEntryActions, workingSetUrls } from './use-history-entry-actions.js'
import type { HistoryEntryProps } from './types.js'

const HISTORY_ENTRY_INTERACTION_CLASSES = 'title-interaction:hover:[--capsule-fill:var(--history-entry-interaction-bg)] title-interaction:focus-within:[--capsule-fill:var(--history-entry-interaction-bg)] [&.history-entry-expanded-open]:[--capsule-fill:var(--history-entry-interaction-bg)] title-interaction:group-data-context-menu-open/history-slot:[--capsule-fill:var(--history-entry-interaction-bg)] title-interaction:hover:after:opacity-100 [&.history-entry-expanded-open]:after:opacity-100 title-interaction:group-data-context-menu-open/history-slot:after:opacity-100'
// Unframed rows share the closed-page fill and rim regardless of liveness.
// Keyboard focus retains its stronger outer outline. Paint values use CSS
// variables so Tailwind sees complete class literals for every selector.
const HISTORY_ENTRY_HOVER_OUTLINE_CLASSES = 'title-interaction:hover:outline title-interaction:hover:outline-1 title-interaction:hover:-outline-offset-1 title-interaction:hover:outline-(--history-entry-hover-border) [&.history-entry-expanded-open]:outline [&.history-entry-expanded-open]:outline-1 [&.history-entry-expanded-open]:-outline-offset-1 [&.history-entry-expanded-open]:outline-(--history-entry-hover-border) title-interaction:group-data-context-menu-open/history-slot:outline title-interaction:group-data-context-menu-open/history-slot:outline-1 title-interaction:group-data-context-menu-open/history-slot:-outline-offset-1 title-interaction:group-data-context-menu-open/history-slot:outline-(--history-entry-hover-border)'
const HISTORY_ENTRY_OUTLINED_INTERACTION_CLASSES = `${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`
const HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES = `[--capsule-fill:var(--history-entry-rest-bg)] text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.04)] ${HISTORY_ENTRY_INTERACTION_CLASSES}`

const EMPTY_HIGHLIGHT_TERMS: readonly string[] = []

const EMPTY_RETAINED_PAGE_SURFACE_MATCHES: readonly RetainedPageSurfaceMatch[] = []

type StopPropagationEvent = { stopPropagation: () => void }

export function historyEntryIndexLabel(entry: TabHistoryEntry, snapshot: TabHistorySnapshot | null, fallback: number): ReactNode {
  if (Number.isInteger(entry.index) && snapshot && Number.isInteger(snapshot.currentIndex) && snapshot.currentIndex >= 0) {
    const relativeIndex = entry.index - snapshot.currentIndex
    if (relativeIndex < 0) {
      return (
        <>
          <span>-</span>
          <span>{Math.abs(relativeIndex)}</span>
        </>
      )
    }
    if (relativeIndex > 0) {
      return (
        <>
          <span>+</span>
          <span>{relativeIndex}</span>
        </>
      )
    }
    return String(relativeIndex)
  }
  return String(fallback)
}

type HistoryEntryMarkerCellProps = {
  indexLabel: ReactNode
}

// Ghost rows (Working Set extras, recently-closed) render a blank marker
// cell: their open/closed state already reads from the row itself via the
// liveness treatment, so the old amber dot glyphs carried redundant signal.
function HistoryEntryMarkerCell({ indexLabel }: HistoryEntryMarkerCellProps) {
  return (
    <span
      data-tabout-part="history-entry-marker"
      className="mt-1.25 inline-flex h-4 w-5.5 flex-none items-center justify-end gap-px bg-transparent text-xs font-medium tabular-nums text-muted-foreground group-has-[.history-entry:hover:not([data-title-collapsed])]/history-row:text-[rgba(64,64,64,0.76)] group-focus-within/history-row:text-[rgba(64,64,64,0.76)]"
    >
      {indexLabel}
    </span>
  )
}

type HistoryEntryTitleProps = {
  expanded: boolean
  title: string
  highlightTerms: readonly string[]
  mutedTitle: boolean
  geometry: HistoryEntryExpansionGeometry
  clampedLineHtml: readonly string[] | null
  titleRef: RefObject<HTMLSpanElement | null>
}

function HistoryEntryTitle({ expanded, title, highlightTerms, mutedTitle, geometry, clampedLineHtml, titleRef }: HistoryEntryTitleProps) {
  function expandedLinesNode() {
    const lastIndex = geometry.lineHtml.length - 1
    return (
      <span className={HISTORY_ENTRY_EXPANDED_LINES_CLASS_NAME}>
        {geometry.lineHtml.map((html, index) => (
          <span
            key={`${index}:${html}`}
            className={index === lastIndex ? HISTORY_ENTRY_EXPANDED_TAIL_LINE_CLASS_NAME : geometry.viewportConstrained ? HISTORY_ENTRY_EXPANDED_CONSTRAINED_LINE_CLASS_NAME : HISTORY_ENTRY_EXPANDED_LINE_CLASS_NAME}
          >
            {expansionLineNodesFromHtml(html, `history-title-line-${index}`)}
          </span>
        ))}
      </span>
    )
  }
  const titleContent = expanded && geometry.lineHtml.length > 0
    ? expandedLinesNode()
    : !expanded && clampedLineHtml && clampedLineHtml.length > 1
        ? clampedTitleLineNodes(clampedLineHtml, 'history-entry-title')
        : highlightedTextNodes(title, highlightTerms, 'history-entry-title', createBionicTitleTextRenderer(title, mutedTitle ? 600 : 700))
  const titleContentKey = clampedLineHtml && clampedLineHtml.length > 1
    ? 'captured'
    : 'natural'
  return (
    <span className="history-entry-title-expansion-hit-area -my-1.25 flex min-w-0 flex-auto py-1.25">
      <span className="flex min-w-0 flex-auto items-start gap-1.5">
        <span
          className={cn(
            "history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [font-size:inherit] [hyphenate-character:''] wrap-break-word [&.history-entry-title-truncated]:mask-(--title-fade-mask)",
            mutedTitle ? 'text-tab-closed font-normal' : 'text-tab-live font-medium',
            expanded && 'max-h-none! max-w-none! flex-none! overflow-visible! mask-none! w-(--history-entry-expanded-title-width) whitespace-normal wrap-break-word',
          )}
          ref={expanded ? undefined : titleRef}
        >
          <span
            key={titleContentKey}
            className="captured-title-content-root contents"
          >
            {titleContent}
          </span>
        </span>
      </span>
    </span>
  )
}

type HistoryEntryFaviconFrameProps = {
  expanded: boolean
  faviconUrl: string
  faviconClassName: string
  loading: boolean
  isApp: boolean
  isWorkingSetExtra: boolean
  canRemoveEntry: boolean
  canForgetClosedGhost: boolean
  entryLabel: string
  onForget: (e: MouseEvent<HTMLButtonElement>) => void
  onClose: (e: MouseEvent<HTMLButtonElement>) => void
}

function HistoryEntryFaviconFrame({ expanded, faviconUrl, faviconClassName, loading, isApp, isWorkingSetExtra, canRemoveEntry, canForgetClosedGhost, entryLabel, onForget, onClose }: HistoryEntryFaviconFrameProps) {
  return (
    <span className={cn(
      'history-entry-favicon-frame group/history-favicon-frame relative grid size-4 flex-none place-items-center',
      canRemoveEntry && 'pointer-events-none',
      !loading && !faviconUrl && !isWorkingSetExtra && !canRemoveEntry && 'invisible',
    )}
    >
      <span
        className={cn(
          // The favicon column is the same 16px cell page chips use, so
          // plain rows carry identical icon-to-title spacing to non-app
          // page chips. Standalone-app rows draw the shared 20px app ring
          // with the symmetric negative margins page chips use: the grid
          // track auto-sizes to its content, so an oversized child alone
          // would sit flush-left and overflow only rightward — the margins
          // force the 2px overflow to split evenly, keeping the ring's
          // center-line on the same axis as every plain favicon. The frame
          // keeps full strength — only the icon dims with liveness.
          'history-entry-favicon-content grid place-items-center',
          isApp
            ? 'history-entry-app-favicon -mx-0.5 -my-0.5 size-5 place-content-center overflow-hidden rounded-lg border border-[rgba(115,115,115,0.32)] p-0.5 [corner-shape:squircle]'
            : 'h-full w-full',
          canRemoveEntry && 'title-interaction:group-hover/history-favicon-frame:opacity-0',
        )}
        aria-hidden="true"
      >
        {loading ? <TabLoadingIndicator /> : faviconUrl ? <FaviconImage className={cn('block h-full w-full object-contain', faviconClassName)} src={faviconUrl} alt="" /> : isWorkingSetExtra || canForgetClosedGhost ? <DefaultFavicon className={faviconClassName} /> : null}
      </span>
      {canRemoveEntry && (
        <span
          data-tabout-part={canForgetClosedGhost ? 'forget-hit-owner' : 'close-hit-owner'}
          className="history-entry-close-hit-owner pointer-events-auto absolute top-1/2 left-1/2 z-2 size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full"
          aria-hidden="true"
        />
      )}
      {canRemoveEntry && (
        <button
          type="button"
          data-tabout-part={canForgetClosedGhost ? 'forget-button' : 'close-button'}
          className="history-entry-close history-entry-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-3 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 leading-0 outline-none title-interaction:group-hover/history-favicon-frame:pointer-events-auto title-interaction:group-hover/history-favicon-frame:opacity-100 title-interaction:hover:bg-neutral-600/10 title-interaction:hover:text-foreground title-interaction:hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-(--card-bg) focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
          tabIndex={expanded ? -1 : undefined}
          aria-label={canForgetClosedGhost ? `Remove ${entryLabel} from recently closed` : `Close ${entryLabel}`}
          onClick={canForgetClosedGhost ? onForget : onClose}
        >
          {canForgetClosedGhost ? (
            <EyeOff className="size-3.75" aria-hidden="true" />
          ) : (
            <X className="size-3.75" strokeWidth={2.5} aria-hidden="true" />
          )}
        </button>
      )}
    </span>
  )
}

type HistoryEntryContextMenuProps = {
  entry: TabHistoryEntry
  savedKeys?: ReadonlySet<string> | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  onOpenChange: (open: boolean, details: ContextMenuChangeEventDetails) => void
  children: PageChipContextMenuTriggerElement
}

/**
 * HistoryEntryContextMenu — wraps a history row in the shared page-chip
 * context menu (Reload / Duplicate / Copy title / Copy URL / Save page / Suspend) when at least one action
 * applies; otherwise renders the row untouched.
 */
function HistoryEntryContextMenu({ entry, savedKeys, retainedPageSurfaceMatches = EMPTY_RETAINED_PAGE_SURFACE_MATCHES, onOpenChange, children }: HistoryEntryContextMenuProps) {
  const copyTitleText = entry.title
  const copyUrlText = entry.url
  const saveEligible = isHistoryEntrySaveEligible(entry, retainedPageSurfaceMatches)
  const saved = historyEntrySaved(entry, savedKeys, retainedPageSurfaceMatches)
  const savedActionLabel = saved ? 'Remove saved page' : 'Save page'
  const canShowSuspend = entry.exists && Number.isInteger(entry.tabId)
  const suspendEnabled = canShowSuspend && !entry.suspended

  async function onCopyEntryTitle(e: StopPropagationEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(copyTitleText)
      showToast('Page title copied')
    } catch {
      showToast('Could not copy page title')
    }
  }

  async function onCopyEntryUrl(e: StopPropagationEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(copyUrlText)
      showToast('Page URL copied')
    } catch {
      showToast('Could not copy page URL')
    }
  }

  async function onToggleEntrySaved(e: StopPropagationEvent) {
    e.stopPropagation()
    try {
      if (saved) await removeSavedPageTarget(historyEntrySavedPageKey(entry, retainedPageSurfaceMatches))
      else await savePageTarget(historyEntrySaveTarget(entry, retainedPageSurfaceMatches))
    } catch {
      showToast(saved ? "Couldn't remove the saved page" : "Couldn't save the page")
    }
  }

  function onToggleEntrySuspend(e: StopPropagationEvent) {
    e.stopPropagation()
    if (!Number.isInteger(entry.tabId)) return
    void suspendHistoryEntry({ tabId: entry.tabId, tabUrl: entry.url, rawUrl: entry.rawUrl })
  }

  function onReloadEntry(e: StopPropagationEvent) {
    e.stopPropagation()
    void reloadTabTarget({ tabId: entry.tabId, tabUrl: entry.url })
  }

  function onDuplicateEntry(e: StopPropagationEvent) {
    e.stopPropagation()
    void duplicateTabTarget({ tabId: entry.tabId, tabUrl: entry.url })
  }

  if (!copyTitleText && !copyUrlText && !saveEligible && !canShowSuspend) return children
  return (
    <PageChipContextMenu
      titleText={copyTitleText}
      onCopyTitle={onCopyEntryTitle}
      urlText={copyUrlText}
      onCopyUrl={onCopyEntryUrl}
      saved={saved}
      savedActionLabel={saveEligible ? savedActionLabel : undefined}
      onSavedSelect={saveEligible ? onToggleEntrySaved : undefined}
      onReloadSelect={canShowSuspend ? onReloadEntry : undefined}
      onDuplicateSelect={canShowSuspend ? onDuplicateEntry : undefined}
      suspendEnabled={suspendEnabled}
      onSuspendSelect={canShowSuspend ? onToggleEntrySuspend : undefined}
      onOpenChange={onOpenChange}
    >
      {children}
    </PageChipContextMenu>
  )
}

export function HistoryEntry({ entry, kind, layoutKey, indexLabel, workingSetItem = null, closedTab = null, savedKeys, retainedPageSurfaceMatches = EMPTY_RETAINED_PAGE_SURFACE_MATCHES, highlightTerms = EMPTY_HIGHLIGHT_TERMS, onSnapshotChange, onHistoryLayoutSettled, onHoverUrlChange, onTabsChange, onForgetClosedGhost }: HistoryEntryProps) {
  const contextMenuOpenRef = useRef(false)
  const titleClampKey = JSON.stringify([entry.title, entry.exists, highlightTerms])
  const {
    entryExpansionId,
    entrySlotRef,
    entryRef,
    titleRef,
    titleMetrics,
    titleClamp,
    titleExpanded,
    entrySlotSize,
    entryExpansionGeometry,
    onHistoryEntryPointerEnter,
    onHistoryEntryPointerMove,
    onHistoryEntryPointerLeave,
    onHistoryEntryFocus,
    onHistoryEntryBlur,
    onHistoryEntryContextMenuOpenChange,
  } = useHistoryEntryExpansion(contextMenuOpenRef, titleClampKey)

  const isWorkingSetExtra = !!workingSetItem
  // Open-ghost (Working Set) rows reference a live tab, so they close it like
  // stack rows. Closed-ghost rows are already closed and Chrome exposes no API
  // to delete a recently-closed entry, so they "forget" via a local dismissal.
  const canCloseEntry = entry.exists
  const canForgetClosedGhost = kind === 'closed-ghost' && !!closedTab
  const canRemoveEntry = canCloseEntry || canForgetClosedGhost
  const canActivateEntry = entry.exists || (kind === 'closed-ghost' && !!closedTab)

  const { activateHistoryEntry, onEntryKeyDown, onEntryMouseDown, onCloseEntry, onMouseEnter, onMouseLeave, clearHover } = useHistoryEntryActions({
    hoverOwner: entryExpansionId,
    entry,
    kind,
    workingSetItem,
    closedTab,
    canActivateEntry,
    entrySlotRef,
    contextMenuOpenRef,
    ...omitUndefined({
      onSnapshotChange,
      onHistoryLayoutSettled,
      onHoverUrlChange,
      onTabsChange,
    }),
  })

  async function onForgetEntry(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    if (!closedTab) return
    const row = e.currentTarget.closest('.history-entry-row') || entrySlotRef.current?.closest('.history-entry-row')
    if (startHistoryEntryRemoval(row)) {
      await waitForHistoryEntryMoves()
      onHistoryLayoutSettled?.()
    }
    clearHover()
    onForgetClosedGhost?.(closedTab)
  }

  // Stable ref identity retains the measured contour across passive refreshes.
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- ref identity preserves the capsule observer and its cleanup across rerenders.
  const attachEntrySurface = useCallback((element: HTMLDivElement | null) => {
    entryRef.current = element
    const cleanup = attachPageChipBorder(element)
    return () => {
      cleanup?.()
      entryRef.current = null
    }
  }, [entryRef])

  const activeInOtherWindow = !!entry.activeInOtherWindow && !entry.current
  const isActiveEntry = entry.active || entry.activeInOtherWindow
  // Liveness controls title/icon dimming independently of the shared hover paint.
  const entryClosed = !entry.exists
  const entryCursorClass = entryClosed && canActivateEntry ? 'cursor-pointer' : 'cursor-default'
  const plainClickableEntry = !entry.current && !activeInOtherWindow && !entryClosed && canActivateEntry
  const historyEntryInteractionBg = entry.current
    ? PAGE_CHIP_PAINT.currentBg
    : activeInOtherWindow
      ? PAGE_CHIP_PAINT.activeOtherInteractionBg
      : PAGE_CHIP_PAINT.quietInteractionBg
  const historyEntryInteractionClasses = activeInOtherWindow
    ? HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES
    : entryClosed || canActivateEntry
      ? HISTORY_ENTRY_OUTLINED_INTERACTION_CLASSES
      : HISTORY_ENTRY_INTERACTION_CLASSES
  const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
  const matchUrls = uniqueUrls([
    ...pageTargetMatchUrls(entry),
    ...workingSetUrls(workingSetItem ?? undefined),
  ])
  // Passive snapshots replace objects, but only a changed target invalidates
  // ownership. Titles, favicons, and activation times may update in place.
  const hoverIdentity = JSON.stringify([
    hoverSource,
    pageTargetUrl(workingSetItem ?? entry),
    matchUrls,
    workingSetItem?.tabId ?? (entry.exists ? entry.tabId : undefined),
  ])
  useLayoutEffect(() => () => {
    void onHoverUrlChange?.('', undefined, undefined, undefined, entryExpansionId)
  }, [hoverIdentity, entryExpansionId, onHoverUrlChange])
  const hoverMatched = useHoverStateSelector((state) => (
    !!state.source && state.source !== hoverSource && (
      pageTargetMatchesHover(entry, state.url, state.urls, state.tabIds) ||
      state.tabIds === undefined && matchUrls.some((url) => url === state.url || state.urls.includes(url))
    )
  ))
  const entryLabel = entry.title.replaceAll('\u200E', '').trim() || entry.displayUrl || entry.url
  const faviconUrl = entry.favIconUrl || workingSetItem?.faviconUrl || ''
  // Same liveness rule as page chips: full strength only when an awake tab
  // backs the row. Open-ghost rows derive `suspended` from the suspender url
  // (makeHistoryEntry default), closed rows are exists:false.
  const faviconClassName = faviconLivenessClassName({ closed: entryClosed, suspended: entry.suspended })
  // Audio icon shows on any live (exists) row that is playing or muted — both
  // stack entries and working-set open-ghost rows (the adapter carries the
  // tab's audible/muted). Closed rows are exists:false, so a gone tab gets none.
  const audioState = entry.exists ? audioStateForTab(entry) : null
  function onToggleEntryAudio() {
    if (!audioState || !Number.isInteger(entry.tabId)) return
    void setHistoryEntryMuted(
      { tabId: entry.tabId, tabUrl: entry.url, rawUrl: entry.rawUrl },
      nextMutedForAudioState(audioState),
    )
  }
  function onHistoryEntryMenuOpenChange(open: boolean, details: ContextMenuChangeEventDetails) {
    onHistoryEntryContextMenuOpenChange(open, details)
    if (open) {
      onMouseEnter()
    } else {
      clearHover()
    }
  }

  const entrySlotStyle: CSSVariableProperties | undefined = titleExpanded && entrySlotSize.width > 0 && entrySlotSize.height > 0 ? {
    height: `${entrySlotSize.height}px`,
    width: `${entrySlotSize.width}px`,
  } : undefined
  const entryExpandedMaxWidth = entryExpansionGeometry.maxWidth > 0 ? `${entryExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const entryExpandedWidth = entryExpansionGeometry.width > 0 ? `${entryExpansionGeometry.width}px` : entryExpandedMaxWidth
  const entryExpansionOverflowsSlot = entryExpansionGeometry.viewportConstrained ||
    entryExpansionGeometry.width > entrySlotSize.width + 1
  const entryExpandedTitleWidth = entryExpansionGeometry.titleWidth > 0 ? `${entryExpansionGeometry.titleWidth}px` : `${Math.max(1, titleMetrics.width)}px`
  const entryBaseStyle: CSSVariableProperties = {
    '--history-entry-fade-bg': historyEntryInteractionBg,
    // Plain rows overlap their neighbors by 1px; keep those frames visible
    // through the raised hover fill, as on dashboard chips.
    '--history-entry-interaction-bg': plainClickableEntry
      ? PAGE_CHIP_PAINT.quietInteractionOverlayBg
      : historyEntryInteractionBg,
    '--history-entry-hover-border': PAGE_CHIP_PAINT.quietHoverBorder,
    '--history-entry-rest-bg': activeInOtherWindow ? PAGE_CHIP_PAINT.activeOtherRestBg : 'transparent',
  }
  const entryOverlayStyle: CSSVariableProperties = {
    ...entryBaseStyle,
    '--history-entry-expanded-max-width': entryExpandedMaxWidth,
    '--history-entry-expanded-title-width': entryExpandedTitleWidth,
    '--history-entry-expanded-width': entryExpandedWidth,
    maxWidth: entryExpandedMaxWidth,
    width: entryExpandedWidth,
  }
  // The growing edge needs an inset only while it still meets the resting
  // seam. CSS compares the actual expanded height with the original slot.
  const expandedGrowingEdgeInset = `clamp(0px, calc(${entrySlotSize.height + 1}px - 100%), 1px)`
  function historyEntrySurface(expanded: boolean) {
    return (
      <div
        data-tabout={expanded ? undefined : 'page-chip'}
        data-tabout-context="activation-history"
        data-tabout-part={expanded ? 'expanded-surface' : undefined}
        data-expanded={titleExpanded ? 'true' : undefined}
        data-title-collapsed={(titleMetrics.isTruncated || titleClamp !== null) && !titleExpanded ? '' : undefined}
        data-current={entry.current ? 'true' : undefined}
        data-active={isActiveEntry ? 'true' : undefined}
        data-active-in-other-window={activeInOtherWindow ? 'true' : undefined}
        data-previous-target={entry.previousTarget ? 'true' : undefined}
        data-next-target={entry.nextTarget ? 'true' : undefined}
        aria-hidden={expanded ? true : undefined}
        className={cn(
          "history-entry group/history-entry relative min-w-0 flex-auto rounded-page-chip border-0 [--capsule-fill:transparent] bg-(--capsule-fill) text-tab-live [--history-entry-fade-bg:var(--card-bg)] [corner-shape:superellipse(1.7)] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-0 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:inherit] after:content-[''] group-has-[.history-entry-main:focus-visible]/history-row:outline-2 group-has-[.history-entry-main:focus-visible]/history-row:outline-offset-2 group-has-[.history-entry-main:focus-visible]/history-row:outline-(--accent-amber) focus-within:after:opacity-100",
          entryCursorClass,
          entryClosed && 'history-entry-closed text-tab-closed',
          titleExpanded && 'history-entry-expanded-open',
          // Keep the canonical keyboard target, but paint the translucent rim only once.
          titleExpanded && !expanded && 'opacity-0',
          !expanded && 'title-interaction:hover:z-4 focus-within:z-4 title-interaction:group-data-context-menu-open/history-slot:z-4',
          expanded && 'history-entry-expanded pointer-events-auto absolute left-0 z-30 min-w-0 max-w-(--history-entry-expanded-max-width) select-none overflow-visible! transition-none! w-(--history-entry-expanded-width)',
          expanded && entryExpansionOverflowsSlot && 'shadow-[0_3px_10px_rgba(10,10,10,0.055)]',
          expanded && (entryExpansionGeometry.y === 'up' ? 'bottom-0' : 'top-0'),
          entry.current && PAGE_CHIP_CURRENT_CLASSES,
          !entry.current && historyEntryInteractionClasses,
          hoverMatched && 'history-entry-hover-match outline-1 outline-offset-1 outline-(--accent-amber)',
          hoverMatched && !expanded && 'z-3',
        )}
        style={expanded ? entryOverlayStyle : entryBaseStyle}
        ref={expanded ? attachPageChipBorder : attachEntrySurface}
      >
        {expanded && plainClickableEntry && (
          <span
            ref={attachPageChipBorder}
            className="history-entry-expanded-fill bg-(--capsule-fill) pointer-events-none absolute inset-x-0 -z-1 rounded-[inherit] [corner-shape:inherit]"
            style={{
              top: entryExpansionGeometry.y === 'up' ? expandedGrowingEdgeInset : '1px',
              bottom: entryExpansionGeometry.y === 'down' ? expandedGrowingEdgeInset : '1px',
              '--capsule-fill': historyEntryInteractionBg,
            } as CSSVariableProperties}
            aria-hidden="true"
          />
        )}
        {(entry.current || activeInOtherWindow) && (
          <span
            className={cn(
              'active-history-entry-frame pointer-events-none absolute inset-0 z-2 rounded-[inherit] [corner-shape:inherit]',
              entry.current
                ? 'shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)]'
                : 'shadow-[inset_0_0_0_1px_rgba(115,115,115,0.2)] title-interaction:group-hover/history-entry:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)] group-[.history-entry-expanded-open]/history-entry:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)] title-interaction:group-data-context-menu-open/history-slot:shadow-[inset_0_0_0_1px_rgba(38,38,38,0.55)]',
            )}
            aria-hidden="true"
          />
        )}
        {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- row contains a nested close <button>; a real <button> wrapper would be invalid nested-interactive DOM. */}
        <div
          role="button"
          tabIndex={!expanded && canActivateEntry ? 0 : -1}
          data-tabout-part="focus-button"
          aria-label={entryLabel}
          aria-disabled={!canActivateEntry}
          aria-busy={entry.loading ? true : undefined}
          className={cn('history-entry-main flex w-full items-start gap-2 border-0 bg-transparent px-2.25 py-1.25 text-left text-[13px] font-normal text-inherit font-[inherit] leading-tight outline-none focus-visible:outline-none', entryCursorClass)}
          onClick={canActivateEntry ? activateHistoryEntry : undefined}
          onMouseDownCapture={expanded ? (event) => {
            // Capture before nested controls stop propagation: only the canonical
            // surface may own focus after this painted copy collapses.
            event.preventDefault()
            if (event.target instanceof Element && event.target.closest('[data-tabout-part="audio-toggle"]')) {
              entryRef.current?.querySelector<HTMLButtonElement>('[data-tabout-part="audio-toggle"]')?.focus({ preventScroll: true })
            }
          } : undefined}
          onMouseDown={!expanded && canActivateEntry ? onEntryMouseDown : undefined}
          onKeyDown={expanded ? undefined : onEntryKeyDown}
        >
          <HistoryEntryFaviconFrame
            expanded={expanded}
            faviconUrl={faviconUrl}
            faviconClassName={faviconClassName}
            loading={!!entry.loading}
            isApp={entry.isApp}
            isWorkingSetExtra={isWorkingSetExtra}
            canRemoveEntry={canRemoveEntry}
            canForgetClosedGhost={canForgetClosedGhost}
            entryLabel={entryLabel}
            onForget={onForgetEntry}
            onClose={onCloseEntry}
          />
          {audioState && (
            <TabAudioButton
              state={audioState}
              onToggle={onToggleEntryAudio}
              className="mt-px self-start"
            />
          )}
          <HistoryEntryTitle
            expanded={expanded}
            title={entry.title}
            highlightTerms={highlightTerms}
            mutedTitle={entryClosed}
            geometry={entryExpansionGeometry}
            clampedLineHtml={titleClamp?.key === titleClampKey ? titleClamp.lineHtml : null}
            titleRef={titleRef}
          />
        </div>
      </div>
    )
  }

  const expandedEntryElement = titleExpanded ? historyEntrySurface(true) : null

  return (
    <div
      data-tabout="activation-history-row"
      data-tabout-layout-key={layoutKey}
      data-working-set-extra={isWorkingSetExtra ? 'true' : undefined}
      data-loading={entry.loading ? 'true' : undefined}
      data-pending={entry.pending ? 'true' : undefined}
      className={cn(
        // Cover crossing titles and index markers only while rows are moving.
        'history-entry-row group/history-row flex w-full min-w-0 flex-none items-start gap-2 font-[inherit] [.history-entry-row+&]:-mt-px [&.closing]:pointer-events-none [&.history-entry-layout-moving]:z-2 [&.history-entry-layout-moving]:bg-tab-card',
        entry.current && '[&.history-entry-layout-moving]:z-3',
        titleExpanded && 'history-entry-row-expanded-open',
      )}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <HistoryEntryMarkerCell indexLabel={indexLabel} />
      <HistoryEntryContextMenu entry={entry} savedKeys={savedKeys} retainedPageSurfaceMatches={retainedPageSurfaceMatches} onOpenChange={onHistoryEntryMenuOpenChange}>
        <div
          className="history-entry-slot group/history-slot relative min-w-0 flex-auto"
          style={entrySlotStyle}
          ref={entrySlotRef}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onPointerEnter={onHistoryEntryPointerEnter}
          onPointerMove={onHistoryEntryPointerMove}
          onPointerLeave={onHistoryEntryPointerLeave}
          onFocus={onHistoryEntryFocus}
          onBlur={onHistoryEntryBlur}
        >
          {historyEntrySurface(false)}
          {expandedEntryElement}
        </div>
      </HistoryEntryContextMenu>
    </div>
  )
}
