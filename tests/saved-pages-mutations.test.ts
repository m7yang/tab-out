import assert from 'node:assert/strict'
import test from 'node:test'

import { Effect } from 'effect'

import {
  addSavedPageToStore,
  emptySavedPagesStore,
  mergeSavedPagesWithTabs,
  removeSavedPageFromStore,
  savedPageKeyForUrl,
  type SavedPageCandidate,
  type SavedPagesStore
} from '../src/extension/saved-pages.js'
import { createSavedPagesMutationStore } from '../src/extension/saved-pages-mutations.js'
import type { DashboardTab } from '../src/extension/types'

function cloneStore(store: SavedPagesStore): SavedPagesStore {
  return structuredClone(store)
}

function savedPage(url: string, title: string): SavedPageCandidate {
  return {
    url,
    rawUrl: url,
    title,
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }
}

function openTab(url: string, title: string): DashboardTab {
  return {
    id: 1,
    url,
    rawUrl: url,
    suspended: false,
    title,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false
  }
}

test('serialized Saved Pages mutations preserve a concurrent save after remove and ignore stale render metadata', async () => {
  const removedUrl = 'https://example.test/removed'
  const savedUrl = 'https://example.test/saved'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), savedPage(removedUrl, 'Original title'), 100)
  const staleMetadataStore = mergeSavedPagesWithTabs(
    [openTab(removedUrl, 'Render title')],
    baseStore,
    200
  ).store
  let stored = cloneStore(baseStore)
  let writes = 0
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  let exclusiveQueue = Promise.resolve()
  function runExclusive<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = exclusiveQueue.then(task)
    exclusiveQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const adapter = {
    read: async () => cloneStore(stored),
    write: async (nextStore: SavedPagesStore) => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      stored = cloneStore(nextStore)
    },
    runExclusive
  }
  // Separate mutation-store instances model separate Tab Out pages. Their
  // shared adapter lock is what serializes the cross-context read/write pair.
  const removeMutations = createSavedPagesMutationStore(adapter)
  const saveMutations = createSavedPagesMutationStore(adapter)
  const metadataMutations = createSavedPagesMutationStore(adapter)

  const removePromise = removeMutations.mutate((store) => {
    const result = removeSavedPageFromStore(store, removedUrl)
    return { store: result.store, value: result.removed }
  })
  await firstWriteStarted.promise

  const savePromise = saveMutations.mutate((store) => ({
    store: addSavedPageToStore(store, savedPage(savedUrl, 'New saved page'), 300),
    value: undefined
  }))
  const staleMetadataPromise = metadataMutations.persistMetadataUpdates(baseStore, staleMetadataStore)
  releaseFirstWrite.resolve()

  const [removed] = await Promise.all([removePromise, savePromise, staleMetadataPromise])

  assert.equal(removed?.title, 'Original title')
  assert.equal(stored.pages[removedUrl], undefined)
  assert.equal(stored.pages[savedUrl]?.title, 'New saved page')
  assert.equal(writes, 2, 'the stale metadata pass must not perform a third write')
})

test('stale render metadata cannot overwrite a newer save of the same page', async () => {
  const url = 'https://example.test/article'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), savedPage(url, 'Original title'), 100)
  const staleMetadataStore = mergeSavedPagesWithTabs(
    [openTab(url, 'Stale render title')],
    baseStore,
    200
  ).store
  let stored = cloneStore(baseStore)
  let writes = 0
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  const mutations = createSavedPagesMutationStore({
    read: async () => cloneStore(stored),
    write: async (nextStore) => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      stored = cloneStore(nextStore)
    }
  })

  const savePromise = mutations.mutate((store) => ({
    store: addSavedPageToStore(store, savedPage(url, 'Newest user title'), 300),
    value: undefined
  }))
  await firstWriteStarted.promise
  const staleMetadataPromise = mutations.persistMetadataUpdates(baseStore, staleMetadataStore)
  releaseFirstWrite.resolve()
  await Promise.all([savePromise, staleMetadataPromise])

  assert.equal(stored.pages[url]?.title, 'Newest user title')
  assert.equal(stored.pages[url]?.updatedAt, 300)
  assert.equal(writes, 1, 'the stale metadata pass must not overwrite the newer record')
})

test('a Saved Pages storage read failure aborts before write and does not poison later mutations', async () => {
  const existingUrl = 'https://example.test/existing'
  const nextUrl = 'https://example.test/next'
  let stored = addSavedPageToStore(emptySavedPagesStore(), savedPage(existingUrl, 'Existing'), 100)
  let reads = 0
  let writes = 0
  const mutations = createSavedPagesMutationStore({
    read: async () => {
      reads += 1
      if (reads === 1) throw new Error('storage read failed')
      return cloneStore(stored)
    },
    write: async (nextStore) => {
      writes += 1
      stored = cloneStore(nextStore)
    }
  })

  await assert.rejects(
    mutations.mutate((store) => ({
      store: addSavedPageToStore(store, savedPage(nextUrl, 'Next'), 200),
      value: undefined
    })),
    /storage read failed/
  )

  assert.equal(writes, 0)
  assert.deepEqual(Object.keys(stored.pages), [existingUrl])

  await mutations.mutate((store) => ({
    store: addSavedPageToStore(store, savedPage(nextUrl, 'Next'), 200),
    value: undefined
  }))

  assert.equal(writes, 1)
  assert.deepEqual(Object.keys(stored.pages).sort(), [existingUrl, nextUrl])
})

test('a rejected Saved Pages lock preserves the failure and releases local serialization', async () => {
  const url = 'https://example.test/article'
  let stored = emptySavedPagesStore()
  let lockAttempts = 0
  const lockFailure = new Error('lock unavailable')
  const mutations = createSavedPagesMutationStore({
    read: async () => cloneStore(stored),
    write: async (nextStore) => {
      stored = cloneStore(nextStore)
    },
    runExclusive: async (task) => {
      lockAttempts += 1
      if (lockAttempts === 1) throw lockFailure
      return task()
    }
  })
  const save = (store: SavedPagesStore) => ({
    store: addSavedPageToStore(store, savedPage(url, 'Article'), 100),
    value: undefined
  })

  await assert.rejects(mutations.mutate(save), (error) => error === lockFailure)
  await mutations.mutate(save)

  assert.equal(stored.pages[url]?.title, 'Article')
})

test('the Saved Pages Effect API composes the complete mutation transaction', async () => {
  const url = 'https://example.test/article'
  let stored = emptySavedPagesStore()
  const mutations = createSavedPagesMutationStore({
    read: async () => cloneStore(stored),
    write: async (nextStore) => {
      stored = cloneStore(nextStore)
    }
  })

  await Effect.runPromise(mutations.mutateEffect((store) => ({
    store: addSavedPageToStore(store, savedPage(url, 'Article'), 100),
    value: undefined
  })))

  assert.equal(stored.pages[url]?.title, 'Article')
})

test('a mutation writes v1 records as v2 normal-tab records without losing an app target', async () => {
  const url = 'https://app.example.test/inbox'
  const legacyStore: unknown = {
    version: 1,
    pages: {
      [url]: {
        key: url,
        url,
        title: 'Inbox tab',
        savedAt: 100,
        updatedAt: 100
      }
    }
  }
  let written: SavedPagesStore | undefined
  const mutations = createSavedPagesMutationStore({
    read: async () => structuredClone(legacyStore),
    write: async (nextStore) => {
      written = structuredClone(nextStore)
    }
  })

  await mutations.mutate((store) => ({
    store: addSavedPageToStore(store, {
      ...savedPage(url, 'Inbox app'),
      isApp: true
    }, 200),
    value: undefined
  }))

  assert.equal(written?.version, 2)
  assert.equal(written?.pages[savedPageKeyForUrl(url, 'normal-tab')]?.surfaceKind, 'normal-tab')
  assert.equal(written?.pages[savedPageKeyForUrl(url, 'app')]?.surfaceKind, 'app')
})

test('persistMetadataUpdates with an unchanged merged store performs no reads or writes', async () => {
  const url = 'https://example.test/article'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), savedPage(url, 'Original title'), 100)
  const mergedStore = mergeSavedPagesWithTabs([openTab(url, 'Original title')], baseStore, 200).store
  let reads = 0
  let writes = 0
  const mutations = createSavedPagesMutationStore({
    read: async () => {
      reads += 1
      return cloneStore(baseStore)
    },
    write: async () => { writes += 1 }
  })

  await mutations.persistMetadataUpdates(baseStore, mergedStore)

  assert.equal(reads, 0, 'an unchanged merge must not read storage')
  assert.equal(writes, 0, 'an unchanged merge must not write storage')
})

test('persistMetadataUpdates applies changed metadata in a single write', async () => {
  const url = 'https://example.test/article'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), savedPage(url, 'Original title'), 100)
  const mergedStore = mergeSavedPagesWithTabs([openTab(url, 'Updated title')], baseStore, 200).store
  let stored = cloneStore(baseStore)
  let reads = 0
  let writes = 0
  const mutations = createSavedPagesMutationStore({
    read: async () => {
      reads += 1
      return cloneStore(stored)
    },
    write: async (nextStore) => {
      writes += 1
      stored = cloneStore(nextStore)
    }
  })

  await mutations.persistMetadataUpdates(baseStore, mergedStore)

  assert.equal(stored.pages[url]?.title, 'Updated title')
  assert.equal(stored.pages[url]?.updatedAt, 200)
  assert.equal(reads, 1, 'one metadata heal is one storage read')
  assert.equal(writes, 1, 'one metadata heal is one storage write')
})

test('a malformed Saved Pages store aborts mutation instead of erasing it', async () => {
  let writes = 0
  const mutations = createSavedPagesMutationStore({
    read: async () => ({ version: 1, pages: [] }),
    write: async () => { writes += 1 }
  })

  await assert.rejects(
    mutations.mutate((store) => ({
      store: addSavedPageToStore(store, savedPage('https://example.test/next', 'Next'), 200),
      value: undefined
    })),
    /malformed/
  )

  assert.equal(writes, 0)
})
