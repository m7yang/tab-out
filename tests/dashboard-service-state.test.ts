import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeDashboardRetainedPagesWire } from '../src/extension/dashboard-retained-pages-wire.js'
import { fetchDashboardServiceStateResult } from '../src/extension/dashboard-service-state.js'

test('dashboard service state distinguishes a transport failure from valid empty state', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => {
        throw new Error('Service worker unavailable')
      }
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.value.tabHistory.entries, [])
  assert.deepEqual(result.value.workingSetActivity.records, {})
})

test('dashboard service state treats an explicit successful empty response as known state', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: [{ id: 1, windowId: 1, url: 'https://example.test/' }],
          windows: [{ id: 1, focused: true, type: 'normal' }]
        },
        tabHistory: { entries: [], maxSize: 48 },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, true)
  assert.equal(result.value.tabHistory.maxSize, 48)
  assert.equal(result.value.openTabsSnapshot?.tabs[0]?.id, 1)
  assert.equal(result.value.openTabsSnapshot?.tabs[0]?.active, false)
  assert.equal(result.value.openTabsSnapshot?.tabs[0]?.groupId, -1)
})

test('dashboard service state rejects malformed successful responses instead of clearing known state', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: true })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.value.tabHistory.entries, [])
  assert.deepEqual(result.value.workingSetActivity.records, {})
})

test('dashboard service state rejects otherwise-valid responses without an atomic open-tabs capture', async () => {
  for (const openTabsSnapshot of [undefined, { tabs: [] }, { windows: [] }]) {
    globalThis.chrome = {
      runtime: {
        sendMessage: async () => ({
          ok: true,
          openTabsSnapshot,
          tabHistory: { entries: [], maxSize: 48 },
          workingSetActivity: { version: 1, records: {} },
          retainedPages: await encodeDashboardRetainedPagesWire([]),
          retentionHealth: null
        })
      }
    } as unknown as typeof globalThis.chrome

    const result = await fetchDashboardServiceStateResult()
    assert.equal(result.ok, false)
    assert.equal(result.value.openTabsSnapshot, null)
  }
})

test('dashboard service state rejects malformed serialized browser rows', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: [{ id: 1, windowId: 'not-a-window', url: 'https://example.test/' }],
          windows: [{ id: 1, focused: true, type: 'normal' }]
        },
        tabHistory: { entries: [] },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: null
      })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.equal(result.value.openTabsSnapshot, null)
})

test('dashboard service state rejects a health record containing page metadata', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: { tabs: [], windows: [] },
        tabHistory: { entries: [] },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: await encodeDashboardRetainedPagesWire([]),
        retentionHealth: {
          failureKind: 'capture',
          operationKind: 'automatic-capture',
          retryState: 'exhausted-after-one-retry',
          startedAt: 100,
          lastFailedAt: 100,
          url: 'https://example.test/private'
        }
      })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.equal(result.value.retentionHealth, null)
})

test('dashboard service state rejects a corrupt retained projection as a whole response', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: { tabs: [], windows: [] },
        tabHistory: { entries: [] },
        workingSetActivity: { version: 1, records: {} },
        retainedPages: {
          schemaVersion: 1,
          identityVersion: 1,
          encoding: 'gzip-base64-json-v1',
          data: 'not-base64!'
        },
        retentionHealth: null
      })
    }
  } as unknown as typeof globalThis.chrome

  const result = await fetchDashboardServiceStateResult()

  assert.equal(result.ok, false)
  assert.equal(result.value.openTabsSnapshot, null)
  assert.deepEqual(result.value.retainedPages, [])
})
