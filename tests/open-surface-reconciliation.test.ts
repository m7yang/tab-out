import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyOpenSurfaceInventory,
  seedOpenSurfaceInventory
} from '../src/extension/open-surface-inventory.js'
import { reconcileOpenSurfaces } from '../src/extension/open-surface-reconciliation.js'

function sequentialTokens(prefix: string) {
  let next = 0
  return () => `${prefix}-${++next}`
}

const currentOne = {
  tabId: 1,
  surfaceKind: 'normal-tab' as const,
  url: 'https://example.test/one',
  title: 'One'
}

test('first installation seeds both inventories without inferring a closure', async () => {
  const result = await reconcileOpenSurfaces({
    mode: 'first-install',
    session: emptyOpenSurfaceInventory(),
    durable: emptyOpenSurfaceInventory(),
    current: [currentOne],
    options: { closureTokenFactory: () => 'new-lifetime' }
  })

  assert.deepEqual(result.inferredClosures, [])
  assert.equal(result.inventory.entries['1']?.closureToken, 'new-lifetime')
})

test('browser startup infers every prior durable lifetime closed before seeding restored tabs anew', async () => {
  const durable = await seedOpenSurfaceInventory([currentOne], {
    closureTokenFactory: () => 'prior-lifetime'
  })
  const result = await reconcileOpenSurfaces({
    mode: 'browser-startup',
    session: emptyOpenSurfaceInventory(),
    durable,
    current: [currentOne],
    options: { closureTokenFactory: () => 'restored-lifetime' }
  })

  assert.equal(result.inferredClosures[0]?.closureToken, 'prior-lifetime')
  assert.equal(result.inventory.entries['1']?.closureToken, 'restored-lifetime')
})

test('worker resume infers only missing session lifetimes and preserves surviving tokens', async () => {
  const session = await seedOpenSurfaceInventory([
    currentOne,
    {
      tabId: 2,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/two',
      title: 'Two'
    }
  ], { closureTokenFactory: sequentialTokens('prior') })
  const result = await reconcileOpenSurfaces({
    mode: 'worker-resume',
    session,
    durable: session,
    current: [currentOne],
    options: { closureTokenFactory: () => 'must-not-replace-survivor' }
  })

  assert.deepEqual(result.inferredClosures.map((entry) => entry.tabId), [2])
  assert.equal(result.inventory.entries['1']?.closureToken, 'prior-1')
  assert.equal(result.inventory.entries['2'], undefined)
})

test('extension reload falls back to durable inventory and preserves surviving tab lifetimes', async () => {
  const durable = await seedOpenSurfaceInventory([
    currentOne,
    {
      tabId: 2,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/two',
      title: 'Two'
    }
  ], { closureTokenFactory: sequentialTokens('durable') })
  const result = await reconcileOpenSurfaces({
    mode: 'extension-reload',
    session: null,
    durable,
    current: [currentOne],
    options: { closureTokenFactory: () => 'must-not-replace-survivor' }
  })

  assert.deepEqual(result.inferredClosures.map((entry) => entry.tabId), [2])
  assert.equal(result.inventory.entries['1']?.closureToken, 'durable-1')
})
