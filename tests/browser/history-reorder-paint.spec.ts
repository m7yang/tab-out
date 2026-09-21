import { expect, test } from '@playwright/test'

test.use({ deviceScaleFactor: 2 })

test('Activation History keeps its painted horizontal edge when a zoomed reorder settles', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyReorderMotion=1')
  const row = page.locator('[data-tabout-layout-key="stack:1:9101"]')
  const chip = row.locator('[data-tabout="page-chip"]')
  await expect(chip).toBeVisible()
  await page.evaluate(() => {
    // Fractional layout makes a compositor-layer rasterization change visible.
    document.documentElement.style.zoom = '0.8'
    document.dispatchEvent(new Event('visibilitychange'))
  })

  const clockStart = Date.now()
  await page.clock.install({ time: clockStart })
  await page.clock.pauseAt(clockStart + 1000)
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const movingRows = document.querySelectorAll('.history-entry-layout-moving-active')
      if (movingRows.length === 0) return
      for (const movingRow of movingRows) {
        for (const animation of movingRow.getAnimations()) {
          const duration = animation.effect?.getTiming().duration
          if (typeof duration !== 'number') throw new Error('History move duration is unavailable')
          // Sample just before completion without firing transitionend. The
          // frozen clock also holds the animator's fallback cleanup timer.
          animation.pause()
          animation.currentTime = duration - 0.001
        }
      }
      observer.disconnect()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true })
    const prepare = Reflect.get(window, '__tabOutSmokePrepareHistoryReorder')
    const refresh = Reflect.get(window, '__tabOutSmokeDispatchPassiveHistoryRefresh')
    if (typeof prepare !== 'function' || typeof refresh !== 'function') throw new Error('History fixture controls are unavailable')
    prepare()
    refresh()
  })
  await expect.poll(async () => {
    await page.clock.runFor(16)
    return row.evaluate((element) => element.classList.contains('history-entry-layout-moving-active'))
  }, { intervals: [16] }).toBe(true)

  const movingRect = await chip.boundingBox()
  if (!movingRect) throw new Error('Moving history chip is unavailable')
  const clip = {
    x: Math.floor(movingRect.x + movingRect.width - 4),
    y: Math.floor(movingRect.y + movingRect.height / 2),
    width: 8,
    height: 1,
  }
  const movingScreenshot = await page.screenshot({ clip })
  await page.clock.runFor(300)
  await expect(row).not.toHaveClass(/history-entry-layout-moving/)
  const settledRect = await chip.boundingBox()
  expect(settledRect?.x).toBe(movingRect.x)
  expect(settledRect?.width).toBe(movingRect.width)
  const settledScreenshot = await page.screenshot({ clip })

  const edges = await page.evaluate(async (screenshots) => Promise.all(screenshots.map(async (encoded) => {
    const response = await fetch(`data:image/png;base64,${encoded}`)
    const bitmap = await createImageBitmap(await response.blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Screenshot canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const { data } = context.getImageData(0, 0, canvas.width, 1)
    let rightEdge = -1
    for (let x = 0; x < canvas.width; x += 1) {
      const red = data[x * 4]
      if (red !== undefined && red < 200) rightEdge = x
    }
    return rightEdge
  })), [movingScreenshot.toBase64(), settledScreenshot.toBase64()])
  expect(edges[0], 'The current chip border must be visible in the sampled strip').toBeGreaterThanOrEqual(0)
  expect(edges[0], 'The painted edge must not jump horizontally at animation cleanup').toBe(edges[1])
})
