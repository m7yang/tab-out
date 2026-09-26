import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOpenTabDedupePlan } from '../src/extension/open-tab-dedupe-plan.js'
import { TAB_OUT_FAVICON_URL } from '../src/extension/tab-out-url.js'

function tab(
  id: number,
  url: string,
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return {
    id,
    windowId: 1,
    url,
    active: id === 1,
    pinned: false,
    groupId: -1,
    index: id - 1,
    ...overrides,
  } as chrome.tabs.Tab
}

test('global dedupe plan counts only group-safe real-page close targets', () => {
  const duplicateUrl = 'https://duplicate.example.test/docs'
  const groupedUrl = 'https://grouped.example.test/docs'
  const mixedUrl = 'https://mixed.example.test/docs'
  const suspendedDuplicateUrl = `chrome-extension://suspender/suspended.html#uri=${encodeURIComponent(duplicateUrl)}`
  const plan = buildOpenTabDedupePlan([
    tab(1, duplicateUrl),
    tab(2, duplicateUrl),
    tab(3, suspendedDuplicateUrl),
    tab(4, groupedUrl, { groupId: 7 }),
    tab(5, groupedUrl, { groupId: 8 }),
    tab(6, mixedUrl, { groupId: 9 }),
    tab(7, mixedUrl),
    tab(8, 'chrome://settings/'),
    tab(9, 'chrome://settings/'),
  ], 1)

  assert.equal(plan.closableCount, 3)
  assert.deepEqual(plan.urls, [duplicateUrl, mixedUrl])
})

test('global dedupe plan shares Tab Out alias and current-page protection', () => {
  const previousChrome = globalThis.chrome
  ;(globalThis as { chrome: unknown }).chrome = { runtime: { id: 'tab-out' } }
  try {
    const canonicalUrl = 'chrome-extension://tab-out/index.html'
    const plan = buildOpenTabDedupePlan([
      tab(1, 'chrome://newtab/', { active: true, favIconUrl: TAB_OUT_FAVICON_URL }),
      tab(2, canonicalUrl, { active: false, pinned: true }),
      tab(3, `${canonicalUrl}?focusFilter=1`, { active: false }),
    ], 1)

    assert.equal(plan.closableCount, 1)
    assert.deepEqual(plan.urls, [canonicalUrl])
  } finally {
    ;(globalThis as { chrome: typeof chrome }).chrome = previousChrome
  }
})

test('native Chrome and Tab Out copies contribute separate duplicate counts', () => {
  const previousChrome = globalThis.chrome
  ;(globalThis as { chrome: unknown }).chrome = { runtime: { id: 'tab-out' } }
  try {
    const url = 'chrome://newtab/'
    const tabs = [
      tab(1, url, { favIconUrl: TAB_OUT_FAVICON_URL }),
      tab(2, url),
      tab(3, url, { favIconUrl: TAB_OUT_FAVICON_URL }),
      tab(4, url, { favIconUrl: TAB_OUT_FAVICON_URL }),
    ]
    assert.deepEqual(buildOpenTabDedupePlan(tabs, 1), {
      closableCount: 2,
      urls: ['chrome-extension://tab-out/index.html'],
    })
    assert.deepEqual(buildOpenTabDedupePlan([...tabs, tab(5, url)], 1), {
      closableCount: 3,
      urls: ['chrome-extension://tab-out/index.html', url],
    })
    assert.deepEqual(buildOpenTabDedupePlan([...tabs, tab(5, url, { status: 'loading' })], 1), {
      closableCount: 2,
      urls: ['chrome-extension://tab-out/index.html'],
    })
  } finally {
    ;(globalThis as { chrome: typeof chrome }).chrome = previousChrome
  }
})
