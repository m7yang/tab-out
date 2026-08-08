import assert from 'node:assert/strict'
import test from 'node:test'

import { createSavedPageActivation } from '../src/extension/saved-page-activation.js'
import {
  SAVED_PAGE_ACTIVATE_MESSAGE,
  parseSavedPageActivateMessage,
  parseSavedPageActivationResponse
} from '../src/extension/runtime-messages.js'

function harness(response: unknown = { ok: true, outcome: 'activated' }) {
  const messages: unknown[] = []
  const notices: string[] = []
  const refreshes: unknown[] = []
  const actions = createSavedPageActivation({
    sendMessage: async (message) => {
      messages.push(message)
      return response
    },
    refresh: async (options) => {
      refreshes.push(options)
    },
    notify: (message) => {
      notices.push(message)
    }
  })
  return { actions, messages, notices, refreshes }
}

test('saved-page activation messages carry an exact target and surface', () => {
  const message = {
    type: SAVED_PAGE_ACTIVATE_MESSAGE,
    url: 'chrome://settings/privacy',
    surfaceKind: 'normal-tab',
    disposition: 'focus-tab'
  } as const
  assert.deepEqual(parseSavedPageActivateMessage(message), message)
  assert.equal(parseSavedPageActivateMessage({ ...message, url: '' }), null)
  assert.equal(parseSavedPageActivateMessage({ ...message, surfaceKind: 'popup' }), null)
  assert.equal(parseSavedPageActivateMessage({ ...message, disposition: 'restore' }), null)
  assert.deepEqual(
    parseSavedPageActivationResponse({ ok: true, outcome: 'activated' }),
    { ok: true, outcome: 'activated' }
  )
  assert.equal(parseSavedPageActivationResponse({ ok: true, outcome: 'stale' }), null)
})

test('closed Saved Page activation uses guarded worker recovery without removing the Saved Page', async () => {
  const state = harness()
  assert.equal(await state.actions.activateSavedPageTarget({
    tabUrl: 'chrome://settings/privacy',
    isApp: false
  }, 'bring-background'), true)
  assert.deepEqual(state.messages, [{
    type: SAVED_PAGE_ACTIVATE_MESSAGE,
    url: 'chrome://settings/privacy',
    surfaceKind: 'normal-tab',
    disposition: 'background-tab'
  }])
  assert.deepEqual(state.refreshes, [{ animateCards: true }])
  assert.deepEqual(state.notices, [])
})

test('failed Saved Page recovery keeps the record and reports the failure', async () => {
  const state = harness({ ok: true, outcome: 'failed' })
  assert.equal(await state.actions.activateSavedPageTarget({
    tabUrl: 'https://example.test/app',
    isApp: true
  }, 'open-window'), false)
  assert.deepEqual(state.messages, [{
    type: SAVED_PAGE_ACTIVATE_MESSAGE,
    url: 'https://example.test/app',
    surfaceKind: 'app',
    disposition: 'new-window'
  }])
  assert.deepEqual(state.refreshes, [])
  assert.deepEqual(state.notices, ['Could not open page'])
})
