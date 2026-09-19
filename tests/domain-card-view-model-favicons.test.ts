import assert from 'node:assert/strict'
import test from 'node:test'

import { addSavedPageToStore, emptySavedPagesStore, mergeSavedPagesWithTabs } from '../src/extension/saved-pages.js'
import { dashboardChipFor, makeDashboardTab } from './helpers/domain-card-view-model.js'

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: { runtime: { getURL: (path: string) => `chrome-extension://testextensionid${path}` } },
})

const url = 'https://example.com/page'
const dataFavicon = 'data:image/png;base64,AAAA'

function assertPageCacheFavicon(faviconUrl: string | undefined) {
  assert.ok(faviconUrl)
  assert.equal(new URL(faviconUrl).pathname, '/_favicon/')
  assert.equal(new URL(faviconUrl).searchParams.get('pageUrl'), url)
}

test('saving and closing a suspended page does not reuse its pre-faded favicon', () => {
  const tab = makeDashboardTab({
    id: 1,
    url,
    rawUrl: `chrome-extension://suspender/suspended.html#ttl=Example&uri=${url}`,
    suspended: true,
    favIconUrl: dataFavicon,
  })
  const saved = addSavedPageToStore(emptySavedPagesStore(), tab, 100)
  const closed = mergeSavedPagesWithTabs([], saved, 200).tabs
  const chip = dashboardChipFor(closed, url)
  assert.equal(chip?.closedSaved, true)
  assertPageCacheFavicon(chip?.faviconUrl)
})

test('a retained snapshot with a pre-faded favicon resolves the original page icon', () => {
  const chip = dashboardChipFor([makeDashboardTab({
    id: 'retained:example',
    url,
    sourceType: 'retained-page',
    closedSaved: true,
    favIconUrl: dataFavicon,
  })], url)
  assert.equal(chip?.closedSaved, true)
  assertPageCacheFavicon(chip?.faviconUrl)
})

test('awake tabs and read-only sources preserve genuine data favicons', () => {
  for (const sourceType of ['tab', 'bookmark', 'history'] satisfies Array<'tab' | 'bookmark' | 'history'>) {
    const chip = dashboardChipFor([makeDashboardTab({ id: 1, url, sourceType, favIconUrl: dataFavicon })], url)
    assert.equal(chip?.faviconUrl, dataFavicon)
  }
})
