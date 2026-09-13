import { expect, test } from '@playwright/test'

for (const width of [1420, 760]) {
  test(`history cues follow both physical ends independently at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 360 })
    await page.goto('/tests/fixtures/dashboard-resize.html')
    const list = page.locator('.history-entry-list')
    const top = page.locator('[data-tabout-part="history-scroll-top-blur"]')
    const bottom = page.locator('[data-tabout-part="history-scroll-bottom-blur"]')
    const dashboard = page.locator('[data-tabout-part="scroll-region"]')
    const input = page.locator('[data-tabout="filter-query"] input')
    await expect(top).toHaveCSS('opacity', '0')
    await expect(bottom).toHaveCSS('opacity', '1')

    const geometry = await list.evaluate((element) => {
      const panel = element.closest<HTMLElement>('.tab-history-panel')!
      const top = panel.querySelector<HTMLElement>('[data-tabout-part="history-scroll-top-blur"]')!
      const bottom = panel.querySelector<HTMLElement>('[data-tabout-part="history-scroll-bottom-blur"]')!
      const track = panel.querySelector<HTMLElement>('.history-entry-scrollbar-track')!
      return {
        topGap: top.getBoundingClientRect().top - element.getBoundingClientRect().top,
        bottomGap: element.getBoundingClientRect().bottom - bottom.getBoundingClientRect().bottom,
        rightGap: track.getBoundingClientRect().left - bottom.getBoundingClientRect().right,
        withinPanel: bottom.getBoundingClientRect().right <= panel.getBoundingClientRect().right,
        heights: [top.getBoundingClientRect().height, bottom.getBoundingClientRect().height],
        pointerEvents: [getComputedStyle(top).pointerEvents, getComputedStyle(bottom).pointerEvents],
      }
    })
    expect(geometry.topGap).toBeCloseTo(0)
    expect(geometry.bottomGap).toBeCloseTo(0)
    expect(geometry.rightGap).toBeGreaterThanOrEqual(0)
    expect(geometry.withinPanel).toBe(true)
    expect(geometry.heights).toEqual([56, 56])
    expect(geometry.pointerEvents).toEqual(['none', 'none'])

    await list.evaluate((element) => { element.scrollTop = 100 })
    await expect(top).toHaveCSS('opacity', '1')
    await expect(bottom).toHaveCSS('opacity', '1')
    const historyScrollTop = await list.evaluate((element) => element.scrollTop)
    await dashboard.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(page.locator('[data-tabout-part="scroll-bottom-blur"]')).toHaveCSS('opacity', '0')
    expect(await list.evaluate((element) => element.scrollTop)).toBe(historyScrollTop)
    await expect(top).toHaveCSS('opacity', '1')
    await expect(bottom).toHaveCSS('opacity', '1')

    // The existing trailing padding is part of the scroll range.
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 5 })
    await expect(bottom).toHaveCSS('opacity', '1')
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(top).toHaveCSS('opacity', '1')
    await expect(bottom).toHaveCSS('opacity', '0')

    await input.fill('no-history-row-matches-this')
    await expect(top).toHaveCSS('opacity', '0')
    await expect(bottom).toHaveCSS('opacity', '0')
    await input.fill('')
    await expect(top).toHaveCSS('opacity', '0')
    await expect(bottom).toHaveCSS('opacity', '1')

    // A tall desktop viewport fits every row; the narrow layout has its own
    // capped height, so switch back to each original layout afterward.
    await page.setViewportSize({ width: 1420, height: 1200 })
    await expect(top).toHaveCSS('opacity', '0')
    await expect(bottom).toHaveCSS('opacity', '0')
    await page.setViewportSize({ width, height: 360 })
    await expect(bottom).toHaveCSS('opacity', '1')

    const track = page.locator('.history-entry-scrollbar-track')
    const bounds = await track.boundingBox()
    if (!bounds) throw new Error('The scrollbar track must have visible geometry')
    // Click through the bottom band at the independent scrollbar rail.
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height - 1)
    await expect(top).toHaveCSS('opacity', '1')
    await expect(bottom).toHaveCSS('opacity', '0')
    await list.evaluate((element) => { element.scrollTop = 0 })
    await expect(top).toHaveCSS('opacity', '0')
    await expect(bottom).toHaveCSS('opacity', '1')
  })
}

for (const edge of ['top', 'bottom'] as const) {
  test(`expanded history titles paint above the ${edge} cue`, async ({ page }) => {
    await page.setViewportSize({ width: 1420, height: 360 })
    await page.goto('/tests/fixtures/dashboard-resize.html')
    const row = page.locator('[data-tabout="activation-history-entry"]').filter({ hasText: 'Tooltip Edge Alpha Story' })
    await expect(row).toHaveCount(1)
    await row.evaluate((element, edge) => {
      const scroller = element.closest<HTMLElement>('.history-entry-list')!
      const rect = element.getBoundingClientRect()
      const viewport = scroller.getBoundingClientRect()
      scroller.scrollTop += edge === 'top' ? rect.top - viewport.top - 5 : rect.bottom - viewport.bottom + 5
    }, edge)
    const blur = page.locator(`[data-tabout-part="history-scroll-${edge}-blur"]`)
    await expect(blur).toHaveCSS('opacity', '1')
    const bounds = await row.boundingBox()
    if (!bounds) throw new Error('The history row must have visible geometry')
    await page.mouse.move(bounds.x + 100, bounds.y + 15)
    const expanded = row.locator('.history-entry-expanded')
    await expect(expanded).toBeVisible()
    const layering = await expanded.evaluate((element, edge) => {
      const blur = document.querySelector<HTMLElement>(`[data-tabout-part="history-scroll-${edge}-blur"]`)!
      const rect = element.getBoundingClientRect()
      const blurRect = blur.getBoundingClientRect()
      const overlapTop = Math.max(rect.top, blurRect.top)
      const overlapBottom = Math.min(rect.bottom, blurRect.bottom)
      const previousPointerEvents = element.style.pointerEvents
      element.style.pointerEvents = 'auto'
      blur.style.pointerEvents = 'auto'
      const stack = document.elementsFromPoint(rect.left + 30, (overlapTop + overlapBottom) / 2)
      element.style.pointerEvents = previousPointerEvents
      blur.style.pointerEvents = ''
      return {
        overlap: overlapBottom - overlapTop,
        titleIndex: stack.indexOf(element),
        blurIndex: stack.indexOf(blur),
      }
    }, edge)
    expect(layering.overlap).toBeGreaterThan(0)
    expect(layering.titleIndex).toBeGreaterThanOrEqual(0)
    expect(layering.blurIndex).toBeGreaterThan(layering.titleIndex)
  })
}
