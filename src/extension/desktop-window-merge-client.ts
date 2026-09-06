import {
  DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE,
  DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE,
  DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE,
  DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE,
  NATIVE_INTEGRATION_PROFILE_SELECT_MESSAGE,
  NATIVE_INTEGRATION_PROFILE_TRANSFER_MESSAGE,
  parseDesktopWindowMergeAcknowledgeResponse,
  parseDesktopWindowMergeConfirmResponse,
  parseDesktopWindowMergePreviewResponse,
  parseDesktopWindowMergeStatusResponse,
  parseNativeIntegrationProfileSelectResponse,
  parseNativeIntegrationProfileTransferResponse,
  type DesktopWindowMergeConfirmResponse,
  type DesktopWindowMergePreviewResponse,
  type DesktopWindowMergeStatusResponse,
  type NativeIntegrationProfileTransferResponse,
} from './desktop-window-merge-contract.js'

async function sendMessage(message: unknown): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch {
    return null
  }
}

export async function getDesktopWindowMergeStatus(
  refreshNativeAvailability = false,
): Promise<
  DesktopWindowMergeStatusResponse | null
> {
  return parseDesktopWindowMergeStatusResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE,
    ...(refreshNativeAvailability ? { refreshNativeAvailability: true } : {}),
  }))
}

export async function selectCurrentNativeIntegrationProfile(): Promise<boolean> {
  const response = parseNativeIntegrationProfileSelectResponse(await sendMessage({
    type: NATIVE_INTEGRATION_PROFILE_SELECT_MESSAGE,
  }))
  return response?.ok === true
}

export async function transferCurrentNativeIntegrationProfile(
  expectedOwnerRevision: string,
): Promise<
  NativeIntegrationProfileTransferResponse
> {
  return parseNativeIntegrationProfileTransferResponse(await sendMessage({
    type: NATIVE_INTEGRATION_PROFILE_TRANSFER_MESSAGE,
    expectedOwnerRevision,
  })) ?? { ok: false, reason: 'indeterminate' }
}

export async function previewDesktopWindowMerge(
  windowId?: number,
): Promise<DesktopWindowMergePreviewResponse | null> {
  return parseDesktopWindowMergePreviewResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE,
    ...(windowId === undefined ? {} : { windowId }),
  }))
}

export async function confirmDesktopWindowMerge(
  previewId: string,
): Promise<DesktopWindowMergeConfirmResponse | null> {
  return parseDesktopWindowMergeConfirmResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE,
    previewId,
  }))
}

export async function acknowledgeDesktopWindowMerge(
  sessionId: string,
): Promise<boolean> {
  const response = parseDesktopWindowMergeAcknowledgeResponse(await sendMessage({
    type: DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE,
    sessionId,
  }))
  return response?.ok === true
}
