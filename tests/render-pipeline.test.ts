import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { flattenBookmarkNodes } from '../src/extension/bookmarks.js'
import { domainCardId } from '../src/extension/domain-card-id.js'
import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_FILTER_OFF,
  HISTORY_RANGE_OPTIONS,
  deleteHistorySourceUrl,
  fetchHistorySourceSearch,
  flattenHistoryItems,
  isHistoryFilterEnabled
} from '../src/extension/history-source.js'
import { filterInputFromSearch, isFilterFocusShortcut, titleForFilterInput, urlForFilterInput } from '../src/extension/app-url.js'
import { readFilterFocusPendingInput, releaseFilterFocusBootValue } from '../src/extension/filter-focus-buffer.js'
import { buildFilterSearchRequest, canDisplayHistorySearchResults, canUseHistorySearchResults, dashboardNeedsFilterSearchRefresh, isHistorySearchRequestSettled } from '../src/extension/filter-search.js'
import { parseFilterQuery } from '../src/extension/filter-query.js'
import { fetchDashboardData } from '../src/extension/dashboard-data-fetch.js'
import { buildDashboardDataFromTabs, buildDashboardViewModel, buildDomainGroups, computeDomainCardViewModel, dashboardChipOrderKeyForTab, tabMatchesFilter } from '../src/extension/render.js'
import { addSavedPageToStore, emptySavedPagesStore, SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import { installWebLocksStub } from './helpers/web-locks.js'
import { useDashboardViewModels } from '../src/hooks/useDashboardViewModels.js'
import { retainHistorySearchResultsOnError } from '../src/extension/dashboard-intake.js'
import { historySearchStatusCopy } from '../src/components/history-search-status-copy.js'
import { normalizeTabHistorySnapshot } from '../src/extension/tab-history.js'
import { resolveWebsitePathSection } from '../src/extension/website-path-sections.js'
import { RETAINED_PAGE_LIFETIME_MS, type RetainedPageRecord } from '../src/extension/retained-pages-ledger.js'
import type { DashboardCardVM, DashboardChipData, DashboardTab } from '../src/extension/types'

(globalThis as any).chrome = {
  runtime: {
    getURL(path: string) {
      return `chrome-extension://tab-out${path}`
    }
  }
};

function expectDefined<T>(value: T | null | undefined, message = 'Expected a defined value'): T {
  assert.ok(value !== null && value !== undefined, message)
  return value
}

function atOrThrow<T>(items: readonly T[], index: number, message = `Expected item at index ${index}`): T {
  return expectDefined(items[index], message)
}

function sectionsOf(vm: DashboardCardVM) {
  assert.equal(vm.isHidden, false, 'Expected a visible dashboard card')
  return expectDefined(vm.sections, 'Expected visible dashboard card sections')
}

function firstSection(vm: DashboardCardVM) {
  return atOrThrow(sectionsOf(vm), 0, 'Expected a first dashboard card section')
}

function makeTab(overrides: Partial<DashboardTab> & { url: string }): DashboardTab {
  const tab: DashboardTab = {
    id: overrides.id ?? 1,
    url: overrides.url,
    rawUrl: overrides.rawUrl ?? overrides.url,
    suspended: overrides.suspended ?? false,
    title: overrides.title ?? '',
    favIconUrl: overrides.favIconUrl ?? '',
    windowId: overrides.windowId ?? 1,
    active: overrides.active ?? false,
    pinned: overrides.pinned ?? false,
    groupId: overrides.groupId ?? -1,
    isTabOut: overrides.isTabOut ?? false,
    isApp: overrides.isApp ?? false
  }

  if (overrides.status !== undefined) tab.status = overrides.status
  if (overrides.retainedSuspendedTitle !== undefined) tab.retainedSuspendedTitle = overrides.retainedSuspendedTitle
  if (overrides.audible !== undefined) tab.audible = overrides.audible
  if (overrides.muted !== undefined) tab.muted = overrides.muted
  if (overrides.sourceType !== undefined) tab.sourceType = overrides.sourceType
  if (overrides.saved !== undefined) tab.saved = overrides.saved
  if (overrides.closedSaved !== undefined) tab.closedSaved = overrides.closedSaved
  if (overrides.savedPageKey !== undefined) tab.savedPageKey = overrides.savedPageKey
  if (overrides.index !== undefined) tab.index = overrides.index

  return tab
}

test('buildDomainGroups keeps homepage routes inside their native domain cards', () => {
  const tabs = [
    makeTab({ url: 'https://github.com/', title: 'GitHub' }),
    makeTab({ id: 2, url: 'https://github.com/openai/openai', title: 'openai/openai' })
  ]

  const groups = buildDomainGroups(tabs)

  const githubGroup = groups.find((group) => group.domain === 'github.com')
  assert.ok(githubGroup)
  assert.deepEqual(githubGroup.tabs.map((tab) => tab.url), ['https://github.com/', 'https://github.com/openai/openai'])
})

test('computeDomainCardViewModel preserves title suffixes for hostless file URLs', () => {
  const vm = computeDomainCardViewModel({
    domain: 'local-files',
    tabs: [makeTab({
      url: 'file:///Users/example/Example%20Document.txt',
      title: 'Example Document - Local Files'
    })]
  })
  const chip = atOrThrow(firstSection(vm).flatVisibleChips, 0)

  assert.deepEqual(chip.displaySegments, ['Example Document - Local Files'])
  assert.deepEqual(chip.suppressedTitleParts, [])
})

test('buildDomainGroups keeps eligible hostless pages visible and places view-source with its target host', () => {
  const groups = buildDomainGroups([
    makeTab({
      id: 'view-source',
      url: 'view-source:https://example.test/article',
      title: 'Source of Example article',
      sourceType: 'retained-page',
      closedSaved: true
    }),
    makeTab({
      id: 'mailto',
      url: 'mailto:person@example.test',
      title: 'Email person',
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true
    })
  ])

  assert.deepEqual(groups.map(({ domain, label }) => ({ domain, label })), [
    { domain: 'example.test', label: undefined },
    { domain: '__hostless-pages__', label: 'Other pages' }
  ])
  assert.equal(groups.flatMap((group) => group.tabs).length, 2)
})

test('buildDomainGroups orders normal domain cards by tab count', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://github.com/', title: 'GitHub' }),
    makeTab({ id: 2, url: 'https://github.com/openai/openai', title: 'openai/openai' }),
    makeTab({ id: 3, url: 'https://openai.com/research', title: 'Research' }),
    makeTab({ id: 4, url: 'https://openai.com/api', title: 'API' })
  ])

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['github.com', 'openai.com']
  )
})

test('buildDashboardDataFromTabs builds dashboard data from an injected open-tab snapshot', async () => {
  const retainedPage: RetainedPageRecord = {
    identityDigest: 'retained-docs',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.com/docs',
    url: 'https://example.com/docs',
    title: 'Retained Docs',
    closedAt: 1,
    closureToken: 'retained-docs-closure'
  }
  const { dashboard } = await buildDashboardDataFromTabs(
    [
      makeTab({ url: 'https://example.com/docs', title: 'Docs' }),
      makeTab({ id: 2, url: 'https://example.test/app', title: 'App' })
    ],
    1,
    new Map(),
    { retainedPages: [retainedPage], now: 1_000 }
  )

  assert.deepEqual(dashboard.realTabs.map((tab) => tab.url), ['https://example.com/docs', 'https://example.test/app'])
  assert.deepEqual(dashboard.domainGroups.map((group) => group.domain), ['example.com', 'example.test'])
  assert.equal(dashboard.currentWindowId, 1)
  assert.equal(dashboard.bookmarkSearchReady, false)
  assert.equal(dashboard.historySearchQuery, '')
  assert.deepEqual(dashboard.retainedPageSurfaceMatches, [{
    canonicalKey: retainedPage.canonicalKey,
    surfaceKind: retainedPage.surfaceKind
  }])
})

test('expired retention cannot infer an app surface for Activation History', async () => {
  const now = 10_000
  const expiredAppPage: RetainedPageRecord = {
    identityDigest: 'retained-expired-app',
    surfaceKind: 'app',
    canonicalKey: 'https://example.test/app',
    url: 'https://example.test/app',
    title: 'Expired app',
    closedAt: now - RETAINED_PAGE_LIFETIME_MS,
    closureToken: 'retained-expired-app-closure'
  }

  const { dashboard } = await buildDashboardDataFromTabs([], null, new Map(), {
    retainedPages: [expiredAppPage],
    now
  })

  assert.deepEqual(dashboard.realTabs, [])
  assert.deepEqual(dashboard.retainedPageSurfaceMatches, [])
})

test('buildDomainGroups puts pinned domain cards above higher-count normal cards', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://github.com/', title: 'GitHub' }),
      makeTab({ id: 2, url: 'https://github.com/openai/openai', title: 'openai/openai' }),
      makeTab({ id: 3, url: 'https://openai.com/research', title: 'Research' })
    ],
    { pinnedDomains: ['openai.com'] }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['openai.com', 'github.com']
  )
  assert.deepEqual(groups.map((group) => group.pinned), [true, false])
})

test('buildDomainGroups keeps saved pin order ahead of previous card order', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://github.com/', title: 'GitHub' }),
      makeTab({ id: 2, url: 'https://openai.com/research', title: 'Research' }),
      makeTab({ id: 3, url: 'https://example.com/docs', title: 'Docs' })
    ],
    {
      pinnedDomains: ['example.com', 'openai.com'],
      previousOrder: new Map([
        ['domain-github.com', 0],
        ['domain-openai.com', 1],
        ['domain-example.com', 2]
      ])
    }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['example.com', 'openai.com', 'github.com']
  )
})

test('domainCardId is the shared identity for card order and DOM hooks', () => {
  assert.equal(domainCardId('github.com'), 'domain-github.com')
  assert.equal(domainCardId('__tab-out__'), 'domain-__tab-out__')
})

test('buildDomainGroups leaves utility cards unpinned by default', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://openai.com/research', title: 'Research' }),
      makeTab({ id: 2, url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', isApp: true }),
      makeTab({ id: 3, url: 'chrome-extension://tab-out/index.html', rawUrl: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true })
    ],
    { pinnedDomains: ['openai.com'] }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['openai.com', '__tab-out__', '__standalone-apps__']
  )
  assert.equal(groups.find((group) => group.domain === '__tab-out__')?.pinned, false)
  assert.equal(groups.find((group) => group.domain === '__standalone-apps__')?.pinned, false)
})

test('buildDomainGroups lets utility cards be explicitly pinned', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ url: 'https://openai.com/research', title: 'Research' }),
      makeTab({ id: 2, url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', isApp: true }),
      makeTab({ id: 3, url: 'chrome-extension://tab-out/index.html', rawUrl: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true })
    ],
    { pinnedDomains: ['__standalone-apps__', '__tab-out__'] }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['__standalone-apps__', '__tab-out__', 'openai.com']
  )
  assert.deepEqual(groups.map((group) => group.pinned), [true, true, false])
})

test('buildDomainGroups collects standalone app tabs into a dedicated apps card', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', active: true, isApp: true, windowId: 2 }),
    makeTab({ id: 2, url: 'https://calendar.google.com/calendar/u/0/r', title: 'Calendar', active: true, isApp: true, windowId: 3 }),
    makeTab({ id: 3, url: 'https://github.com/openai/openai', title: 'openai/openai' })
  ])

  const appsGroup = groups.find((group) => group.domain === '__standalone-apps__')
  assert.ok(appsGroup)
  assert.equal(appsGroup.label, 'Apps')
  assert.deepEqual(
    appsGroup.tabs.map((tab) => tab.url),
    ['https://mail.google.com/mail/u/0/', 'https://calendar.google.com/calendar/u/0/r']
  )

  const appsVm = computeDomainCardViewModel(appsGroup, { currentWindowId: 1 })
  assert.equal(appsVm.displayName, 'Apps')
  assert.equal(appsVm.tabCountLabel, '2')
  assert.equal(appsVm.tabCountTitle, '2 open tabs')
  assert.equal(firstSection(appsVm).flatVisibleChips.every((chip) => !chip.iconOnly), true)
  assert.deepEqual(firstSection(appsVm).flatVisibleChips.map((chip) => chip.title), ['Calendar', 'Inbox'])
  assert.equal(firstSection(appsVm).flatVisibleChips.every((chip) => !chip.activeInOtherWindow), true)

  const filteredAppsVm = computeDomainCardViewModel(appsGroup, { filter: 'inbox' })
  assert.equal(filteredAppsVm.isHidden, true)

  const unmatchedAppsVm = computeDomainCardViewModel(appsGroup, { filter: 'inbox', mode: 'unmatched' })
  assert.equal(unmatchedAppsVm.isHidden, true)

  const filteredVm = buildDashboardViewModel({
    realTabs: groups.flatMap((group) => group.tabs),
    domainGroups: groups,
    filter: 'inbox'
  })
  assert.equal(filteredVm.stats.visibleTabs, 0)
  assert.equal(filteredVm.matchedCards.some(({ group }) => group.domain === '__standalone-apps__'), false)
  assert.equal(filteredVm.unmatchedCards.some(({ group }) => group.domain === '__standalone-apps__'), false)
  assert.deepEqual(filteredVm.filteredCloseUrls, [])
})

test('closed standalone-app pages remain filterable while open apps stay outside filter results', () => {
  const groups = buildDomainGroups([
    makeTab({
      id: 1,
      url: 'https://mail.example.test/inbox',
      title: 'Open inbox',
      isApp: true,
      windowId: 2
    }),
    makeTab({
      id: 'retained-app',
      url: 'https://notes.example.test/reference',
      title: 'Closed reference',
      isApp: true,
      sourceType: 'retained-page',
      closedSaved: true,
      retainedPageIdentity: 'identity-retained-app',
      retainedPageClosureToken: 'lifetime-retained-app'
    })
  ])
  const appsGroup = groups.find((group) => group.domain === '__standalone-apps__')
  assert.ok(appsGroup)

  const matchingClosed = computeDomainCardViewModel(appsGroup, { filter: 'reference' })
  assert.equal(matchingClosed.isHidden, false)
  assert.equal(matchingClosed.tabCountLabel, '1 closed')
  assert.deepEqual(
    firstSection(matchingClosed).flatVisibleChips.map((chip) => chip.sourceType),
    ['retained-page']
  )

  const matchingOpen = computeDomainCardViewModel(appsGroup, { filter: 'inbox' })
  assert.equal(matchingOpen.isHidden, true)
})

test('standalone-app cards use ordinary Page Chip overflow presentation', () => {
  const group = buildDomainGroups(Array.from({ length: 7 }, (_, index) => makeTab({
    id: index + 1,
    url: `https://app-${index}.example.test/`,
    title: `App ${index}`,
    isApp: true,
    windowId: index + 2
  }))).find((candidate) => candidate.domain === '__standalone-apps__')
  assert.ok(group)

  const vm = computeDomainCardViewModel(group)
  assert.equal(firstSection(vm).flatVisibleChips.length, 5)
  assert.equal(firstSection(vm).flatHiddenChips.length, 2)
  assert.equal(firstSection(vm).flatHiddenCount, 2)
})

test('buildDomainGroups collects Tab Out pages into a dedicated new tabs card', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'chrome-extension://tab-out/index.html', rawUrl: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true }),
    makeTab({ id: 2, url: 'chrome://newtab/', rawUrl: 'chrome://newtab/', title: 'New Tab', isTabOut: true }),
    makeTab({
      id: 3,
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      rawUrl: 'chrome-extension://tab-out/index.html?focusFilter=1',
      title: 'Tab Out',
      isTabOut: true
    }),
    makeTab({ id: 4, url: 'https://openai.com/', title: 'OpenAI' })
  ])

  const newTabsGroup = groups.find((group) => group.domain === '__tab-out__')
  assert.ok(newTabsGroup)
  assert.equal(newTabsGroup.label, 'New tabs')
  assert.deepEqual(
    newTabsGroup.tabs.map((tab) => tab.rawUrl),
    ['chrome-extension://tab-out/index.html', 'chrome://newtab/', 'chrome-extension://tab-out/index.html?focusFilter=1']
  )
})

test('computeDomainCardViewModel keeps pinned new tabs out of close and dedupe counts', () => {
  const group = {
    domain: '__tab-out__',
    label: 'New tabs',
    tabs: [
      makeTab({
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        isTabOut: true,
        pinned: true
      }),
      makeTab({
        id: 2,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        isTabOut: true
      }),
      makeTab({
        id: 3,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        isTabOut: true
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.displayName, 'New tabs')
  assert.equal(vm.closableCount, 2)
  assert.equal(vm.suspendableCount, 2)
  assert.equal(vm.suspendableCountLabel, 'Suspend 2 ungrouped tabs')
  assert.equal(vm.closableSuspendedCount, 0)
  assert.equal(vm.closableSuspendedCountLabel, 'Close 0 suspended ungrouped tabs')
  assert.equal(vm.closableExtras, 2)
})

test('computeDomainCardViewModel labels card-level suspend for live tabs only', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/a', title: 'Alpha' }),
      makeTab({ id: 2, url: 'https://example.com/b', title: 'Bravo' }),
      makeTab({
        id: 3,
        url: 'https://example.com/c',
        rawUrl: 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fc',
        suspended: true,
        title: 'Charlie'
      }),
      makeTab({ id: 4, url: 'https://example.com/d', title: 'Delta', groupId: 7 })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.closableCount, 3)
  assert.equal(vm.closableCountLabel, 'Close 3 ungrouped tabs')
  assert.equal(vm.suspendableCount, 2)
  assert.equal(vm.suspendableCountLabel, 'Suspend 2 ungrouped tabs')
  assert.equal(vm.closableSuspendedCount, 1)
  assert.equal(vm.closableSuspendedCountLabel, 'Close 1 suspended ungrouped tab')
})

test('computeDomainCardViewModel labels closing every suspended tab in a card', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({
        url: 'https://example.com/a',
        rawUrl: 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fa',
        suspended: true,
        title: 'Alpha'
      }),
      makeTab({
        id: 2,
        url: 'https://example.com/b',
        rawUrl: 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fb',
        suspended: true,
        title: 'Bravo'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.closableSuspendedCount, 2)
  assert.equal(vm.closableSuspendedCountLabel, 'Close all 2 suspended tabs')
})

test('computeDomainCardViewModel excludes the current Tab Out page from pinned dedupe counts', () => {
  const group = {
    domain: '__tab-out__',
    label: 'New tabs',
    tabs: [
      makeTab({
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        active: true,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 2,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        pinned: true,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 3,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        windowId: 1,
        isTabOut: true
      })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.equal(vm.closableExtras, 1)
})

test('computeDomainCardViewModel excludes the current Tab Out page from grouped dedupe counts', () => {
  const group = {
    domain: '__tab-out__',
    label: 'New tabs',
    tabs: [
      makeTab({
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        active: true,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 2,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        groupId: 7,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 3,
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        windowId: 1,
        isTabOut: true
      })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.equal(vm.closableExtras, 1)
})

test('computeDomainCardViewModel splits duplicate Tab Out pages by preserved Chrome state', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const group = {
    domain: '__tab-out__',
    label: 'New tabs',
    tabs: [
      makeTab({
        id: 1,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        active: true,
        pinned: true,
        groupId: 7,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 2,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        pinned: true,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 3,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        groupId: 7,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 4,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        groupId: 7,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 5,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        groupId: 8,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 6,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 7,
        url: tabOutUrl,
        rawUrl: tabOutUrl,
        title: 'Tab Out',
        windowId: 1,
        isTabOut: true
      })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const chips = firstSection(vm).flatVisibleChips

  assert.equal(vm.closableExtras, 2)
  assert.deepEqual(chips.map((chip) => chip.tabId), [1, 2, 3, 5, 6])
  assert.deepEqual(chips.map((chip) => chip.dupeCount), [1, 1, 2, 1, 2])
  assert.deepEqual(chips.map((chip) => !!chip.isCurrentTabOut), [true, false, false, false, false])
  assert.deepEqual(chips.map((chip) => !!chip.chromePinned), [true, true, false, false, false])
  assert.deepEqual(chips.map((chip) => !!chip.isGrouped), [true, false, true, true, false])
  assert.deepEqual(chips.map((chip) => chip.pagePinId), [undefined, undefined, undefined, undefined, undefined])
})

test('computeDomainCardViewModel groups same-title URL variants in one rendered section', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/team/dashboard', title: 'Dashboard' }),
      makeTab({ id: 2, url: 'https://example.com/me/dashboard', title: 'Dashboard' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.equal(vm.isHidden, false)

  const chips = firstSection(vm).flatVisibleChips
  assert.equal(chips.length, 1)
  const chip = atOrThrow(chips, 0)
  assert.equal(chip.pathSuffix, '')
  assert.deepEqual(new Set(chip.titleVariantChips?.map((variant) => variant.pathSuffix)), new Set(['/me', '/team']))
})

test('computeDomainCardViewModel uses query crumbs for same-title URL variants on the same path', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/content/item?search_id=alpha', title: 'Example content item' }),
      makeTab({ id: 2, url: 'https://example.com/content/item?search_id=bravo', title: 'Example content item' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = firstSection(vm).flatVisibleChips

  assert.equal(chips.length, 1)
  assert.deepEqual(atOrThrow(chips, 0).titleVariantChips?.map((chip) => chip.pathSuffix), ['…?search_id=alpha', '…?search_id=bravo'])
})

test('computeDomainCardViewModel keeps same-title URL variant labels unique when paths only differ by trailing slash', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({ url: 'https://example.atlassian.net/jira/your-work', title: '[CO] Work item search - JIRA' }),
      makeTab({ id: 2, url: 'https://example.atlassian.net/jira/your-work/', title: '[CO] Work item search - JIRA' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = firstSection(vm).flatVisibleChips

  assert.equal(chips.length, 1)
  assert.deepEqual(atOrThrow(chips, 0).titleVariantChips?.map((chip) => chip.pathSuffix), ['/jira/your-work', '/jira/your-work/'])
})

test('computeDomainCardViewModel keeps saved state scoped to same-title URL variants', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({
        url: 'https://example.com/content/item?search_id=alpha',
        title: 'Example content item',
        saved: true,
        savedPageKey: 'https://example.com/content/item?search_id=alpha'
      }),
      makeTab({ id: 2, url: 'https://example.com/content/item?search_id=bravo', title: 'Example content item' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chip = atOrThrow(firstSection(vm).flatVisibleChips, 0)
  const variants = chip.titleVariantChips || []

  assert.equal(chip.saved, false)
  assert.equal(chip.savedPageKey, undefined)
  assert.equal(variants.find((variant) => variant.tabUrl.endsWith('search_id=alpha'))?.saved, true)
  assert.equal(variants.find((variant) => variant.tabUrl.endsWith('search_id=bravo'))?.saved, false)
})

test('same-title groups use a live state representative when remembered order puts a closed page first', () => {
  const tabs = [
    makeTab({
      id: 'saved-first',
      url: 'https://example.com/reference?kind=saved',
      title: 'Shared title',
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true
    }),
    makeTab({
      id: 42,
      url: 'https://example.com/reference?kind=open',
      title: 'Shared title',
      sourceType: 'tab',
      active: true
    })
  ]
  const group = atOrThrow(buildDomainGroups(tabs), 0)
  const chip = atOrThrow(firstSection(computeDomainCardViewModel(group, {
    chipOrder: new Map([
      [dashboardChipOrderKeyForTab(atOrThrow(tabs, 0)), 0],
      [dashboardChipOrderKeyForTab(atOrThrow(tabs, 1)), 1]
    ])
  })).flatVisibleChips, 0)

  assert.equal(chip.sourceType, 'tab')
  assert.equal(chip.tabId, 42)
  assert.equal(chip.closedSaved, false)
  assert.equal(chip.activeChipFrame, true)
  assert.equal(chip.titleVariantChips?.[0]?.sourceType, 'saved-page')
})

test('closed-page chips keep raw snapshot metadata separate from display title and favicon transforms', () => {
  const rawFavicon = 'https://example.com/static/favicon.ico'
  const tab = makeTab({
    id: 'retained',
    url: 'https://example.com/reference',
    title: 'Example reference - Example Workspace',
    favIconUrl: rawFavicon,
    sourceType: 'retained-page',
    closedSaved: true
  })
  const chip = atOrThrow(firstSection(computeDomainCardViewModel({
    domain: 'example.com',
    tabs: [tab]
  })).flatVisibleChips, 0)

  assert.equal(chip.actionTitle, tab.title)
  assert.equal(chip.actionFaviconUrl, rawFavicon)
  assert.equal(chip.faviconUrl.includes('/_favicon/'), true)
})

test('computeDomainCardViewModel inlines title suppression when same-title URL variants are the only occurrence', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/content/item?search_id=alpha', title: 'Example content item - Example Workspace' }),
      makeTab({ id: 2, url: 'https://example.com/content/item?search_id=bravo', title: 'Example content item - Example Workspace' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = firstSection(vm).flatVisibleChips

  assert.deepEqual(vm.allSuppressedTitleParts, [])
  assert.deepEqual(firstSection(vm).suppressedTitleParts, [])
  assert.equal(chips.length, 1)
  const chip = atOrThrow(chips, 0)
  assert.deepEqual(chip.displaySegments, ['Example content item - Example Workspace'])
  assert.deepEqual(chip.suppressedTitleParts, [])
  assert.deepEqual(chip.titleVariantChips?.map((variant) => variant.suppressedTitleParts), [[], []])
  assert.deepEqual(chip.titleVariantChips?.map((variant) => variant.displaySegments), [
    ['Example content item - Example Workspace'],
    ['Example content item - Example Workspace']
  ])
})

test('computeDomainCardViewModel counts same-title URL variants as one title suppression occurrence', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/content/item?search_id=alpha', title: 'Example content item - Example Workspace' }),
      makeTab({ id: 2, url: 'https://example.com/content/item?search_id=bravo', title: 'Example content item - Example Workspace' }),
      makeTab({ id: 3, url: 'https://example.com/settings', title: 'Settings - Example Workspace' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const section = firstSection(vm)
  const mergedChip = section.websitePathSections?.[0]?.flatVisibleChips.find((chip) => chip.titleVariantChips)
  const settingsChip = section.flatVisibleChips.find((chip) => chip.tabUrl === 'https://example.com/settings')

  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- Example Workspace', count: 2 }])
  assert.deepEqual(section.suppressedTitleParts, [{ text: '- Example Workspace', count: 2 }])
  assert.ok(mergedChip)
  assert.ok(settingsChip)
  assert.deepEqual(mergedChip.suppressedTitleParts, ['- Example Workspace'])
  assert.deepEqual(settingsChip.suppressedTitleParts, ['- Example Workspace'])
  assert.equal(mergedChip.titleVariantChips?.length, 2)
})

test('computeDomainCardViewModel maps a suppression token to exact closeable and suspendable tabs', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/content/item?search_id=alpha', title: 'Example content item - Example Workspace' }),
      makeTab({ id: 2, url: 'https://example.com/content/item?search_id=bravo', title: 'Example content item - Example Workspace' }),
      makeTab({ id: 3, url: 'https://example.com/settings', title: 'Settings - Example Workspace', suspended: true })
    ]
  }

  const vm = computeDomainCardViewModel(group)

  // The token's display count is 2 titles, but it maps to 3 closable tabs.
  assert.equal(sectionsOf(vm)?.[0]?.suppressedTitleParts?.[0]?.count, 2)
  assert.deepEqual(vm.suppressionCloseTargetsByText, {
    '- example workspace': [
      { tabId: 1, tabUrl: 'https://example.com/content/item?search_id=alpha' },
      { tabId: 2, tabUrl: 'https://example.com/content/item?search_id=bravo' },
      { tabId: 3, tabUrl: 'https://example.com/settings' }
    ]
  })
  assert.deepEqual(vm.suppressionSuspendTargetsByText, {
    '- example workspace': [
      { tabId: 1, tabUrl: 'https://example.com/content/item?search_id=alpha' },
      { tabId: 2, tabUrl: 'https://example.com/content/item?search_id=bravo' }
    ]
  })
})

test('suppression token actions exclude a same-URL duplicate whose own title lacks the token', () => {
  const sharedUrl = 'https://example.com/shared'
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ id: 1, url: sharedUrl, title: 'Alpha - Example Workspace' }),
      makeTab({ id: 2, url: sharedUrl, title: 'Unrelated' }),
      makeTab({ id: 3, url: 'https://example.com/other', title: 'Gamma - Example Workspace' })
    ]
  }

  const vm = computeDomainCardViewModel(group)

  assert.deepEqual(vm.suppressionCloseTargetsByText, {
    '- example workspace': [
      { tabId: 1, tabUrl: sharedUrl },
      { tabId: 3, tabUrl: 'https://example.com/other' }
    ]
  })
})

test('suppression token action target maps exclude grouped tabs and are empty when mutations are disallowed', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/a', title: 'Alpha - Example Workspace' }),
      makeTab({ id: 2, url: 'https://example.com/b', title: 'Bravo - Example Workspace' }),
      makeTab({ id: 3, url: 'https://example.com/c', title: 'Charlie - Example Workspace', groupId: 7 })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  assert.deepEqual(vm.suppressionCloseTargetsByText, {
    '- example workspace': [
      { tabId: 1, tabUrl: 'https://example.com/a' },
      { tabId: 2, tabUrl: 'https://example.com/b' }
    ]
  })
  assert.deepEqual(vm.suppressionSuspendTargetsByText, {
    '- example workspace': [
      { tabId: 1, tabUrl: 'https://example.com/a' },
      { tabId: 2, tabUrl: 'https://example.com/b' }
    ]
  })

  const readOnlyVm = computeDomainCardViewModel(group, { allowMutations: false })
  assert.deepEqual(readOnlyVm.suppressionCloseTargetsByText, {})
  assert.deepEqual(readOnlyVm.suppressionSuspendTargetsByText, {})
})

test('computeDomainCardViewModel skips path suffixes for duplicate titles in different rendered path groups', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({ url: 'https://example.atlassian.net/browse/APP-1001', title: 'Example task' }),
      makeTab({ id: 2, url: 'https://example.atlassian.net/browse/DOC-2001', title: 'Example task' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const clusters = firstSection(vm).clusters

  assert.deepEqual(clusters.map((cluster) => cluster.label), ['APP', 'DOC'])
  assert.deepEqual(clusters.flatMap((cluster) => cluster.visibleChips.map((chip) => chip.pathSuffix)), ['', ''])
})

test('computeDomainCardViewModel groups duplicate titles inside the same rendered path group', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({ url: 'https://example.atlassian.net/browse/APP-1001', title: 'Example task' }),
      makeTab({ id: 2, url: 'https://example.atlassian.net/browse/APP-1002', title: 'Example task' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = atOrThrow(firstSection(vm).clusters, 0).visibleChips

  assert.equal(chips.length, 1)
  const chip = atOrThrow(chips, 0)
  assert.equal(chip.pathSuffix, '')
  assert.deepEqual(chip.titleVariantChips?.map((variant) => variant.pathSuffix), ['…/APP-1001', '…/APP-1002'])
})

test('computeDomainCardViewModel hides repeated trailing title suffixes in normal mode', () => {
  const group = {
    domain: 'slack.com',
    tabs: [
      makeTab({ url: 'https://app.slack.com/client/T123/C123', title: 'Alpha channel - Example Workspace - Slack' }),
      makeTab({ id: 2, url: 'https://app.slack.com/client/T123/C456', title: 'Beta channel - Example Workspace - Slack' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = firstSection(vm).flatVisibleChips
  const titles = chips.map((chip) => chip.displaySegments.filter((seg) => typeof seg === 'string').join(''))

  assert.deepEqual(titles, ['Alpha channel', 'Beta channel'])
  assert.deepEqual(chips.map((chip) => chip.suppressedTitleParts), [['- Example Workspace - Slack'], ['- Example Workspace - Slack']])
  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- Example Workspace - Slack', count: 2 }])
  assert.deepEqual(firstSection(vm).suppressedTitleParts, [{ text: '- Example Workspace - Slack', count: 2 }])
})

test('computeDomainCardViewModel keeps repeated title suffixes visible while filtering', () => {
  const group = {
    domain: 'slack.com',
    tabs: [
      makeTab({ url: 'https://app.slack.com/client/T123/C123', title: 'Alpha channel - Example Workspace - Slack' }),
      makeTab({ id: 2, url: 'https://app.slack.com/client/T123/C456', title: 'Beta channel - Example Workspace - Slack' })
    ]
  }

  const vm = computeDomainCardViewModel(group, { filter: 'workspace' })
  const chips = firstSection(vm).flatVisibleChips
  const titles = chips.map((chip) => chip.displaySegments.filter((seg) => typeof seg === 'string').join(''))

  assert.deepEqual(titles, ['Alpha channel - Example Workspace', 'Beta channel - Example Workspace'])
  assert.deepEqual(chips.map((chip) => chip.suppressedTitleParts), [['- Slack'], ['- Slack']])
  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- Slack', count: 2 }])
  assert.deepEqual(firstSection(vm).suppressedTitleParts, [{ text: '- Slack', count: 2 }])
})

test('computeDomainCardViewModel tracks multiple hidden title parts per chip', () => {
  const group = {
    domain: 'slack.com',
    tabs: [
      makeTab({ url: 'https://app.slack.com/client/T123/C123', title: 'Alpha channel - JIRA - Example Workspace - Slack' }),
      makeTab({ id: 2, url: 'https://app.slack.com/client/T123/C456', title: 'Beta channel - JIRA - Example Workspace - Slack' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = firstSection(vm).flatVisibleChips
  const titles = chips.map((chip) => chip.displaySegments.filter((seg) => typeof seg === 'string').join(''))

  assert.deepEqual(titles, ['Alpha channel', 'Beta channel'])
  assert.deepEqual(chips.map((chip) => chip.suppressedTitleParts), [['- JIRA - Example Workspace - Slack'], ['- JIRA - Example Workspace - Slack']])
  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- JIRA - Example Workspace - Slack', count: 2 }])
  assert.deepEqual(firstSection(vm).suppressedTitleParts, [{ text: '- JIRA - Example Workspace - Slack', count: 2 }])
})

test('computeDomainCardViewModel scopes title suppression tokens to the narrowest section', () => {
  const group = {
    domain: 'slack.com',
    tabs: [
      makeTab({ url: 'https://app.slack.com/client/T123/C123', title: 'Alpha channel - Example Workspace - Slack' }),
      makeTab({ id: 2, url: 'https://app.slack.com/client/T123/C456', title: 'Beta channel - Example Workspace - Slack' }),
      makeTab({ id: 3, url: 'https://help.slack.com/articles/welcome', title: 'Welcome to Slack Help' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const appSection = sectionsOf(vm).find((section) => section.key === 'app')
  const helpSection = sectionsOf(vm).find((section) => section.key === 'help')

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- Example Workspace - Slack', count: 2 }])
  assert.deepEqual(appSection?.suppressedTitleParts, [{ text: '- Example Workspace - Slack', count: 2 }])
  assert.deepEqual(helpSection?.suppressedTitleParts, [])
})

test('computeDomainCardViewModel keeps a single Contentful tab in its environment path group', () => {
  const group = {
    domain: 'contentful.com',
    tabs: [
      makeTab({
        url: 'https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-alpha',
        title: 'Example Article Alpha — env-alpha — Contentful'
      }),
      makeTab({
        id: 2,
        url: 'https://app.contentful.com/spaces/example-space/environments/env-beta/entries/entry-beta',
        title: 'Example Article Beta — env-beta — Contentful'
      }),
      makeTab({
        id: 3,
        url: 'https://app.contentful.com/spaces/example-space/environments/env-beta/entries/entry-gamma',
        title: 'Example Article Gamma — env-beta — Contentful'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const appSection = sectionsOf(vm).find((section) => section.key === 'app')

  assert.ok(appSection)
  assert.deepEqual(
    appSection.clusters.map((cluster) => ({ label: cluster.label, count: cluster.count })),
    [
      { label: 'env-alpha', count: 1 },
      { label: 'env-beta', count: 2 }
    ]
  )
  assert.equal(appSection.hasFlat, false)
})

test('computeDomainCardViewModel scopes title suppression tokens to a pathgroup before its subdomain', () => {
  const group = {
    domain: 'contentful.com',
    tabs: [
      makeTab({
        url: 'https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-alpha',
        title: 'Example Article Alpha — Content — Example Website — env-alpha — Contentful'
      }),
      makeTab({
        id: 2,
        url: 'https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-beta',
        title: 'Example Article Beta — Content — Example Website — env-alpha — Contentful'
      }),
      makeTab({
        id: 3,
        url: 'https://app.contentful.com/spaces/example-space/environments/env-beta/entries/entry-gamma',
        title: 'Example Taxonomy | Example Help Center'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const appSection = sectionsOf(vm).find((section) => section.key === 'app')
  const envAlphaCluster = appSection?.clusters.find((cluster) => cluster.label === 'env-alpha')

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(appSection?.suppressedTitleParts, [])
  assert.deepEqual(envAlphaCluster?.suppressedTitleParts, [{ text: '— Content — Example Website —', count: 2 }, { text: '— Contentful', count: 2 }])
})

test('computeDomainCardViewModel orders title suppression summary by source title position before count', () => {
  const group = {
    domain: 'contentful.com',
    tabs: [
      makeTab({
        url: 'https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-alpha',
        title: 'Example Article Alpha — Content — Example Website — env-alpha — Contentful'
      }),
      makeTab({
        id: 2,
        url: 'https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-beta',
        title: 'Example Article Beta — Content — Example Website — env-alpha — Contentful'
      }),
      makeTab({
        id: 3,
        url: 'https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-gamma',
        title: 'Content: All entries — env-alpha — Contentful'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const appSection = sectionsOf(vm).find((section) => section.key === 'app')
  const envAlphaCluster = appSection?.clusters.find((cluster) => cluster.label === 'env-alpha')
  const expectedSummary = [
    { text: '— Content — Example Website —', count: 2 },
    { text: '— Contentful', count: 3 }
  ]

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, expectedSummary)
  assert.deepEqual(envAlphaCluster?.suppressedTitleParts, expectedSummary)
})

test('computeDomainCardViewModel suppresses shared title text before structural path labels', () => {
  const titles = [
    'Example Article Alpha — Content — Example Website — env-alpha — Contentful',
    'Example Article Beta — Content — Example Website — env-alpha — Contentful'
  ]
  const group = {
    domain: 'contentful.com',
    tabs: titles.map((title, index) => makeTab({
      id: index + 1,
      url: `https://app.contentful.com/spaces/example-space/environments/env-alpha/entries/entry-${index + 1}`,
      title
    }))
  }
  const chipTitle = (chip: DashboardChipData) => chip.displaySegments.map((segment) => {
    if (typeof segment === 'string') return segment
    if ('titleSuppression' in segment) return '˷'
    return '/'
  }).join('')
  const chipsFrom = (vm: DashboardCardVM) => sectionsOf(vm).flatMap((section) => section.clusters.flatMap((cluster) => cluster.visibleChips))

  const vm = computeDomainCardViewModel(group)
  const chips = chipsFrom(vm)
  const visibleTitles = chips.map(chipTitle)
  const structuralPlaceholderLabels = chips.map((chip) => {
    const placeholder = chip.displaySegments.find((segment) => typeof segment !== 'string' && 'placeholder' in segment)
    return placeholder && 'placeholder' in placeholder ? placeholder.label : undefined
  })

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '— Content — Example Website —', count: 2 }, { text: '— Contentful', count: 2 }])
  assert.deepEqual(atOrThrow(firstSection(vm).clusters, 0).suppressedTitleParts, [{ text: '— Content — Example Website —', count: 2 }, { text: '— Contentful', count: 2 }])
  assert.deepEqual(chips.map((chip) => chip.suppressedTitleParts), [['— Content — Example Website —', '— Contentful'], ['— Content — Example Website —', '— Contentful']])
  assert.deepEqual(structuralPlaceholderLabels, ['env-alpha', 'env-alpha'])
  assert.deepEqual(visibleTitles, [
    'Example Article Alpha ˷ /',
    'Example Article Beta ˷ /'
  ])
  assert.ok(visibleTitles.every((title) => !title.includes('Content') && !title.includes('Example Website')))

  const filteredVm = computeDomainCardViewModel(group, { filter: 'example website' })
  const filteredTitles = chipsFrom(filteredVm).map(chipTitle)

  assert.deepEqual(filteredVm.suppressedTitleParts, [])
  assert.deepEqual(filteredVm.allSuppressedTitleParts, [{ text: '— Contentful', count: 2 }])
  assert.deepEqual(atOrThrow(firstSection(filteredVm).clusters, 0).suppressedTitleParts, [{ text: '— Contentful', count: 2 }])
  assert.ok(filteredTitles.every((title) => title.includes('Content') && title.includes('Example Website')))
})

test('computeDomainCardViewModel treats Google Search as shared hidden title text instead of a path group', () => {
  const group = {
    domain: 'google.com',
    tabs: [
      makeTab({ url: 'https://www.google.com/search?q=alpha', title: 'alpha - Google Search' }),
      makeTab({ id: 2, url: 'https://www.google.com/search?q=beta', title: 'beta - Google Search' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const section = firstSection(vm)

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- Google Search', count: 2 }])
  assert.deepEqual(section.suppressedTitleParts, [{ text: '- Google Search', count: 2 }])
  assert.deepEqual(section.clusters.map((cluster) => cluster.label), [])
  assert.equal(section.hasFlat, true)
})

test('resolveWebsitePathSection returns raw Google document product paths', () => {
  assert.deepEqual(resolveWebsitePathSection('https://docs.google.com/document/d/doc-alpha/edit'), {
    key: '/document',
    label: '/document'
  })
  assert.deepEqual(resolveWebsitePathSection('https://docs.google.com/spreadsheets/d/sheet-alpha/edit'), {
    key: '/spreadsheets',
    label: '/spreadsheets'
  })
  assert.deepEqual(resolveWebsitePathSection('https://docs.google.com/presentation/d/deck-alpha/edit'), {
    key: '/presentation',
    label: '/presentation'
  })
  assert.equal(resolveWebsitePathSection('https://docs.google.com/viewer?url=https%3A%2F%2Fexample.com'), null)
})

test('computeDomainCardViewModel splits docs.google.com products into website path sections when multiple paths are present', () => {
  const group = {
    domain: 'google.com',
    tabs: [
      makeTab({
        url: 'https://docs.google.com/document/d/doc-alpha/edit',
        title: 'Example Spec - Google Docs'
      }),
      makeTab({
        id: 2,
        url: 'https://docs.google.com/spreadsheets/d/sheet-alpha/edit',
        title: 'Example Budget - Google Sheets'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const docsSection = sectionsOf(vm).find((section) => section.key === 'docs')

  assert.ok(docsSection)
  assert.equal(docsSection.hasFlat, false)
  assert.deepEqual(
    docsSection.websitePathSections.map((section) => section.label),
    ['/document', '/spreadsheets']
  )
  assert.deepEqual(
    docsSection.websitePathSections.map((section) => section.flatVisibleChips.map((chip) => chip.tabUrl)),
    [
      ['https://docs.google.com/document/d/doc-alpha/edit'],
      ['https://docs.google.com/spreadsheets/d/sheet-alpha/edit']
    ]
  )
})

test('computeDomainCardViewModel keeps Atlassian tenants separate while nesting website paths and project groups', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({
        url: 'https://alpha.atlassian.net/browse/APP-1001',
        title: '[APP-1001] Example task'
      }),
      makeTab({
        id: 2,
        url: 'https://alpha.atlassian.net/wiki/spaces/KB/pages/page-alpha',
        title: 'Alpha guide - Example-Site - Confluence'
      }),
      makeTab({
        id: 3,
        url: 'https://alpha.atlassian.net/wiki/spaces/KB/pages/page-beta',
        title: 'Beta guide - Example-Site - Confluence'
      }),
      makeTab({
        id: 4,
        url: 'https://beta.atlassian.net/browse/OPS-2001',
        title: '[OPS-2001] Example incident'
      }),
      makeTab({
        id: 5,
        url: 'https://beta.atlassian.net/wiki/spaces/RUN/pages/page-alpha',
        title: 'Runbook alpha - Example-Site - Confluence'
      }),
      makeTab({
        id: 6,
        url: 'https://beta.atlassian.net/wiki/spaces/RUN/pages/page-beta',
        title: 'Runbook beta - Example-Site - Confluence'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const alphaSection = sectionsOf(vm).find((section) => section.key === 'alpha')
  const betaSection = sectionsOf(vm).find((section) => section.key === 'beta')

  assert.ok(alphaSection)
  assert.ok(betaSection)
  assert.equal(alphaSection.showHeader, true)
  assert.equal(betaSection.showHeader, true)
  assert.deepEqual(alphaSection.websitePathSections.map((section) => section.label), ['/browse', '/wiki'])
  assert.deepEqual(betaSection.websitePathSections.map((section) => section.label), ['/browse', '/wiki'])
  assert.deepEqual(alphaSection.websitePathSections.find((section) => section.label === '/browse')?.clusters.map((cluster) => cluster.label), ['APP'])
  assert.deepEqual(alphaSection.websitePathSections.find((section) => section.label === '/wiki')?.clusters.map((cluster) => cluster.label), ['KB'])
  assert.deepEqual(betaSection.websitePathSections.find((section) => section.label === '/browse')?.clusters.map((cluster) => cluster.label), ['OPS'])
  assert.deepEqual(betaSection.websitePathSections.find((section) => section.label === '/wiki')?.clusters.map((cluster) => cluster.label), ['RUN'])
  assert.deepEqual(alphaSection.clusters, [])
  assert.deepEqual(betaSection.clusters, [])
})

test('computeDomainCardViewModel creates generic first-segment path sections within each current section', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({
        url: 'https://env-a.example.test/resource/contentKeys/account/en-US.json',
        title: 'env-a.example.test/resource/contentKeys/account/en-US.json'
      }),
      makeTab({
        id: 2,
        url: 'https://env-a.example.test/resource/contentKeys/cart/en-US.json',
        title: 'env-a.example.test/resource/contentKeys/cart/en-US.json'
      }),
      makeTab({
        id: 3,
        url: 'https://env-a.example.test/gateway/contentful-sync/sync',
        title: 'env-a.example.test/gateway/contentful-sync/sync'
      }),
      makeTab({
        id: 4,
        url: 'https://env-a.example.test/shop/frames',
        title: 'Example Shop'
      }),
      makeTab({
        id: 5,
        url: 'https://env-b.example.test/resource/contentKeys/only-here/en-US.json',
        title: 'env-b.example.test/resource/contentKeys/only-here/en-US.json'
      }),
      makeTab({
        id: 6,
        url: 'https://env-b.example.test/shop/sunglasses',
        title: 'Example Sunglasses'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const envASection = sectionsOf(vm).find((section) => section.key === 'env-a')
  const envBSection = sectionsOf(vm).find((section) => section.key === 'env-b')

  assert.ok(envASection)
  assert.ok(envBSection)
  assert.deepEqual(
    envASection.websitePathSections.map((section) => section.label),
    ['/resource']
  )
  assert.deepEqual(
    atOrThrow(envASection.websitePathSections, 0).flatVisibleChips.map((chip) => chip.tabUrl),
    [
      'https://env-a.example.test/resource/contentKeys/account/en-US.json',
      'https://env-a.example.test/resource/contentKeys/cart/en-US.json'
    ]
  )
  assert.equal(envASection.hasFlat, true)
  assert.deepEqual(
    envASection.flatVisibleChips.map((chip) => chip.tabUrl),
    [
      'https://env-a.example.test/gateway/contentful-sync/sync',
      'https://env-a.example.test/shop/frames'
    ]
  )
  assert.equal(envBSection.websitePathSections.length, 0)
  assert.deepEqual(
    envBSection.flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://env-b.example.test/resource/contentKeys/only-here/en-US.json', 'https://env-b.example.test/shop/sunglasses']
  )
})

test('computeDomainCardViewModel applies generic path sections to root-domain sections too', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({
        url: 'https://example.test/resource/contentKeys/account/en-US.json',
        title: 'example.test/resource/contentKeys/account/en-US.json'
      }),
      makeTab({
        id: 2,
        url: 'https://example.test/resource/contentKeys/cart/en-US.json',
        title: 'example.test/resource/contentKeys/cart/en-US.json'
      }),
      makeTab({
        id: 3,
        url: 'https://example.test/shop/frames',
        title: 'Example Shop'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const rootSection = sectionsOf(vm).find((section) => section.key === '')

  assert.ok(rootSection)
  assert.deepEqual(
    rootSection.websitePathSections.map((section) => section.label),
    ['/resource']
  )
  assert.deepEqual(rootSection.flatVisibleChips.map((chip) => chip.tabUrl), ['https://example.test/shop/frames'])
})

test('computeDomainCardViewModel leaves a single docs.google.com product tab flat', () => {
  const group = {
    domain: 'google.com',
    tabs: [
      makeTab({
        url: 'https://docs.google.com/document/d/doc-alpha/edit',
        title: 'Example Spec - Google Docs'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const docsSection = firstSection(vm)

  assert.equal(docsSection.key, 'docs')
  assert.equal(docsSection.websitePathSections.length, 0)
  assert.equal(docsSection.flatVisibleChips.length, 1)
  assert.equal(atOrThrow(docsSection.flatVisibleChips, 0).tabUrl, 'https://docs.google.com/document/d/doc-alpha/edit')
})

test('resolveWebsitePathSection groups Atlassian Jira app paths under /jira', () => {
  assert.deepEqual(resolveWebsitePathSection('https://example.atlassian.net/browse/APP-123'), {
    key: '/browse',
    label: '/browse'
  })
  assert.deepEqual(resolveWebsitePathSection('https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha'), {
    key: '/wiki',
    label: '/wiki'
  })
  assert.deepEqual(resolveWebsitePathSection('https://example.atlassian.net/jira/for-you'), {
    key: '/jira',
    label: '/jira'
  })
  assert.deepEqual(resolveWebsitePathSection('https://example.atlassian.net/jira/software/projects/APP/boards/1'), {
    key: '/jira',
    label: '/jira'
  })
  assert.deepEqual(resolveWebsitePathSection('https://example.atlassian.net/jira/servicedesk/projects/HELP/queues/custom/1'), {
    key: '/jira',
    label: '/jira'
  })
  assert.equal(resolveWebsitePathSection('https://example.atlassian.net/rest/api/3/issue/APP-123'), null)
})

test('computeDomainCardViewModel scopes title suppression to a website path before its subdomain', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({
        url: 'https://example.atlassian.net/wiki/home',
        title: 'Wiki home - Example-Site - Confluence'
      }),
      makeTab({
        id: 2,
        url: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
        title: 'Alpha guide - Example-Site - Confluence'
      }),
      makeTab({
        id: 3,
        url: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-beta',
        title: 'Beta guide - Example-Site - Confluence'
      }),
      makeTab({
        id: 4,
        url: 'https://example.atlassian.net/browse/APP-1001',
        title: '[APP-1001] Example task'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const section = firstSection(vm)
  const wikiSection = section.websitePathSections.find((websitePathSection) => websitePathSection.label === '/wiki')
  const kbCluster = wikiSection?.clusters.find((cluster) => cluster.label === 'KB')

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(section.suppressedTitleParts, [])
  assert.deepEqual(wikiSection?.suppressedTitleParts, [{ text: '- Confluence', count: 3, spansRenderedChildGroups: true }])
  assert.deepEqual(kbCluster?.suppressedTitleParts, [{ text: '- Example-Site', count: 2 }])
})

test('computeDomainCardViewModel marks single title suppression that spans rendered child groups', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({
        url: 'https://example.atlassian.net/jira/your-work',
        title: 'Work item search - JIRA'
      }),
      makeTab({
        id: 2,
        url: 'https://example.atlassian.net/browse/TASK-1001',
        title: '[TASK-1001] Account settings - JIRA'
      }),
      makeTab({
        id: 3,
        url: 'https://example.atlassian.net/browse/DOC-201',
        title: '[DOC-201] Example checklist - JIRA'
      }),
      makeTab({
        id: 4,
        url: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
        title: 'Platform Architecture Notes - Example-Site - Confluence'
      }),
      makeTab({
        id: 5,
        url: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-beta',
        title: 'Shared Library Plan - Example-Site - Confluence'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const section = firstSection(vm)

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(section.suppressedTitleParts, [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }])
  assert.equal(section.hasFlat, false)
  assert.deepEqual(section.websitePathSections.map((websitePathSection) => websitePathSection.label), ['/browse', '/jira', '/wiki'])
  assert.deepEqual(section.websitePathSections.find((websitePathSection) => websitePathSection.label === '/browse')?.clusters.map((cluster) => cluster.label), ['DOC', 'TASK'])
  assert.deepEqual(section.websitePathSections.find((websitePathSection) => websitePathSection.label === '/wiki')?.clusters.map((cluster) => cluster.label), ['KB'])
})

test('computeDomainCardViewModel keeps single title suppression neutral when it is the only card meaning', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({
        url: 'https://www.example.test/',
        title: 'Deployment History - ENV A | Example Retail'
      }),
      makeTab({
        id: 2,
        url: 'https://env-a.example.test/order',
        title: 'Order Page | Example Retail'
      }),
      makeTab({
        id: 3,
        url: 'https://env-b.example.test/resource/config/account/en-US.json',
        title: 'env-b.example.test/resource/config/account/en-US.json | Example Retail'
      }),
      makeTab({
        id: 4,
        url: 'https://stage.example.test/help',
        title: 'stage.example.test/help | Example Retail'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)

  assert.deepEqual(vm.suppressedTitleParts, [{ text: '| Example Retail', count: 4 }])
  assert.equal(atOrThrow(expectDefined(vm.suppressedTitleParts), 0).spansRenderedChildGroups, undefined)
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '| Example Retail', count: 4 }])
  assert.ok(sectionsOf(vm).length > 1)
})

test('computeDomainCardViewModel exposes Confluence product and site suffixes as title noise', () => {
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({
        url: 'https://example.atlassian.net/browse/TASK-1001',
        title: '[TASK-1001] My account: Suggestion to add'
      }),
      makeTab({
        id: 2,
        url: 'https://example.atlassian.net/browse/DOC-1002',
        title: '[DOC-1002] Example Product Article'
      }),
      makeTab({
        id: 3,
        url: 'https://example.atlassian.net/wiki/spaces/DOCS/pages/page-alpha/Platform+Architecture+Notes',
        title: 'Platform Architecture Notes - Example-Site - Confluence'
      }),
      makeTab({
        id: 4,
        url: 'https://example.atlassian.net/wiki/spaces/DOCS/pages/page-beta/Shared+Library+Plan',
        title: 'Shared Library Plan - Example-Site - Confluence'
      }),
      makeTab({
        id: 5,
        url: 'https://example.atlassian.net/wiki/spaces/DOCS/pages/page-gamma/Content+Guide',
        title: 'Example Content Guide - Example-Site - Confluence'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = sectionsOf(vm)
    .flatMap((section) => section.websitePathSections.flatMap((websitePathSection) => websitePathSection.clusters.flatMap((cluster) => cluster.visibleChips)))
    .filter((chip) => chip.tabUrl.includes('/wiki/'))
  const titles = chips.map((chip) => chip.displaySegments.filter((seg) => typeof seg === 'string').join(''))

  const wikiSection = sectionsOf(vm).flatMap((section) => section.websitePathSections).find((websitePathSection) => websitePathSection.label === '/wiki')
  const docsCluster = wikiSection?.clusters.find((cluster) => cluster.label === 'DOCS')

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [{ text: '- Example-Site - Confluence', count: 3 }])
  assert.deepEqual(wikiSection?.suppressedTitleParts, [])
  assert.deepEqual(docsCluster?.suppressedTitleParts, [{ text: '- Example-Site - Confluence', count: 3 }])
  assert.equal(docsCluster?.suppressedTitleParts?.[0]?.spansRenderedChildGroups, undefined)
  assert.deepEqual(chips.map((chip) => chip.suppressedTitleParts), [
    ['- Example-Site - Confluence'],
    ['- Example-Site - Confluence'],
    ['- Example-Site - Confluence']
  ])
  assert.ok(titles.every((title) => !title.includes('Example-Site')))
  assert.ok(titles.every((title) => !title.includes('Confluence')))
})

test('computeDomainCardViewModel keeps one-off cleaned title suffixes out of the summary row', () => {
  const wikiUrl = 'https://example.atlassian.net/wiki/spaces/DOCS/pages/page-alpha/Platform+Architecture+Notes'
  const group = {
    domain: 'atlassian.net',
    tabs: [
      makeTab({
        url: wikiUrl,
        title: 'Example Architecture Plan - Confluence'
      }),
      makeTab({
        id: 2,
        url: 'https://example.atlassian.net/browse/TASK-1001',
        title: '[TASK-1001] My account: Suggestion to add'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chips = sectionsOf(vm).flatMap((section) => [
    ...section.flatVisibleChips,
    ...section.clusters.flatMap((cluster) => cluster.visibleChips),
    ...section.websitePathSections.flatMap((websitePathSection) => [
      ...websitePathSection.flatVisibleChips,
      ...websitePathSection.clusters.flatMap((cluster) => cluster.visibleChips)
    ])
  ])
  const wikiChip = chips.find((chip) => chip.tabUrl === wikiUrl)
  const wikiTitle = wikiChip?.displaySegments.filter((seg) => typeof seg === 'string').join('')

  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(wikiChip?.suppressedTitleParts, [])
  assert.equal(wikiTitle, 'Example Architecture Plan - Confluence')
})

test('computeDomainCardViewModel marks active tabs from other windows', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/current-window', title: 'Current window', active: true, windowId: 1 }),
      makeTab({ id: 2, url: 'https://example.com/other-window', title: 'Other window', active: true, windowId: 2 })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const chips = firstSection(vm).flatVisibleChips
  const currentWindowChip = chips.find((chip) => chip.tabUrl === 'https://example.com/current-window')
  const otherWindowChip = chips.find((chip) => chip.tabUrl === 'https://example.com/other-window')

  assert.equal(currentWindowChip?.activeInOtherWindow, false)
  assert.equal(otherWindowChip?.activeInOtherWindow, true)
})

test('computeDomainCardViewModel keeps live tab favicons aligned with Chrome tab state', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({ url: 'https://example.test/glasses-lenses', title: 'Example Lenses', favIconUrl: '' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chip = atOrThrow(firstSection(vm).flatVisibleChips, 0)

  assert.equal(chip.faviconUrl, '')
})

test('computeDomainCardViewModel resolves suspended tab favicons from the original url, not the suspender-faded copy', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({
        url: 'https://example.test/docs',
        rawUrl: 'chrome-extension://suspender/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.test%2Fdocs',
        title: 'Example Docs',
        suspended: true,
        favIconUrl: 'data:image/png;base64,suspended'
      })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chip = atOrThrow(firstSection(vm).flatVisibleChips, 0)

  assert.equal(chip.faviconUrl, 'chrome-extension://tab-out/_favicon/?pageUrl=https%3A%2F%2Fexample.test%2Fdocs&size=32')
})

test('computeDomainCardViewModel can use Chrome favicon cache for read-only source chips', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ id: 'h1', url: 'https://example.com/docs', title: 'Example Docs', favIconUrl: '', sourceType: 'history' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const chip = atOrThrow(firstSection(vm).flatVisibleChips, 0)

  assert.equal(chip.faviconUrl, 'chrome-extension://tab-out/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fdocs&size=32')
})

test('computeDomainCardViewModel frames a duplicate URL when the active copy is not the displayed representative', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/current-page', title: 'Inactive duplicate', windowId: 2 }),
      makeTab({ id: 2, url: 'https://example.com/current-page', title: 'Active duplicate', active: true, windowId: 1 })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const chip = firstSection(vm).flatVisibleChips.find((candidate) => candidate.tabUrl === 'https://example.com/current-page')

  assert.equal(chip?.dupeCount, 2)
  assert.equal(chip?.activeInOtherWindow, false)
  assert.equal(chip?.activeChipFrame, true)
})

test('computeDomainCardViewModel marks a duplicate URL active in another window when the active copy is not the displayed representative', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://example.com/other-window-page', title: 'Inactive duplicate', windowId: 1 }),
      makeTab({ id: 2, url: 'https://example.com/other-window-page', title: 'Active duplicate', active: true, windowId: 2 })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const chip = firstSection(vm).flatVisibleChips.find((candidate) => candidate.tabUrl === 'https://example.com/other-window-page')

  assert.equal(chip?.dupeCount, 2)
  assert.equal(chip?.activeInOtherWindow, true)
  assert.equal(chip?.activeChipFrame, true)
})

test('computeDomainCardViewModel frames the current Tab Out page without marking it as other-window active', () => {
  const group = {
    domain: '__tab-out__',
    label: 'New tabs',
    tabs: [
      makeTab({
        url: 'chrome-extension://tab-out/index.html',
        rawUrl: 'chrome-extension://tab-out/index.html',
        title: 'Tab Out',
        active: true,
        windowId: 1,
        isTabOut: true
      }),
      makeTab({
        id: 2,
        url: 'chrome-extension://tab-out/index.html?focusFilter=1',
        rawUrl: 'chrome-extension://tab-out/index.html?focusFilter=1',
        title: 'Tab Out',
        windowId: 2,
        isTabOut: true
      })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const currentTabOutChip = firstSection(vm).flatVisibleChips.find((chip) => chip.rawUrl === 'chrome-extension://tab-out/index.html')

  assert.equal(currentTabOutChip?.activeInOtherWindow, false)
  assert.equal(currentTabOutChip?.activeChipFrame, true)
})

test('computeDomainCardViewModel keeps the shared folded section headerless', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://dev.example.com/settings', title: 'Settings' }),
      makeTab({ id: 2, url: 'https://qa.example.com/settings', title: 'Settings', active: true, windowId: 2 }),
      makeTab({ id: 3, url: 'https://dev.example.com/logs', title: 'Logs' })
    ]
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const section = firstSection(vm)
  const chip = atOrThrow(section.flatVisibleChips, 0)
  const envs = expectDefined(chip.envs, 'Expected the shared chip to retain its environments')
  assert.equal(vm.isHidden, false)
  assert.equal(section.isShared, true)
  assert.equal(section.showHeader, false)
  assert.equal(section.flatVisibleChips.length, 1)
  assert.equal(chip.activeInOtherWindow, true)
  assert.deepEqual(
    envs.map((env) => env.prefix),
    ['dev', 'qa']
  )
  assert.deepEqual(
    envs.map((env) => env.activeInOtherWindow ?? false),
    [false, true]
  )
})

test('computeDomainCardViewModel keeps same-path tabs in separate subdomain sections when their titles differ', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({ url: 'https://dev1.example.test/deployments', title: 'Deployment History - DEV1' }),
      makeTab({ id: 2, url: 'https://dev2.example.test/deployments', title: 'Deployment History - DEV2' }),
      makeTab({ id: 3, url: 'https://qa.example.test/deployments', title: 'Deployment History - QA' })
    ]
  }

  const vm = computeDomainCardViewModel(group)

  assert.equal(sectionsOf(vm).some((section) => section.isShared), false)
  assert.deepEqual(sectionsOf(vm).map((section) => section.key), ['dev1', 'dev2', 'qa'])
  assert.deepEqual(
    sectionsOf(vm).flatMap((section) => section.flatVisibleChips.map((chip) => chip.tabUrl)),
    [
      'https://dev1.example.test/deployments',
      'https://dev2.example.test/deployments',
      'https://qa.example.test/deployments'
    ]
  )
  assert.ok(sectionsOf(vm).every((section) => section.flatVisibleChips.every((chip) => !chip.envs?.length)))
})

test('computeDomainCardViewModel carries every env suppression token on folded chips', () => {
  const group = {
    domain: 'example.test',
    tabs: [
      makeTab({ url: 'https://dev1.example.test/deployments', title: 'Deployment History | Example Retail' }),
      makeTab({ id: 2, url: 'https://dev2.example.test/deployments', title: 'Deployment History | Example Retail' })
    ]
  }

  const vm = computeDomainCardViewModel(group)
  const foldedChip = atOrThrow(firstSection(vm).flatVisibleChips, 0)

  assert.equal(firstSection(vm).isShared, true)
  assert.deepEqual(vm.suppressedTitleParts, [])
  assert.deepEqual(vm.allSuppressedTitleParts, [
    { text: '| Example Retail', count: 2 }
  ])
  assert.deepEqual(firstSection(vm).suppressedTitleParts, [
    { text: '| Example Retail', count: 2 }
  ])
  assert.deepEqual(foldedChip.suppressedTitleParts, ['| Example Retail'])
  assert.deepEqual(
    foldedChip.displaySegments.filter((seg) => typeof seg === 'string').join(''),
    'Deployment History'
  )
})

test('buildDashboardViewModel derives matched and unmatched cards in one pass', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://alpha.example.com/overview', title: 'Overview' }),
    makeTab({ id: 2, url: 'https://alpha.example.com/beta', title: 'Beta rollout' }),
    makeTab({ id: 3, url: 'https://second.test.com/other', title: 'Other page' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'beta'
  })

  assert.equal(vm.stats.totalTabs, 3)
  assert.equal(vm.stats.visibleTabs, 1)
  assert.equal(vm.matchedCards.length, 1)
  assert.equal(vm.unmatchedCards.length, 2)
  assert.equal(vm.showOtherTabs, true)
  assert.deepEqual(vm.filteredCloseUrls, ['https://alpha.example.com/beta'])
  const matchedCard = atOrThrow(vm.matchedCards, 0)
  assert.equal(matchedCard.vm.tabCount, 1)
  assert.equal(matchedCard.vm.totalTabCount, 2)
  assert.equal(matchedCard.vm.tabCountLabel, '1/2')
  assert.equal(matchedCard.vm.tabCountTitle, '1 of 2 open tabs shown while filtering')

  const unmatchedAlphaCard = expectDefined(vm.unmatchedCards.find(({ group }) => group.domain === 'example.com'))
  assert.equal(unmatchedAlphaCard.vm.tabCount, 1)
  assert.equal(unmatchedAlphaCard.vm.totalTabCount, 2)
  assert.equal(unmatchedAlphaCard.vm.tabCountLabel, '1/2')
})

test('filtered close targets preserve per-tab title scope for same-URL duplicates', () => {
  const sharedUrl = 'https://example.test/shared'
  const groups = buildDomainGroups([
    makeTab({ id: 1, url: sharedUrl, title: 'Alpha match' }),
    makeTab({ id: 2, url: sharedUrl, title: 'Beta non-match' })
  ])
  const vm = buildDashboardViewModel({
    realTabs: groups.flatMap((group) => group.tabs),
    domainGroups: groups,
    filter: 'alpha'
  })

  assert.deepEqual(vm.filteredCloseUrls, [sharedUrl])
  assert.deepEqual(vm.filteredCloseTargets, [{ tabId: 1, tabUrl: sharedUrl }])
  assert.equal(vm.stats.filteredCloseCount, 1)
})

test('buildDashboardViewModel counts active (unsuspended) open tabs', () => {
  const tabs = [
    makeTab({ id: 1, url: 'https://a.example.com/', title: 'A' }),
    makeTab({ id: 2, url: 'https://b.example.com/', title: 'B', suspended: true }),
    makeTab({ id: 3, url: 'https://c.example.com/', title: 'C', suspended: true })
  ]
  const groups = buildDomainGroups(tabs)

  const vm = buildDashboardViewModel({ realTabs: tabs, domainGroups: groups })

  assert.equal(vm.stats.totalTabs, 3)
  assert.equal(vm.stats.activeTabs, 1)
})

test('buildDashboardViewModel keeps known chip URLs in their previous card order when titles change', () => {
  const tabs = [
    makeTab({ url: 'https://example.test/?page=alpha', title: 'Alpha loading title' }),
    makeTab({ id: 2, url: 'https://example.test/?page=bravo', title: 'Bravo final title' })
  ]
  const groups = buildDomainGroups(tabs)
  const previousChipOrder = new Map([
    [
      domainCardId('example.test'),
      new Map([
        [dashboardChipOrderKeyForTab(atOrThrow(tabs, 1)), 0],
        [dashboardChipOrderKeyForTab(atOrThrow(tabs, 0)), 1]
      ])
    ]
  ])

  const vm = buildDashboardViewModel({
    realTabs: groups.flatMap((group) => group.tabs),
    domainGroups: groups,
    chipOrder: previousChipOrder
  })

  assert.deepEqual(
    firstSection(atOrThrow(vm.matchedCards, 0).vm).flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.test/?page=bravo', 'https://example.test/?page=alpha']
  )
})

test('buildDashboardViewModel ranks working-set-priority chips before remembered order within a domain card', () => {
  const tabs = [
    makeTab({ url: 'https://example.test/?page=alpha', title: 'Alpha page' }),
    makeTab({ id: 2, url: 'https://example.test/?page=bravo', title: 'Bravo page' }),
    makeTab({ id: 3, url: 'https://example.test/?page=charlie', title: 'Charlie page' })
  ]
  const groups = buildDomainGroups(tabs)
  const previousChipOrder = new Map([
    [
      domainCardId('example.test'),
      new Map([
        [dashboardChipOrderKeyForTab(atOrThrow(tabs, 0)), 0],
        [dashboardChipOrderKeyForTab(atOrThrow(tabs, 1)), 1],
        [dashboardChipOrderKeyForTab(atOrThrow(tabs, 2)), 2]
      ])
    ]
  ])

  const vm = buildDashboardViewModel({
    realTabs: groups.flatMap((group) => group.tabs),
    domainGroups: groups,
    chipOrder: previousChipOrder,
    chipPriority: new Map([
      ['https://example.test/?page=charlie', 100]
    ])
  })

  assert.deepEqual(
    firstSection(atOrThrow(vm.matchedCards, 0).vm).flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.test/?page=charlie', 'https://example.test/?page=alpha', 'https://example.test/?page=bravo']
  )
})

test('buildDashboardViewModel keeps remembered order across saved-page and raw-url startup identity drift', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html?url=https%3A%2F%2Fexample.test%2Fbravo'
  const tabs = [
    makeTab({ url: 'https://example.test/alpha', title: 'Alpha page' }),
    makeTab({ id: 2, url: 'https://example.test/bravo', rawUrl, title: 'Zulu page' })
  ]
  const groups = buildDomainGroups(tabs)
  const previousChipOrder = new Map([
    [
      domainCardId('example.test'),
      new Map([
        [dashboardChipOrderKeyForTab({ ...atOrThrow(tabs, 1), sourceType: 'saved-page', url: rawUrl }), 0],
        [dashboardChipOrderKeyForTab(atOrThrow(tabs, 0)), 1]
      ])
    ]
  ])

  const vm = buildDashboardViewModel({
    realTabs: groups.flatMap((group) => group.tabs),
    domainGroups: groups,
    chipOrder: previousChipOrder
  })

  assert.deepEqual(
    firstSection(atOrThrow(vm.matchedCards, 0).vm).flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.test/bravo', 'https://example.test/alpha']
  )
})

test('computeDomainCardViewModel does not inspect an empty remembered chip order', () => {
  class UnreadableEmptyOrder extends Map<string, number> {
    override get(_key: string): number | undefined {
      throw new Error('an empty remembered order must not perform URL-key lookups')
    }
  }

  const tabs = [
    makeTab({ url: 'https://example.test/alpha', title: 'Alpha page' }),
    makeTab({ id: 2, url: 'https://example.test/bravo', title: 'Bravo page' })
  ]

  const baseline = computeDomainCardViewModel(
    { domain: 'example.test', tabs },
    { source: 'tabs' }
  )
  const withEmptyOrder = computeDomainCardViewModel(
    { domain: 'example.test', tabs },
    { source: 'tabs', chipOrder: new UnreadableEmptyOrder() }
  )

  assert.deepEqual(
    firstSection(withEmptyOrder).flatVisibleChips.map((chip) => chip.tabUrl),
    firstSection(baseline).flatVisibleChips.map((chip) => chip.tabUrl)
  )
})

// useDashboardViewModels memoizes its builds with real hooks now, so it must run
// inside a React render; a one-shot static render extracts the hook's value.
function renderHookValue<T>(run: () => T): T {
  let value: T | undefined
  renderToStaticMarkup(React.createElement(() => {
    value = run()
    return null
  }))
  return expectDefined(value, 'Expected the hook render to produce a value')
}

test('useDashboardViewModels holds tabs chip order during the startup freeze and resumes after it', () => {
  const tabs = [
    makeTab({ id: 1, url: 'https://example.test/alpha', title: 'Alpha' }),
    makeTab({ id: 2, url: 'https://example.test/bravo', title: 'Bravo' })
  ]
  const groups = buildDomainGroups(tabs)
  const dashboard = {
    realTabs: groups.flatMap((group) => group.tabs),
    domainGroups: groups,
    currentWindowId: 1
  } as any
  // Remembered chip order that disagrees with the deterministic label fallback (bravo first).
  const rememberedChipOrder = {
    tabs: new Map([[domainCardId('example.test'), new Map([
      [dashboardChipOrderKeyForTab(atOrThrow(tabs, 1)), 0],
      [dashboardChipOrderKeyForTab(atOrThrow(tabs, 0)), 1]
    ])]]),
    bookmarks: new Map(),
    history: new Map()
  }
  const base = {
    dashboard,
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    isReady: true,
    chipOrder: rememberedChipOrder
  }
  // During the startup freeze the remembered order is ignored, so first paint and live
  // hydration both render the stable fallback order instead of re-sorting the chip window.
  const frozen = renderHookValue(() => useDashboardViewModels({ ...base, freezeTabsChipOrder: true }))
  assert.deepEqual(
    firstSection(atOrThrow(frozen.matchedCards, 0).vm).flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.test/alpha', 'https://example.test/bravo']
  )

  // Once the freeze lifts (filter/source change) the remembered order is honored again.
  const live = renderHookValue(() => useDashboardViewModels({ ...base, freezeTabsChipOrder: false }))
  assert.deepEqual(
    firstSection(atOrThrow(live.matchedCards, 0).vm).flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.test/bravo', 'https://example.test/alpha']
  )
})

test('computeDomainCardViewModel applies working-set priority before remembered Jira block order', () => {
  const tabs = [
    makeTab({ url: 'https://example.atlassian.net/browse/DOC-201', title: '[DOC-201] Example checklist - JIRA' }),
    makeTab({ id: 2, url: 'https://example.atlassian.net/browse/TASK-1001', title: '[TASK-1001] Account settings - JIRA' }),
    makeTab({ id: 3, url: 'https://example.atlassian.net/jira/your-work', title: 'Work item search - JIRA' }),
    makeTab({ id: 4, url: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha', title: 'Platform notes - Confluence' })
  ]
  const chipOrder = new Map(tabs.map((tab, index) => [dashboardChipOrderKeyForTab(tab), index]))

  const vm = computeDomainCardViewModel(
    { domain: 'atlassian.net', tabs },
    {
      chipOrder,
      chipPriority: new Map([
        ['https://example.atlassian.net/browse/TASK-1001', 90],
        ['https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha', 100]
      ])
    }
  )

  const rootSection = firstSection(vm)
  const browseSection = rootSection.websitePathSections.find((section) => section.label === '/browse')

  assert.deepEqual(rootSection.websitePathSections.map((section) => section.label), ['/wiki', '/browse', '/jira'])
  assert.deepEqual(browseSection?.clusters.map((cluster) => cluster.label), ['TASK', 'DOC'])
})

test('computeDomainCardViewModel applies chip priority before the overflow split', () => {
  const tabs = [
    makeTab({ url: 'https://example.test/pages/alpha', title: 'Alpha page' }),
    makeTab({ id: 2, url: 'https://example.test/pages/bravo', title: 'Bravo page' }),
    makeTab({ id: 3, url: 'https://example.test/pages/charlie', title: 'Charlie page' }),
    makeTab({ id: 4, url: 'https://example.test/pages/delta', title: 'Delta page' }),
    makeTab({ id: 5, url: 'https://example.test/pages/echo', title: 'Echo page' }),
    makeTab({ id: 6, url: 'https://example.test/pages/foxtrot', title: 'Foxtrot page' }),
    makeTab({ id: 7, url: 'https://example.test/pages/golf', title: 'Golf page' })
  ]

  const vm = computeDomainCardViewModel(
    { domain: 'example.test', tabs },
    {
      chipPriority: new Map([
        ['https://example.test/pages/golf', 100]
      ])
    }
  )
  const section = firstSection(vm)

  assert.equal(section.flatHiddenCount, 2)
  assert.equal(atOrThrow(section.flatVisibleChips, 0).tabUrl, 'https://example.test/pages/golf')
  assert.equal(section.flatHiddenChips.some((chip) => chip.tabUrl === 'https://example.test/pages/golf'), false)
})

test('computeDomainCardViewModel ranks subdomain sections by their strongest chip priority', () => {
  const tabs = [
    makeTab({ url: 'https://alpha.example.test/one', title: 'Alpha page' }),
    makeTab({ id: 2, url: 'https://beta.example.test/two', title: 'Beta page' })
  ]

  const vm = computeDomainCardViewModel(
    { domain: 'example.test', tabs },
    {
      chipPriority: new Map([
        ['https://beta.example.test/two', 100]
      ])
    }
  )

  assert.deepEqual(sectionsOf(vm).map((section) => section.key), ['beta', 'alpha'])
})

test('computeDomainCardViewModel ranks website path sections by their strongest chip priority', () => {
  const tabs = [
    makeTab({ url: 'https://example.test/docs/alpha', title: 'Docs alpha' }),
    makeTab({ id: 2, url: 'https://example.test/docs/bravo', title: 'Docs bravo' }),
    makeTab({ id: 3, url: 'https://example.test/shop/alpha', title: 'Shop alpha' }),
    makeTab({ id: 4, url: 'https://example.test/shop/bravo', title: 'Shop bravo' })
  ]

  const vm = computeDomainCardViewModel(
    { domain: 'example.test', tabs },
    {
      chipPriority: new Map([
        ['https://example.test/shop/bravo', 100]
      ])
    }
  )

  assert.deepEqual(firstSection(vm).websitePathSections.map((section) => section.label), ['/shop', '/docs'])
})

test('computeDomainCardViewModel ranks path groups by their strongest chip priority', () => {
  const tabs = [
    makeTab({ url: 'https://github.com/example/alpha/pull/1', title: 'Alpha pull request' }),
    makeTab({ id: 2, url: 'https://github.com/example/alpha/issues/2', title: 'Alpha issue' }),
    makeTab({ id: 3, url: 'https://github.com/example/bravo/pull/1', title: 'Bravo pull request' }),
    makeTab({ id: 4, url: 'https://github.com/example/bravo/issues/2', title: 'Bravo issue' })
  ]

  const vm = computeDomainCardViewModel(
    { domain: 'github.com', tabs },
    {
      chipPriority: new Map([
        ['https://github.com/example/bravo/issues/2', 100]
      ])
    }
  )

  assert.deepEqual(firstSection(vm).clusters.map((cluster) => cluster.label), ['example/bravo', 'example/alpha'])
})

test('parseFilterQuery separates tokens, quoted phrases, and open-ended phrases', () => {
  assert.deepEqual(parseFilterQuery(' github "pull request" 4706 "open ended ').terms, [
    { kind: 'token', value: 'github' },
    { kind: 'phrase', value: 'pull request' },
    { kind: 'token', value: '4706' },
    { kind: 'phrase', value: 'open ended' }
  ])
})

test('tabMatchesFilter uses tokenized AND and quoted phrase semantics', () => {
  const tab = makeTab({
    url: 'https://github.com/example/repo/pull/4706',
    title: 'Pull Request review'
  })
  const hyphenatedTab = makeTab({
    url: 'https://example.test/tab-out',
    title: 'Tab-Out guide'
  })
  const spacedTab = makeTab({
    url: 'https://example.test/tab-out',
    title: 'Tab Out guide'
  })

  assert.equal(tabMatchesFilter(tab, 'github 4706'), true)
  assert.equal(tabMatchesFilter(tab, '4706 github'), true)
  assert.equal(tabMatchesFilter(tab, 'github 9999'), false)
  assert.equal(tabMatchesFilter(tab, 'github "pull request"'), true)
  assert.equal(tabMatchesFilter(tab, 'github "request pull"'), false)
  assert.equal(tabMatchesFilter(tab, 'github "pull request'), true)
  assert.equal(tabMatchesFilter(tab, 'github pr'), true)
  assert.equal(tabMatchesFilter(tab, 'github "pr"'), false)
  assert.equal(tabMatchesFilter(hyphenatedTab, '"tab out"'), true)
  assert.equal(tabMatchesFilter(spacedTab, '"tab-out"'), true)
  assert.equal(tabMatchesFilter(tab, '   '), true)
})

test('tokenized filter matches drive filtered close targets for open tabs', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://github.com/example/repo/pull/4706', title: 'Pull Request review' }),
    makeTab({ id: 2, url: 'https://github.com/example/repo/pull/9999', title: 'Pull Request review' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'github pr 4706'
  })

  assert.deepEqual(vm.filteredCloseUrls, ['https://github.com/example/repo/pull/4706'])
  assert.equal(vm.stats.visibleTabs, 1)

  const blankVm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: '   '
  })
  assert.equal(blankVm.stats.filtering, false)
  assert.deepEqual(blankVm.filteredCloseUrls, [])
})

test('history source uses parsed filter semantics for returned candidates', () => {
  const historyTabs = [
    makeTab({ id: 'h1', url: 'https://openai.com/docs', title: 'OpenAI Docs', sourceType: 'history' }),
    makeTab({ id: 'h2', url: 'https://example.test/tab-out', title: 'Tab-Out guide', sourceType: 'history' })
  ]
  const bookmarkTabs = [
    makeTab({ id: 'b1', url: 'https://openai.com/docs', title: 'OpenAI Docs', sourceType: 'bookmark' })
  ]
  const historyGroups = buildDomainGroups(historyTabs)
  const bookmarkGroups = buildDomainGroups(bookmarkTabs)

  assert.equal(tabMatchesFilter(atOrThrow(historyTabs, 0), 'docs openai'), true)
  assert.equal(tabMatchesFilter(atOrThrow(historyTabs, 1), 'tab out'), true)
  assert.equal(tabMatchesFilter(atOrThrow(bookmarkTabs, 0), 'docs openai'), true)

  const historyVm = buildDashboardViewModel({
    realTabs: historyTabs,
    domainGroups: historyGroups,
    filter: 'docs openai',
    source: 'history'
  })
  const separatorHistoryVm = buildDashboardViewModel({
    realTabs: historyTabs,
    domainGroups: historyGroups,
    filter: 'tab out',
    source: 'history'
  })
  const bookmarkVm = buildDashboardViewModel({
    realTabs: bookmarkTabs,
    domainGroups: bookmarkGroups,
    filter: 'docs openai',
    source: 'bookmarks'
  })

  assert.deepEqual(historyVm.matchedCards.map(({ group }) => group.domain), ['openai.com'])
  assert.deepEqual(separatorHistoryVm.matchedCards.map(({ group }) => group.domain), ['example.test'])
  assert.equal(bookmarkVm.matchedCards.length, 1)
})

test('computeDomainCardViewModel uses the simple count when every chip matches the filter', () => {
  const group = {
    domain: 'example.com',
    tabs: [
      makeTab({ url: 'https://alpha.example.com/overview', title: 'Alpha overview' }),
      makeTab({ id: 2, url: 'https://alpha.example.com/details', title: 'Alpha details' })
    ]
  }

  const vm = computeDomainCardViewModel(group, { filter: 'alpha' })

  assert.equal(vm.tabCount, 2)
  assert.equal(vm.totalTabCount, 2)
  assert.equal(vm.tabCountLabel, '2')
  assert.equal(vm.tabCountTitle, '2 of 2 open tabs shown while filtering')
})

test('titleForFilterInput mirrors typed filter keywords', () => {
  assert.equal(titleForFilterInput('github'), 'github - Tab Out')
  assert.equal(titleForFilterInput('  qa env  '), 'qa env - Tab Out')
  assert.equal(titleForFilterInput(''), '\u200e')
  assert.equal(titleForFilterInput('   '), '\u200e')
})

test('filter URL helpers preserve restorable filter state without history churn', () => {
  assert.equal(filterInputFromSearch('?filter=github'), 'github')
  assert.equal(filterInputFromSearch('?focusFilter=1&filter=qa+env'), 'qa env')
  assert.equal(urlForFilterInput('github', { pathname: '/index.html', search: '?focusFilter=1', hash: '#top' }), '/index.html?focusFilter=1&filter=github#top')
  assert.equal(urlForFilterInput('', { pathname: '/index.html', search: '?filter=github&focusFilter=1', hash: '' }), '/index.html?focusFilter=1')
  assert.equal(urlForFilterInput('qa env', { pathname: '/index.html', search: '', hash: '' }), '/index.html?filter=qa+env')
})

test('filter focus shortcut matches Cmd+K on macOS and Ctrl+K elsewhere', () => {
  assert.equal(isFilterFocusShortcut({ key: 'k', metaKey: true }, 'MacIntel'), true)
  assert.equal(isFilterFocusShortcut({ key: 'K', ctrlKey: true }, 'Win32'), true)
  assert.equal(isFilterFocusShortcut({ key: 'k', ctrlKey: true }, 'Linux x86_64'), true)
  assert.equal(isFilterFocusShortcut({ key: 'k', ctrlKey: true }, 'MacIntel'), false)
  assert.equal(isFilterFocusShortcut({ key: 'k', metaKey: true }, 'Win32'), false)
  assert.equal(isFilterFocusShortcut({ key: 'k', metaKey: true, shiftKey: true }, 'MacIntel'), false)
  assert.equal(isFilterFocusShortcut({ key: 'j', metaKey: true }, 'MacIntel'), false)
})

test('filter focus pending input adopts the pre-app value and releases its listener', () => {
  const originalWindow = globalThis.window
  let releaseCount = 0
  const bootWindow = {
    __tabOutFilterFocusBootValue: 'git',
    __tabOutReleaseFilterFocusBoot: () => { releaseCount += 1 }
  }
  globalThis.window = bootWindow as unknown as Window & typeof globalThis
  try {
    assert.equal(readFilterFocusPendingInput(''), 'git')
    assert.equal(readFilterFocusPendingInput('docs'), 'git')
    releaseFilterFocusBootValue()
    assert.equal(releaseCount, 1)
    assert.equal('__tabOutFilterFocusBootValue' in bootWindow, false)
    assert.equal('__tabOutReleaseFilterFocusBoot' in bootWindow, false)
    assert.equal(readFilterFocusPendingInput('docs'), 'docs')
  } finally {
    globalThis.window = originalWindow
  }
  assert.equal(readFilterFocusPendingInput('docs'), 'docs')
})

test('filtering ignores Tab Out keywords injected by the active filter title and URL', () => {
  const groups = buildDomainGroups([
    makeTab({
      url: 'chrome-extension://tab-out/index.html?filter=github',
      rawUrl: 'chrome-extension://tab-out/index.html?filter=github',
      title: 'github - Tab Out',
      isTabOut: true
    }),
    makeTab({ id: 2, url: 'https://openai.com/', title: 'OpenAI' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'github'
  })

  assert.equal(vm.stats.visibleTabs, 0)
  assert.equal(vm.matchedCards.length, 0)
})

test('normalizeTabHistorySnapshot keeps command target markers stable', () => {
  const snapshot = normalizeTabHistorySnapshot({
    stackSize: 3,
    maxSize: 24,
    cursorIndex: 2,
    currentIndex: 1,
    previousIndex: 0,
    nextIndex: 2,
    activeTabId: 12,
    activeWindowId: 1,
    entries: [
      { index: 0, tabId: 11, windowId: 1, title: 'Alpha', displayUrl: 'alpha.example', exists: true, previousTarget: true },
      { index: 1, tabId: 12, windowId: 1, title: 'Bravo', displayUrl: 'bravo.example', exists: true, active: true, current: true },
      { index: 2, tabId: 13, windowId: 1, title: 'Charlie', displayUrl: 'charlie.example', exists: true, activeInOtherWindow: true, cursor: true, nextTarget: true }
    ] as any
  })

  assert.equal(snapshot.stackSize, 3)
  assert.equal(snapshot.currentIndex, 1)
  assert.equal(snapshot.previousIndex, 0)
  assert.equal(snapshot.nextIndex, 2)
  assert.equal(snapshot.activeTabId, 12)
  assert.equal(atOrThrow(snapshot.entries, 0).previousTarget, true)
  assert.equal(atOrThrow(snapshot.entries, 1).current, true)
  assert.equal(atOrThrow(snapshot.entries, 1).active, true)
  assert.equal(atOrThrow(snapshot.entries, 2).cursor, true)
  assert.equal(atOrThrow(snapshot.entries, 2).activeInOtherWindow, true)
  assert.equal(atOrThrow(snapshot.entries, 2).nextTarget, true)
})

test('normalizeTabHistorySnapshot resolves live history favicons from Chrome tab state or cache', () => {
  const snapshot = normalizeTabHistorySnapshot({
    entries: [
      {
        index: 0,
        tabId: 11,
        windowId: 1,
        title: 'Alpha',
        url: 'https://alpha.example/docs',
        favIconUrl: '',
        exists: true
      },
      {
        index: 1,
        tabId: 12,
        windowId: 1,
        title: 'Bravo',
        url: 'https://bravo.example/docs',
        favIconUrl: 'data:image/png;base64,abc',
        exists: true
      }
    ] as any
  })

  assert.equal(atOrThrow(snapshot.entries, 0).favIconUrl, 'chrome-extension://tab-out/_favicon/?pageUrl=https%3A%2F%2Falpha.example%2Fdocs&size=32')
  assert.equal(atOrThrow(snapshot.entries, 1).favIconUrl, 'data:image/png;base64,abc')
})

test('normalizeTabHistorySnapshot resolves suspended-row favicons from the original url, not the suspender-faded copy', () => {
  const snapshot = normalizeTabHistorySnapshot({
    entries: [
      {
        index: 0,
        tabId: 21,
        windowId: 1,
        title: 'Charlie',
        url: 'https://charlie.example/docs',
        rawUrl: 'chrome-extension://suspenderid/suspended.html#ttl=Charlie&uri=https://charlie.example/docs',
        favIconUrl: 'data:image/png;base64,faded',
        exists: true
      }
    ] as any
  })

  assert.equal(atOrThrow(snapshot.entries, 0).favIconUrl, 'chrome-extension://tab-out/_favicon/?pageUrl=https%3A%2F%2Fcharlie.example%2Fdocs&size=32')
})

test('normalizeTabHistorySnapshot falls back to Chrome favicon cache for suspended rows without a tab favicon', () => {
  const snapshot = normalizeTabHistorySnapshot({
    entries: [
      {
        index: 0,
        tabId: 21,
        windowId: 1,
        title: 'Charlie',
        url: 'https://charlie.example/docs',
        rawUrl: 'chrome-extension://suspenderid/suspended.html#ttl=Charlie&uri=https://charlie.example/docs',
        favIconUrl: '',
        exists: true
      }
    ] as any
  })

  assert.equal(atOrThrow(snapshot.entries, 0).favIconUrl, 'chrome-extension://tab-out/_favicon/?pageUrl=https%3A%2F%2Fcharlie.example%2Fdocs&size=32')
})

test('normalizeTabHistorySnapshot honors the explicit suspended flag over url comparison', () => {
  const snapshot = normalizeTabHistorySnapshot({
    entries: [
      {
        index: 0,
        tabId: 22,
        windowId: 1,
        title: 'Delta',
        url: 'https://delta.example/docs',
        suspended: true,
        favIconUrl: 'data:image/png;base64,faded',
        exists: true
      }
    ] as any
  })

  assert.equal(atOrThrow(snapshot.entries, 0).suspended, true)
  assert.equal(atOrThrow(snapshot.entries, 0).favIconUrl, 'chrome-extension://tab-out/_favicon/?pageUrl=https%3A%2F%2Fdelta.example%2Fdocs&size=32')
})

test('flattenBookmarkNodes turns bookmark tree nodes into read-only dashboard items', () => {
  const bookmarks = flattenBookmarkNodes([
    {
      id: '1',
      title: 'Root',
      children: [
        { id: '2', title: 'OpenAI', url: 'https://openai.com/' },
        {
          id: '3',
          title: 'Nested',
          children: [{ id: '4', title: 'GitHub', url: 'https://github.com/' }]
        }
      ]
    }
  ])

  assert.deepEqual(
    bookmarks.map((bookmark) => ({ url: bookmark.url, sourceType: bookmark.sourceType })),
    [
      { url: 'https://openai.com/', sourceType: 'bookmark' },
      { url: 'https://github.com/', sourceType: 'bookmark' }
    ]
  )
})

test('flattenHistoryItems turns Chrome history items into read-only dashboard items', () => {
  const historyItems = flattenHistoryItems([
    { id: '1', title: 'OpenAI Docs', url: 'https://openai.com/docs' },
    { id: '2', title: 'Chrome internal', url: 'chrome://settings' }
  ])

  assert.deepEqual(
    historyItems.map((item) => ({ url: item.url, sourceType: item.sourceType })),
    [{ url: 'https://openai.com/docs', sourceType: 'history' }]
  )
})

test('history range options default to the last day search window', () => {
  assert.equal(DEFAULT_HISTORY_RANGE, '1d')
  assert.deepEqual(
    HISTORY_RANGE_OPTIONS.map((option) => option.value),
    [HISTORY_FILTER_OFF, '1d', '7d', '30d', '90d', '180d', '365d', 'all']
  )
  assert.equal(expectDefined(HISTORY_RANGE_OPTIONS.find((option) => option.value === DEFAULT_HISTORY_RANGE)).days, 1)
})

test('history source sends the raw trimmed filter text to Chrome history search', async () => {
  const originalHistory = (globalThis.chrome as any).history
  let searchedText = ''
  ;(globalThis.chrome as any).history = {
    async search(query: any) {
      searchedText = query.text
      return [{ id: '1', title: 'Pull Request review', url: 'https://github.com/example/repo/pull/4706' }]
    }
  }

  try {
    const { tabs: items } = await fetchHistorySourceSearch(' github "pull request" 4706 ', '7d')
    assert.equal(searchedText, 'github "pull request" 4706')
    assert.deepEqual(items.map((item) => item.sourceType), ['history'])
  } finally {
    if (originalHistory === undefined) delete (globalThis.chrome as any).history
    else (globalThis.chrome as any).history = originalHistory
  }
})

test('history source keeps search failures distinct from zero matches', async () => {
  const originalHistory = (globalThis.chrome as any).history
  ;(globalThis.chrome as any).history = {
    async search() {
      throw new Error('History unavailable')
    }
  }

  try {
    const result = await fetchHistorySourceSearch('example', '7d')
    assert.deepEqual(result, { status: 'error', tabs: [] })
  } finally {
    if (originalHistory === undefined) delete (globalThis.chrome as any).history
    else (globalThis.chrome as any).history = originalHistory
  }
})

test('history search status copy distinguishes visible, deduped, empty, and updating results', () => {
  assert.deepEqual(historySearchStatusCopy({
    phase: 'ready',
    totalMatches: 4,
    visibleMatches: 2,
    dedupedMatches: 2
  }), {
    title: '2 shown in Tabs',
    detail: '2 of 4 returned matches appear below.'
  })
  assert.deepEqual(historySearchStatusCopy({
    phase: 'ready',
    totalMatches: 3,
    visibleMatches: 0,
    dedupedMatches: 3
  }), {
    title: '3 shown in Tabs',
    detail: 'No returned matches repeated below.'
  })
  assert.deepEqual(historySearchStatusCopy({
    phase: 'ready',
    totalMatches: 0,
    visibleMatches: 0,
    dedupedMatches: 0
  }), {
    title: 'No returned History matches',
    detail: 'Try a wider range.'
  })
  assert.deepEqual(historySearchStatusCopy({
    phase: 'updating',
    totalMatches: 1,
    visibleMatches: 1,
    dedupedMatches: 0
  }), {
    title: '1 returned History match',
    detail: 'Updating…'
  })
  assert.deepEqual(historySearchStatusCopy({
    phase: 'error',
    totalMatches: 1,
    visibleMatches: 1,
    dedupedMatches: 0
  }), {
    title: 'History update failed',
    detail: 'Previous results remain below.'
  })
})

test('history filter off skips Chrome history search', async () => {
  assert.equal(isHistoryFilterEnabled(HISTORY_FILTER_OFF), false)

  const originalHistory = (globalThis.chrome as any).history
  let searched = false
  ;(globalThis.chrome as any).history = {
    async search() {
      searched = true
      return [{ id: '1', title: 'OpenAI Docs', url: 'https://openai.com/docs' }]
    }
  }

  try {
    const { tabs: items } = await fetchHistorySourceSearch('openai', HISTORY_FILTER_OFF)
    assert.deepEqual(items, [])
    assert.equal(searched, false)
  } finally {
    if (originalHistory === undefined) delete (globalThis.chrome as any).history
    else (globalThis.chrome as any).history = originalHistory
  }
})

test('all-time history search starts at the Unix epoch', async () => {
  const originalHistory = (globalThis.chrome as any).history
  let searchQuery: any
  ;(globalThis.chrome as any).history = {
    async search(query: any) {
      searchQuery = query
      return []
    }
  }

  try {
    await fetchHistorySourceSearch('example', 'all')
    assert.equal(searchQuery.text, 'example')
    assert.equal(searchQuery.maxResults, 100)
    assert.equal(searchQuery.startTime, 0)
  } finally {
    if (originalHistory === undefined) delete (globalThis.chrome as any).history
    else (globalThis.chrome as any).history = originalHistory
  }
})

test('filter search request owns bookmark and history inclusion rules', () => {
  assert.deepEqual(
    buildFilterSearchRequest({
      source: 'tabs',
      filter: ' openai ',
      historyRange: '7d',
      historyFilterEnabled: true
    }),
    {
      query: ' openai ',
      historyQuery: 'openai',
      historyRange: '7d',
      includeBookmarkMatches: true,
      includeHistoryMatches: true
    }
  )

  assert.deepEqual(
    buildFilterSearchRequest({
      source: 'bookmarks',
      filter: 'openai',
      historyRange: '7d',
      historyFilterEnabled: true
    }),
    {
      query: 'openai',
      historyQuery: '',
      historyRange: '7d',
      includeBookmarkMatches: false,
      includeHistoryMatches: false
    }
  )

  assert.deepEqual(
    buildFilterSearchRequest({
      source: 'tabs',
      filter: '   ',
      historyRange: '7d',
      historyFilterEnabled: true
    }),
    {
      query: '   ',
      historyQuery: '',
      historyRange: '7d',
      includeBookmarkMatches: false,
      includeHistoryMatches: false
    }
  )
})

test('history range changes retain same-query results while requiring an exact refresh', () => {
  const historyTabs = [
    makeTab({
      id: 2,
      sourceType: 'history',
      title: 'OpenAI Docs',
      url: 'https://example.test/openai'
    })
  ]
  const dashboard = {
    realTabs: [],
    domainGroups: [],
    bookmarkSearchReady: true,
    historyTabs,
    historyDomainGroups: buildDomainGroups(historyTabs),
    historySearchQuery: 'openai',
    historyRange: '1d'
  }
  const options = {
    source: 'tabs' as const,
    filter: 'openai',
    historyRange: '7d',
    historyFilterEnabled: true
  }

  assert.equal(canUseHistorySearchResults(dashboard, options), false)
  assert.equal(canDisplayHistorySearchResults(dashboard, options), true)
  assert.equal(dashboardNeedsFilterSearchRefresh(dashboard, options), true)
  const stale = renderHookValue(() => useDashboardViewModels({
    dashboard,
    ...options,
    isReady: true,
    chipOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }))
  assert.equal(stale.historyResultsFilter, 'openai')
  assert.deepEqual(stale.historyMatchedCards.map(({ group }) => group.domain), ['example.test'])
  assert.equal(stale.showHistoryMatches, true)
  assert.deepEqual(stale.historySearchSummary, {
    phase: 'updating',
    totalMatches: 1,
    visibleMatches: 1,
    dedupedMatches: 0
  })
  assert.equal(
    canDisplayHistorySearchResults(dashboard, {
      ...options,
      filter: 'github'
    }),
    false
  )
  assert.equal(
    dashboardNeedsFilterSearchRefresh(dashboard, {
      ...options,
      historyFilterEnabled: false
    }),
    false
  )
  assert.equal(
    canDisplayHistorySearchResults(dashboard, {
      ...options,
      historyFilterEnabled: false
    }),
    false
  )
})

test('failed history searches settle without becoming usable result snapshots', () => {
  const dashboard = {
    realTabs: [],
    domainGroups: [],
    bookmarkSearchReady: true,
    historyTabs: [],
    historyDomainGroups: [],
    historySearchQuery: 'example',
    historyRange: '7d',
    historySearchStatus: 'error' as const
  }
  const options = {
    source: 'tabs' as const,
    filter: 'example',
    historyRange: '7d',
    historyFilterEnabled: true
  }

  assert.equal(isHistorySearchRequestSettled(dashboard, options), true)
  assert.equal(canUseHistorySearchResults(dashboard, options), false)
  assert.equal(dashboardNeedsFilterSearchRefresh(dashboard, options), false)

  const failed = renderHookValue(() => useDashboardViewModels({
    dashboard,
    ...options,
    historySearchPending: false,
    isReady: true,
    chipOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }))
  assert.deepEqual(failed.historySearchSummary, {
    phase: 'error',
    totalMatches: 0,
    visibleMatches: 0,
    dedupedMatches: 0
  })

  const retrying = renderHookValue(() => useDashboardViewModels({
    dashboard,
    ...options,
    historySearchPending: true,
    isReady: true,
    chipOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }))
  assert.equal(retrying.historySearchSummary?.phase, 'searching')
})

test('failed same-query history refreshes retain the previous result candidates', () => {
  const historyTab = makeTab({
    id: 'history-previous',
    sourceType: 'history',
    title: 'Previous History result',
    url: 'https://history-previous.test/docs'
  })
  const previous = {
    realTabs: [],
    domainGroups: [],
    historyTabs: [historyTab],
    historyDomainGroups: buildDomainGroups([historyTab]),
    historySearchQuery: 'history',
    historyRange: '1d',
    historySearchStatus: 'ready' as const
  }
  const next = {
    realTabs: [],
    domainGroups: [],
    historyTabs: [],
    historyDomainGroups: [],
    historySearchQuery: 'history',
    historyRange: '7d',
    historySearchStatus: 'error' as const
  }

  const retained = retainHistorySearchResultsOnError(next, previous)
  assert.equal(retained.historyRange, '7d')
  assert.equal(retained.historySearchStatus, 'error')
  assert.deepEqual(retained.historyTabs, [historyTab])
  assert.deepEqual(retained.historyDomainGroups, previous.historyDomainGroups)
  const retainedAfterRetryFailure = retainHistorySearchResultsOnError(
    { ...next, historyRange: '30d' },
    retained
  )
  assert.equal(retainedAfterRetryFailure.historyRange, '30d')
  assert.deepEqual(retainedAfterRetryFailure.historyTabs, [historyTab])
  assert.deepEqual(retainedAfterRetryFailure.historyDomainGroups, previous.historyDomainGroups)
  assert.equal(
    retainHistorySearchResultsOnError(
      { ...next, historySearchQuery: 'another query' },
      previous
    ).historyTabs?.length,
    0
  )
})

test('a history result suppressed by an open tab appears immediately after that tab closes', async () => {
  const openTab = makeTab({
    id: 1,
    title: 'World Reference',
    url: 'https://priority.test/reference'
  })
  const historyTab = makeTab({
    id: 'history-reference',
    sourceType: 'history',
    title: 'World Reference',
    url: 'https://priority.test/reference'
  })
  const { dashboard } = await buildDashboardDataFromTabs(
    [openTab],
    1,
    new Map(),
    {
      includeBookmarkMatches: true,
      includeHistoryMatches: true,
      searchQuery: 'world',
      historyRange: '7d',
      historyTabs: [historyTab]
    }
  )
  const options = {
    source: 'tabs' as const,
    filter: 'world',
    historyRange: '7d',
    historyFilterEnabled: true,
    isReady: true,
    chipOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }
  const open = renderHookValue(() => useDashboardViewModels({
    dashboard,
    ...options
  }))
  assert.equal(open.matchedCards.length, 1)
  assert.equal(open.showHistoryMatches, false)
  assert.deepEqual(open.historySearchSummary, {
    phase: 'ready',
    totalMatches: 1,
    visibleMatches: 0,
    dedupedMatches: 1
  })

  const afterClose = renderHookValue(() => useDashboardViewModels({
    dashboard: {
      ...dashboard,
      realTabs: [],
      domainGroups: []
    },
    ...options
  }))
  assert.deepEqual(afterClose.historyMatchedCards.map(({ group }) => group.domain), ['priority.test'])
  assert.equal(afterClose.showHistoryMatches, true)
  assert.deepEqual(afterClose.historySearchSummary, {
    phase: 'ready',
    totalMatches: 1,
    visibleMatches: 1,
    dedupedMatches: 0
  })
})

test('filter companion results dedupe by tabs, then history, then bookmarks', async () => {
  const bookmarkTabs = flattenBookmarkNodes([
    {
      id: 'root',
      title: 'Bookmarks',
      children: [
        { id: 'b1', title: 'World Open Bookmark', url: 'https://priority.test/open' },
        { id: 'b2', title: 'World History Bookmark', url: 'https://priority.test/history' },
        { id: 'b3', title: 'World Bookmark', url: 'https://priority.test/bookmark' }
      ]
    }
  ])
  const historyTabs = flattenHistoryItems([
    { id: 'h1', title: 'World Open History', url: 'https://priority.test/open' },
    { id: 'h2', title: 'World History', url: 'https://priority.test/history' }
  ])
  const { dashboard } = await buildDashboardDataFromTabs(
    [makeTab({ url: 'https://priority.test/open', title: 'World Open' })],
    1,
    new Map(),
    {
      includeBookmarkMatches: true,
      includeHistoryMatches: true,
      searchQuery: 'world',
      historyRange: '7d',
      bookmarkTabs,
      historyTabs
    }
  )

  assert.deepEqual(
    dashboard.historyTabs.map((tab) => tab.url),
    ['https://priority.test/open', 'https://priority.test/history']
  )
  assert.deepEqual(
    dashboard.bookmarkTabs.map((tab) => tab.url),
    ['https://priority.test/open', 'https://priority.test/history', 'https://priority.test/bookmark']
  )
  const viewModels = renderHookValue(() => useDashboardViewModels({
    dashboard,
    source: 'tabs',
    filter: 'world',
    historyRange: '7d',
    historyFilterEnabled: true,
    isReady: true,
    chipOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }))
  assert.deepEqual(
    viewModels.historyMatchedCards.flatMap(({ group }) => group.tabs.map((tab) => tab.url)),
    ['https://priority.test/history']
  )
  assert.deepEqual(
    viewModels.bookmarkMatchedCards.flatMap(({ group }) => group.tabs.map((tab) => tab.url)),
    ['https://priority.test/bookmark']
  )
  assert.deepEqual(viewModels.historySearchSummary, {
    phase: 'ready',
    totalMatches: 2,
    visibleMatches: 1,
    dedupedMatches: 1
  })
})

test('deleteHistorySourceUrl deletes a URL from Chrome history', async () => {
  const originalHistory = (globalThis.chrome as any).history
  let deletedUrl = ''
  ;(globalThis.chrome as any).history = {
    async deleteUrl(details: any) {
      deletedUrl = details.url
    }
  }

  try {
    assert.equal(await deleteHistorySourceUrl('https://openai.com/docs'), true)
    assert.equal(deletedUrl, 'https://openai.com/docs')
    assert.equal(await deleteHistorySourceUrl(''), false)
  } finally {
    if (originalHistory === undefined) delete (globalThis.chrome as any).history
    else (globalThis.chrome as any).history = originalHistory
  }
})

test('buildDashboardViewModel disables destructive actions for bookmarks source', () => {
  const groups = buildDomainGroups([
    makeTab({ url: 'https://bookmarks.test/a', title: 'Bookmark A', sourceType: 'bookmark' }),
    makeTab({ id: 2, url: 'https://bookmarks.test/b', title: 'Bookmark B', sourceType: 'bookmark' })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const vm = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    source: 'bookmarks'
  })

  assert.equal(vm.source, 'bookmarks')
  assert.equal(vm.stats.dedupCount, 0)
  assert.deepEqual(vm.filteredCloseUrls, [])
  const matchedCard = atOrThrow(vm.matchedCards, 0)
  assert.equal(matchedCard.vm.closableCount, 0)
  assert.equal(matchedCard.vm.tabCountTitle, '2 bookmarks')
  assert.equal(firstSection(matchedCard.vm).flatVisibleChips.every((chip) => chip.sourceType === 'bookmark'), true)
})

test('combined tab and bookmark search keeps bookmark matches read-only', () => {
  const tabGroups = buildDomainGroups([
    makeTab({ url: 'https://openai.com/docs', title: 'OpenAI Docs' }),
    makeTab({ id: 2, url: 'https://example.com/', title: 'Example' })
  ])
  const bookmarkGroups = buildDomainGroups([
    makeTab({ id: 'b1', url: 'https://openai.com/research', title: 'OpenAI Research', sourceType: 'bookmark' }),
    makeTab({ id: 'b2', url: 'https://github.com/', title: 'GitHub', sourceType: 'bookmark' })
  ])

  const tabsVm = buildDashboardViewModel({
    realTabs: tabGroups.flatMap((group) => group.tabs),
    domainGroups: tabGroups,
    filter: 'openai',
    source: 'tabs'
  })
  const bookmarksVm = buildDashboardViewModel({
    realTabs: bookmarkGroups.flatMap((group) => group.tabs),
    domainGroups: bookmarkGroups,
    filter: 'openai',
    source: 'bookmarks'
  })

  assert.deepEqual(tabsVm.filteredCloseUrls, ['https://openai.com/docs'])
  assert.equal(tabsVm.matchedCards.length, 1)
  assert.equal(tabsVm.unmatchedCards.length, 1)
  assert.deepEqual(bookmarksVm.filteredCloseUrls, [])
  assert.equal(bookmarksVm.matchedCards.length, 1)
  assert.equal(bookmarksVm.unmatchedCards.length, 1)
  const matchedBookmarkCard = atOrThrow(bookmarksVm.matchedCards, 0)
  assert.equal(matchedBookmarkCard.vm.closableCount, 0)
  assert.equal(matchedBookmarkCard.vm.tabCountTitle, '1 of 1 bookmark shown while filtering')
  assert.equal(atOrThrow(firstSection(matchedBookmarkCard.vm).flatVisibleChips, 0).sourceType, 'bookmark')
})

test('history search matches are not tab-closable dashboard results', () => {
  const historyGroups = buildDomainGroups([
    makeTab({ id: 'h1', url: 'https://openai.com/docs', title: 'OpenAI Docs', sourceType: 'history' }),
    makeTab({ id: 'h2', url: 'https://example.com/', title: 'Example', sourceType: 'history' })
  ])

  const vm = buildDashboardViewModel({
    realTabs: historyGroups.flatMap((group) => group.tabs),
    domainGroups: historyGroups,
    filter: 'openai',
    source: 'history'
  })

  assert.equal(vm.stats.dedupCount, 0)
  assert.deepEqual(vm.filteredCloseUrls, [])
  assert.equal(vm.matchedCards.length, 1)
  assert.equal(vm.unmatchedCards.length, 1)
  const matchedCard = atOrThrow(vm.matchedCards, 0)
  assert.equal(matchedCard.vm.closableCount, 0)
  assert.equal(matchedCard.vm.tabCountTitle, '1 of 1 history result shown while filtering')
  assert.equal(atOrThrow(firstSection(matchedCard.vm).flatVisibleChips, 0).sourceType, 'history')
})

test('closed saved pages stay searchable without counting as open tabs or close targets', () => {
  const groups = buildDomainGroups([
    makeTab({ id: 1, url: 'https://example.test/open', title: 'Open tab' }),
    makeTab({
      id: 'saved-1',
      url: 'https://example.test/saved',
      title: 'Saved reference',
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true
    })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const unfiltered = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    source: 'tabs'
  })
  const unfilteredCard = atOrThrow(unfiltered.matchedCards, 0)
  assert.equal(unfiltered.stats.totalTabs, 1)
  assert.equal(unfiltered.stats.visibleTabs, 1)
  assert.equal(unfilteredCard.vm.tabCountLabel, '1 + 1 closed')
  assert.equal(unfilteredCard.vm.closableCount, 1)
  assert.deepEqual(
    sectionsOf(unfilteredCard.vm).flatMap((section) => section.sectionClosableUrls),
    ['https://example.test/open']
  )
  assert.deepEqual(unfiltered.globalDedupeUrls, [])

  const filtered = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'reference',
    source: 'tabs'
  })
  const filteredCard = atOrThrow(filtered.matchedCards, 0)
  assert.equal(filtered.stats.visibleTabs, 0)
  assert.equal(filtered.matchedCards.length, 1)
  assert.equal(filteredCard.vm.tabCountLabel, '1 closed')
  assert.deepEqual(filtered.filteredCloseUrls, [])
  assert.equal(atOrThrow(firstSection(filteredCard.vm).flatVisibleChips, 0).sourceType, 'saved-page')
  const unmatchedCard = atOrThrow(filtered.unmatchedCards, 0)
  assert.deepEqual(
    firstSection(unmatchedCard.vm).flatVisibleChips.map((chip) => chip.sourceType),
    ['tab']
  )
  assert.equal(
    filtered.unmatchedCards.flatMap(({ vm }) => sectionsOf(vm))
      .flatMap((section) => section.flatVisibleChips)
      .some((chip) => chip.sourceType === 'saved-page' || chip.sourceType === 'retained-page'),
    false
  )
})

test('filtered saved-only cards show the matched closed-page fraction in their badge', () => {
  const groups = buildDomainGroups([
    makeTab({ id: 1, url: 'https://example.test/open', title: 'Open tab' }),
    makeTab({ id: 'saved-1', url: 'https://example.test/saved-1', title: 'Matching reference one', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 'saved-2', url: 'https://example.test/saved-2', title: 'Matching reference two', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 'saved-3', url: 'https://example.test/saved-3', title: 'Other saved page', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 'saved-4', url: 'https://example.test/saved-4', title: 'Another saved page', sourceType: 'saved-page', saved: true, closedSaved: true })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const filtered = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'matching reference',
    source: 'tabs'
  })

  assert.equal(filtered.matchedCards.length, 1)
  const matchedCard = atOrThrow(filtered.matchedCards, 0)
  assert.equal(matchedCard.vm.tabCountLabel, '2/4 closed')
  assert.equal(matchedCard.vm.tabCountTitle, '0 of 1 open tab shown while filtering, 2 of 4 closed pages shown while filtering')
})

test('filtered cards show the closed-page fraction alongside their open-tab count', () => {
  const groups = buildDomainGroups([
    makeTab({ id: 1, url: 'https://example.test/open-match', title: 'Matching open tab' }),
    makeTab({ id: 2, url: 'https://example.test/open-other', title: 'Other open tab' }),
    makeTab({ id: 'saved-1', url: 'https://example.test/saved-1', title: 'Matching saved page one', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 'saved-2', url: 'https://example.test/saved-2', title: 'Matching saved page two', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 'saved-3', url: 'https://example.test/saved-3', title: 'Other saved page', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 'saved-4', url: 'https://example.test/saved-4', title: 'Another saved page', sourceType: 'saved-page', saved: true, closedSaved: true })
  ])
  const realTabs = groups.flatMap((group) => group.tabs)

  const filtered = buildDashboardViewModel({
    realTabs,
    domainGroups: groups,
    filter: 'matching',
    source: 'tabs'
  })

  assert.equal(filtered.matchedCards.length, 1)
  const matchedCard = atOrThrow(filtered.matchedCards, 0)
  assert.equal(matchedCard.vm.tabCountLabel, '1/2 + 2/4 closed')
  assert.equal(matchedCard.vm.tabCountTitle, '1 of 2 open tabs shown while filtering, 2 of 4 closed pages shown while filtering')
})

test('New tabs bulk-close scopes exclude pinned physical copies in card and section counts', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const group = atOrThrow(buildDomainGroups([
    makeTab({ id: 1, url: tabOutUrl, title: 'Pinned Tab Out', isTabOut: true, pinned: true }),
    makeTab({ id: 2, url: tabOutUrl, title: 'Ordinary Tab Out', isTabOut: true })
  ]), 0)

  const vm = computeDomainCardViewModel(group)

  assert.equal(vm.closableCount, 1)
  assert.deepEqual(sectionsOf(vm).flatMap((section) => section.sectionClosableUrls), [tabOutUrl])
})

test('closed saved pages render after open tabs within their domain card scope', () => {
  const groups = buildDomainGroups([
    makeTab({ id: 'saved-1', url: 'https://example.test/a-saved', title: 'Alpha Saved', sourceType: 'saved-page', saved: true, closedSaved: true }),
    makeTab({ id: 2, url: 'https://example.test/z-open', title: 'Zulu Open' })
  ])

  const vm = computeDomainCardViewModel(atOrThrow(groups, 0))
  assert.deepEqual(
    firstSection(vm).flatVisibleChips.map((chip) => chip.tabUrl),
    ['https://example.test/z-open', 'https://example.test/a-saved']
  )
})

test('buildDomainGroups keeps saved-only cards after cards with open tabs despite previous order', () => {
  const groups = buildDomainGroups(
    [
      makeTab({ id: 'saved-1', url: 'https://saved-only.test/a', title: 'Saved only', sourceType: 'saved-page', saved: true, closedSaved: true }),
      makeTab({ id: 2, url: 'https://open-tabs.test/z', title: 'Open tab' })
    ],
    {
      previousOrder: new Map([
        ['domain-saved-only.test', 0],
        ['domain-open-tabs.test', 1]
      ])
    }
  )

  assert.deepEqual(
    groups.map((group) => group.domain),
    ['open-tabs.test', 'saved-only.test']
  )
})

test('manifest keeps only the permissions used by the extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.permissions, [
    'tabs',
    'tabGroups',
    'bookmarks',
    'history',
    'sessions',
    'storage',
    'alarms',
    'favicon',
    'system.display',
    'nativeMessaging'
  ])
  assert.equal(manifest.incognito, 'not_allowed')
  assert.equal(manifest.commands['switch-to-last-tab'].description, 'Switch to the previous tab in global activation history')
  assert.equal(manifest.commands['switch-to-next-tab'].description, 'Switch forward to the next tab in global activation history')
  assert.equal(manifest.commands['open-filter-tab'].description, 'Open Tab Out with the filter focused')
  assert.equal(manifest.commands['open-new-tab'].description, 'Open a new Tab Out tab')
  assert.equal('global' in manifest.commands['open-new-tab'], false)
  assert.deepEqual(Object.keys(manifest.commands), [
    'switch-to-last-tab',
    'switch-to-next-tab',
    'open-filter-tab',
    'open-new-tab'
  ])
})

function installSavedPagesStorageProbe(initialStore: unknown) {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  const restoreLocks = installWebLocksStub()
  const state = { reads: 0, writes: 0, stored: initialStore }
  ;(globalThis as any).chrome = {
    ...(previousChrome as object),
    storage: {
      local: {
        get: async (key: string) => {
          if (key === SAVED_PAGES_STORAGE_KEY) state.reads += 1
          return { [key]: state.stored }
        },
        set: async (values: Record<string, unknown>) => {
          if (SAVED_PAGES_STORAGE_KEY in values) {
            state.writes += 1
            state.stored = values[SAVED_PAGES_STORAGE_KEY]
          }
        }
      }
    }
  }
  return {
    state,
    restore: () => {
      ;(globalThis as { chrome?: unknown }).chrome = previousChrome
      restoreLocks()
    }
  }
}

async function drainSavedPagesWrites(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await delay(0)
  }
}

function staleSavedPageStore(savedUrl: string) {
  return addSavedPageToStore(emptySavedPagesStore(), {
    url: savedUrl,
    rawUrl: savedUrl,
    title: 'Stale saved title',
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 100)
}

test('buildDashboardDataFromTabs returns saved page metadata updates instead of persisting them', async () => {
  const savedUrl = 'https://example.com/docs'
  const baseStore = staleSavedPageStore(savedUrl)
  const probe = installSavedPagesStorageProbe(baseStore)
  try {
    const build = await buildDashboardDataFromTabs(
      [makeTab({ url: savedUrl, title: 'Fresh page title' })],
      1,
      new Map(),
      { savedPagesStore: baseStore }
    )
    await drainSavedPagesWrites()

    assert.deepEqual(build.dashboard.realTabs.map((tab) => tab.url), [savedUrl])
    assert.equal(build.savedPageUpdates.base.pages[savedUrl]?.title, 'Stale saved title')
    assert.equal(build.savedPageUpdates.merged.pages[savedUrl]?.title, 'Fresh page title')
    assert.equal(probe.state.reads, 0, 'a pure build must not read Saved Pages storage')
    assert.equal(probe.state.writes, 0, 'a pure build must not write Saved Pages storage')
  } finally {
    probe.restore()
  }
})

test('fetchDashboardData heals changed Saved Page metadata with a single storage write', async () => {
  const savedUrl = 'https://example.com/docs'
  const baseStore = staleSavedPageStore(savedUrl)
  const probe = installSavedPagesStorageProbe(baseStore)
  try {
    const dashboard = await fetchDashboardData(new Map(), 'tabs', {
      dashboardTabs: [makeTab({ url: savedUrl, title: 'Fresh page title' })],
      currentWindowId: 1,
      savedPagesStore: baseStore
    })
    await drainSavedPagesWrites()

    assert.equal(dashboard.realTabs[0]?.saved, true)
    assert.equal(probe.state.writes, 1, 'one changed merge is one Saved Pages write')
    assert.equal((probe.state.stored as { pages?: Record<string, { title?: string }> })?.pages?.[savedUrl]?.title, 'Fresh page title')
  } finally {
    probe.restore()
  }
})
