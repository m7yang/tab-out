import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DASHBOARD_STARTUP_SEED_CACHE_KEY,
  DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS,
  DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS,
  LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY,
  dashboardStartupPreviousOrder,
  dashboardStartupTitleHistory,
  invalidateDashboardStartupTitleRetention,
  loadDashboardStartupSeed,
  promoteDashboardStartupSeed,
  rebaseDashboardStartupWorkingSetPriority,
  saveDashboardStartupSeed,
  type DashboardStartupSeed
} from '../src/extension/startup-snapshot.js'
import { parseDashboardStartupSeedBoundary } from '../src/extension/startup-snapshot-schema.js'
import type { WorkingSetSnapshot } from '../src/extension/types'
import { makeCachedSuspendedTab } from './helpers/suspended-tab.js'

type StoredValues = Record<string, unknown>
type StorageOperation = { area: 'session' | 'local'; kind: 'set' | 'remove'; key: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function storageArea(
  area: 'session' | 'local',
  values: StoredValues,
  operations: StorageOperation[],
  setAttempt?: (next: StoredValues, attempt: number) => Promise<void>
) {
  let attempt = 0
  return {
    get: async () => ({ ...values }),
    set: async (next: StoredValues) => {
      attempt += 1
      await setAttempt?.(next, attempt)
      Object.assign(values, next)
      for (const key of Object.keys(next)) operations.push({ area, kind: 'set', key })
    },
    remove: async (key: string) => {
      delete values[key]
      operations.push({ area, kind: 'remove', key })
    }
  }
}

function installStorage(
  sessionValues: StoredValues,
  localValues: StoredValues,
  options: {
    sessionSetAttempt?: (next: StoredValues, attempt: number) => Promise<void>
    localSetAttempt?: (next: StoredValues, attempt: number) => Promise<void>
  } = {}
): { operations: StorageOperation[]; restore: () => void } {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  const operations: StorageOperation[] = []
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: {
        session: storageArea('session', sessionValues, operations, options.sessionSetAttempt),
        local: storageArea('local', localValues, operations, options.localSetAttempt)
      }
    }
  })
  return {
    operations,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, 'chrome', previous)
      else Reflect.deleteProperty(globalThis, 'chrome')
    }
  }
}

function seed(
  captureStartedAt: number,
  overrides: Partial<DashboardStartupSeed> = {}
): DashboardStartupSeed {
  return {
    schemaVersion: 2,
    savedAt: captureStartedAt,
    captureStartedAt,
    cardOrder: ['domain-example.test'],
    workingSetPriority: {
      epoch: captureStartedAt,
      keys: ['https://example.test/docs']
    },
    ...overrides
  }
}

function workingSet(keys: readonly string[]): WorkingSetSnapshot {
  return {
    defaultLimit: 8,
    expandedLimit: 16,
    items: keys.map((key, index) => ({
      key,
      tabId: index + 1,
      windowId: 1,
      tabUrl: key,
      rawUrl: key,
      title: `Page ${index + 1}`,
      displayUrl: key,
      faviconUrl: '',
      dupeCount: 1,
      active: false,
      activeInOtherWindow: false,
      score: 100 - index,
      lastActivatedAt: 100 - index
    }))
  }
}

function legacySeed(savedAt: number) {
  return {
    savedAt,
    captureStartedAt: savedAt,
    workingSetSavedAt: savedAt - 1,
    snapshot: {
      dashboard: {
        realTabs: [makeCachedSuspendedTab('https://example.test/docs')],
        domainGroups: [{ domain: 'example.test', tabs: [] }]
      },
      workingSet: workingSet(['https://example.test/docs']),
      tabHistory: { entries: [{ title: 'must stay unread' }] },
      closedTabs: [{ title: 'must stay unread' }],
      startupViewModel: { viewModel: { mustStayUnread: true } }
    },
    localState: { pinnedDomains: ['must-stay-unread.test'] }
  }
}

test('v2 seed decoding filters duplicate and noncanonical continuity keys', () => {
  const parsed = parseDashboardStartupSeedBoundary({
    schemaVersion: 2,
    savedAt: 10,
    captureStartedAt: 9,
    cardOrder: [
      'domain-example.test',
      'domain-example.test',
      'domain-%',
      'not-a-domain-card'
    ],
    workingSetPriority: {
      epoch: 8,
      keys: [
        'https://example.test/docs',
        'https://example.test/docs',
        'https://EXAMPLE.test/docs',
        'chrome://settings/'
      ]
    },
    titleRetention: [
      { tabId: 7, url: 'https://example.test/docs', title: 'Example', kind: 'suspended' },
      { tabId: 7, url: 'https://example.test/other', title: 'Duplicate id', kind: 'suspended' },
      { tabId: 8, url: 'not a URL', title: 'Invalid URL', kind: 'retained-loading' },
      { tabId: 9, url: 'https://example.test/blank', title: '\u200E ', kind: 'suspended' }
    ]
  })

  assert.deepEqual(parsed?.cardOrder, ['domain-example.test'])
  assert.deepEqual(parsed?.workingSetPriority.keys, ['https://example.test/docs'])
  assert.deepEqual(parsed?.titleRetention, [{
    tabId: 7,
    url: 'https://example.test/docs',
    title: 'Example',
    kind: 'suspended'
  }])
})

test('legacy render caches are derived read-only into compact continuity seeds', async (t) => {
  const sessionValues = {
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(200)
  }
  const localValues = {
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(100)
  }
  const storage = installStorage(sessionValues, localValues)
  t.after(() => {
    storage.restore()
  })

  const loaded = await loadDashboardStartupSeed(300)

  assert.deepEqual(loaded?.cardOrder, ['domain-example.test'])
  assert.deepEqual(loaded?.workingSetPriority, {
    epoch: 199,
    keys: ['https://example.test/docs']
  })
  assert.equal(dashboardStartupTitleHistory(loaded)[0]?.title, 'Example Docs')
  assert.ok(sessionValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY])
  assert.ok(localValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY])
  assert.deepEqual(storage.operations, [])
})

test('a successful v2 save migrates each area only after its compact write', async (t) => {
  const sessionValues: StoredValues = {
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(100)
  }
  const localValues: StoredValues = {
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(100)
  }
  const storage = installStorage(sessionValues, localValues)
  t.after(() => {
    storage.restore()
  })

  await saveDashboardStartupSeed({
    cardOrder: ['domain-example.test'],
    workingSet: workingSet(['https://example.test/docs']),
    titleTabs: [makeCachedSuspendedTab('https://example.test/docs')]
  }, { now: 200, captureStartedAt: 200 })

  const warm = sessionValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  const durable = localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  assert.deepEqual(parseDashboardStartupSeedBoundary(warm)?.titleRetention, [{
    tabId: 7,
    url: 'https://example.test/docs',
    title: 'Example Docs',
    kind: 'suspended'
  }])
  assert.equal(parseDashboardStartupSeedBoundary(durable)?.titleRetention, undefined)
  assert.ok(isRecord(warm))
  assert.equal(Object.hasOwn(warm, 'snapshot'), false)
  assert.equal(Object.hasOwn(warm, 'localState'), false)
  assert.equal(sessionValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)
  assert.equal(localValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)
  assert.deepEqual(storage.operations, [
    { area: 'session', kind: 'set', key: DASHBOARD_STARTUP_SEED_CACHE_KEY },
    { area: 'session', kind: 'remove', key: LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY },
    { area: 'local', kind: 'set', key: DASHBOARD_STARTUP_SEED_CACHE_KEY },
    { area: 'local', kind: 'remove', key: LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY }
  ])
})

test('a newer legacy generation replaces an older v2 seed before legacy cleanup', async (t) => {
  const sessionValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(50),
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(100)
  }
  const localValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(50),
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(100)
  }
  const storage = installStorage(sessionValues, localValues)
  t.after(() => {
    storage.restore()
  })

  await saveDashboardStartupSeed({
    cardOrder: ['domain-example.test'],
    workingSet: workingSet(['https://example.test/docs']),
    titleTabs: [makeCachedSuspendedTab('https://example.test/docs')]
  }, { now: 200, captureStartedAt: 200 })

  assert.equal(parseDashboardStartupSeedBoundary(
    sessionValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )?.captureStartedAt, 200)
  assert.equal(parseDashboardStartupSeedBoundary(
    localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )?.captureStartedAt, 200)
  assert.equal(sessionValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)
  assert.equal(localValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)
})

test('failed durable replacement leaves its legacy checkpoint recoverable', async (t) => {
  const sessionValues: StoredValues = {}
  const localValues: StoredValues = {
    [LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: legacySeed(100)
  }
  const storage = installStorage(sessionValues, localValues, {
    localSetAttempt: async () => { throw new Error('durable storage unavailable') }
  })
  t.after(() => {
    storage.restore()
  })

  await saveDashboardStartupSeed({
    cardOrder: ['domain-example.test'],
    workingSet: workingSet(['https://example.test/docs']),
    titleTabs: []
  }, { now: 200, captureStartedAt: 200 })

  assert.ok(localValues[LEGACY_DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY])
  assert.equal(localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY], undefined)
  assert.equal(storage.operations.some((operation) =>
    operation.area === 'local' && operation.kind === 'remove'
  ), false)
})

test('seed loading selects the newest generation and uses Warm only for equal-generation title data', async (t) => {
  const sessionValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(200, {
      titleRetention: [{
        tabId: 7,
        url: 'https://example.test/docs',
        title: 'Warm title',
        kind: 'suspended'
      }]
    })
  }
  const localValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(200)
  }
  const storage = installStorage(sessionValues, localValues)
  t.after(() => {
    storage.restore()
  })

  assert.equal((await loadDashboardStartupSeed(250))?.titleRetention?.[0]?.title, 'Warm title')

  localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY] = seed(300, {
    cardOrder: ['domain-newer.test']
  })
  const newer = await loadDashboardStartupSeed(350)
  assert.deepEqual(newer?.cardOrder, ['domain-newer.test'])
  assert.equal(newer?.titleRetention, undefined)
})

test('seed loading rejects an expired Durable checkpoint', async (t) => {
  const sessionValues: StoredValues = {}
  const localValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(100)
  }
  const storage = installStorage(sessionValues, localValues)
  t.after(() => {
    storage.restore()
  })

  assert.equal(
    await loadDashboardStartupSeed(100 + DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS + 1),
    null
  )
})

test('ordering helpers install card order and intersect frozen priority with live rows', () => {
  const cached = seed(100, {
    cardOrder: ['domain-second.test', 'domain-first.test'],
    workingSetPriority: {
      epoch: 100,
      keys: ['https://closed.test/', 'https://example.test/docs']
    }
  })
  const live = workingSet([
    'https://example.test/app',
    'https://example.test/docs'
  ])
  live.items.push(
    {
      ...live.items[0]!,
      key: '',
      tabId: 3,
      tabUrl: 'chrome://newtab',
      rawUrl: 'chrome://newtab'
    },
    {
      ...live.items[0]!,
      key: '',
      tabId: 4,
      tabUrl: 'chrome://extensions',
      rawUrl: 'chrome://extensions'
    }
  )

  assert.deepEqual(dashboardStartupPreviousOrder(cached).entries().toArray(), [
    ['domain-second.test', 0],
    ['domain-first.test', 1]
  ])
  const rebased = rebaseDashboardStartupWorkingSetPriority(cached, live, 200)
  assert.deepEqual(rebased.items.map((item) => item.key), [
    'https://example.test/docs',
    'https://example.test/app',
    '',
    ''
  ])
  assert.equal(rebased.items[0]?.tabId, 2)
  assert.equal(rebased.items[0]?.score, 4)
  assert.equal(rebased.items[1]?.tabId, 1)
  assert.equal(rebased.items[1]?.score, 3)
  assert.deepEqual(rebased.items.slice(2).map((item) => item.tabId), [3, 4])

  const expired = rebaseDashboardStartupWorkingSetPriority(
    cached,
    live,
    100 + DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS + 1
  )
  assert.deepEqual(expired, live)
})

test('a title-only Warm update neither changes Durable nor arms promotion', async (t) => {
  const originalWarm = seed(100, {
    titleRetention: [{
      tabId: 7,
      url: 'https://example.test/docs',
      title: 'Old title',
      kind: 'suspended'
    }]
  })
  const originalDurable = seed(100)
  const sessionValues: StoredValues = { [DASHBOARD_STARTUP_SEED_CACHE_KEY]: originalWarm }
  const localValues: StoredValues = { [DASHBOARD_STARTUP_SEED_CACHE_KEY]: originalDurable }
  const storage = installStorage(sessionValues, localValues)
  let scheduled = 0
  t.after(() => {
    storage.restore()
  })

  const titleTab = makeCachedSuspendedTab('https://example.test/docs')
  titleTab.title = 'New title'
  await saveDashboardStartupSeed({
    cardOrder: ['domain-example.test'],
    workingSet: workingSet(['https://example.test/docs']),
    titleTabs: [titleTab]
  }, {
    now: 200,
    captureStartedAt: 200,
    durableCheckpointIntervalMs: 300,
    scheduleDurableCheckpoint: () => { scheduled += 1 }
  })

  assert.equal(parseDashboardStartupSeedBoundary(
    sessionValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )?.titleRetention?.[0]?.title, 'New title')
  assert.deepEqual(localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY], originalDurable)
  assert.equal(scheduled, 0)
})

test('title invalidation advances the generation so an older capture cannot restore it', async (t) => {
  const sessionValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(100, {
      titleRetention: [{
        tabId: 7,
        url: 'https://example.test/docs',
        title: 'Old title',
        kind: 'suspended'
      }]
    })
  }
  const localValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(100)
  }
  const storage = installStorage(sessionValues, localValues)
  t.after(() => {
    storage.restore()
  })

  assert.equal(await invalidateDashboardStartupTitleRetention(7, 200), true)
  await saveDashboardStartupSeed({
    cardOrder: ['domain-example.test'],
    workingSet: workingSet(['https://example.test/docs']),
    titleTabs: [makeCachedSuspendedTab('https://example.test/docs')]
  }, { now: 150, captureStartedAt: 150 })

  const warm = parseDashboardStartupSeedBoundary(
    sessionValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )
  assert.equal(warm?.captureStartedAt, 200)
  assert.equal(warm?.titleRetention, undefined)
  assert.equal(parseDashboardStartupSeedBoundary(
    localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )?.captureStartedAt, 100)
})

test('durable promotion retries once and strips session-only title retention', async (t) => {
  const sessionValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(200, {
      titleRetention: [{
        tabId: 7,
        url: 'https://example.test/docs',
        title: 'Warm title',
        kind: 'suspended'
      }]
    })
  }
  const localValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(100)
  }
  let attempts = 0
  const storage = installStorage(sessionValues, localValues, {
    localSetAttempt: async (_next, attempt) => {
      attempts = attempt
      if (attempt === 1) throw new Error('transient write failure')
    }
  })
  t.after(() => {
    storage.restore()
  })

  assert.equal(await promoteDashboardStartupSeed(300), true)
  assert.equal(attempts, 2)
  const durable = parseDashboardStartupSeedBoundary(
    localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )
  assert.equal(durable?.captureStartedAt, 200)
  assert.equal(durable?.savedAt, 300)
  assert.equal(durable?.titleRetention, undefined)
})

test('a later material refresh can re-arm promotion after both durable write attempts fail', async (t) => {
  const sessionValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(200, {
      cardOrder: ['domain-newer.test']
    })
  }
  const localValues: StoredValues = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: seed(100)
  }
  let failDurableWrites = true
  const storage = installStorage(sessionValues, localValues, {
    localSetAttempt: async () => {
      if (failDurableWrites) throw new Error('durable storage unavailable')
    }
  })
  let scheduledAt: number | null = null
  t.after(() => {
    storage.restore()
  })

  assert.equal(await promoteDashboardStartupSeed(300), false)
  assert.deepEqual(parseDashboardStartupSeedBoundary(
    localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )?.cardOrder, ['domain-example.test'])

  failDurableWrites = false
  await saveDashboardStartupSeed({
    cardOrder: ['domain-newer.test'],
    workingSet: workingSet(['https://example.test/docs']),
    titleTabs: []
  }, {
    now: 400,
    captureStartedAt: 400,
    durableCheckpointIntervalMs: 300,
    scheduleDurableCheckpoint: (when) => { scheduledAt = when }
  })

  assert.equal(scheduledAt, 400)
  assert.deepEqual(parseDashboardStartupSeedBoundary(
    localValues[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )?.cardOrder, ['domain-example.test'])
})
