import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { launchInstalledExtensionFromArtifact } from './installed-extension.js'

test('hovering an already selected page chip does not disable later native highlights', async () => {
  // Closing the target tabs creates retained pages. Give this interaction its
  // own profile so those records cannot affect the retention lifecycle suite.
  await using installedExtension = await launchInstalledExtensionFromArtifact(
    join(import.meta.dirname, '../../extension'),
  )
  const { context, serviceWorker, extensionId } = installedExtension
  const first = await context.newPage()
  const second = await context.newPage()
  const dashboard = await context.newPage()
  const firstUrl = 'https://hover.example.test/first'
  const secondUrl = 'https://hover.example.test/second'
  await context.route('https://hover.example.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<title>${route.request().url() === firstUrl ? 'First hover target' : 'Second hover target'}</title>`,
  }))

  await first.goto(firstUrl)
  await second.goto(secondUrl)
  await dashboard.goto(`chrome-extension://${extensionId}/index.html`)
  await dashboard.bringToFront()
  const current = await dashboard.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent()
    if (tab?.id === undefined) throw new Error('Missing dashboard tab')
    return { id: tab.id, windowId: tab.windowId }
  })
  const targets = await serviceWorker.evaluate(async ({ firstUrl, secondUrl, current }) => {
    const tabs = await chrome.tabs.query({ windowId: current.windowId })
    const first = tabs.find((tab) => tab.url === firstUrl)
    const second = tabs.find((tab) => tab.url === secondUrl)
    const dashboard = tabs.find((tab) => tab.id === current.id)
    if (first?.id === undefined || second?.id === undefined || !dashboard) {
      throw new Error('Missing hover test tabs')
    }
    await chrome.tabs.highlight({ windowId: current.windowId, tabs: [dashboard.index, first.index] })
    return { firstId: first.id, secondId: second.id }
  }, { firstUrl, secondUrl, current })
  const chips = dashboard.locator('[data-tabout="page-chip"][data-tabout-context="domain-card"]')
  const firstChip = chips.filter({ hasText: 'First hover target' })
  const secondChip = chips.filter({ hasText: 'Second hover target' })
  await expect(firstChip).toBeVisible()
  await expect(secondChip).toBeVisible()
  const selection = () => serviceWorker.evaluate(async (windowId) => {
    const tabs = await chrome.tabs.query({ windowId })
    return {
      activeId: tabs.find((tab) => tab.active)?.id,
      highlightedIds: tabs.filter((tab) => tab.highlighted).map((tab) => tab.id).sort(),
    }
  }, current.windowId)
  const expectedSelection = (extra: number[] = []) => ({
    activeId: current.id,
    highlightedIds: [current.id, targets.firstId, ...extra].sort(),
  })

  for (let round = 0; round < 3; round += 1) {
    await firstChip.hover()
    // Allow the read-only preview to settle before leaving its chip.
    await dashboard.waitForTimeout(100)
    await dashboard.mouse.move(0, 0)
    await dashboard.waitForTimeout(100)
    await secondChip.hover()
    await expect.poll(selection).toEqual(expectedSelection([targets.secondId]))
    await dashboard.mouse.move(0, 0)
    await expect.poll(selection).toEqual(expectedSelection())
  }
})
