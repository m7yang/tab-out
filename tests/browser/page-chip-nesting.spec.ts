import { expect, test } from '@playwright/test'

const cardFrame = '[data-tabout-part="history-match-frame"]'
const pageFrame = '[data-tabout-part="history-page-match-frame"]'

test('a one-line card keeps its compact height when the fixed outline appears', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion')
  const card = page.locator('[data-tabout-domain="bravo.test"]')
  const chip = card.locator('.page-chip')
  await expect.poll(() => chip.evaluate((element) => element.getBoundingClientRect().height)).toBe(26.25)
  const restingBounds = await card.boundingBox()
  const history = await page.locator('[data-tabout="page-chip"][data-tabout-context="activation-history"]').filter({ hasText: 'History Charlie' }).boundingBox()
  if (!history) throw new Error('History entry has no bounds')
  await page.mouse.move(history.x + 30, history.y + 8)
  await expect(page.locator(cardFrame)).toBeVisible()
  await expect.poll(() => page.locator(cardFrame).evaluate((element) => element.getBoundingClientRect().height)).toBe(83.25)
  await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
  await expect(page.locator(cardFrame)).toHaveCSS('corner-shape', 'superellipse(2)')
  expect(await card.boundingBox()).toEqual(restingBounds)
  await page.screenshot({ path: test.info().outputPath('one-line-fixed-corners.png') })
})

test('card corners stay fixed after chip reflow and while using local frames', async ({ page }) => {
  await page.route('**/tests/fixtures/dashboard-resize.html?*', async (route) => {
    const response = await route.fetch()
    const body = (await response.text()).replaceAll("title: 'History Charlie'", "title: 'History Charlie — tools for finding files and organizing saved pages'")
    await route.fulfill({ response, body })
  })
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const card = page.locator('[data-tabout-domain="bravo.test"]')
  const chip = card.locator('.page-chip')
  await expect.poll(() => chip.evaluate((element) => element.getBoundingClientRect().height)).toBe(42.5)
  const history = await page.locator('[data-tabout="page-chip"][data-tabout-context="activation-history"]').filter({ hasText: 'History Charlie' }).boundingBox()
  if (!history) throw new Error('History entry has no bounds')
  await page.mouse.move(history.x + 30, history.y + 8)
  await expect(page.locator(cardFrame)).toBeVisible()
  await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').borderRadius)).toBe('50px')
  await page.screenshot({ path: test.info().outputPath('wrapped-chip-card.png') })

  // Content changes must preserve the fixed radius in all four corners.
  for (const height of [58.75, 26.25, 42.5]) {
    await chip.evaluate((element, height) => { element.style.height = `${height}px` }, height)
    await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
    await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').borderRadius)).toBe('50px')
    const gaps = await chip.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const parent = element.closest('[data-tabout="domain-card"]')!.getBoundingClientRect()
      return [box.left - parent.left + 8, parent.right - box.right + 8, parent.bottom - box.bottom + 8]
    })
    expect(gaps).toEqual([16, 16, 16])
  }

  // Multiple matches use the same fixed token on local card outlines.
  const other = page.locator('[data-tabout-domain="charlie.test"] .page-chip')
  await other.evaluate((element) => element.classList.add('page-chip-hover-match'))
  await expect(page.locator(cardFrame)).toBeHidden()
  await chip.evaluate((element) => { element.style.height = '58.75px' })
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element, '::after').borderRadius)).toBe('50px')
  await other.evaluate((element) => element.classList.remove('page-chip-hover-match'))
  await expect(page.locator(cardFrame)).toBeVisible()
  await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
  await page.mouse.move(0, 0)
  await expect.poll(() => card.evaluate((element) => element.style.getPropertyValue('--radius-history-match-card'))).toBe('')
})

test('variant groups share the Page Chip curve without changing the card radius', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?filter=Plain%20Title%20Variant')
  await page.evaluate(async () => { await Reflect.get(window, '__tabOutSmokeAddPlainTitleVariantTabs')?.() })
  const chip = page.locator('.page-chip').filter({ hasText: 'Plain Title Variant' }).first()
  await expect(chip.locator('.chip-title-variant')).toHaveCount(2)
  await chip.evaluate((element) => element.classList.add('page-chip-hover-match'))
  await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
  await expect(page.locator(pageFrame)).toHaveCSS('border-radius', '23px')
  await expect(chip).toHaveCSS('border-radius', '23px')
  await page.setViewportSize({ width: 760, height: 900 })
  await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
  const spacing = await chip.locator('.chip-title-variant').last().evaluate((row) => {
    const parent = row.closest('.page-chip')!.getBoundingClientRect()
    const child = row.getBoundingClientRect()
    return [parent.right - child.right, parent.bottom - child.bottom]
  })
  expect(spacing).toEqual([2.5, 2.5])
  // Coincident outlines must also refresh when only a corner token changes.
  await chip.evaluate((element) => element.style.setProperty('--radius-page-chip', '24px'))
  await expect(page.locator(cardFrame)).toHaveCSS('border-radius', '50px')
  await expect(page.locator(pageFrame)).toHaveCSS('border-radius', '24px')
})
