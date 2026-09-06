import assert from 'node:assert/strict'
import { afterEach, it, vi } from '@effect/vitest'
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import {
  NATIVE_CONTROL_BRIDGE_VERSION,
  NATIVE_MERGE_DESKTOP_CAPABILITY,
  NATIVE_PLACEMENT_BRIDGE_VERSION,
  NATIVE_PROFILE_SELECTION_VERSION,
  NATIVE_PROFILE_TRANSFER_DRAIN_CAPABILITY,
  NativePlacementBridge,
  handleNativePlacementBridgeMessageEffect,
  makeNativePlacementBridgeLayer,
} from '../../src/extension/background/native-placement-bridge.js'
import type { ChromeApi } from '../../src/extension/background/chrome-api.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const nowMs = 1_800_000_000_000
const testProfileId = '11111111-1111-4111-8111-111111111111'
const testOwnerRevision = '22222222-2222-4222-8222-222222222222'

function nativeProfileStorage(profileId = testProfileId) {
  const stored: Record<string, unknown> = {
    nativeIntegrationProfileIdV1: profileId,
  }
  return {
    local: {
      async get(key: string) {
        return { [key]: stored[key] }
      },
      async set(values: Record<string, unknown>) {
        Object.assign(stored, values)
      },
    },
  }
}

function createNativeBridgeHarness(options: {
  readonly failConnectionAt?: number
  readonly getAllWindows?: () => Promise<chrome.windows.Window[]>
  readonly onStatusChanged?: () => void
} = {}) {
  const disconnectListeners: Array<() => void> = []
  const messageListeners: Array<(message: unknown) => void> = []
  const postedMessages: unknown[] = []
  const runtimeMessages: unknown[] = []
  const counts = { connections: 0, disconnects: 0 }
  const noOp = () => {}
  const chromeApi = {
    runtime: {
      async sendMessage(message: unknown) {
        runtimeMessages.push(message)
        options.onStatusChanged?.()
      },
      connectNative() {
        counts.connections += 1
        if (counts.connections === options.failConnectionAt) {
          throw new Error('Native host unavailable')
        }
        return {
          disconnect() {
            counts.disconnects += 1
          },
          onMessage: {
            addListener(listener: (message: unknown) => void) {
              messageListeners.push(listener)
            },
            removeListener: noOp,
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener: noOp,
          },
          postMessage(message: unknown) {
            postedMessages.push(message)
          },
        }
      },
    },
    storage: nativeProfileStorage(),
    ...(options.getAllWindows ? { windows: { getAll: options.getAllWindows } } : {}),
  } as unknown as ChromeApi

  return {
    chromeApi,
    counts,
    disconnectListeners,
    messageListeners,
    postedMessages,
    runtimeMessages,
  }
}

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

const waitForCondition = Effect.fn('nativePlacementBridgeTest.waitForCondition')(
  function (condition: () => boolean): Effect.Effect<void> {
    return Effect.promise(() => new Promise<void>((resolve, reject) => {
      let attempts = 0
      const inspect = () => {
        if (condition()) {
          resolve()
          return
        }
        attempts += 1
        if (attempts >= 100) {
          reject(new Error('timed out waiting for native bridge test condition'))
          return
        }
        setImmediate(inspect)
      }
      inspect()
    }))
  },
)

function handleNativePlacementBridgeMessage(
  message: unknown,
  chromeApi: ChromeApi,
  at: number,
) {
  return handleNativePlacementBridgeMessageEffect(message, chromeApi, at)
}

const targetDisplay = {
  id: 'target-display',
  isPrimary: false,
  isInternal: false,
  isEnabled: true,
  bounds: { left: 1440, top: 0, width: 1920, height: 1080 },
  workArea: { left: 1440, top: 25, width: 1920, height: 1055 },
  rotation: 0,
  dpiX: 110,
  dpiY: 110,
} as chrome.system.display.DisplayUnitInfo

function createChromeApi(windows: chrome.windows.Window[] = []) {
  const createCalls: chrome.windows.CreateData[] = []
  const chromeApi = {
    runtime: { id: 'tab-out' },
    storage: nativeProfileStorage(),
    system: {
      display: {
        async getInfo() {
          return [targetDisplay]
        },
      },
    },
    windows: {
      async getAll() {
        return windows
      },
      async create(createData: chrome.windows.CreateData) {
        createCalls.push(createData)
        return { id: 91, type: 'normal', focused: false, state: 'normal' } as chrome.windows.Window
      },
    },
  } as unknown as ChromeApi

  return { chromeApi, createCalls }
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'create-window',
    requestId: 'hs-1800000000000-1',
    expiresAtMs: nowMs + 12_000,
    operation: 'filter',
    targetBounds: targetDisplay.bounds,
    ...overrides,
  }
}

it.effect('native placement bridge uses its request ID only in the created bootstrap URL', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  const creationToken = 'hs:1800000000000:filter'

  const result = yield* handleNativePlacementBridgeMessage(createRequest({
    requestId: creationToken,
  }), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: creationToken,
    status: 'accepted',
    browserWindowId: 91,
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?focusFilter=1&tabOutPlacement=hs%3A1800000000000%3Afilter',
    focused: false,
    left: 1440,
    top: 25,
    width: 1920,
    height: 1055,
  }])
}))

it.effect('native placement bridge creates new-page requests through a uniquely tokenized Tab Out document', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  const creationToken = 'hs:1800000000000:newPage'

  const result = yield* handleNativePlacementBridgeMessage(createRequest({
    operation: 'newPage',
    requestId: creationToken,
  }), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: creationToken,
    status: 'accepted',
    browserWindowId: 91,
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?tabOutPlacement=hs%3A1800000000000%3AnewPage',
    focused: false,
    left: 1440,
    top: 25,
    width: 1920,
    height: 1055,
  }])
}))

it.effect('native placement bridge status handshake does not create a window', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()

  const result = yield* handleNativePlacementBridgeMessage(createRequest({ type: 'status' }), chromeApi, nowMs)

  assert.equal(result.status, 'accepted')
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge reports profile-owned normal window identities without focusing them', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi([
    { id: 71, type: 'normal', focused: false, state: 'normal' },
    { id: 72, type: 'popup', focused: false, state: 'normal' },
    { id: 73, type: 'normal', focused: false, state: 'minimized' },
    { type: 'normal', focused: false, state: 'normal' },
  ] as chrome.windows.Window[])

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ type: 'list-profile-windows' }),
    chromeApi,
    nowMs,
  )

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'accepted',
    windowIds: [71],
  })
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge turns a rejected profile-window read into a response', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  Object.assign(chromeApi.windows, {
    async getAll() {
      throw new Error('Profile window inventory unavailable')
    },
  })

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ type: 'list-profile-windows' }),
    chromeApi,
    nowMs,
  )

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'rejected',
    reason: 'Profile window inventory unavailable',
  })
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge turns a rejected placement read into a response', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  Object.assign(chromeApi.system.display, {
    async getInfo() {
      throw new Error('Display inventory unavailable')
    },
  })

  const result = yield* handleNativePlacementBridgeMessage(createRequest(), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'rejected',
    reason: 'Display inventory unavailable',
  })
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge rejects an expired request before mutation', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ expiresAtMs: nowMs - 1 }),
    chromeApi,
    nowMs,
  )

  assert.equal(result.status, 'rejected')
  assert.match(result.reason ?? '', /expired/)
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge rejects malformed target bounds before mutation', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ targetBounds: { left: 0, top: 0, width: 0, height: 900 } }),
    chromeApi,
    nowMs,
  )

  assert.equal(result.status, 'rejected')
  assert.match(result.reason ?? '', /target bounds/)
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge schema preserves envelope rejection reasons', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  const cases: ReadonlyArray<{ message: unknown, reason: RegExp, requestId: string }> = [
    { message: null, reason: /not an object/, requestId: 'invalid' },
    {
      message: createRequest({ version: NATIVE_PLACEMENT_BRIDGE_VERSION + 1 }),
      reason: /version is unsupported/,
      requestId: 'hs-1800000000000-1',
    },
    {
      message: createRequest({ requestId: 'contains spaces' }),
      reason: /request ID is invalid/,
      requestId: 'invalid',
    },
    {
      message: createRequest({ type: 'unknown' }),
      reason: /request type is unsupported/,
      requestId: 'hs-1800000000000-1',
    },
    {
      message: createRequest({ operation: 'unknown' }),
      reason: /operation is invalid/,
      requestId: 'hs-1800000000000-1',
    },
    {
      message: createRequest({
        targetBounds: { left: 100_001, top: 0, width: 900, height: 700 },
      }),
      reason: /target bounds are invalid/,
      requestId: 'hs-1800000000000-1',
    },
  ]

  for (const entry of cases) {
    const result = yield* handleNativePlacementBridgeMessage(entry.message, chromeApi, nowMs)
    assert.equal(result.status, 'rejected')
    assert.equal(result.requestId, entry.requestId)
    assert.match(result.reason ?? '', entry.reason)
  }
  assert.deepEqual(createCalls, [])
}))

it.effect('native bridge correlates desktop control while placement work is pending', () => Effect.gen(function* () {
  const messageListeners: Array<(message: unknown) => void> = []
  const postedMessages: unknown[] = []
  const runtimeMessages: unknown[] = []
  const postedMessage = Deferred.makeUnsafe<unknown>()
  const profileHello = Deferred.makeUnsafe<unknown>()
  const displayInfo = Promise.withResolvers<chrome.system.display.DisplayUnitInfo[]>()
  let placementStarted = false
  let selectionCompleted = false
  const stored: Record<string, unknown> = {}
  const noOp = () => {}
  const chromeApi = {
    runtime: {
      async sendMessage(message: unknown) {
        runtimeMessages.push(message)
      },
      connectNative() {
        return {
          disconnect() {},
          onMessage: {
            addListener(listener: (message: unknown) => void) {
              messageListeners.push(listener)
            },
            removeListener: noOp,
          },
          onDisconnect: { addListener: noOp, removeListener: noOp },
          postMessage(message: unknown) {
            postedMessages.push(message)
            if ((message as Record<string, unknown>).type === 'profile-hello') {
              Deferred.doneUnsafe(profileHello, Effect.succeed(message))
            } else {
              Deferred.doneUnsafe(postedMessage, Effect.succeed(message))
            }
          },
        }
      },
    },
    storage: {
      local: {
        async get(key: string) {
          return { [key]: stored[key] }
        },
        async set(values: Record<string, unknown>) {
          Object.assign(stored, values)
        },
      },
    },
    system: {
      display: {
        getInfo() {
          placementStarted = true
          return displayInfo.promise
        },
      },
    },
    windows: {
      async getAll() {
        return [
          {
            id: 71,
            type: 'normal',
            state: 'normal',
            left: 1_500,
            top: 25,
            width: 1_200,
            height: 900,
          },
          {
            id: 72,
            type: 'normal',
            state: 'maximized',
            left: 1_500,
            top: 25,
            width: 1_200,
            height: 900,
          },
          {
            id: 73,
            type: 'normal',
            state: 'minimized',
            left: 1_500,
            top: 25,
            width: 1_200,
            height: 900,
          },
          {
            id: 74,
            type: 'popup',
            state: 'normal',
            left: 1_500,
            top: 25,
            width: 1_200,
            height: 900,
          },
        ]
      },
      async create() {
        return { id: 91, type: 'normal', state: 'normal' }
      },
    },
  } as unknown as ChromeApi

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* Deferred.await(profileHello)
  assert.deepEqual(postedMessages, [{
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-hello',
    profileId: stored.nativeIntegrationProfileIdV1,
  }])
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'controller-status',
    connected: true,
    capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
  })
  yield* waitForCondition(() => runtimeMessages.length === 3)

  assert.deepEqual(yield* bridge.getStatus(), {
    capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
    controllerConnected: true,
    hostConnected: true,
    initialConnectionSettled: true,
    ownerRevision: testOwnerRevision,
    profileSelection: 'selected',
    profileTransferAvailable: false,
  })
  assert.deepEqual(runtimeMessages, [
    { type: 'tab-out:desktop-window-merge-status-changed' },
    { type: 'tab-out:desktop-window-merge-status-changed' },
    { type: 'tab-out:desktop-window-merge-status-changed' },
  ])

  valueAt(messageListeners, 0)(createRequest())
  yield* waitForCondition(() => placementStarted)

  const selectionFiber = yield* bridge.resolveDesktopWindows(71).pipe(
    Effect.tap(() => Effect.sync(() => {
      selectionCompleted = true
    })),
    Effect.forkChild({ startImmediately: true }),
  )
  const request = (yield* Deferred.await(postedMessage)) as Record<string, unknown>
  assert.equal(postedMessages.length, 2)
  assert.equal(request.version, NATIVE_CONTROL_BRIDGE_VERSION)
  assert.equal(request.type, 'resolve-desktop-windows')
  assert.equal(request.destinationWindowId, 71)
  assert.deepEqual(request.profileWindowIds, [71, 72])
  const requestId = request.requestId
  assert.equal(typeof requestId, 'string')

  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'response',
    requestId,
    status: 'accepted',
    windowIds: [72, 71],
  })
  yield* waitForCondition(() => selectionCompleted)
  assert.deepEqual(yield* Fiber.join(selectionFiber), {
    selectionToken: requestId,
    windowIds: [72, 71],
  })
  displayInfo.resolve([targetDisplay])
  yield* waitForCondition(() => postedMessages.length === 3)
  assert.deepEqual(postedMessages[2], {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'accepted',
    browserWindowId: 91,
  })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge explicitly selects the current Chrome profile', () => Effect.gen(function* () {
  const { chromeApi, messageListeners, postedMessages, runtimeMessages } =
    createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'required',
    capabilities: ['profile-transfer'],
  })
  yield* waitForCondition(() => runtimeMessages.length === 2)
  assert.equal((yield* bridge.getStatus()).profileSelection, 'required')

  const selectionFiber = yield* Effect.forkChild(bridge.selectCurrentProfile())
  yield* waitForCondition(() => postedMessages.length === 2)
  assert.equal((yield* bridge.refreshStatus()).profileSelection, 'required')
  assert.deepEqual(postedMessages[1], {
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'select-profile',
    profileId: testProfileId,
  })
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* Fiber.join(selectionFiber)
  assert.equal((yield* bridge.getStatus()).profileSelection, 'selected')
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge does not reconnect a later unselected Chrome profile', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, runtimeMessages } = createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => messageListeners.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => runtimeMessages.length === 3)
  yield* TestClock.adjust(60_000)

  assert.equal(counts.connections, 1)
  assert.equal(counts.disconnects, 1)
  assert.deepEqual(yield* bridge.getStatus(), {
    capabilities: [],
    controllerConnected: false,
    hostConnected: false,
    initialConnectionSettled: true,
    ownerRevision: testOwnerRevision,
    profileSelection: 'another-profile',
    profileTransferAvailable: true,
  })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('menu status checks share one read-only refresh of a stale profile capability', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness()
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: [],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)
  assert.equal((yield* bridge.getStatus()).profileTransferAvailable, false)
  yield* bridge.getStatus()
  yield* TestClock.adjust(60_000)
  assert.equal(counts.connections, 1)

  const first = yield* Effect.forkChild(bridge.refreshStatus(), { startImmediately: true })
  const second = yield* Effect.forkChild(bridge.refreshStatus(), { startImmediately: true })
  yield* waitForCondition(() => postedMessages.length === 2)
  assert.equal(counts.connections, 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  const refreshed = yield* Fiber.join(first)
  assert.deepEqual(yield* Fiber.join(second), refreshed)
  assert.equal(refreshed.profileTransferAvailable, true)
  assert.equal(refreshed.ownerRevision, testOwnerRevision)
  yield* waitForCondition(() => counts.disconnects === 2)
  yield* TestClock.adjust(60_000)
  assert.equal(counts.connections, 2)
  assert.deepEqual(postedMessages, Array.from({ length: 2 }, () => ({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-hello',
    profileId: testProfileId,
  })))
  yield* Scope.close(scope, Exit.void)
}))

it.effect('a failed menu status reconnect clears stale capability and waits for another menu open', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness({
    failConnectionAt: 2,
  })
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const unavailable = yield* bridge.refreshStatus()
  assert.equal(unavailable.profileTransferAvailable, false)
  assert.equal(unavailable.ownerRevision, null)
  assert.equal(unavailable.hostConnected, false)
  yield* TestClock.adjust(120_000)
  assert.equal(counts.connections, 2)

  const retry = yield* Effect.forkChild(bridge.refreshStatus())
  yield* waitForCondition(() => counts.connections === 3 && postedMessages.length === 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  assert.equal((yield* Fiber.join(retry)).profileTransferAvailable, true)
  yield* Scope.close(scope, Exit.void)
}))

it.effect('a menu opening during native disconnect cleanup shares the settled handshake', () => Effect.gen(function* () {
  let statusChanges = 0
  let overlapCompleted = false
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness({
    onStatusChanged: () => {
      statusChanges += 1
      if (statusChanges !== 3) return
      assert.ok(bridge)
      const status = Effect.runSync(bridge.refreshStatus())
      assert.equal(status.hostConnected, false)
      assert.equal(status.profileTransferAvailable, true)
      overlapCompleted = true
    },
  })
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => overlapCompleted)
  yield* TestClock.adjust(120_000)
  assert.equal(counts.connections, 1)
  yield* Scope.close(scope, Exit.void)
}))

it.effect('a menu status timeout ends its handshake without restarting automatic reconnects', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness()
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const refresh = yield* Effect.forkChild(bridge.refreshStatus())
  yield* waitForCondition(() => postedMessages.length === 2)
  yield* TestClock.adjust(4_000)
  const unavailable = yield* Fiber.join(refresh)
  assert.equal(unavailable.profileTransferAvailable, false)
  assert.equal(unavailable.ownerRevision, null)
  assert.equal(unavailable.hostConnected, false)
  assert.equal(counts.disconnects, 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* TestClock.adjust(120_000)
  assert.equal(counts.connections, 2)
  assert.equal((yield* bridge.getStatus()).profileTransferAvailable, false)

  const retry = yield* Effect.forkChild(bridge.refreshStatus())
  yield* waitForCondition(() => postedMessages.length === 3)
  valueAt(messageListeners, 2)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'required',
    capabilities: ['profile-transfer'],
  })
  assert.equal((yield* Fiber.join(retry)).profileSelection, 'required')
  yield* Scope.close(scope, Exit.void)
}))

it.effect('menu status refresh reuses the initial handshake and keeps a selected owner connected', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness()
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  const refresh = yield* Effect.forkChild(bridge.refreshStatus(), { startImmediately: true })
  assert.equal(counts.connections, 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  assert.equal((yield* Fiber.join(refresh)).profileSelection, 'selected')
  yield* bridge.refreshStatus()
  yield* bridge.beginDesktopWindowMerge()
  yield* bridge.refreshStatus()
  yield* TestClock.adjust(60_000)
  assert.equal(counts.connections, 1)
  assert.equal(counts.disconnects, 0)
  yield* bridge.finishDesktopWindowMerge()
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge exposes setup guidance when a transfer reconnect is unavailable', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness({
    failConnectionAt: 2,
  })

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  assert.deepEqual(yield* bridge.transferCurrentProfile(testOwnerRevision), {
    ok: false,
    reason: 'failed',
  })
  assert.deepEqual(yield* bridge.getStatus(), {
    capabilities: [],
    controllerConnected: false,
    hostConnected: false,
    initialConnectionSettled: true,
    ownerRevision: null,
    profileSelection: 'unknown',
    profileTransferAvailable: false,
  })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge transfers a confirmed profile through a one-shot reconnect', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const transferFiber = yield* Effect.forkChild(
    bridge.transferCurrentProfile(testOwnerRevision),
  )
  yield* waitForCondition(() => counts.connections === 2 && postedMessages.length === 2)
  assert.equal((yield* bridge.refreshStatus()).profileSelection, 'unknown')
  assert.equal(counts.connections, 2)
  assert.equal(counts.disconnects, 1)
  assert.deepEqual(postedMessages[1], {
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-hello',
    profileId: testProfileId,
  })
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => postedMessages.length === 3)
  assert.deepEqual(postedMessages[2], {
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'transfer-profile',
    profileId: testProfileId,
    expectedOwnerRevision: testOwnerRevision,
  })

  const replacementRevision = '33333333-3333-4333-8333-333333333333'
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: ['profile-transfer'],
    ownerRevision: replacementRevision,
  })
  assert.deepEqual(yield* Fiber.join(transferFiber), { ok: true })
  assert.deepEqual(yield* bridge.getStatus(), {
    capabilities: [],
    controllerConnected: false,
    hostConnected: true,
    initialConnectionSettled: true,
    ownerRevision: replacementRevision,
    profileSelection: 'selected',
    profileTransferAvailable: false,
  })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge reconciles a committed transfer after its acknowledgement is lost', () => Effect.gen(function* () {
  const {
    chromeApi,
    counts,
    disconnectListeners,
    messageListeners,
    postedMessages,
  } = createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const transfer = yield* Effect.forkChild(
    bridge.transferCurrentProfile(testOwnerRevision),
  )
  yield* waitForCondition(() => counts.connections === 2 && postedMessages.length === 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => postedMessages.length === 3)

  valueAt(disconnectListeners, 1)()
  yield* waitForCondition(() => counts.connections === 3 && postedMessages.length === 4)
  assert.equal((yield* bridge.refreshStatus()).profileSelection, 'unknown')
  assert.equal(counts.connections, 3)
  const replacementRevision = '33333333-3333-4333-8333-333333333333'
  valueAt(messageListeners, 2)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: [],
    ownerRevision: replacementRevision,
  })

  assert.deepEqual(yield* Fiber.join(transfer), { ok: true })
  assert.equal((yield* bridge.getStatus()).ownerRevision, replacementRevision)
  assert.deepEqual(postedMessages.filter((message) =>
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'type') === 'transfer-profile').length, 1)
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge reports indeterminate when acknowledgement reconciliation cannot reconnect', () => Effect.gen(function* () {
  const {
    chromeApi,
    counts,
    disconnectListeners,
    messageListeners,
    postedMessages,
  } = createNativeBridgeHarness({ failConnectionAt: 3 })

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const transfer = yield* Effect.forkChild(bridge.transferCurrentProfile(testOwnerRevision))
  yield* waitForCondition(() => counts.connections === 2 && postedMessages.length === 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => postedMessages.length === 3)

  valueAt(disconnectListeners, 1)()
  yield* waitForCondition(() => counts.connections === 3)
  assert.deepEqual(yield* Fiber.join(transfer), {
    ok: false,
    reason: 'indeterminate',
  })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge refreshes authority after a stale profile transfer', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages, runtimeMessages } =
    createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const transfer = yield* Effect.forkChild(bridge.transferCurrentProfile(testOwnerRevision))
  yield* waitForCondition(() => counts.connections === 2 && postedMessages.length === 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => postedMessages.length === 3)
  const replacementOwnerRevision = '33333333-3333-4333-8333-333333333333'
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-result',
    status: 'rejected',
    reason: 'selection-changed',
    ownerRevision: replacementOwnerRevision,
  })
  assert.deepEqual(yield* Fiber.join(transfer), {
    ok: false,
    reason: 'selection-changed',
  })
  const staleTransferStatus = yield* bridge.getStatus()
  assert.equal(staleTransferStatus.ownerRevision, replacementOwnerRevision)
  assert.equal(staleTransferStatus.profileTransferAvailable, false)

  yield* waitForCondition(() => counts.connections === 3 && postedMessages.length === 4)
  const messageCountBeforeRefreshStatus = runtimeMessages.length
  valueAt(messageListeners, 2)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'required',
    capabilities: ['profile-transfer'],
  })
  yield* waitForCondition(() => runtimeMessages.length > messageCountBeforeRefreshStatus)
  assert.equal((yield* bridge.getStatus()).profileSelection, 'required')
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge clears a timed-out profile transfer before a retry', () => Effect.gen(function* () {
  const { chromeApi, counts, messageListeners, postedMessages } = createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => counts.disconnects === 1)

  const timedOutTransfer = yield* Effect.forkChild(
    bridge.transferCurrentProfile(testOwnerRevision),
  )
  yield* waitForCondition(() => counts.connections === 2 && postedMessages.length === 2)
  valueAt(messageListeners, 1)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => postedMessages.length === 3)
  yield* TestClock.adjust(10_000)
  yield* waitForCondition(() => counts.connections === 3 && postedMessages.length === 4)
  valueAt(messageListeners, 2)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  assert.deepEqual(yield* Fiber.join(timedOutTransfer), { ok: false, reason: 'failed' })
  yield* waitForCondition(() => counts.disconnects === 3)

  const retry = yield* Effect.forkChild(bridge.transferCurrentProfile(testOwnerRevision))
  yield* waitForCondition(() => counts.connections === 4 && postedMessages.length === 5)
  valueAt(messageListeners, 3)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'another-profile',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  yield* waitForCondition(() => postedMessages.length === 6)
  valueAt(messageListeners, 3)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-result',
    status: 'rejected',
    reason: 'busy',
    ownerRevision: testOwnerRevision,
  })
  assert.deepEqual(yield* Fiber.join(retry), { ok: false, reason: 'busy' })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge only attests idle when merge and transfer drains do not overlap', () => Effect.gen(function* () {
  const { chromeApi, messageListeners, postedMessages } = createNativeBridgeHarness()

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => postedMessages.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'controller-status',
    connected: true,
    capabilities: [
      NATIVE_MERGE_DESKTOP_CAPABILITY,
      NATIVE_PROFILE_TRANSFER_DRAIN_CAPABILITY,
    ],
  })
  yield* bridge.beginDesktopWindowMerge()
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-prepare',
    requestId: 'profile-transfer-busy',
  })
  yield* waitForCondition(() => postedMessages.length === 2)
  assert.deepEqual(postedMessages[1], {
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-response',
    requestId: 'profile-transfer-busy',
    status: 'busy',
  })

  yield* bridge.finishDesktopWindowMerge()
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-prepare',
    requestId: 'profile-transfer-idle',
  })
  yield* waitForCondition(() => postedMessages.length === 3)
  assert.deepEqual(postedMessages[2], {
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-response',
    requestId: 'profile-transfer-idle',
    status: 'idle',
  })
  assert.equal(Exit.isFailure(yield* Effect.exit(bridge.beginDesktopWindowMerge())), true)

  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-transfer-cancel',
    requestId: 'profile-transfer-idle',
  })
  yield* Effect.yieldNow
  yield* bridge.beginDesktopWindowMerge()
  yield* bridge.finishDesktopWindowMerge()
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge rejects an oversized profile window inventory before transport', () => Effect.gen(function* () {
  const { chromeApi, messageListeners, postedMessages } = createNativeBridgeHarness({
    getAllWindows: async () => Array.from({ length: 513 }, (_, index) => ({
      id: index + 1,
      type: 'normal',
      state: 'normal',
    } as chrome.windows.Window)),
  })

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  yield* waitForCondition(() => messageListeners.length === 1)
  valueAt(messageListeners, 0)({
    version: NATIVE_PROFILE_SELECTION_VERSION,
    type: 'profile-selection-status',
    selection: 'selected',
    capabilities: ['profile-transfer'],
    ownerRevision: testOwnerRevision,
  })
  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'controller-status',
    connected: true,
    capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
  })
  yield* Effect.yieldNow

  const result = yield* Effect.exit(bridge.resolveDesktopWindows(71))
  assert.equal(Exit.isFailure(result), true)
  assert.deepEqual(
    postedMessages.filter((message) =>
      (message as Record<string, unknown>).type !== 'profile-hello'),
    [],
  )
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native placement bridge reconnects after the host port disconnects', () => Effect.gen(function* () {
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  const noOp = () => {}
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          disconnect() {},
          onMessage: {
            addListener() {},
            removeListener() {},
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener: noOp,
          },
          postMessage() {},
        }
      },
    },
    storage: nativeProfileStorage(),
  } as unknown as ChromeApi

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  yield* waitForCondition(() => connectionCount === 1)
  assert.equal(connectionCount, 1)

  valueAt(disconnectListeners, 0)()
  yield* TestClock.adjust(250)

  assert.equal(connectionCount, 2)
}))

it.effect('native placement bridge escalates delays across connection failures', () => Effect.gen(function* () {
  let connectionCount = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        if (connectionCount < 3) throw new Error('Native host unavailable')
        return {
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
          postMessage() {},
        }
      },
    },
    storage: nativeProfileStorage(),
  } as unknown as ChromeApi

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  yield* waitForCondition(() => connectionCount === 1)
  assert.equal(connectionCount, 1)

  yield* TestClock.adjust(249)
  assert.equal(connectionCount, 1)
  yield* TestClock.adjust(1)
  assert.equal(connectionCount, 2)

  yield* TestClock.adjust(999)
  assert.equal(connectionCount, 2)
  yield* TestClock.adjust(1)
  assert.equal(connectionCount, 3)
}))

it.effect('native placement bridge backs off beyond the MV3 idle window when the host stays unavailable', () => Effect.gen(function* () {
  let connectionCount = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { chromeApi } = createChromeApi()
  chromeApi.runtime.connectNative = () => {
    connectionCount += 1
    throw new Error('Native host unavailable')
  }

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  yield* waitForCondition(() => connectionCount === 1)
  assert.equal(connectionCount, 1)

  yield* TestClock.adjust(250)
  assert.equal(connectionCount, 2)
  yield* TestClock.adjust(1_000)
  assert.equal(connectionCount, 3)
  yield* TestClock.adjust(5_000)
  assert.equal(connectionCount, 4)

  yield* TestClock.adjust(30_000)
  assert.equal(connectionCount, 4)
}))

it.effect('native placement bridge resets backoff after a native message', () => Effect.gen(function* () {
  vi.useFakeTimers({ now: nowMs, toFake: ['Date'] })
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          disconnect() {},
          onMessage: {
            addListener(listener: (message: unknown) => void) {
              messageListeners.push(listener)
            },
            removeListener() {},
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener() {},
          },
          postMessage() {},
        }
      },
    },
    storage: nativeProfileStorage(),
  } as unknown as ChromeApi

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  yield* waitForCondition(() => disconnectListeners.length === 1)
  valueAt(disconnectListeners, 0)()
  yield* TestClock.adjust(250)
  assert.equal(connectionCount, 2)

  valueAt(messageListeners, 1)(createRequest({ type: 'status' }))
  yield* Effect.yieldNow
  valueAt(disconnectListeners, 1)()
  yield* TestClock.adjust(249)
  assert.equal(connectionCount, 2)
  yield* TestClock.adjust(1)
  assert.equal(connectionCount, 3)
}))

it.effect('disposing the native placement bridge cancels reconnect sleep', () => Effect.gen(function* () {
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener() {},
          },
          postMessage() {},
        }
      },
    },
    storage: nativeProfileStorage(),
  } as unknown as ChromeApi

  const scope = yield* Scope.make()
  yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  yield* waitForCondition(() => disconnectListeners.length === 1)
  valueAt(disconnectListeners, 0)()
  yield* Scope.close(scope, Exit.void)

  yield* TestClock.adjust(15_000)
  assert.equal(connectionCount, 1)
}))
