import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHistoryPanelRows } from '../src/hooks/useHistoryPanelRows.js'
import { closedGhostDismissalKey } from '../src/extension/closed-ghost-dismissals.js'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../src/extension/types'
import type { ClosedTabEntry } from '../src/extension/closed-tabs.js'

function makeStackEntry(overrides: Partial<TabHistoryEntry> & { index: number, tabId: number, url: string }): TabHistoryEntry {
  return {
    windowId: 1,
    exists: true,
    active: false,
    activeInOtherWindow: false,
    isApp: false,
    pinned: false,
    discarded: false,
    suspended: false,
    cursor: false,
    current: false,
    previousTarget: false,
    nextTarget: false,
    title: `Title ${overrides.tabId}`,
    rawUrl: overrides.url,
    displayUrl: overrides.url,
    favIconUrl: '',
    lastActivatedAt: null,
    ...overrides,
  }
}

function makeWorkingSetItem(overrides: Partial<WorkingSetItem> & { key: string, tabId: number }): WorkingSetItem {
  return {
    windowId: 1,
    tabUrl: overrides.key,
    rawUrl: overrides.key,
    title: `WS ${overrides.tabId}`,
    displayUrl: overrides.key,
    faviconUrl: '',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    score: 100,
    lastActivatedAt: 0,
    ...overrides,
  }
}

function makeClosed(overrides: Partial<ClosedTabEntry> & { sessionId: string, url: string, lastClosedAt: number }): ClosedTabEntry {
  return {
    tabId: -1,
    rawUrl: overrides.url,
    displayUrl: overrides.url,
    title: `Closed ${overrides.sessionId}`,
    favIconUrl: '',
    ...overrides,
  }
}

function snapshotOf(entries: TabHistoryEntry[], maxSize = 24): TabHistorySnapshot {
  return {
    stackSize: entries.length,
    maxSize,
    cursorIndex: entries.length - 1,
    currentIndex: entries.length - 1,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: null,
    activeWindowId: null,
    activeWasInserted: false,
    entries,
  }
}

function workingSetOf(items: WorkingSetItem[]): WorkingSetSnapshot {
  return { defaultLimit: 8, expandedLimit: 16, items }
}

test('buildHistoryPanelRows produces one row per source candidate', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/a', lastActivatedAt: 1000 })]),
    workingSet: workingSetOf([makeWorkingSetItem({ key: 'https://example.com/b', tabId: 2, lastActivatedAt: 2000 })]),
    closedTabs: [makeClosed({ sessionId: 'c', url: 'https://example.com/c', lastClosedAt: 3000 })],
    filter: '',
  })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['closed-ghost', 'open-ghost', 'stack'])
})

test('buildHistoryPanelRows handles all-empty sources', () => {
  const rows = buildHistoryPanelRows({
    snapshot: null,
    workingSet: null,
    closedTabs: [],
    filter: '',
  })
  assert.deepEqual(rows, [])
})

test('buildHistoryPanelRows applies filter to all three kinds by title and url', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/alpha', title: 'Alpha', lastActivatedAt: 1 }),
      makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/bravo', title: 'Bravo', lastActivatedAt: 2 }),
    ]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/charlie', tabId: 3, title: 'Charlie', lastActivatedAt: 3 }),
      makeWorkingSetItem({ key: 'https://example.com/alpha2', tabId: 4, title: 'Alpha 2', lastActivatedAt: 4 }),
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'd', url: 'https://example.com/delta', title: 'Delta', lastClosedAt: 5 }),
      makeClosed({ sessionId: 'a', url: 'https://example.com/alpha-archive', title: 'Alpha Archive', lastClosedAt: 6 }),
    ],
    filter: 'alpha',
  })

  const kinds = rows.map((r) => r.kind).sort()
  assert.equal(rows.length, 3)
  assert.deepEqual(kinds, ['closed-ghost', 'open-ghost', 'stack'])
})

test('buildHistoryPanelRows hides open-ghost when same URL exists as stack', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/shared', title: 'Shared', lastActivatedAt: 10 }),
    ]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/shared', tabId: 1, lastActivatedAt: 20 }),
    ]),
    closedTabs: [],
    filter: '',
  })

  assert.equal(rows.length, 1)
  const [row] = rows
  assert.ok(row)
  assert.equal(row.kind, 'stack')
})

test('buildHistoryPanelRows keeps every pending tab indexed even when URLs match', () => {
  const entries = [
    makeStackEntry({
      index: 0,
      tabId: 1,
      url: 'https://example.com/current',
      current: true,
    }),
    makeStackEntry({
      index: 1,
      tabId: 2,
      url: 'https://example.com/shared',
      pending: true,
      createdAt: 2000,
    }),
    makeStackEntry({
      index: 2,
      tabId: 3,
      url: 'https://example.com/shared',
      pending: true,
      createdAt: 3000,
    }),
  ]
  const snapshot: TabHistorySnapshot = {
    ...snapshotOf(entries),
    stackSize: 1,
    pendingSize: 2,
    cursorIndex: 0,
    currentIndex: 0,
    nextIndex: 1,
  }

  const rows = buildHistoryPanelRows({
    snapshot,
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  assert.deepEqual(
    rows.map((row) => row.kind === 'stack' ? row.entry.index : -1),
    [2, 1, 0],
  )
})

test('buildHistoryPanelRows shows every signed offset in descending order when indexed tabs share URLs', () => {
  // This previously rendered 0, -1, +1, -4, -6, -7, -8, -9.
  const entries = ['oldest', 'older', 'old', 'recent', 'shared', 'shared', 'current', 'previous', 'previous', 'current', 'pending']
    .map((slug, index) => makeStackEntry({
      index,
      tabId: index + 1,
      url: `https://example.test/${slug}`,
      pending: index === 10,
    }))
  const currentIndex = 9
  const rows = buildHistoryPanelRows({
    snapshot: {
      ...snapshotOf(entries),
      stackSize: 10,
      pendingSize: 1,
      cursorIndex: currentIndex,
      currentIndex,
    },
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  assert.deepEqual(
    rows.flatMap((row) => row.kind === 'stack' ? [row.entry.index - currentIndex] : []),
    [1, 0, -1, -2, -3, -4, -5, -6, -7, -8, -9],
  )
})

test('buildHistoryPanelRows preserves signed order across cursor positions despite duplicate pending tabs and timestamps', () => {
  const entries = ['shared', 'middle', 'current', 'shared', 'shared'].map((slug, index) => makeStackEntry({
    index,
    tabId: index + 1,
    url: `https://example.test/${slug}`,
    pending: index >= 3,
    lastActivatedAt: [500, 100, 800, 300, 200][index] ?? null,
  }))

  for (const currentIndex of [0, 1, 2]) {
    const rows = buildHistoryPanelRows({
      snapshot: {
        ...snapshotOf(entries),
        stackSize: 3,
        pendingSize: 2,
        cursorIndex: currentIndex,
        currentIndex,
      },
      workingSet: null,
      closedTabs: [],
      filter: '',
    })

    assert.deepEqual(
      rows.flatMap((row) => row.kind === 'stack' ? [row.entry.tabId] : []).toSorted((a, b) => a - b),
      [1, 2, 3, 4, 5],
      `all physical targets remain visible at cursor ${currentIndex}`,
    )
    assert.deepEqual(
      rows.flatMap((row) => row.kind === 'stack' ? [row.entry.index - currentIndex] : []),
      [4, 3, 2, 1, 0].map((index) => index - currentIndex),
    )
  }
})

test('buildHistoryPanelRows keeps every indexed duplicate and preserves navigation offsets when filtering', () => {
  const entries = ['shared#older', 'shared#nearer', 'middle', 'current', 'shared?utm_source=pending'].map((slug, index) => makeStackEntry({
    index,
    tabId: index + 1,
    url: `https://example.test/${slug}`,
    pending: index === 4,
  }))

  for (const filter of ['', 'shared']) {
    const rows = buildHistoryPanelRows({
      snapshot: {
        ...snapshotOf(entries),
        stackSize: 4,
        pendingSize: 1,
        cursorIndex: 3,
        currentIndex: 3,
      },
      workingSet: null,
      closedTabs: [],
      filter,
    })

    assert.deepEqual(
      rows.flatMap((row) => row.kind === 'stack' ? [row.entry.index - 3] : []),
      filter ? [1, -2, -3] : [1, 0, -1, -2, -3],
    )
  }
})

test('buildHistoryPanelRows still suppresses supplemental duplicates of activated and pending pages', () => {
  const entries = ['shared', 'middle', 'current', 'shared', 'queued'].map((slug, index) => makeStackEntry({
    index,
    tabId: index + 1,
    url: `https://example.test/${slug}`,
    pending: index >= 3,
  }))
  const rows = buildHistoryPanelRows({
    snapshot: {
      ...snapshotOf(entries, 6),
      stackSize: 3,
      pendingSize: 2,
      cursorIndex: 2,
      currentIndex: 2,
    },
    workingSet: workingSetOf(['shared', 'queued', 'extra'].map((slug, index) => makeWorkingSetItem({
      key: `https://example.test/${slug}`,
      tabId: index + 10,
      lastActivatedAt: 100,
    }))),
    closedTabs: ['shared', 'queued', 'closed'].map((slug) => makeClosed({
      sessionId: slug,
      url: `https://example.test/${slug}`,
      lastClosedAt: 200,
    })),
    filter: '',
  })

  assert.equal(rows.length, 6)
  assert.deepEqual(rows.flatMap((row) => row.kind === 'stack' ? [row.entry.index] : []), [4, 3, 2, 1, 0])
  assert.deepEqual(rows.flatMap((row) => row.kind === 'open-ghost' ? [row.item.key] : []), ['https://example.test/extra'])
  assert.equal(rows.some((row) => row.kind === 'closed-ghost'), false)
})

test('buildHistoryPanelRows reserves the row budget for activated history before closer pending tabs', () => {
  const entries = ['oldest', 'middle', 'current', 'pending'].map((slug, index) => makeStackEntry({
    index,
    tabId: index + 1,
    url: `https://example.test/${slug}`,
    pending: index === 3,
  }))
  const rows = buildHistoryPanelRows({
    snapshot: {
      ...snapshotOf(entries, 3),
      stackSize: 3,
      pendingSize: 1,
      cursorIndex: 2,
      currentIndex: 2,
    },
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  assert.deepEqual(rows.flatMap((row) => row.kind === 'stack' ? [row.entry.index] : []), [2, 1, 0])
})

test('buildHistoryPanelRows reserves remaining capacity for the earliest pending tabs', () => {
  const entries = ['current', 'pending', 'pending', 'pending'].map((slug, index) => makeStackEntry({
    index,
    tabId: index + 1,
    url: `https://example.test/${slug}`,
    pending: index > 0,
  }))
  const rows = buildHistoryPanelRows({
    snapshot: {
      ...snapshotOf(entries, 3),
      stackSize: 1,
      pendingSize: 3,
      cursorIndex: 0,
      currentIndex: 0,
    },
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  assert.deepEqual(rows.flatMap((row) => row.kind === 'stack' ? [row.entry.index] : []), [2, 1, 0])
})

test('buildHistoryPanelRows hides closed-ghost when same URL exists as open-ghost', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/shared', tabId: 1, lastActivatedAt: 5 }),
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'x', url: 'https://example.com/shared', lastClosedAt: 100 }),
    ],
    filter: '',
  })

  assert.equal(rows.length, 1)
  const [row] = rows
  assert.ok(row)
  assert.equal(row.kind, 'open-ghost')
})

test('buildHistoryPanelRows hides closed-ghost when same URL exists as stack', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/shared', title: 'Shared', lastActivatedAt: 1 }),
    ]),
    workingSet: workingSetOf([]),
    closedTabs: [
      makeClosed({ sessionId: 'x', url: 'https://example.com/shared', lastClosedAt: 100 }),
    ],
    filter: '',
  })

  assert.equal(rows.length, 1)
  const [row] = rows
  assert.ok(row)
  assert.equal(row.kind, 'stack')
})

test('buildHistoryPanelRows caps merged rows to the history max size', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/stack-a', lastActivatedAt: 100 }),
      makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/stack-b', lastActivatedAt: 90 }),
    ], 3),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/work-a', tabId: 3, lastActivatedAt: 300 }),
      makeWorkingSetItem({ key: 'https://example.com/work-b', tabId: 4, lastActivatedAt: 250 }),
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'closed-a', url: 'https://example.com/closed-a', lastClosedAt: 1000 }),
      makeClosed({ sessionId: 'closed-b', url: 'https://example.com/closed-b', lastClosedAt: 900 }),
    ],
    filter: '',
  })

  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.kind), ['open-ghost', 'stack', 'stack'])
})

test('buildHistoryPanelRows hides a closed-ghost dismissed at or after its close time', () => {
  const closed = makeClosed({ sessionId: 'c', url: 'https://example.com/forgotten', lastClosedAt: 3000 })
  const rows = buildHistoryPanelRows({
    snapshot: null,
    workingSet: null,
    closedTabs: [closed],
    filter: '',
    dismissedClosedGhosts: new Map([[closedGhostDismissalKey(closed), 3000]]),
  })

  assert.equal(rows.length, 0)
})

test('buildHistoryPanelRows suppresses closed ghosts while dismissal state is unknown', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/open', lastActivatedAt: 100 }),
    ]),
    workingSet: null,
    closedTabs: [
      makeClosed({ sessionId: 'c', url: 'https://example.com/forgotten', lastClosedAt: 3000 }),
    ],
    filter: '',
    dismissedClosedGhosts: null,
  })

  assert.deepEqual(rows.map((row) => row.kind), ['stack'])
})

test('buildHistoryPanelRows shows closed ghosts after a confirmed empty dismissal read', () => {
  const rows = buildHistoryPanelRows({
    snapshot: null,
    workingSet: null,
    closedTabs: [
      makeClosed({ sessionId: 'c', url: 'https://example.com/recent', lastClosedAt: 3000 }),
    ],
    filter: '',
    dismissedClosedGhosts: new Map(),
  })

  assert.deepEqual(rows.map((row) => row.kind), ['closed-ghost'])
})

test('buildHistoryPanelRows keeps a closed-ghost re-closed after its dismissal timestamp', () => {
  const closed = makeClosed({ sessionId: 'c', url: 'https://example.com/forgotten', lastClosedAt: 5000 })
  const rows = buildHistoryPanelRows({
    snapshot: null,
    workingSet: null,
    closedTabs: [closed],
    filter: '',
    dismissedClosedGhosts: new Map([[closedGhostDismissalKey(closed), 3000]]),
  })

  assert.equal(rows.length, 1)
  const [row] = rows
  assert.ok(row)
  assert.equal(row.kind, 'closed-ghost')
})

test('buildHistoryPanelRows sorts rows by recency descending', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/a', lastActivatedAt: 100 }),
      makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/b', lastActivatedAt: 300 }),
    ]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/c', tabId: 3, lastActivatedAt: 200 }),
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'd', url: 'https://example.com/d', lastClosedAt: 400 }),
    ],
    filter: '',
  })

  assert.deepEqual(
    rows.map((r) => r.lastTouchedAt),
    [400, 300, 200, 100],
  )
})

test('buildHistoryPanelRows keeps descending indexes with null timestamps', () => {
  const rows = buildHistoryPanelRows({
    snapshot: {
      stackSize: 3,
      maxSize: 24,
      cursorIndex: 2,
      currentIndex: 2,
      previousIndex: -1,
      nextIndex: -1,
      activeTabId: null,
      activeWindowId: null,
      activeWasInserted: false,
      entries: [
        makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/a' }),
        makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/b' }),
        makeStackEntry({ index: 2, tabId: 3, url: 'https://example.com/c' }),
      ],
    },
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  assert.equal(rows.length, 3)
  assert.equal((rows[0] as { entry: TabHistoryEntry }).entry.tabId, 3)
  assert.equal((rows[1] as { entry: TabHistoryEntry }).entry.tabId, 2)
  assert.equal((rows[2] as { entry: TabHistoryEntry }).entry.tabId, 1)
})

test('buildHistoryPanelRows keeps descending indexes despite a fresher cross-tab timestamp on a back entry', () => {
  // A back-history entry whose URL was recently visited in another tab
  // carries a fresh activity-log lastActivatedAt, which previously
  // floated it above closer entries (e.g. order 0, -1, -4, -2, -3).
  const rows = buildHistoryPanelRows({
    snapshot: {
      stackSize: 5,
      maxSize: 24,
      cursorIndex: 4,
      currentIndex: 4,
      previousIndex: 3,
      nextIndex: -1,
      activeTabId: null,
      activeWindowId: null,
      activeWasInserted: false,
      entries: [
        makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/merge', lastActivatedAt: 950 }),
        makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/guide', lastActivatedAt: 400 }),
        makeStackEntry({ index: 2, tabId: 3, url: 'https://example.com/dev-web', lastActivatedAt: 500 }),
        makeStackEntry({ index: 3, tabId: 4, url: 'https://example.com/notes', lastActivatedAt: 900 }),
        makeStackEntry({ index: 4, tabId: 5, url: 'https://example.com/newtab', lastActivatedAt: 1000 }),
      ],
    },
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  // Cursor is index 4 (relative 0). Display must follow signed descending order:
  // 4 (0), 3 (-1), 2 (-2), 1 (-3), 0 (-4) — NOT recency order.
  assert.deepEqual(
    rows.map((r) => (r as { entry: TabHistoryEntry }).entry.index),
    [4, 3, 2, 1, 0],
  )
})

test('buildHistoryPanelRows keeps distinct indexed tabs even for identical utility URLs', () => {
  const rows = buildHistoryPanelRows({
    snapshot: {
      stackSize: 3,
      maxSize: 24,
      cursorIndex: 2,
      currentIndex: 2,
      previousIndex: -1,
      nextIndex: -1,
      activeTabId: null,
      activeWindowId: null,
      activeWasInserted: false,
      entries: [
        makeStackEntry({ index: 0, tabId: 1, url: 'chrome://newtab/' }),
        makeStackEntry({ index: 1, tabId: 2, url: 'chrome://newtab/' }),
        makeStackEntry({ index: 2, tabId: 3, url: 'chrome://newtab/' }),
      ],
    },
    workingSet: null,
    closedTabs: [],
    filter: '',
  })

  assert.deepEqual(rows.flatMap((row) => row.kind === 'stack' ? [row.entry.tabId] : []), [3, 2, 1])
})
