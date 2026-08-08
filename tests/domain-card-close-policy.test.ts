import assert from 'node:assert/strict'
import test from 'node:test'

import { domainCardCloseRemovesAllItems } from '../src/components/domain-card-close-policy.js'
import type { DashboardTab, DomainGroup } from '../src/extension/types.js'

function tab(id: number, overrides: Partial<DashboardTab> = {}): DashboardTab {
  const url = `https://example.test/${id}`
  return {
    id,
    url,
    rawUrl: url,
    suspended: false,
    title: `Example ${id}`,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...overrides
  }
}

function group(tabs: DashboardTab[]): DomainGroup {
  return { domain: 'example.test', tabs }
}

test('domain card removal animation never hides eligible tabs that settle into retained pages', () => {
  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 2,
    filter: '',
    group: group([tab(1), tab(2)]),
    removedCount: 2
  }), false)
  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 2,
    filter: '',
    group: group([tab(1), tab(2)]),
    removedCount: 1
  }), false)
  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 1,
    filter: '',
    group: group([tab(1), tab(2, { groupId: 4 })]),
    removedCount: 1
  }), false)

  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 1,
    filter: '',
    group: group([tab(1, { url: 'blob:https://example.test/temporary', rawUrl: 'blob:https://example.test/temporary' })]),
    removedCount: 1
  }), true)
})

test('domain card removal animation preserves filtered and Saved Page surfaces', () => {
  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 1,
    filter: 'example',
    group: group([tab(1)]),
    removedCount: 1
  }), false)
  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 1,
    filter: '',
    group: group([tab(1, { saved: true })]),
    removedCount: 1
  }), false)
  assert.equal(domainCardCloseRemovesAllItems({
    closableCount: 1,
    filter: '',
    group: group([
      tab(1),
      tab(2, { sourceType: 'saved-page', closedSaved: true, saved: true })
    ]),
    removedCount: 1
  }), false)
})
