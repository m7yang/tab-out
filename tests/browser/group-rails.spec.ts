import { expect, test } from '@playwright/test'

test('mixed same-title chips break rails while unanimous same-title chips join', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?groupRails&mixedGroupRails')
  const slots = page.locator('[data-tabout-domain="example.test"] .chip-slot')
  await expect(slots).toHaveCount(5)
  await expect(slots.nth(1).locator('.chip-title-variant')).toHaveCount(2)
  await expect(slots.nth(3).locator('.chip-title-variant')).toHaveCount(2)
  const ends = await slots.evaluateAll((elements) => elements.map((slot) => {
    const rail = slot.querySelector('[data-tabout-part="group-rail"]')!
    const style = getComputedStyle(rail)
    return [style.top, style.bottom]
  }))
  expect(ends).toEqual([
    ['7px', '7px'],
    ['7px', '7px'],
    ['7px', '0px'],
    ['0px', '0px'],
    ['0px', '7px'],
  ])
})

test('Chrome group rails join adjacent chips and stop at group, visibility, and filter boundaries', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?groupRails')
  const card = page.locator('[data-tabout-domain="example.test"]')
  const slots = card.locator('.chip-slot')
  const rails = card.locator('[data-tabout-part="group-rail"]')
  await expect(slots).toHaveCount(5)
  await expect(rails).toHaveCount(4)

  async function geometry() {
    return slots.evaluateAll((elements) => elements.map((slot) => {
      const chip = slot.querySelector('.page-chip')!.getBoundingClientRect()
      const rail = slot.querySelector<HTMLElement>('[data-tabout-part="group-rail"]')
      if (!rail) return null
      const box = rail.getBoundingClientRect()
      const bounds = slot.getBoundingClientRect()
      return {
        x: box.x,
        y: box.y,
        bottom: box.bottom,
        width: box.width,
        gap: chip.left - box.right,
        topInset: Math.round((box.top - bounds.top) * 100) / 100,
        bottomInset: Math.round((bounds.bottom - box.bottom) * 100) / 100,
        color: getComputedStyle(rail).backgroundColor,
      }
    }))
  }

  let rows = await geometry()
  expect(rows[0]).toMatchObject({ width: 2, gap: 4, topInset: 7, bottomInset: 0 })
  expect(rows[1]).toMatchObject({ topInset: 0, bottomInset: 7 })
  expect(rows[0]!.bottom).toBeGreaterThanOrEqual(rows[1]!.y)
  expect(rows[2]).toBeNull()
  expect(rows[3]).toMatchObject({ topInset: 7, bottomInset: 0 })
  expect(rows[4]).toMatchObject({ topInset: 0, bottomInset: 7 })

  await card.locator('[data-tabout-part="overflow-expander"]').click()
  await expect(slots).toHaveCount(8)
  await expect(card.locator('[data-tabout-part="overflow-expander"]')).toHaveCount(0)
  await expect(rails).toHaveCount(7)
  await expect(slots.nth(5)).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  rows = await geometry()
  expect(rows[4]).toMatchObject({ topInset: 0, bottomInset: 0 })
  expect(rows[5]).toMatchObject({ topInset: 0, bottomInset: 7 })
  expect(rows[4]!.bottom).toBeGreaterThanOrEqual(rows[5]!.y)
  expect(rows[6]).toMatchObject({ topInset: 7, bottomInset: 7, color: rows[5]!.color })
  expect(rows[7]).toMatchObject({ topInset: 7, bottomInset: 7, color: rows[0]!.color })
  expect(rows.filter(Boolean).every((row) => row!.gap === 4 && row!.x === rows[0]!.x)).toBe(true)
  await page.mouse.move(0, 0)
  await card.screenshot({ path: test.info().outputPath('shared-group-rails.png') })

  await page.setViewportSize({ width: 760, height: 900 })
  await expect.poll(async () => (await geometry())[4]!.bottom - (await geometry())[5]!.y).toBeGreaterThanOrEqual(0)
  await page.locator('.tab-filter').fill('F Notes')
  await expect(slots).toHaveCount(1)
  await expect(rails).toHaveCount(1)
  expect((await geometry())[0]).toMatchObject({ width: 2, gap: 4, topInset: 7, bottomInset: 7 })
})
