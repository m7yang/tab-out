import { expect, test } from '@playwright/test'

test.use({ deviceScaleFactor: 2 })

test('Activation History paints the current row above crossing titles and index markers', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyReorderMotion=1')
  const row = page.locator('[data-tabout-layout-key="stack:1:9101"]')
  await expect(row).toBeVisible()
  const clockStart = Date.now()
  await page.clock.install({ time: clockStart })
  await page.clock.pauseAt(clockStart + 1000)
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const movingRows = document.querySelectorAll('.history-entry-layout-moving-active')
      // Each row starts in a separate animation-frame callback. Wait for the
      // complete three-row fixture before pausing so none keeps moving behind it.
      if (movingRows.length !== 3) return
      for (const movingRow of movingRows) {
        for (const animation of movingRow.getAnimations()) {
          animation.pause()
          animation.currentTime = 25
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

  for (const time of [25, 48]) {
    await page.evaluate(async (currentTime) => {
      for (const movingRow of document.querySelectorAll<HTMLElement>('.history-entry-layout-moving-active')) {
        movingRow.style.visibility = ''
        for (const animation of movingRow.getAnimations()) {
          await animation.ready
          animation.currentTime = currentTime
        }
      }
    }, time)
    const rect = await row.boundingBox()
    if (!rect) throw new Error('Moving history row is unavailable')
    const clip = { x: rect.x, y: Math.ceil(rect.y + 3), width: rect.width, height: Math.floor(rect.height - 6) }
    const crossingRow = page.locator(`[data-tabout-layout-key="stack:1:${time === 25 ? 9102 : 9103}"]`)
    const crossingRect = await crossingRow.boundingBox()
    if (!crossingRect) throw new Error('Crossing history row is unavailable')
    expect(Math.abs(crossingRect.y - rect.y), 'The sampled rows must cross through each other').toBeLessThan(4)
    const overlap = await page.screenshot({ clip })
    await page.evaluate(() => {
      for (const otherRow of document.querySelectorAll<HTMLElement>('[data-tabout="activation-history-row"]')) {
        if (otherRow.dataset.taboutLayoutKey !== 'stack:1:9101') otherRow.style.visibility = 'hidden'
      }
    })
    const isolated = await page.screenshot({ clip })
    expect(overlap.equals(isolated), 'Crossing text and markers must not paint through the current row').toBe(true)
  }
})

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
  // The empty marker-to-chip gap exposes any temporary row background.
  const gapClip = { x: Math.floor(movingRect.x - 6), y: Math.ceil(movingRect.y + 6), width: 3, height: 3 }
  const movingBackground = await page.screenshot({ clip: gapClip })
  await page.clock.runFor(300)
  await expect(row).not.toHaveClass(/(^|\s)history-entry-layout-moving(\s|$)/)
  const settledRect = await chip.boundingBox()
  expect(settledRect?.x).toBe(movingRect.x)
  expect(settledRect?.width).toBe(movingRect.width)
  const settledScreenshot = await page.screenshot({ clip })
  const settledBackground = await page.screenshot({ clip: gapClip })
  expect(movingBackground.equals(settledBackground), 'The row background must not flash when the animation settles').toBe(true)

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
