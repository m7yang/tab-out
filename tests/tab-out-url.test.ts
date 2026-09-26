import assert from 'node:assert/strict'
import test from 'node:test'

import { isTabOutDashboardUrl, isTabOutPageUrl, tabOutDashboardCanonicalUrl } from '../src/extension/tab-out-url.js'

function withExtensionId<T>(id: string | undefined, fn: () => T): T {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = id ? { runtime: { id } } : undefined
  try {
    return fn()
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
}

test('tabOutDashboardCanonicalUrl builds the index.html URL from the runtime id', () => {
  withExtensionId('tab-out', () => {
    assert.equal(tabOutDashboardCanonicalUrl(), 'chrome-extension://tab-out/index.html')
  })
})

test('tabOutDashboardCanonicalUrl is null without a runtime id', () => {
  withExtensionId(undefined, () => {
    assert.equal(tabOutDashboardCanonicalUrl(), null)
  })
})

test('isTabOutDashboardUrl matches the dashboard base and its search/hash variants', () => {
  withExtensionId('tab-out', () => {
    const base = 'chrome-extension://tab-out/index.html'
    assert.equal(isTabOutDashboardUrl(base), true)
    assert.equal(isTabOutDashboardUrl(`${base}?filter=github`), true)
    assert.equal(isTabOutDashboardUrl(`${base}?focusFilter=1`), true)
    assert.equal(isTabOutDashboardUrl(`${base}#section`), true)
  })
})

test('isTabOutDashboardUrl excludes chrome://newtab/ and unrelated pages', () => {
  withExtensionId('tab-out', () => {
    assert.equal(isTabOutDashboardUrl('chrome://newtab/'), false)
    assert.equal(isTabOutDashboardUrl('https://example.com/index.html'), false)
    assert.equal(isTabOutDashboardUrl('chrome-extension://tab-out/suspended.html'), false)
    assert.equal(isTabOutDashboardUrl(undefined), false)
  })
})

test('isTabOutDashboardUrl is false without a runtime id', () => {
  withExtensionId(undefined, () => {
    assert.equal(isTabOutDashboardUrl('chrome-extension://tab-out/index.html'), false)
  })
})

test('isTabOutPageUrl includes chrome://newtab/ as well as the dashboard', () => {
  withExtensionId('tab-out', () => {
    assert.equal(isTabOutPageUrl('chrome://newtab/'), true)
    assert.equal(isTabOutPageUrl('chrome://new-tab-page/'), true)
    assert.equal(isTabOutPageUrl('chrome-untrusted://new-tab-page/'), false)
    assert.equal(isTabOutPageUrl('chrome-extension://tab-out/index.html?filter=x'), true)
    assert.equal(isTabOutPageUrl('https://example.com/'), false)
  })
})

test('isTabOutPageUrl still recognizes chrome://newtab/ without a runtime id', () => {
  withExtensionId(undefined, () => {
    assert.equal(isTabOutPageUrl('chrome://newtab/'), true)
    assert.equal(isTabOutPageUrl('chrome://new-tab-page/'), true)
    assert.equal(isTabOutPageUrl('chrome-untrusted://new-tab-page/'), false)
    assert.equal(isTabOutPageUrl('chrome-extension://tab-out/index.html'), false)
  })
})
