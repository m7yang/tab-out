import { expect, test } from '@playwright/test'

for (const width of [1420, 760]) {
  test(`bottom cue follows the actual end and changing content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 })
    await page.goto('/tests/fixtures/dashboard-resize.html?largeTabs=20')
    const region = page.locator('[data-tabout-part="scroll-region"]')
    const blur = page.locator('[data-tabout-part="scroll-bottom-blur"]')
    const input = page.locator('[data-tabout="filter-query"] input')
    await expect(blur).toHaveCSS('opacity', '1')

    const geometry = await blur.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('.scroll-region')!
      const rect = element.getBoundingClientRect()
      const scrollRect = scroller.getBoundingClientRect()
      return {
        bottomGap: scrollRect.bottom - rect.bottom,
        scrollbarGap: scrollRect.right - rect.right,
        height: rect.height,
        pointerEvents: getComputedStyle(element).pointerEvents,
      }
    })
    expect(geometry.bottomGap).toBeCloseTo(0)
    expect(geometry.scrollbarGap).toBeGreaterThanOrEqual(8)
    expect(geometry.height).toBe(56)
    expect(geometry.pointerEvents).toBe('none')

    // The final content being visible does not hide the cue: trailing space
    // still counts as remaining travel. Only the actual end clears it.
    await region.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 20 })
    await expect(blur).toHaveCSS('opacity', '1')
    await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(blur).toHaveCSS('opacity', '0')

    const previousScrollTop = await region.evaluate((element) => element.scrollTop)
    await page.evaluate(() => window.__tabOutSmokeSetBulkTabs(40))
    await expect(blur).toHaveCSS('opacity', '1')
    expect(await region.evaluate((element) => element.scrollTop)).toBe(previousScrollTop)

    await input.fill('no-matching-scroll-edge-result')
    await expect(blur).toHaveCSS('opacity', '0')
    expect(await region.evaluate((element) => element.scrollHeight === element.clientHeight)).toBe(true)
    await input.fill('')
    await expect(blur).toHaveCSS('opacity', '1')

    await page.getByRole('tab', { name: 'Open + Saved', exact: true }).click()
    await expect(blur).toHaveCSS('opacity', '1')
    await page.getByRole('tab', { name: 'All Tabs', exact: true }).click()
    await expect(blur).toHaveCSS('opacity', '1')
    await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click()
    await expect.poll(() => page.locator('[data-tabout="dashboard-shell"]').getAttribute('data-source')).toBe('bookmarks')
    await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(blur).toHaveCSS('opacity', '0')

    await page.getByRole('tab', { name: 'All Tabs', exact: true }).click()
    await expect(blur).toHaveCSS('opacity', '1')
    await page.setViewportSize({ width, height: 20000 })
    await expect(blur).toHaveCSS('opacity', '0')
    await page.setViewportSize({ width, height: 700 })
    await expect(blur).toHaveCSS('opacity', '1')
  })
}

test('bottom cue follows progressively mounted cards through to the final end', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 })
  await page.goto('/tests/fixtures/dashboard-resize.html?largeTabs=200')
  const cards = page.locator('[data-tabout-domain^="bulk-tab-"]')
  const allCards = page.locator('[data-tabout="domain-card"]')
  const sentinel = page.locator('[data-tabout-part="progressive-card-sentinel"]')
  const region = page.locator('[data-tabout-part="scroll-region"]')
  const blur = page.locator('[data-tabout-part="scroll-bottom-blur"]')
  await expect.poll(() => cards.count()).toBeGreaterThan(0)
  expect(await cards.count()).toBeLessThan(200)
  for (let pass = 0; pass < 12 && await sentinel.count() > 0; pass += 1) {
    const previousCount = await allCards.count()
    await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => allCards.count()).toBeGreaterThan(previousCount)
    await expect(blur).toHaveCSS('opacity', '1')
  }
  await expect(cards).toHaveCount(200)
  await expect(sentinel).toHaveCount(0)
  await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(blur).toHaveCSS('opacity', '0')
})

test('keyboard-selected results scroll clear of the bottom cue', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 })
  await page.goto('/tests/fixtures/dashboard-resize.html?largeTabs=60')
  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Bulk Tab')
  await expect(page.locator('[data-tabout-filter-result]')).toHaveCount(60)

  for (let index = 0; index < 20; index += 1) {
    await input.press('ArrowDown')
    const selected = page.locator('[data-tabout-filter-result-selected="true"]')
    await expect(selected).toHaveCount(1)
    const clearance = await selected.evaluate((element) => {
      const blur = document.querySelector('[data-tabout-part="scroll-bottom-blur"]')!
      return blur.getBoundingClientRect().top - element.getBoundingClientRect().bottom
    })
    expect(clearance).toBeGreaterThanOrEqual(3)
  }
  await expect(input).toBeFocused()
  expect(await page.locator('.scroll-region').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

test('expanded titles paint above the bottom cue without blocking pointer input', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 })
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const chip = page.locator('[data-tabout-domain="tab-out-smoke-24.com"] [data-tabout="page-chip"]')
  await expect(page.locator('#openTabsMissions')).toHaveClass(/is-packed/)
  await chip.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('.scroll-region')!
    scroller.scrollTop += element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 2
  })
  const bounds = await chip.boundingBox()
  if (!bounds) throw new Error('The title must have visible geometry')
  // Locator.hover scrolls the target into view first; raw pointer movement
  // preserves the deliberate overlap with the bottom band.
  await page.mouse.move(bounds.x + 35, bounds.y + 20)
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  const layering = await chip.evaluate((element) => {
    const blur = document.querySelector<HTMLElement>('[data-tabout-part="scroll-bottom-blur"]')!
    const rect = element.getBoundingClientRect()
    const blurRect = blur.getBoundingClientRect()
    // Include the decorative layer in this synchronous hit-stack probe,
    // then restore pointer transparency before the next frame.
    blur.style.pointerEvents = 'auto'
    const stack = document.elementsFromPoint(rect.left + 30, rect.bottom - 3)
    blur.style.pointerEvents = ''
    return {
      overlaps: rect.bottom > blurRect.top && rect.bottom <= blurRect.bottom,
      chipIndex: stack.indexOf(element),
      blurIndex: stack.indexOf(blur),
    }
  })
  expect(layering.overlaps).toBe(true)
  expect(layering.chipIndex).toBeGreaterThanOrEqual(0)
  expect(layering.blurIndex).toBeGreaterThan(layering.chipIndex)
})
