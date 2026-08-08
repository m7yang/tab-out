import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeTargetLeavesSavedPage,
  historyDeleteFullyRemoved,
  variantClosable,
  partitionVariantCloseTargets,
  foldedTabCloseTargets,
  groupCloseActionLabel,
  titleVariantGroupRemovalConfirmed,
} from '../src/components/chip-close-targets.js'

test('variantClosable: open tabs and history entries are closable', () => {
  assert.equal(variantClosable({ sourceType: 'tab', tabUrl: 'https://a', rawUrl: 'https://a' }), true)
  assert.equal(variantClosable({ sourceType: 'history', tabUrl: 'https://a', rawUrl: 'https://a' }), true)
})

test('variantClosable: bookmarks, saved pages, and closed-saved tabs are not closable', () => {
  assert.equal(variantClosable({ sourceType: 'bookmark', tabUrl: 'https://a', rawUrl: 'https://a' }), false)
  assert.equal(variantClosable({ sourceType: 'saved-page', tabUrl: 'https://a', rawUrl: 'https://a' }), false)
  assert.equal(variantClosable({ sourceType: 'tab', closedSaved: true, tabUrl: 'https://a', rawUrl: 'https://a' }), false)
})

test('closeTargetLeavesSavedPage: only saved open tab targets remain visible after close', () => {
  assert.equal(closeTargetLeavesSavedPage({ sourceType: 'tab', saved: true }), true)
  assert.equal(closeTargetLeavesSavedPage({ saved: true }), true)
  assert.equal(closeTargetLeavesSavedPage({ sourceType: 'tab', saved: false }), false)
  assert.equal(closeTargetLeavesSavedPage({ sourceType: 'tab', saved: true, closedSaved: true }), false)
  assert.equal(closeTargetLeavesSavedPage({ sourceType: 'saved-page', saved: true, closedSaved: true }), false)
  assert.equal(closeTargetLeavesSavedPage({ sourceType: 'history', saved: true }), false)
})

test('partitionVariantCloseTargets: splits closable variants into history urls and tab envs', () => {
  const result = partitionVariantCloseTargets([
    { sourceType: 'tab', tabUrl: 'https://t1', rawUrl: 'raw1' },
    { sourceType: 'history', tabUrl: 'https://h1', rawUrl: 'raw-h1' },
    { sourceType: 'bookmark', tabUrl: 'https://b1', rawUrl: 'raw-b1' },
    { sourceType: 'saved-page', tabUrl: 'https://s1', rawUrl: 'raw-s1' },
  ])
  assert.deepEqual(result.historyUrls, ['https://h1'])
  assert.deepEqual(result.tabEnvs, [{ prefix: '', tabUrl: 'https://t1', rawUrl: 'raw1' }])
})

test('partitionVariantCloseTargets: empty when nothing is closable', () => {
  const result = partitionVariantCloseTargets([
    { sourceType: 'bookmark', tabUrl: 'https://b1', rawUrl: 'raw-b1' },
    { sourceType: 'saved-page', tabUrl: 'https://s1', rawUrl: 'raw-s1' },
  ])
  assert.deepEqual(result.historyUrls, [])
  assert.deepEqual(result.tabEnvs, [])
})

test('foldedTabCloseTargets excludes closed Saved and retained envs in either display order', () => {
  const open = {
    prefix: 'open',
    tabUrl: 'https://open.example.test/page',
    rawUrl: 'https://open.example.test/page',
    sourceType: 'tab' as const
  }
  const saved = {
    prefix: 'saved',
    tabUrl: 'https://saved.example.test/page',
    rawUrl: 'https://saved.example.test/page',
    sourceType: 'saved-page' as const,
    closedSaved: true
  }
  const retained = {
    prefix: 'retained',
    tabUrl: 'https://retained.example.test/page',
    rawUrl: 'https://retained.example.test/page',
    sourceType: 'retained-page' as const,
    closedSaved: true
  }

  assert.deepEqual(foldedTabCloseTargets([saved, open, retained]), [open])
  assert.deepEqual(foldedTabCloseTargets([open, retained, saved]), [open])
})

test('groupCloseActionLabel: singular labels match single-chip wording', () => {
  assert.equal(groupCloseActionLabel({ count: 1, allHistory: false }), 'Close this tab')
  assert.equal(groupCloseActionLabel({ count: 1, allHistory: true }), 'Delete from history')
})

test('groupCloseActionLabel: plural labels are count-aware', () => {
  assert.equal(groupCloseActionLabel({ count: 3, allHistory: false }), 'Close 3 tabs')
  assert.equal(groupCloseActionLabel({ count: 2, allHistory: true }), 'Delete 2 from history')
})

test('historyDeleteFullyRemoved rejects partial history deletion', () => {
  assert.equal(historyDeleteFullyRemoved(2, { deletedCount: 2 }), true)
  assert.equal(historyDeleteFullyRemoved(2, { deletedCount: 1 }), false)
  assert.equal(historyDeleteFullyRemoved(2, null), false)
})

test('titleVariantGroupRemovalConfirmed requires every requested tab and history target to be removed', () => {
  assert.equal(titleVariantGroupRemovalConfirmed({
    requestedTabCount: 2,
    tabResult: { ok: true, shouldAnimateRemoval: true },
    requestedHistoryCount: 2,
    historyResult: { deletedCount: 2 }
  }), true)
  assert.equal(titleVariantGroupRemovalConfirmed({
    requestedTabCount: 2,
    tabResult: { ok: true, shouldAnimateRemoval: false },
    requestedHistoryCount: 2,
    historyResult: { deletedCount: 2 }
  }), false)
  assert.equal(titleVariantGroupRemovalConfirmed({
    requestedTabCount: 2,
    tabResult: { ok: false, shouldAnimateRemoval: false },
    requestedHistoryCount: 2,
    historyResult: { deletedCount: 2 }
  }), false)
  assert.equal(titleVariantGroupRemovalConfirmed({
    requestedTabCount: 2,
    tabResult: { ok: true, shouldAnimateRemoval: true },
    requestedHistoryCount: 2,
    historyResult: { deletedCount: 1 }
  }), false)
})
