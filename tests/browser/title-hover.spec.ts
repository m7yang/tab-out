import { expect, test } from '@playwright/test'

for (const surface of ['page-chip', 'history-entry']) {
  test(`${surface} keeps hover chrome and expansion together through blur and re-entry`, async ({ page }) => {
    await page.goto('/tests/fixtures/dashboard-resize.html')
    const chip = page.locator(`.${surface}[data-title-collapsed]:has([data-tabout-part="close-button"])`).first()
    await expect(chip).toBeVisible()
    await chip.scrollIntoViewIfNeeded()
    // Keep one identity as expansion removes the collapsed-state selector.
    await chip.evaluate((element) => element.setAttribute('data-hover-probe', 'target'))
    const target = page.locator('[data-hover-probe="target"]')
    const readPaint = () => target.evaluate((element) => {
      const style = getComputedStyle(element)
      const visibleSurface = element.parentElement?.querySelector('.history-entry-expanded') ?? element
      const close = visibleSurface.querySelector('[data-tabout-part="close-button"]')
      const frame = element.querySelector('.active-chip-frame, .active-history-entry-frame')
      return {
        background: getComputedStyle(element.matches('[data-capsule-ready]') ? element.querySelector(':scope > .capsule-fill')! : element).backgroundColor,
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        fade: getComputedStyle(element, '::after').opacity,
        close: close ? getComputedStyle(close).opacity : null,
        frame: frame ? getComputedStyle(frame).boxShadow : null,
      }
    })
    const restPaint = await readPaint()
    // CSS can match hover before the pointer event's expansion commit. Force
    // that paint independently to verify it cannot expose either surface early.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-hover-probe="target"]',
    })
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
    await expect.poll(readPaint).toEqual(restPaint)
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    await cdp.detach()
    const close = target.locator('[data-tabout-part="close-button"]')
    const box = await close.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(target).toHaveAttribute('data-expanded', 'true')
    await expect.poll(async () => (await readPaint()).background).not.toBe(restPaint.background)
    await expect.poll(async () => (await readPaint()).close).toBe('1')

    // Window deactivation closes the title without changing the CSS hover target.
    // This is the intermediate state that previously retained the rim and action.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(target).toHaveAttribute('data-title-collapsed', '')
    expect(await target.evaluate((element) => element.matches(':hover'))).toBe(true)
    await expect.poll(readPaint).toEqual(restPaint)

    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)
    await expect(target).toHaveAttribute('data-expanded', 'true')
    await page.mouse.move(0, 0)
    await expect(target).toHaveAttribute('data-title-collapsed', '')
    await expect.poll(readPaint).toEqual(restPaint)
  })
}

test('Page Chip keeps its keyboard-focus outline when the pointer enters', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const chip = page.locator('.page-chip[role="button"]')
    .filter({ hasText: 'Example 2 with enough tooltip text' }).first()
  await expect(chip).toBeVisible()
  await chip.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await chip.focus()
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  const readFocusOutline = () => chip.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      focusVisible: element.matches(':focus-visible'),
      outline: style.outline,
      offset: style.outlineOffset,
    }
  })
  const focused = await readFocusOutline()
  expect(focused.focusVisible).toBe(true)
  await expect(chip).toHaveCSS('outline-width', '2px')
  await expect(chip).toHaveCSS('outline-offset', '2px')

  await chip.hover()
  await expect.poll(readFocusOutline).toEqual(focused)
  await page.mouse.move(0, 0)
  await expect.poll(readFocusOutline).toEqual(focused)
})

test('Page Chip keeps its keyboard-selection outline when the pointer enters', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Example')
  const candidates = page.locator('#openTabsMissions [data-tabout-filter-result]')
  await expect.poll(() => candidates.count()).toBeGreaterThan(1)
  const firstId = await candidates.first().getAttribute('id')
  await input.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', firstId ?? '')
  const chip = page.locator('.page-chip[data-tabout-filter-result-selected="true"]')
  await expect(chip).toBeVisible()
  await expect(input).toBeFocused()
  const readOutline = () => chip.evaluate((element) => {
    const style = getComputedStyle(element)
    return { outline: style.outline, offset: style.outlineOffset }
  })
  await expect(chip).toHaveCSS('outline-offset', '2px')
  const selected = await readOutline()

  await chip.hover()
  await expect(input).toBeFocused()
  await expect.poll(readOutline).toEqual(selected)
  await page.mouse.move(0, 0)
  await expect.poll(readOutline).toEqual(selected)
})

test('Activation History keeps keyboard focus visible on the painted surface during expansion and hover', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const candidate = page.locator('[data-tabout="activation-history-row"]')
    .filter({ has: page.locator('.history-entry[data-title-collapsed] .history-entry-main[tabindex="0"]') }).first()
  await expect(candidate).toBeVisible()
  await candidate.evaluate((element) => element.setAttribute('data-focus-probe', 'history'))
  const row = page.locator('[data-focus-probe="history"]')
  const target = row.locator('[data-tabout="page-chip"] .history-entry-main')
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await target.focus()
  await expect(target).toBeFocused()
  await expect(row.locator('[data-tabout-part="expanded-surface"]')).toBeVisible()

  const readOutline = () => row.evaluate((element) => {
    const surface = element.querySelector('[data-tabout-part="expanded-surface"]')
      ?? element.querySelector('[data-tabout="page-chip"]')
    if (!surface) return null
    const style = getComputedStyle(surface)
    return { width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor }
  })
  const focusOutline = { width: '2px', offset: '2px', color: 'rgb(82, 82, 82)' }
  await expect.poll(readOutline).toEqual(focusOutline)
  await row.locator('[data-tabout-part="expanded-surface"]').hover()
  await expect.poll(readOutline).toEqual(focusOutline)
  await page.mouse.move(0, 0)
  await expect(target).toBeFocused()
  await expect.poll(readOutline).toEqual(focusOutline)
})

test('Activation History owns hover, activation, and menus across the expanded surface', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const row = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9001"]')
  const chip = row.locator('[data-tabout="page-chip"]')
  await expect(chip).toBeVisible()
  await chip.scrollIntoViewIfNeeded()
  const rest = await chip.boundingBox()
  if (!rest) throw new Error('History chip is missing')
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2)
  const expanded = row.locator('[data-tabout-part="expanded-surface"]')
  await expect(expanded).toBeVisible()
  const bounds = await expanded.boundingBox()
  if (!bounds) throw new Error('Expanded History chip is missing')
  expect(bounds.x + bounds.width).toBeGreaterThan(rest.x + rest.width + 8)
  const overflow = { x: Math.min(bounds.x + bounds.width - 4, rest.x + rest.width + 16), y: rest.y + rest.height / 2 }
  await page.mouse.move(overflow.x, overflow.y)
  await expect(expanded).toBeVisible()
  expect(await expanded.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), overflow)).toBe(true)
  await expect(page.locator('.history-entry-expanded')).toHaveCount(1)

  // Record the real action target rather than merely checking event propagation.
  await page.evaluate(() => {
    const activated: number[] = []
    Reflect.set(window, '__historyExpansionActivated', activated)
    const update = window.chrome.tabs.update.bind(window.chrome.tabs)
    Reflect.set(window.chrome.tabs, 'update', async (id: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.active) activated.push(id)
      return update(id, properties)
    })
  })
  await page.mouse.click(overflow.x, overflow.y)
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__historyExpansionActivated'))).toEqual([9001])

  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2)
  await expect(expanded).toBeVisible()
  await page.mouse.click(overflow.x, overflow.y, { button: 'right' })
  await expect(page.locator('[data-slot="context-menu-content"]')).toBeVisible()
  await expect(row.locator('.history-entry-slot')).toHaveAttribute('data-context-menu-open', '')
  // Menu ownership survives pointer departure; dismissal over the revealed
  // surface must not close and reopen the expansion.
  await page.mouse.move(2, 2)
  await expect(expanded).toBeVisible()
  await page.mouse.click(overflow.x, overflow.y)
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0)
  await expect(expanded).toBeVisible()
  await page.mouse.move(bounds.x + bounds.width + 2, bounds.y + bounds.height / 2)
  await expect(expanded).toHaveCount(0)
})

test('wheel input over revealed History text scrolls History without scrolling the dashboard', async ({ page }) => {
  await page.setViewportSize({ width: 1420, height: 300 })
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const row = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9001"]')
  const chip = row.locator('[data-tabout="page-chip"]')
  await expect(chip).toBeVisible()
  const rest = await chip.boundingBox()
  if (!rest) throw new Error('History chip is missing')
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2)
  const expanded = row.locator('[data-tabout-part="expanded-surface"]')
  await expect(expanded).toBeVisible()
  const bounds = await expanded.boundingBox()
  if (!bounds) throw new Error('Expanded History chip is missing')
  const overflowX = Math.min(bounds.x + bounds.width - 4, rest.x + rest.width + 16)
  expect(overflowX).toBeGreaterThan(rest.x + rest.width)
  await page.mouse.move(overflowX, rest.y + rest.height / 2)
  await expect(expanded).toBeVisible()
  const history = page.locator('.history-entry-list')
  const dashboard = page.locator('[data-tabout-part="scroll-region"]')
  const historyBefore = await history.evaluate((element) => element.scrollTop)
  const dashboardBefore = await dashboard.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 100)
  await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(historyBefore)
  expect(await dashboard.evaluate((element) => element.scrollTop)).toBe(dashboardBefore)
})

for (const audioState of ['playing', 'muted']) {
  test(`expanded History ${audioState} audio keeps focus on the canonical control after collapse`, async ({ page }) => {
    await page.goto(`/tests/fixtures/dashboard-resize.html?historyAudio=${audioState}`)
    const row = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9001"]')
    const canonicalAudio = row.locator('[data-tabout="page-chip"] [data-tabout-part="audio-toggle"]')
    await expect(canonicalAudio).toBeVisible()
    await page.getByRole('searchbox', { name: 'Filter dashboard' }).focus()
    const rect = await canonicalAudio.boundingBox()
    if (!rect) throw new Error('History audio control is missing')
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    const expanded = row.locator('[data-tabout-part="expanded-surface"]')
    await expect(expanded).toBeVisible()
    await expanded.locator('[data-tabout-part="audio-toggle"]').click()
    await expect.poll(() => page.evaluate(async () => (await window.chrome.tabs.get(9001)).mutedInfo?.muted)).toBe(audioState === 'playing')
    expect(await page.evaluate(async () => (await window.chrome.tabs.get(9001)).active)).toBe(false)
    await expect(canonicalAudio).toBeFocused()

    await page.mouse.move(0, 0)
    await expect(expanded).toHaveCount(0)
    await expect(canonicalAudio).toBeFocused()
    expect(await canonicalAudio.evaluate((element) => element.closest('[aria-hidden="true"]') === null)).toBe(true)
  })
}
