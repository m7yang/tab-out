import { expect, test } from '@playwright/test'

test('focus animation keeps the painted outline sharp and the shadow grows without a pulse', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await page.locator('.header-filter-shadow').waitFor({ state: 'attached' })
  const input = page.getByRole('searchbox', { name: 'Filter dashboard' })
  await input.evaluate(async (element) => {
    element.blur()
    await new Promise((resolve) => setTimeout(resolve, 200))
    void getComputedStyle(element.parentElement!.querySelector('.header-filter-focus')!).stroke
    element.focus()
    for (const animation of element.parentElement!.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = 0
    }
  })

  const paints: Array<{ sharpness: number, shadowStrength: number }> = []
  for (const time of [75, 125, 200]) {
    await input.evaluate((element, currentTime) => {
      for (const animation of element.parentElement!.getAnimations({ subtree: true })) {
        animation.currentTime = currentTime
      }
    }, time)
    const screenshot = await page.screenshot()
    paints.push(await input.evaluate(async (element, base64) => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const rect = element.getBoundingClientRect()
      function darkness(y: number) {
        const pixels = context.getImageData(Math.round(rect.x + 50), Math.round(y), 100, 1).data
        let total = 0
        for (let index = 0; index < pixels.length; index += 4) total += 255 - pixels[index]!
        return total / 100
      }
      const center = darkness(rect.top)
      return {
        // A filtered outline spread across three pixels during animation even
        // though its computed stroke width remained 1px throughout.
        sharpness: center / (darkness(rect.top - 1) + center + darkness(rect.top + 1)),
        shadowStrength: darkness(rect.bottom + 4),
      }
    }, screenshot.toString('base64')))
  }
  for (const paint of paints) expect(paint.sharpness).toBeGreaterThan(0.8)
  for (let index = 1; index < paints.length; index += 1) {
    expect(paints[index]!.shadowStrength).toBeGreaterThanOrEqual(paints[index - 1]!.shadowStrength - 1)
  }
})
