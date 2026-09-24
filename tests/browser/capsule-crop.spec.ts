import { expect, test } from '@playwright/test'
import { createCapsuleGeometry } from '@fleet/continuous-capsule'

for (const deviceScaleFactor of [1, 2, 3]) {
  test.describe(`at ${deviceScaleFactor}x display scale`, () => {
    test.use({ deviceScaleFactor })

    test('count badge retains its native shoulders at fractional pixel positions', async ({ page }) => {
      await page.goto('/tests/fixtures/dashboard-resize.html')
      const badge = page.locator('.open-tabs-badge').first()
      await expect(badge).toBeVisible()
      await badge.evaluate((element) => {
        element.textContent = '3 closed'
        element.style.setProperty('--tab-count-fill', 'black')
        // Keep the real layout/ancestry; relative offsets exercise fractional
        // placement without removing the badge's slot from the header flow.
        Object.assign(element.style, { position: 'relative', color: 'transparent' })
      })
      await expect.poll(() => badge.evaluate((element) => element.style.getPropertyValue('border-shape'))).toContain('path(')

      for (const top of [0, 0.25, 0.5, 0.75]) {
        await badge.evaluate((element, y) => element.style.top = `${y}px`, top)
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const rect = await badge.boundingBox()
        if (!rect) throw new Error('Badge has no bounds')
        expect(rect.width).toBeCloseTo(60.703125, 4)
        expect(rect.height).toBe(22)
        const geometry = createCapsuleGeometry({ ...rect, borderWidth: 0 })
        if (!geometry) throw new Error('Badge has no native contour')
        const clip = { x: Math.floor(rect.x) - 2, y: Math.floor(rect.y) - 2, width: Math.ceil(rect.width) + 4, height: Math.ceil(rect.height) + 4 }
        const actual = await page.screenshot({ clip, animations: 'disabled', path: test.info().outputPath(`actual-${top}.png`) })
        await badge.evaluate((element) => element.style.visibility = 'hidden')
        await page.evaluate(({ rect, path }) => {
          // Keep the SVG viewport at the page origin. Positioning its viewport at a
          // fractional offset introduces a separate SVG pixel-snapping discrepancy.
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.id = 'native-capsule-reference'
          svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;pointer-events:none'
          const surface = document.createElementNS(svg.namespaceURI, 'path')
          surface.setAttribute('d', path)
          surface.setAttribute('transform', `translate(${rect.x} ${rect.y})`)
          svg.append(surface)
          document.documentElement.append(svg)
        }, { rect, path: geometry.surfacePath })
        const reference = await page.screenshot({ clip, animations: 'disabled', path: test.info().outputPath(`reference-${top}.png`) })
        const difference = await page.evaluate(async (shots) => {
          const pixels = await Promise.all(shots.map(async (shot) => {
            const image = new Image()
            image.src = `data:image/png;base64,${shot}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const context = canvas.getContext('2d')!
            context.drawImage(image, 0, 0)
            return context.getImageData(0, 0, canvas.width, canvas.height).data
          }))
          let maximum = 0
          for (let i = 0; i < pixels[0]!.length; i++) {
            maximum = Math.max(maximum, Math.abs(pixels[0]![i]! - pixels[1]![i]!))
          }
          return maximum
        }, [actual.toString('base64'), reference.toString('base64')])
        // Different rasterizers can differ slightly in antialiasing; the cropped
        // background loses entire black pixels (difference 255 at a half pixel).
        if (difference > 12) {
          await test.info().attach('actual', { body: actual, contentType: 'image/png' })
          await test.info().attach('reference', { body: reference, contentType: 'image/png' })
        }
        expect(difference, `contour at y=${top}`).toBeLessThanOrEqual(12)
        await page.locator('#native-capsule-reference').evaluate((element) => element.remove())
        await badge.evaluate((element) => element.style.visibility = '')
      }
    })
  })
}
