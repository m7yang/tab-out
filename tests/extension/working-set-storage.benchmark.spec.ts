import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import { test, type Page, type TestInfo } from '@playwright/test'

import {
  buildWorkingSetStorageBenchmarkArtifacts,
  type WorkingSetBenchmarkArtifactSidecar,
} from '../../scripts/build-working-set-storage-benchmark.js'
import type { WorkingSetBenchmarkVariant } from '../../scripts/working-set-benchmark-build-config.js'
import { chromeSupportPolicy } from '../../src/extension/chrome-support.js'
import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from '../../src/extension/runtime-messages.js'
import type {
  WorkingSetActivityEvent,
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
} from '../../src/extension/types'
import { normalizeWorkingSetActivity } from '../../src/extension/working-set.js'
import {
  makeWorkingSetStorageProfile,
  makeWorkingSetStorageProfiles,
  type WorkingSetStorageProfileName,
} from '../helpers/working-set-storage-profile.js'
import {
  benchmarkCount,
  distribution,
  makeRandom,
  percentile,
} from './benchmark-helpers.js'
import {
  launchInstalledExtensionFromArtifact,
  type InstalledExtension,
} from './installed-extension.js'
import {
  terminateServiceWorkerAndProveAbsent as terminateServiceWorkerTargetAndProveAbsent,
} from './service-worker-cdp.js'
import {
  parseWorkingSetStorageBenchmarkMessage,
  parseWorkingSetStorageBenchmarkResponse,
  WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
  type WorkingSetStorageBenchmarkDiagnostics,
  type WorkingSetStorageBenchmarkEvent,
  type WorkingSetStorageBenchmarkMessage,
  type WorkingSetStorageBenchmarkOwnedStorage,
  type WorkingSetStorageBenchmarkSuccessResponse,
} from './working-set-storage-benchmark-protocol.js'

const BENCHMARK_TIMEOUT_MS = 30 * 60_000
const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const BOOTSTRAP_REPETITIONS = 2_000
const SUPPORTED_PROFILE_NAMES: readonly WorkingSetStorageProfileName[] = [
  'empty',
  '500x20',
  '500x80',
  '250-live-250-expired',
]
const CANDIDATE_COMPLEXITY_ORDER: readonly WorkingSetBenchmarkVariant[] = [
  'compact',
  'shards-32',
  'idb',
]

const WARMUP_PAIR_COUNT = benchmarkCount(
  'TAB_OUT_WORKING_SET_BENCHMARK_WARMUPS',
  5,
)
const MEASURED_PAIR_COUNT = benchmarkCount(
  'TAB_OUT_WORKING_SET_BENCHMARK_RUNS',
  30,
)
const CANONICAL_RUN = WARMUP_PAIR_COUNT === 5 && MEASURED_PAIR_COUNT === 30

type StorageFootprint =
  | {
    readonly kind: 'chrome-storage'
    readonly keys: readonly string[]
    readonly bytesInUse: number
    readonly authority: 'chrome.storage.local.getBytesInUse(ownedKeys)'
  }
  | {
    readonly kind: 'indexed-db'
    readonly database: string
    readonly objectStores: readonly string[]
    readonly originUsageBytes: number | null
    readonly originQuotaBytes: number | null
    readonly comparableToChromeOwnedKeyBytes: false
    readonly authority: 'navigator.storage.estimate() extension-origin allocation'
  }

interface StartupFrameMeasurement {
  readonly serviceStateRequestMs: number
  readonly serviceStateRequestStartedAtMs: number
  readonly serviceStateToHeaderMs: number
  readonly startupFrameReadyMs: number
  readonly preHeaderServiceStateRequestCount: number
  readonly visiblePageChips: number
  readonly wallToHeaderObservationMs: number
  readonly workerAbsentBeforeNavigation: true
}

interface SuccessfulTimedSample {
  readonly status: 'ok'
  readonly phase: 'warmup' | 'measured'
  readonly iteration: number
  readonly order: number
  readonly buildVariant: WorkingSetBenchmarkVariant
  readonly selectedVariant: string
  readonly cold: StartupFrameMeasurement
  readonly timings: {
    readonly controllerRoundTripMs: number
    readonly listenerToCommitMs: number
    readonly fullAppMutationMs: number
    readonly domainOnlyMutationMs: number
    readonly storagePathDomainMutationMs: number
    readonly storageCommitMs: number
    readonly storagePathListenerToCommitMs: number
    readonly warmUncachedStorageReadMs: number
    readonly warmCachedServiceReadMs: number
  }
  readonly navigationDiagnostics: WorkingSetStorageBenchmarkDiagnostics
  readonly storageMutationDiagnostics: WorkingSetStorageBenchmarkDiagnostics
  readonly footprint: StorageFootprint
}

interface FailedTimedSample {
  readonly status: 'failed'
  readonly phase: 'warmup' | 'measured'
  readonly iteration: number
  readonly order: number
  readonly buildVariant: WorkingSetBenchmarkVariant
  readonly error: string
}

type TimedSample = SuccessfulTimedSample | FailedTimedSample

interface CorrectnessCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail?: unknown
  readonly error?: string
}

interface ProfileCheck {
  readonly name: WorkingSetStorageProfileName
  readonly supportedGate: boolean
  readonly passed: boolean
  readonly detail?: unknown
  readonly error?: string
}

interface VariantCorrectnessReport {
  readonly buildVariant: WorkingSetBenchmarkVariant
  readonly selectedVariant: string | null
  readonly selectedVariantMatchesBuild: boolean
  readonly browser: {
    readonly userAgent: string
    readonly actualChromeMajor: number | null
    readonly declaredMinimumChromeMajor: number
    readonly matchesDeclaredMinimum: boolean
  } | null
  readonly profiles: readonly ProfileCheck[]
  readonly checks: readonly CorrectnessCheck[]
  readonly supportedGatePassed: boolean
}

function describeError(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)
}

function chromeMajorFromUserAgent(userAgent: string): number | null {
  const match = /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(userAgent)
  const major = match?.[1]
  return major === undefined ? null : Number(major)
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function requireSuccess(
  response: ReturnType<typeof parseWorkingSetStorageBenchmarkResponse>,
): WorkingSetStorageBenchmarkSuccessResponse {
  if (response === null) throw new Error('Benchmark controller returned an invalid response')
  if (!response.ok) {
    throw new Error(
      `${response.operation} failed: ${response.error.name}: ${response.error.message}`,
    )
  }
  return response
}

async function sendMessage(
  controller: Page,
  message: WorkingSetStorageBenchmarkMessage,
) {
  const raw: unknown = await controller.evaluate(async (request) =>
    chrome.runtime.sendMessage(request), message)
  return parseWorkingSetStorageBenchmarkResponse(raw)
}

async function sendSuccessfulMessage(
  controller: Page,
  message: WorkingSetStorageBenchmarkMessage,
): Promise<WorkingSetStorageBenchmarkSuccessResponse> {
  return requireSuccess(await sendMessage(controller, message))
}

async function openController(
  installed: InstalledExtension,
  artifact: WorkingSetBenchmarkArtifactSidecar,
): Promise<Page> {
  const controller = await installed.context.newPage()
  await controller.goto(
    `chrome-extension://${installed.extensionId}/${artifact.controllerPage}`,
    { waitUntil: 'domcontentloaded' },
  )
  return controller
}

type BenchmarkMessageBody = WorkingSetStorageBenchmarkMessage extends infer Message
  ? Message extends { readonly type: string }
    ? Omit<Message, 'type'>
    : never
  : never

function benchmarkMessage(
  message: BenchmarkMessageBody,
): WorkingSetStorageBenchmarkMessage {
  const parsed = parseWorkingSetStorageBenchmarkMessage({
    type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
    ...message,
  })
  invariant(parsed !== null, `Invalid benchmark message: ${message.operation}`)
  return parsed
}

function makeEvent(
  url: string,
  tabId: number,
  at: number,
  title = 'Example Working Set Page',
): WorkingSetStorageBenchmarkEvent {
  return {
    kind: 'navigation',
    at,
    tabId,
    windowId: 1,
    url,
    title,
  }
}

function sortedRecordKeys(activity: WorkingSetActivityStore): readonly string[] {
  return Object.keys(activity.records).sort()
}

function canonicalActivitySha256(activity: WorkingSetActivityStore): string {
  const records = sortedRecordKeys(activity).map((key) => {
    const record = activity.records[key]
    invariant(record !== undefined, `${key} was absent while hashing activity`)
    return [
      record.key,
      record.url,
      record.title,
      record.domain,
      record.lastSeenAt,
      record.lastActivatedAt ?? null,
      record.lastNavigatedAt ?? null,
      record.dismissedAt ?? null,
      record.dismissedUntil ?? null,
      record.events.map((event) => [event.kind, event.at]),
    ]
  })
  return createHash('sha256').update(JSON.stringify([
    activity.version,
    records,
  ])).digest('hex')
}

function assertEventsEqual(
  actual: readonly WorkingSetActivityEvent[],
  expected: readonly WorkingSetActivityEvent[],
  key: string,
): void {
  invariant(
    actual.length === expected.length,
    `${key} event count was ${String(actual.length)}, expected ${String(expected.length)}`,
  )
  for (const [index, expectedEvent] of expected.entries()) {
    const actualEvent = actual[index]
    invariant(actualEvent !== undefined, `${key} event ${String(index)} was absent`)
    invariant(
      actualEvent.kind === expectedEvent.kind && actualEvent.at === expectedEvent.at,
      `${key} event ${String(index)} did not round-trip exactly`,
    )
  }
}

function assertRecordEqual(
  actual: WorkingSetActivityRecord,
  expected: WorkingSetActivityRecord,
): void {
  const scalarFields: readonly (keyof WorkingSetActivityRecord)[] = [
    'key',
    'url',
    'title',
    'domain',
    'lastSeenAt',
    'lastActivatedAt',
    'lastNavigatedAt',
    'dismissedAt',
    'dismissedUntil',
  ]
  for (const field of scalarFields) {
    invariant(
      actual[field] === expected[field],
      `${expected.key} field ${field} did not round-trip exactly`,
    )
  }
  assertEventsEqual(actual.events, expected.events, expected.key)
}

function assertActivityEqual(
  actual: WorkingSetActivityStore,
  expected: WorkingSetActivityStore,
): void {
  invariant(actual.version === expected.version, 'Working Set version changed')
  const expectedKeys = sortedRecordKeys(expected)
  const actualKeys = sortedRecordKeys(actual)
  invariant(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `Working Set keys differed: actual=${String(actualKeys.length)}, expected=${String(expectedKeys.length)}`,
  )
  for (const key of expectedKeys) {
    const actualRecord = actual.records[key]
    const expectedRecord = expected.records[key]
    invariant(actualRecord !== undefined, `${key} was absent from actual activity`)
    invariant(expectedRecord !== undefined, `${key} was absent from expected activity`)
    assertRecordEqual(actualRecord, expectedRecord)
  }
}

function requireActivity(
  response: WorkingSetStorageBenchmarkSuccessResponse,
): WorkingSetActivityStore {
  invariant(response.activity !== undefined, `${response.operation} omitted activity`)
  return response.activity
}

async function captureStorageFootprint(
  controller: Page,
  ownedStorage: WorkingSetStorageBenchmarkOwnedStorage,
): Promise<StorageFootprint> {
  if (ownedStorage.kind === 'chrome-storage') {
    const keys = [...ownedStorage.keys]
    const bytesInUse = await controller.evaluate((ownedKeys) =>
      chrome.storage.local.getBytesInUse(ownedKeys), keys)
    return {
      kind: 'chrome-storage',
      keys,
      bytesInUse,
      authority: 'chrome.storage.local.getBytesInUse(ownedKeys)',
    }
  }
  const estimate = await controller.evaluate(async () => {
    const value = await navigator.storage.estimate()
    return {
      usage: value.usage ?? null,
      quota: value.quota ?? null,
    }
  })
  return {
    kind: 'indexed-db',
    database: ownedStorage.database,
    objectStores: [...ownedStorage.objectStores],
    originUsageBytes: estimate.usage,
    originQuotaBytes: estimate.quota,
    comparableToChromeOwnedKeyBytes: false,
    authority: 'navigator.storage.estimate() extension-origin allocation',
  }
}

async function countIndexedDbPhysicalRows(
  controller: Page,
  ownedStorage: WorkingSetStorageBenchmarkOwnedStorage,
): Promise<number | null> {
  if (ownedStorage.kind !== 'indexed-db') return null
  const objectStore = ownedStorage.objectStores[0]
  invariant(objectStore !== undefined, 'IndexedDB diagnostics named no object store')
  return controller.evaluate(({ databaseName, objectStoreName }) =>
    new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('IndexedDB row-count open was blocked'))
      request.onsuccess = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(objectStoreName)) {
          database.close()
          reject(new Error(`IndexedDB row-count store was absent: ${objectStoreName}`))
          return
        }
        const transaction = database.transaction(objectStoreName, 'readonly')
        const count = transaction.objectStore(objectStoreName).count()
        count.onerror = () => {
          database.close()
          reject(count.error)
        }
        count.onsuccess = () => {
          database.close()
          resolve(count.result)
        }
      }
    }), {
    databaseName: ownedStorage.database,
    objectStoreName: objectStore,
  })
}

function terminateServiceWorkerAndProveAbsent(
  installed: InstalledExtension,
  controller: Page,
): Promise<void> {
  return terminateServiceWorkerTargetAndProveAbsent(
    installed.context,
    controller,
    installed.serviceWorker.url(),
  )
}

const STARTUP_TRACE_KEY = '__tabOutWorkingSetStorageBenchmarkStartupTrace'

interface StartupTrace {
  readonly headerReadyAt: number | null
  readonly latestPreHeaderRequest: {
    readonly durationMs: number
    readonly finishedAt: number
    readonly responseOk: boolean | null
    readonly startedAt: number
  } | null
  readonly preHeaderRequestCount: number
}

function parseRequestTiming(value: unknown): StartupTrace['latestPreHeaderRequest'] {
  if (typeof value !== 'object' || value === null) return null
  const durationMs = Reflect.get(value, 'durationMs')
  const finishedAt = Reflect.get(value, 'finishedAt')
  const responseOk = Reflect.get(value, 'responseOk')
  const startedAt = Reflect.get(value, 'startedAt')
  return typeof durationMs === 'number' && Number.isFinite(durationMs) &&
    typeof finishedAt === 'number' && Number.isFinite(finishedAt) &&
    (typeof responseOk === 'boolean' || responseOk === null) &&
    typeof startedAt === 'number' && Number.isFinite(startedAt)
    ? { durationMs, finishedAt, responseOk, startedAt }
    : null
}

function parseStartupTrace(value: unknown): StartupTrace | null {
  if (typeof value !== 'object' || value === null) return null
  const headerReadyAt = Reflect.get(value, 'headerReadyAt')
  const latestPreHeaderRequest = parseRequestTiming(
    Reflect.get(value, 'latestPreHeaderRequest'),
  )
  const preHeaderRequestCount = Reflect.get(value, 'preHeaderRequestCount')
  if (
    headerReadyAt !== null &&
    (typeof headerReadyAt !== 'number' || !Number.isFinite(headerReadyAt))
  ) return null
  if (
    typeof preHeaderRequestCount !== 'number' ||
    !Number.isSafeInteger(preHeaderRequestCount) ||
    preHeaderRequestCount < 0
  ) return null
  return { headerReadyAt, latestPreHeaderRequest, preHeaderRequestCount }
}

async function installStartupFrameInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(({ messageType, traceKey }) => {
    type RequestTiming = {
      durationMs: number
      finishedAt: number
      responseOk: boolean | null
      startedAt: number
    }
    type MutableTrace = {
      headerReadyAt: number | null
      latestPreHeaderRequest: RequestTiming | null
      preHeaderRequestCount: number
    }
    const trace: MutableTrace = {
      headerReadyAt: null,
      latestPreHeaderRequest: null,
      preHeaderRequestCount: 0,
    }
    Reflect.set(globalThis, traceKey, trace)

    const runtime = globalThis.chrome?.runtime
    if (runtime?.sendMessage) {
      const originalSendMessage = runtime.sendMessage.bind(runtime)
      Reflect.set(runtime, 'sendMessage', (...args: unknown[]) => {
        const message = args.find((value) =>
          typeof value === 'object' && value !== null &&
          Reflect.get(value, 'type') === messageType)
        if (message === undefined || trace.headerReadyAt !== null) {
          return Reflect.apply(originalSendMessage, runtime, args)
        }
        const startedAt = performance.now()
        trace.preHeaderRequestCount += 1
        const result = Reflect.apply(originalSendMessage, runtime, args)
        return Promise.resolve(result).then((response) => {
          const finishedAt = performance.now()
          if (
            trace.latestPreHeaderRequest === null ||
            startedAt > trace.latestPreHeaderRequest.startedAt
          ) {
            trace.latestPreHeaderRequest = {
              durationMs: finishedAt - startedAt,
              finishedAt,
              responseOk: typeof response === 'object' && response !== null &&
                typeof Reflect.get(response, 'ok') === 'boolean'
                ? Reflect.get(response, 'ok')
                : null,
              startedAt,
            }
          }
          return response
        })
      })
    }

    const recordHeaderReady = (observer: MutationObserver) => {
      const header = document.querySelector('[data-tabout="header-stats"]')
      if (header === null || header.getAttribute('aria-hidden') === 'true') return
      trace.headerReadyAt ??= performance.now()
      observer.disconnect()
    }
    const observer = new MutationObserver(() => recordHeaderReady(observer))
    observer.observe(document, {
      attributes: true,
      attributeFilter: ['aria-hidden'],
      childList: true,
      subtree: true,
    })
    recordHeaderReady(observer)
  }, {
    messageType: DASHBOARD_SERVICE_STATE_GET_MESSAGE,
    traceKey: STARTUP_TRACE_KEY,
  })
}

async function measureColdStartupFrame(
  installed: InstalledExtension,
  dashboard: Page,
): Promise<StartupFrameMeasurement> {
  const wallStartedAt = performance.now()
  await dashboard.goto(
    `chrome-extension://${installed.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' },
  )
  await dashboard.locator('[data-tabout="header-stats"]').waitFor({
    state: 'attached',
    timeout: 30_000,
  })
  await dashboard.waitForFunction(() => {
    const header = document.querySelector('[data-tabout="header-stats"]')
    return header !== null && header.getAttribute('aria-hidden') !== 'true'
  })
  const wallToHeaderObservationMs = performance.now() - wallStartedAt
  const rawTrace: unknown = await dashboard.evaluate((traceKey) =>
    Reflect.get(globalThis, traceKey), STARTUP_TRACE_KEY)
  const trace = parseStartupTrace(rawTrace)
  invariant(trace !== null, 'Startup Frame instrumentation returned invalid data')
  invariant(trace.headerReadyAt !== null, 'Startup Frame header publication was not observed')
  invariant(
    trace.latestPreHeaderRequest !== null,
    'Startup Frame dashboard-service-state request was not observed',
  )
  invariant(
    trace.preHeaderRequestCount === 1,
    `Expected one pre-header dashboard-service-state request, observed ${String(trace.preHeaderRequestCount)}`,
  )
  invariant(
    trace.latestPreHeaderRequest.responseOk === true,
    'Cold Startup Frame dashboard-service-state request did not return explicit success',
  )
  return {
    serviceStateRequestMs: trace.latestPreHeaderRequest.durationMs,
    serviceStateRequestStartedAtMs: trace.latestPreHeaderRequest.startedAt,
    serviceStateToHeaderMs:
      trace.headerReadyAt - trace.latestPreHeaderRequest.finishedAt,
    startupFrameReadyMs: trace.headerReadyAt,
    preHeaderServiceStateRequestCount: trace.preHeaderRequestCount,
    visiblePageChips: await dashboard.locator('[data-tabout="page-chip"][data-tabout-context="domain-card"]').count(),
    wallToHeaderObservationMs,
    workerAbsentBeforeNavigation: true,
  }
}

async function measureColdStartupFailure(
  installed: InstalledExtension,
  dashboard: Page,
) {
  const headerNonPublicationWindowMs = 500
  await dashboard.goto(
    `chrome-extension://${installed.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' },
  )
  const header = dashboard.locator('[data-tabout="header-stats"]')
  await header.waitFor({ state: 'attached', timeout: 30_000 })
  await dashboard.waitForFunction((traceKey) => {
    const trace = Reflect.get(globalThis, traceKey)
    return typeof trace === 'object' && trace !== null &&
      Reflect.get(trace, 'latestPreHeaderRequest') !== null
  }, STARTUP_TRACE_KEY)
  const rawTrace: unknown = await dashboard.evaluate((traceKey) =>
    Reflect.get(globalThis, traceKey), STARTUP_TRACE_KEY)
  const trace = parseStartupTrace(rawTrace)
  invariant(trace !== null, 'Failed Startup Frame instrumentation returned invalid data')
  invariant(
    trace.preHeaderRequestCount === 1,
    `Expected one failed pre-header dashboard-service-state request, observed ${String(trace.preHeaderRequestCount)}`,
  )
  invariant(
    trace.latestPreHeaderRequest?.responseOk === false,
    'Corrupt authority did not produce an explicit failed dashboard-service-state response',
  )

  const headerPublished = await dashboard.waitForFunction(() => {
    const candidate = document.querySelector('[data-tabout="header-stats"]')
    return candidate !== null && candidate.getAttribute('aria-hidden') !== 'true'
  }, undefined, { timeout: headerNonPublicationWindowMs }).then(
    () => true,
    (cause: unknown) => {
      const message = describeError(cause)
      if (!message.includes('Timeout')) throw cause
      return false
    },
  )
  invariant(!headerPublished, 'Corrupt authority published a false known-empty Startup Frame')
  invariant(trace.headerReadyAt === null, 'Startup trace recorded header publication after failure')
  return {
    serviceStateRequestMs: trace.latestPreHeaderRequest.durationMs,
    responseOk: trace.latestPreHeaderRequest.responseOk,
    preHeaderServiceStateRequestCount: trace.preHeaderRequestCount,
    headerPublished,
    headerNonPublicationWindowMs,
    workerAbsentBeforeNavigation: true,
  }
}

async function assertColdStartupRejectsCorruptAuthority(
  installed: InstalledExtension,
  controller: Page,
) {
  const dashboard = await installed.context.newPage()
  try {
    await installStartupFrameInstrumentation(dashboard)
    await terminateServiceWorkerAndProveAbsent(installed, controller)
    return await measureColdStartupFailure(installed, dashboard)
  } finally {
    await dashboard.close().catch(() => undefined)
  }
}

async function runCheck(
  name: string,
  check: () => Promise<unknown>,
): Promise<CorrectnessCheck> {
  try {
    return { name, passed: true, detail: await check() }
  } catch (cause) {
    return { name, passed: false, error: describeError(cause) }
  }
}

async function resetAndSeed(
  controller: Page,
  profile: WorkingSetStorageProfileName,
  now: number,
): Promise<void> {
  await sendSuccessfulMessage(controller, benchmarkMessage({ operation: 'reset' }))
  await sendSuccessfulMessage(controller, benchmarkMessage({
    operation: 'seed-profile',
    profile,
    now,
  }))
}

async function readStoredActivity(controller: Page): Promise<WorkingSetActivityStore> {
  return requireActivity(await sendSuccessfulMessage(
    controller,
    benchmarkMessage({ operation: 'storage-read' }),
  ))
}

async function runCorrectnessMatrix(
  installed: InstalledExtension,
  artifact: WorkingSetBenchmarkArtifactSidecar,
): Promise<VariantCorrectnessReport> {
  const controller = await openController(installed, artifact)
  const diagnostic = await sendSuccessfulMessage(
    controller,
    benchmarkMessage({ operation: 'diagnostics' }),
  )
  const selectedVariant = diagnostic.diagnostics.variant
  const selectedVariantMatchesBuild =
    selectedVariant === artifact.variant
  const userAgent = await controller.evaluate(() => navigator.userAgent)
  const actualChromeMajor = chromeMajorFromUserAgent(userAgent)
  const browser = {
    userAgent,
    actualChromeMajor,
    declaredMinimumChromeMajor: chromeSupportPolicy.minimumMajor,
    matchesDeclaredMinimum: actualChromeMajor === chromeSupportPolicy.minimumMajor,
  }
  const profiles: ProfileCheck[] = []

  for (const profile of makeWorkingSetStorageProfiles(Date.now())) {
    const supportedGate = SUPPORTED_PROFILE_NAMES.includes(profile.name)
    try {
      await resetAndSeed(controller, profile.name, profile.now)
      if (profile.name === '250-live-250-expired') {
        await terminateServiceWorkerAndProveAbsent(installed, controller)
      }
      const read = await sendSuccessfulMessage(
        controller,
        benchmarkMessage({ operation: 'storage-read' }),
      )
      const actual = requireActivity(read)
      const expected = normalizeWorkingSetActivity(profile.activity, profile.now)
      assertActivityEqual(actual, expected)
      const physicalRowCount = await countIndexedDbPhysicalRows(
        controller,
        read.diagnostics.ownedStorage,
      )
      if (
        profile.name === '250-live-250-expired' &&
        read.diagnostics.ownedStorage.kind === 'indexed-db'
      ) {
        invariant(
          physicalRowCount === 250,
          `IndexedDB cold-open expiry sweep retained ${String(physicalRowCount)} physical rows`,
        )
      }
      profiles.push({
        name: profile.name,
        supportedGate,
        passed: true,
        detail: {
          records: Object.keys(actual.records).length,
          canonicalActivitySha256: canonicalActivitySha256(actual),
          expectedCanonicalActivitySha256: canonicalActivitySha256(expected),
          physicalRowCount,
          coldOpenExpirySweep: profile.name === '250-live-250-expired',
          workerAbsentBeforeStorageRead:
            profile.name === '250-live-250-expired',
          diagnostics: read.diagnostics,
          footprint: await captureStorageFootprint(
            controller,
            read.diagnostics.ownedStorage,
          ),
        },
      })
    } catch (cause) {
      profiles.push({
        name: profile.name,
        supportedGate,
        passed: false,
        error: describeError(cause),
      })
    }
  }

  const checks: CorrectnessCheck[] = []
  checks.push(await runCheck('existing-record append', async () => {
    const now = Date.now()
    const profile = makeWorkingSetStorageProfile('500x20', now)
    const key = sortedRecordKeys(profile.activity)[0]
    invariant(key !== undefined, '500x20 fixture had no existing key')
    await resetAndSeed(controller, profile.name, now)
    const response = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'storage-mutation',
      event: makeEvent(key, 10_001, now + 1, 'Updated Existing Page'),
    }))
    const activity = await readStoredActivity(controller)
    const record = activity.records[key]
    invariant(record !== undefined, 'Existing record disappeared after append')
    invariant(record.events.length === 21, 'Existing record append did not add one event')
    invariant(record.events.at(-1)?.kind === 'navigation', 'Append did not retain the new event')
    invariant(record.title === 'Updated Existing Page', 'Append did not update the title')
    invariant(response.diagnostics.writeInvocationCount === 1, 'Append did not issue one write')
    return response.diagnostics
  }))
  checks.push(await runCheck('capped existing-record append', async () => {
    const now = Date.now()
    const profile = makeWorkingSetStorageProfile('500x80', now)
    const key = sortedRecordKeys(profile.activity)[0]
    invariant(key !== undefined, '500x80 fixture had no existing key')
    const original = profile.activity.records[key]
    invariant(original !== undefined, '500x80 fixture record was absent')
    const originalFirstAt = original.events[0]?.at
    await resetAndSeed(controller, profile.name, now)
    await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'storage-mutation',
      event: makeEvent(key, 10_002, now + 1),
    }))
    const record = (await readStoredActivity(controller)).records[key]
    invariant(record !== undefined, 'Capped record disappeared')
    invariant(record.events.length === 80, 'Capped append did not preserve the 80-event cap')
    invariant(record.events[0]?.at !== originalFirstAt, 'Capped append did not evict the oldest event')
    invariant(record.events.at(-1)?.at === now + 1, 'Capped append omitted the new event')
    return { events: record.events.length }
  }))
  checks.push(await runCheck('new record', async () => {
    const now = Date.now()
    const url = 'https://new-record.example.test/page'
    await resetAndSeed(controller, 'empty', now)
    const response = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'storage-mutation',
      event: makeEvent(url, 10_003, now + 1, 'New Example Page'),
    }))
    const activity = await readStoredActivity(controller)
    invariant(sortedRecordKeys(activity).length === 1, 'New record mutation did not create one record')
    invariant(activity.records[url]?.events.length === 1, 'New record event was not persisted')
    return response.diagnostics
  }))
  checks.push(await runCheck('future mutation expires old records', async () => {
    const now = Date.now()
    const url = 'https://future-mutation.example.test/page'
    await resetAndSeed(controller, '500x20', now)
    await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'storage-mutation',
      event: makeEvent(url, 10_004, now + ACTIVITY_RETENTION_MS + 1_000),
    }))
    const activity = await readStoredActivity(controller)
    invariant(
      JSON.stringify(sortedRecordKeys(activity)) === JSON.stringify([url]),
      'Future mutation did not expire all old records atomically',
    )
    return { records: 1 }
  }))
  checks.push(await runCheck('same-navigation zero write', async () => {
    const now = Date.now()
    const event = makeEvent('https://same-navigation.example.test/page', 10_005, now)
    await resetAndSeed(controller, 'empty', now)
    await terminateServiceWorkerAndProveAbsent(installed, controller)
    const first = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'navigation',
      event,
    }))
    const afterFirst = await readStoredActivity(controller)
    const second = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'navigation',
      event: { ...event, at: now + 1 },
    }))
    const afterSecond = await readStoredActivity(controller)
    assertActivityEqual(afterSecond, afterFirst)
    invariant(
      second.diagnostics.writeInvocationCount === first.diagnostics.writeInvocationCount,
      'Same-navigation no-op reached the persistence backend',
    )
    return {
      writesAfterFirst: first.diagnostics.writeInvocationCount,
      writesAfterSecond: second.diagnostics.writeInvocationCount,
    }
  }))
  checks.push(await runCheck('failed mutation preserves truth and identical retry commits once', async () => {
    const now = Date.now()
    const key = 'https://retry-after-failure.example.test/page'
    const before: WorkingSetActivityStore = {
      version: 1,
      records: {
        [key]: {
          key,
          url: key,
          title: 'Retry Fixture Before',
          domain: 'retry-after-failure.example.test',
          lastSeenAt: now,
          lastActivatedAt: now,
          events: [{ kind: 'activation', at: now }],
        },
      },
    }
    await sendSuccessfulMessage(controller, benchmarkMessage({ operation: 'reset' }))
    await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'replace',
      activity: before,
    }))
    await terminateServiceWorkerAndProveAbsent(installed, controller)

    const coldServiceBefore = requireActivity(await sendSuccessfulMessage(
      controller,
      benchmarkMessage({ operation: 'service-read' }),
    ))
    const durableBefore = await readStoredActivity(controller)
    assertActivityEqual(coldServiceBefore, before)
    assertActivityEqual(durableBefore, before)

    await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'fail-next-mutation',
    }))
    const navigationMessage = benchmarkMessage({
      operation: 'navigation',
      event: makeEvent(key, 10_006, now + 1, 'Retry Fixture After'),
    })
    const failed = await sendMessage(controller, navigationMessage)
    invariant(failed !== null, 'Injected-failure response was invalid')
    invariant(!failed.ok, 'Armed mutation unexpectedly succeeded')

    const durableAfterFailure = await readStoredActivity(controller)
    const serviceAfterFailure = requireActivity(await sendSuccessfulMessage(
      controller,
      benchmarkMessage({ operation: 'service-read' }),
    ))
    assertActivityEqual(durableAfterFailure, before)
    assertActivityEqual(serviceAfterFailure, before)

    const retry = await sendSuccessfulMessage(controller, navigationMessage)
    const durableAfterRetry = await readStoredActivity(controller)
    const serviceAfterRetry = requireActivity(await sendSuccessfulMessage(
      controller,
      benchmarkMessage({ operation: 'service-read' }),
    ))
    assertActivityEqual(serviceAfterRetry, durableAfterRetry)
    const retriedRecord = durableAfterRetry.records[key]
    invariant(retriedRecord !== undefined, 'Retry removed the canonical record')
    invariant(retriedRecord.events.length === 2, 'Retry did not add exactly one event')
    invariant(
      retriedRecord.events.filter((event) => event.kind === 'navigation').length === 1,
      'Failed attempt leaked or retry duplicated the navigation event',
    )
    invariant(
      retriedRecord.events.at(-1)?.kind === 'navigation',
      'Retry did not durably append its navigation',
    )
    return {
      injectedFailure: failed.error,
      beforeCanonicalActivitySha256: canonicalActivitySha256(before),
      durableAfterFailureCanonicalActivitySha256:
        canonicalActivitySha256(durableAfterFailure),
      serviceAfterFailureCanonicalActivitySha256:
        canonicalActivitySha256(serviceAfterFailure),
      finalCanonicalActivitySha256: canonicalActivitySha256(durableAfterRetry),
      retryDiagnostics: retry.diagnostics,
    }
  }))

  for (const burstSize of [100, 500]) {
    checks.push(await runCheck(`${String(burstSize)}-event unique burst`, async () => {
      const now = Date.now()
      const events = Array.from({ length: burstSize }, (_, index) => makeEvent(
        `https://burst-${String(index).padStart(4, '0')}.example.test/page`,
        20_000 + index,
        now + index,
      ))
      await resetAndSeed(controller, 'empty', now)
      await terminateServiceWorkerAndProveAbsent(installed, controller)
      const response = await sendSuccessfulMessage(controller, benchmarkMessage({
        operation: 'burst',
        events,
      }))
      const activity = await readStoredActivity(controller)
      invariant(
        sortedRecordKeys(activity).length === burstSize,
        `${String(burstSize)}-event burst lost records`,
      )
      for (const event of events) {
        invariant(
          activity.records[event.url]?.events.length === 1,
          `${event.url} was lost or duplicated during the burst`,
        )
      }
      invariant(
        response.diagnostics.writeInvocationCount === burstSize,
        `${String(burstSize)}-event burst did not settle every queued write`,
      )
      return response.diagnostics
    }))
  }

  checks.push(await runCheck('malformed row isolation', async () => {
    const now = Date.now()
    const profile = makeWorkingSetStorageProfile('500x20', now)
    const expected = normalizeWorkingSetActivity(profile.activity, now)
    await resetAndSeed(controller, '500x20', now)
    await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'corrupt',
      corruption: 'row',
    }))
    const activity = await readStoredActivity(controller)
    for (const key of sortedRecordKeys(expected)) {
      const actualRecord = activity.records[key]
      const expectedRecord = expected.records[key]
      invariant(actualRecord !== undefined, `${key} was lost after malformed-row isolation`)
      invariant(expectedRecord !== undefined, `${key} was absent from the seeded fixture`)
      assertRecordEqual(actualRecord, expectedRecord)
    }
    return {
      seededRecordsSurvived: sortedRecordKeys(expected).length,
      totalValidRecordsAfterIsolation: sortedRecordKeys(activity).length,
    }
  }))
  checks.push(await runCheck('unsupported outer version is unknown', async () => {
    const now = Date.now()
    await resetAndSeed(controller, '500x20', now)
    await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'corrupt',
      corruption: 'outer-version',
    }))
    const response = await sendMessage(
      controller,
      benchmarkMessage({ operation: 'storage-read' }),
    )
    invariant(response !== null, 'Unsupported-version response was invalid')
    invariant(!response.ok, 'Unsupported outer version was treated as known activity')
    return {
      directStorageRead: response,
      coldStartup: await assertColdStartupRejectsCorruptAuthority(
        installed,
        controller,
      ),
    }
  }))
  if (artifact.variant === 'idb' || artifact.variant === 'shards-32') {
    checks.push(await runCheck('missing required physical authority is unknown', async () => {
      const now = Date.now()
      await sendSuccessfulMessage(controller, benchmarkMessage({ operation: 'reset' }))
      await sendSuccessfulMessage(controller, benchmarkMessage({
        operation: 'seed-profile',
        profile: '500x20',
        now,
      }))
      await sendSuccessfulMessage(controller, benchmarkMessage({
        operation: 'corrupt',
        corruption: 'missing-required-store',
      }))
      const response = await sendMessage(
        controller,
        benchmarkMessage({ operation: 'storage-read' }),
      )
      invariant(response !== null, 'Missing-store response was invalid')
      invariant(!response.ok, 'Missing required physical authority was treated as known activity')
      return {
        directStorageRead: response,
        coldStartup: await assertColdStartupRejectsCorruptAuthority(
          installed,
          controller,
        ),
      }
    }))
  } else {
    checks.push(await runCheck('absent whole-envelope key is known empty', async () => {
      const now = Date.now()
      await resetAndSeed(controller, '500x20', now)
      await sendSuccessfulMessage(controller, benchmarkMessage({
        operation: 'corrupt',
        corruption: 'missing-required-store',
      }))
      const activity = await readStoredActivity(controller)
      invariant(
        sortedRecordKeys(activity).length === 0,
        'Absent whole-envelope key was not interpreted as complete empty activity',
      )
      return { records: 0 }
    }))
  }

  await sendSuccessfulMessage(controller, benchmarkMessage({ operation: 'reset' }))
  const supportedGatePassed = selectedVariantMatchesBuild &&
    browser.matchesDeclaredMinimum &&
    profiles.filter((profile) => profile.supportedGate).every((profile) => profile.passed) &&
    checks.every((check) => check.passed)
  return {
    buildVariant: artifact.variant,
    selectedVariant,
    selectedVariantMatchesBuild,
    browser,
    profiles,
    checks,
    supportedGatePassed,
  }
}

function measurementOrder(
  artifacts: readonly WorkingSetBenchmarkArtifactSidecar[],
  iteration: number,
): readonly WorkingSetBenchmarkArtifactSidecar[] {
  if (artifacts.length === 0) return []
  const offset = iteration % artifacts.length
  const rotated = [
    ...artifacts.slice(offset),
    ...artifacts.slice(0, offset),
  ]
  return Math.floor(iteration / artifacts.length) % 2 === 0
    ? rotated
    : rotated.toReversed()
}

async function measureVariant(
  artifact: WorkingSetBenchmarkArtifactSidecar,
  phase: SuccessfulTimedSample['phase'],
  iteration: number,
  order: number,
): Promise<SuccessfulTimedSample> {
  const installed = await launchInstalledExtensionFromArtifact(
    artifact.extensionDirectory,
  )
  try {
    const controller = await openController(installed, artifact)
    const diagnostics = await sendSuccessfulMessage(
      controller,
      benchmarkMessage({ operation: 'diagnostics' }),
    )
    invariant(
      diagnostics.diagnostics.variant === artifact.variant,
      `${artifact.variant} artifact selected ${diagnostics.diagnostics.variant}`,
    )
    const now = Date.now()
    const profile = makeWorkingSetStorageProfile('500x20', now)
    const existingKey = sortedRecordKeys(profile.activity)[0]
    invariant(existingKey !== undefined, 'Timed 500x20 fixture had no existing key')
    await resetAndSeed(controller, profile.name, now)

    const dashboard = await installed.context.newPage()
    await installStartupFrameInstrumentation(dashboard)
    await terminateServiceWorkerAndProveAbsent(installed, controller)
    const cold = await measureColdStartupFrame(installed, dashboard)

    const navigationStartedAt = performance.now()
    const navigation = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'navigation',
      event: makeEvent(
        existingKey,
        30_000 + iteration,
        Date.now(),
        'Measured Existing Page',
      ),
    }))
    const controllerRoundTripMs = performance.now() - navigationStartedAt
    const fullAppMutationMs = navigation.timings.fullAppMutationMs
    invariant(fullAppMutationMs !== undefined, 'Navigation omitted full-app timing')

    // This read is intentionally outside the timed mutation and proves the
    // response followed a durable commit rather than a cache-only update.
    const persistedResponse = await sendSuccessfulMessage(
      controller,
      benchmarkMessage({ operation: 'storage-read' }),
    )
    const persisted = requireActivity(persistedResponse)
    const warmUncachedStorageReadMs = persistedResponse.timings.storageReadMs
    invariant(
      warmUncachedStorageReadMs !== undefined,
      'Untimed semantic storage read omitted its backend timing',
    )
    const persistedRecord = persisted.records[existingKey]
    invariant(persistedRecord !== undefined, 'Timed mutation lost the existing record')
    invariant(persistedRecord.events.length === 21, 'Timed mutation did not append exactly once')
    invariant(
      persistedRecord.events.at(-1)?.kind === 'navigation',
      'Timed mutation did not durably append a navigation',
    )
    const cachedResponse = await sendSuccessfulMessage(
      controller,
      benchmarkMessage({ operation: 'service-read' }),
    )
    const warmCachedServiceReadMs = cachedResponse.timings.serviceReadMs
    invariant(
      warmCachedServiceReadMs !== undefined,
      'Warm WorkingSet service read omitted its cache timing',
    )
    assertActivityEqual(requireActivity(cachedResponse), persisted)
    const footprint = await captureStorageFootprint(
      controller,
      navigation.diagnostics.ownedStorage,
    )

    const domainOnly = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'domain-mutation',
      event: makeEvent(existingKey, 40_000 + iteration, Date.now() + 1),
    }))
    const storagePath = await sendSuccessfulMessage(controller, benchmarkMessage({
      operation: 'storage-mutation',
      event: makeEvent(existingKey, 50_000 + iteration, Date.now() + 2),
    }))
    const domainOnlyMutationMs = domainOnly.timings.domainMutationMs
    const storagePathDomainMutationMs = storagePath.timings.domainMutationMs
    const storageCommitMs = storagePath.timings.storageCommitMs
    invariant(domainOnlyMutationMs !== undefined, 'Domain-only command omitted domain timing')
    invariant(
      storagePathDomainMutationMs !== undefined,
      'Storage-path command omitted domain timing',
    )
    invariant(storageCommitMs !== undefined, 'Storage-path command omitted commit timing')

    return {
      status: 'ok',
      phase,
      iteration,
      order,
      buildVariant: artifact.variant,
      selectedVariant: navigation.diagnostics.variant,
      cold,
      timings: {
        controllerRoundTripMs,
        listenerToCommitMs: navigation.timings.listenerToCommitMs,
        fullAppMutationMs,
        domainOnlyMutationMs,
        storagePathDomainMutationMs,
        storageCommitMs,
        storagePathListenerToCommitMs: storagePath.timings.listenerToCommitMs,
        warmUncachedStorageReadMs,
        warmCachedServiceReadMs,
      },
      navigationDiagnostics: navigation.diagnostics,
      storageMutationDiagnostics: storagePath.diagnostics,
      footprint,
    }
  } finally {
    await installed.dispose()
  }
}

function successfulMeasuredSamples(
  samples: readonly TimedSample[],
  variant: WorkingSetBenchmarkVariant,
): readonly SuccessfulTimedSample[] {
  return samples.filter((sample): sample is SuccessfulTimedSample =>
    sample.status === 'ok' &&
    sample.phase === 'measured' &&
    sample.buildVariant === variant)
}

function pairedColdBootstrap(
  currentSamples: readonly SuccessfulTimedSample[],
  candidateSamples: readonly SuccessfulTimedSample[],
  seed: number,
) {
  const currentByIteration = new Map(
    currentSamples.map((sample) => [sample.iteration, sample]),
  )
  const pairs = candidateSamples.flatMap((candidate) => {
    const current = currentByIteration.get(candidate.iteration)
    return current === undefined ? [] : [{ current, candidate }]
  })
  if (pairs.length === 0) return null
  const random = makeRandom(seed)
  const p95Deltas: number[] = []
  for (let repetition = 0; repetition < BOOTSTRAP_REPETITIONS; repetition += 1) {
    const sampledCurrent: number[] = []
    const sampledCandidate: number[] = []
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)]
      invariant(pair !== undefined, 'Paired bootstrap selected no sample')
      sampledCurrent.push(pair.current.cold.serviceStateRequestMs)
      sampledCandidate.push(pair.candidate.cold.serviceStateRequestMs)
    }
    p95Deltas.push(
      percentile(sampledCandidate, 0.95) - percentile(sampledCurrent, 0.95),
    )
  }
  return {
    pairCount: pairs.length,
    repetitions: BOOTSTRAP_REPETITIONS,
    seed,
    lower95Ms: percentile(p95Deltas, 0.025),
    upper95Ms: percentile(p95Deltas, 0.975),
  }
}

function measurementSummary(samples: readonly SuccessfulTimedSample[]) {
  return {
    sampleCount: samples.length,
    listenerToCommitMs: distribution(samples.map((sample) =>
      sample.timings.listenerToCommitMs)),
    fullAppMutationMs: distribution(samples.map((sample) =>
      sample.timings.fullAppMutationMs)),
    controllerRoundTripMs: distribution(samples.map((sample) =>
      sample.timings.controllerRoundTripMs)),
    domainOnlyMutationMs: distribution(samples.map((sample) =>
      sample.timings.domainOnlyMutationMs)),
    storagePathDomainMutationMs: distribution(samples.map((sample) =>
      sample.timings.storagePathDomainMutationMs)),
    storageCommitMs: distribution(samples.map((sample) =>
      sample.timings.storageCommitMs)),
    storagePathListenerToCommitMs: distribution(samples.map((sample) =>
      sample.timings.storagePathListenerToCommitMs)),
    warmUncachedStorageReadMs: distribution(samples.map((sample) =>
      sample.timings.warmUncachedStorageReadMs)),
    warmCachedServiceReadMs: distribution(samples.map((sample) =>
      sample.timings.warmCachedServiceReadMs)),
    coldServiceStateRequestMs: distribution(samples.map((sample) =>
      sample.cold.serviceStateRequestMs)),
    coldStartupFrameReadyMs: distribution(samples.map((sample) =>
      sample.cold.startupFrameReadyMs)),
    coldServiceStateToHeaderMs: distribution(samples.map((sample) =>
      sample.cold.serviceStateToHeaderMs)),
    mutationLogicalBytes: distribution(samples.map((sample) =>
      sample.navigationDiagnostics.lastMutationLogicalBytes)),
    chromeOwnedKeyBytes: distribution(samples.flatMap((sample) =>
      sample.footprint.kind === 'chrome-storage'
        ? [sample.footprint.bytesInUse]
        : [])),
    indexedDbOriginAllocationBytesNonComparable: distribution(samples.flatMap((sample) =>
      sample.footprint.kind === 'indexed-db' &&
      sample.footprint.originUsageBytes !== null
        ? [sample.footprint.originUsageBytes]
        : [])),
  }
}

function evaluateGates(
  samples: readonly TimedSample[],
  correctness: readonly VariantCorrectnessReport[],
) {
  const currentSamples = successfulMeasuredSamples(samples, 'current')
  const currentSummary = measurementSummary(currentSamples)
  const currentMutationP95 = currentSummary.listenerToCommitMs?.p95 ?? null
  const currentPayloadP95 = currentSummary.mutationLogicalBytes?.p95 ?? null
  const currentReadP95 = currentSummary.coldServiceStateRequestMs?.p95 ?? null
  const validBaseline =
    currentSamples.length === MEASURED_PAIR_COUNT &&
    currentMutationP95 !== null &&
    currentPayloadP95 !== null &&
    currentReadP95 !== null &&
    correctness.find((entry) => entry.buildVariant === 'current')
      ?.supportedGatePassed === true

  const candidates = CANDIDATE_COMPLEXITY_ORDER.map((variant, index) => {
    const candidateSamples = successfulMeasuredSamples(samples, variant)
    const summary = measurementSummary(candidateSamples)
    const mutationP95 = summary.listenerToCommitMs?.p95 ?? null
    const payloadP95 = summary.mutationLogicalBytes?.p95 ?? null
    const readP95 = summary.coldServiceStateRequestMs?.p95 ?? null
    const completeMeasurements = candidateSamples.length === MEASURED_PAIR_COUNT
    const payloadReduction =
      currentPayloadP95 !== null && payloadP95 !== null && payloadP95 > 0
        ? currentPayloadP95 / payloadP95
        : null
    const mutationImprovement =
      currentMutationP95 !== null && mutationP95 !== null && currentMutationP95 > 0
        ? (currentMutationP95 - mutationP95) / currentMutationP95
        : null
    const bootstrap = pairedColdBootstrap(
      currentSamples,
      candidateSamples,
      0x51f15e + index,
    )
    const allowedReadRegressionMs = currentReadP95 === null
      ? null
      : Math.max(currentReadP95 * 0.1, 5)
    const pointReadRegressionMs =
      currentReadP95 !== null && readP95 !== null
        ? readP95 - currentReadP95
        : null
    const coldReadStatus =
      allowedReadRegressionMs === null ||
      pointReadRegressionMs === null ||
      bootstrap === null ||
      bootstrap.pairCount !== MEASURED_PAIR_COUNT
        ? 'insufficient-data'
        : pointReadRegressionMs <= allowedReadRegressionMs &&
          bootstrap.upper95Ms <= allowedReadRegressionMs
          ? 'pass'
          : bootstrap.lower95Ms > allowedReadRegressionMs
            ? 'fail'
            : 'inconclusive'
    const correctnessPassed = correctness.find((entry) =>
      entry.buildVariant === variant)?.supportedGatePassed === true
    const payloadPassed = payloadReduction !== null && payloadReduction >= 10
    const mutationPassed = mutationImprovement !== null && mutationImprovement >= 0.25
    const overallPassed = CANONICAL_RUN && validBaseline && completeMeasurements &&
      correctnessPassed && payloadPassed && mutationPassed && coldReadStatus === 'pass'
    return {
      variant,
      completeMeasurements,
      correctness: { passed: correctnessPassed },
      payload: {
        passed: payloadPassed,
        baselineP95Bytes: currentPayloadP95,
        candidateP95Bytes: payloadP95,
        reductionMultiple: payloadReduction,
        requiredReductionMultiple: 10,
      },
      mutationCompletion: {
        passed: mutationPassed,
        authority: 'controller listener entry through real WorkingSet commit response',
        baselineP95Ms: currentMutationP95,
        candidateP95Ms: mutationP95,
        improvementFraction: mutationImprovement,
        requiredImprovementFraction: 0.25,
      },
      coldFullRead: {
        status: coldReadStatus,
        authority: 'dashboard tab-out:get-dashboard-service-state promise duration after CDP-proven worker absence',
        baselineP95Ms: currentReadP95,
        candidateP95Ms: readP95,
        pointRegressionMs: pointReadRegressionMs,
        allowedRegressionMs: allowedReadRegressionMs,
        allowedRule: 'max(10% of current p95, 5ms)',
        pairedBootstrapP95Delta: bootstrap,
      },
      overallPassed,
    }
  })
  const selected = candidates.find((candidate) => candidate.overallPassed)?.variant ?? null
  return {
    canonical: CANONICAL_RUN,
    validBaseline,
    candidates,
    verdict: {
      selected,
      selectionOrder: CANDIDATE_COMPLEXITY_ORDER,
      forcedWinner: false,
      reason: !CANONICAL_RUN
        ? 'Smoke-count run is non-canonical; candidate selection is intentionally disabled.'
        : !validBaseline
            ? 'Benchmark baseline is incomplete or incorrect; no candidate can win.'
            : selected === null
              ? 'No candidate passed every correctness, payload, latency, and cold-read gate.'
              : `${selected} is the least-complex candidate that passed every gate.`,
    },
  }
}

async function writeAndAttachReport(
  testInfo: TestInfo,
  report: unknown,
): Promise<void> {
  const path = testInfo.outputPath('working-set-storage-benchmark.json')
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach('working-set-storage-benchmark.json', {
    path,
    contentType: 'application/json',
  })
}

test('compares installed-extension Working Set storage candidates', async ({}, testInfo) => {
  test.setTimeout(BENCHMARK_TIMEOUT_MS)
  await using build = await buildWorkingSetStorageBenchmarkArtifacts()
  const correctness: VariantCorrectnessReport[] = []
  for (const artifact of build.sidecar.variants) {
    const installed = await launchInstalledExtensionFromArtifact(
      artifact.extensionDirectory,
    )
    try {
      correctness.push(await runCorrectnessMatrix(installed, artifact))
    } catch (cause) {
      correctness.push({
        buildVariant: artifact.variant,
        selectedVariant: null,
        selectedVariantMatchesBuild: false,
        browser: null,
        profiles: [],
        checks: [{
          name: 'correctness harness completed',
          passed: false,
          error: describeError(cause),
        }],
        supportedGatePassed: false,
      })
    } finally {
      await installed.dispose()
    }
  }

  const samples: TimedSample[] = []
  const totalPairCount = WARMUP_PAIR_COUNT + MEASURED_PAIR_COUNT
  for (let pair = 0; pair < totalPairCount; pair += 1) {
    const phase = pair < WARMUP_PAIR_COUNT ? 'warmup' : 'measured'
    const iteration = phase === 'warmup' ? pair : pair - WARMUP_PAIR_COUNT
    const order = measurementOrder(build.sidecar.variants, pair)
    for (const [orderIndex, artifact] of order.entries()) {
      try {
        samples.push(await measureVariant(
          artifact,
          phase,
          iteration,
          orderIndex,
        ))
      } catch (cause) {
        samples.push({
          status: 'failed',
          phase,
          iteration,
          order: orderIndex,
          buildVariant: artifact.variant,
          error: describeError(cause),
        })
      }
    }
  }

  const summaries = Object.fromEntries(build.sidecar.variants.map((artifact) => {
    const measured = successfulMeasuredSamples(samples, artifact.variant)
    return [artifact.variant, measurementSummary(measured)]
  }))
  const gates = evaluateGates(samples, correctness)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      authority: 'installed Manifest V3 extensions in fresh persistent Chromium profiles',
      canonical: CANONICAL_RUN,
      canonicalCounts: { warmupPairs: 5, measuredPairs: 30 },
      warmupPairs: WARMUP_PAIR_COUNT,
      measuredPairs: MEASURED_PAIR_COUNT,
      ordering: 'candidate order rotates each pair and reverses after each four-pair rotation',
      workload: '500 records x 20 events for paired measurements',
      workerColdProof: 'CDP Target.getTargets observes no matching service_worker target before dashboard navigation',
      startupRequest: DASHBOARD_SERVICE_STATE_GET_MESSAGE,
      mutation: 'one warm existing-record navigation through the real WorkingSet service and commit response',
      semanticRead: 'separate untimed WorkingSetActivityStorage read after mutation',
      warmReadBoundaries: 'post-mutation storage-read bypasses WorkingSet cache; following service-read measures the warm WorkingSet cache',
      idbAllocationCaveat: 'navigator.storage.estimate reports extension-origin allocation and is not comparable to Chrome owned-key bytes',
      bootstrap: {
        repetitions: BOOTSTRAP_REPETITIONS,
        method: 'deterministic paired resampling by measured iteration, recomputing candidate-current cold request p95 delta',
      },
      browserEvidence: correctness.map(({ buildVariant, browser }) => ({
        buildVariant,
        browser,
      })),
    },
    artifacts: build.sidecar,
    correctness,
    samples,
    summaries,
    gates: {
      canonical: gates.canonical,
      validBaseline: gates.validBaseline,
      candidates: gates.candidates,
    },
    verdict: gates.verdict,
  }
  await writeAndAttachReport(testInfo, report)
  console.log(JSON.stringify({
    benchmark: 'working-set-storage',
    verdict: report.verdict,
  }))
})
