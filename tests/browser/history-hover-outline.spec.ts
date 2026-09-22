import { expect, test } from '@playwright/test'

test('keyboard history activation waits for another row’s pending native highlight', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyHoverFrameExpanded=above')
  const focused = page.locator('[data-tabout-layout-key="stack:1:9101"] .history-entry-main')
  const hovered = page.locator('[data-tabout-layout-key="stack:1:9103"] [data-tabout="page-chip"]')
  await focused.focus()
  await expect(page.locator('.page-chip-hover-match')).toHaveText('History Alpha')
  await page.evaluate(() => {
    // The layout fixture omits windows.get; supply the read needed to reach
    // the real native-highlight controller's selection lookup.
    Reflect.set(chrome.windows, 'get', async (id: number) => (
      (await chrome.windows.getAll()).find((window) => window.id === id)
    ))
    const query = chrome.tabs.query.bind(chrome.tabs)
    let paused = false
    Reflect.set(chrome.tabs, 'query', async (options: chrome.tabs.QueryInfo) => {
      const snapshot = await query(options)
      if (!paused && options.windowId === 1) {
        paused = true
        await new Promise<void>((resolve) => Reflect.set(window, '__releaseHistoryHoverQuery', resolve))
      }
      return snapshot
    })
    const activated: number[] = []
    Reflect.set(window, '__historyHoverActivated', activated)
    const update = chrome.tabs.update.bind(chrome.tabs)
    Reflect.set(chrome.tabs, 'update', async (id: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.active) activated.push(id)
      return update(id, properties)
    })
  })
  const rect = await hovered.boundingBox()
  if (!rect) throw new Error('History chip is missing')
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await expect(page.locator('.page-chip-hover-match')).toContainText('History Charlie')
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, '__releaseHistoryHoverQuery'))).toBe('function')
  await page.keyboard.press('Enter')
  // Clearing the visual match must not let activation overtake the pending
  // native selection: that selection captured the previously active tab.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  expect(await page.evaluate(() => Reflect.get(window, '__historyHoverActivated'))).toEqual([])
  await expect(page.locator('.page-chip-hover-match')).toHaveCount(0)
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, '__releaseHistoryHoverQuery')
    if (typeof release !== 'function') throw new Error('Native highlight query was not paused')
    release()
  })
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__historyHoverActivated'))).toEqual([9101])
})

for (const departingOwner of ['focus', 'pointer']) {
  test(`a departing ${departingOwner} owner cannot clear a newer history match`, async ({ page }) => {
    await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyHoverFrameExpanded=above')
    const oldRow = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9104"]')
    const newRow = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9103"]')
    const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="history-reorder.test"]')
    const match = card.locator('.page-chip-hover-match').filter({ hasText: 'History Charlie' })
    await expect(oldRow).toBeVisible()
    const pointerRow = departingOwner === 'focus' ? newRow : oldRow
    const focusRow = departingOwner === 'focus' ? oldRow : newRow
    if (departingOwner === 'focus') await focusRow.locator('.history-entry-main').focus()
    const rect = await pointerRow.locator('[data-tabout="page-chip"]').boundingBox()
    if (!rect) throw new Error('History chip is missing')
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    if (departingOwner === 'pointer') await focusRow.locator('.history-entry-main').first().focus()
    await expect(match).toHaveCount(1)
    await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1')

    if (departingOwner === 'focus') await page.locator('input').first().focus()
    else await page.mouse.move(2, 2)

    await expect(match).toHaveCount(1)
    await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1')
    if (departingOwner === 'focus') await page.mouse.move(2, 2)
    else await page.locator('input').first().focus()
    await expect(card.locator('.page-chip-hover-match')).toHaveCount(0)
    await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('0')
  })
}

test('history card outline follows the expanded surface through menu dismissal and departure', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyHoverFrameExpanded=above')
  const row = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9103"]')
  const chip = row.locator('[data-tabout="page-chip"]')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="history-reorder.test"]')
  await expect(chip).toBeVisible()
  const rest = await chip.boundingBox()
  if (!rest) throw new Error('History chip is missing')
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2)
  const expanded = row.locator('[data-tabout-part="expanded-surface"]')
  await expect(expanded).toBeVisible()
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1')
  const bounds = await expanded.boundingBox()
  if (!rest || !bounds) throw new Error('History surfaces are missing')
  const point = { x: Math.min(bounds.x + bounds.width - 4, rest.x + rest.width + 16), y: rest.y + rest.height / 2 }
  await page.mouse.move(point.x, point.y)
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.locator('[data-slot="context-menu-content"]')).toBeVisible()
  await page.mouse.move(2, 2)
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await page.mouse.click(point.x, point.y)
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0)
  await expect(expanded).toBeVisible()
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1')
  await page.mouse.move(2, 2)
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(0)
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('0')
})

test.describe('history hover beside an active frame', () => {
  test.use({ deviceScaleFactor: 4 })

  for (const expanded of [false, true]) {
    for (const side of ['above', 'below']) {
      test(`keeps the active frame visible with a ${expanded ? 'long' : 'short'} title ${side}`, async ({ page }) => {
        await page.goto(`/tests/fixtures/dashboard-resize.html?historyHoverFrame${expanded ? `&historyHoverFrameExpanded=${side}` : ''}`)
        const framed = page.locator('.history-entry[data-active-in-other-window="true"]')
        const neighbor = page.locator('.history-entry:not(.history-entry-expanded)').filter({ hasText: side === 'above' ? 'History Charlie' : 'History Alpha' })
        await expect(framed).toBeVisible()
        const rect = await framed.boundingBox()
        const neighborRect = await neighbor.boundingBox()
        if (!rect || !neighborRect) throw new Error('Adjacent history rows are missing')
        // Verify the intended shared edge, rather than trusting fixture order.
        expect(side === 'above' ? neighborRect.y + neighborRect.height - rect.y : rect.y + rect.height - neighborRect.y).toBeCloseTo(1, 4)
        await page.mouse.move(neighborRect.x + neighborRect.width / 2, neighborRect.y + neighborRect.height / 2)
        if (expanded) await expect(page.locator('.history-entry-expanded')).toBeVisible()
        const clip = {
          x: rect.x + rect.width / 2,
          y: side === 'above' ? rect.y : rect.y + rect.height - 1,
          width: 20,
          height: 1,
        }
        const actual = await page.screenshot({ clip, animations: 'disabled' })
        // If hiding the frame changes nothing, the neighboring fill has covered it.
        await framed.locator('.active-history-entry-frame').evaluate((element) => { element.style.visibility = 'hidden' })
        const withoutFrame = await page.screenshot({ clip, animations: 'disabled' })
        expect(actual.equals(withoutFrame), `active frame must contribute to the ${side} seam`).toBe(false)
      })
    }
  }
})

test('history hover keeps both adjacent matching dashboard outlines above neighboring fills', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverSeam')
  const history = page.locator('.history-entry-main').filter({ hasText: 'New Tab' }).first()
  await history.hover()
  const matches = page.locator('.page-chip-hover-match')
  await expect(matches).toHaveCount(2)

  for (const edge of ['bottom', 'top'] as const) {
    const owner = matches.nth(edge === 'bottom' ? 0 : 1)
    const neighbor = matches.nth(edge === 'bottom' ? 1 : 0)
    const rect = await owner.boundingBox()
    if (!rect) throw new Error('Highlighted dashboard tab is missing')
    const clip = {
      x: Math.floor(rect.x + rect.width / 2),
      y: Math.floor(edge === 'bottom' ? rect.y + rect.height + 1 : rect.y - 2),
      width: 20,
      height: 1,
    }
    const actual = await page.screenshot({ clip, animations: 'disabled' })
    await neighbor.evaluate((element) => { element.style.visibility = 'hidden' })
    const unobstructed = await page.screenshot({ clip, animations: 'disabled' })
    await neighbor.evaluate((element) => { element.style.visibility = '' })
    expect(actual.equals(unobstructed), `${edge} outline should remain visible beside another matching tab`).toBe(true)
  }
})
