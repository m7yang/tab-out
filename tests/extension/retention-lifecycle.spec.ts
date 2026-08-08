import type { Worker } from '@playwright/test'

import { RETAINED_PAGES_EXPIRY_ALARM } from '../../src/extension/background/retained-pages-expiry-alarm.js'
import {
  createClosureToken,
  createRetainedPageIdentity,
  type RetainedPageSurfaceKind
} from '../../src/extension/retained-page-identity.js'
import {
  recordRetainedPageClosure,
  RETAINED_PAGE_LIFETIME_MS
} from '../../src/extension/retained-pages-ledger.js'
import type {
  RetainedPageLedger,
  RetainedPageRecord
} from '../../src/extension/retained-pages-ledger.js'
import {
  decodeRetainedPageLedgerStorageValue,
  encodeRetainedPageLedgerStorageValue,
  parseRetainedPageLedgerValue,
  RETAINED_PAGES_STORAGE_KEY
} from '../../src/extension/retained-pages-storage.js'
import {
  RETAINED_PAGE_REMOVE_MESSAGE
} from '../../src/extension/runtime-messages.js'
import {
  expect,
  test,
  type InstalledExtension
} from './installed-extension.js'

const DURABLE_INVENTORY_STORAGE_KEY = 'tabOutOpenSurfacesDurableV1'

type InstalledRetainedPage = RetainedPageRecord

async function findTabId(worker: Worker, url: string): Promise<number> {
  await expect.poll(() => worker.evaluate(async (targetUrl) => {
    const matchingTab = (await chrome.tabs.query({})).find((tab) => tab.url === targetUrl)
    return matchingTab?.id ?? null
  }, url)).not.toBeNull()

  const tabId = await worker.evaluate(async (targetUrl) => {
    const matchingTab = (await chrome.tabs.query({})).find((tab) => tab.url === targetUrl)
    return matchingTab?.id ?? null
  }, url)
  if (tabId === null) throw new Error(`Could not resolve installed-extension tab for ${url}`)
  return tabId
}

async function waitForDurableInventoryEntry(
  worker: Worker,
  tabId: number,
  url: string
): Promise<void> {
  await expect.poll(() => worker.evaluate(async ({ key, nextTabId, targetUrl }) => {
    const stored = await chrome.storage.local.get(key)
    const inventory = stored[key] as {
      entries?: Record<string, { url?: string }>
    } | undefined
    return inventory?.entries?.[String(nextTabId)]?.url === targetUrl
  }, {
    key: DURABLE_INVENTORY_STORAGE_KEY,
    nextTabId: tabId,
    targetUrl: url
  })).toBe(true)
}

async function retainedPageForUrl(
  worker: Worker,
  url: string
): Promise<InstalledRetainedPage | null> {
  const raw = await worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key)
    return stored[key] as unknown
  }, RETAINED_PAGES_STORAGE_KEY)
  const parsed = parseRetainedPageLedgerValue(
    await decodeRetainedPageLedgerStorageValue(raw)
  )
  if (parsed.status !== 'valid') return null
  return Object.values(parsed.ledger.pages).find((page) => page.url === url) ?? null
}

async function writeRetainedPageClosureTime(
  worker: Worker,
  url: string,
  closedAt: number
): Promise<InstalledRetainedPage> {
  const raw = await worker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key)
    return stored[key] as unknown
  }, RETAINED_PAGES_STORAGE_KEY)
  const parsed = parseRetainedPageLedgerValue(
    await decodeRetainedPageLedgerStorageValue(raw)
  )
  if (parsed.status !== 'valid') {
    throw new Error(`Cannot rewrite ${url}: retained ledger is ${parsed.status}`)
  }
  const entry = Object.entries(parsed.ledger.pages)
    .find(([, page]) => page.url === url)
  if (!entry) throw new Error(`Cannot rewrite missing retained page: ${url}`)
  const [identityDigest, page] = entry
  const rewritten: RetainedPageLedger = {
    ...parsed.ledger,
    pages: {
      ...parsed.ledger.pages,
      [identityDigest]: { ...page, closedAt }
    }
  }
  const encoded = await encodeRetainedPageLedgerStorageValue(rewritten)
  await worker.evaluate(async ({ key, value }) => {
    await chrome.storage.local.set({ [key]: value })
  }, { key: RETAINED_PAGES_STORAGE_KEY, value: encoded })
  return rewritten.pages[identityDigest]!
}

async function seedRetainedPages(
  worker: Worker,
  candidates: readonly {
    surfaceKind: RetainedPageSurfaceKind
    title: string
    url: string
  }[]
): Promise<readonly InstalledRetainedPage[]> {
  const { runtimeId, stored } = await worker.evaluate(async (key) => ({
    runtimeId: chrome.runtime.id,
    stored: (await chrome.storage.local.get(key))[key] as unknown
  }), RETAINED_PAGES_STORAGE_KEY)
  const seededAt = Date.now()
  const parsed = parseRetainedPageLedgerValue(
    await decodeRetainedPageLedgerStorageValue(stored)
  )
  if (parsed.status !== 'valid' && parsed.status !== 'missing') {
    throw new Error(`Cannot seed retained pages: retained ledger is ${parsed.status}`)
  }

  let ledger = parsed.ledger
  const records: InstalledRetainedPage[] = []
  for (const [index, candidate] of candidates.entries()) {
    const identity = await createRetainedPageIdentity(candidate, { runtimeId })
    if (!identity) throw new Error(`Cannot seed ineligible retained page: ${candidate.url}`)
    const record: InstalledRetainedPage = {
      identityDigest: identity.identityDigest,
      surfaceKind: identity.surfaceKind,
      canonicalKey: identity.canonicalKey,
      url: identity.url,
      title: candidate.title,
      closedAt: seededAt - candidates.length + index,
      closureToken: createClosureToken()
    }
    const transition = recordRetainedPageClosure(ledger, record)
    if (!transition.changed || transition.outcome !== 'inserted') {
      throw new Error(`Cannot seed retained page: ${transition.outcome}`)
    }
    ledger = transition.ledger
    records.push(record)
  }

  const encoded = await encodeRetainedPageLedgerStorageValue(ledger)
  await worker.evaluate(async ({ key, value }) => {
    await chrome.storage.local.set({ [key]: value })
  }, { key: RETAINED_PAGES_STORAGE_KEY, value: encoded })
  return records
}

async function closePageAndWaitForRetentionDetails(
  installedExtension: InstalledExtension,
  targetUrl: string
): Promise<{ retainedPage: InstalledRetainedPage; tabId: number }> {
  const target = await installedExtension.context.newPage()
  await target.goto(targetUrl, { waitUntil: 'domcontentloaded' })
  await expect(target).toHaveURL(targetUrl)

  const tabId = await findTabId(installedExtension.serviceWorker, targetUrl)
  await waitForDurableInventoryEntry(installedExtension.serviceWorker, tabId, targetUrl)
  await target.close()

  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  )).not.toBeNull()
  const retainedPage = await retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  )
  if (!retainedPage) throw new Error(`Closed internal page was not retained: ${targetUrl}`)
  return { retainedPage, tabId }
}

async function closePageAndWaitForRetention(
  installedExtension: InstalledExtension,
  targetUrl: string
): Promise<InstalledRetainedPage> {
  return (await closePageAndWaitForRetentionDetails(
    installedExtension,
    targetUrl
  )).retainedPage
}

test('real chrome APIs retain, present, and remove a closed internal page', async ({
  installedExtension
}) => {
  const targetUrl = 'chrome://settings/privacy'
  const retainedPage = await closePageAndWaitForRetention(
    installedExtension,
    targetUrl
  )
  expect(retainedPage.title).not.toBe('')

  const dashboard = await installedExtension.context.newPage()
  await dashboard.goto(
    `chrome-extension://${installedExtension.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' }
  )
  const chip = dashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: retainedPage.title })
    .first()
  await expect(chip).toBeVisible()
  const card = dashboard.locator('[data-tabout="domain-card"]', { has: chip })
  await expect(card).toContainText('1 closed')
  await expect(chip).not.toHaveAttribute('aria-label', /open copies/)

  await chip.click({ button: 'right' })
  await expect(dashboard.getByRole('menuitem', { name: 'Save page' })).toBeVisible()
  await expect(dashboard.getByRole('menuitem', { name: 'Remove from Tabs' })).toBeVisible()
  await expect(dashboard.getByRole('menuitem', { name: 'Remove saved page' })).toHaveCount(0)
  await expect(dashboard.getByRole('menuitem', { name: 'Reload' })).toHaveCount(0)
  await expect(dashboard.getByRole('menuitem', { name: 'Duplicate' })).toHaveCount(0)
  await dashboard.getByRole('menuitem', { name: 'Remove from Tabs' }).click()

  await expect(dashboard.getByText('Removed from Tabs', { exact: true })).toBeVisible()
  await expect(dashboard.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  )).toBeNull()
  await expect(chip).toHaveCount(0)
  await dashboard.close()
})

test('two live dashboards converge after physical retention and exact removal', async ({
  installedExtension
}) => {
  const dashboardUrl =
    `chrome-extension://${installedExtension.extensionId}/index.html`
  const firstDashboard = await installedExtension.context.newPage()
  const secondDashboard = await installedExtension.context.newPage()
  await Promise.all([
    firstDashboard.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }),
    secondDashboard.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
  ])
  await Promise.all([
    expect(firstDashboard.locator('[data-tabout="dashboard-shell"]')).toBeVisible(),
    expect(secondDashboard.locator('[data-tabout="dashboard-shell"]')).toBeVisible()
  ])
  await firstDashboard.evaluate(() => {
    ;(window as typeof window & { __retentionConvergenceDocument?: string })
      .__retentionConvergenceDocument = 'first-dashboard'
  })
  await secondDashboard.evaluate(() => {
    ;(window as typeof window & { __retentionConvergenceDocument?: string })
      .__retentionConvergenceDocument = 'second-dashboard'
  })

  const targetUrl = 'chrome://settings/languages'
  const retainedPage = await closePageAndWaitForRetention(
    installedExtension,
    targetUrl
  )
  const firstChip = firstDashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: retainedPage.title })
    .first()
  const secondChip = secondDashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: retainedPage.title })
    .first()
  await Promise.all([
    expect(firstChip).toBeVisible(),
    expect(secondChip).toBeVisible()
  ])
  await Promise.all([
    expect(firstDashboard.locator('[data-tabout="domain-card"]', { has: firstChip }))
      .toContainText('1 closed'),
    expect(secondDashboard.locator('[data-tabout="domain-card"]', { has: secondChip }))
      .toContainText('1 closed')
  ])

  await firstChip.click({ button: 'right' })
  await firstDashboard.getByRole('menuitem', { name: 'Remove from Tabs' }).click()

  await Promise.all([
    expect(firstDashboard.getByText('Removed from Tabs', { exact: true })).toBeVisible(),
    expect.poll(() => retainedPageForUrl(
      installedExtension.serviceWorker,
      targetUrl
    )).toBeNull(),
    expect(firstChip).toHaveCount(0),
    expect(secondChip).toHaveCount(0)
  ])
  await Promise.all([
    expect(firstDashboard.getByRole('button', { name: 'Undo' })).toHaveCount(0),
    expect(secondDashboard.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  ])
  expect(await firstDashboard.evaluate(() => (
    window as typeof window & { __retentionConvergenceDocument?: string }
  ).__retentionConvergenceDocument)).toBe('first-dashboard')
  expect(await secondDashboard.evaluate(() => (
    window as typeof window & { __retentionConvergenceDocument?: string }
  ).__retentionConvergenceDocument)).toBe('second-dashboard')
  expect(firstDashboard.url()).toBe(dashboardUrl)
  expect(secondDashboard.url()).toBe(dashboardUrl)
  expect(installedExtension.runtimeErrors()).toEqual([])

  await Promise.all([firstDashboard.close(), secondDashboard.close()])
})

test('the production earliest-expiry alarm durably prunes a retained page', async ({
  installedExtension
}) => {
  const dashboardUrl =
    `chrome-extension://${installedExtension.extensionId}/index.html`
  const dashboard = await installedExtension.context.newPage()
  await dashboard.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
  await expect(dashboard.locator('[data-tabout="dashboard-shell"]')).toBeVisible()
  await dashboard.evaluate(() => {
    ;(window as typeof window & { __retentionExpiryDocument?: string })
      .__retentionExpiryDocument = 'expiry-dashboard'
  })

  const targetUrl = 'chrome://downloads/'
  const { retainedPage } = await closePageAndWaitForRetentionDetails(
    installedExtension,
    targetUrl
  )
  const chip = dashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: retainedPage.title })
    .first()
  await expect(chip).toBeVisible()
  await expect(dashboard.locator('[data-tabout="domain-card"]', { has: chip }))
    .toContainText('1 closed')

  const expiresAt = Date.now() + 3_000
  const rewritten = await writeRetainedPageClosureTime(
    installedExtension.serviceWorker,
    targetUrl,
    expiresAt - RETAINED_PAGE_LIFETIME_MS
  )
  await expect.poll(async () => (
    await retainedPageForUrl(installedExtension.serviceWorker, targetUrl)
  )?.closedAt).toBe(rewritten.closedAt)
  await expect(chip).toBeVisible()

  const synchronization = await dashboard.evaluate(async ({ messageType }) => (
    chrome.runtime.sendMessage({
      type: messageType,
      identityDigest: 'absent-expiry-synchronization',
      closureToken: 'absent-expiry-synchronization'
    })
  ), {
    messageType: RETAINED_PAGE_REMOVE_MESSAGE
  })
  expect(synchronization).toEqual({ ok: true, outcome: 'already-absent' })

  await expect.poll(() => installedExtension.serviceWorker.evaluate(async (name) => {
    const alarm = await chrome.alarms.get(name)
    return alarm
      ? { name: alarm.name, scheduledTime: alarm.scheduledTime }
      : null
  }, RETAINED_PAGES_EXPIRY_ALARM)).toEqual({
    name: RETAINED_PAGES_EXPIRY_ALARM,
    scheduledTime: expiresAt
  })

  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  ), {
    timeout: 10_000,
    intervals: [50, 100, 200, 500]
  }).toBeNull()
  await expect(chip).toHaveCount(0)
  await expect.poll(() => installedExtension.serviceWorker.evaluate(async (name) => (
    await chrome.alarms.get(name) ?? null
  ), RETAINED_PAGES_EXPIRY_ALARM)).toBeNull()
  await expect(dashboard.getByText('Removed from Tabs', { exact: true })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  expect(await dashboard.evaluate(() => (
    window as typeof window & { __retentionExpiryDocument?: string }
  ).__retentionExpiryDocument)).toBe('expiry-dashboard')
  expect(dashboard.url()).toBe(dashboardUrl)
  expect(installedExtension.runtimeErrors()).toEqual([])

  await dashboard.close()
})

test('an app retained snapshot falls back to one exact ordinary tab', async ({
  installedExtension
}) => {
  const targetUrl = 'chrome://settings/accessibility'
  const companionUrl = 'chrome://settings/system'
  const [targetRecord, companionRecord] = await seedRetainedPages(
    installedExtension.serviceWorker,
    [
      {
        surfaceKind: 'app',
        title: 'Example App Target',
        url: targetUrl
      },
      {
        surfaceKind: 'app',
        title: 'Example App Companion',
        url: companionUrl
      }
    ]
  )
  if (!targetRecord || !companionRecord) {
    throw new Error('App retained fixtures were not seeded')
  }

  const dashboard = await installedExtension.context.newPage()
  await dashboard.goto(
    `chrome-extension://${installedExtension.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' }
  )
  const targetChip = dashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: targetRecord.title })
    .first()
  const companionChip = dashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: companionRecord.title })
    .first()
  await Promise.all([
    expect(targetChip).toBeVisible(),
    expect(companionChip).toBeVisible()
  ])
  await expect(dashboard.locator('[data-tabout="domain-card"]', { has: targetChip }))
    .toContainText('2 closed')
  expect(await installedExtension.serviceWorker.evaluate(async (url) => (
    (await chrome.tabs.query({})).some((tab) => tab.url === url)
  ), targetUrl)).toBe(false)

  await targetChip.click()

  await expect.poll(() => installedExtension.serviceWorker.evaluate(async (url) => {
    const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url === url)
    const windowTypes = new Map(
      (await chrome.windows.getAll()).map((window) => [window.id, window.type])
    )
    return tabs.map((tab) => ({
      url: tab.url,
      windowType: windowTypes.get(tab.windowId)
    }))
  }, targetUrl)).toEqual([{
    url: targetUrl,
    windowType: 'normal'
  }])
  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  )).toBeNull()
  await expect.poll(async () => (
    await retainedPageForUrl(installedExtension.serviceWorker, companionUrl)
  )?.closureToken).toBe(companionRecord.closureToken)
  const targetTabId = await installedExtension.serviceWorker.evaluate(async (url) => (
    (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? null
  ), targetUrl)
  if (targetTabId === null) throw new Error('App fallback tab disappeared before cleanup')

  await dashboard.bringToFront()
  await expect(targetChip).toHaveCount(0)
  await expect(companionChip).toBeVisible()
  await companionChip.click({ button: 'right' })
  await dashboard.getByRole('menuitem', { name: 'Remove from Tabs' }).click()
  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    companionUrl
  )).toBeNull()

  await installedExtension.serviceWorker.evaluate(async (tabId) => {
    await chrome.tabs.update(tabId, { url: 'about:blank', active: false })
  }, targetTabId)
  await expect.poll(() => installedExtension.serviceWorker.evaluate(async ({ key, tabId }) => {
    const stored = await chrome.storage.local.get(key)
    const inventory = stored[key] as {
      entries?: Record<string, unknown>
    } | undefined
    return Object.hasOwn(inventory?.entries ?? {}, String(tabId))
  }, {
    key: DURABLE_INVENTORY_STORAGE_KEY,
    tabId: targetTabId
  })).toBe(false)
  await installedExtension.serviceWorker.evaluate(async (tabId) => {
    await chrome.tabs.remove(tabId)
  }, targetTabId)
  await expect.poll(() => installedExtension.serviceWorker.evaluate(async (tabId) => (
    (await chrome.tabs.query({})).some((tab) => tab.id === tabId)
  ), targetTabId)).toBe(false)
  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  )).toBeNull()
  expect(installedExtension.runtimeErrors()).toEqual([])
  await dashboard.close()
})

test('real chrome APIs reopen the exact retained target and consume its snapshot', async ({
  installedExtension
}) => {
  const targetUrl = 'chrome://settings/appearance'
  const retainedPage = await closePageAndWaitForRetention(
    installedExtension,
    targetUrl
  )
  expect(
    installedExtension.context.pages().some((page) => page.url() === targetUrl)
  ).toBe(false)

  const dashboard = await installedExtension.context.newPage()
  await dashboard.goto(
    `chrome-extension://${installedExtension.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' }
  )
  const chip = dashboard.locator('[data-tabout="page-chip"]')
    .filter({ hasText: retainedPage.title })
    .first()
  await expect(chip).toBeVisible()
  await chip.click()

  await expect.poll(() => installedExtension.serviceWorker.evaluate(async (url) => (
    (await chrome.tabs.query({})).some((tab) => tab.url === url)
  ), targetUrl)).toBe(true)
  await expect.poll(() => retainedPageForUrl(
    installedExtension.serviceWorker,
    targetUrl
  )).toBeNull()

  await dashboard.bringToFront()
  await expect(chip).toHaveCount(0)
})
