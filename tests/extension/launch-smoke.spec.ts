import {
  expect,
  RETENTION_TEST_INSTRUMENTATION_MARKER,
  test
} from './installed-extension.js'

test('built MV3 extension launches its worker and dashboard without runtime errors', async ({
  installedExtension
}) => {
  expect(
    installedExtension.markerMatches,
    `Production bundles must omit ${RETENTION_TEST_INSTRUMENTATION_MARKER}`
  ).toEqual([])
  expect(installedExtension.extensionId).toMatch(/^[a-p]{32}$/)
  expect(installedExtension.serviceWorker.url()).toBe(
    `chrome-extension://${installedExtension.extensionId}/dist/background.js`
  )

  await expect(installedExtension.serviceWorker.evaluate(() => ({
    extensionId: chrome.runtime.id,
    manifestVersion: chrome.runtime.getManifest().manifest_version
  }))).resolves.toEqual({
    extensionId: installedExtension.extensionId,
    manifestVersion: 3
  })

  const page = await installedExtension.context.newPage()
  const dashboardUrl =
    `chrome-extension://${installedExtension.extensionId}/index.html`
  await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })

  await expect(page).toHaveURL(dashboardUrl)
  await expect(page.locator('[data-tabout="dashboard-shell"]')).toBeVisible()
  await expect(
    page.locator('[data-tabout="filter-query"] [data-tabout-part="input"]')
  ).toBeVisible()
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })

  expect(installedExtension.runtimeErrors()).toEqual([])
})
