import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureOpenSurfaceCheckpoint,
  captureCurrentOpenSurfaceObservations,
  captureOpenSurfaceObservation,
  openSurfaceObservationFromTab
} from '../src/extension/background/open-surface-capture.js'

test('Chrome tab capture preserves app context and unwraps suspended metadata', () => {
  const exactUrl = 'https://example.test/article?view=notes#comment'
  const suspendedUrl = `chrome-extension://suspender-id/suspended.html#ttl=Example%20article&uri=${encodeURIComponent(exactUrl)}`
  const observation = openSurfaceObservationFromTab({
    id: 10,
    windowId: 2,
    index: 0,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    url: suspendedUrl,
    title: 'Suspender wrapper'
  }, 'app')

  assert.deepEqual(observation, {
    tabId: 10,
    surfaceKind: 'app',
    url: exactUrl,
    rawUrl: suspendedUrl,
    title: 'Example article'
  })
})

test('Chrome tab capture uses the pending navigation as the newest effective target', () => {
  const observation = openSurfaceObservationFromTab({
    id: 14,
    windowId: 2,
    index: 0,
    highlighted: false,
    active: true,
    pinned: false,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    url: 'https://example.test/original',
    pendingUrl: 'https://example.test/newest-target',
    title: 'Navigating'
  }, 'normal')

  assert.equal(observation?.url, 'https://example.test/newest-target')
})

test('Chrome tab capture rejects private surfaces before producing an observation', () => {
  assert.equal(openSurfaceObservationFromTab({
    id: 11,
    windowId: 2,
    index: 0,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: true,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    url: 'chrome-extension://suspender-id/suspended.html#uri=private-value',
    title: 'Private title'
  }, 'normal'), null)
})

test('Chrome tab capture does not guess a normal-tab identity when window type is unknown', async () => {
  const tab = {
    id: 12,
    windowId: 8,
    index: 0,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    url: 'https://example.test/app',
    title: 'Example app'
  } satisfies chrome.tabs.Tab

  assert.equal(openSurfaceObservationFromTab(tab), null)
  assert.equal(await captureOpenSurfaceObservation({
    windows: {
      get: async () => {
        throw new Error('window disappeared')
      }
    }
  } as never, tab), null)
})

test('checkpoint capture distinguishes a disappearing window from an ineligible surface', async () => {
  const tab = {
    id: 15,
    windowId: 8,
    index: 0,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    url: 'https://example.test/preserve-prior-lifetime',
    title: 'Preserve prior lifetime'
  } satisfies chrome.tabs.Tab

  const unavailable = await captureOpenSurfaceCheckpoint({
    windows: {
      get: async () => {
        throw new Error('window disappeared during physical close')
      }
    }
  } as never, tab)
  const ineligible = await captureOpenSurfaceCheckpoint({
    windows: {
      get: async () => ({ id: 8, type: 'normal' })
    }
  } as never, { ...tab, incognito: true })

  assert.deepEqual(unavailable, { status: 'unavailable' })
  assert.deepEqual(ineligible, { status: 'ineligible' })
})

test('current-surface capture omits tabs whose window metadata is missing', async () => {
  const observations = await captureCurrentOpenSurfaceObservations({
    tabs: {
      query: async () => [{
        id: 13,
        windowId: 9,
        index: 0,
        highlighted: false,
        active: false,
        pinned: false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        frozen: false,
        groupId: -1,
        url: 'https://example.test/unknown-window',
        title: 'Unknown window'
      }]
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }]
    }
  } as never)

  assert.deepEqual(observations, [])
})
