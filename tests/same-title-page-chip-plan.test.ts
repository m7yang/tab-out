import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileSameTitlePageChip,
  resolveSameTitlePageChip,
} from '../src/extension/same-title-page-chip-plan.js'
import type { DashboardChipData, SameTitlePageChipPlan } from '../src/extension/types.js'

function chip(
  tabId: number | string,
  tabUrl: string,
  overrides: Partial<DashboardChipData> = {},
): DashboardChipData {
  return {
    tabId,
    tabUrl,
    rawUrl: tabUrl,
    sourceType: 'tab',
    saved: false,
    closedSaved: false,
    suspended: false,
    loading: false,
    pagePinned: false,
    leadPrefix: '',
    pathGroupLabel: '',
    title: 'Example item',
    displaySegments: ['Example item'],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: 'Example item',
    dupeCount: 1,
    faviconUrl: '',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides,
  }
}

function compiledPlan(targets: readonly DashboardChipData[]): SameTitlePageChipPlan {
  const result = compileSameTitlePageChip(targets)
  if (!result.ok) assert.fail(result.reason)
  return result.plan
}

test('shared Chrome group membership requires every same-title target to agree', () => {
  for (const otherGroupId of [101, 202, -1, undefined]) {
    const targets = [
      chip(1, 'https://example.test/first', { isGrouped: true, chromeGroupId: 101 }),
      chip(2, 'https://example.test/second', {
        isGrouped: otherGroupId != null && otherGroupId !== -1,
        ...(otherGroupId == null ? {} : { chromeGroupId: otherGroupId }),
      }),
    ]
    const plan = compiledPlan(targets)
    assert.equal(plan.view.chromeGroupId, otherGroupId === 101 ? 101 : null)
    const decision = resolveSameTitlePageChip(plan, { kind: 'debug-targets' })
    assert.equal(decision.kind, 'debug-targets')
    if (decision.kind === 'debug-targets') {
      assert.deepEqual(decision.exactTargets.map(({ target }) => target.chromeGroupId), [101, otherGroupId])
    }
  }
})

test('compiled same-title plans preserve repeated exact URL occurrences', () => {
  const repeatedUrl = 'https://example.test/content/item?state=open'
  const plan = compiledPlan([
    chip(1, repeatedUrl),
    chip(2, 'https://example.test/content/item?state=closed'),
    chip(3, repeatedUrl),
  ])

  assert.deepEqual(plan.view.rows.map((row) => row.label), [
    '…?state=open',
    '…?state=closed',
    '…?state=open',
  ])
  assert.equal(new Set(plan.view.rows.map((row) => row.id)).size, 3)

  const targetIds = plan.view.rows.map((row) => {
    const decision = resolveSameTitlePageChip(plan, { kind: 'activate', rowId: row.id })
    assert.equal(decision.kind, 'activate')
    return decision.kind === 'activate' ? decision.target.tabId : null
  })
  assert.deepEqual(targetIds, [1, 2, 3])
})

test('compiled same-title plans collapse History opaque families without losing deletion scope', () => {
  const urls = [
    'https://accounts.example.test/content/item?token=alpha0123456789abcdefghijklmnopqrstuvwxyz',
    'https://accounts.example.test/content/item?token=bravo0123456789abcdefghijklmnopqrstuvwxyz',
  ]
  const plan = compiledPlan(urls.map((url, index) => chip(`history-${index}`, url, {
    sourceType: 'history',
  })))

  assert.equal(plan.view.rows.length, 1)
  assert.equal(plan.view.rows[0]?.exactTargetCount, 2)
  assert.equal(plan.view.rows[0]?.label, '…?token=…')
  assert.equal(plan.view.rows[0]?.actions.close?.label, 'Delete 2 from history: …?token=…')

  const decision = resolveSameTitlePageChip(plan, {
    action: 'close',
    kind: 'action',
    rowId: plan.view.rows[0]?.id,
  })
  assert.equal(decision.kind, 'remove')
  if (decision.kind !== 'remove') return
  assert.deepEqual(decision.historyUrls, urls)
  assert.equal(decision.tabClose, null)
})

test('compiled same-title plans choose the current-window target before other active targets', () => {
  const plan = compiledPlan([
    chip(1, 'https://example.test/one', { activeInOtherWindow: true }),
    chip(2, 'https://example.test/two', { activeChipFrame: true }),
    chip(3, 'https://example.test/three'),
  ])

  const decision = resolveSameTitlePageChip(plan, { kind: 'activate' })
  assert.equal(decision.kind, 'activate')
  if (decision.kind !== 'activate') return
  assert.equal(decision.target.tabId, 2)
  assert.equal(
    plan.view.rows.find((row) => row.id === plan.view.defaultRowId)?.filterCandidate.key.includes('2'),
    true,
  )
})

test('compiled same-title plans expose target-sensitive row actions and labels', () => {
  const plan = compiledPlan([
    chip(1, 'https://example.test/open', {
      pagePinId: 'pin-open',
      pagePinned: true,
      saved: true,
    }),
    chip('retained:two', 'https://example.test/retained', {
      closedSaved: true,
      retainedPageClosureToken: 'closure-two',
      retainedPageIdentity: 'identity-two',
      sourceType: 'retained-page',
    }),
  ])
  const openRow = plan.view.rows[0]
  const retainedRow = plan.view.rows[1]

  assert.deepEqual(openRow?.actions.saved, { label: 'Remove saved page' })
  assert.deepEqual(openRow?.actions.pin, { label: 'Unpin' })
  assert.equal(openRow?.actions.chromeTabActions, true)
  assert.equal(openRow?.actions.close?.label, 'Close this tab: /open')
  assert.equal(retainedRow?.actions.removeRetained, true)
  assert.deepEqual(retainedRow?.actions.saved, { label: 'Save page' })
  assert.equal(retainedRow?.actions.close, null)
})

test('compiled same-title plans keep group close and order decisions behind the interface', () => {
  const suspendedUrl = 'chrome-extension://suspender/suspended.html#uri=https://example.test/one'
  const plan = compiledPlan([
    chip(1, 'https://example.test/one', {
      rawUrl: suspendedUrl,
      saved: true,
    }),
    chip('history-two', 'https://example.test/two', {
      sourceType: 'history',
    }),
  ])

  assert.deepEqual(plan.view.orderEntries, [
    {
      key: 'tab:url:https://example.test/one',
      alternateKey: `tab:url:${suspendedUrl}`,
    },
    {
      key: 'history:url:https://example.test/two',
      alternateKey: null,
    },
  ])
  assert.deepEqual(plan.view.groupRemoval, {
    historyCount: 1,
    label: 'Close 1 tab and delete 1 from history',
    tabCount: 1,
  })

  const decision = resolveSameTitlePageChip(plan, { action: 'close', kind: 'action' })
  assert.equal(decision.kind, 'remove')
  if (decision.kind !== 'remove') return
  assert.equal(decision.tabClose?.kind, 'many')
  assert.deepEqual(decision.historyUrls, ['https://example.test/two'])
  assert.equal(decision.leavesSavedPage, true)
})

test('compiled same-title plans remain resolvable after a JSON round trip', () => {
  const plan = compiledPlan([
    chip(1, 'https://example.test/alpha'),
    chip(2, 'https://example.test/bravo', { activeChipFrame: true }),
  ])
  const serialized = JSON.stringify(plan)
  const revived = JSON.parse(serialized) as SameTitlePageChipPlan

  assert.deepEqual(revived.view, plan.view)
  const decision = resolveSameTitlePageChip(revived, { kind: 'activate' })
  assert.equal(decision.kind, 'activate')
  if (decision.kind !== 'activate') return
  assert.equal(decision.target.tabId, 2)
})

test('compiled same-title plans return explicit failures for invalid groups', () => {
  assert.deepEqual(compileSameTitlePageChip([]), {
    ok: false,
    reason: 'fewer-than-two-targets',
  })
  assert.deepEqual(compileSameTitlePageChip([
    chip(1, 'https://example.test/one'),
    chip(2, 'https://example.test/one'),
  ]), {
    ok: false,
    reason: 'single-exact-url',
  })
})
