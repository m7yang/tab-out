import type { KeyboardEvent, MouseEvent, RefObject } from 'react'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntryResult } from '../../extension/tab-history.js'
import { restoreClosedTab } from '../../extension/closed-tab-actions.js'
import type { ClosedTabEntry } from '../../extension/closed-tabs.js'
import { focusWorkingSetItemResult } from '../../extension/working-set-client.js'
import { tabFocusResultToastMessage, type ExistingTabFocusResult } from '../../extension/tab-focus.js'
import { pageTargetMatchUrls, pageTargetUrl } from '../../extension/page-target.js'
import { markClosure } from '../../extension/undo.js'
import { showToast } from '../../extension/toast.js'
import { chipActivationMode, performDashboardItemActivation, shouldSuppressSelectionForGesture } from '../../extension/tab-activation.js'
import { animateHistoryEntryMoves, snapshotHistoryEntryPositions, waitForHistoryEntryMoves } from '../../extension/history-entry-move-animation.js'
import { startLayoutRemovalAnimation } from '../LayoutRemovalAnimation.js'
import type { HoverUrlChangeHandler, HoverUrlSource, SnapshotChangeHandler, TabsChangeHandler } from '../types'
import type { TabHistoryEntry, WorkingSetItem } from '../../extension/types'
import type { HistoryEntryKind } from './types.js'

export function startHistoryEntryRemoval(row: Element | null | undefined): boolean {
  if (!(row instanceof HTMLElement)) return false
  const root = row.closest<HTMLElement>('.history-entry-list-content')
  const positions = snapshotHistoryEntryPositions(root)
  return startLayoutRemovalAnimation(row, {
    ghostClassName: 'history-entry-closing-ghost',
    onAfterRemove: () => animateHistoryEntryMoves(root, positions),
  })
}

export function workingSetUrls(item: WorkingSetItem | null | undefined) {
  return item ? [...new Set([...pageTargetMatchUrls(item), item.key].filter(Boolean))] : []
}

export function uniqueUrls(urls: readonly string[]) {
  return [...new Set(urls.filter(Boolean))]
}

type HistoryEntryActionsOptions = {
  entry: TabHistoryEntry
  kind: HistoryEntryKind
  workingSetItem: WorkingSetItem | null
  closedTab: ClosedTabEntry | null
  canActivateEntry: boolean
  entrySlotRef: RefObject<HTMLDivElement | null>
  contextMenuOpenRef: RefObject<boolean>
  onSnapshotChange?: SnapshotChangeHandler
  onHistoryLayoutSettled?: () => void
  onHoverUrlChange?: HoverUrlChangeHandler
  onTabsChange?: TabsChangeHandler
}

export function useHistoryEntryActions({ entry, kind, workingSetItem, closedTab, canActivateEntry, entrySlotRef, contextMenuOpenRef, onSnapshotChange, onHistoryLayoutSettled, onHoverUrlChange, onTabsChange }: HistoryEntryActionsOptions) {
  function focusChangedActiveTab(result: ExistingTabFocusResult): boolean {
    const message = tabFocusResultToastMessage(result.status)
    if (message) showToast(message)
    return result.status === 'focused' || result.status === 'activated'
  }

  async function refreshAfterMutation() {
    try {
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
    } catch {
      // The browser mutation is already authoritative; an unavailable refresh
      // must not turn it into a failed action or suppress Undo/success state.
    }
  }

  async function onFocusEntry() {
    if (kind === 'closed-ghost' && closedTab) {
      const ok = await restoreClosedTab(closedTab.sessionId)
      if (!ok) {
        showToast("Couldn't reopen that tab")
        return
      }
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
      return
    }

    if (workingSetItem) {
      const result = await focusWorkingSetItemResult(workingSetItem)
      if (!focusChangedActiveTab(result)) return
      if (onTabsChange) {
        await onTabsChange()
        return
      }
      onSnapshotChange?.(await fetchTabHistorySnapshot())
      return
    }

    const result = await focusHistoryEntryResult(entry)
    if (!focusChangedActiveTab(result)) return
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  async function activateHistoryEntry(e?: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    await onHoverUrlChange?.('')
    const mode = chipActivationMode(e)
    const hasLiveTab = !!workingSetItem || entry.exists
    const tabId = workingSetItem ? workingSetItem.tabId : entry.tabId
    const tabUrl = workingSetItem ? workingSetItem.tabUrl : entry.url
    const rawUrl = workingSetItem ? workingSetItem.rawUrl : entry.rawUrl
    // Only a plain click restores a closed session. Modifier gestures on a
    // no-live-target row follow the same URL-opening contract as other chips:
    // background/foreground in this window, or a new window for Shift.
    if (mode === 'focus') {
      await onFocusEntry()
      return
    }
    const activationResult = await performDashboardItemActivation(
      mode,
      { tabId, tabUrl, rawUrl },
      { moveExisting: hasLiveTab },
    )
    if (activationResult === 'handled') await refreshAfterMutation()
  }

  function onEntryKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (!canActivateEntry) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    void activateHistoryEntry(e)
  }

  function onEntryMouseDown(e: MouseEvent<HTMLDivElement>) {
    // Shift-click moves the tab into a new window; ⌘-click moves it into this window.
    // Cancel the browser's native text selection for those gestures only so the row behaves like a link
    // (a plain click still drag-selects). See tab-activation.ts.
    if (shouldSuppressSelectionForGesture(e)) e.preventDefault()
  }

  async function onCloseEntry(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const row = e.currentTarget.closest('.history-entry-row') || entrySlotRef.current?.closest('.history-entry-row')
    const result = await closeHistoryEntry(entry)
    if (!result.closed) {
      if (result.status === 'unknown') {
        showToast("Couldn't read open tabs, so the tab wasn't closed")
      } else if (result.status === 'failed') {
        showToast("Couldn't close that tab")
      } else {
        showToast('Nothing to close')
      }
      return
    }

    if (result.snapshot.length > 0) {
      markClosure(result.snapshot, 'Tab closed')
    } else {
      showToast('Tab closed')
    }

    if (startHistoryEntryRemoval(row)) {
      await waitForHistoryEntryMoves()
      onHistoryLayoutSettled?.()
    }
    onHoverUrlChange?.('')
    await refreshAfterMutation()
  }

  function onMouseEnter() {
    const hoverSource: HoverUrlSource = workingSetItem ? 'working-set' : 'history'
    const hoverUrl = workingSetItem ? pageTargetUrl(workingSetItem) : pageTargetUrl(entry)
    const hoverUrls = uniqueUrls([
      ...pageTargetMatchUrls(entry),
      ...workingSetUrls(workingSetItem ?? undefined),
    ])
    const tabId = workingSetItem?.tabId ?? (entry.exists ? entry.tabId : undefined)
    onHoverUrlChange?.(hoverUrl, hoverSource, hoverUrls, tabId)
  }

  function onMouseLeave() {
    if (contextMenuOpenRef.current) return
    onHoverUrlChange?.('')
  }

  return { activateHistoryEntry, onEntryKeyDown, onEntryMouseDown, onCloseEntry, onMouseEnter, onMouseLeave }
}
