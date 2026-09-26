import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDomainCardViewModel } from '../src/extension/domain-card-view-model.js'
import { titleForFilterInput } from '../src/extension/app-url.js'
import { TAB_OUT_FAVICON_URL } from '../src/extension/tab-out-url.js'
import { domainCardId } from '../src/extension/domain-card-id.js'
import type { MissionOrderMap } from '../src/extension/dashboard-intake.js'
import type { DomainGroup } from '../src/extension/types'
import { rememberMissionOrder, type DashboardChipOrderMemoryMap } from '../src/hooks/useDashboardViewModels.js'
import { collectDashboardChips, makeDashboardTab } from './helpers/domain-card-view-model.js'
import { sameTitlePageChipTargets } from './helpers/same-title-page-chip-plan.js'

test('two Jira URL forms of the same comment collapse into one closable duplicate', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
  const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [makeDashboardTab({ id: 1, url: longForm }), makeDashboardTab({ id: 2, url: shortForm })],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls, ['https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'])

  const jiraChips = collectDashboardChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 1)
})

test('different focused comments on the same issue are not treated as duplicates', () => {
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeDashboardTab({ id: 1, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100' }),
      makeDashboardTab({ id: 2, url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=200' }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

  assert.deepEqual(vm.closableDupeUrls ?? [], [])
  const jiraChips = collectDashboardChips(vm).filter((chip) => chip.tabUrl.includes('/browse/ABC-123'))
  assert.equal(jiraChips.length, 2)
})

test('multiple exact Saved targets sharing one canonical identity remain independently actionable', () => {
  const longForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const shortForm =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeDashboardTab({
        id: 'saved-long',
        url: longForm,
        title: 'Example issue',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: longForm,
      }),
      makeDashboardTab({
        id: 'saved-short',
        url: shortForm,
        title: 'Example issue',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: shortForm,
      }),
    ],
  }

  const vm = computeDomainCardViewModel(group)
  const [chip] = collectDashboardChips(vm)
  assert.ok(chip)
  const variants = sameTitlePageChipTargets(chip.sameTitlePageChipPlan)
  assert.equal(variants.length, 2)

  assert.equal(vm.tabCountLabel, '2 closed')
  assert.equal(chip.dupeCount, 1)
  assert.deepEqual(
    variants.map((variant) => ({
      savedPageKey: variant.savedPageKey,
      url: variant.tabUrl,
    })).toSorted((left, right) => left.url.localeCompare(right.url)),
    [
      { savedPageKey: longForm, url: longForm },
      { savedPageKey: shortForm, url: shortForm },
    ].toSorted((left, right) => left.url.localeCompare(right.url)),
  )
})

test('same-title plan rows keep repeated Exact Targets independently owned', () => {
  const repeatedUrl = 'https://example.test/content?state=alpha'
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 1,
        url: repeatedUrl,
        title: 'Shared title',
      }),
      makeDashboardTab({
        id: 'retained-alpha',
        url: repeatedUrl,
        title: 'Shared title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-alpha',
        retainedPageClosureToken: 'lifetime-alpha',
      }),
      makeDashboardTab({
        id: 2,
        url: 'https://example.test/content?state=bravo',
        title: 'Shared title',
      }),
    ],
  }

  const [chip] = collectDashboardChips(computeDomainCardViewModel(group))
  assert.ok(chip)
  const presentations = chip.sameTitlePageChipPlan?.view.rows ?? []
  const repeatedPresentations = presentations.filter((row) => row.copyUrl === repeatedUrl)

  assert.equal(presentations.length, 3)
  assert.equal(repeatedPresentations.length, 2)
  assert.ok(repeatedPresentations.every((row) => row.exactTargetCount === 1))
  assert.deepEqual(
    repeatedPresentations.map((row) => row.sourceType).toSorted(),
    ['retained-page', 'tab'],
  )
})

test('an invalid same-title plan falls back to separate Page Chips', () => {
  const url = 'https://example.test/content?state=alpha'
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 1,
        url,
        title: 'Shared title',
      }),
      makeDashboardTab({
        id: 'retained-alpha',
        url,
        title: 'Shared title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-alpha',
        retainedPageClosureToken: 'lifetime-alpha',
      }),
    ],
  }

  const chips = collectDashboardChips(computeDomainCardViewModel(group))

  assert.equal(chips.length, 2)
  assert.ok(chips.every((chip) => chip.sameTitlePageChipPlan === undefined))
  assert.deepEqual(chips.map((chip) => chip.sourceType).toSorted(), ['retained-page', 'tab'])
})

test('a closed Saved target does not inherit live state from a canonical-equivalent open tab', () => {
  const openUrl =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
  const savedUrl =
    'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  const group: DomainGroup = {
    domain: 'example.atlassian.net',
    tabs: [
      makeDashboardTab({
        id: 1,
        url: openUrl,
        title: 'Example issue',
        windowId: 2,
        active: true,
        suspended: true,
        status: 'loading',
        audible: true,
      }),
      makeDashboardTab({
        id: 'saved-exact',
        url: savedUrl,
        title: 'Example issue',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: savedUrl,
      }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const [groupedChip] = collectDashboardChips(vm)
  const savedVariant = sameTitlePageChipTargets(groupedChip?.sameTitlePageChipPlan).find(
    (variant) => variant.savedPageKey === savedUrl,
  )
  assert.ok(savedVariant)

  assert.equal(vm.tabCountLabel, '1 + 1 closed')
  assert.equal(savedVariant.dupeCount, 1)
  assert.equal(savedVariant.suspended, false)
  assert.equal(savedVariant.loading, false)
  assert.equal(savedVariant.activeChipFrame, false)
  assert.equal(savedVariant.activeInOtherWindow, false)
  assert.equal(savedVariant.audioState, null)
})

test('a retained row is one unique closed item without a duplicate count', () => {
  const url = 'https://example.test/article'
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 'retained-example',
        url,
        title: 'Example article',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-example',
        retainedPageClosureToken: 'lifetime-example',
      }),
    ],
  }

  const vm = computeDomainCardViewModel(group)
  const [chip] = collectDashboardChips(vm)
  assert.ok(chip)

  assert.equal(vm.tabCountLabel, '1 closed')
  assert.equal(vm.tabCountTitle, '0 open tabs, 1 closed page')
  assert.deepEqual(vm.closableDupeUrls, [])
  assert.equal(vm.closableExtras, 0)
  assert.equal(chip.sourceType, 'retained-page')
  assert.equal(chip.dupeCount, 1)
  assert.equal(chip.sameTitlePageChipPlan, undefined)
})

test('card removal targets include only exact retained snapshots in the matched scope', () => {
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: [
      makeDashboardTab({
        id: 1,
        url: 'https://example.test/live',
        title: 'Live page',
      }),
      makeDashboardTab({
        id: 2,
        url: 'https://example.test/grouped',
        title: 'Grouped live page',
        groupId: 42,
      }),
      makeDashboardTab({
        id: 'saved-page',
        url: 'https://example.test/saved',
        title: 'Saved page',
        sourceType: 'saved-page',
        saved: true,
        closedSaved: true,
        savedPageKey: 'https://example.test/saved',
      }),
      makeDashboardTab({
        id: 'retained-alpha',
        url: 'https://example.test/alpha',
        title: 'Shared retained title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-alpha',
        retainedPageClosureToken: 'lifetime-alpha',
      }),
      makeDashboardTab({
        id: 'retained-bravo',
        url: 'https://example.test/bravo',
        title: 'Shared retained title',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-bravo',
        retainedPageClosureToken: 'lifetime-bravo',
      }),
    ],
  }

  const unfiltered = computeDomainCardViewModel(group)
  assert.deepEqual(unfiltered.retainedPageRemovalTargets, [
    {
      retainedPageIdentity: 'identity-alpha',
      retainedPageClosureToken: 'lifetime-alpha',
    },
    {
      retainedPageIdentity: 'identity-bravo',
      retainedPageClosureToken: 'lifetime-bravo',
    },
  ])
  assert.equal(unfiltered.retainedPageRemovalLabel, 'Remove 2 from Tabs')
  assert.equal(unfiltered.closableCount, 1)
  const retainedVariantIdentities = collectDashboardChips(unfiltered)
    .flatMap((chip) => {
      const variants = sameTitlePageChipTargets(chip.sameTitlePageChipPlan)
      return variants.length > 0 ? variants : [chip]
    })
    .flatMap((chip) => chip.retainedPageIdentity ?? [])
    .toSorted()
  assert.deepEqual(retainedVariantIdentities, ['identity-alpha', 'identity-bravo'])

  const filtered = computeDomainCardViewModel(group, { filter: 'alpha' })
  assert.deepEqual(filtered.retainedPageRemovalTargets, [{
    retainedPageIdentity: 'identity-alpha',
    retainedPageClosureToken: 'lifetime-alpha',
  }])
  assert.equal(filtered.retainedPageRemovalLabel, 'Remove from Tabs')

  const readOnly = computeDomainCardViewModel(group, { allowMutations: false })
  assert.deepEqual(readOnly.retainedPageRemovalTargets, [])
})

test('the Apps card exposes exact retained app snapshots for batch removal', () => {
  const group: DomainGroup = {
    domain: '__standalone-apps__',
    label: 'Apps',
    tabs: [makeDashboardTab({
      id: 'retained-app',
      url: 'https://app.example.test/document',
      title: 'Retained App Document',
      sourceType: 'retained-page',
      closedSaved: true,
      retainedPageIdentity: 'identity-app',
      retainedPageClosureToken: 'lifetime-app',
      isApp: true,
    })],
  }

  const vm = computeDomainCardViewModel(group)

  assert.deepEqual(vm.retainedPageRemovalTargets, [{
    retainedPageIdentity: 'identity-app',
    retainedPageClosureToken: 'lifetime-app',
  }])
  assert.equal(vm.retainedPageRemovalLabel, 'Remove from Tabs')
  assert.equal(vm.closableCount, 0)
})

test('GitHub repository root slash variants collapse into one closable duplicate', () => {
  const repository = 'https://github.com/example/repo'
  const group: DomainGroup = {
    domain: 'github.com',
    tabs: [
      makeDashboardTab({ id: 1, url: repository, title: 'example/repo' }),
      makeDashboardTab({ id: 2, url: `${repository}/`, title: 'example/repo' }),
    ],
  }

  const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
  const [chip] = collectDashboardChips(vm)
  assert.ok(chip)

  assert.deepEqual(vm.closableDupeUrls, [repository])
  assert.equal(vm.closableExtras, 1)
  assert.equal(chip.dupeCount, 2)
  assert.equal(chip.sameTitlePageChipPlan, undefined)
})

test('dashboards with different filter params collapse into one closable Tab Out duplicate', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const group: DomainGroup = {
      domain: '__tab-out__',
      tabs: [
        makeDashboardTab({ id: 1, url: `${base}?filter=github`, title: 'Tab Out', windowId: 1, active: true, isTabOut: true }),
        makeDashboardTab({ id: 2, url: `${base}?filter=docs`, title: 'Tab Out', windowId: 1, isTabOut: true }),
      ],
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('current and ordinary Tab Out aliases share one closable identity while staying in separate state buckets', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const newTab = 'chrome://newtab/'
    const group: DomainGroup = {
      domain: '__tab-out__',
      tabs: [
        makeDashboardTab({ id: 1, url: base, title: 'Tab Out', windowId: 1, active: true, isTabOut: true }),
        makeDashboardTab({ id: 2, url: newTab, favIconUrl: TAB_OUT_FAVICON_URL, title: 'Tab Out', windowId: 1, isTabOut: true }),
      ],
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
    const chips = collectDashboardChips(vm)

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
    assert.deepEqual(chips.map((chip) => chip.tabUrl).toSorted(), [base, newTab].toSorted())
    assert.deepEqual(chips.map((chip) => chip.dupeCount), [1, 1])
    assert.equal(chips.find((chip) => chip.tabUrl === base)?.isCurrentTabOut, true)
    assert.equal(chips.find((chip) => chip.tabUrl === newTab)?.isCurrentTabOut, false)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('New tabs keep current and duplicate chips stable across Dashboard View URL changes with remembered order', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const previousOrder: MissionOrderMap = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    const chipOrder: DashboardChipOrderMemoryMap = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    const snapshots = ['', '?view=open-saved', '', '?view=open-saved'].map((search) => {
      const tabs = Array.from({ length: 5 }, (_, index) => makeDashboardTab({
        id: index + 1,
        url: index === 0 ? `${base}${search}` : base,
        title: titleForFilterInput(),
        windowId: 1,
        active: index === 0,
        isTabOut: true,
      }))
      const group: DomainGroup = { domain: '__tab-out__', tabs }
      const vm = computeDomainCardViewModel(group, {
        currentWindowId: 1,
        chipOrder: chipOrder.tabs.get(domainCardId(group.domain)) ?? new Map(),
      })
      const chips = collectDashboardChips(vm)
      assert.equal(chips.length, 2)
      assert.ok(chips.every((chip) => chip.sameTitlePageChipPlan === undefined))
      const current = chips.find((chip) => chip.isCurrentTabOut)
      assert.equal(current?.tabUrl, `${base}${search}`)
      assert.equal(current?.tabId, 1)
      assert.equal(vm.closableExtras, 4)
      rememberMissionOrder({
        previousOrder,
        chipOrder,
        source: 'tabs',
        view: search ? 'open-saved' : 'all-tabs',
        filter: '',
        matchedCards: [{ group, vm }],
        bookmarkMatchedCards: [],
        historyMatchedCards: [],
      })
      return chips.map((chip) => ({
        renderKey: chip.renderKey,
        count: chip.dupeCount,
        current: chip.isCurrentTabOut,
      }))
    })
    assert.deepEqual(snapshots[1], snapshots[0])
    assert.deepEqual(snapshots[2], snapshots[0])
    assert.deepEqual(snapshots[3], snapshots[0])
    assert.deepEqual(snapshots[0]?.map((chip) => chip.count), [1, 4])
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('New tabs keep current, pinned, Chrome-grouped, and ordinary bucket order despite URL priority and memory', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const tabs = [
      makeDashboardTab({ id: 1, url: `${base}?view=open-saved`, active: true }),
      makeDashboardTab({ id: 2, url: `${base}?focusFilter=1`, pinned: true }),
      makeDashboardTab({ id: 3, url: `${base}#example`, groupId: 7 }),
      makeDashboardTab({ id: 4, url: base }),
      makeDashboardTab({ id: 5, url: 'chrome://newtab/', favIconUrl: TAB_OUT_FAVICON_URL }),
    ].map((tab) => ({ ...tab, title: titleForFilterInput(), isTabOut: true }))
    const vm = computeDomainCardViewModel({ domain: '__tab-out__', tabs }, {
      currentWindowId: 1,
      chipOrder: new Map(tabs.map((tab, index) => [`tab:url:${tab.url}`, tabs.length - index])),
      chipPriority: new Map([[base, 100]]),
    })
    const chips = collectDashboardChips(vm)
    assert.equal(chips.length, 4)
    assert.deepEqual(chips.map((chip) => chip.tabId), [1, 2, 3, 4])
    assert.ok(chips.every((chip) => chip.sameTitlePageChipPlan === undefined))
    assert.equal(chips.find((chip) => chip.isCurrentTabOut)?.tabId, 1)
    assert.equal(chips.find((chip) => chip.chromePinned)?.tabId, 2)
    assert.equal(chips.find((chip) => chip.chromeGroupId === 7)?.tabId, 3)
    assert.equal(chips.find((chip) => chip.tabId === 4)?.dupeCount, 2)
    assert.equal(vm.closableExtras, 2)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('native Chrome and Tab Out new tabs have separate stacks with the current page first', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` } }
  try {
    const url = 'chrome://newtab/'
    const tabs = [
      makeDashboardTab({ id: 2, url, title: 'New Tab', isTabOut: true }),
      ...[1, 3, 4].map((id) => makeDashboardTab({
        id, url, title: titleForFilterInput(), favIconUrl: TAB_OUT_FAVICON_URL, active: id === 1, isTabOut: true,
      })),
    ]
    const vm = computeDomainCardViewModel({ domain: '__tab-out__', tabs }, { currentWindowId: 1 })
    const chips = collectDashboardChips(vm)
    assert.equal(vm.tabCount, 4)
    assert.equal(vm.closableExtras, 2)
    assert.deepEqual(chips.map((chip) => [chip.tabId, chip.dupeCount]), [[1, 1], [2, 1], [3, 2]])
    assert.deepEqual(chips.map((chip) => chip.title), [titleForFilterInput(), 'New Tab', titleForFilterInput()])
    assert.equal(chips[0]?.faviconUrl, TAB_OUT_FAVICON_URL)
    assert.deepEqual(chips.map((chip) => chip.hoverTabIds), [[1], [2], [3, 4]])
    assert.equal(URL.parse(chips[1]?.faviconUrl ?? '')?.searchParams.get('pageUrl'), 'chrome://new-tab-page/')
    assert.equal(chips[2]?.faviconUrl, TAB_OUT_FAVICON_URL)
    // Either scan order must preserve each page's title at the shared alias.
    const pair = tabs.filter((tab) => tab.id === 1 || tab.id === 2)
    for (const orderedTabs of [pair, pair.toReversed()]) {
      const pairChips = collectDashboardChips(computeDomainCardViewModel({ domain: '__tab-out__', tabs: orderedTabs }, { currentWindowId: 1 }))
      assert.deepEqual(pairChips.map((chip) => chip.title), [titleForFilterInput(), 'New Tab'])
    }
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('ordinary Tab Out aliases collapse into one stacked display chip', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const group: DomainGroup = {
      domain: '__tab-out__',
      tabs: [
        makeDashboardTab({ id: 1, url: base, title: 'Tab Out', windowId: 2, isTabOut: true }),
        makeDashboardTab({ id: 2, url: 'chrome://newtab/', favIconUrl: TAB_OUT_FAVICON_URL, title: 'Tab Out', windowId: 2, isTabOut: true }),
      ],
    }

    const vm = computeDomainCardViewModel(group, { currentWindowId: 1 })
    const chips = collectDashboardChips(vm)

    assert.deepEqual(vm.closableDupeUrls, [base])
    assert.equal(vm.closableExtras, 1)
    assert.equal(chips.length, 1)
    assert.equal(chips[0]?.dupeCount, 2)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})

test('an ordinary Tab Out bucket keeps its render identity when its representative closes', () => {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id: 'tab-out' } }
  try {
    const base = 'chrome-extension://tab-out/index.html'
    const newTab = 'chrome://newtab/'
    const makeGroup = (tabs: DomainGroup['tabs']): DomainGroup => ({
      domain: '__tab-out__',
      tabs,
    })
    const before = collectDashboardChips(computeDomainCardViewModel(makeGroup([
      makeDashboardTab({ id: 20, url: base, title: 'Tab Out', windowId: 2, isTabOut: true }),
      makeDashboardTab({ id: 21, url: newTab, favIconUrl: TAB_OUT_FAVICON_URL, title: 'Tab Out', windowId: 2, isTabOut: true }),
    ]), { currentWindowId: 1 }))[0]
    const after = collectDashboardChips(computeDomainCardViewModel(makeGroup([
      makeDashboardTab({ id: 21, url: newTab, favIconUrl: TAB_OUT_FAVICON_URL, title: 'Tab Out', windowId: 2, isTabOut: true }),
    ]), { currentWindowId: 1 }))[0]

    assert.ok(before)
    assert.ok(after)
    assert.notEqual(before.tabId, after.tabId)
    assert.notEqual(before.rawUrl, after.rawUrl)
    assert.equal(before.renderKey, `tab-out:${base}\0ordinary`)
    assert.equal(after.renderKey, before.renderKey)
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
})
