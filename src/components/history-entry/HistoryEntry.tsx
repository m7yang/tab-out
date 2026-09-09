import { useRef } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { EyeOff, X } from 'lucide-react'
import { audioStateForTab, nextMutedForAudioState } from '../../extension/tab-audio.js'
import { duplicateTabTarget, reloadTabTarget, setHistoryEntryMuted, suspendHistoryEntry } from '../../extension/tab-actions'
import { savePageTarget, removeSavedPageTarget } from '../../extension/saved-page-actions.js'
import { historyEntrySaveTarget, historyEntrySaved, historyEntrySavedPageKey, isHistoryEntrySaveEligible } from '../../extension/history-saved-page.js'
import { pageTargetMatchesHover, pageTargetMatchUrls } from '../../extension/page-target.js'
import { showToast } from '../../extension/toast.js'
import { waitForHistoryEntryMoves } from '../../extension/history-entry-move-animation.js'
import { PageChipContextMenu } from '../PageChipContextMenu'
import type { PageChipContextMenuTriggerElement } from '../PageChipContextMenu'
import type { ContextMenuChangeEventDetails } from '../context-menu-outside-press'
import { DefaultFavicon } from '../DefaultFavicon'
import { FaviconImage } from '../FaviconImage'
import { FAVICON_DIM_CLASS_NAME } from '../liveness-dim'
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

const HISTORY_ENTRY_CLICKABLE_INTERACTION_BG = 'color-mix(in srgb, var(--card-bg) 90%, var(--color-neutral-600) 10%)'
const HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG = 'color-mix(in srgb, var(--card-bg) 96.5%, var(--color-neutral-600) 3.5%)'
const HISTORY_ENTRY_ACTIVE_OTHER_REST_BG = 'color-mix(in srgb, var(--card-bg) 92.5%, var(--color-neutral-600) 7.5%)'
const HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_BG = 'color-mix(in srgb, var(--card-bg) 84%, var(--color-neutral-600) 16%)'
const HISTORY_ENTRY_INTERACTION_CLASSES = 'hover:bg-(--history-entry-interaction-bg) focus-within:bg-(--history-entry-interaction-bg) [&.history-entry-expanded-open]:bg-(--history-entry-interaction-bg) [&[data-context-menu-open]]:bg-(--history-entry-interaction-bg) hover:after:opacity-100 [&.history-entry-expanded-open]:after:opacity-100 [&[data-context-menu-open]]:after:opacity-100'
// Every hoverable entry surface answers interaction with a 1px outline beside the
// fill (chip-trim's hover-line recipe), across the same interaction states
// the fill responds to. Focus keeps the amber ring instead. The outline
// color rides a CSS var (set in entryBaseStyle) exactly like the chips'
// --chip-hover-border — an arbitrary color-mix() class does not survive
// Tailwind's extractor: closed rows (dead stack rows and recently-closed
// ghosts) match closed-saved chips at 22% (their faint fill leaves the
// line carrying the signal); open rows (2026-07-15) draw the quiet
// interaction-fill rim instead — the same 10% mix as their clickable fill, laid
// once more at the edge — because the darkened fill already carries the
// open-hover emphasis.
const HISTORY_ENTRY_HOVER_OUTLINE_CLASSES = 'hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-(--history-entry-hover-border) [&.history-entry-expanded-open]:outline [&.history-entry-expanded-open]:outline-1 [&.history-entry-expanded-open]:-outline-offset-1 [&.history-entry-expanded-open]:outline-(--history-entry-hover-border) [&[data-context-menu-open]]:outline [&[data-context-menu-open]]:outline-1 [&[data-context-menu-open]]:-outline-offset-1 [&[data-context-menu-open]]:outline-(--history-entry-hover-border)'
const HISTORY_ENTRY_CLOSED_HOVER_BORDER = 'color-mix(in srgb, var(--color-neutral-600) 22%, transparent)'
const HISTORY_ENTRY_OPEN_HOVER_BORDER = 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)'
const HISTORY_ENTRY_CLICKABLE_INTERACTION_CLASSES = `${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`
const HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_CLASSES = HISTORY_ENTRY_INTERACTION_CLASSES
const HISTORY_ENTRY_CLOSED_INTERACTION_CLASSES = `${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`
const HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES = `bg-(--history-entry-rest-bg) text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.04)] ${HISTORY_ENTRY_INTERACTION_CLASSES} ${HISTORY_ENTRY_HOVER_OUTLINE_CLASSES}`

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
  isIndexHighlighted: boolean
}

// Ghost rows (Working Set extras, recently-closed) render a blank marker
// cell: their open/closed state already reads from the row itself via the
// liveness treatment, so the old amber dot glyphs carried redundant signal.
function HistoryEntryMarkerCell({ indexLabel, isIndexHighlighted }: HistoryEntryMarkerCellProps) {
  const marker: ReactNode = indexLabel
  return (
    <span
      data-tabout-part="history-entry-marker"
      className={cn(
        'mt-1.25 inline-flex h-4 w-5.5 flex-none items-center justify-end gap-px bg-transparent text-xs font-medium tabular-nums text-muted-foreground group-has-[.history-entry:hover]/history-row:text-[rgba(64,64,64,0.76)] group-focus-within/history-row:text-[rgba(64,64,64,0.76)]',
        isIndexHighlighted && 'font-semibold text-tab-live group-has-[.history-entry:hover]/history-row:text-tab-live group-focus-within/history-row:text-tab-live',
      )}
    >
      {marker}
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
        : highlightedTextNodes(title, highlightTerms, 'history-entry-title', createBionicTitleTextRenderer(title))
  const titleContentKey = clampedLineHtml && clampedLineHtml.length > 1
    ? 'captured'
    : 'natural'
  return (
    <span className="history-entry-title-expansion-hit-area -my-1.25 flex min-w-0 flex-auto py-1.25">
      <span className="flex min-w-0 flex-auto items-start gap-1.5">
        <span
          className={cn(
            "history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [font-size:inherit] [font-weight:inherit] [hyphenate-character:''] wrap-break-word [&.history-entry-title-truncated]:mask-(--title-fade-mask)",
            mutedTitle ? 'text-tab-closed' : 'text-tab-live',
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
  faviconDimmed: boolean
  loading: boolean
  isApp: boolean
  isWorkingSetExtra: boolean
  canRemoveEntry: boolean
  canForgetClosedGhost: boolean
  entryLabel: string
  onForget: (e: MouseEvent<HTMLButtonElement>) => void
  onClose: (e: MouseEvent<HTMLButtonElement>) => void
}

function HistoryEntryFaviconFrame({ expanded, faviconUrl, faviconDimmed, loading, isApp, isWorkingSetExtra, canRemoveEntry, canForgetClosedGhost, entryLabel, onForget, onClose }: HistoryEntryFaviconFrameProps) {
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
          canRemoveEntry && 'group-hover/history-favicon-frame:opacity-0',
        )}
        aria-hidden="true"
      >
        {loading ? <TabLoadingIndicator /> : faviconUrl ? <FaviconImage className={cn('block h-full w-full object-contain', faviconDimmed && FAVICON_DIM_CLASS_NAME)} src={faviconUrl} alt="" /> : isWorkingSetExtra || canForgetClosedGhost ? <DefaultFavicon className={faviconDimmed ? FAVICON_DIM_CLASS_NAME : ''} /> : null}
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
          className="history-entry-close history-entry-close-favicon pointer-events-none absolute top-1/2 left-1/2 z-3 inline-flex size-5 -translate-x-1/2 -translate-y-1/2 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground opacity-0 leading-0 outline-none group-hover/history-favicon-frame:pointer-events-auto group-hover/history-favicon-frame:opacity-100 hover:bg-neutral-600/10 hover:text-foreground hover:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-(--card-bg) focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
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
  const titleClampKey = JSON.stringify([entry.title, highlightTerms])
  const {
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

  const { activateHistoryEntry, onEntryKeyDown, onEntryMouseDown, onCloseEntry, onMouseEnter, onMouseLeave } = useHistoryEntryActions({
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
    onHoverUrlChange?.('')
    onForgetClosedGhost?.(closedTab)
  }

  const activeInOtherWindow = !!entry.activeInOtherWindow && !entry.current
  const isActiveEntry = entry.active || entry.activeInOtherWindow
  // Closed rows (no open tab) mirror closed-saved page chips: muted title,
  // dimmed favicon, and the group-style hover (lighter fill + outline).
  // The closed branch outranks canActivateEntry — closed ghosts are
  // activatable (reopen) but must not read as live clickable rows.
  const entryClosed = !entry.exists
  const historyEntryInteractionBg = entry.current
    ? 'var(--color-neutral-100)'
    : activeInOtherWindow
      ? HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_BG
      : entryClosed
        ? HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG
        : canActivateEntry
          ? HISTORY_ENTRY_CLICKABLE_INTERACTION_BG
          : HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG
  const historyEntryInteractionClasses = activeInOtherWindow
    ? HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES
    : entryClosed
      ? HISTORY_ENTRY_CLOSED_INTERACTION_CLASSES
      : canActivateEntry
        ? HISTORY_ENTRY_CLICKABLE_INTERACTION_CLASSES
        : HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_CLASSES
  const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
  const matchUrls = uniqueUrls([
    ...pageTargetMatchUrls(entry),
    ...workingSetUrls(workingSetItem ?? undefined),
  ])
  const hoverMatched = useHoverStateSelector((state) => (
    !!state.source && state.source !== hoverSource && (
      pageTargetMatchesHover(entry, state.url, state.urls) ||
      matchUrls.some((url) => url === state.url || state.urls.includes(url))
    )
  ))
  const isIndexHighlighted = isActiveEntry || entry.previousTarget || entry.nextTarget || hoverMatched
  const entryLabel = entry.title || entry.displayUrl || entry.url
  const faviconUrl = entry.favIconUrl || workingSetItem?.faviconUrl || ''
  // Same liveness rule as page chips: full strength only when an awake tab
  // backs the row. Open-ghost rows derive `suspended` from the suspender url
  // (makeHistoryEntry default), closed rows are exists:false.
  const faviconDimmed = !entry.exists || entry.suspended
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
      onHoverUrlChange?.('')
    }
  }

  const entrySlotStyle: CSSVariableProperties | undefined = titleExpanded && entrySlotSize.width > 0 && entrySlotSize.height > 0 ? {
    height: `${entrySlotSize.height}px`,
    width: `${entrySlotSize.width}px`,
  } : undefined
  const entryExpandedMaxWidth = entryExpansionGeometry.maxWidth > 0 ? `${entryExpansionGeometry.maxWidth}px` : 'calc(100vw - 16px)'
  const entryExpandedWidth = entryExpansionGeometry.width > 0 ? `${entryExpansionGeometry.width}px` : entryExpandedMaxWidth
  const entryExpandedTitleWidth = entryExpansionGeometry.titleWidth > 0 ? `${entryExpansionGeometry.titleWidth}px` : `${Math.max(1, titleMetrics.width)}px`
  const entryBaseStyle: CSSVariableProperties = {
    '--history-entry-fade-bg': historyEntryInteractionBg,
    '--history-entry-interaction-bg': historyEntryInteractionBg,
    '--history-entry-hover-border': entryClosed ? HISTORY_ENTRY_CLOSED_HOVER_BORDER : HISTORY_ENTRY_OPEN_HOVER_BORDER,
    '--history-entry-rest-bg': activeInOtherWindow ? HISTORY_ENTRY_ACTIVE_OTHER_REST_BG : 'transparent',
  }
  const entryOverlayStyle: CSSVariableProperties = {
    ...entryBaseStyle,
    '--history-entry-expanded-max-width': entryExpandedMaxWidth,
    '--history-entry-expanded-title-width': entryExpandedTitleWidth,
    '--history-entry-expanded-width': entryExpandedWidth,
    maxWidth: entryExpandedMaxWidth,
    width: entryExpandedWidth,
  }
  function historyEntrySurface(expanded: boolean) {
    return (
      <div
        data-expanded={titleExpanded ? 'true' : undefined}
        data-current={entry.current ? 'true' : undefined}
        data-active={isActiveEntry ? 'true' : undefined}
        data-active-in-other-window={activeInOtherWindow ? 'true' : undefined}
        data-previous-target={entry.previousTarget ? 'true' : undefined}
        data-next-target={entry.nextTarget ? 'true' : undefined}
        aria-hidden={expanded ? true : undefined}
        className={cn(
          "history-entry group/history-entry relative min-w-0 flex-auto rounded-[10px] border-0 bg-transparent text-tab-live [--history-entry-fade-bg:var(--card-bg)] [corner-shape:squircle] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-0 after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,var(--history-entry-fade-bg)_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] focus-within:shadow-[inset_0_0_0_1px_rgba(234,179,8,0.42)] focus-within:after:opacity-100",
          entryClosed && 'history-entry-closed text-tab-closed',
          titleExpanded && 'history-entry-expanded-open',
          expanded && 'history-entry-expanded pointer-events-none absolute left-0 z-30 min-w-0 max-w-(--history-entry-expanded-max-width) cursor-default select-none overflow-visible! transition-none! w-(--history-entry-expanded-width) shadow-[0_3px_10px_rgba(10,10,10,0.055)]',
          expanded && (entryExpansionGeometry.y === 'up' ? 'bottom-0' : 'top-0'),
          entry.current && 'bg-neutral-100 text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400 [--history-entry-fade-bg:var(--color-neutral-100)]',
          !entry.current && historyEntryInteractionClasses,
          hoverMatched && 'history-entry-hover-match outline-1 outline-offset-1 outline-(--accent-amber)',
        )}
        style={expanded ? entryOverlayStyle : entryBaseStyle}
        ref={expanded ? undefined : entryRef}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onPointerEnter={onHistoryEntryPointerEnter}
        onPointerMove={onHistoryEntryPointerMove}
        onPointerLeave={onHistoryEntryPointerLeave}
        onFocus={(e) => {
          if (expanded) onMouseEnter()
          onHistoryEntryFocus(e)
        }}
        onBlur={(e) => {
          if (expanded) onMouseLeave()
          onHistoryEntryBlur(e)
        }}
      >
        {entry.current && (
          <span
            className="active-history-entry-frame pointer-events-none absolute inset-0 z-2 rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(82,82,82,0.48)] [corner-shape:squircle]"
            aria-hidden="true"
          />
        )}
        {expanded && entryExpansionGeometry.scrollbarShieldWidth > 0 && (
          <span
            data-tabout-part="history-scrollbar-input-shield"
            className="history-entry-scrollbar-input-shield pointer-events-auto absolute top-0 bottom-0 z-3"
            style={{
              left: `${entryExpansionGeometry.scrollbarShieldLeft}px`,
              width: `${entryExpansionGeometry.scrollbarShieldWidth}px`,
            }}
            aria-hidden="true"
          />
        )}
        {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- row contains a nested close <button>; a real <button> wrapper would be invalid nested-interactive DOM. */}
        <div
          role="button"
          tabIndex={!expanded && canActivateEntry ? 0 : -1}
          data-tabout-part="focus-button"
          aria-label={entryLabel}
          aria-disabled={!canActivateEntry || expanded}
          aria-busy={entry.loading ? true : undefined}
          className="history-entry-main flex w-full cursor-default items-start gap-2 border-0 bg-transparent px-2.25 py-1.25 text-left text-[13px] font-normal text-inherit font-[inherit] leading-tight outline-none focus-visible:outline-none"
          onClick={!expanded && canActivateEntry ? activateHistoryEntry : undefined}
          onMouseDown={!expanded && canActivateEntry ? onEntryMouseDown : undefined}
          onKeyDown={expanded ? undefined : onEntryKeyDown}
        >
          <HistoryEntryFaviconFrame
            expanded={expanded}
            faviconUrl={faviconUrl}
            faviconDimmed={faviconDimmed}
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
      data-tabout="activation-history-entry"
      data-tabout-layout-key={layoutKey}
      data-working-set-extra={isWorkingSetExtra ? 'true' : undefined}
      data-loading={entry.loading ? 'true' : undefined}
      data-pending={entry.pending ? 'true' : undefined}
      className={cn(
        'history-entry-row group/history-row flex w-full min-w-0 flex-none items-start gap-2 font-[inherit] [&.closing]:pointer-events-none',
        titleExpanded && 'history-entry-row-expanded-open',
      )}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <HistoryEntryMarkerCell
        indexLabel={indexLabel}
        isIndexHighlighted={isIndexHighlighted}
      />
      <div
        className="history-entry-slot relative min-w-0 flex-auto"
        style={entrySlotStyle}
        ref={entrySlotRef}
      >
        <HistoryEntryContextMenu entry={entry} savedKeys={savedKeys} retainedPageSurfaceMatches={retainedPageSurfaceMatches} onOpenChange={onHistoryEntryMenuOpenChange}>
          {historyEntrySurface(false)}
        </HistoryEntryContextMenu>
        {expandedEntryElement}
      </div>
    </div>
  )
}
