import { expect, test } from '@playwright/test'

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
        await neighbor.hover()
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
