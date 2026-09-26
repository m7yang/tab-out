import { expect, test, type Locator } from '@playwright/test'

for (const input of ['pointer', 'keyboard']) {
  test(`a passive refresh preserves the ${input} history preview and both outlines`, async ({ page }) => {
    await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion')
    const history = page.locator('[data-tabout-context="activation-history"][data-tabout="page-chip"]').filter({ hasText: 'History Alpha' })
    if (input === 'pointer') await history.hover()
    else await history.locator('.history-entry-main').focus()
    await expect(page.locator('.page-chip-hover-match')).toHaveText('History Alpha')

    // A different tab changing its favicon schedules a real passive refresh.
    // Keep the current input in place; re-entering the chip would mask the bug.
    await page.evaluate(async () => {
      await Reflect.get(window, '__tabOutSmokeSetTabFavicon')(9103, 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E')
    })
    await expect(page.locator('[data-tabout-domain="bravo.test"] img').first()).toHaveAttribute('src', /data:image\/svg/)
    await expect(page.locator('.page-chip-hover-match')).toHaveText('History Alpha')
    for (const part of ['history-match-frame', 'history-page-match-frame']) {
      await expect(page.locator(`[data-tabout-part="${part}"]`)).toBeVisible()
    }
    await expect(page.locator('.url-preview')).toHaveText('https://alpha.test/page-0')

    // Explicit filter changes still invalidate the old preview.
    await page.locator('[data-tabout="filter-query"] input').fill('no-matching-page')
    await expect(page.locator('.page-chip-hover-match')).toHaveCount(0)
    await expect(page.locator('[data-tabout-part="history-match-frame"]')).toBeHidden()
    await expect(page.locator('.url-preview')).toHaveCSS('opacity', '0')
  })
}

for (const change of ['removed', 'replaced']) {
  test(`a ${change} history target releases its preview during a passive refresh`, async ({ page }) => {
    await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyFrameMotion')
    const title = change === 'removed' ? 'History Delta' : 'History Alpha'
    const tabId = change === 'removed' ? 9104 : 9101
    const row = page.locator(`[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:${tabId}"]`)
    await row.locator('.history-entry-main').focus()
    await expect(page.locator('.page-chip-hover-match')).toHaveText(title)
    // Keep the original dashboard tab available to expose stale matches.
    // Replacement preserves row order and focus, so blur cannot mask cleanup.
    await page.evaluate(({ change, tabId }) => {
      if (change === 'removed') Reflect.get(window, '__tabOutSmokeRemoveHistoryEntry')(tabId)
      else Reflect.get(window, '__tabOutSmokeSetHistoryEntryUrl')(tabId, 'https://replacement.test/page')
      Reflect.get(window, '__tabOutSmokeDispatchPassiveHistoryRefresh')()
    }, { change, tabId })
    if (change === 'removed') await expect(row).toHaveCount(0)
    await expect(page.locator('.page-chip-hover-match')).toHaveCount(0)
    await expect(page.locator('[data-tabout-part="history-match-frame"]')).toBeHidden()
    await expect(page.locator('.url-preview')).toHaveCSS('opacity', '0')
    if (change === 'replaced') await expect(row.locator('.history-entry-main')).toBeFocused()
  })
}

test('removing an older history owner does not clear the newer focused preview', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame')
  for (const title of ['History Delta', 'History Alpha']) {
    await page.locator('[data-tabout="activation-history-row"]').filter({ hasText: title }).locator('.history-entry-main').focus()
    await expect(page.locator('.page-chip-hover-match')).toHaveText(title)
  }
  await page.evaluate(() => {
    Reflect.get(window, '__tabOutSmokeRemoveHistoryEntry')(9104)
    Reflect.get(window, '__tabOutSmokeDispatchPassiveHistoryRefresh')()
  })
  await expect(page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9104"]')).toHaveCount(0)
  await expect(page.locator('.page-chip-hover-match')).toHaveText('History Alpha')
  await expect(page.locator('[data-tabout-part="history-match-frame"]')).toBeVisible()
})

test('keyboard history activation waits for another row’s pending native highlight', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyHoverFrameExpanded=above')
  const focused = page.locator('[data-tabout-layout-key="stack:1:9101"] .history-entry-main')
  const hovered = page.locator('[data-tabout-layout-key="stack:1:9103"] [data-tabout="page-chip"]')
  await focused.focus()
  await expect(page.locator('.page-chip-hover-match')).toHaveText('History Alpha')
  await page.evaluate(() => {
    // The layout fixture omits windows.get; supply the read needed to reach
    // the real native-highlight controller's selection lookup.
    Reflect.set(chrome.windows, 'get', async (id: number) => (
      (await chrome.windows.getAll()).find((window) => window.id === id)
    ))
    const query = chrome.tabs.query.bind(chrome.tabs)
    let paused = false
    Reflect.set(chrome.tabs, 'query', async (options: chrome.tabs.QueryInfo) => {
      const snapshot = await query(options)
      if (!paused && options.windowId === 1) {
        paused = true
        await new Promise<void>((resolve) => Reflect.set(window, '__releaseHistoryHoverQuery', resolve))
      }
      return snapshot
    })
    const activated: number[] = []
    Reflect.set(window, '__historyHoverActivated', activated)
    const update = chrome.tabs.update.bind(chrome.tabs)
    Reflect.set(chrome.tabs, 'update', async (id: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.active) activated.push(id)
      return update(id, properties)
    })
  })
  const rect = await hovered.boundingBox()
  if (!rect) throw new Error('History chip is missing')
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await expect(page.locator('.page-chip-hover-match')).toContainText('History Charlie')
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, '__releaseHistoryHoverQuery'))).toBe('function')
  await page.keyboard.press('Enter')
  // Clearing the visual match must not let activation overtake the pending
  // native selection: that selection captured the previously active tab.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  expect(await page.evaluate(() => Reflect.get(window, '__historyHoverActivated'))).toEqual([])
  await expect(page.locator('.page-chip-hover-match')).toHaveCount(0)
  await page.evaluate(() => {
    const release: unknown = Reflect.get(window, '__releaseHistoryHoverQuery')
    if (typeof release !== 'function') throw new Error('Native highlight query was not paused')
    release()
  })
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__historyHoverActivated'))).toEqual([9101])
})

async function expectCardFrame(card: Locator, visible: boolean) {
  await expect.poll(() => card.evaluate((element) => {
    const root = element.closest('[data-tabout-part="scroll-region"]')
    if (root?.hasAttribute('data-history-match-frame')) {
      return !!root.querySelector('[data-tabout-part="history-match-frame"]:not([hidden])')
    }
    return getComputedStyle(element, '::after').opacity === '1'
  })).toBe(visible)
}

for (const departingOwner of ['focus', 'pointer']) {
  test(`a departing ${departingOwner} owner cannot clear a newer history match`, async ({ page }) => {
    await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyHoverFrameExpanded=above')
    const oldRow = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9104"]')
    const newRow = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9103"]')
    const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="history-reorder.test"]')
    const match = card.locator('.page-chip-hover-match').filter({ hasText: 'History Charlie' })
    await expect(oldRow).toBeVisible()
    const pointerRow = departingOwner === 'focus' ? newRow : oldRow
    const focusRow = departingOwner === 'focus' ? oldRow : newRow
    if (departingOwner === 'focus') await focusRow.locator('.history-entry-main').focus()
    const rect = await pointerRow.locator('[data-tabout="page-chip"]').boundingBox()
    if (!rect) throw new Error('History chip is missing')
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    if (departingOwner === 'pointer') await focusRow.locator('.history-entry-main').first().focus()
    await expect(match).toHaveCount(1)
    await expectCardFrame(card, true)

    if (departingOwner === 'focus') await page.locator('input').first().focus()
    else await page.mouse.move(2, 2)

    await expect(match).toHaveCount(1)
    await expectCardFrame(card, true)
    if (departingOwner === 'focus') await page.mouse.move(2, 2)
    else await page.locator('input').first().focus()
    await expect(card.locator('.page-chip-hover-match')).toHaveCount(0)
    await expectCardFrame(card, false)
  })
}

test('history card outline follows the expanded surface through menu dismissal and departure', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverFrame&historyHoverFrameExpanded=above')
  const row = page.locator('[data-tabout="activation-history-row"][data-tabout-layout-key="stack:1:9103"]')
  const chip = row.locator('[data-tabout="page-chip"]')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="history-reorder.test"]')
  await expect(chip).toBeVisible()
  const rest = await chip.boundingBox()
  if (!rest) throw new Error('History chip is missing')
  await page.mouse.move(rest.x + rest.width / 2, rest.y + rest.height / 2)
  const expanded = row.locator('[data-tabout-part="expanded-surface"]')
  await expect(expanded).toBeVisible()
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await expectCardFrame(card, true)
  const bounds = await expanded.boundingBox()
  if (!rest || !bounds) throw new Error('History surfaces are missing')
  const point = { x: Math.min(bounds.x + bounds.width - 4, rest.x + rest.width + 16), y: rest.y + rest.height / 2 }
  await page.mouse.move(point.x, point.y)
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.locator('[data-slot="context-menu-content"]')).toBeVisible()
  await page.mouse.move(2, 2)
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await page.mouse.click(point.x, point.y)
  await expect(page.locator('[data-slot="context-menu-content"]')).toHaveCount(0)
  await expect(expanded).toBeVisible()
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(1)
  await expectCardFrame(card, true)
  await page.mouse.move(2, 2)
  await expect(card.locator('.page-chip-hover-match')).toHaveCount(0)
  await expectCardFrame(card, false)
})

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
        await page.mouse.move(neighborRect.x + neighborRect.width / 2, neighborRect.y + neighborRect.height / 2)
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

test('history hover keeps its matching dashboard outline above the adjacent fill', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?historyHoverSeam')
  const chips = page.locator('[data-tabout-context="domain-card"][data-tabout="page-chip"]')
  await expect(chips).toHaveCount(2)
  for (const edge of ['bottom', 'top'] as const) {
    await page.locator(`[data-tabout-layout-key="stack:${edge === 'bottom' ? '1:1' : '2:2'}"] .history-entry-main`).hover()
    await expect(page.locator('.page-chip-hover-match')).toHaveCount(1)
    const owner = chips.nth(edge === 'bottom' ? 0 : 1)
    const neighbor = chips.nth(edge === 'bottom' ? 1 : 0)
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
    const samples = await page.evaluate(async (images) => Promise.all(images.map(async (encoded) => {
      const image = new Image()
      image.src = `data:image/png;base64,${encoded}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
    })), [actual.toString('base64'), unobstructed.toString('base64')])
    // Fractional capsule strokes partially cover this row. The neighboring
    // background can change antialiased pixels by 2 levels without covering
    // the outline; retain a tight bound and verify the reference contains ink.
    expect(Math.min(...samples[1]!)).toBeLessThan(160)
    const maximumDifference = Math.max(...samples[0]!.map((value, index) => Math.abs(value - samples[1]![index]!)))
    expect(maximumDifference, `${edge} outline should remain visible beside another tab`).toBeLessThanOrEqual(3)
  }
})

test('new-tab hover matches physical stack membership in both directions', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?newTabHoverIdentity')
  const chips = page.locator('[data-tabout-context="domain-card"][data-tabout="page-chip"]')
  await expect(chips).toHaveCount(3)
  await expect(chips).toHaveText(['\u200e', '\u200e', 'New Tab'])
  const buckets = [[1], [2, 3], [4, 5, 6, 7]]
  for (const [index, tabIds] of buckets.entries()) {
    for (const tabId of tabIds) {
      const history = page.locator(`[data-tabout-layout-key="stack:${tabId === 1 ? 1 : 2}:${tabId}"] .history-entry-main`)
      for (const input of ['pointer', 'keyboard']) {
        if (input === 'pointer') await history.hover()
        else await history.focus()
        await expect(page.locator('.page-chip-hover-match')).toHaveCount(1)
        await expect(chips.nth(index)).toHaveClass(/page-chip-hover-match/)
      }
    }
    await chips.nth(index).hover()
    const matches = page.locator('[data-tabout="activation-history-row"]').filter({ has: page.locator('.history-entry-hover-match') })
    await expect(matches).toHaveCount(tabIds.length)
    for (const tabId of tabIds) {
      await expect(page.locator(`[data-tabout-layout-key="stack:${tabId === 1 ? 1 : 2}:${tabId}"] .history-entry-hover-match`)).toHaveCount(1)
    }
  }
})
