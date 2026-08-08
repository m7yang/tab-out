import { Schema } from 'effect'

export const CLOSED_TAB_RESTORE_STATE_MESSAGE = 'tab-out:closed-tab-restore-state'
export const CLOSED_TAB_RETENTION_SETTLE_MESSAGE = 'tab-out:settle-closed-tab-retention'
export const DASHBOARD_SERVICE_STATE_GET_MESSAGE = 'tab-out:get-dashboard-service-state'
export const RETAINED_PAGE_ACTIVATE_MESSAGE = 'tab-out:activate-retained-page'
export const RETAINED_PAGE_REMOVE_MESSAGE = 'tab-out:remove-retained-page'
export const SAVED_PAGE_ACTIVATE_MESSAGE = 'tab-out:activate-saved-page'
export const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
export const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

const nonEmptyMessageStringSchema = Schema.String.check(Schema.isMinLength(1))

const retainedPageActivationDispositionSchema = Schema.Literals([
  'focus-tab',
  'foreground-tab',
  'background-tab',
  'new-window'
])

export type RetainedPageActivationDisposition =
  typeof retainedPageActivationDispositionSchema.Type

const retainedPageActivateMessageSchema = Schema.Struct({
  type: Schema.Literals([RETAINED_PAGE_ACTIVATE_MESSAGE]),
  identityDigest: nonEmptyMessageStringSchema,
  closureToken: nonEmptyMessageStringSchema,
  disposition: retainedPageActivationDispositionSchema
})

const closedTabRetentionSettleMessageSchema = Schema.Struct({
  type: Schema.Literals([CLOSED_TAB_RETENTION_SETTLE_MESSAGE]),
  tabId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const retainedPageRemoveMessageSchema = Schema.Struct({
  type: Schema.Literals([RETAINED_PAGE_REMOVE_MESSAGE]),
  identityDigest: nonEmptyMessageStringSchema,
  closureToken: nonEmptyMessageStringSchema
})

const savedPageActivateMessageSchema = Schema.Struct({
  type: Schema.Literals([SAVED_PAGE_ACTIVATE_MESSAGE]),
  url: nonEmptyMessageStringSchema,
  surfaceKind: Schema.Literals(['normal-tab', 'app']),
  disposition: retainedPageActivationDispositionSchema
})

const retainedPageActivationResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  outcome: Schema.Literals([
    'activated',
    'activated-newer-retained',
    'activated-unconsumed',
    'stale',
    'failed'
  ])
})

const retainedPageRemovalResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  outcome: Schema.Literals(['removed', 'already-absent', 'stale'])
})

const savedPageActivationResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  outcome: Schema.Literals(['activated', 'failed'])
})

export type RetainedPageActivateMessage = typeof retainedPageActivateMessageSchema.Type
export type RetainedPageRemoveMessage = typeof retainedPageRemoveMessageSchema.Type
export type RetainedPageActivationResponse = typeof retainedPageActivationResponseSchema.Type
export type RetainedPageRemovalResponse = typeof retainedPageRemovalResponseSchema.Type
export type SavedPageActivateMessage = typeof savedPageActivateMessageSchema.Type
export type SavedPageActivationResponse = typeof savedPageActivationResponseSchema.Type

const isRetainedPageActivateMessage = Schema.is(retainedPageActivateMessageSchema)
const isClosedTabRetentionSettleMessage = Schema.is(closedTabRetentionSettleMessageSchema)
const isRetainedPageRemoveMessage = Schema.is(retainedPageRemoveMessageSchema)
const isRetainedPageActivationResponse = Schema.is(retainedPageActivationResponseSchema)
const isRetainedPageRemovalResponse = Schema.is(retainedPageRemovalResponseSchema)
const isSavedPageActivateMessage = Schema.is(savedPageActivateMessageSchema)
const isSavedPageActivationResponse = Schema.is(savedPageActivationResponseSchema)

export function parseRetainedPageActivateMessage(value: unknown): RetainedPageActivateMessage | null {
  return isRetainedPageActivateMessage(value) ? value : null
}

export function parseClosedTabRetentionSettleMessage(
  value: unknown
): typeof closedTabRetentionSettleMessageSchema.Type | null {
  return isClosedTabRetentionSettleMessage(value) ? value : null
}

export function parseRetainedPageRemoveMessage(value: unknown): RetainedPageRemoveMessage | null {
  return isRetainedPageRemoveMessage(value) ? value : null
}

export function parseRetainedPageActivationResponse(value: unknown): RetainedPageActivationResponse | null {
  return isRetainedPageActivationResponse(value) ? value : null
}

export function parseRetainedPageRemovalResponse(value: unknown): RetainedPageRemovalResponse | null {
  return isRetainedPageRemovalResponse(value) ? value : null
}

export function parseSavedPageActivateMessage(value: unknown): SavedPageActivateMessage | null {
  return isSavedPageActivateMessage(value) ? value : null
}

export function parseSavedPageActivationResponse(value: unknown): SavedPageActivationResponse | null {
  return isSavedPageActivationResponse(value) ? value : null
}

const closedTabRestoreMessageEnvelopeSchema = Schema.Struct({
  type: Schema.Literals([CLOSED_TAB_RESTORE_STATE_MESSAGE])
})

const closedTabRestoreStateMessageSchema = Schema.Struct({
  type: Schema.Literals([CLOSED_TAB_RESTORE_STATE_MESSAGE]),
  restoreId: Schema.String.check(Schema.isMinLength(1)),
  phase: Schema.Literals(['started', 'settled']),
  restored: Schema.optionalKey(Schema.Boolean)
})

export type ClosedTabRestoreStateMessage = typeof closedTabRestoreStateMessageSchema.Type

const isClosedTabRestoreMessageEnvelope = Schema.is(closedTabRestoreMessageEnvelopeSchema)
const isClosedTabRestoreStateMessage = Schema.is(closedTabRestoreStateMessageSchema)

export function isClosedTabRestoreMessage(value: unknown): boolean {
  return isClosedTabRestoreMessageEnvelope(value)
}

export function parseClosedTabRestoreStateMessage(value: unknown): ClosedTabRestoreStateMessage | null {
  return isClosedTabRestoreStateMessage(value) ? value : null
}

const tabHistoryGetMessageSchema = Schema.Struct({
  type: Schema.Literals([TAB_HISTORY_GET_MESSAGE])
})

const tabHistorySwitchMessageSchema = Schema.Struct({
  type: Schema.Literals([TAB_HISTORY_SWITCH_MESSAGE]),
  direction: Schema.optionalKey(Schema.Unknown)
})

const dashboardServiceStateGetMessageSchema = Schema.Struct({
  type: Schema.Literals([DASHBOARD_SERVICE_STATE_GET_MESSAGE])
})

const isTabHistoryGetMessageSchema = Schema.is(tabHistoryGetMessageSchema)
const isTabHistorySwitchMessageSchema = Schema.is(tabHistorySwitchMessageSchema)
const isDashboardServiceStateGetMessageSchema = Schema.is(dashboardServiceStateGetMessageSchema)
const isTabHistoryDirection = Schema.is(Schema.Literals([-1, 1]))

export function isTabHistoryGetMessage(value: unknown): boolean {
  return isTabHistoryGetMessageSchema(value)
}

export function parseTabHistorySwitchDirection(value: unknown): -1 | 1 | null {
  if (!isTabHistorySwitchMessageSchema(value)) return null
  return isTabHistoryDirection(value.direction) ? value.direction : -1
}

export function isDashboardServiceStateGetMessage(value: unknown): boolean {
  return isDashboardServiceStateGetMessageSchema(value)
}

const tabHistorySuccessResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  snapshot: Schema.Struct({
    entries: Schema.mutable(Schema.Array(Schema.Unknown))
  })
})

const isTabHistorySuccessResponse = Schema.is(tabHistorySuccessResponseSchema)

export function parseTabHistorySuccessResponse(value: unknown): unknown | null {
  return isTabHistorySuccessResponse(value) ? value.snapshot : null
}
