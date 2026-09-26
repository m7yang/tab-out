import { expect, test, type Locator, type Page } from '@playwright/test'
import { createCapsuleGeometry } from '@fleet/continuous-capsule'

const frameSelector = '[data-tabout-part="history-match-frame"]'
const pageFrameSelector = '[data-tabout-part="history-page-match-frame"]'

function historyChip(page: Page, title: string) {
  return page.locator('[data-tabout="page-chip"][data-tabout-context="activation-history"]').filter({ hasText: title })
}

async function pointAt(chip: Locator) {
  const rect = await chip.boundingBox()
  if (!rect) throw new Error('History chip is missing')
  await chip.page().mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
}

function dashboardChip(page: Page, title: string) {
  return page.locator('[data-tabout="page-chip"][data-tabout-context="domain-card"]').filter({ hasText: title })
}

async function expectAligned(frame: Locator, card: Locator, outset = 8) {
  await expect.poll(async () => {
    const actual = await frame.boundingBox()
    const target = await card.boundingBox()
    return actual && target ? Math.max(
      Math.abs(actual.x - target.x + outset),
      Math.abs(actual.y - target.y + outset),
      Math.abs(actual.width - target.width - outset * 2),
      Math.abs(actual.height - target.height - outset * 2),
    ) : Infinity
  }).toBeLessThan(1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion')
  await expect(historyChip(page, 'History Alpha')).toBeVisible()
})

test('overflow match outlines keep the capsule contour throughout resizing and interruption', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion&historyFrameOverflow')
  const frame = page.locator(pageFrameSelector)
  const expander = page.locator('[data-tabout-domain="alpha.test"] [data-tabout-part="overflow-expander"]')
  await pointAt(historyChip(page, 'History Charlie'))
  await expect(frame).toBeVisible()
  await frame.evaluate((element) => {
    new MutationObserver(() => {
      for (const animation of element.getAnimations()) {
        if (animation.playState === 'paused') continue
        animation.pause()
        animation.currentTime = 60
      }
    }).observe(element, { attributes: true, attributeFilter: ['style'] })
  })
  await pointAt(historyChip(page, 'History Bravo'))
  await expect(expander).toHaveClass(/page-chip-overflow-hover-match/)
  await expect.poll(() => frame.evaluate((element) => element.getAnimations()[0]?.playState)).toBe('paused')

  async function expectCapsule() {
    // Finishing WAAPI forces layout before ResizeObserver refreshes the path.
    // Retry the complete snapshot so both measurements describe one paint.
    await expect(async () => {
      const actual = await frame.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
          shape: element.querySelector('path')!.getAttribute('d')!, corner: style.getPropertyValue('corner-shape'),
          stroke: style.outlineWidth, offset: style.outlineOffset,
        }
      })
      const geometry = createCapsuleGeometry({ ...actual, borderWidth: 0, focusGap: 1, focusWidth: 1 })!
      const coordinates = (path: string) => path.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi)!.map(Number)
      const expected = coordinates(geometry.focusPath)
      const rendered = coordinates(actual.shape)
      expect(rendered).toHaveLength(expected.length)
      // One comparison keeps the original three-decimal tolerance without
      // thousands of matcher calls competing with browser rendering.
      const maximumError = Math.max(...rendered.map((value, index) => Math.abs(value - expected[index]!)))
      expect(maximumError).toBeLessThan(0.0005)
      await expect(frame.locator('svg')).toBeVisible()
      await expect(frame).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)')
      expect(actual).toMatchObject({ corner: 'superellipse(1)', stroke: '1px', offset: '1px' })
    }).toPass({ timeout: 5000 })
  }
  await expectCapsule()
  await page.screenshot({ path: test.info().outputPath('overflow-frame-midpoint.png') })
  await frame.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()))
  await expectAligned(frame, expander, 0)
  await expectCapsule()
  await expect(expander).toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)')
  await page.screenshot({ path: test.info().outputPath('overflow-frame-settled.png') })

  await pointAt(historyChip(page, 'History Charlie'))
  await expect.poll(() => frame.evaluate((element) => element.getAnimations()[0]?.playState)).toBe('paused')
  await pointAt(historyChip(page, 'History Bravo'))
  await expect(expander).toHaveClass(/page-chip-overflow-hover-match/)
  await expect.poll(() => frame.evaluate((element) => element.getAnimations()[0]?.playState)).toBe('paused')
  await expectCapsule()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expectAligned(frame, expander, 0)
  await expectCapsule()
  await pointAt(historyChip(page, 'History Charlie'))
  await expect(frame).toHaveCSS('border-shape', 'none')
  await expect(frame).toHaveCSS('corner-shape', 'superellipse(2)')
})

test('the frame travels, resizes without scaling its stroke, and retargets from its interrupted position', async ({ page }) => {
  const frame = page.locator(frameSelector)
  const alpha = page.locator('[data-tabout="domain-card"][data-tabout-domain="alpha.test"]')
  const bravo = page.locator('[data-tabout="domain-card"][data-tabout-domain="bravo.test"]')
  const charlie = page.locator('[data-tabout="domain-card"][data-tabout-domain="charlie.test"]')
  await pointAt(historyChip(page, 'History Alpha'))
  await expectAligned(frame, alpha)
  await expect(frame).toHaveAttribute('aria-hidden', 'true')
  expect(await frame.evaluate((element) => element.getAnimations().length)).toBe(0)

  await pointAt(historyChip(page, 'History Bravo'))
  await expectAligned(frame, alpha)
  expect(await frame.evaluate((element) => element.getAnimations().length)).toBe(0)

  // Freeze real browser animations halfway through, without changing their
  // duration or easing, so geometry assertions do not race a 120ms transition.
  await frame.evaluate((element) => {
    new MutationObserver(() => {
      for (const animation of element.getAnimations()) {
        if (animation.playState === 'paused') continue
        animation.pause()
        animation.currentTime = 60
      }
    }).observe(element, { attributes: true, attributeFilter: ['style'] })
  })
  await pointAt(historyChip(page, 'History Charlie'))
  await expect.poll(() => frame.evaluate((element) => element.getAnimations()[0]?.playState)).toBe('paused')
  const midway = await frame.boundingBox()
  const start = await alpha.boundingBox()
  const end = await bravo.boundingBox()
  if (!midway || !start || !end) throw new Error('Card geometry is missing')
  expect(Math.hypot(midway.x - start.x + 8, midway.y - start.y + 8)).toBeGreaterThan(1)
  expect(Math.hypot(midway.x - end.x + 8, midway.y - end.y + 8)).toBeGreaterThan(1)
  expect(midway.height).toBeGreaterThan(Math.min(start.height, end.height) + 16)
  expect(midway.height).toBeLessThan(Math.max(start.height, end.height) + 16)
  expect(await frame.evaluate((element) => {
    const style = getComputedStyle(element)
    const transform = new DOMMatrix(style.transform)
    return { stroke: style.borderTopWidth, radius: style.borderTopLeftRadius, scaleX: transform.a, scaleY: transform.d }
  })).toEqual({ stroke: '1px', radius: '50px', scaleX: 1, scaleY: 1 })
  await page.screenshot({ path: test.info().outputPath('history-frame-midpoint.png') })

  await pointAt(historyChip(page, 'History Delta'))
  await expect.poll(() => charlie.locator('.page-chip-hover-match').count()).toBe(1)
  await frame.evaluate(async (element) => {
    await new Promise(requestAnimationFrame)
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Retargeted motion is missing')
    animation.currentTime = 0
  })
  const interruptedStart = await frame.boundingBox()
  expect(interruptedStart?.x).toBeCloseTo(midway.x, 1)
  expect(interruptedStart?.y).toBeCloseTo(midway.y, 1)
  expect(interruptedStart?.height).toBeCloseTo(midway.height, 1)
  await frame.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()))
  await expectAligned(frame, charlie)
  await page.screenshot({ path: test.info().outputPath('history-frame-settled.png') })

  await page.mouse.move(2, 2)
  await expect(frame).toBeHidden()
})

test('keyboard focus and reduced motion switch immediately; resizing stays aligned', async ({ page }) => {
  const frame = page.locator(frameSelector)
  const pageFrame = page.locator(pageFrameSelector)
  await pointAt(historyChip(page, 'History Alpha'))
  await expect(frame).toBeVisible()
  await historyChip(page, 'History Charlie').locator('.history-entry-main').focus()
  await expectAligned(frame, page.locator('[data-tabout="domain-card"][data-tabout-domain="bravo.test"]'))
  expect(await frame.evaluate((element) => element.getAnimations().length)).toBe(0)
  await expectAligned(pageFrame, dashboardChip(page, 'History Charlie'), 0)
  expect(await pageFrame.evaluate((element) => element.getAnimations().length)).toBe(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pointAt(historyChip(page, 'History Delta'))
  const target = page.locator('[data-tabout="domain-card"][data-tabout-domain="charlie.test"]')
  await expectAligned(frame, target)
  expect(await frame.evaluate((element) => element.getAnimations().length)).toBe(0)
  await expectAligned(pageFrame, dashboardChip(page, 'History Delta'), 0)
  expect(await pageFrame.evaluate((element) => element.getAnimations().length)).toBe(0)
  await page.setViewportSize({ width: 1100, height: 700 })
  await expectAligned(frame, target)
  await page.locator('[data-tabout-part="scroll-region"]').evaluate((element) => {
    element.style.maxHeight = '100px'
    const grid = element.querySelector<HTMLElement>('.missions')
    if (grid) grid.style.minHeight = '500px'
    element.scrollTop = 20
  })
  await expectAligned(frame, target)
  await expectAligned(pageFrame, dashboardChip(page, 'History Delta'), 0)
})

test('the page outline moves within a card and retargets across cards without a second destination outline', async ({ page }) => {
  const frame = page.locator(pageFrameSelector)
  const cardFrame = page.locator(frameSelector)
  const alpha = dashboardChip(page, 'History Alpha')
  const bravo = dashboardChip(page, 'History Bravo')
  const charlie = dashboardChip(page, 'History Charlie')
  await pointAt(historyChip(page, 'History Alpha'))
  await expectAligned(frame, alpha, 0)
  expect(await frame.evaluate((element) => element.getAnimations().length)).toBe(0)
  const cardBounds = await cardFrame.boundingBox()
  await frame.evaluate((element) => {
    new MutationObserver(() => {
      for (const animation of element.getAnimations()) {
        if (animation.playState === 'paused') continue
        animation.pause()
        animation.currentTime = 60
      }
    }).observe(element, { attributes: true, attributeFilter: ['style'] })
  })
  await pointAt(historyChip(page, 'History Bravo'))
  await expect.poll(() => frame.evaluate((element) => element.getAnimations()[0]?.playState)).toBe('paused')
  const midway = await frame.boundingBox()
  const start = await alpha.boundingBox()
  const end = await bravo.boundingBox()
  if (!midway || !start || !end) throw new Error('Page geometry is missing')
  expect(midway.y).toBeGreaterThan(Math.min(start.y, end.y))
  expect(midway.y).toBeLessThan(Math.max(start.y, end.y))
  expect(await cardFrame.boundingBox()).toEqual(cardBounds)
  expect(await cardFrame.evaluate((element) => element.getAnimations().length)).toBe(0)
  await expect(bravo.locator('..').locator('.page-chip-hover-match-outline')).toHaveCSS('visibility', 'hidden')
  expect(await frame.evaluate((element) => {
    const style = getComputedStyle(element)
    const transform = new DOMMatrix(style.transform)
    return { stroke: style.outlineWidth, offset: style.outlineOffset, radius: style.borderTopLeftRadius, scaleX: transform.a, scaleY: transform.d }
  })).toEqual({ stroke: '1px', offset: '1px', radius: '23px', scaleX: 1, scaleY: 1 })
  await page.screenshot({ path: test.info().outputPath('page-frame-midpoint.png') })

  await pointAt(historyChip(page, 'History Charlie'))
  await expect(charlie).toHaveClass(/page-chip-hover-match/)
  await frame.evaluate(async (element) => {
    await new Promise(requestAnimationFrame)
    const animation = element.getAnimations()[0]
    if (!animation) throw new Error('Retargeted page motion is missing')
    animation.currentTime = 0
  })
  const interrupted = await frame.boundingBox()
  expect(interrupted?.x).toBeCloseTo(midway.x, 1)
  expect(interrupted?.y).toBeCloseTo(midway.y, 1)
  await frame.evaluate((element) => element.getAnimations().forEach((animation) => animation.finish()))
  await expectAligned(frame, charlie, 0)
  await page.mouse.move(2, 2)
  await expect(frame).toBeHidden()
})

test('multiple page matches and expanded surfaces retain their local outlines', async ({ page }) => {
  const frame = page.locator(pageFrameSelector)
  await pointAt(historyChip(page, 'History Alpha'))
  const chip = dashboardChip(page, 'History Alpha')
  await expectAligned(frame, chip, 0)
  await chip.evaluate((element) => element.parentElement!.after(element.parentElement!.cloneNode(true)))
  await expect(frame).toBeHidden()
  expect(await chip.locator('..').locator('.page-chip-hover-match-outline').evaluateAll((elements) => (
    elements.map((element) => getComputedStyle(element).visibility)
  ))).toEqual(['visible', 'visible'])
  await chip.last().evaluate((element) => element.parentElement!.remove())
  await expect(frame).toBeVisible()
  // An expanded target owns a higher stacking context. Exercise that marker
  // independently of the history source's own title-expansion interaction.
  await chip.evaluate((element) => element.classList.add('page-chip-expanded'))
  await expect(frame).toBeHidden()
  await expect(chip.locator('..').locator('.page-chip-hover-match-outline')).toHaveCSS('visibility', 'visible')
  await chip.evaluate((element) => element.classList.remove('page-chip-expanded'))
  await expectAligned(frame, chip, 0)
})

test('hovering during a card pin flight keeps both outlines local until the card settles', async ({ page }) => {
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="charlie.test"]')
  await card.hover()
  await page.getByRole('button', { name: 'Actions for charlie.test', exact: true }).click({ force: true })
  await page.getByRole('menuitem', { name: 'Pin card', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-tabout-domain="charlie.test"].layout-moving'))
  await pointAt(historyChip(page, 'History Delta'))

  const samples = await card.evaluate(async (element) => {
    const samples: { x: number, sharedCardHidden: boolean, sharedPageHidden: boolean, cardOpacity: string, pageVisibility: string, pageOffset: number }[] = []
    while (element.classList.contains('layout-moving')) {
      await new Promise(requestAnimationFrame)
      if (!element.classList.contains('layout-moving')) break
      const chip = element.querySelector('.page-chip-hover-match')
      const outline = chip?.parentElement?.querySelector('.page-chip-hover-match-outline')
      const cardFrame = document.querySelector<HTMLElement>('[data-tabout-part="history-match-frame"]')
      const pageFrame = document.querySelector<HTMLElement>('[data-tabout-part="history-page-match-frame"]')
      if (!chip || !outline || !cardFrame || !pageFrame) continue
      samples.push({
        x: element.getBoundingClientRect().x,
        sharedCardHidden: cardFrame.hidden === true,
        sharedPageHidden: pageFrame.hidden === true,
        cardOpacity: getComputedStyle(element, '::after').opacity,
        pageVisibility: getComputedStyle(outline).visibility,
        pageOffset: Math.abs(outline.getBoundingClientRect().x - chip.getBoundingClientRect().x),
      })
    }
    return samples
  })
  expect(samples.length).toBeGreaterThan(1)
  expect(Math.max(...samples.map((sample) => sample.x)) - Math.min(...samples.map((sample) => sample.x))).toBeGreaterThan(20)
  for (const sample of samples) {
    expect(sample.sharedCardHidden).toBe(true)
    expect(sample.sharedPageHidden).toBe(true)
    expect(sample.cardOpacity).toBe('1')
    expect(sample.pageVisibility).toBe('visible')
    expect(sample.pageOffset).toBeLessThan(1)
  }
  // The scroller's temporary overflow allowance outlives the card's FLIP.
  // Its cleanup changes the overlay coordinate origin without resizing chips.
  await expect(page.locator('[data-tabout-part="scroll-region"]')).not.toHaveClass(/card-motion-bleed/)
  await expectAligned(page.locator(frameSelector), card)
  await expectAligned(page.locator(pageFrameSelector), dashboardChip(page, 'History Delta'), 0)
  for (const selector of [frameSelector, pageFrameSelector]) {
    expect(await page.locator(selector).evaluate((element) => element.getAnimations().length)).toBe(0)
  }
})

test('an intra-card move releases only the page overlay and resumes without stale motion', async ({ page }) => {
  await pointAt(historyChip(page, 'History Alpha'))
  const chip = dashboardChip(page, 'History Alpha')
  const pageFrame = page.locator(pageFrameSelector)
  await expectAligned(pageFrame, chip, 0)
  // Exercise the same slot marker used by the intra-card FLIP adapter, including
  // its cancellation cleanup, without changing preview ownership through a menu.
  await chip.evaluate((element) => {
    const slot = element.closest<HTMLElement>('.chip-slot')
    if (!slot) throw new Error('Page Chip slot is missing')
    slot.classList.add('intra-card-layout-moving')
    slot.style.transform = 'translateY(20px)'
  })
  await expect(pageFrame).toBeHidden()
  await expect(page.locator(frameSelector)).toBeVisible()
  await expect(chip.locator('..').locator('.page-chip-hover-match-outline')).toHaveCSS('visibility', 'visible')
  await chip.evaluate((element) => {
    const slot = element.closest<HTMLElement>('.chip-slot')
    if (!slot) throw new Error('Page Chip slot is missing')
    slot.classList.remove('intra-card-layout-moving')
    slot.style.transform = ''
  })
  await expectAligned(pageFrame, chip, 0)
  expect(await pageFrame.evaluate((element) => element.getAnimations().length)).toBe(0)
})

test('multiple matches retain every local frame and removing a target clears the shared frame', async ({ page }) => {
  const frame = page.locator(frameSelector)
  await pointAt(historyChip(page, 'History Alpha'))
  await expect(frame).toBeVisible()
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="alpha.test"]')
  // Model duplicate card surfaces in companion results without changing the
  // fixture's data resolver: the existing match markers remain authoritative.
  await card.evaluate((element) => element.parentElement!.after(element.parentElement!.cloneNode(true)))
  await expect(frame).toBeHidden()
  expect(await card.evaluateAll((elements) => elements.map((element) => getComputedStyle(element, '::after').opacity))).toEqual(['1', '1'])
  await card.last().evaluate((element) => element.remove())
  await expect(frame).toBeVisible()
  await card.evaluate((element) => element.remove())
  await expect(frame).toBeHidden()
})
