import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyOpenSurfaceInventory,
  markOpenSurfaceClosure,
  markOpenSurfaceClosures,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
  openSurfaceInventoriesEqual,
  observeOpenSurface,
  removeOpenSurface,
  removeOpenSurfaceLifetimes,
  seedOpenSurfaceInventory,
  transferOpenSurfaceLifetime
} from '../src/extension/open-surface-inventory.js'

function sequentialTokens() {
  let next = 0
  return () => `token-${++next}`
}

test('seeding inventories every eligible non-private surface with one stable lifetime token', async () => {
  const inventory = await seedOpenSurfaceInventory([
    { tabId: 1, surfaceKind: 'normal-tab', url: 'https://example.test/docs', title: 'Docs' },
    { tabId: 2, surfaceKind: 'normal-tab', url: 'chrome://settings/privacy', title: 'Settings' },
    { tabId: 3, surfaceKind: 'normal-tab', url: 'chrome-extension://other-id/options.html', title: 'Options' },
    { tabId: 4, surfaceKind: 'app', url: 'https://app.example.test/workspace', title: 'Workspace' },
    { tabId: 5, surfaceKind: 'normal-tab', url: 'https://private.example.test/', title: 'Private', incognito: true },
    { tabId: 6, surfaceKind: 'normal-tab', url: 'chrome://newtab/', title: 'New Tab' },
    { tabId: 7, surfaceKind: 'normal-tab', url: 'chrome-extension://tab-out-id/index.html', title: 'Tab Out' }
  ], {
    runtimeId: 'tab-out-id',
    closureTokenFactory: sequentialTokens()
  })

  assert.equal(inventory.schemaVersion, OPEN_SURFACE_INVENTORY_SCHEMA_VERSION)
  assert.equal(inventory.identityVersion, 1)
  assert.deepEqual(Object.keys(inventory.entries), ['1', '2', '3', '4'])
  assert.deepEqual(Object.values(inventory.entries).map((entry) => entry.closureToken), [
    'token-1',
    'token-2',
    'token-3',
    'token-4'
  ])
  assert.equal(inventory.entries['4']?.surfaceKind, 'app')
})

test('ineligible and Incognito observations are rejected before lifetime-token allocation', async () => {
  let tokenAllocations = 0
  const closureTokenFactory = () => {
    tokenAllocations += 1
    return `token-${tokenAllocations}`
  }

  await seedOpenSurfaceInventory([
    { tabId: 1, surfaceKind: 'normal-tab', url: 'https://private.example.test/', incognito: true },
    { tabId: 2, surfaceKind: 'normal-tab', url: 'chrome://newtab/' },
    { tabId: 3, surfaceKind: 'normal-tab', url: 'https://example.test/' }
  ], { closureTokenFactory })

  assert.equal(tokenAllocations, 1)
})

test('observing navigation and metadata changes preserves the physical lifetime token', async () => {
  const tokenFactory = sequentialTokens()
  const first = await observeOpenSurface(emptyOpenSurfaceInventory(), {
    tabId: 10,
    surfaceKind: 'normal-tab',
    url: 'https://example.test/old',
    title: 'Old page',
    favIconUrl: 'https://example.test/old.ico'
  }, { closureTokenFactory: tokenFactory })
  const navigated = await observeOpenSurface(first.inventory, {
    tabId: 10,
    surfaceKind: 'normal-tab',
    url: 'https://example.test/new',
    title: '',
    favIconUrl: ''
  }, { closureTokenFactory: tokenFactory })
  const enriched = await observeOpenSurface(navigated.inventory, {
    tabId: 10,
    surfaceKind: 'normal-tab',
    url: 'https://example.test/new',
    title: 'New page',
    favIconUrl: 'https://example.test/new.ico'
  }, { closureTokenFactory: tokenFactory })
  const transientEmpty = await observeOpenSurface(enriched.inventory, {
    tabId: 10,
    surfaceKind: 'normal-tab',
    url: 'https://example.test/new',
    title: '',
    favIconUrl: ''
  }, { closureTokenFactory: tokenFactory })

  assert.equal(first.entry?.closureToken, 'token-1')
  assert.equal(navigated.entry?.closureToken, 'token-1')
  assert.equal(navigated.entry?.url, 'https://example.test/new')
  assert.equal(navigated.entry?.title, '')
  assert.equal(navigated.entry?.favIconUrl, undefined)
  assert.equal(enriched.entry?.closureToken, 'token-1')
  assert.equal(transientEmpty.entry?.title, 'New page')
  assert.equal(transientEmpty.entry?.favIconUrl, 'https://example.test/new.ico')
})

test('inventory bounds reusable metadata without truncating exact target or identity', async () => {
  const longTitle = `${'a'.repeat(511)}💡extra`
  const longUrl = `https://example.test/${'path/'.repeat(900)}`
  const oversizedFavicon = `https://example.test/${'x'.repeat(2_100)}.ico`
  const result = await observeOpenSurface(emptyOpenSurfaceInventory(), {
    tabId: 20,
    surfaceKind: 'normal-tab',
    url: longUrl,
    title: longTitle,
    favIconUrl: oversizedFavicon
  }, { closureTokenFactory: () => 'token-long' })

  assert.equal(result.entry?.url, longUrl)
  assert.equal(Array.from(result.entry?.title || '').length, 512)
  assert.equal(result.entry?.title.endsWith('💡'), true)
  assert.equal(result.entry?.favIconUrl, undefined)

  const blobFavicon = await observeOpenSurface(result.inventory, {
    tabId: 20,
    surfaceKind: 'normal-tab',
    url: longUrl,
    title: longTitle,
    favIconUrl: 'blob:https://example.test/session-only'
  })
  assert.equal(blobFavicon.entry?.favIconUrl, undefined)
})

test('removal returns the exact capture candidate and leaves other lifetimes untouched', async () => {
  const inventory = await seedOpenSurfaceInventory([
    { tabId: 1, surfaceKind: 'normal-tab', url: 'https://one.example.test/', title: 'One' },
    { tabId: 2, surfaceKind: 'normal-tab', url: 'https://two.example.test/', title: 'Two' }
  ], { closureTokenFactory: sequentialTokens() })
  const removed = removeOpenSurface(inventory, 1)

  assert.equal(removed.entry?.tabId, 1)
  assert.equal(removed.entry?.url, 'https://one.example.test/')
  assert.equal(removed.entry?.closureToken, 'token-1')
  assert.deepEqual(Object.keys(removed.inventory.entries), ['2'])
  assert.equal(removeOpenSurface(removed.inventory, 1).changed, false)
})

test('a physical lifetime keeps the first observed closure time across replay', async () => {
  const inventory = await seedOpenSurfaceInventory([{
    tabId: 1,
    surfaceKind: 'normal-tab',
    url: 'https://one.example.test/',
    title: 'One'
  }], { closureTokenFactory: () => 'stable-lifetime' })

  const first = markOpenSurfaceClosure(inventory, 1, 1_000, 'stable-lifetime')
  const replay = markOpenSurfaceClosure(first.inventory, 1, 9_000, 'stable-lifetime')

  assert.equal(first.changed, true)
  assert.equal(first.entry?.closedAt, 1_000)
  assert.equal(replay.changed, false)
  assert.equal(replay.entry?.closedAt, 1_000)
  assert.equal(replay.inventory, first.inventory)
  assert.equal(openSurfaceInventoriesEqual(first.inventory, replay.inventory), true)
  assert.equal(openSurfaceInventoriesEqual(first.inventory, inventory), false)
})

test('bulk closure marking preserves order, token guards, and original inputs', async () => {
  const inventory = await seedOpenSurfaceInventory([
    { tabId: 1, surfaceKind: 'normal-tab', url: 'https://one.example.test/', title: 'One' },
    { tabId: 2, surfaceKind: 'normal-tab', url: 'https://two.example.test/', title: 'Two' },
    { tabId: 3, surfaceKind: 'normal-tab', url: 'https://three.example.test/', title: 'Three' }
  ], { closureTokenFactory: sequentialTokens() })
  const originalEntries = structuredClone(inventory.entries)

  const marked = markOpenSurfaceClosures(inventory, [
    { tabId: 1, closedAt: 1_000, closureToken: 'token-1' },
    { tabId: 2, closedAt: 2_000, closureToken: 'wrong-token' },
    { tabId: 3, closedAt: 3_000, closureToken: 'token-3' },
    { tabId: 99, closedAt: 4_000, closureToken: 'missing-token' }
  ])

  assert.equal(marked.changed, true)
  assert.deepEqual(marked.entries.map((entry) => entry?.tabId ?? null), [1, 2, 3, null])
  assert.equal(marked.inventory.entries['1']?.closedAt, 1_000)
  assert.equal(marked.inventory.entries['2']?.closedAt, undefined)
  assert.equal(marked.inventory.entries['3']?.closedAt, 3_000)
  assert.deepEqual(inventory.entries, originalEntries)

  const replay = markOpenSurfaceClosures(marked.inventory, [
    { tabId: 1, closedAt: 9_000, closureToken: 'token-1' },
    { tabId: 3, closedAt: 9_000, closureToken: 'token-3' }
  ])
  assert.equal(replay.changed, false)
  assert.equal(replay.inventory, marked.inventory)
  assert.deepEqual(replay.entries.map((entry) => entry?.closedAt), [1_000, 3_000])
})

test('bulk lifetime cleanup removes only matching tokens without mutating the input', async () => {
  const inventory = await seedOpenSurfaceInventory([
    { tabId: 1, surfaceKind: 'normal-tab', url: 'https://one.example.test/', title: 'One' },
    { tabId: 2, surfaceKind: 'normal-tab', url: 'https://two.example.test/', title: 'Two' },
    { tabId: 3, surfaceKind: 'normal-tab', url: 'https://three.example.test/', title: 'Three' }
  ], { closureTokenFactory: sequentialTokens() })
  const originalEntries = structuredClone(inventory.entries)

  const removed = removeOpenSurfaceLifetimes(inventory, [
    { tabId: 1, closureToken: 'token-1' },
    { tabId: 2, closureToken: 'wrong-token' },
    { tabId: 99, closureToken: 'missing-token' }
  ])

  assert.equal(removed.changed, true)
  assert.deepEqual(removed.entries.map((entry) => entry?.tabId ?? null), [1, null, null])
  assert.deepEqual(Object.keys(removed.inventory.entries), ['2', '3'])
  assert.deepEqual(inventory.entries, originalEntries)

  const noOp = removeOpenSurfaceLifetimes(removed.inventory, [
    { tabId: 2, closureToken: 'wrong-token' }
  ])
  assert.equal(noOp.changed, false)
  assert.equal(noOp.inventory, removed.inventory)
})

test('tabs.onReplaced transfer keeps the old lifetime token while adopting the replacement target', async () => {
  const seeded = await observeOpenSurface(emptyOpenSurfaceInventory(), {
    tabId: 30,
    surfaceKind: 'normal-tab',
    url: 'https://example.atlassian.net/browse/ABC-123?sourceType=before',
    title: 'Before'
  }, { closureTokenFactory: () => 'original-token' })
  const replaced = await transferOpenSurfaceLifetime(seeded.inventory, 30, {
    tabId: 31,
    surfaceKind: 'normal-tab',
    url: 'https://example.atlassian.net/browse/ABC-123?sourceType=after',
    title: ''
  }, { closureTokenFactory: () => 'must-not-be-used' })

  assert.equal(replaced.transferred, true)
  assert.equal(replaced.entry?.tabId, 31)
  assert.equal(replaced.entry?.closureToken, 'original-token')
  assert.equal(replaced.entry?.closedAt, undefined)
  assert.equal(replaced.entry?.url, 'https://example.atlassian.net/browse/ABC-123?sourceType=after')
  assert.equal(replaced.entry?.title, 'Before')
  assert.equal(replaced.inventory.entries['30'], undefined)
  assert.equal(replaced.inventory.entries['31']?.closureToken, 'original-token')
})

test('replacement into an ineligible surface removes inventory without fabricating a closure', async () => {
  const seeded = await observeOpenSurface(emptyOpenSurfaceInventory(), {
    tabId: 40,
    surfaceKind: 'normal-tab',
    url: 'https://example.test/before-replacement',
    title: 'Before'
  }, { closureTokenFactory: () => 'original-token' })
  const replaced = await transferOpenSurfaceLifetime(seeded.inventory, 40, {
    tabId: 41,
    surfaceKind: 'normal-tab',
    url: 'chrome://newtab/',
    title: 'New Tab'
  })

  assert.equal(replaced.transferred, true)
  assert.equal(replaced.entry, null)
  assert.deepEqual(replaced.inventory.entries, {})
})
