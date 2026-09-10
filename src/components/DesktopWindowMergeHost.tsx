import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  isDesktopWindowMergeStatusChangedMessage,
  parseDesktopWindowMergeStartConfirmMessage,
  type DesktopWindowMergeJournal,
} from '../extension/desktop-window-merge-contract.js'
import {
  acknowledgeDesktopWindowMerge,
  confirmDesktopWindowMerge,
  getDesktopWindowMergeStatus,
  previewDesktopWindowMerge,
} from '../extension/desktop-window-merge-client.js'
import {
  desktopWindowMergeFailureMessage,
  desktopWindowMergeSuccessMessage,
} from '../extension/desktop-window-merge-strings.js'
import { showToast } from '../extension/toast.js'
import {
  DesktopWindowMergeDialog,
  type DesktopWindowMergeDialogState,
} from './DesktopWindowMergeDialog'

/**
 * A menu-confirmed merge runs on this page while it stays in the background,
 * so the user's focus never moves on the happy path. When a dialog genuinely
 * needs them — a revalidation re-confirmation or a non-success result — the
 * page surfaces itself.
 */
async function bringThisPageForward(): Promise<void> {
  const tab = await chrome.tabs.getCurrent().catch(() => undefined)
  if (typeof tab?.id !== 'number') return
  await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined)
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
  }
}

function showDesktopWindowMergeBackgroundReport(title: string): void {
  const options = document.visibilityState === 'visible'
    ? undefined
    : { timeout: 0 }
  showToast(title, null, options)
}

/**
 * Dashboard-page host for Desktop Window Merge: owns the progress, result,
 * and revalidation dialogs plus the journal status listener. The user
 * previews and confirms in the toolbar Tab Actions Menu popup; its handoff
 * delivers the start-confirm intent to this page in the background, and this
 * page submits the confirmation so it becomes the journal owner. When
 * confirmation-time revalidation reports changes, this page asks again with
 * fresh counts through the full dialog.
 */
export function DesktopWindowMergeHost() {
  const mergeResultAcknowledgementPendingRef = useRef(false)
  const handledSessionIdsRef = useRef(new Set<string>())
  const mergePendingRef = useRef(false)
  const mergeSessionRef = useRef<DesktopWindowMergeJournal | null>(null)
  const [dialogState, setDialogState] =
    useState<DesktopWindowMergeDialogState | null>(null)
  async function confirmMerge(previewId: string) {
    // The handoff retries delivery until acknowledged; a lost acknowledgement
    // must not submit the same confirmation twice.
    if (mergePendingRef.current) return
    setDialogState({ kind: 'progress' })
    mergePendingRef.current = true
    await runMergeConfirmation(previewId).finally(() => {
      mergePendingRef.current = false
    })
  }

  async function runMergeConfirmation(previewId: string) {
    const response = await confirmDesktopWindowMerge(previewId)
    if (!response) {
      setDialogState(null)
      showToast('Could not read the window merge result')
      return
    }
    if (!response.ok) {
      setDialogState(null)
      showToast(desktopWindowMergeFailureMessage(response.reason))
      return
    }
    if (response.status === 'changed') {
      // The replacement preview returned by confirmation was captured while
      // this owner was still inactive. Surface it first, then capture the
      // snapshot that the user will actually approve.
      await bringThisPageForward()
      const refreshed = await previewDesktopWindowMerge()
      if (!refreshed) {
        setDialogState(null)
        showToast('Could not read the window merge preview')
        return
      }
      if (!refreshed.ok) {
        setDialogState(null)
        showToast(desktopWindowMergeFailureMessage(refreshed.reason))
        return
      }
      if (refreshed.status !== 'ready') {
        setDialogState(null)
        showToast(refreshed.status === 'already-merged'
          ? 'All windows on this desktop are already merged.'
          : 'Another window merge is already in progress')
        return
      }
      setDialogState({
        kind: 'confirm',
        movingTabCount: refreshed.movingTabCount,
        notice: 'The windows or tabs changed. Review the updated counts before merging.',
        previewId: refreshed.previewId,
        sourceWindowCount: refreshed.sourceWindowCount,
      })
      return
    }
    if (response.status === 'already-merged') {
      setDialogState(null)
      showDesktopWindowMergeBackgroundReport(
        'All windows on this desktop are already merged.',
      )
      return
    }
    if (response.status === 'busy') {
      setDialogState(null)
      showToast('Another window merge is already in progress')
      return
    }
    if (!('journal' in response)) return

    if (handledSessionIdsRef.current.has(response.journal.sessionId)) {
      if (response.status === 'succeeded') setDialogState(null)
      return
    }
    handledSessionIdsRef.current.add(response.journal.sessionId)
    mergeSessionRef.current = response.journal
    if (response.status === 'succeeded') {
      setDialogState(null)
      showDesktopWindowMergeBackgroundReport(
        desktopWindowMergeSuccessMessage(response.journal),
      )
      const acknowledged = await acknowledgeDesktopWindowMerge(response.journal.sessionId)
      if (!acknowledged) {
        handledSessionIdsRef.current.delete(response.journal.sessionId)
      } else {
        mergeSessionRef.current = null
      }
      return
    }
    setDialogState({ kind: 'result', journal: response.journal })
    void bringThisPageForward()
  }

  // The mount-once message listener reaches the current confirmMerge through
  // this effect event instead of a ref it would otherwise have to re-sync after
  // every render. The compiler needs confirmMerge declared above this point.
  const confirmMergeFromMessage = useEffectEvent((previewId: string) => {
    void confirmMerge(previewId)
  })

  useEffect(() => {
    let disposed = false
    let latestStatusRequest = 0

    const applyStatus = async () => {
      latestStatusRequest += 1
      const statusRequest = latestStatusRequest
      const response = await getDesktopWindowMergeStatus()
      if (disposed || statusRequest !== latestStatusRequest) return
      if (!response) return
      mergeSessionRef.current = response.session?.journal ?? null
      const owned = response.session
      if (!owned?.isOwner) return
      const journal = owned.journal
      if (journal.status === 'running') {
        setDialogState((current) =>
          current?.kind === 'result' ? current : { kind: 'progress' })
        return
      }
      if (handledSessionIdsRef.current.has(journal.sessionId)) return
      handledSessionIdsRef.current.add(journal.sessionId)
      if (journal.status === 'succeeded') {
        setDialogState(null)
        showDesktopWindowMergeBackgroundReport(desktopWindowMergeSuccessMessage(journal))
        const acknowledged = await acknowledgeDesktopWindowMerge(journal.sessionId)
        if (!acknowledged) handledSessionIdsRef.current.delete(journal.sessionId)
        else if (!disposed) mergeSessionRef.current = null
        return
      }
      setDialogState({ kind: 'result', journal })
      void bringThisPageForward()
    }

    void applyStatus()
    const onRuntimeMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      if (isDesktopWindowMergeStatusChangedMessage(message)) {
        void applyStatus()
        return undefined
      }
      const startConfirmRequest = parseDesktopWindowMergeStartConfirmMessage(message)
      if (startConfirmRequest) {
        sendResponse({ ok: true })
        confirmMergeFromMessage(startConfirmRequest.previewId)
        return undefined
      }
      return undefined
    }
    const onWindowFocus = () => void applyStatus()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void applyStatus()
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      latestStatusRequest += 1
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  async function closeMergeResult(journal: DesktopWindowMergeJournal) {
    if (mergeResultAcknowledgementPendingRef.current) return
    mergeResultAcknowledgementPendingRef.current = true
    const acknowledged = await acknowledgeDesktopWindowMerge(journal.sessionId).finally(() => {
      mergeResultAcknowledgementPendingRef.current = false
    })
    if (!acknowledged) {
      handledSessionIdsRef.current.delete(journal.sessionId)
      setDialogState({ kind: 'result', journal })
      showToast('Could not clear the window merge result')
    } else {
      setDialogState(null)
      mergeSessionRef.current = null
    }
  }

  function onDialogOpenChange(open: boolean) {
    if (open || !dialogState) return
    if (dialogState.kind === 'result') {
      void closeMergeResult(dialogState.journal)
    } else {
      setDialogState(null)
    }
  }

  return (
    <DesktopWindowMergeDialog
      state={dialogState}
      onCloseResult={(journal) => void closeMergeResult(journal)}
      onConfirm={(previewId) => void confirmMerge(previewId)}
      onOpenChange={onDialogOpenChange}
    />
  )
}
