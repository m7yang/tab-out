import { useEffect, useRef, useState } from 'react'
import { useRetimer } from 'foxact/use-retimer'
import {
  DESKTOP_WINDOW_MERGE_OPEN_MESSAGE,
  isDesktopWindowMergeStatusChangedMessage,
  type DesktopWindowMergeAvailability,
  type DesktopWindowMergeJournal,
} from '../extension/desktop-window-merge-contract.js'
import {
  getDesktopWindowMergeStatus,
  previewDesktopWindowMerge,
  selectCurrentNativeIntegrationProfile,
  transferCurrentNativeIntegrationProfile,
} from '../extension/desktop-window-merge-client.js'
import {
  desktopWindowMergeConfirmMessage,
  desktopWindowMergeFailureMessage,
} from '../extension/desktop-window-merge-strings.js'
import { moveActiveTabToNewWindow } from '../extension/move-current-tab-action.js'
import { buildOpenTabDedupePlan, type OpenTabDedupePlan } from '../extension/open-tab-dedupe-plan.js'
import {
  closeAllSuspendedTabs,
  closeAllSuspendedTabsAndDedupe,
  dedupeTabs,
} from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'

const DEDUPE_PLAN_REFRESH_DELAY_MS = 150
const TAB_ACTION_STATUS_DELAY_MS = 150
const MACOS_INTEGRATION_SETUP_URL =
  'https://github.com/m7yang/tab-out#optional-macos-hammerspoon-integration'

const popupItemClassName =
  'relative flex w-full min-h-6 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-sm leading-tight text-foreground outline-none select-none [corner-shape:squircle] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50'

const popupSecondaryButtonClassName =
  'inline-flex h-7 cursor-pointer items-center justify-center rounded-lg border border-border bg-transparent px-2.5 text-sm text-foreground outline-none [corner-shape:squircle] hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)'
const popupPrimaryButtonClassName =
  'inline-flex h-7 cursor-pointer items-center justify-center rounded-lg border border-foreground bg-foreground px-2.5 text-sm text-background outline-none [corner-shape:squircle] hover:opacity-[0.88] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)'

type PopupMergePreview = {
  previewId: string
  movingTabCount: number
  sourceWindowCount: number
}

function dedupeItemLabel(plan: OpenTabDedupePlan | null): string {
  if (!plan || plan.closableCount === 0) return 'Dedupe duplicate tabs'
  return `Dedupe ${plan.closableCount} duplicate tab${plan.closableCount === 1 ? '' : 's'}`
}

async function requestMergePreviewForCurrentWindow(): Promise<PopupMergePreview | null> {
  const currentWindow = await chrome.windows.getCurrent().catch(() => null)
  if (typeof currentWindow?.id !== 'number') {
    showToast('Could not identify this Chrome window')
    return null
  }
  const response = await previewDesktopWindowMerge(currentWindow.id)
  if (!response) {
    showToast('Could not check windows on this desktop')
    return null
  }
  if (!response.ok) {
    showToast(desktopWindowMergeFailureMessage(response.reason))
    return null
  }
  if (response.status === 'ready') {
    return {
      previewId: response.previewId,
      movingTabCount: response.movingTabCount,
      sourceWindowCount: response.sourceWindowCount,
    }
  }
  if (response.status === 'already-merged') {
    showToast('All windows on this desktop are already merged.')
    return null
  }
  showToast('Another window merge is already in progress')
  return null
}

async function requestMergeConfirmHandoff(previewId: string): Promise<void> {
  const currentWindow = await chrome.windows.getCurrent().catch(() => null)
  if (typeof currentWindow?.id !== 'number') {
    showToast('Could not identify this Chrome window')
    return
  }
  void chrome.runtime.sendMessage({
    type: DESKTOP_WINDOW_MERGE_OPEN_MESSAGE,
    windowId: currentWindow.id,
    previewId,
  }).catch(() => undefined)
  // The handed-off Tab Out page submits the confirmation in the background —
  // the user's focus stays put while the merge runs — so the menu dismisses
  // itself here.
  window.close()
}

type PendingAction = 'merge' | 'profile-selection' | 'profile-transfer' | 'tab-action'

/**
 * The Tab Actions Menu rendered by popup.html behind the toolbar action.
 * Cleanup items run in this popup page so their result toast and one-shot
 * Undo render inline. The merge item previews here and swaps the menu for a
 * compact confirmation; confirming hands off to a Tab Out page in the
 * invoking window, which submits the confirmation and owns the progress,
 * result, and revalidation surfaces.
 */
export function TabActionsPopup() {
  const pendingActionRef = useRef<PendingAction | null>(null)
  const retimeTabActionStatus = useRetimer()
  const [dedupePlan, setDedupePlan] = useState<OpenTabDedupePlan | null>(null)
  const [availability, setAvailability] =
    useState<DesktopWindowMergeAvailability | null>(null)
  const [mergeSession, setMergeSession] =
    useState<DesktopWindowMergeJournal | null>(null)
  const [mergeConfirm, setMergeConfirm] = useState<PopupMergePreview | null>(null)
  const [profileTransferConfirm, setProfileTransferConfirm] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the returned cleanup clears refreshTimer; the id is reassigned per debounce, which the rule cannot track.
  useEffect(() => {
    let disposed = false
    let latestStatusRequest = 0
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const refreshDedupePlan = () => {
      Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getCurrent(),
      ]).then(([tabs, currentWindow]) => {
        if (disposed) return
        setDedupePlan(buildOpenTabDedupePlan(tabs, currentWindow?.id ?? -1))
      }).catch(() => {
        if (!disposed) setDedupePlan({ closableCount: 0, urls: [] })
      })
    }

    const scheduleDedupePlanRefresh = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        refreshDedupePlan()
      }, DEDUPE_PLAN_REFRESH_DELAY_MS)
    }

    const applyMergeStatus = async (refreshNativeAvailability = false) => {
      latestStatusRequest += 1
      const statusRequest = latestStatusRequest
      const response = await getDesktopWindowMergeStatus(refreshNativeAvailability)
      if (disposed || statusRequest !== latestStatusRequest) return
      if (!response) {
        setAvailability({ available: false, reason: 'coordination-unavailable' })
        return
      }
      setAvailability(response.availability)
      setMergeSession(response.session?.journal ?? null)
      setProfileTransferConfirm((ownerRevision) => (
        ownerRevision &&
        response.availability.available === false &&
        response.availability.reason === 'another-profile-selected' &&
        response.availability.ownerRevision === ownerRevision
          ? ownerRevision
          : null
      ))
      // A session appearing means another surface already merged; the counts
      // in a pending confirmation would be stale, so withdraw it.
      if (response.session?.journal) setMergeConfirm(null)
    }

    refreshDedupePlan()
    void applyMergeStatus(true)
    const onRuntimeMessage = (message: unknown) => {
      if (isDesktopWindowMergeStatusChangedMessage(message)) void applyMergeStatus()
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    chrome.tabs.onCreated.addListener(scheduleDedupePlanRefresh)
    chrome.tabs.onRemoved.addListener(scheduleDedupePlanRefresh)
    chrome.tabs.onUpdated.addListener(scheduleDedupePlanRefresh)
    chrome.tabs.onReplaced.addListener(scheduleDedupePlanRefresh)
    return () => {
      disposed = true
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      retimeTabActionStatus()
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      chrome.tabs.onCreated.removeListener(scheduleDedupePlanRefresh)
      chrome.tabs.onRemoved.removeListener(scheduleDedupePlanRefresh)
      chrome.tabs.onUpdated.removeListener(scheduleDedupePlanRefresh)
      chrome.tabs.onReplaced.removeListener(scheduleDedupePlanRefresh)
    }
  }, [retimeTabActionStatus])

  function runPopupTabAction(action: () => Promise<unknown>) {
    if (
      pendingActionRef.current ||
      mergeSession?.status === 'running'
    ) return
    pendingActionRef.current = 'tab-action'
    retimeTabActionStatus(window.setTimeout(() => {
      setPendingAction('tab-action')
    }, TAB_ACTION_STATUS_DELAY_MS))
    return action()
      .then(() => undefined)
      .finally(() => {
        retimeTabActionStatus()
        pendingActionRef.current = null
        setPendingAction(null)
      })
  }

  function requestMergeConfirmation() {
    if (pendingActionRef.current) return
    pendingActionRef.current = 'merge'
    setPendingAction('merge')
    void requestMergePreviewForCurrentWindow()
      .then((preview) => {
        if (preview) setMergeConfirm(preview)
      })
      .finally(() => {
        pendingActionRef.current = null
        setPendingAction(null)
      })
  }

  function confirmMergeHandoff() {
    const preview = mergeConfirm
    if (!preview || pendingActionRef.current) return
    pendingActionRef.current = 'merge'
    setPendingAction('merge')
    void requestMergeConfirmHandoff(preview.previewId).finally(() => {
      pendingActionRef.current = null
      setPendingAction(null)
    })
  }

  function selectNativeIntegrationProfile() {
    if (
      pendingActionRef.current ||
      mergeSession?.status === 'running'
    ) return
    pendingActionRef.current = 'profile-selection'
    setPendingAction('profile-selection')
    void selectCurrentNativeIntegrationProfile()
      .then(async (selected) => {
        showToast(selected
          ? 'This Chrome profile now owns the macOS integration'
          : 'Could not select this Chrome profile')
        const response = await getDesktopWindowMergeStatus()
        if (response) {
          setAvailability(response.availability)
          setMergeSession(response.session?.journal ?? null)
        }
      })
      .finally(() => {
        pendingActionRef.current = null
        setPendingAction(null)
      })
  }

  function transferNativeIntegrationProfile() {
    const expectedOwnerRevision = profileTransferConfirm
    if (
      !expectedOwnerRevision ||
      pendingActionRef.current ||
      mergeSession?.status === 'running'
    ) return
    pendingActionRef.current = 'profile-transfer'
    setPendingAction('profile-transfer')
    void transferCurrentNativeIntegrationProfile(expectedOwnerRevision)
      .then(async (result) => {
        if (result.ok) {
          setProfileTransferConfirm(null)
          showToast('This profile now owns the macOS integration')
        } else if (result.reason === 'busy') {
          showToast('Finish the current macOS action, then try again')
        } else if (result.reason === 'selection-changed') {
          setProfileTransferConfirm(null)
          showToast('The selected Chrome profile changed. Review and try again')
        } else if (result.reason === 'update-required') {
          setProfileTransferConfirm(null)
          showToast('Update the macOS integration before switching profiles')
        } else if (result.reason === 'indeterminate') {
          setProfileTransferConfirm(null)
          showToast('Could not confirm which profile owns the macOS integration. Reopen the menu to check')
        } else {
          setProfileTransferConfirm(null)
          showToast('Could not switch profiles. Profile ownership did not change')
        }
        const response = await getDesktopWindowMergeStatus()
        if (response) {
          setAvailability(response.availability)
          setMergeSession(response.session?.journal ?? null)
        }
      })
      .finally(() => {
        pendingActionRef.current = null
        setPendingAction(null)
      })
  }

  function openMacosIntegrationSetup() {
    if (pendingActionRef.current) return
    pendingActionRef.current = 'tab-action'
    setPendingAction('tab-action')
    void chrome.tabs.create({ active: true, url: MACOS_INTEGRATION_SETUP_URL })
      .then(() => window.close())
      .catch(() => {
        showToast('Could not open the macOS integration setup guide')
        pendingActionRef.current = null
        setPendingAction(null)
      })
  }

  const mergeUnavailableReason = availability == null
    ? 'Checking macOS integration…'
    : pendingAction === 'profile-selection'
      ? 'Selecting Chrome profile…'
      : pendingAction === 'profile-transfer'
        ? 'Switching Chrome profile…'
        : !availability.available
            ? desktopWindowMergeFailureMessage(availability.reason)
            : pendingAction === 'tab-action'
              ? 'Another tab action is in progress'
              : mergeSession?.status === 'running'
                ? 'A window merge is already in progress'
                : mergeSession
                  ? 'Finish the current window merge result'
                  : pendingAction === 'merge'
                    ? 'Checking windows…'
                    : null
  const profileSelectionRequired = availability?.available === false &&
    availability.reason === 'profile-selection-required'
  const profileTransferAvailable = availability?.available === false &&
    availability.reason === 'another-profile-selected'
  const integrationSetupRequired = availability?.available === false && (
    availability.reason === 'native-integration-required' ||
    availability.reason === 'controller-update-required' ||
    availability.reason === 'profile-transfer-update-required'
  )
  const otherActionsDisabled = pendingAction !== null || mergeSession?.status === 'running'
  const dedupeDisabled =
    otherActionsDisabled || !dedupePlan || dedupePlan.closableCount === 0

  if (mergeConfirm) {
    return (
      <div data-tabout="tab-actions" className="flex w-full flex-col">
        <div data-tabout-part="merge-confirm" className="flex flex-col gap-2.5 p-2">
          <p className="m-0 text-sm leading-5 text-foreground">
            {desktopWindowMergeConfirmMessage(
              mergeConfirm.movingTabCount,
              mergeConfirm.sourceWindowCount,
            )}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-tabout-part="cancel-button"
              autoFocus
              className={popupSecondaryButtonClassName}
              onClick={() => setMergeConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-tabout-part="confirm-button"
              className={popupPrimaryButtonClassName}
              onClick={confirmMergeHandoff}
            >
              Merge windows
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (profileTransferConfirm) {
    return (
      <div data-tabout="tab-actions" className="flex w-full flex-col">
        <div data-tabout-part="profile-transfer-confirm" className="flex flex-col gap-2.5 p-2">
          <p className="m-0 text-sm leading-5 text-foreground">
            Switch the macOS integration to this Chrome profile? First configure
            Hammerspoon&apos;s <code>chromeProfileDirectory</code> for this profile;
            Tab Out cannot verify that setting. The profile that currently owns the
            integration will lose access.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-tabout-part="cancel-button"
              autoFocus
              className={popupSecondaryButtonClassName}
              disabled={pendingAction === 'profile-transfer'}
              onClick={() => setProfileTransferConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-tabout-part="confirm-button"
              className={popupPrimaryButtonClassName}
              disabled={pendingAction === 'profile-transfer'}
              onClick={transferNativeIntegrationProfile}
            >
              {pendingAction === 'profile-transfer' ? 'Switching…' : 'Switch profile'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-tabout="tab-actions" className="flex w-full flex-col">
      <button
        type="button"
        data-tabout-part="dedupe-button"
        className={popupItemClassName}
        disabled={dedupeDisabled}
        onClick={() => {
          const plan = dedupePlan
          if (!plan || plan.urls.length === 0) return
          void runPopupTabAction(() =>
            dedupeTabs({ urls: plan.urls, preservePinnedTabOut: true }))
        }}
      >
        <span className="icon-[lucide--copy-x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">{dedupeItemLabel(dedupePlan)}</span>
      </button>
      <button
        type="button"
        data-tabout-part="close-suspended-button"
        className={popupItemClassName}
        disabled={otherActionsDisabled}
        onClick={() => void runPopupTabAction(closeAllSuspendedTabs)}
      >
        <span className="icon-[lucide--circle-x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Close all suspended tabs</span>
      </button>
      <button
        type="button"
        data-tabout-part="close-suspended-and-dedupe-button"
        className={popupItemClassName}
        disabled={otherActionsDisabled}
        onClick={() => void runPopupTabAction(closeAllSuspendedTabsAndDedupe)}
      >
        <span className="icon-[lucide--list-x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Close all suspended tabs and dedupe</span>
      </button>
      <div role="separator" aria-orientation="horizontal" className="pointer-events-none mx-1 my-1 h-px bg-border" />
      <button
        type="button"
        data-tabout-part="move-current-tab-button"
        className={popupItemClassName}
        disabled={otherActionsDisabled}
        onClick={() => void runPopupTabAction(async () => {
          const moved = await moveActiveTabToNewWindow()
          // The new window takes focus in real Chrome, which closes the
          // popup; closing deliberately keeps that deterministic.
          if (moved) window.close()
        })}
      >
        <span className="icon-[lucide--app-window] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Move current tab to new window</span>
      </button>
      {profileSelectionRequired && (
        <button
          type="button"
          data-tabout-part="select-native-profile-button"
          className={popupItemClassName}
          disabled={otherActionsDisabled}
          onClick={selectNativeIntegrationProfile}
        >
          <span className="icon-[lucide--circle-check-big] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {pendingAction === 'profile-selection'
              ? 'Selecting this Chrome profile…'
              : 'Use this profile for macOS integration'}
          </span>
        </button>
      )}
      {profileTransferAvailable && (
        <button
          type="button"
          data-tabout-part="transfer-native-profile-button"
          className={popupItemClassName}
          disabled={otherActionsDisabled}
          onClick={() => setProfileTransferConfirm(availability.ownerRevision)}
        >
          <span className="icon-[lucide--replace] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">Switch macOS integration to this profile…</span>
        </button>
      )}
      {integrationSetupRequired && (
        <button
          type="button"
          data-tabout-part="setup-native-integration-button"
          className={popupItemClassName}
          disabled={otherActionsDisabled}
          onClick={openMacosIntegrationSetup}
        >
          <span className="icon-[lucide--external-link] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">Set up or update macOS integration…</span>
        </button>
      )}
      <button
        type="button"
        data-tabout-part="merge-desktop-windows-button"
        className={`${popupItemClassName} items-start`}
        aria-label="Merge windows on this desktop"
        disabled={mergeUnavailableReason !== null}
        onClick={requestMergeConfirmation}
      >
        <span className="icon-[lucide--panels-top-left] mt-px size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block">Merge windows on this desktop…</span>
          {mergeUnavailableReason && (
            <span className="mt-0.5 block text-[13px] leading-4 text-muted-foreground">
              {mergeUnavailableReason}
            </span>
          )}
        </span>
      </button>
    </div>
  )
}
