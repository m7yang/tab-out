import { Schema } from 'effect'

export const DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE =
  'tab-out:get-desktop-window-merge-status'
export const DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE =
  'tab-out:preview-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE =
  'tab-out:confirm-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE =
  'tab-out:acknowledge-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE =
  'tab-out:desktop-window-merge-status-changed'
export const DESKTOP_WINDOW_MERGE_OPEN_MESSAGE =
  'tab-out:open-desktop-window-merge'
export const DESKTOP_WINDOW_MERGE_START_CONFIRM_MESSAGE =
  'tab-out:start-desktop-window-merge-confirm'
export const NATIVE_INTEGRATION_PROFILE_SELECT_MESSAGE =
  'tab-out:select-native-integration-profile'
export const NATIVE_INTEGRATION_PROFILE_TRANSFER_MESSAGE =
  'tab-out:transfer-native-integration-profile'

export const DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY =
  'desktopWindowMergeSessionV1'

const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0))
const nonNegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const opaqueIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)

const desktopWindowMergeAvailabilityReasonWithoutTransferSchema = Schema.Literals([
  'controller-update-required',
  'coordination-unavailable',
  'native-integration-checking',
  'native-integration-required',
  'profile-selection-required',
  'profile-transfer-update-required',
  'session-storage-unavailable',
])

export const desktopWindowMergeRequestFailureReasonSchema = Schema.Literals([
  'another-profile-selected',
  'browser-read-failed',
  'controller-update-required',
  'coordination-unavailable',
  'desktop-selection-unavailable',
  'native-integration-checking',
  'native-integration-required',
  'profile-transfer-update-required',
  'profile-selection-required',
  'session-storage-unavailable',
])

export type DesktopWindowMergeRequestFailureReason =
  typeof desktopWindowMergeRequestFailureReasonSchema.Type

const desktopWindowMergeErrorCodeSchema = Schema.Literals([
  'browser-mutation-failed',
  'interrupted',
  'session-storage-unavailable',
])

const desktopWindowMergeJournalSchema = Schema.Struct({
  version: Schema.Literals([1]),
  sessionId: opaqueIdSchema,
  status: Schema.Literals(['running', 'succeeded', 'partial', 'interrupted']),
  ownerTabId: positiveIntegerSchema,
  destinationWindowId: positiveIntegerSchema,
  sourceWindowCount: positiveIntegerSchema,
  plannedTabCount: positiveIntegerSchema,
  movedTabCount: nonNegativeIntegerSchema,
  remainingTabCount: nonNegativeIntegerSchema,
  startedAtMs: Schema.Finite,
  updatedAtMs: Schema.Finite,
  errorCode: Schema.optionalKey(desktopWindowMergeErrorCodeSchema),
}).check(Schema.makeFilter((journal) => {
  if (journal.movedTabCount + journal.remainingTabCount !== journal.plannedTabCount) {
    return 'Moved and remaining tab counts must equal the planned tab count'
  }
  if (journal.updatedAtMs < journal.startedAtMs) {
    return 'The window merge update time cannot precede its start time'
  }
  if (journal.status === 'running') {
    return journal.errorCode === undefined
      ? undefined
      : 'A running window merge cannot have an error code'
  }
  if (journal.status === 'succeeded') {
    return journal.remainingTabCount === 0 && journal.errorCode === undefined
      ? undefined
      : 'A successful window merge must have no remaining tabs or error code'
  }
  if (journal.status === 'interrupted') {
    return journal.errorCode === 'interrupted'
      ? undefined
      : 'An interrupted window merge must use the interrupted error code'
  }
  return journal.errorCode === undefined
    ? 'A partial window merge must have an error code'
    : undefined
}))

export type DesktopWindowMergeJournal =
  typeof desktopWindowMergeJournalSchema.Type

const desktopWindowMergeAvailabilitySchema = Schema.Union([
  Schema.Struct({ available: Schema.Literals([true]) }),
  Schema.Struct({
    available: Schema.Literals([false]),
    reason: desktopWindowMergeAvailabilityReasonWithoutTransferSchema,
  }),
  Schema.Struct({
    available: Schema.Literals([false]),
    reason: Schema.Literals(['another-profile-selected']),
    ownerRevision: opaqueIdSchema,
  }),
])

export type DesktopWindowMergeAvailability =
  typeof desktopWindowMergeAvailabilitySchema.Type

const desktopWindowMergeStatusResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  availability: desktopWindowMergeAvailabilitySchema,
  session: Schema.NullOr(Schema.Struct({
    journal: desktopWindowMergeJournalSchema,
    isOwner: Schema.Boolean,
  })),
})

const desktopWindowMergePreviewResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['ready']),
    previewId: opaqueIdSchema,
    sourceWindowCount: positiveIntegerSchema,
    movingTabCount: positiveIntegerSchema,
  }),
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['already-merged', 'busy']),
  }),
  Schema.Struct({
    ok: Schema.Literals([false]),
    reason: desktopWindowMergeRequestFailureReasonSchema,
  }),
])

const desktopWindowMergeConfirmResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['succeeded', 'partial']),
    journal: desktopWindowMergeJournalSchema,
  }),
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['changed']),
    previewId: opaqueIdSchema,
    sourceWindowCount: positiveIntegerSchema,
    movingTabCount: positiveIntegerSchema,
  }),
  Schema.Struct({
    ok: Schema.Literals([true]),
    status: Schema.Literals(['already-merged', 'busy']),
  }),
  Schema.Struct({
    ok: Schema.Literals([false]),
    reason: desktopWindowMergeRequestFailureReasonSchema,
  }),
])

const desktopWindowMergeAcknowledgeResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
})

const desktopWindowMergeStatusGetMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_STATUS_GET_MESSAGE]),
  refreshNativeAvailability: Schema.optionalKey(Schema.Boolean),
})
const desktopWindowMergePreviewMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_PREVIEW_MESSAGE]),
  // Tab senders imply their own window; the tabless Tab Actions Menu popup
  // names the invoking window explicitly.
  windowId: Schema.optionalKey(positiveIntegerSchema),
})
const desktopWindowMergeConfirmMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_CONFIRM_MESSAGE]),
  previewId: opaqueIdSchema,
})
const desktopWindowMergeAcknowledgeMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_ACKNOWLEDGE_MESSAGE]),
  sessionId: opaqueIdSchema,
})
const desktopWindowMergeStatusChangedMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE]),
})
const desktopWindowMergeOpenMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_OPEN_MESSAGE]),
  windowId: positiveIntegerSchema,
  previewId: opaqueIdSchema,
})
const desktopWindowMergeStartConfirmMessageSchema = Schema.Struct({
  type: Schema.Literals([DESKTOP_WINDOW_MERGE_START_CONFIRM_MESSAGE]),
  previewId: opaqueIdSchema,
})
const desktopWindowMergeStartConfirmAcknowledgementSchema = Schema.Struct({
  ok: Schema.Literals([true]),
})
const nativeIntegrationProfileSelectMessageSchema = Schema.Struct({
  type: Schema.Literals([NATIVE_INTEGRATION_PROFILE_SELECT_MESSAGE]),
})
const nativeIntegrationProfileSelectResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
})
const nativeIntegrationProfileTransferMessageSchema = Schema.Struct({
  type: Schema.Literals([NATIVE_INTEGRATION_PROFILE_TRANSFER_MESSAGE]),
  expectedOwnerRevision: opaqueIdSchema,
})
const nativeIntegrationProfileTransferFailureReasonSchema = Schema.Literals([
  'busy',
  'failed',
  'indeterminate',
  'selection-changed',
  'update-required',
])
const nativeIntegrationProfileTransferResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literals([true]) }),
  Schema.Struct({
    ok: Schema.Literals([false]),
    reason: nativeIntegrationProfileTransferFailureReasonSchema,
  }),
])

export type NativeIntegrationProfileTransferResponse =
  typeof nativeIntegrationProfileTransferResponseSchema.Type

export type DesktopWindowMergeStatusResponse =
  typeof desktopWindowMergeStatusResponseSchema.Type
export type DesktopWindowMergePreviewResponse =
  typeof desktopWindowMergePreviewResponseSchema.Type
export type DesktopWindowMergeConfirmResponse =
  typeof desktopWindowMergeConfirmResponseSchema.Type

const isStatusGetMessage = Schema.is(desktopWindowMergeStatusGetMessageSchema)
const isPreviewMessage = Schema.is(desktopWindowMergePreviewMessageSchema)
const isConfirmMessage = Schema.is(desktopWindowMergeConfirmMessageSchema)
const isAcknowledgeMessage = Schema.is(desktopWindowMergeAcknowledgeMessageSchema)
const isStatusChangedMessage = Schema.is(desktopWindowMergeStatusChangedMessageSchema)
const isOpenMessage = Schema.is(desktopWindowMergeOpenMessageSchema)
const isStartConfirmMessage = Schema.is(desktopWindowMergeStartConfirmMessageSchema)
const isStartConfirmAcknowledgement = Schema.is(desktopWindowMergeStartConfirmAcknowledgementSchema)
const isNativeIntegrationProfileSelectMessage = Schema.is(
  nativeIntegrationProfileSelectMessageSchema,
)
const isNativeIntegrationProfileSelectResponse = Schema.is(
  nativeIntegrationProfileSelectResponseSchema,
)
const isNativeIntegrationProfileTransferMessage = Schema.is(
  nativeIntegrationProfileTransferMessageSchema,
)
const isNativeIntegrationProfileTransferResponse = Schema.is(
  nativeIntegrationProfileTransferResponseSchema,
)
const isStatusResponse = Schema.is(desktopWindowMergeStatusResponseSchema)
const isPreviewResponse = Schema.is(desktopWindowMergePreviewResponseSchema)
const isConfirmResponse = Schema.is(desktopWindowMergeConfirmResponseSchema)
const isAcknowledgeResponse = Schema.is(desktopWindowMergeAcknowledgeResponseSchema)
const isJournal = Schema.is(desktopWindowMergeJournalSchema)

export function isDesktopWindowMergeStatusGetMessage(
  value: unknown,
): value is typeof desktopWindowMergeStatusGetMessageSchema.Type {
  return isStatusGetMessage(value)
}

export function parseDesktopWindowMergePreviewMessage(
  value: unknown,
): typeof desktopWindowMergePreviewMessageSchema.Type | null {
  return isPreviewMessage(value) ? value : null
}

export function parseDesktopWindowMergeConfirmMessage(
  value: unknown,
): typeof desktopWindowMergeConfirmMessageSchema.Type | null {
  return isConfirmMessage(value) ? value : null
}

export function parseDesktopWindowMergeAcknowledgeMessage(
  value: unknown,
): typeof desktopWindowMergeAcknowledgeMessageSchema.Type | null {
  return isAcknowledgeMessage(value) ? value : null
}

export function isDesktopWindowMergeStatusChangedMessage(value: unknown): boolean {
  return isStatusChangedMessage(value)
}

export function parseDesktopWindowMergeOpenMessage(
  value: unknown,
): typeof desktopWindowMergeOpenMessageSchema.Type | null {
  return isOpenMessage(value) ? value : null
}

export function parseDesktopWindowMergeStartConfirmMessage(
  value: unknown,
): typeof desktopWindowMergeStartConfirmMessageSchema.Type | null {
  return isStartConfirmMessage(value) ? value : null
}

export function isDesktopWindowMergeStartConfirmAcknowledgement(value: unknown): boolean {
  return isStartConfirmAcknowledgement(value)
}

export function isNativeIntegrationProfileSelectRequest(value: unknown): boolean {
  return isNativeIntegrationProfileSelectMessage(value)
}

export function parseNativeIntegrationProfileSelectResponse(
  value: unknown,
): typeof nativeIntegrationProfileSelectResponseSchema.Type | null {
  return isNativeIntegrationProfileSelectResponse(value) ? value : null
}

export function parseNativeIntegrationProfileTransferRequest(
  value: unknown,
): typeof nativeIntegrationProfileTransferMessageSchema.Type | null {
  return isNativeIntegrationProfileTransferMessage(value) ? value : null
}

export function parseNativeIntegrationProfileTransferResponse(
  value: unknown,
): NativeIntegrationProfileTransferResponse | null {
  return isNativeIntegrationProfileTransferResponse(value) ? value : null
}

export function parseDesktopWindowMergeStatusResponse(
  value: unknown,
): DesktopWindowMergeStatusResponse | null {
  return isStatusResponse(value) ? value : null
}

export function parseDesktopWindowMergePreviewResponse(
  value: unknown,
): DesktopWindowMergePreviewResponse | null {
  return isPreviewResponse(value) ? value : null
}

export function parseDesktopWindowMergeConfirmResponse(
  value: unknown,
): DesktopWindowMergeConfirmResponse | null {
  return isConfirmResponse(value) ? value : null
}

export function parseDesktopWindowMergeAcknowledgeResponse(
  value: unknown,
): typeof desktopWindowMergeAcknowledgeResponseSchema.Type | null {
  return isAcknowledgeResponse(value) ? value : null
}

export function parseDesktopWindowMergeJournal(
  value: unknown,
): DesktopWindowMergeJournal | null {
  return isJournal(value) ? value : null
}
