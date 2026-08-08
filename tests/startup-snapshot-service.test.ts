import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import FakeTimers from '@sinonjs/fake-timers'
import { Effect, Layer, ManagedRuntime } from 'effect'

import {
  STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS,
  STARTUP_SNAPSHOT_DEBOUNCE_MS,
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM,
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS,
  STARTUP_SNAPSHOT_MAX_WAIT_MS,
  StartupSnapshot,
  startupSnapshotStorageChangesRequireRefresh
} from '../src/extension/background/startup-snapshot-service.js'
import { BrowserTabs } from '../src/extension/browser-tabs-service.js'
import type { CapturedDashboardServiceState } from '../src/extension/dashboard-service-messages.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { RETAINED_PAGES_STORAGE_KEY } from '../src/extension/retained-pages-storage.js'
import { PAGE_CHIP_PIN_STORAGE_KEY } from '../src/extension/page-chip-pins.js'
import {
  SAVED_PAGES_STORAGE_KEY,
  addSavedPageToStore,
  emptySavedPagesStore
} from '../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY } from '../src/extension/section-pins.js'
import {
  DASHBOARD_STARTUP_SEED_CACHE_KEY,
  type DashboardStartupSeed
} from '../src/extension/startup-snapshot.js'
import { parseDashboardStartupSeedBoundary } from '../src/extension/startup-snapshot-schema.js'
import type { WorkingSetActivityStore } from '../src/extension/types'
import { makeChromeTab } from './helpers/chrome-tab.js'
import { installWebLocksStub } from './helpers/web-locks.js'

const emptyTabHistory = {
  stackSize: 0,
  maxSize: 48,
  cursorIndex: -1,
  currentIndex: -1,
  previousIndex: -1,
  nextIndex: -1,
  activeTabId: null,
  activeWindowId: 1,
  activeWasInserted: false,
  entries: []
}

const emptyActivity: WorkingSetActivityStore = { version: 1, records: {} }

function dashboardServiceState(
  tabs: chrome.tabs.Tab[],
  workingSetActivity = emptyActivity
): CapturedDashboardServiceState {
  return {
    tabHistory: emptyTabHistory,
    workingSetActivity,
    retainedPages: [],
    retentionHealth: null,
    openTabsSnapshot: {
      tabs,
      windows: [{
        id: 1,
        focused: true,
        type: 'normal',
        alwaysOnTop: false,
        incognito: false
      }]
    }
  }
}

function createStartupSnapshotService(
  t: TestContext,
  options: {
    getDashboardServiceState: () => Promise<CapturedDashboardServiceState>
    alarms?: {
      create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => Promise<void>
      get: (name: string) => Promise<chrome.alarms.Alarm | undefined>
    }
  }
) {
  const runtime = ManagedRuntime.make(StartupSnapshot.layer({
    ...(options.alarms ? { alarms: options.alarms } : {}),
    getDashboardServiceState: Effect.tryPromise({
      try: options.getDashboardServiceState,
      catch: (cause) => cause
    })
  }).pipe(Layer.provideMerge(BrowserTabs.layer())))
  runtime.runSync(Effect.void)
  const service = runtime.runSync(StartupSnapshot)
  t.after(() => runtime.dispose())
  return {
    refreshNow: () => runtime.runPromise(service.refreshNow()),
    scheduleRefresh: () => runtime.runPromise(service.scheduleRefresh()),
    sessionsChanged: () => runtime.runPromise(service.sessionsChanged()),
    promoteDurableCheckpoint: () => runtime.runPromise(service.promoteDurableCheckpoint())
  }
}

type StorageValues = Record<string, unknown>

function installWorkerChrome(
  t: TestContext,
  options: {
    sessionValues?: StorageValues
    localValues?: StorageValues
    localGet?: (keys: string | string[]) => Promise<StorageValues>
    sessionGet?: (keys: string | string[]) => Promise<StorageValues>
  } = {}
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  const sessionValues = options.sessionValues ?? {}
  const localValues = options.localValues ?? {}
  let sessionWrites = 0
  let durableWrites = 0
  let savedPagesWrites = 0
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        id: 'tab-out',
        getURL: (path: string) => `chrome-extension://tab-out/${path}`
      },
      tabGroups: { query: async () => [] },
      storage: {
        session: {
          get: options.sessionGet ?? (async () => ({ ...sessionValues })),
          set: async (values: StorageValues) => {
            sessionWrites += 1
            Object.assign(sessionValues, values)
          },
          remove: async (key: string) => { delete sessionValues[key] }
        },
        local: {
          get: options.localGet ?? (async () => ({ ...localValues })),
          set: async (values: StorageValues) => {
            if (Object.hasOwn(values, DASHBOARD_STARTUP_SEED_CACHE_KEY)) durableWrites += 1
            if (Object.hasOwn(values, SAVED_PAGES_STORAGE_KEY)) savedPagesWrites += 1
            Object.assign(localValues, values)
          },
          remove: async (key: string) => { delete localValues[key] }
        }
      }
    }
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous)
    else Reflect.deleteProperty(globalThis, 'chrome')
  })
  return {
    sessionValues,
    localValues,
    sessionWrites: () => sessionWrites,
    durableWrites: () => durableWrites,
    savedPagesWrites: () => savedPagesWrites
  }
}

function storedSeed(values: StorageValues): DashboardStartupSeed | null {
  return parseDashboardStartupSeedBoundary(values[DASHBOARD_STARTUP_SEED_CACHE_KEY])
}

test('seed refreshes only for local sources that can change compact ordering', () => {
  const change: chrome.storage.StorageChange = { newValue: [] }

  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [RETAINED_PAGES_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SAVED_PAGES_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SECTION_PIN_STORAGE_KEY]: change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [PAGE_CHIP_PIN_STORAGE_KEY]: change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'session'), false)
})

test('worker writes compact Warm and Durable seeds while preserving pinned and saved-only card order', async (t) => {
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  const savedUrl = 'https://saved.example/report'
  const savedPages = addSavedPageToStore(emptySavedPagesStore(), {
    url: savedUrl,
    rawUrl: savedUrl,
    title: 'Saved report',
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 10)
  const storage = installWorkerChrome(t, {
    localValues: {
      [DOMAIN_PIN_STORAGE_KEY]: ['example.test'],
      [SAVED_PAGES_STORAGE_KEY]: savedPages
    }
  })
  const tabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report')
  ]
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => dashboardServiceState(tabs)
  })

  await service.refreshNow()

  const warm = storedSeed(storage.sessionValues)
  const durable = storedSeed(storage.localValues)
  assert.deepEqual(warm?.cardOrder, [
    'domain-example.test',
    'domain-example.com',
    'domain-saved.example'
  ])
  assert.deepEqual(durable?.cardOrder, warm?.cardOrder)
  assert.equal(durable?.titleRetention, undefined)
  assert.equal(Object.hasOwn(warm ?? {}, 'snapshot'), false)
  assert.equal(Object.hasOwn(warm ?? {}, 'localState'), false)
  assert.equal(storage.savedPagesWrites(), 0)
})

test('service schedules one non-sliding Durable promotion and promotes the newest Warm seed', async (t) => {
  const clock = FakeTimers.install({ now: 100, toFake: ['Date'] })
  t.after(() => clock.uninstall())
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  const storage = installWorkerChrome(t)
  let tabs = [makeChromeTab(1, 'https://first.example/docs', 'First')]
  let stateReads = 0
  let pendingAlarm: chrome.alarms.Alarm | undefined
  const alarmCreates: chrome.alarms.AlarmCreateInfo[] = []
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState(tabs)
    },
    alarms: {
      get: async () => pendingAlarm,
      create: async (name, alarmInfo) => {
        alarmCreates.push(alarmInfo)
        pendingAlarm = { name, scheduledTime: alarmInfo.when ?? Date.now() }
      }
    }
  })

  await service.refreshNow()
  assert.deepEqual(storedSeed(storage.localValues)?.cardOrder, ['domain-first.example'])

  await clock.tickAsync(100)
  tabs = [makeChromeTab(2, 'https://second.example/docs', 'Second')]
  await service.refreshNow()
  assert.equal(alarmCreates.length, 1)
  assert.equal(alarmCreates[0]?.when, 100 + STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS)

  await clock.tickAsync(100)
  tabs = [makeChromeTab(3, 'https://latest.example/docs', 'Latest')]
  await service.refreshNow()
  assert.equal(alarmCreates.length, 1, 'later Warm changes do not slide the pending checkpoint')
  assert.deepEqual(storedSeed(storage.sessionValues)?.cardOrder, ['domain-latest.example'])
  assert.deepEqual(storedSeed(storage.localValues)?.cardOrder, ['domain-first.example'])

  await service.promoteDurableCheckpoint()
  assert.deepEqual(storedSeed(storage.localValues)?.cardOrder, ['domain-latest.example'])
  assert.equal(stateReads, 3, 'promotion copies the Warm seed without rebuilding')
  assert.equal(pendingAlarm?.name, STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM)
})

test('a transient cache read failure retries once before performing browser work', async (t) => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  t.after(() => clock.uninstall())
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  let sessionReads = 0
  let stateReads = 0
  const storage = installWorkerChrome(t, {
    sessionGet: async () => {
      sessionReads += 1
      if (sessionReads === 1) throw new Error('session storage unavailable')
      return {}
    }
  })
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState([
        makeChromeTab(1, 'https://example.test/docs', 'Example')
      ])
    }
  })

  await service.refreshNow()
  assert.equal(stateReads, 0)
  assert.equal(storage.sessionWrites(), 0)

  await clock.tickAsync(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS)
  assert.equal(stateReads, 1)
  assert.ok(storedSeed(storage.sessionValues))
})

test('unknown pin input preserves the prior Warm seed', async (t) => {
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  const prior = {
    schemaVersion: 2,
    savedAt: 10,
    captureStartedAt: 10,
    cardOrder: ['domain-prior.test'],
    workingSetPriority: { epoch: 10, keys: [] }
  }
  const sessionValues: StorageValues = { [DASHBOARD_STARTUP_SEED_CACHE_KEY]: prior }
  const storage = installWorkerChrome(t, {
    sessionValues,
    localGet: async (keys) => {
      if (keys === DOMAIN_PIN_STORAGE_KEY) throw new Error('pin storage unavailable')
      return {}
    }
  })
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => dashboardServiceState([
      makeChromeTab(1, 'https://new.test/docs', 'New')
    ])
  })

  await service.refreshNow()

  assert.deepEqual(storage.sessionValues[DASHBOARD_STARTUP_SEED_CACHE_KEY], prior)
  assert.equal(storage.sessionWrites(), 0)
})

test('session changes no longer rebuild a seed that does not contain recently closed rows', async (t) => {
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  installWorkerChrome(t)
  let stateReads = 0
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState([])
    }
  })

  await service.refreshNow()
  await service.sessionsChanged()

  assert.equal(stateReads, 1)
})

test('seed scheduling uses a sliding quiet window with a fixed maximum wait', async (t) => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  t.after(() => clock.uninstall())
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  installWorkerChrome(t)
  let stateReads = 0
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState([])
    }
  })

  await service.scheduleRefresh()
  for (let elapsed = 3_000; elapsed < STARTUP_SNAPSHOT_MAX_WAIT_MS; elapsed += 3_000) {
    await clock.tickAsync(3_000)
    assert.equal(stateReads, 0)
    await service.scheduleRefresh()
  }

  await clock.tickAsync(3_000)
  assert.equal(stateReads, 1, 'fixed max wait refreshes despite a continuously sliding quiet timer')
})

test('a refresh requested during an active seed flight runs once as a trailing refresh', async (t) => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  t.after(() => clock.uninstall())
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  installWorkerChrome(t)
  const firstRead = Promise.withResolvers<void>()
  const releaseFirstRead = Promise.withResolvers<void>()
  let stateReads = 0
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => {
      stateReads += 1
      if (stateReads === 1) {
        firstRead.resolve()
        await releaseFirstRead.promise
      }
      return dashboardServiceState([])
    }
  })

  const active = service.refreshNow()
  await firstRead.promise
  const coalesced = service.refreshNow()
  releaseFirstRead.resolve()
  await Promise.all([active, coalesced])
  assert.equal(stateReads, 1)

  await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
  assert.equal(stateReads, 2)
})

test('a completed seed-flight failure does not block a later refresh', async (t) => {
  const restoreLocks = installWebLocksStub()
  t.after(restoreLocks)
  const storage = installWorkerChrome(t)
  let stateReads = 0
  const service = createStartupSnapshotService(t, {
    getDashboardServiceState: async () => {
      stateReads += 1
      if (stateReads === 1) throw new Error('worker read unavailable')
      return dashboardServiceState([
        makeChromeTab(1, 'https://recovered.example/docs', 'Recovered')
      ])
    }
  })

  await service.refreshNow()
  await service.refreshNow()

  assert.equal(stateReads, 2)
  assert.deepEqual(storedSeed(storage.sessionValues)?.cardOrder, [
    'domain-recovered.example'
  ])
})
