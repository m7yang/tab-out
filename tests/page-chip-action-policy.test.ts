import assert from 'node:assert/strict'
import test from 'node:test'

import { pageChipTargetActionPolicy } from '../src/components/page-chip-action-policy.js'

test('live tab targets expose saved-page, Chrome tab, and close actions', () => {
  assert.deepEqual(
    pageChipTargetActionPolicy({
      sourceType: 'tab',
      saved: false,
      closedSaved: false,
      isApp: false
    }),
    {
      canClose: true,
      canRemoveRetained: false,
      canToggleSaved: true,
      canUseChromeTabActions: true,
      showSavedHint: false
    }
  )
})

test('closed saved-page targets can be removed but cannot use live-tab or close actions', () => {
  assert.deepEqual(
    pageChipTargetActionPolicy({
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true,
      isApp: false
    }),
    {
      canClose: false,
      canRemoveRetained: false,
      canToggleSaved: true,
      canUseChromeTabActions: false,
      showSavedHint: false
    }
  )
})

test('read-only saved targets show the saved hint without mutation actions', () => {
  assert.deepEqual(
    pageChipTargetActionPolicy({
      sourceType: 'bookmark',
      saved: true,
      closedSaved: false,
      isApp: false
    }),
    {
      canClose: false,
      canRemoveRetained: false,
      canToggleSaved: false,
      canUseChromeTabActions: false,
      showSavedHint: true
    }
  )
})

test('history targets expose delete through the shared close capability', () => {
  assert.deepEqual(
    pageChipTargetActionPolicy({
      sourceType: 'history',
      saved: false,
      closedSaved: false,
      isApp: false
    }),
    {
      canClose: true,
      canRemoveRetained: false,
      canToggleSaved: false,
      canUseChromeTabActions: false,
      showSavedHint: false
    }
  )
})

test('non-interactive aggregate targets suppress target-level actions', () => {
  assert.deepEqual(
    pageChipTargetActionPolicy(
      {
        sourceType: 'tab',
        saved: true,
        closedSaved: false,
        isApp: false
      },
      { interactive: false }
    ),
    {
      canClose: false,
      canRemoveRetained: false,
      canToggleSaved: false,
      canUseChromeTabActions: false,
      showSavedHint: false
    }
  )
})

test('retained app targets can be saved or removed from Tabs without live-tab actions', () => {
  assert.deepEqual(
    pageChipTargetActionPolicy({
      sourceType: 'retained-page',
      saved: false,
      closedSaved: true,
      isApp: true
    }),
    {
      canClose: false,
      canRemoveRetained: true,
      canToggleSaved: true,
      canUseChromeTabActions: false,
      showSavedHint: false
    }
  )
})
