import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import type { DashboardTab, DomainGroup } from '../src/extension/types'
import { collectDashboardChips } from './helpers/domain-card-view-model.js'

function makeTab(overrides: Partial<DashboardTab> = {}): DashboardTab {
  return {
    id: 1,
    url: 'https://example.test/page',
    rawUrl: 'https://example.test/page',
    suspended: false,
    title: 'Example Page',
    status: 'complete',
    favIconUrl: 'https://example.test/favicon.png',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    sourceType: 'tab',
    ...overrides,
  }
}

function firstChip(tabs: DashboardTab[]) {
  const group: DomainGroup = { domain: 'example.test', tabs }
  return computeDomainCardViewModel(group, { currentWindowId: 1 }).sections?.[0]?.flatVisibleChips[0]
}

test('a loading live tab produces a loading Page Chip', () => {
  const chip = firstChip([makeTab({ status: 'loading' })])

  assert.equal(chip?.loading, true)
})

test('a same-title Page Chip loads when any URL variant is loading', () => {
  const chip = firstChip([
    makeTab({ id: 1, url: 'https://example.test/alpha', rawUrl: 'https://example.test/alpha', title: 'Shared title' }),
    makeTab({ id: 2, url: 'https://example.test/beta', rawUrl: 'https://example.test/beta', title: 'Shared title', status: 'loading' }),
  ])

  assert.ok(chip?.sameTitlePageChipPlan)
  assert.equal(chip?.loading, true)
})

test('a folded Page Chip loads when any environment is loading', () => {
  const chip = firstChip([
    makeTab({ id: 1, url: 'https://dev.example.test/app', rawUrl: 'https://dev.example.test/app' }),
    makeTab({ id: 2, url: 'https://qa.example.test/app', rawUrl: 'https://qa.example.test/app', status: 'loading' }),
  ])

  assert.equal(chip?.envs?.length, 2)
  assert.equal(chip?.loading, true)
})

test('a folded Page Chip loads when a non-representative duplicate is loading', () => {
  const tabs = [
    makeTab({ id: 1, url: 'https://dev.example.test/app', rawUrl: 'https://dev.example.test/app' }),
    makeTab({ id: 2, url: 'https://dev.example.test/app', rawUrl: 'https://dev.example.test/app', status: 'loading' }),
    makeTab({ id: 3, url: 'https://qa.example.test/app', rawUrl: 'https://qa.example.test/app' }),
  ]

  const loadingChip = firstChip(tabs)
  const completeChip = firstChip(tabs.map((tab) => ({ ...tab, status: 'complete' })))

  assert.equal(loadingChip?.envs?.length, 2)
  assert.equal(loadingChip?.loading, true)
  assert.equal(completeChip?.loading, false)
})

test('a duplicate Page Chip loads when any open copy is loading', () => {
  const chip = firstChip([
    makeTab({ id: 1 }),
    makeTab({ id: 2, windowId: 2, status: 'loading' }),
  ])

  assert.equal(chip?.dupeCount, 2)
  assert.equal(chip?.loading, true)
})

test('only awake open tabs can make a Page Chip loading', () => {
  const complete = firstChip([makeTab()])
  const unloaded = firstChip([makeTab({ status: 'unloaded' })])
  const suspended = firstChip([makeTab({ suspended: true, status: 'loading' })])
  const bookmark = firstChip([makeTab({ id: 'bookmark:1', sourceType: 'bookmark', status: 'loading' })])
  const history = firstChip([makeTab({ id: 'history:1', sourceType: 'history', status: 'loading' })])
  const closedSaved = firstChip([makeTab({ id: 'saved:1', sourceType: 'saved-page', saved: true, closedSaved: true, status: 'loading' })])

  assert.deepEqual(
    [complete, unloaded, suspended, bookmark, history, closedSaved].map((chip) => chip?.loading),
    [false, false, false, false, false, false],
  )
})

test('New tabs loading stays within its physical bucket and clears after its aliases complete', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out-runtime' } }
  try {
    const loadingTabs = [
      makeTab({
        id: 1,
        active: true,
        isTabOut: true,
        url: 'chrome://newtab/',
        rawUrl: 'chrome://newtab/',
      }),
      makeTab({
        id: 2,
        isTabOut: true,
        status: 'loading',
        url: 'chrome-extension://tab-out-runtime/index.html',
        rawUrl: 'chrome-extension://tab-out-runtime/index.html',
      }),
      makeTab({ id: 3, isTabOut: true, url: 'chrome://newtab/', rawUrl: 'chrome://newtab/' }),
    ]

    const chipsFor = (tabs: DashboardTab[]) => collectDashboardChips(computeDomainCardViewModel(
      { domain: '__tab-out__', label: 'New tabs', tabs },
      { currentWindowId: 1 },
    ))
    const loadingChips = chipsFor(loadingTabs)
    assert.equal(loadingChips.length, 2)
    assert.equal(loadingChips.find((chip) => chip.isCurrentTabOut)?.loading, false)
    const duplicates = loadingChips.find((chip) => !chip.isCurrentTabOut)
    assert.equal(duplicates?.dupeCount, 2)
    assert.equal(duplicates?.loading, true)
    assert.deepEqual(chipsFor(loadingTabs.map((tab) => ({ ...tab, status: 'complete' })))
      .map((chip) => chip.loading), [false, false])
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('duplicate, same-title, and folded Page Chips recompute after loading completes', () => {
  const scenarios = [
    [
      makeTab({ id: 1 }),
      makeTab({ id: 2, windowId: 2, status: 'loading' }),
    ],
    [
      makeTab({ id: 1, url: 'https://example.test/alpha', rawUrl: 'https://example.test/alpha', title: 'Shared title' }),
      makeTab({ id: 2, url: 'https://example.test/beta', rawUrl: 'https://example.test/beta', title: 'Shared title', status: 'loading' }),
    ],
    [
      makeTab({ id: 1, url: 'https://dev.example.test/app', rawUrl: 'https://dev.example.test/app' }),
      makeTab({ id: 2, url: 'https://qa.example.test/app', rawUrl: 'https://qa.example.test/app', status: 'loading' }),
    ],
  ]

  for (const tabs of scenarios) {
    assert.equal(firstChip(tabs)?.loading, true)
    assert.equal(firstChip(
      tabs.map((tab) => ({ ...tab, status: 'complete' })),
    )?.loading, false)
  }
})
