import { expect, test } from '@playwright/test'

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`chip seam hover at ${deviceScaleFactor}x`, () => {
    test.use({ deviceScaleFactor })

    for (const context of ['domain-card', 'activation-history']) {
      test(`${context} keeps expansion active across fractional seams and corners`, async ({ page }) => {
        await page.goto('/tests/fixtures/dashboard-resize.html')
        const chips = page.locator(`[data-tabout="page-chip"][data-tabout-context="${context}"]`)
        await expect(page.locator(
          `[data-tabout="page-chip"][data-tabout-context="${context}"][data-title-collapsed]`,
        ).first()).toBeAttached()
        const seam = await chips.evaluateAll((elements) => {
          for (let index = 1; index < elements.length; index++) {
            const upper = elements[index - 1]
            const lower = elements[index]
            if (!upper || !lower || !upper.hasAttribute('data-title-collapsed') || !lower.hasAttribute('data-title-collapsed')) continue
            const a = upper.getBoundingClientRect()
            const b = lower.getBoundingClientRect()
            if (a.top < 20 || b.bottom > innerHeight - 20 || a.left !== b.left || Math.abs(b.top - a.bottom + 1) > 0.01) continue
            if (b.top === Math.floor(b.top)) continue
            return { upper: index - 1, lower: index, left: b.left, right: b.right, top: b.top }
          }
          return null
        })
        expect(seam).not.toBeNull()
        if (!seam) return
        const upper = chips.nth(seam.upper)
        const lower = chips.nth(seam.lower)
        const expanded = page.locator(`[data-tabout="page-chip"][data-tabout-context="${context}"][data-expanded="true"]`)
        const centerX = (seam.left + seam.right) / 2

        // Each fresh approach must reach a chip, including the square hit area
        // outside its painted corners and Chrome's fractional top-edge hit.
        for (const x of [centerX, seam.left + 1, seam.right - 1]) {
          for (const y of [Math.floor(seam.top), seam.top + 0.25]) {
            await page.mouse.move(1, 1)
            await expect(expanded).toHaveCount(0)
            await page.mouse.move(x, y)
            await page.mouse.move(x + 0.1, y)
            await expect(expanded).toHaveCount(1)
            await expect(lower).toHaveAttribute('data-expanded', 'true')
          }
        }

        // Scan both ways without leaving the column. Stay inside the current
        // expanded surface, then cross its actual boundary onto its neighbor.
        await page.mouse.move(1, 1)
        await page.mouse.move(centerX, seam.top - 2)
        await expect(upper).toHaveAttribute('data-expanded', 'true')
        // History's canonical chip keeps its resting bounds during expansion.
        const upperSurface = context === 'activation-history'
          ? upper.locator('..').locator('[data-tabout-part="expanded-surface"]')
          : upper
        const expandedBox = await upperSurface.boundingBox()
        expect(expandedBox).not.toBeNull()
        if (!expandedBox) return
        await page.mouse.move(centerX, expandedBox.y + expandedBox.height + 1)
        await expect(upper).not.toHaveAttribute('data-expanded', 'true')
        await page.mouse.move(centerX, seam.top + 2)
        await expect(lower).toHaveAttribute('data-expanded', 'true')
        await page.mouse.move(centerX, Math.floor(seam.top))
        await expect(lower).toHaveAttribute('data-expanded', 'true')

        await page.mouse.move(seam.left - 2, seam.top + 2)
        await expect(expanded).toHaveCount(0)
      })
    }
  })
}
