import type { Page, Worker } from '@playwright/test'

import { expect, test } from './installed-extension.js'

const RELOAD_ROUNDS = 50

async function tabStatus(worker: Worker, tabId: number) {
  return worker.evaluate(
    async (targetTabId) => (await chrome.tabs.get(targetTabId)).status,
    tabId,
  )
}

function targetSurfaces(page: Page, tabId: number) {
  return {
    historyEntry: page.locator(
      `[data-tabout="activation-history-row"][data-tabout-layout-key$=":${tabId}"]`,
    ),
    newTabChip: page.locator(
      '[data-tabout="domain-card"][data-tabout-domain="__tab-out__"] [data-tabout="page-chip"][data-tabout-context="domain-card"]',
    ).first(),
  }
}

async function loadingIndicatorCounts(page: Page, tabId: number) {
  const { historyEntry, newTabChip } = targetSurfaces(page, tabId)
  return {
    history: await historyEntry.locator('[data-tabout-part="loading-indicator"]').count(),
    pageChip: await newTabChip.locator('[data-tabout-part="loading-indicator"]').count(),
  }
}

test('new-tab loading indicators settle after Chrome completes across repeated reloads', async ({
  installedExtension,
}) => {
  const pageCreated = installedExtension.context.waitForEvent('page')
  const tabId = await installedExtension.serviceWorker.evaluate(async () => {
    const tab = await chrome.tabs.create({ active: true })
    if (tab.id === undefined) throw new Error('Chrome created a tab without an id')
    return tab.id
  })
  const page = await pageCreated

  try {
    await page.locator('[data-tabout="dashboard-shell"]').waitFor()

    for (let round = 1; round <= RELOAD_ROUNDS; round += 1) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[data-tabout="dashboard-shell"]').waitFor()
      const { historyEntry, newTabChip } = targetSurfaces(page, tabId)
      await expect(newTabChip, `New tabs Page Chip did not render in reload ${round}`).toBeVisible()
      await expect(historyEntry, `Target activation-history row did not render in reload ${round}`).toHaveCount(1)
      await expect.poll(
        () => tabStatus(installedExtension.serviceWorker, tabId),
        { message: `Chrome tab did not complete reload ${round}`, timeout: 2_000 },
      ).toBe('complete')

      // Give the admitted Startup Frame time to expose the race. A legitimate
      // trailing dashboard refresh still has a further second to settle below.
      await page.waitForTimeout(100)
      const firstCounts = await loadingIndicatorCounts(page, tabId)
      if (firstCounts.pageChip === 0 && firstCounts.history === 0) continue

      await expect.poll(async () => ({
        ...(await loadingIndicatorCounts(page, tabId)),
        status: await tabStatus(installedExtension.serviceWorker, tabId),
      }), {
        message: `Loading indicators remained after Chrome completed reload ${round}`,
        timeout: 1_000,
      }).toEqual({ history: 0, pageChip: 0, status: 'complete' })
    }
  } finally {
    await page.close()
  }
})
