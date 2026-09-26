import {
  expect,
  RETENTION_TEST_INSTRUMENTATION_MARKER,
  test,
} from './installed-extension.js'
import { TAB_OUT_FAVICON_URL } from '../../src/extension/tab-out-url.js'

test('Chrome reports the declared favicon for a Tab Out new-tab alias', async ({ installedExtension }) => {
  const created = installedExtension.context.waitForEvent('page')
  const tabId = await installedExtension.serviceWorker.evaluate(async () => {
    const tab = await chrome.tabs.create({ active: true })
    if (tab.id === undefined) throw new Error('Chrome created a tab without an id')
    return tab.id
  })
  const page = await created
  try {
    await expect(page.locator('[data-tabout="dashboard-shell"]')).toBeVisible()
    await expect.poll(() => installedExtension.serviceWorker.evaluate(async (id) => {
      const tab = await chrome.tabs.get(id)
      return { url: tab.url, favIconUrl: tab.favIconUrl, status: tab.status }
    }, tabId)).toEqual({ url: 'chrome://newtab/', favIconUrl: TAB_OUT_FAVICON_URL, status: 'complete' })
    await expect(page.locator('.history-entry-title').first()).toHaveText('\u200e')
    await expect(page.locator('.history-entry-main').first()).toHaveAttribute('aria-label', 'chrome://newtab/')
    await expect(page.locator('[data-tabout-domain="__tab-out__"] [data-tabout="page-chip"]').first()).toHaveText('\u200e')
  } finally {
    await page.close()
  }
})

test('built MV3 extension launches its worker and dashboard without runtime errors', async ({
  installedExtension,
}) => {
  expect(
    installedExtension.markerMatches,
    `Production bundles must omit ${RETENTION_TEST_INSTRUMENTATION_MARKER}`,
  ).toEqual([])
  expect(installedExtension.extensionId).toMatch(/^[a-p]{32}$/)
  expect(installedExtension.serviceWorker.url()).toBe(
    `chrome-extension://${installedExtension.extensionId}/dist/background.js`,
  )

  await expect(installedExtension.serviceWorker.evaluate(() => ({
    extensionId: chrome.runtime.id,
    manifestVersion: chrome.runtime.getManifest().manifest_version,
  }))).resolves.toEqual({
    extensionId: installedExtension.extensionId,
    manifestVersion: 3,
  })

  const page = await installedExtension.context.newPage()
  const dashboardUrl =
    `chrome-extension://${installedExtension.extensionId}/index.html`
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })

  await expect(page).toHaveURL(dashboardUrl)
  await expect(page.locator('[data-tabout="dashboard-shell"]')).toBeVisible()
  await expect(
    page.locator('[data-tabout="filter-query"] [data-tabout-part="input"]'),
  ).toBeVisible()
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })

  expect(installedExtension.runtimeErrors()).toEqual([])
})
