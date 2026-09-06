import {
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
} from 'effect'

import { omitUndefined } from '../../lib/omit-undefined.js'
import {
  DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE,
  type NativeIntegrationProfileTransferResponse,
} from '../desktop-window-merge-contract.js'
import type { ChromeApi } from './chrome-api.js'
import {
  createInactiveWindow,
  type TargetDisplayBounds,
} from './native-window-placement.js'

export const NATIVE_PROFILE_SELECTION_VERSION = 2
export const NATIVE_PLACEMENT_BRIDGE_VERSION = 6
export const NATIVE_CONTROL_BRIDGE_VERSION = 7
export const NATIVE_MERGE_DESKTOP_CAPABILITY = 'merge-desktop'
export const NATIVE_PROFILE_TRANSFER_DRAIN_CAPABILITY = 'profile-transfer-drain'
const NATIVE_PROFILE_TRANSFER_CAPABILITY = 'profile-transfer'
const nativeProfileTransferFailed = {
  ok: false,
  reason: 'failed',
} satisfies NativeIntegrationProfileTransferResponse
const nativeProfileTransferIndeterminate = {
  ok: false,
  reason: 'indeterminate',
} satisfies NativeIntegrationProfileTransferResponse
const NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY =
  'nativeIntegrationProfileIdV1'
const NATIVE_CONTROL_MAXIMUM_WINDOW_IDS = 512
// The final delay deliberately exceeds Chrome's normal 30-second MV3 idle
// window. A missing optional host can therefore let an otherwise idle worker
// terminate, while a later worker wake restarts the fast reconnect sequence.
const NATIVE_PLACEMENT_UNAVAILABLE_RETRY_MS = 60_000
const NATIVE_PLACEMENT_RECONNECT_DELAYS_MS = [
  250,
  1_000,
  5_000,
  NATIVE_PLACEMENT_UNAVAILABLE_RETRY_MS,
] as const
const NATIVE_PLACEMENT_HOST_NAME = 'com.tabout.native_bridge'

export type NativePlacementBridgeResponse = {
  browserWindowId?: number
  reason?: string
  requestId: string
  status: 'accepted' | 'rejected'
  type: 'response'
  version: typeof NATIVE_PLACEMENT_BRIDGE_VERSION
  windowIds?: number[]
}

const nativeControlRequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)
const nativeControlWindowIdSchema = Schema.Int.check(Schema.isGreaterThan(0))
const nativeControlCapabilitiesSchema = Schema.Array(Schema.Literals([
  NATIVE_MERGE_DESKTOP_CAPABILITY,
  NATIVE_PROFILE_TRANSFER_DRAIN_CAPABILITY,
])).check(Schema.isMaxLength(16))
const nativeControlWindowIdsSchema = Schema.Array(nativeControlWindowIdSchema).check(
  Schema.isMaxLength(NATIVE_CONTROL_MAXIMUM_WINDOW_IDS),
)
const nativeControlResponseSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_CONTROL_BRIDGE_VERSION]),
  type: Schema.Literals(['response']),
  requestId: nativeControlRequestIdSchema,
  status: Schema.Literals(['accepted', 'rejected']),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_024))),
  windowIds: Schema.optionalKey(nativeControlWindowIdsSchema),
})
const nativeControllerStatusMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_CONTROL_BRIDGE_VERSION]),
  type: Schema.Literals(['controller-status']),
  connected: Schema.Boolean,
  capabilities: nativeControlCapabilitiesSchema,
})
const nativeProfileIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const nativeProfileSelectionStatusMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_PROFILE_SELECTION_VERSION]),
  type: Schema.Literals(['profile-selection-status']),
  selection: Schema.Literals(['another-profile', 'required', 'selected']),
  capabilities: Schema.Array(Schema.Literals([
    NATIVE_PROFILE_TRANSFER_CAPABILITY,
  ])).check(Schema.isMaxLength(8)),
  ownerRevision: Schema.optionalKey(nativeProfileIdSchema),
})
const nativeProfileTransferResultMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_PROFILE_SELECTION_VERSION]),
  type: Schema.Literals(['profile-transfer-result']),
  status: Schema.Literals(['rejected']),
  reason: Schema.Literals([
    'busy',
    'failed',
    'selection-changed',
    'update-required',
  ]),
  ownerRevision: Schema.optionalKey(nativeProfileIdSchema),
})
const nativeProfileTransferPrepareMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_PROFILE_SELECTION_VERSION]),
  type: Schema.Literals(['profile-transfer-prepare']),
  requestId: nativeControlRequestIdSchema,
})
const nativeProfileTransferCancelMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_PROFILE_SELECTION_VERSION]),
  type: Schema.Literals(['profile-transfer-cancel']),
  requestId: nativeControlRequestIdSchema,
})

type NativeControlResponse = typeof nativeControlResponseSchema.Type
type NativeControllerStatusMessage = typeof nativeControllerStatusMessageSchema.Type
type NativeProfileSelectionStatusMessage =
  typeof nativeProfileSelectionStatusMessageSchema.Type

const isNativeControlResponse = Schema.is(nativeControlResponseSchema)
const isNativeControllerStatusMessage = Schema.is(nativeControllerStatusMessageSchema)
const isNativeProfileId = Schema.is(nativeProfileIdSchema)
const isNativeProfileSelectionStatusMessage = Schema.is(
  nativeProfileSelectionStatusMessageSchema,
)
const isNativeProfileTransferResultMessage = Schema.is(
  nativeProfileTransferResultMessageSchema,
)
const isNativeProfileTransferPrepareMessage = Schema.is(
  nativeProfileTransferPrepareMessageSchema,
)
const isNativeProfileTransferCancelMessage = Schema.is(
  nativeProfileTransferCancelMessageSchema,
)

export interface NativeDesktopWindowSelection {
  readonly selectionToken: string
  readonly windowIds: readonly number[]
}

export interface NativeDesktopControllerStatus {
  readonly capabilities: readonly string[]
  readonly controllerConnected: boolean
  readonly hostConnected: boolean
  readonly initialConnectionSettled: boolean
  readonly ownerRevision: string | null
  readonly profileSelection: 'another-profile' | 'required' | 'selected' | 'unknown'
  readonly profileTransferAvailable: boolean
}

export class NativeDesktopControlError extends Schema.TaggedError<NativeDesktopControlError>()(
  'NativeDesktopControlError',
  { reason: Schema.String },
) {}

export class NativePlacementBridge extends Context.Service<NativePlacementBridge, {
  readonly getStatus: () => Effect.Effect<NativeDesktopControllerStatus>
  readonly refreshStatus: () => Effect.Effect<NativeDesktopControllerStatus>
  readonly selectCurrentProfile: () => Effect.Effect<void, NativeDesktopControlError>
  readonly transferCurrentProfile: (
    expectedOwnerRevision: string,
  ) => Effect.Effect<NativeIntegrationProfileTransferResponse>
  readonly beginDesktopWindowMerge: () => Effect.Effect<void, NativeDesktopControlError>
  readonly finishDesktopWindowMerge: () => Effect.Effect<void>
  readonly resolveDesktopWindows: (
    destinationWindowId: number,
  ) => Effect.Effect<NativeDesktopWindowSelection, NativeDesktopControlError>
  readonly revalidateDesktopWindows: (
    destinationWindowId: number,
    selectionToken: string,
  ) => Effect.Effect<NativeDesktopWindowSelection, NativeDesktopControlError>
}>()('tab-out/background/NativePlacementBridge') {}

class NativePlacementOperationError extends Schema.TaggedError<NativePlacementOperationError>()(
  'NativePlacementOperationError',
  { cause: Schema.Defect() },
) {}

class NativePlacementConnectionError extends Schema.TaggedError<NativePlacementConnectionError>()(
  'NativePlacementConnectionError',
  { cause: Schema.Defect() },
) {}

async function readOrCreateNativeProfileId(chromeApi: ChromeApi): Promise<string> {
  const storage = chromeApi.storage?.local
  if (!storage) throw new Error('Local extension storage is unavailable')
  const stored = await storage.get(NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY)
  const existing = stored[NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY]
  if (isNativeProfileId(existing)) return existing

  const profileId = crypto.randomUUID()
  await storage.set({ [NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY]: profileId })
  return profileId
}

const nativePlacementRequestRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const nativePlacementRequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)
const nativePlacementCoordinateSchema = Schema.Finite.check(
  Schema.isBetween({ minimum: -100_000, maximum: 100_000 }),
)
const nativePlacementDimensionSchema = nativePlacementCoordinateSchema.check(
  Schema.isGreaterThan(0),
)
const nativePlacementTargetBoundsSchema = Schema.Struct({
  left: nativePlacementCoordinateSchema,
  top: nativePlacementCoordinateSchema,
  width: nativePlacementDimensionSchema,
  height: nativePlacementDimensionSchema,
}) satisfies Schema.Schema<TargetDisplayBounds>

const isNativePlacementRequestRecord = Schema.is(nativePlacementRequestRecordSchema)
const isNativePlacementRequestId = Schema.is(nativePlacementRequestIdSchema)
const isNativePlacementRequestTime = Schema.is(Schema.Finite)
const isNativePlacementTargetBounds = Schema.is(nativePlacementTargetBoundsSchema)

function response(
  requestId: string,
  status: NativePlacementBridgeResponse['status'],
  reason?: string,
  windowIds?: number[],
): NativePlacementBridgeResponse {
  return omitUndefined({
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId,
    status,
    reason: reason || undefined,
    windowIds,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The native placement request failed'
}

export const handleNativePlacementBridgeMessageEffect = Effect.fn('nativePlacementBridge.handleMessage')(function* (
  message: unknown,
  chromeApi: ChromeApi,
  nowMs: number,
) {
  if (!isNativePlacementRequestRecord(message)) {
    return response('invalid', 'rejected', 'The native placement request is not an object')
  }

  const candidate = message
  const requestId = isNativePlacementRequestId(candidate.requestId) ? candidate.requestId : 'invalid'
  if (candidate.version !== NATIVE_PLACEMENT_BRIDGE_VERSION) {
    return response(requestId, 'rejected', 'The native placement protocol version is unsupported')
  }
  if (!isNativePlacementRequestId(candidate.requestId)) {
    return response(requestId, 'rejected', 'The native placement request ID is invalid')
  }
  if (!isNativePlacementRequestTime(candidate.expiresAtMs) || candidate.expiresAtMs < nowMs) {
    return response(requestId, 'rejected', 'The native placement request expired')
  }

  if (candidate.type === 'status') {
    return response(requestId, 'accepted')
  }
  if (candidate.type === 'list-profile-windows') {
    const windowsResult = yield* Effect.result(Effect.tryPromise({
      try: () => chromeApi.windows.getAll({ windowTypes: ['normal'] }),
      catch: (cause) => new NativePlacementOperationError({ cause }),
    }))
    if (Result.isFailure(windowsResult)) {
      return response(requestId, 'rejected', errorMessage(windowsResult.failure.cause))
    }
    const windowIds = windowsResult.success
      .filter((window) => window.type === 'normal' && window.state !== 'minimized')
      .map((window) => window.id)
      .filter((windowId): windowId is number => (
        Number.isInteger(windowId) && (windowId ?? 0) > 0
      ))
    return response(requestId, 'accepted', undefined, windowIds)
  }
  if (candidate.type !== 'create-window') {
    return response(requestId, 'rejected', 'The native placement request type is unsupported')
  }
  if (candidate.operation !== 'filter' && candidate.operation !== 'newPage') {
    return response(requestId, 'rejected', 'The native placement operation is invalid')
  }
  if (!isNativePlacementTargetBounds(candidate.targetBounds)) {
    return response(requestId, 'rejected', 'The native placement target bounds are invalid')
  }
  const operation = candidate.operation
  const targetBounds = candidate.targetBounds

  const placementResult = yield* Effect.result(Effect.tryPromise({
    try: () => createInactiveWindow(operation, targetBounds, requestId, chromeApi),
    catch: (cause) => new NativePlacementOperationError({ cause }),
  }))
  if (Result.isFailure(placementResult)) {
    return response(requestId, 'rejected', errorMessage(placementResult.failure.cause))
  }
  return {
    ...response(requestId, 'accepted'),
    browserWindowId: placementResult.success,
  }
})

export function makeNativePlacementBridgeLayer(
  chromeApi: ChromeApi,
): Layer.Layer<NativePlacementBridge> {
  return Layer.effect(NativePlacementBridge, Effect.gen(function* () {
    const scope = yield* Effect.scope
    const runtimeApi = chromeApi.runtime
    const status = yield* Ref.make<NativeDesktopControllerStatus>({
      capabilities: [],
      controllerConnected: false,
      hostConnected: false,
      initialConnectionSettled: false,
      ownerRevision: null,
      profileSelection: 'unknown',
      profileTransferAvailable: false,
    })
    const activePort = yield* Ref.make<chrome.runtime.Port | null>(null)
    const pendingStatusRefresh = yield* Ref.make<
      Deferred.Deferred<NativeDesktopControllerStatus> | null
    >(null)
    const pendingProfileSelection = yield* Ref.make<Deferred.Deferred<
      boolean,
      NativeDesktopControlError
    > | null>(null)
    const pendingControlRequests = yield* Ref.make<ReadonlyMap<
      string,
      Deferred.Deferred<NativeControlResponse, NativeDesktopControlError>
    >>(new Map())
    const pendingProfileTransfer = yield* Ref.make<{
      readonly completion: Deferred.Deferred<NativeIntegrationProfileTransferResponse>
      readonly expectedOwnerRevision: string
      readonly phase: 'awaiting-result' | 'reconciling' | 'starting'
      readonly requestPort: chrome.runtime.Port | null
    } | null>(null)
    const profileTransferActivity = yield* Ref.make<{
      readonly drainRequestId: string | null
      readonly mergeRunning: boolean
    }>({ drainRequestId: null, mergeRunning: false })
    const manualReconnects = yield* Queue.unbounded<void>()
    const incomingMessages = yield* Queue.unbounded<{
      readonly disconnect: () => void
      readonly message: unknown
      readonly port: chrome.runtime.Port
    }>()
    let disconnectActivePort: (() => void) | null = null
    let connectionAttempt: { cancelled: boolean, settled: boolean } | null = null
    let reconnectOnlyOnRequest = false
    let reconnectAttempt = 0
    let cachedProfileId: string | null = null

    const controlError = (reason: string) => new NativeDesktopControlError({ reason })

    const notifyControllerStatusChanged = Effect.fn(
      'NativePlacementBridge.notifyControllerStatusChanged',
    )(function* () {
      if (!runtimeApi?.sendMessage) return
      yield* Effect.tryPromise({
        try: () => runtimeApi.sendMessage({
          type: DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE,
        }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void))
    })

    const setControllerStatus = Effect.fn(
      'NativePlacementBridge.setControllerStatus',
    )(function* (next: NativeDesktopControllerStatus) {
      const previous = yield* Ref.get(status)
      if (
        previous.hostConnected === next.hostConnected &&
        previous.controllerConnected === next.controllerConnected &&
        previous.profileSelection === next.profileSelection &&
        previous.initialConnectionSettled === next.initialConnectionSettled &&
        previous.ownerRevision === next.ownerRevision &&
        previous.profileTransferAvailable === next.profileTransferAvailable &&
        previous.capabilities.length === next.capabilities.length &&
        previous.capabilities.every((capability, index) =>
          next.capabilities[index] === capability)
      ) return
      yield* Ref.set(status, next)
      yield* notifyControllerStatusChanged().pipe(
        Effect.forkChild({ startImmediately: true }),
      )
    })

    const completeStatusRefresh = Effect.fn(
      'NativePlacementBridge.completeStatusRefresh',
    )(function* () {
      const completion = yield* Ref.getAndSet(pendingStatusRefresh, null)
      if (completion) yield* Deferred.succeed(completion, yield* Ref.get(status))
    })

    const failPendingControlRequests = Effect.fn(
      'NativePlacementBridge.failPendingControlRequests',
    )(function* (reason: string) {
      const pending = yield* Ref.getAndSet(pendingControlRequests, new Map())
      yield* Effect.forEach(
        pending.values(),
        (completion) => Deferred.fail(completion, controlError(reason)),
        { concurrency: 'unbounded', discard: true },
      )
    })

    const failPendingProfileSelection = Effect.fn(
      'NativePlacementBridge.failPendingProfileSelection',
    )(function* (reason: string) {
      const completion = yield* Ref.getAndSet(pendingProfileSelection, null)
      if (completion) yield* Deferred.fail(completion, controlError(reason))
    })

    const completeUnavailableProfileTransfer = Effect.fn(
      'NativePlacementBridge.completeUnavailableProfileTransfer',
    )(function* () {
      const pending = yield* Ref.getAndSet(pendingProfileTransfer, null)
      if (!pending) return
      yield* Deferred.succeed(
        pending.completion,
        pending.phase === 'reconciling'
          ? nativeProfileTransferIndeterminate
          : nativeProfileTransferFailed,
      )
    })

    const postNativeMessage = Effect.fn(
      'NativePlacementBridge.postNativeMessage',
    )(function* (port: chrome.runtime.Port, message: unknown) {
      yield* Effect.try({
        try: () => port.postMessage(message),
        catch: (cause) => controlError(errorMessage(cause)),
      })
    })

    const updateControllerStatus = Effect.fn(
      'NativePlacementBridge.updateControllerStatus',
    )(function* (message: NativeControllerStatusMessage) {
      const current = yield* Ref.get(status)
      if (current.profileSelection !== 'selected') return
      yield* setControllerStatus({
        capabilities: message.capabilities,
        controllerConnected: message.connected,
        hostConnected: current.hostConnected,
        initialConnectionSettled: current.initialConnectionSettled,
        ownerRevision: current.ownerRevision,
        profileSelection: current.profileSelection,
        profileTransferAvailable: current.profileTransferAvailable,
      })
    })

    const updateProfileSelectionStatus = Effect.fn(
      'NativePlacementBridge.updateProfileSelectionStatus',
    )(function* (message: NativeProfileSelectionStatusMessage) {
      const current = yield* Ref.get(status)
      const profileSelection = message.selection
      if (profileSelection === 'another-profile') reconnectOnlyOnRequest = true
      else if (profileSelection === 'selected') reconnectOnlyOnRequest = false
      yield* setControllerStatus({
        capabilities: profileSelection === 'selected' ? current.capabilities : [],
        controllerConnected: profileSelection === 'selected'
          ? current.controllerConnected
          : false,
        hostConnected: current.hostConnected,
        initialConnectionSettled: true,
        ownerRevision: message.ownerRevision ?? null,
        profileSelection,
        profileTransferAvailable: profileSelection === 'another-profile' &&
          message.ownerRevision !== undefined &&
          message.capabilities.includes(NATIVE_PROFILE_TRANSFER_CAPABILITY),
      })
      if (profileSelection !== 'required') {
        const completion = yield* Ref.getAndSet(pendingProfileSelection, null)
        if (completion) yield* Deferred.succeed(completion, profileSelection === 'selected')
      }
      if (connectionAttempt) connectionAttempt.settled = true
      yield* completeStatusRefresh()
    })

    const completeProfileTransfer = Effect.fn(
      'NativePlacementBridge.completeProfileTransfer',
    )(function* (result: NativeIntegrationProfileTransferResponse) {
      const pending = yield* Ref.getAndSet(pendingProfileTransfer, null)
      if (pending) yield* Deferred.succeed(pending.completion, result)
    })

    const handleProfileTransferPrepare = Effect.fn(
      'NativePlacementBridge.handleProfileTransferPrepare',
    )(function* (port: chrome.runtime.Port, requestId: string) {
      const accepted = yield* Ref.modify(profileTransferActivity, (current) => {
        if (current.drainRequestId !== null || current.mergeRunning) {
          return [false, current] as const
        }
        return [true, { ...current, drainRequestId: requestId }] as const
      })
      yield* postNativeMessage(port, {
        version: NATIVE_PROFILE_SELECTION_VERSION,
        type: 'profile-transfer-response',
        requestId,
        status: accepted ? 'idle' : 'busy',
      }).pipe(Effect.catch(() => Effect.void))
    })

    const handleProfileTransferCancel = Effect.fn(
      'NativePlacementBridge.handleProfileTransferCancel',
    )(function* (requestId: string) {
      yield* Ref.update(profileTransferActivity, (current) => (
        current.drainRequestId === requestId
          ? { ...current, drainRequestId: null }
          : current
      ))
    })

    const replyToNativeMessage = Effect.fn('NativePlacementBridge.reply')(function* (
      port: chrome.runtime.Port,
      message: unknown,
      disconnect: () => void,
    ) {
      if ((yield* Ref.get(activePort)) !== port) return
      if (isNativeProfileSelectionStatusMessage(message)) {
        yield* updateProfileSelectionStatus(message)
        const pending = yield* Ref.get(pendingProfileTransfer)
        if (pending) {
          // A status means the requested connection is now live. Remove any
          // wake-up token left by the narrow confirm-before-disconnect race.
          yield* Queue.clear(manualReconnects)
        }
        if (message.selection === 'another-profile') {
          if (pending?.phase === 'reconciling') {
            yield* completeProfileTransfer({
              ok: false,
              reason: message.ownerRevision !== pending.expectedOwnerRevision
                ? 'selection-changed'
                : message.capabilities.includes(NATIVE_PROFILE_TRANSFER_CAPABILITY)
                  ? 'failed'
                  : 'update-required',
            })
            yield* Effect.sync(disconnect)
            return
          }
          if (
            pending &&
            pending.phase === 'starting' &&
            message.ownerRevision === pending.expectedOwnerRevision &&
            message.capabilities.includes(NATIVE_PROFILE_TRANSFER_CAPABILITY)
          ) {
            yield* Ref.update(pendingProfileTransfer, (current) => (
              current === pending
                ? { ...current, phase: 'awaiting-result' as const, requestPort: port }
                : current
            ))
            const posted = yield* Effect.result(postNativeMessage(port, {
              version: NATIVE_PROFILE_SELECTION_VERSION,
              type: 'transfer-profile',
              profileId: cachedProfileId,
              expectedOwnerRevision: pending.expectedOwnerRevision,
            }))
            if (Result.isFailure(posted)) {
              yield* completeProfileTransfer(nativeProfileTransferFailed)
              yield* Effect.sync(disconnect)
            }
            return
          }
          if (pending?.phase === 'awaiting-result' && pending.requestPort === port) {
            return
          }
          if (pending) {
            yield* completeProfileTransfer({
              ok: false,
              reason: message.capabilities.includes(NATIVE_PROFILE_TRANSFER_CAPABILITY)
                ? 'selection-changed'
                : 'update-required',
            })
          }
          yield* Effect.sync(disconnect)
        } else if (message.selection === 'selected') {
          yield* completeProfileTransfer({ ok: true })
        } else if (pending) {
          yield* completeProfileTransfer({ ok: false, reason: 'selection-changed' })
          yield* Effect.sync(disconnect)
        }
        return
      }
      if (isNativeProfileTransferResultMessage(message)) {
        const current = yield* Ref.get(status)
        yield* setControllerStatus({
          ...current,
          initialConnectionSettled: true,
          ownerRevision: message.ownerRevision ?? current.ownerRevision,
          profileTransferAvailable:
            message.reason !== 'selection-changed' && message.reason !== 'update-required',
        })
        yield* completeProfileTransfer({ ok: false, reason: message.reason })
        if (message.reason === 'selection-changed') {
          // Re-read authority after a stale or competing commit so the popup
          // can offer Use or a newly revisioned Switch without a second
          // failed confirmation.
          yield* Queue.offer(manualReconnects, undefined)
        }
        yield* Effect.sync(disconnect)
        return
      }
      if (isNativeProfileTransferPrepareMessage(message)) {
        yield* handleProfileTransferPrepare(port, message.requestId)
        return
      }
      if (isNativeProfileTransferCancelMessage(message)) {
        yield* handleProfileTransferCancel(message.requestId)
        return
      }
      if (isNativeControllerStatusMessage(message)) {
        yield* updateControllerStatus(message)
        return
      }
      if (isNativeControlResponse(message)) {
        const completion = (yield* Ref.get(pendingControlRequests)).get(message.requestId)
        if (completion) yield* Deferred.succeed(completion, message)
        return
      }

      const result = yield* handleNativePlacementBridgeMessageEffect(message, chromeApi, Date.now())
      yield* Effect.try({
        try: () => port.postMessage(result),
        catch: (cause) => NativePlacementOperationError.make({ cause }),
      }).pipe(
        Effect.catchTag('NativePlacementOperationError', (error) => Effect.sync(() => {
          console.warn(
            'Tab Out native placement bridge could not reply:',
            errorMessage(error.cause),
          )
        })),
      )
    })

    yield* Queue.take(incomingMessages).pipe(
      Effect.flatMap(({ disconnect, message, port }) => {
        const reply = replyToNativeMessage(port, message, disconnect)
        if (
          isNativeProfileSelectionStatusMessage(message) ||
          isNativeProfileTransferResultMessage(message) ||
          isNativeProfileTransferPrepareMessage(message) ||
          isNativeProfileTransferCancelMessage(message) ||
          isNativeControllerStatusMessage(message) ||
          isNativeControlResponse(message)
        ) return reply
        return reply.pipe(
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      }),
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const connectUntilDisconnected = Effect.fn('NativePlacementBridge.connect')(function* (
      attempt: { cancelled: boolean, settled: boolean },
    ) {
      if (!runtimeApi || typeof runtimeApi.connectNative !== 'function') {
        return yield* Effect.fail(NativePlacementConnectionError.make({
          cause: new Error('Native messaging is unavailable'),
        }))
      }
      const profileId = cachedProfileId ?? (yield* Effect.tryPromise({
        try: () => readOrCreateNativeProfileId(chromeApi),
        catch: (cause) => NativePlacementConnectionError.make({ cause }),
      }))
      cachedProfileId = profileId
      if (attempt.cancelled) return
      const port = yield* Effect.try({
        try: () => runtimeApi.connectNative(NATIVE_PLACEMENT_HOST_NAME),
        catch: (cause) => NativePlacementConnectionError.make({ cause }),
      })
      yield* Ref.set(activePort, port)
      const previousStatus = yield* Ref.get(status)
      yield* setControllerStatus({
        capabilities: [],
        controllerConnected: false,
        hostConnected: true,
        initialConnectionSettled: previousStatus.initialConnectionSettled,
        ownerRevision: previousStatus.ownerRevision,
        profileSelection: 'unknown',
        profileTransferAvailable: false,
      })

      yield* Effect.callback<void>((resume) => {
        let disconnected = false

        const removeListeners = () => {
          port.onMessage.removeListener(onMessage)
          port.onDisconnect.removeListener(onDisconnect)
        }
        const finishDisconnect = () => {
          if (disconnected) return
          disconnected = true
          removeListeners()
          if (disconnectActivePort === disconnect) disconnectActivePort = null
          resume(Effect.void)
        }
        const disconnect = () => {
          if (disconnected) return
          finishDisconnect()
          try {
            port.disconnect()
          } catch {}
        }
        const onMessage = (message: unknown) => {
          reconnectAttempt = 0
          Queue.offerUnsafe(incomingMessages, { disconnect, message, port })
        }
        const onDisconnect = () => {
          const disconnectError = runtimeApi.lastError
          if (disconnected) return
          finishDisconnect()
          if (disconnectError?.message) {
            console.info(
              'Tab Out native placement bridge disconnected:',
              disconnectError.message,
            )
          }
        }

        port.onMessage.addListener(onMessage)
        port.onDisconnect.addListener(onDisconnect)
        disconnectActivePort = disconnect

        try {
          port.postMessage({
            version: NATIVE_PROFILE_SELECTION_VERSION,
            type: 'profile-hello',
            profileId,
          })
        } catch (cause) {
          console.info(
            'Tab Out native placement bridge disconnected:',
            errorMessage(cause),
          )
          finishDisconnect()
        }

        return Effect.sync(() => {
          if (disconnected) return
          disconnected = true
          removeListeners()
          if (disconnectActivePort === disconnect) disconnectActivePort = null
          try {
            port.disconnect()
          } catch {}
        })
      })
      yield* Ref.update(activePort, (current) => current === port ? null : current)
      const currentStatus = yield* Ref.get(status)
      yield* setControllerStatus({
        capabilities: [],
        controllerConnected: false,
        hostConnected: false,
        initialConnectionSettled: true,
        ownerRevision: currentStatus.profileSelection === 'unknown'
          ? null
          : currentStatus.ownerRevision,
        profileSelection: currentStatus.profileSelection,
        profileTransferAvailable: currentStatus.profileTransferAvailable,
      })
      attempt.settled = true
      if (!attempt.cancelled) yield* completeStatusRefresh()
      yield* Ref.update(profileTransferActivity, (current) => ({
        ...current,
        drainRequestId: null,
      }))
      yield* failPendingProfileSelection('The native bridge disconnected')
      yield* failPendingControlRequests('The native bridge disconnected')
      const pendingTransfer = yield* Ref.get(pendingProfileTransfer)
      if (
        pendingTransfer?.phase === 'awaiting-result' &&
        pendingTransfer.requestPort === port
      ) {
        yield* Ref.update(pendingProfileTransfer, (current) => (
          current === pendingTransfer
            ? { ...current, phase: 'reconciling' as const }
            : current
        ))
        yield* Queue.offer(manualReconnects, undefined)
      } else if (
        !pendingTransfer ||
        currentStatus.profileSelection !== 'another-profile' ||
        (
          pendingTransfer.phase === 'reconciling' &&
          pendingTransfer.requestPort !== port
        )
      ) {
        yield* completeUnavailableProfileTransfer()
      }
    })

    const reconnect = Effect.fn('NativePlacementBridge.reconnect')(function* () {
      const attempt = { cancelled: false, settled: false }
      connectionAttempt = attempt
      const connection = yield* Effect.result(connectUntilDisconnected(attempt))
      if (Result.isFailure(connection)) {
        yield* Effect.sync(() => {
          console.warn(
            'Tab Out native placement bridge could not connect:',
            errorMessage(connection.failure.cause),
          )
        })
        const current = yield* Ref.get(status)
        const staleNonOwnerStatus = current.profileSelection === 'another-profile'
        yield* setControllerStatus({
          ...current,
          hostConnected: false,
          initialConnectionSettled: true,
          ownerRevision: staleNonOwnerStatus ? null : current.ownerRevision,
          profileSelection: staleNonOwnerStatus ? 'unknown' : current.profileSelection,
          profileTransferAvailable: false,
        })
        yield* completeUnavailableProfileTransfer()
        attempt.settled = true
        if (!attempt.cancelled) yield* completeStatusRefresh()
      }
      connectionAttempt = null

      if (reconnectOnlyOnRequest) {
        return yield* Queue.take(manualReconnects)
      }

      const delayIndex = Math.min(
        reconnectAttempt,
        NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.length - 1,
      )
      const delay = NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.at(delayIndex) ??
        NATIVE_PLACEMENT_UNAVAILABLE_RETRY_MS
      reconnectAttempt += 1
      yield* Effect.raceFirst(Effect.sleep(delay), Queue.take(manualReconnects))
    })

    yield* reconnect().pipe(
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const refreshStatus = Effect.fn('NativePlacementBridge.refreshStatus')(function* () {
      const pending = yield* Ref.get(pendingStatusRefresh)
      if (pending) return yield* Deferred.await(pending)
      const current = yield* Ref.get(status)
      const activity = yield* Ref.get(profileTransferActivity)
      if (
        (connectionAttempt?.settled && !connectionAttempt.cancelled) ||
        (current.hostConnected && current.profileSelection !== 'unknown') ||
        (yield* Ref.get(pendingProfileSelection)) ||
        (yield* Ref.get(pendingProfileTransfer)) ||
        activity.drainRequestId !== null ||
        activity.mergeRunning
      ) return current

      const completion = yield* Deferred.make<NativeDesktopControllerStatus>()
      const installed = yield* Ref.modify(pendingStatusRefresh, (existing) => (
        existing ? [existing, existing] : [completion, completion]
      ))
      if (installed !== completion) return yield* Deferred.await(installed)

      // The handshake temporarily reports unknown. Keep its read-only probe
      // purpose independently so a failed attempt returns to dormancy.
      reconnectOnlyOnRequest = true
      if (!connectionAttempt || connectionAttempt.cancelled) {
        yield* Queue.offer(manualReconnects, undefined)
      }
      yield* Deferred.await(completion).pipe(
        Effect.timeoutOrElse({
          duration: '4 seconds',
          orElse: () => Effect.gen(function* () {
            if ((yield* Ref.get(pendingStatusRefresh)) !== completion) return
            if (connectionAttempt) connectionAttempt.cancelled = true
            yield* Effect.sync(() => disconnectActivePort?.())
            yield* setControllerStatus({
              capabilities: [],
              controllerConnected: false,
              hostConnected: false,
              initialConnectionSettled: true,
              ownerRevision: null,
              profileSelection: 'unknown',
              profileTransferAvailable: false,
            })
            yield* completeStatusRefresh()
          }),
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return yield* Deferred.await(completion)
    })

    const readProfileWindowIds = Effect.fn(
      'NativePlacementBridge.readProfileWindowIds',
    )(function* () {
      const windows = yield* Effect.tryPromise({
        try: () => chromeApi.windows.getAll({ windowTypes: ['normal'] }),
        catch: (cause) => controlError(errorMessage(cause)),
      })
      const windowIds: number[] = []
      for (const window of windows) {
        if (
          window.type === 'normal' &&
          window.state !== 'minimized' &&
          Number.isInteger(window.id) &&
          (window.id ?? 0) > 0
        ) windowIds.push(window.id as number)
      }
      if (windowIds.length > NATIVE_CONTROL_MAXIMUM_WINDOW_IDS) {
        return yield* Effect.fail(controlError(
          'The configured-profile window inventory is too large',
        ))
      }
      return windowIds
    })

    const selectCurrentProfile = Effect.fn(
      'NativePlacementBridge.selectCurrentProfile',
    )(function* () {
      const currentStatus = yield* Ref.get(status)
      if (currentStatus.profileSelection === 'selected') return
      if (currentStatus.profileSelection === 'another-profile') {
        return yield* Effect.fail(controlError(
          'Another Chrome profile is already selected for the macOS integration',
        ))
      }
      if (currentStatus.profileSelection !== 'required') {
        return yield* Effect.fail(controlError(
          'The native bridge profile-selection status is unavailable',
        ))
      }

      const port = yield* Ref.get(activePort)
      const profileId = cachedProfileId
      if (!port || !profileId) {
        return yield* Effect.fail(controlError('The native bridge is not connected'))
      }
      const completion = yield* Deferred.make<boolean, NativeDesktopControlError>()
      const installed = yield* Ref.modify(pendingProfileSelection, (current) => (
        current ? [false, current] : [true, completion]
      ))
      if (!installed) {
        return yield* Effect.fail(controlError(
          'Native bridge profile selection is already in progress',
        ))
      }
      const removePending = Ref.update(pendingProfileSelection, (current) =>
        current === completion ? null : current)
      const selected = yield* Effect.try({
        try: () => port.postMessage({
          version: NATIVE_PROFILE_SELECTION_VERSION,
          type: 'select-profile',
          profileId,
        }),
        catch: (cause) => controlError(errorMessage(cause)),
      }).pipe(
        Effect.andThen(Deferred.await(completion)),
        Effect.timeoutOrElse({
          duration: '6 seconds',
          orElse: () => Effect.fail(controlError(
            'The native bridge profile-selection request timed out',
          )),
        }),
        Effect.ensuring(removePending),
      )
      if (!selected) {
        return yield* Effect.fail(controlError(
          'Another Chrome profile was selected first for the macOS integration',
        ))
      }
    })

    const transferCurrentProfile = Effect.fn(
      'NativePlacementBridge.transferCurrentProfile',
    )(function* (expectedOwnerRevision: string) {
      const transfer = Effect.gen(function* () {
        const currentStatus = yield* Ref.get(status)
        if (currentStatus.profileSelection === 'selected') {
          return { ok: true } as const
        }
        if (
          currentStatus.profileSelection !== 'another-profile' ||
          currentStatus.ownerRevision !== expectedOwnerRevision
        ) {
          return { ok: false, reason: 'selection-changed' } as const
        }
        if (!currentStatus.profileTransferAvailable) {
          return { ok: false, reason: 'update-required' } as const
        }
        if (yield* Ref.get(pendingProfileSelection)) {
          return { ok: false, reason: 'busy' } as const
        }

        const completion = yield* Deferred.make<NativeIntegrationProfileTransferResponse>()
        const pending = {
          completion,
          expectedOwnerRevision,
          phase: 'starting' as const,
          requestPort: null,
        }
        const installed = yield* Ref.modify(pendingProfileTransfer, (current) => (
          current ? [false, current] : [true, pending]
        ))
        if (!installed) return { ok: false, reason: 'busy' } as const

        const removePending = Ref.update(pendingProfileTransfer, (current) =>
          current?.completion === completion ? null : current)
        const reconcileAfterTimeout = Effect.gen(function* () {
          const current = yield* Ref.get(pendingProfileTransfer)
          if (
            current?.completion !== completion ||
            current.phase !== 'awaiting-result'
          ) {
            return nativeProfileTransferIndeterminate
          }
          yield* Ref.update(pendingProfileTransfer, (candidate) => (
            candidate === current
              ? { ...candidate, phase: 'reconciling' as const }
              : candidate
          ))
          yield* Effect.sync(() => disconnectActivePort?.())
          yield* Queue.offer(manualReconnects, undefined)
          return yield* Deferred.await(completion).pipe(
            Effect.timeoutOrElse({
              duration: '4 seconds',
              orElse: () => Effect.succeed(nativeProfileTransferIndeterminate),
            }),
          )
        })
        return yield* Queue.offer(manualReconnects, undefined).pipe(
          Effect.andThen(Deferred.await(completion)),
          Effect.timeoutOrElse({
            duration: '10 seconds',
            orElse: () => reconcileAfterTimeout,
          }),
          Effect.ensuring(removePending),
        )
      })
      const result = yield* Effect.result(transfer)
      const response = Result.isSuccess(result)
        ? result.success
        : nativeProfileTransferIndeterminate

      if (!response.ok && response.reason === 'indeterminate' && (yield* Ref.get(activePort))) {
        yield* Effect.sync(() => disconnectActivePort?.())
      }
      return response
    })

    const beginDesktopWindowMerge = Effect.fn(
      'NativePlacementBridge.beginDesktopWindowMerge',
    )(function* () {
      const acquired = yield* Ref.modify(profileTransferActivity, (current) => {
        if (current.drainRequestId !== null || current.mergeRunning) {
          return [false, current] as const
        }
        return [true, { ...current, mergeRunning: true }] as const
      })
      if (!acquired) {
        return yield* Effect.fail(controlError(
          'A native integration action is already in progress',
        ))
      }
    })

    const finishDesktopWindowMerge = Effect.fn(
      'NativePlacementBridge.finishDesktopWindowMerge',
    )(function* () {
      yield* Ref.update(profileTransferActivity, (current) => ({
        ...current,
        mergeRunning: false,
      }))
    })

    const requestControl = Effect.fn('NativePlacementBridge.requestControl')(function* (
      type: 'resolve-desktop-windows' | 'revalidate-desktop-windows',
      destinationWindowId: number,
      selectionToken?: string,
    ) {
      if ((yield* Ref.get(profileTransferActivity)).drainRequestId !== null) {
        return yield* Effect.fail(controlError(
          'The native integration is switching Chrome profiles',
        ))
      }
      const port = yield* Ref.get(activePort)
      if (!port) return yield* Effect.fail(controlError('The native bridge is not connected'))
      const currentStatus = yield* Ref.get(status)
      if (
        !currentStatus.controllerConnected ||
        !currentStatus.capabilities.includes(NATIVE_MERGE_DESKTOP_CAPABILITY)
      ) {
        return yield* Effect.fail(controlError(
          'The Hammerspoon desktop-window controller is not connected',
        ))
      }

      const profileWindowIds = yield* readProfileWindowIds()
      if (!profileWindowIds.includes(destinationWindowId)) {
        return yield* Effect.fail(controlError(
          'The invoking Tab Out window is not an eligible profile window',
        ))
      }

      const requestId = `extension-control-${crypto.randomUUID()}`
      const completion = yield* Deferred.make<
        NativeControlResponse,
        NativeDesktopControlError
      >()
      yield* Ref.update(pendingControlRequests, (current) => {
        const next = new Map(current)
        next.set(requestId, completion)
        return next
      })
      const removePending = Ref.update(pendingControlRequests, (current) => {
        if (current.get(requestId) !== completion) return current
        const next = new Map(current)
        next.delete(requestId)
        return next
      })

      const result = yield* Effect.try({
        try: () => port.postMessage(omitUndefined({
          version: NATIVE_CONTROL_BRIDGE_VERSION,
          type,
          requestId,
          expiresAtMs: Date.now() + 5_000,
          destinationWindowId,
          profileWindowIds,
          selectionToken,
        })),
        catch: (cause) => controlError(errorMessage(cause)),
      }).pipe(
        Effect.andThen(Deferred.await(completion)),
        Effect.timeoutOrElse({
          duration: '6 seconds',
          orElse: () => Effect.fail(controlError('The native control request timed out')),
        }),
        Effect.ensuring(removePending),
      )

      if (result.status === 'rejected') {
        return yield* Effect.fail(controlError(
          result.reason || 'The desktop-window controller rejected the request',
        ))
      }
      if (
        !result.windowIds ||
        !result.windowIds.includes(destinationWindowId) ||
        new Set(result.windowIds).size !== result.windowIds.length
      ) {
        return yield* Effect.fail(controlError(
          'The desktop-window controller returned an invalid window selection',
        ))
      }
      return {
        selectionToken: selectionToken ?? requestId,
        windowIds: result.windowIds,
      }
    })

    return NativePlacementBridge.of({
      beginDesktopWindowMerge,
      finishDesktopWindowMerge,
      getStatus: () => Ref.get(status),
      refreshStatus,
      selectCurrentProfile,
      transferCurrentProfile,
      resolveDesktopWindows: (destinationWindowId) => requestControl(
        'resolve-desktop-windows',
        destinationWindowId,
      ),
      revalidateDesktopWindows: (destinationWindowId, selectionToken) => requestControl(
        'revalidate-desktop-windows',
        destinationWindowId,
        selectionToken,
      ),
    })
  }))
}
