import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverRetainedPageSnapshot } from '../src/extension/background/retained-page-recovery.js'
import type { RetainedPageRecord } from '../src/extension/retained-pages-ledger.js'

function page(overrides: Partial<RetainedPageRecord> = {}): RetainedPageRecord {
  return {
    identityDigest: 'identity-example',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/article',
    url: 'https://example.test/article?view=exact#comment',
    title: 'Example article',
    closedAt: 1_000,
    closureToken: 'lifetime-example',
    ...overrides
  }
}

function chromeApi(overrides: Record<string, unknown> = {}) {
  const base = {
    tabs: {
      query: async () => [],
      move: async (tabId: number, properties: chrome.tabs.MoveProperties) => ({
        id: tabId,
        windowId: properties.windowId ?? 1,
        url: page().url
      }),
      create: async (properties: chrome.tabs.CreateProperties) => ({
        id: 9,
        windowId: 1,
        url: properties.url
      }),
      get: async (tabId: number) => ({
        id: tabId,
        windowId: 1,
        url: page().url
      }),
      update: async (tabId: number, properties: chrome.tabs.UpdateProperties) => ({
        id: tabId,
        windowId: 1,
        active: properties.active
      })
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }],
      get: async (windowId: number) => ({ id: windowId, type: 'normal' }),
      update: async (windowId: number) => ({ id: windowId, focused: true }),
      create: async (properties: chrome.windows.CreateData) => ({
        id: 2,
        focused: properties.focused,
        tabs: [{ id: 10, windowId: 2, url: properties.url }]
      })
    },
  }
  return {
    ...base,
    ...overrides,
    tabs: {
      ...base.tabs,
      ...((overrides.tabs || {}) as object)
    },
    windows: {
      ...base.windows,
      ...((overrides.windows || {}) as object)
    }
  } as unknown as typeof chrome
}

test('plain retained recovery opens the exact stored URL in an active normal tab', async () => {
  const creates: chrome.tabs.CreateProperties[] = []
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async (properties: chrome.tabs.CreateProperties) => {
        creates.push(properties)
        return { id: 9, windowId: 1, url: properties.url }
      },
      get: async () => ({ id: 9, windowId: 1, url: page().url })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(api, page(), 'focus-tab'), true)
  assert.deepEqual(creates, [{
    windowId: 1,
    url: 'https://example.test/article?view=exact#comment',
    active: true
  }])
})

test('plain retained recovery focuses a reappeared exact live target in place', async () => {
  const updates: Array<{ tabId: number; properties: chrome.tabs.UpdateProperties }> = []
  const focusedWindows: number[] = []
  let createCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 4,
        url: 'https://example.test/article?view=exact#comment'
      }],
      update: async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
        updates.push({ tabId, properties })
        return { id: tabId, windowId: 4, url: page().url }
      },
      create: async () => {
        createCount += 1
        return { id: 9, windowId: 1 }
      }
    },
    windows: {
      getAll: async () => [{ id: 4, type: 'normal' }],
      update: async (windowId: number) => {
        focusedWindows.push(windowId)
        return { id: windowId, focused: true }
      },
      create: async () => ({ id: 2 })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(api, page(), 'focus-tab'), true)
  assert.deepEqual(updates, [{ tabId: 7, properties: { active: true } }])
  assert.deepEqual(focusedWindows, [4])
  assert.equal(createCount, 0)
})

test('app retained recovery reuses an exact normal-tab fallback without changing identity', async () => {
  const updates: number[] = []
  const focusedWindows: number[] = []
  let createCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 4,
        url: 'https://example.test/article?view=exact#comment'
      }],
      update: async (tabId: number) => {
        updates.push(tabId)
        return { id: tabId, windowId: 4, url: page().url }
      },
      get: async (tabId: number) => ({ id: tabId, windowId: 4, url: page().url }),
      create: async () => {
        createCount += 1
        return { id: 9, windowId: 1 }
      }
    },
    windows: {
      getAll: async () => [{ id: 4, type: 'normal' }],
      update: async (windowId: number) => {
        focusedWindows.push(windowId)
        return { id: windowId }
      },
      get: async (windowId: number) => ({ id: windowId, type: 'normal' }),
      create: async () => ({ id: 2 })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ surfaceKind: 'app' }),
    'focus-tab'
  ), true)
  assert.deepEqual(updates, [7])
  assert.deepEqual(focusedWindows, [4])
  assert.equal(createCount, 0)
})

test('app snapshot recovery ignores an exact live app target and creates a normal-tab fallback', async () => {
  const creates: chrome.tabs.CreateProperties[] = []
  const updatedTabIds: number[] = []
  const api = chromeApi({
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 4,
        url: page().url
      }],
      update: async (tabId: number) => {
        updatedTabIds.push(tabId)
        return { id: tabId, windowId: 4, url: page().url }
      },
      create: async (properties: chrome.tabs.CreateProperties) => {
        creates.push(properties)
        return { id: 9, windowId: 1, url: properties.url }
      },
      get: async (tabId: number) => ({
        id: tabId,
        windowId: tabId === 7 ? 4 : 1,
        url: page().url
      })
    },
    windows: {
      getAll: async () => [
        { id: 1, type: 'normal', focused: true },
        { id: 4, type: 'app' }
      ],
      get: async (windowId: number) => ({
        id: windowId,
        type: windowId === 4 ? 'app' : 'normal'
      })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ surfaceKind: 'app' }),
    'focus-tab'
  ), true)
  assert.deepEqual(updatedTabIds, [])
  assert.deepEqual(creates, [{
    windowId: 1,
    url: page().url,
    active: true
  }])
})

test('app snapshot recovery ignores a pending app target and creates a normal-tab fallback', async () => {
  const creates: chrome.tabs.CreateProperties[] = []
  const api = chromeApi({
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 4,
        url: 'chrome://newtab/',
        pendingUrl: page().url,
        status: 'loading'
      }],
      create: async (properties: chrome.tabs.CreateProperties) => {
        creates.push(properties)
        return { id: 9, windowId: 1, url: properties.url }
      },
      get: async (tabId: number) => ({
        id: tabId,
        windowId: 1,
        url: page().url
      })
    },
    windows: {
      getAll: async () => [
        { id: 1, type: 'normal', focused: true },
        { id: 4, type: 'app' }
      ]
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ surfaceKind: 'app' }),
    'foreground-tab'
  ), true)
  assert.deepEqual(creates, [{
    windowId: 1,
    url: page().url,
    active: true
  }])
})

test('app snapshot recovery creates a normal fallback when its normal candidate becomes an app before mutation', async () => {
  const creates: chrome.tabs.CreateProperties[] = []
  const movedTabIds: number[] = []
  const updatedTabIds: number[] = []
  let inventoryReadCount = 0
  let windowInventoryReadCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => {
        inventoryReadCount += 1
        return inventoryReadCount === 1
          ? [{ id: 7, windowId: 4, url: page().url }]
          : [{ id: 7, windowId: 5, url: page().url }]
      },
      get: async (tabId: number) => tabId === 7
        ? { id: 7, windowId: 5, url: page().url }
        : { id: 9, windowId: 1, url: page().url },
      move: async (tabId: number) => {
        movedTabIds.push(tabId)
        return { id: tabId, windowId: 1, url: page().url }
      },
      update: async (tabId: number) => {
        updatedTabIds.push(tabId)
        return { id: tabId, windowId: 5, url: page().url }
      },
      create: async (properties: chrome.tabs.CreateProperties) => {
        creates.push(properties)
        return { id: 9, windowId: 1, url: properties.url }
      }
    },
    windows: {
      getAll: async () => {
        windowInventoryReadCount += 1
        return windowInventoryReadCount === 1
          ? [
              { id: 1, type: 'normal', focused: true },
              { id: 4, type: 'normal' }
            ]
          : [
              { id: 1, type: 'normal', focused: true },
              { id: 5, type: 'app' }
            ]
      },
      get: async (windowId: number) => ({
        id: windowId,
        type: windowId === 5 ? 'app' : 'normal'
      })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ surfaceKind: 'app' }),
    'background-tab',
    { currentWindowId: 1 }
  ), true)
  assert.deepEqual(movedTabIds, [])
  assert.deepEqual(updatedTabIds, [])
  assert.deepEqual(creates, [{
    windowId: 1,
    url: page().url,
    active: false
  }])
})

test('primary-modifier recovery moves an exact live target into the initiating window', async () => {
  const moves: Array<{ tabId: number; properties: chrome.tabs.MoveProperties }> = []
  const updates: Array<{ tabId: number; properties: chrome.tabs.UpdateProperties }> = []
  const api = chromeApi({
    tabs: {
      query: async () => [{
        id: 7,
        windowId: 4,
        url: page().url
      }],
      move: async (tabId: number, properties: chrome.tabs.MoveProperties) => {
        moves.push({ tabId, properties })
        return { id: tabId, windowId: properties.windowId, url: page().url }
      },
      update: async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
        updates.push({ tabId, properties })
        return { id: tabId, windowId: 1, url: page().url }
      },
      get: async (tabId: number) => ({ id: tabId, windowId: 1, url: page().url })
    },
    windows: {
      getAll: async () => [
        { id: 1, type: 'normal', focused: true },
        { id: 4, type: 'normal', focused: false }
      ],
      update: async () => ({ id: 1, focused: true }),
      create: async () => ({ id: 2 })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'background-tab',
    { currentWindowId: 1 }
  ), true)
  assert.deepEqual(moves, [{
    tabId: 7,
    properties: { windowId: 1, index: -1 }
  }])
  assert.deepEqual(updates, [])
})

test('background recovery preserves retention when a same-window live target navigates during revalidation', async () => {
  let createCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: page().url }],
      get: async () => ({
        id: 7,
        windowId: 1,
        url: 'https://example.test/a-different-page'
      }),
      create: async () => {
        createCount += 1
        return { id: 9, windowId: 1, url: page().url }
      }
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal', focused: true }],
      update: async () => ({ id: 1, focused: true }),
      create: async () => ({ id: 2 })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'background-tab',
    { currentWindowId: 1 }
  ), false)
  assert.equal(createCount, 0)
})

test('primary-modifier plus Shift moves and activates an exact live target here', async () => {
  const moves: chrome.tabs.MoveProperties[] = []
  const updates: chrome.tabs.UpdateProperties[] = []
  const focusedWindows: number[] = []
  const api = chromeApi({
    tabs: {
      query: async () => [{ id: 7, windowId: 4, url: page().url }],
      move: async (_tabId: number, properties: chrome.tabs.MoveProperties) => {
        moves.push(properties)
        return { id: 7, windowId: 1, url: page().url }
      },
      update: async (_tabId: number, properties: chrome.tabs.UpdateProperties) => {
        updates.push(properties)
        return { id: 7, windowId: 1, url: page().url }
      },
      get: async () => ({ id: 7, windowId: 1, url: page().url })
    },
    windows: {
      getAll: async () => [
        { id: 1, type: 'normal', focused: true },
        { id: 4, type: 'normal' }
      ],
      update: async (windowId: number) => {
        focusedWindows.push(windowId)
        return { id: windowId, focused: true }
      },
      create: async () => ({ id: 2 })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'foreground-tab',
    { currentWindowId: 1 }
  ), true)
  assert.deepEqual(moves, [{ windowId: 1, index: -1 }])
  assert.deepEqual(updates, [{ active: true }])
  assert.deepEqual(focusedWindows, [1])
})

test('Shift recovery moves an exact live target to one focused normal window', async () => {
  const windows: chrome.windows.CreateData[] = []
  let tabCreateCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [{ id: 7, windowId: 4, url: page().url }],
      create: async () => {
        tabCreateCount += 1
        return { id: 9, windowId: 1 }
      },
      get: async () => ({ id: 7, windowId: 2, url: page().url })
    },
    windows: {
      getAll: async () => [{ id: 4, type: 'normal', focused: true }],
      update: async () => ({ id: 2, focused: true }),
      create: async (properties: chrome.windows.CreateData) => {
        windows.push(properties)
        return {
          id: 2,
          type: 'normal',
          tabs: [{ id: 7, windowId: 2, url: page().url }]
        }
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(api, page(), 'new-window'), true)
  assert.equal(tabCreateCount, 0)
  assert.deepEqual(windows, [{ tabId: 7, focused: true, type: 'normal' }])
})

test('retained recovery uses a normal new window for the explicit new-window gesture', async () => {
  const windows: chrome.windows.CreateData[] = []
  const api = chromeApi({
    windows: {
      getAll: async () => [],
      update: async () => undefined,
      create: async (properties: chrome.windows.CreateData) => {
        windows.push(properties)
        return {
          id: 2,
          tabs: [{ id: 20, windowId: 2, url: properties.url }]
        }
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ surfaceKind: 'app' }),
    'new-window'
  ), true)
  assert.deepEqual(windows, [{
    url: 'https://example.test/article?view=exact#comment',
    focused: true,
    type: 'normal'
  }])
})

test('retained recovery reports failure when Chrome rejects the target', async () => {
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async () => {
        throw new Error('privileged target rejected')
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(api, page(), 'foreground-tab'), false)
})

test('retained recovery waits for Chrome to represent the exact created target', async () => {
  let reads = 0
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async (properties: chrome.tabs.CreateProperties) => ({
        id: 9,
        windowId: 1,
        pendingUrl: properties.url,
        status: 'loading'
      }),
      get: async () => {
        reads += 1
        return reads === 1
          ? {
              id: 9,
              windowId: 1,
              pendingUrl: page().url,
              status: 'loading'
            }
          : {
              id: 9,
              windowId: 1,
              url: page().url,
              status: 'loading'
            }
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'foreground-tab',
    { waitBetweenConfirmationAttempts: async () => {} }
  ), true)
  assert.equal(reads, 2)
})

test('retained recovery preserves an unconfirmed target instead of consuming it', async () => {
  let removeCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async () => ({
        id: 9,
        windowId: 1,
        pendingUrl: page().url,
        status: 'loading'
      }),
      get: async () => ({
        id: 9,
        windowId: 1,
        url: 'chrome://newtab/',
        status: 'complete'
      }),
      remove: async () => {
        removeCount += 1
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'foreground-tab',
    { waitBetweenConfirmationAttempts: async () => {} }
  ), false)
  assert.equal(removeCount, 0)
})

test('retained recovery does not trust an exact URL echoed by tabs.create', async () => {
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async () => ({
        id: 9,
        windowId: 1,
        url: page().url,
        status: 'complete'
      }),
      get: async () => ({
        id: 9,
        windowId: 1,
        url: 'chrome://newtab/',
        status: 'complete'
      })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'foreground-tab',
    { confirmationAttempts: 1 }
  ), false)
})

test('retained recovery does not trust an exact URL echoed by windows.create', async () => {
  const api = chromeApi({
    tabs: {
      query: async (queryInfo: chrome.tabs.QueryInfo) => queryInfo.windowId === 2
        ? [{ id: 20, windowId: 2, url: 'chrome://newtab/', status: 'complete' }]
        : [],
      get: async () => ({
        id: 20,
        windowId: 2,
        url: 'chrome://newtab/',
        status: 'complete'
      })
    },
    windows: {
      getAll: async () => [],
      create: async () => ({
        id: 2,
        tabs: [{ id: 20, windowId: 2, url: page().url, status: 'complete' }]
      })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page(),
    'new-window',
    { confirmationAttempts: 1 }
  ), false)
})

test('retained recovery never invokes destructive or categorically blocked privileged targets', async () => {
  let browserReadCount = 0
  let browserMutationCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => {
        browserReadCount += 1
        return []
      },
      create: async () => {
        browserMutationCount += 1
        return { id: 9, windowId: 1 }
      },
      update: async () => {
        browserMutationCount += 1
        return { id: 9, windowId: 1 }
      }
    },
    windows: {
      getAll: async () => {
        browserReadCount += 1
        return [{ id: 1, type: 'normal' }]
      },
      create: async () => {
        browserMutationCount += 1
        return { id: 2 }
      },
      update: async () => {
        browserMutationCount += 1
        return { id: 1 }
      }
    }
  })

  for (const url of [
    'chrome://restart/',
    'chrome://quit/',
    'chrome://quit-with-apps/',
    'chrome://crash/',
    'chrome://badcastcrash/',
    'chrome://hang/',
    'chrome://delayeduithreadhang/',
    'chrome://inducebrowserdcheckforrealz/',
    'chrome://memory-exhaust/',
    'chrome-untrusted://example-surface/content',
    'devtools://devtools/bundled/inspector.html'
  ]) {
    assert.equal(
      await recoverRetainedPageSnapshot(api, page({ url }), 'foreground-tab'),
      false,
      url
    )
  }
  assert.equal(browserReadCount, 0)
  assert.equal(browserMutationCount, 0)
})

test('retained recovery still invokes ordinary Chrome WebUI targets', async () => {
  const creates: chrome.tabs.CreateProperties[] = []
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async (properties: chrome.tabs.CreateProperties) => {
        creates.push(properties)
        return { id: 9, windowId: 1, url: properties.url }
      },
      get: async () => ({ id: 9, windowId: 1, url: 'chrome://settings/privacy' })
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ url: 'chrome://settings/privacy' }),
    'foreground-tab'
  ), true)
  assert.deepEqual(creates, [{
    windowId: 1,
    url: 'chrome://settings/privacy',
    active: true
  }])
})

test('retained recovery makes no browser mutation when the live-target read is unknown', async () => {
  let createCount = 0
  let windowCreateCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => {
        throw new Error('tab inventory unavailable')
      },
      create: async () => {
        createCount += 1
        return { id: 9, windowId: 1 }
      }
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }],
      update: async () => ({ id: 1 }),
      create: async () => {
        windowCreateCount += 1
        return { id: 2 }
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(api, page(), 'foreground-tab'), false)
  assert.equal(createCount, 0)
  assert.equal(windowCreateCount, 0)
})

test('retained recovery does not duplicate an exact target in an unclassified window', async () => {
  let createCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [{ id: 7, windowId: 99, url: page().url }],
      create: async () => {
        createCount += 1
        return { id: 9, windowId: 1, url: page().url }
      }
    },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal' }]
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(api, page(), 'focus-tab'), false)
  assert.equal(createCount, 0)
})

test('app fallback creates one normal browser window when no normal window exists', async () => {
  const windows: chrome.windows.CreateData[] = []
  let tabCreateCount = 0
  const api = chromeApi({
    tabs: {
      query: async () => [],
      create: async () => {
        tabCreateCount += 1
        return { id: 9, windowId: 1 }
      }
    },
    windows: {
      getAll: async () => [{ id: 4, type: 'app', focused: true }],
      update: async () => ({ id: 4 }),
      create: async (properties: chrome.windows.CreateData) => {
        windows.push(properties)
        return {
          id: 2,
          type: 'normal',
          tabs: [{ id: 20, windowId: 2, url: properties.url }]
        }
      }
    }
  })

  assert.equal(await recoverRetainedPageSnapshot(
    api,
    page({ surfaceKind: 'app' }),
    'foreground-tab'
  ), true)
  assert.equal(tabCreateCount, 0)
  assert.deepEqual(windows, [{
    url: 'https://example.test/article?view=exact#comment',
    focused: true,
    type: 'normal'
  }])
})
