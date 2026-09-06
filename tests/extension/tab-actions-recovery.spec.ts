import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { test as base, type Worker } from '@playwright/test'

import {
  OPEN_SURFACE_DURABLE_STORAGE_KEY,
  parseOpenSurfaceInventoryValue,
} from '../../src/extension/open-surface-inventory-storage.js'
import {
  decodeRetainedPageLedgerStorageValue,
  parseRetainedPageLedgerValue,
  RETAINED_PAGES_STORAGE_KEY,
} from '../../src/extension/retained-pages-storage.js'
import { RETAINED_PAGE_ACTIVATE_MESSAGE } from '../../src/extension/runtime-messages.js'
import {
  expect,
  launchInstalledExtensionFromArtifact,
  type InstalledExtension,
} from './installed-extension.js'

const test = base.extend<{ installedExtension: InstalledExtension }>({
  installedExtension: async ({}, use) => {
    await using installedExtension = await launchInstalledExtensionFromArtifact(
      join(import.meta.dirname, '../../extension'),
    )
    await use(installedExtension)
  },
})

const exampleDocument = '<title>Example Article</title><link rel="icon" href="data:,">'

async function startExampleServer(onDeparture?: () => Promise<void>) {
  const server = createServer(async (request, response) => {
    if (request.url === '/recovery-beta') await onDeparture?.()
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    })
    response.end(exampleDocument)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The example server has no address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections()
      await server[Symbol.asyncDispose]()
    },
  }
}

async function readLocalStorage(worker: Worker, key: string): Promise<unknown> {
  return worker.evaluate(async (storageKey): Promise<unknown> =>
    (await chrome.storage.local.get(storageKey))[storageKey], key)
}

async function retainedPageForUrl(worker: Worker, url: string) {
  const parsed = parseRetainedPageLedgerValue(await decodeRetainedPageLedgerStorageValue(
    await readLocalStorage(worker, RETAINED_PAGES_STORAGE_KEY),
  ))
  return parsed.status === 'valid'
    ? Object.values(parsed.ledger.pages).find((page) => page.url === url) ?? null
    : null
}

test('popup cleanup reports and undoes every acknowledged close around a stale tab ID', async ({
  installedExtension: { context, serviceWorker, extensionId },
}) => {
  await using server = await startExampleServer()
  const url = `${server.origin}/cleanup-alpha`
  const popup = await context.newPage()
  try {
    const lastDuplicateId = await serviceWorker.evaluate(async (targetUrl) => {
      await chrome.tabs.create({ url: targetUrl, active: false, pinned: true })
      await chrome.tabs.create({ url: targetUrl, active: false })
      return (await chrome.tabs.create({ url: targetUrl, active: false })).id
    }, url)
    expect(lastDuplicateId).toBeDefined()
    await expect.poll(() => serviceWorker.evaluate(async (targetUrl) =>
      (await chrome.tabs.query({})).filter((tab) =>
        tab.url === targetUrl && tab.status === 'complete',
      ).length, url)).toBe(3)

    // Supply one stale inventory entry between real duplicates. Removal and
    // Undo still use the installed extension's real Chrome APIs and bundles.
    await popup.addInitScript(({ targetUrl, followingTabId }) => {
      const query = chrome.tabs.query.bind(chrome.tabs)
      Object.defineProperty(chrome.tabs, 'query', {
        configurable: true,
        value: async (queryInfo: chrome.tabs.QueryInfo) => {
          const tabs = await query(queryInfo)
          if (queryInfo.windowId !== undefined) return tabs
          const followingIndex = tabs.findIndex((tab) =>
            tab.id === followingTabId && tab.url === targetUrl,
          )
          const followingTab = tabs[followingIndex]
          if (followingTab) {
            tabs.splice(followingIndex, 0, { ...followingTab, id: 2_000_000_000 })
          }
          return tabs
        },
      })
    }, { targetUrl: url, followingTabId: lastDuplicateId })
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    const dedupe = popup.getByRole('button', { name: 'Dedupe 3 duplicate tabs', exact: true })
    await expect(dedupe).toBeEnabled()
    await dedupe.click()
    await expect(popup.getByText('Closed 2 of 3 duplicates', { exact: true })).toBeVisible()
    await expect.poll(() => serviceWorker.evaluate(async (targetUrl) =>
      (await chrome.tabs.query({})).filter((tab) => tab.url === targetUrl).length,
    url)).toBe(1)

    await popup.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => serviceWorker.evaluate(async (targetUrl) =>
      (await chrome.tabs.query({})).filter((tab) =>
        (tab.pendingUrl || tab.url) === targetUrl,
      ).length, url)).toBe(3)
  } finally {
    await context.close()
  }
})

test('retained activation preserves a departing tab and restores the requested page separately', async ({
  installedExtension: { context, serviceWorker, extensionId },
}) => {
  const navigationStarted = Promise.withResolvers<void>()
  const releaseNavigation = Promise.withResolvers<void>()
  await using server = await startExampleServer(async () => {
    navigationStarted.resolve()
    await releaseNavigation.promise
  })
  const retainedUrl = `${server.origin}/recovery-alpha`
  const departingUrl = `${server.origin}/recovery-beta`
  const original = await context.newPage()
  const dashboard = await context.newPage()
  const departing = await context.newPage()
  let navigation: Promise<unknown> | undefined
  try {
    await original.goto(retainedUrl)
    const originalId = await serviceWorker.evaluate(async (targetUrl) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === targetUrl)?.id,
    retainedUrl)
    expect(originalId).toBeDefined()
    await expect.poll(async () => {
      const parsed = parseOpenSurfaceInventoryValue(
        await readLocalStorage(serviceWorker, OPEN_SURFACE_DURABLE_STORAGE_KEY),
      )
      return parsed.status === 'valid' &&
        parsed.inventory.entries[String(originalId)]?.url === retainedUrl
    }).toBe(true)
    await original.close()
    await expect.poll(() => retainedPageForUrl(serviceWorker, retainedUrl)).not.toBeNull()
    const retained = await retainedPageForUrl(serviceWorker, retainedUrl)
    if (!retained) throw new Error('The closed example page was not retained')

    await departing.goto(retainedUrl)
    const departingId = await serviceWorker.evaluate(async (targetUrl) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === targetUrl)?.id,
    retainedUrl)
    if (typeof departingId !== 'number') throw new Error('The departing example tab is missing')
    await dashboard.goto(`chrome-extension://${extensionId}/index.html`)
    navigation = departing.goto(departingUrl).catch(() => undefined)
    await navigationStarted.promise
    await expect.poll(() => serviceWorker.evaluate(async (tabId) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.id === tabId)
      return { committed: tab?.url, intended: tab?.pendingUrl }
    }, departingId)).toEqual({ committed: retainedUrl, intended: departingUrl })

    const response = await dashboard.evaluate((message) => chrome.runtime.sendMessage(message), {
      type: RETAINED_PAGE_ACTIVATE_MESSAGE,
      identityDigest: retained.identityDigest,
      closureToken: retained.closureToken,
      disposition: 'focus-tab',
    })
    const recoveryTabs = await serviceWorker.evaluate(async () =>
      (await chrome.tabs.query({})).map(({ id, url, pendingUrl, status }) => ({
        id, url, pendingUrl, status,
      })))
    expect(response, JSON.stringify(recoveryTabs)).toEqual({ ok: true, outcome: 'activated' })
    const restoredIds = recoveryTabs.filter((tab) =>
      (tab.pendingUrl || tab.url) === retainedUrl,
    ).map((tab) => tab.id)
    expect(restoredIds).toHaveLength(1)
    expect(restoredIds).not.toContain(departingId)
    expect(await serviceWorker.evaluate(async (tabId) =>
      (await chrome.tabs.get(tabId)).pendingUrl, departingId)).toBe(departingUrl)
    await expect.poll(() => retainedPageForUrl(serviceWorker, retainedUrl)).toBeNull()

    releaseNavigation.resolve()
    await navigation
    await expect(departing).toHaveURL(departingUrl)
  } finally {
    releaseNavigation.resolve()
    await navigation
    await context.close()
  }
})
