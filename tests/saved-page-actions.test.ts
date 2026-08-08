import assert from 'node:assert/strict'
import test from 'node:test'

import { createSavedPageActions } from '../src/extension/saved-page-actions.js'
import {
  addSavedPageToStore,
  emptySavedPagesStore,
  savedPageKeyForUrl,
  type SavedPagesStore,
  type SavedPagesStoreMutation
} from '../src/extension/saved-pages.js'
import type { ToastAction } from '../src/extension/toast.js'

const target = {
  url: 'https://example.test/article',
  rawUrl: 'https://example.test/article',
  title: 'Example Article',
  favIconUrl: '',
  isTabOut: false,
  isApp: false
}

type Notice = {
  title: string
  action: ToastAction | null
}

async function invokeToastAction(action: ToastAction | null | undefined): Promise<void> {
  assert.ok(action)
  await action.onClick()
}

function savedRecord(store: SavedPagesStore, key: string) {
  return store.pages[key]
}

function actionHarness(initialStore = emptySavedPagesStore()) {
  let store = initialStore
  let mutateCalls = 0
  let refreshCalls = 0
  let rejectMutationCall = 0
  let rejectRefreshCall = 0
  const notices: Notice[] = []

  const actions = createSavedPageActions({
    mutate: async <Value>(mutation: (currentStore: SavedPagesStore) => SavedPagesStoreMutation<Value>) => {
      mutateCalls += 1
      if (mutateCalls === rejectMutationCall) throw new Error('storage unavailable')
      const result = mutation(store)
      store = result.store
      return result.value
    },
    refresh: async () => {
      refreshCalls += 1
      if (refreshCalls === rejectRefreshCall) throw new Error('refresh unavailable')
    },
    notify: (title, action = null) => {
      notices.push({ title, action })
    }
  })

  return {
    actions,
    notices,
    rejectMutationOn(call: number) {
      rejectMutationCall = call
    },
    rejectRefreshOn(call: number) {
      rejectRefreshCall = call
    },
    get mutateCalls() {
      return mutateCalls
    },
    get refreshCalls() {
      return refreshCalls
    },
    get store() {
      return store
    }
  }
}

test('savePageTarget handles a storage rejection with user feedback', async () => {
  const harness = actionHarness()
  harness.rejectMutationOn(1)

  await assert.doesNotReject(harness.actions.savePageTarget(target))

  assert.equal(harness.refreshCalls, 0)
  assert.deepEqual(harness.notices, [{ title: "Couldn't save the page", action: null }])
})

test('savePageTarget reports when persistence succeeds but refresh fails', async () => {
  const harness = actionHarness()
  harness.rejectRefreshOn(1)

  await assert.doesNotReject(harness.actions.savePageTarget(target))

  assert.ok(harness.store.pages[savedPageKeyForUrl(target.url)])
  assert.deepEqual(harness.notices, [{
    title: "Page saved, but couldn't refresh the dashboard",
    action: null
  }])
})

test('Saved Page actions preserve an app target through remove and Undo', async () => {
  const appTarget = { ...target, isApp: true }
  const appKey = savedPageKeyForUrl(appTarget.url, 'app')
  const harness = actionHarness()

  await harness.actions.savePageTarget(appTarget)
  assert.equal(harness.store.pages[appKey]?.surfaceKind, 'app')
  assert.equal(harness.store.pages[savedPageKeyForUrl(appTarget.url, 'normal-tab')], undefined)

  await harness.actions.removeSavedPageTarget(appKey)
  assert.equal(harness.store.pages[appKey], undefined)
  assert.equal(harness.notices.at(-1)?.action?.label, 'Undo')

  await invokeToastAction(harness.notices.at(-1)?.action)
  assert.equal(savedRecord(harness.store, appKey)?.surfaceKind, 'app')
})

test('removeSavedPageTarget handles a storage rejection with user feedback', async () => {
  const initialStore = addSavedPageToStore(emptySavedPagesStore(), target, 100)
  const harness = actionHarness(initialStore)
  harness.rejectMutationOn(1)

  await assert.doesNotReject(harness.actions.removeSavedPageTarget(target.url))

  assert.equal(harness.refreshCalls, 0)
  assert.ok(harness.store.pages[savedPageKeyForUrl(target.url)])
  assert.deepEqual(harness.notices, [{
    title: "Couldn't remove the saved page",
    action: null
  }])
})

test('removeSavedPageTarget keeps Undo available when refresh fails', async () => {
  const initialStore = addSavedPageToStore(emptySavedPagesStore(), target, 100)
  const harness = actionHarness(initialStore)
  harness.rejectRefreshOn(1)

  await assert.doesNotReject(harness.actions.removeSavedPageTarget(target.url))

  assert.equal(harness.store.pages[savedPageKeyForUrl(target.url)], undefined)
  assert.equal(harness.notices[0]?.title, "Saved page removed, but couldn't refresh the dashboard")
  assert.equal(harness.notices[0]?.action?.label, 'Undo')

  await assert.doesNotReject(invokeToastAction(harness.notices[0]?.action))
  assert.ok(harness.store.pages[savedPageKeyForUrl(target.url)])
})

test('Saved Page Undo handles a restore storage rejection with user feedback', async () => {
  const initialStore = addSavedPageToStore(emptySavedPagesStore(), target, 100)
  const harness = actionHarness(initialStore)

  await harness.actions.removeSavedPageTarget(target.url)
  harness.rejectMutationOn(2)

  await assert.doesNotReject(invokeToastAction(harness.notices[0]?.action))

  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.notices.map(({ title }) => title), [
    'Saved page removed',
    "Couldn't restore the saved page"
  ])
})

test('Saved Page Undo reports when restore succeeds but refresh fails', async () => {
  const initialStore = addSavedPageToStore(emptySavedPagesStore(), target, 100)
  const harness = actionHarness(initialStore)

  await harness.actions.removeSavedPageTarget(target.url)
  harness.rejectRefreshOn(2)

  await assert.doesNotReject(invokeToastAction(harness.notices[0]?.action))

  assert.ok(harness.store.pages[savedPageKeyForUrl(target.url)])
  assert.deepEqual(harness.notices.map(({ title }) => title), [
    'Saved page removed',
    "Saved page restored, but couldn't refresh the dashboard"
  ])
})
