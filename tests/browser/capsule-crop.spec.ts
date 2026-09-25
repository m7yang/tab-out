import { readdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { createCapsuleGeometry } from '@fleet/continuous-capsule'

async function maximumPixelDifference(page: Page, actual: Buffer, reference: Buffer) {
  return await page.evaluate(async (shots) => {
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
}

for (const deviceScaleFactor of [1, 2, 3]) {
  test.describe(`at ${deviceScaleFactor}x display scale`, () => {
    test.use({ deviceScaleFactor })

    test('the history overflow outline paints the full offset contour at fractional positions', async ({ page }) => {
      await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion&historyFrameOverflow')
      await page.locator('[data-tabout-context="activation-history"][data-tabout="page-chip"]').filter({ hasText: 'History Bravo' }).hover()
      const frame = page.locator('[data-tabout-part="history-page-match-frame"]')
      await expect(frame).toBeVisible()
      await frame.evaluate((element) => {
        element.style.setProperty('--accent-amber', 'black')
        const backdrop = document.createElement('div')
        backdrop.style.cssText = `position:absolute;top:-3px;left:-3px;width:calc(${element.style.width} + 6px);height:calc(${element.style.height} + 6px);transform:${element.style.transform};background:white;z-index:2;pointer-events:none`
        element.before(backdrop)
      })
      const transform = await frame.evaluate((element) => element.style.transform)
      for (const fraction of [0, 0.25, 0.5, 0.75]) {
        await frame.evaluate((element, { transform, fraction }) => {
          element.style.transform = `${transform} translate(${fraction}px, ${fraction}px)`
        }, { transform, fraction })
        const rect = (await frame.boundingBox())!
        const geometry = createCapsuleGeometry({ ...rect, borderWidth: 0, focusGap: 1, focusWidth: 1 })!
        const clip = { x: Math.floor(rect.x) - 3, y: Math.floor(rect.y) - 3, width: Math.ceil(rect.width) + 6, height: Math.ceil(rect.height) + 6 }
        const actual = await page.screenshot({ clip, path: test.info().outputPath(`outline-${fraction}.png`) })
        await frame.evaluate((element, { rect, path }) => {
          element.setAttribute('hidden', '')
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.id = 'capsule-outline-reference'
          svg.style.cssText = `position:absolute;left:0;top:0;transform:${element.style.transform};width:${rect.width}px;height:${rect.height}px;overflow:visible;z-index:3;pointer-events:none`
          const outline = document.createElementNS(svg.namespaceURI, 'path')
          outline.setAttribute('d', path)
          outline.setAttribute('fill', 'none')
          outline.setAttribute('stroke', 'black')
          outline.setAttribute('stroke-width', '1')
          svg.append(outline)
          element.after(svg)
        }, { rect, path: geometry.focusPath })
        const reference = await page.screenshot({ clip, path: test.info().outputPath(`reference-outline-${fraction}.png`) })
        // Compare the rendered stroke, not just its path coordinates. A native
        // border-shape outline passes geometry checks but changes tip pixels.
        expect(await maximumPixelDifference(page, actual, reference)).toBeLessThanOrEqual(12)
        await page.locator('#capsule-outline-reference').evaluate((element) => element.remove())
        await frame.evaluate((element) => element.removeAttribute('hidden'))
      }
    })

    for (const selector of ['.open-tabs-badge', '.pathgroup-header .chip-pathgroup', '.page-chip-expanded .chip-strip-indicator', '.title-suppression-token', '.page-chip-expanded .chip-title-suppression-marker', '[data-tabout-part="overflow-expander"]', '[data-tabout="toast"] [data-tabout-part="action-button"]']) {
      test(`${selector} retains its native shoulders at fractional pixel positions`, async ({ page }) => {
        await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')
        if (selector.includes('page-chip-expanded')) {
          const chip = page.locator('[data-tabout="page-chip"][data-tabout-context="domain-card"]').filter({ hasText: 'Tooltip Boundary Alpha' }).first()
          await chip.hover({ position: { x: 36, y: 8 } })
          await expect(chip).toHaveAttribute('data-expanded', 'true')
        }
        if (selector.includes('toast')) {
          const chunk = readdirSync(new URL('../../extension/dist/assets/', import.meta.url)).find((name) => name.startsWith('mountToast-') && name.endsWith('.js'))
          if (!chunk) throw new Error('Built toast module is missing')
          await page.evaluate(async (url) => {
            const { showMountedToast } = await import(url)
            await showMountedToast('Example notice', { label: 'Undo', onClick() {} }, { timeout: 0 })
          }, `/extension/dist/assets/${chunk}`)
          await expect(page.locator('[data-tabout="toast"]')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
        }
        const capsule = page.locator(selector).first()
        await expect(capsule).toBeVisible()
        await capsule.evaluate((element, selector) => {
          if (selector === '.open-tabs-badge') element.textContent = '3 closed'
          element.style.setProperty('--capsule-fill', 'black')
          element.style.setProperty('--capsule-border-color', 'black')
          element.style.setProperty('--capsule-shadow', 'none')
          // Keep the real layout/ancestry; relative offsets exercise fractional
          // placement without removing the capsule's slot from the document flow.
          Object.assign(element.style, { position: 'relative', color: 'transparent' })
        }, selector)
        await expect.poll(() => capsule.evaluate((element) => element.style.getPropertyValue('border-shape'))).toContain('path(')

        await expect.poll(() => capsule.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)).toBe(0)
        const initialRect = await capsule.boundingBox()
        if (!initialRect) throw new Error('Capsule has no bounds')
        for (const top of [0, 0.25, 0.5, 0.75]) {
          await capsule.evaluate((element, y) => element.style.top = `${y}px`, top)
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          const rect = await capsule.boundingBox()
          if (!rect) throw new Error('Capsule has no bounds')
          expect(rect.width).toBe(initialRect.width)
          expect(rect.height).toBe(initialRect.height)
          const borderWidth = await capsule.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth))
          const geometry = createCapsuleGeometry({ ...rect, borderWidth })
          if (!geometry) throw new Error('Capsule has no native contour')
          const clip = { x: Math.floor(rect.x) - 2, y: Math.floor(rect.y) - 2, width: Math.ceil(rect.width) + 4, height: Math.ceil(rect.height) + 4 }
          const actual = await page.screenshot({ clip, animations: 'disabled', path: test.info().outputPath(`actual-${top}.png`) })
          await capsule.evaluate((element) => element.style.visibility = 'hidden')
          await page.evaluate(({ rect, path, borderWidth, inset }) => {
            // Keep the SVG viewport at the page origin. Positioning its viewport at a
            // fractional offset introduces a separate SVG pixel-snapping discrepancy.
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            svg.id = 'native-capsule-reference'
            svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;pointer-events:none'
            const surface = document.createElementNS(svg.namespaceURI, 'path')
            surface.setAttribute('d', path)
            surface.setAttribute('transform', `translate(${rect.x + inset} ${rect.y + inset})`)
            surface.setAttribute('stroke', 'black')
            surface.setAttribute('stroke-width', String(borderWidth))
            svg.append(surface)
            document.documentElement.append(svg)
          }, { rect, path: geometry.surfacePath, borderWidth, inset: geometry.inset })
          const reference = await page.screenshot({ clip, animations: 'disabled', path: test.info().outputPath(`reference-${top}.png`) })
          const difference = await maximumPixelDifference(page, actual, reference)
          // Different rasterizers can differ slightly in antialiasing; the cropped
          // background loses entire black pixels (difference 255 at a half pixel).
          if (difference > 12) {
            await test.info().attach('actual', { body: actual, contentType: 'image/png' })
            await test.info().attach('reference', { body: reference, contentType: 'image/png' })
          }
          expect(difference, `contour at y=${top}`).toBeLessThanOrEqual(12)
          await page.locator('#native-capsule-reference').evaluate((element) => element.remove())
          await capsule.evaluate((element) => element.style.visibility = '')
        }
      })
    }
  })
}

test('overflow capsule owns its paint through fallback, resize, and React removal', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')
  const expander = page.locator('[data-tabout-part="overflow-expander"]').first()
  await expect(expander).toHaveAttribute('data-capsule-ready', '')
  await expect(expander.locator(':scope > .capsule-fill')).toHaveCount(1)
  await expect(expander.locator(':scope > .capsule-fill')).toHaveAttribute('aria-hidden', 'true')
  const attached = await expander.elementHandle()
  if (!attached) throw new Error('Overflow expander is missing')

  await expander.evaluate((element) => {
    Object.assign(element.style, { width: '24px', height: '24px', minWidth: '0' })
  })
  await expect(expander).not.toHaveAttribute('data-capsule-ready')
  await expect(expander.locator(':scope > .capsule-fill')).toBeHidden()
  await expect(expander).toHaveCSS('border-shape', 'none')

  await expander.evaluate((element) => { element.style.width = '240px' })
  await expect(expander).toHaveAttribute('data-capsule-ready', '')
  await expect(expander.locator(':scope > .capsule-fill')).toHaveCount(1)
  await expect(expander.locator(':scope > .capsule-fill')).toBeVisible()
  await expander.click()
  await expect.poll(() => attached.evaluate((element) => element.isConnected)).toBe(false)
  expect(await attached.evaluate((element) => ({
    paint: element.getAttribute('data-capsule-paint'),
    ready: element.getAttribute('data-capsule-ready'),
    shape: element.style.getPropertyValue('border-shape'),
    fillShape: element.style.getPropertyValue('--capsule-fill-shape'),
    borderWidth: element.style.getPropertyValue('--capsule-border-width'),
    paintChildren: element.querySelectorAll('.capsule-fill').length,
  }))).toEqual({ paint: null, ready: null, shape: '', fillShape: '', borderWidth: '', paintChildren: 0 })
  await attached.dispose()
})

test('capsule paint preserves token hover, focus, marker tones, and overflow decoration', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')
  const token = page.locator('.title-suppression-token').first()
  await expect(token).toHaveAttribute('data-capsule-ready', '')

  const checkPaint = async (control: import('@playwright/test').Locator) => {
    await expect(control).toHaveAttribute('data-capsule-ready', '')
    const paints = await control.evaluate((element) => {
      const transition = element.style.transition
      element.style.transition = 'none'
      const read = (style: CSSStyleDeclaration) => ({
        background: style.backgroundColor,
        border: style.borderTopWidth === '0px' ? null : style.borderTopColor,
        borderWidth: style.borderTopWidth,
        shadow: style.boxShadow === 'none' ? [] : style.boxShadow.split(/, (?![^()]*\))/u).filter((shadow) => !shadow.startsWith('rgba(0, 0, 0, 0)')),
      })
      const outline = (style: CSSStyleDeclaration) => [style.outlineColor, style.outlineStyle, style.outlineWidth, style.outlineOffset]
      const fill = element.querySelector('.capsule-fill')
      const actual = read(fill ? getComputedStyle(fill) : getComputedStyle(element, '::before'))
      const actualOutline = outline(getComputedStyle(element))
      const rect = element.getBoundingClientRect()
      delete element.dataset.capsuleReady
      const expected = read(getComputedStyle(element))
      const expectedOutline = outline(getComputedStyle(element))
      const fallbackRect = element.getBoundingClientRect()
      element.dataset.capsuleReady = ''
      element.style.transition = transition
      return { actual, expected, actualOutline, expectedOutline, size: [rect.width, rect.height], fallbackSize: [fallbackRect.width, fallbackRect.height] }
    })
    expect(paints.actual).toEqual(paints.expected)
    expect(paints.actualOutline).toEqual(paints.expectedOutline)
    expect(paints.size).toEqual(paints.fallbackSize)
  }

  await checkPaint(token)
  await token.hover()
  await checkPaint(token)
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await token.focus()
  await expect(token).toBeFocused()
  expect(await token.evaluate((element) => element.matches(':focus-visible'))).toBe(true)
  await checkPaint(token)

  const chip = page.locator('[data-tabout="page-chip"][data-tabout-context="domain-card"]').filter({ hasText: 'Tooltip Boundary Alpha' }).first()
  await chip.hover({ position: { x: 36, y: 8 } })
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  const marker = chip.locator('.chip-title-suppression-marker').first()
  await expect(marker).toHaveAttribute('data-capsule-ready', '')
  await checkPaint(marker)

  const expander = page.locator('[data-tabout-part="overflow-expander"]').first()
  await expander.hover()
  await checkPaint(expander)
  await expect(expander).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(await expander.evaluate((element) => getComputedStyle(element, '::before').width)).toBe('2px')
})
