import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel, dashboardChipOrderKeyForChip } from '../src/extension/domain-card-view-model.js'
import { buildDomainGroups } from '../src/extension/render.js'
import {
  createPinnedPageChipIndex,
  pageChipPinId,
  pageChipPinKeyForFoldUrls,
  pageChipPinKeyForUrl,
  pageChipPinScopeId
} from '../src/extension/page-chip-pins.js'
import type { DashboardTab } from '../src/extension/types'

;(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    getURL(path: string) {
      return `chrome-extension://tab-out${path}`
    }
  }
}

function makeTab(overrides: Partial<DashboardTab> & { url: string; id: number; title: string }): DashboardTab {
  return {
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    favIconUrl: overrides.favIconUrl || '',
    windowId: overrides.windowId || 1,
    active: overrides.active || false,
    pinned: overrides.pinned || false,
    groupId: overrides.groupId ?? -1,
    isTabOut: false,
    isApp: overrides.isApp || false,
    ...overrides
  }
}

function groupFor(domain: string, tabs: DashboardTab[]) {
  const group = buildDomainGroups(tabs).find((g) => g.domain === domain)
  assert.ok(group, `expected a domain group for ${domain}`)
  return group
}

test('computeDomainCardViewModel sorts pinned page chips first only inside their rendered flat scope', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Alpha', url: 'https://example.com/alpha' }),
    makeTab({ id: 2, title: 'Bravo', url: 'https://example.com/bravo' }),
    makeTab({ id: 3, title: 'Charlie', url: 'https://example.com/charlie' }),
    makeTab({ id: 4, title: 'Docs Alpha', url: 'https://example.com/docs/alpha' }),
    makeTab({ id: 5, title: 'Docs Bravo', url: 'https://example.com/docs/bravo' })
  ]
  const group = groupFor('example.com', tabs)
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const docsScope = pageChipPinScopeId('example.com', '', '/docs', '')
  const pinnedPageChips = createPinnedPageChipIndex([
    pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/charlie')),
    pageChipPinId('tabs', docsScope, pageChipPinKeyForUrl('https://example.com/docs/bravo'))
  ])

  const baseline = computeDomainCardViewModel(group, { source: 'tabs' })
  const baselineSection = baseline.sections?.find((section) => section.key === '')
  assert.ok(baselineSection)
  assert.deepEqual(
    baselineSection.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/alpha', 'https://example.com/bravo', 'https://example.com/charlie']
  )
  assert.deepEqual(
    baselineSection.websitePathSections[0]?.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/docs/alpha', 'https://example.com/docs/bravo']
  )

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const section = vm.sections?.find((section) => section.key === '')
  assert.ok(section)
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/charlie', 'https://example.com/alpha', 'https://example.com/bravo']
  )
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.pagePinned),
    [true, false, false]
  )
  assert.deepEqual(
    section.websitePathSections[0]?.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.com/docs/bravo', 'https://example.com/docs/alpha']
  )
  assert.deepEqual(
    section.websitePathSections[0]?.flatVisibleChips.map((chip) => chip.pagePinned),
    [true, false]
  )
})

test('computeDomainCardViewModel sorts pinned folded chips as aggregate rows', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Alpha Env', url: 'https://dev.example.com/alpha' }),
    makeTab({ id: 2, title: 'Alpha Env', url: 'https://qa.example.com/alpha' }),
    makeTab({ id: 3, title: 'Bravo Env', url: 'https://dev.example.com/bravo' }),
    makeTab({ id: 4, title: 'Bravo Env', url: 'https://qa.example.com/bravo' })
  ]
  const group = groupFor('example.com', tabs)
  const sharedScope = pageChipPinScopeId('example.com', '__shared__', '', '')
  const legacyBravoPinId = pageChipPinId(
    'tabs',
    sharedScope,
    `fold:${['https://dev.example.com/bravo', 'https://qa.example.com/bravo'].sort().join('\u0000')}`
  )
  const compactBravoPinId = pageChipPinId(
    'tabs',
    sharedScope,
    pageChipPinKeyForFoldUrls(['https://dev.example.com/bravo', 'https://qa.example.com/bravo'])
  )
  const pinnedPageChips = createPinnedPageChipIndex([
    legacyBravoPinId
  ])

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const sharedSection = vm.sections?.find((section) => section.key === '__shared__')
  assert.ok(sharedSection)
  assert.deepEqual(
    sharedSection.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://dev.example.com/bravo', 'https://dev.example.com/alpha']
  )
  assert.deepEqual(
    sharedSection.flatVisibleChips.map((chip) => chip.pagePinned),
    [true, false]
  )
  assert.equal(sharedSection.flatVisibleChips[0]?.pagePinId, compactBravoPinId)
})

test('folded chip remembered-order keys stay bounded to one representative URL', () => {
  const alpha = 'https://env-alpha.example.test/docs'
  const bravo = 'https://env-bravo.example.test/docs'
  const charlie = 'https://env-charlie.example.test/docs'

  function orderKey(urls: readonly string[]) {
    const first = urls[0] || ''
    return dashboardChipOrderKeyForChip({
      sourceType: 'retained-page',
      tabUrl: first,
      envs: urls.map((url) => ({ prefix: 'env', tabUrl: url, rawUrl: url }))
    })
  }

  const key = orderKey([bravo, alpha])

  assert.equal(key, `tab:fold:${alpha}`)
  assert.equal(key.includes(bravo), false)
  assert.equal(orderKey([alpha, charlie]), key)
  assert.equal(orderKey([charlie, bravo]), `tab:fold:${bravo}`)
  assert.equal(orderKey([alpha, bravo]), orderKey([bravo, alpha]))
})

test('computeDomainCardViewModel keeps pinned same-title URL variants inside one promoted group', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Example content item', url: 'https://example.com/alpha' }),
    makeTab({ id: 2, title: 'Example content item', url: 'https://example.com/bravo' }),
    makeTab({ id: 3, title: 'Example content item', url: 'https://example.com/charlie' }),
    makeTab({ id: 4, title: 'Settings', url: 'https://example.com/settings' })
  ]
  const group = groupFor('example.com', tabs)
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const alphaPinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/alpha'))
  const bravoPinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/bravo'))
  const charliePinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/charlie'))
  const pinnedPageChips = createPinnedPageChipIndex([bravoPinId])

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const section = vm.sections?.find((candidate) => candidate.key === '')
  assert.ok(section)
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.tabUrl),
    [
      'https://example.com/alpha',
      'https://example.com/settings'
    ]
  )

  const [variantGroup] = section.flatVisibleChips
  assert.ok(variantGroup)
  assert.equal(variantGroup.pagePinId, undefined)
  assert.equal(variantGroup.pagePinned, undefined)
  assert.deepEqual(
    variantGroup.titleVariantChips?.map((variant) => variant.tabUrl),
    [
      'https://example.com/bravo',
      'https://example.com/alpha',
      'https://example.com/charlie'
    ]
  )
  assert.deepEqual(
    variantGroup.titleVariantChips?.map((variant) => variant.pagePinId),
    [bravoPinId, alphaPinId, charliePinId]
  )
  assert.deepEqual(
    variantGroup.titleVariantChips?.map((variant) => variant.pagePinned),
    [true, false, false]
  )
})

test('computeDomainCardViewModel orders a unified same-title group by its earliest pinned variant', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Example content item', url: 'https://example.com/alpha' }),
    makeTab({ id: 2, title: 'Example content item', url: 'https://example.com/bravo' }),
    makeTab({ id: 3, title: 'Example content item', url: 'https://example.com/charlie' }),
    makeTab({ id: 4, title: 'Settings', url: 'https://example.com/settings' })
  ]
  const group = groupFor('example.com', tabs)
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const settingsPinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/settings'))
  const charliePinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/charlie'))
  const bravoPinId = pageChipPinId('tabs', rootScope, pageChipPinKeyForUrl('https://example.com/bravo'))
  const pinnedPageChips = createPinnedPageChipIndex([
    settingsPinId,
    charliePinId,
    bravoPinId
  ])

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const section = vm.sections?.find((candidate) => candidate.key === '')
  assert.ok(section)
  assert.deepEqual(
    section.flatVisibleChips.map((chip) => chip.tabUrl),
    [
      'https://example.com/settings',
      'https://example.com/alpha'
    ]
  )

  const variantGroup = section.flatVisibleChips[1]
  assert.ok(variantGroup)
  assert.deepEqual(
    variantGroup.titleVariantChips?.map((variant) => variant.tabUrl),
    [
      'https://example.com/charlie',
      'https://example.com/bravo',
      'https://example.com/alpha'
    ]
  )
  assert.deepEqual(
    variantGroup.titleVariantChips?.map((variant) => variant.pagePinned),
    [true, true, false]
  )
})

test('a pinned retained variant does not replace the live same-title group representative', () => {
  const tabs = [
    makeTab({ id: 1, title: 'Example content item', url: 'https://example.com/alpha' }),
    makeTab({
      id: 2,
      title: 'Example content item',
      url: 'https://example.com/bravo',
      sourceType: 'retained-page',
      closedSaved: true,
      retainedPageIdentity: 'identity-bravo',
      retainedPageClosureToken: 'lifetime-bravo'
    })
  ]
  const group = groupFor('example.com', tabs)
  const rootScope = pageChipPinScopeId('example.com', '', '', '')
  const retainedPinId = pageChipPinId(
    'tabs',
    rootScope,
    pageChipPinKeyForUrl('https://example.com/bravo')
  )
  const pinnedPageChips = createPinnedPageChipIndex([retainedPinId])

  const vm = computeDomainCardViewModel(group, { source: 'tabs', pinnedPageChips })
  const section = vm.sections?.find((candidate) => candidate.key === '')
  const variantGroup = section?.flatVisibleChips[0]
  assert.ok(variantGroup)

  assert.equal(variantGroup.tabUrl, 'https://example.com/alpha')
  assert.equal(variantGroup.sourceType, 'tab')
  assert.deepEqual(
    variantGroup.titleVariantChips?.map((variant) => ({
      pagePinned: variant.pagePinned,
      sourceType: variant.sourceType,
      tabUrl: variant.tabUrl
    })),
    [
      {
        pagePinned: true,
        sourceType: 'retained-page',
        tabUrl: 'https://example.com/bravo'
      },
      {
        pagePinned: false,
        sourceType: 'tab',
        tabUrl: 'https://example.com/alpha'
      }
    ]
  )
})
