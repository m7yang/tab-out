import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import type { CDPSession } from '@playwright/test'

test('filter shortcut startup preserves the prerendered input and its focus-visible shadow', async ({
  page
}) => {
  const hydrationErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydration|didn't match/i.test(message.text())) {
      hydrationErrors.push(message.text())
    }
  })
  await page.addInitScript(() => {
    const focusShadowPaint = {
      owner: 'none',
      presentations: 0,
      visible: false,
      blur: 0
    }
    const startupInput = {
      element: null as HTMLInputElement | null,
      seeded: false
    }

    function sampleFocusShadow() {
      const inputs = document.querySelectorAll<HTMLInputElement>(
        '[data-tabout="filter-query"] input'
      )
      let owner = 'none'
      let blur = 0
      for (const input of inputs) {
        if (!input.matches(':focus-visible')) continue
        if (!startupInput.seeded) {
          startupInput.element = input
          startupInput.seeded = true
          input.value = 'exam'
          input.setSelectionRange(2, 2)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const borderLayer = input.parentElement
        if (!borderLayer) continue
        const focusLayer = getComputedStyle(borderLayer, '::after')
        const shadowLengths = focusLayer.filter
          .match(/-?[\d.]+px/g)
          ?.map((length) => Number.parseFloat(length)) ?? []
        const inputBlur = Math.max(
          0,
          ...shadowLengths.filter((_, index) => index % 3 === 2)
        ) * Number.parseFloat(focusLayer.opacity)
        if (inputBlur > blur) {
          owner = 'app'
          blur = inputBlur
        }
      }

      const visible = blur > 0
      if (visible && !focusShadowPaint.visible) focusShadowPaint.presentations += 1
      focusShadowPaint.owner = owner
      focusShadowPaint.visible = visible
      focusShadowPaint.blur = blur
      requestAnimationFrame(sampleFocusShadow)
    }

    ;(window as typeof window & {
      __tabOutFocusShadowPaint: typeof focusShadowPaint
      __tabOutStartupInput: typeof startupInput
    }).__tabOutFocusShadowPaint = focusShadowPaint
    ;(window as typeof window & {
      __tabOutStartupInput: typeof startupInput
    }).__tabOutStartupInput = startupInput
    requestAnimationFrame(sampleFocusShadow)
  })
  await page.route('**/extension/dist/app.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await route.continue()
  })

  await page.goto('/tests/fixtures/dashboard-resize.html?focusFilter=1')
  const filterInput = page.locator('[data-tabout="filter-query"] input')
  await expect(filterInput).toHaveValue('exam')
  await expect(filterInput).toBeFocused()
  expect(await filterInput.evaluate((input) => {
    const filterInputElement = input as HTMLInputElement
    const startupInput = (window as typeof window & {
      __tabOutStartupInput: { element: HTMLInputElement | null }
    }).__tabOutStartupInput
    return {
      sameElement: startupInput.element === filterInputElement,
      selectionEnd: filterInputElement.selectionEnd,
      selectionStart: filterInputElement.selectionStart
    }
  })).toEqual({
    sameElement: true,
    selectionEnd: 2,
    selectionStart: 2
  })
  expect(hydrationErrors).toEqual([])
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutFocusShadowPaint: { blur: number } })
      .__tabOutFocusShadowPaint.blur
  )).toBeGreaterThan(2.8)

  const focusStyle = await filterInput.evaluate((input) => ({
    restingFilter: getComputedStyle(input.parentElement!, '::before').filter,
    focusFilter: getComputedStyle(input.parentElement!, '::after').filter,
    focusBoxShadow: getComputedStyle(input.parentElement!, '::after').boxShadow,
    focusBorderColor: getComputedStyle(input.parentElement!, '::after').borderColor,
    focusOpacity: getComputedStyle(input.parentElement!, '::after').opacity,
    caretColor: getComputedStyle(input).caretColor,
    inputFilter: getComputedStyle(input).filter
  }))
  expect(focusStyle.inputFilter).toBe('none')
  expect(focusStyle.restingFilter).toContain('drop-shadow')
  expect(focusStyle.focusFilter).toContain('drop-shadow')
  expect(focusStyle.focusBoxShadow).toBe('none')
  expect(focusStyle.focusBorderColor).toBe(focusStyle.caretColor)
  expect(focusStyle.focusOpacity).toBe('1')

  await filterInput.fill('example')
  const clearFilterButton = page.getByRole('button', { name: 'Clear filter' })
  await expect(clearFilterButton).toBeVisible()
  await filterInput.evaluate((input) => {
    const trackedWindow = window as typeof window & { __tabOutFilterBlurCount?: number }
    trackedWindow.__tabOutFilterBlurCount = 0
    input.addEventListener('blur', () => {
      trackedWindow.__tabOutFilterBlurCount = (trackedWindow.__tabOutFilterBlurCount ?? 0) + 1
    })
  })
  await clearFilterButton.click()
  await expect(filterInput).toHaveValue('')
  await expect(filterInput).toBeFocused()
  expect(await page.evaluate(() =>
    (window as typeof window & { __tabOutFilterBlurCount?: number }).__tabOutFilterBlurCount
  )).toBe(0)

  const focusShadowPaint = await page.evaluate(() =>
    (window as typeof window & {
      __tabOutFocusShadowPaint: {
        owner: string
        presentations: number
        visible: boolean
        blur: number
      }
    }).__tabOutFocusShadowPaint
  )
  expect(focusShadowPaint).toMatchObject({
    owner: 'app',
    presentations: 1,
    visible: true
  })

  const refocusPaint = await filterInput.evaluate(async (input) => {
    const borderLayer = input.parentElement!
    input.blur()
    await new Promise((resolve) => setTimeout(resolve, 200))
    input.focus()
    const samples: Array<{ borderColor: string; filter: string; opacity: number }> = []
    const start = performance.now()
    do {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const focusLayer = getComputedStyle(borderLayer, '::after')
      samples.push({
        borderColor: focusLayer.borderColor,
        filter: focusLayer.filter,
        opacity: Number.parseFloat(focusLayer.opacity)
      })
    } while (performance.now() - start < 200)
    return samples
  })
  expect(refocusPaint.length).toBeGreaterThan(2)
  expect(refocusPaint[0]?.opacity).toBeLessThan(1)
  expect(refocusPaint.at(-1)?.opacity).toBe(1)
  expect(new Set(refocusPaint.map(({ borderColor }) => borderColor)).size).toBe(1)
  expect(new Set(refocusPaint.map(({ filter }) => filter)).size).toBe(1)
  for (let index = 1; index < refocusPaint.length; index += 1) {
    expect(refocusPaint[index]!.opacity).toBeGreaterThanOrEqual(refocusPaint[index - 1]!.opacity)
  }
})

test('dashboard attaches before storage resolves and fills startup surfaces atomically', async ({ page }) => {
  await page.addInitScript(() => {
    const startupCommit = {
      firstContent: null as null | {
        dedupeText: string
        domainCards: number
        headerStats: string
        historyEntries: number
        historyOrder: string[]
      }
    }
    ;(window as typeof window & { __tabOutStartupCommit: typeof startupCommit })
      .__tabOutStartupCommit = startupCommit

    new MutationObserver(() => {
      if (startupCommit.firstContent) return
      const domainCards = document.querySelectorAll('[data-tabout="domain-card"]').length
      const headerStats = document.querySelector('[data-tabout="header-stats"]')?.textContent ?? ''
      const historyRows = Array.from(document.querySelectorAll<HTMLElement>('[data-tabout="activation-history-entry"]'))
      const dedupeText = document.querySelector('[data-tabout="header-stats"] button')?.textContent?.trim() ?? ''
      if (domainCards === 0 && !headerStats.trim() && historyRows.length === 0 && !dedupeText) return
      startupCommit.firstContent = {
        dedupeText,
        domainCards,
        headerStats,
        historyEntries: historyRows.length,
        historyOrder: historyRows.map((row) => row.dataset.taboutLayoutKey ?? '')
      }
    }).observe(document, { childList: true, subtree: true })
  })

  await page.goto('/tests/fixtures/dashboard-resize.html?focusFilter=1&slowInitialStorage=1&staleLegacyStartup=1')
  const filterInput = page.locator('[data-tabout="filter-query"] input')
  await expect(filterInput).toBeFocused()
  await filterInput.fill('early')
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })

  const shellGeometry = await page.evaluate(() => {
    function rect(selector: string) {
      const bounds = document.querySelector(selector)?.getBoundingClientRect()
      if (!bounds) throw new Error(`Missing startup shell landmark: ${selector}`)
      return {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x,
        y: bounds.y
      }
    }
    return {
      filter: rect('[data-tabout="filter-query"]'),
      header: rect('.pinned-top'),
      sourceSwitch: rect('[data-tabout="source-switch"]')
    }
  })

  const pendingState = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-tabout="domain-card"]').length,
    clearVisible: getComputedStyle(document.querySelector<HTMLElement>('[data-tabout-part="clear-button"]')!).display !== 'none',
    headerShadowOpacity: Number(getComputedStyle(document.querySelector<HTMLElement>('.pinned-top')!, '::after').opacity),
    storagePending: (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true
  }))
  expect(pendingState).toMatchObject({
    cards: 0,
    clearVisible: true,
    headerShadowOpacity: 0,
    storagePending: true
  })
  await expect(page.locator('[data-tabout="dashboard-startup-status"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(filterInput).toHaveValue('')

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __tabOutStartupCommit: { firstContent: unknown }
    }).__tabOutStartupCommit.firstContent
  )).not.toBeNull()
  const firstContent = await page.evaluate(() =>
    (window as typeof window & {
      __tabOutStartupCommit: {
          firstContent: {
            dedupeText: string
            domainCards: number
            headerStats: string
            historyEntries: number
            historyOrder: string[]
        }
      }
    }).__tabOutStartupCommit.firstContent
  )
  expect(firstContent.domainCards).toBeGreaterThan(0)
  expect(firstContent.dedupeText).toBe('')
  expect(firstContent.headerStats).toMatch(/\d+(?:\/\d+)? tabs/)
  expect(firstContent.historyEntries).toBeGreaterThan(0)
  expect(await page.locator('[data-tabout="activation-history-entry"]').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.taboutLayoutKey ?? '')
  )).toEqual(firstContent.historyOrder)
  expect(await page.evaluate(() => {
    function rect(selector: string) {
      const bounds = document.querySelector(selector)?.getBoundingClientRect()
      if (!bounds) throw new Error(`Missing filled shell landmark: ${selector}`)
      return {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x,
        y: bounds.y
      }
    }
    return {
      filter: rect('[data-tabout="filter-query"]'),
      header: rect('.pinned-top'),
      sourceSwitch: rect('[data-tabout="source-switch"]')
    }
  })).toEqual(shellGeometry)
})

test('a pre-app filter admits its companion results in the first dynamic frame', async ({ page }) => {
  await page.addInitScript(() => {
    const observed = { firstFrameHasBookmark: null as boolean | null }
    ;(window as typeof window & { __tabOutFilteredStartup: typeof observed })
      .__tabOutFilteredStartup = observed
    new MutationObserver(() => {
      if (observed.firstFrameHasBookmark !== null) return
      if (document.querySelectorAll('[data-tabout="domain-card"]').length === 0) return
      observed.firstFrameHasBookmark = document.querySelector(
        '[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]'
      ) !== null
    }).observe(document, { childList: true, subtree: true })
  })

  await page.goto('/tests/fixtures/dashboard-resize.html?focusFilter=1&filter=Bookmark%201&initialBookmarks=3')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __tabOutFilteredStartup: { firstFrameHasBookmark: boolean | null }
    }).__tabOutFilteredStartup.firstFrameHasBookmark
  )).toBe(true)
})

test('startup coalesces rapid filter input before its browser History read', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?slowInitialStorage=1')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true
  )).toBe(true)

  const filterInput = page.locator('[data-tabout="filter-query"] input')
  await filterInput.fill('a')
  await filterInput.fill('al')
  await filterInput.fill('alp')
  await filterInput.fill('alpha')

  await expect(page.locator('[data-tabout="domain-card"]').first()).toBeVisible()
  expect(await page.evaluate(() =>
    (window as typeof window & { __tabOutSmokeHistorySearchQueries: string[] })
      .__tabOutSmokeHistorySearchQueries
  )).toEqual(['alpha'])
})

test('filter recovery from startup failure stays coalesced before History reads', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?failFirstStartupStorage=1')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true
  )).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === false
  )).toBe(true)
  await expect(page.locator('[data-tabout="dashboard-startup-status"]')).toHaveCount(0)

  const filterInput = page.locator('[data-tabout="filter-query"] input')
  await filterInput.fill('a')
  await filterInput.fill('al')
  await filterInput.fill('alp')
  await filterInput.fill('alpha')

  await expect(page.locator('[data-tabout="domain-card"]').first()).toBeVisible()
  expect(await page.evaluate(() =>
    (window as typeof window & { __tabOutSmokeHistorySearchQueries: string[] })
      .__tabOutSmokeHistorySearchQueries
  )).toEqual(['alpha'])
})

test('startup failure keeps the shell truthful and visually quiet', async ({ page }) => {
  await page.addInitScript(() => {
    const observed = { failureCopySeen: false, retryButtonSeen: false }
    ;(window as typeof window & { __tabOutStartupPresentation: typeof observed })
      .__tabOutStartupPresentation = observed
    new MutationObserver(() => {
      observed.failureCopySeen ||= document.body?.textContent?.includes('Couldn’t load dashboard') === true
      observed.retryButtonSeen ||= document.querySelector('[data-tabout="dashboard-startup-status"] button') !== null
    }).observe(document, { childList: true, subtree: true })
  })
  await page.goto('/tests/fixtures/dashboard-resize.html?failFirstStartupStorage=1')

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true
  )).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === false
  )).toBe(true)
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })

  await expect(page.locator('[data-tabout="dashboard-startup-status"]')).toHaveCount(0)
  await expect(page.locator('[data-tabout="domain-card"]')).toHaveCount(0)
  await expect(page.locator('[data-tabout="activation-history-entry"]')).toHaveCount(0)
  await expect(page.locator('[data-tabout="header-stats"] button')).toHaveCount(0)
  expect(await page.evaluate(() =>
    (window as typeof window & { __tabOutStartupPresentation: { failureCopySeen: boolean, retryButtonSeen: boolean } })
      .__tabOutStartupPresentation
  )).toEqual({ failureCopySeen: false, retryButtonSeen: false })
})

test('a source choice made in the shell selects the admitted startup frame', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?slowInitialStorage=1')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true
  )).toBe(true)
  await page.evaluate(() => {
    ;(window as typeof window & { __tabOutSmokeSetBookmarks?: (count: number) => void })
      .__tabOutSmokeSetBookmarks?.(3)
    const observed = { contentSources: [] as string[] }
    ;(window as typeof window & { __tabOutStartupSourceFrames: typeof observed })
      .__tabOutStartupSourceFrames = observed
    new MutationObserver(() => {
      if (document.querySelectorAll('[data-tabout="domain-card"]').length === 0) return
      const source = document.querySelector<HTMLElement>('[data-tabout="dashboard-shell"]')?.dataset.source ?? ''
      if (source && observed.contentSources.at(-1) !== source) observed.contentSources.push(source)
    }).observe(document.getElementById('appRoot')!, { childList: true, subtree: true })
  })

  const bookmarksSource = page.getByRole('tab', { name: 'Bookmarks' })
  await bookmarksSource.click()
  await expect(bookmarksSource).toHaveAttribute('data-active', '')
  const bookmarkCard = page.locator(
    '[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]'
  )
  await expect(bookmarkCard).toHaveCount(0)

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === false
  )).toBe(true)
  await expect(bookmarkCard).toHaveCount(1)
  expect(await page.evaluate(() =>
    (window as typeof window & {
      __tabOutStartupSourceFrames: { contentSources: string[] }
    }).__tabOutStartupSourceFrames.contentSources
  )).toEqual(['bookmarks'])
})

const RUN_HISTORY_SCROLLBAR_OVERLAP_ONLY = process.env.HISTORY_SCROLLBAR_OVERLAP_ONLY === '1'
const PAGE_CHIP_EXPANSION_SMOKE_LABEL = 'Hover Handoff Title'

function wait(delay: number) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delay))
}

type CdpSession = {
  send(method: string, params?: Record<string, any>): Promise<any>
}

function cdpSessionAdapter(session: CDPSession): CdpSession {
  return {
    send(method, params = {}) {
      return session.send(method as Parameters<CDPSession['send']>[0], params as never)
    }
  }
}

async function evaluateWithNavigationRetry(session: CdpSession, params: Record<string, any>) {
  const deadline = Date.now() + 10000
  let lastError
  while (Date.now() < deadline) {
    try {
      return await session.send('Runtime.evaluate', params)
    } catch (error: any) {
      lastError = error
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) {
        throw error
      }
      await wait(100)
    }
  }
  throw lastError
}

type BrowserConditionOptions<Args extends readonly unknown[]> = {
  args?: Args
  timeoutMs?: number
}

// Predicates run in the page realm; pass Node-side values through args instead of closures.
async function waitForBrowserCondition<Args extends readonly unknown[] = []>(
  session: CdpSession,
  condition: (...args: Args) => boolean,
  description: string,
  options: BrowserConditionOptions<Args> = {}
) {
  const args = options.args ?? ([] as unknown as Args)
  const timeoutMs = options.timeoutMs ?? 2000
  // Runtime.evaluate requires source text, so keep the CDP serialization at this boundary.
  const matched = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const condition = (${condition.toString()})
      const args = ${JSON.stringify(args)}
      const start = Date.now()
      const wait = () => {
        try {
          if (condition(...args)) {
            resolve(true)
            return
          }
        } catch {}
        if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(false)
        } else {
          requestAnimationFrame(wait)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.equal(matched, true, description)
}

async function waitForDashboardSettled(session: CdpSession) {
  await waitForBrowserCondition(
    session,
    () => {
      const containers = Array.from(document.querySelectorAll('.missions:not(.missions-empty)'))
        .filter((container) => container.clientWidth > 0 && container.querySelector('[data-tabout="domain-card"]:not(.closing)'))
      if (containers.length === 0) return false
      const layoutsMatch = containers.every((container) => {
        const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-tabout="domain-card"]:not(.closing)'))
          .filter((card) => window.getComputedStyle(card).display !== 'none')
        if (!container.classList.contains('is-packed') || cards.length === 0 || container.querySelector('.layout-moving')) {
          return false
        }
        const columns = cards.map((card) => Number(card.dataset.masonryCol))
        if (columns.some((column) => !Number.isInteger(column) || column < 0)) return false
        const style = window.getComputedStyle(container)
        const gap = Number.parseFloat(style.getPropertyValue('--masonry-gap')) || 10
        const columnCount = Math.max(...columns) + 1
        const expectedWidth = (container.clientWidth - gap * (columnCount - 1)) / columnCount
        return cards.every((card) => Math.abs(Number.parseFloat(card.style.width) - expectedWidth) <= 1)
      })
      return layoutsMatch
    },
    'dashboard masonry should settle at the requested viewport',
    { timeoutMs: 5000 }
  )
}

async function waitForScrollTop(session: CdpSession, selector: string, expected = 0) {
  await waitForBrowserCondition(
    session,
    (targetSelector: string, targetScrollTop: number) => {
      const scroller = document.querySelector(targetSelector)
      return !!scroller && Math.abs(scroller.scrollTop - targetScrollTop) <= 1
    },
    `${selector} should reach scrollTop ${expected}`,
    { args: [selector, expected] }
  )
}

async function waitForNoPageChipExpansion(session: CdpSession) {
  await waitForBrowserCondition(
    session,
    () => !document.querySelector('.page-chip-expanded'),
    'page chip expansion should close'
  )
}

async function waitForNoHistoryEntryExpansion(session: CdpSession) {
  await waitForBrowserCondition(
    session,
    () => !document.querySelector('.history-entry-expanded'),
    'history entry expansion should close'
  )
}

async function waitForNoVisibleTooltip(session: CdpSession) {
  await waitForBrowserCondition(
    session,
    () => !Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).some((tooltip) => {
      const rect = tooltip.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
    }),
    'visible tooltip should close'
  )
}

async function waitForNoTitleExpansion(session: CdpSession) {
  await Promise.all([
    waitForNoPageChipExpansion(session),
    waitForNoHistoryEntryExpansion(session),
    waitForNoVisibleTooltip(session)
  ])
}

async function waitForContextMenuState(session: CdpSession, open: boolean) {
  await waitForBrowserCondition(
    session,
    (shouldBeOpen: boolean) => {
      const menu = document.querySelector('[data-slot="context-menu-content"]')
      return shouldBeOpen
        ? !!menu && menu.getClientRects().length > 0
        : !menu || menu.getClientRects().length === 0
    },
    `context menu should ${open ? 'open' : 'close'}`,
    { args: [open] }
  )
}

async function waitForFocusUpdates(session: CdpSession) {
  await waitForBrowserCondition(
    session,
    () => {
      const smokeWindow = window as typeof window & {
        __tabOutSmokeFocusUpdates?: Array<{ kind: string }>
      }
      const updates = smokeWindow.__tabOutSmokeFocusUpdates || []
      return updates.some((update) => update.kind === 'tab') &&
        updates.some((update) => update.kind === 'window')
    },
    'tab and window focus updates should complete'
  )
}

async function measureDashboard(session: CdpSession, width: number) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const done = () => {
        const cards = Array.from(document.querySelectorAll('.domain-block'))
        const rects = cards.map((card) => card.getBoundingClientRect()).filter((rect) => rect.width > 0)
        const lefts = Array.from(new Set(rects.map((rect) => Math.round(rect.left))))
        const round = (value) => Math.round(value * 100) / 100
        const sourceSwitchRect = document.querySelector('[data-tabout="source-switch"]')?.getBoundingClientRect()
        const headerControlsRect = document.querySelector('.header-controls')?.getBoundingClientRect()
        const missionsRect = document.querySelector('.missions:not(.missions-empty)')?.getBoundingClientRect()
        resolve({
          cardCount: rects.length,
          columns: lefts.length,
          firstWidth: Math.round(rects[0]?.width || 0),
          headerControlsRight: headerControlsRect ? round(headerControlsRect.right) : null,
          missionsRight: missionsRect ? round(missionsRect.right) : null,
          rootHtmlLength: document.getElementById('appRoot')?.innerHTML.length || 0,
          sourceSwitchRight: sourceSwitchRect ? round(sourceSwitchRect.right) : null,
          errors: window.__tabOutSmokeErrors || []
        })
      }
      const start = Date.now()
      const wait = () => {
        if (document.querySelectorAll('.domain-block').length >= 12) {
          requestAnimationFrame(() => setTimeout(done, 700))
        } else if (Date.now() - start > 5000) {
          done()
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function measureInitialTooltipMeasureNodes(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    returnByValue: true,
      expression: `(() => ({
      pageChipMeasureNodes: document.querySelectorAll('.page-chip-tooltip-measure').length,
      historyExpansionMeasureNodes: document.querySelectorAll('.history-entry-title-expansion-measure').length,
      visibleTooltipNodes: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
      }).length
    }))()`
  }).then((result: any) => result.result.value)
}

async function measureTruncatedTitleTailFill(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve((() => {
      const summarize = (elements) => {
        const truncated = elements.filter((el) => el.querySelector('.clamped-title-line'))
        return {
          truncatedCount: elements.length,
          clampedCount: truncated.length,
          tailOverflows: truncated.every((el) => {
            const rows = el.querySelectorAll('.clamped-title-line')
            const tail = rows[rows.length - 1]
            return rows.length > 1 && tail.scrollWidth > el.clientWidth
          }),
          headsFit: truncated.every((el) => {
            const rows = Array.from(el.querySelectorAll('.clamped-title-line')).slice(0, -1)
            return rows.every((row) => row.scrollWidth <= el.clientWidth + 1)
          })
        }
      }
      const clampedPills = Array.from(document.querySelectorAll('.clamped-title-line .chip-title-suppression-marker'))
      return {
        history: summarize(Array.from(document.querySelectorAll('.history-entry-title.history-entry-title-truncated'))),
        chips: summarize(Array.from(document.querySelectorAll('.chip-text.chip-text-truncated')).filter((el) => (
          !el.closest('.page-chip-expanded') &&
          !el.querySelector('.chip-title-variant-list, .chip-folded-content')
        ))),
        clampedPillCount: clampedPills.length,
        clampedPillsKeepGlyph: clampedPills.every((pill) => !!pill.querySelector('svg.chip-title-suppression-glyph')),
        untruncatedWithClamp: document.querySelectorAll('.history-entry-title:not(.history-entry-title-truncated) .clamped-title-line').length
      }
    })()), 120))))`
  }).then((result: any) => result.result.value)
}

async function measureLargeBookmarkProgressiveRender(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      window.__tabOutSmokeSetBookmarks?.(1008)
      const trigger = Array.from(document.querySelectorAll('[data-tabout-part="source-option"]'))
        .find((candidate) => candidate.textContent?.trim() === 'Bookmarks')
      const start = performance.now()
      let initial = null
      let steady = null
      let lastScrollAt = 0
      const committedSource = () => document.querySelector('[data-tabout="dashboard-shell"]')?.getAttribute('data-source') || ''
      const cardCount = () => document.querySelectorAll('#openTabsMissions .domain-block').length
      const snapshot = () => ({
        count: cardCount(),
        elapsedMs: Math.round(performance.now() - start),
        elementCount: document.querySelectorAll('#openTabsMissions *').length,
        measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length,
        scrollTop: Math.round(document.querySelector('[data-tabout-part="scroll-region"]')?.scrollTop || 0)
      })
      const captureInitialCommit = () => {
        if (initial || committedSource() !== 'bookmarks') return
        const count = cardCount()
        if (count === 0) return
        initial = {
          count,
          elapsedMs: Math.round(performance.now() - start),
          measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length
        }
      }
      const observer = new MutationObserver(captureInitialCommit)
      const appRoot = document.getElementById('appRoot')
      if (appRoot) {
        observer.observe(appRoot, {
          attributes: true,
          attributeFilter: ['data-source'],
          subtree: true
        })
      }
      trigger?.click()
      captureInitialCommit()
      const wait = () => {
        captureInitialCommit()
        const elapsed = performance.now() - start
        const current = snapshot()
        if (initial && !steady && committedSource() === 'bookmarks' && elapsed >= 1200) {
          steady = current
        }
        if (steady && current.count < 1008 && elapsed - lastScrollAt >= 40) {
          const scrollRegion = document.querySelector('[data-tabout-part="scroll-region"]')
          if (scrollRegion) scrollRegion.scrollTop = scrollRegion.scrollHeight
          lastScrollAt = elapsed
        }
        if (initial && steady && committedSource() === 'bookmarks' && current.count >= 1008) {
          observer.disconnect()
          resolve({
            initial,
            steady,
            final: current
          })
          return
        }
        if (elapsed > 12000) {
          observer.disconnect()
          resolve({
            initial,
            steady,
            final: current
          })
          return
        }
        setTimeout(wait, 16)
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function measureHorizontalScrollLock(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const scrollRegion = document.querySelector('.scroll-region')
        const rect = scrollRegion?.getBoundingClientRect()
        if (scrollRegion && rect && rect.width > 0 && rect.height > 0) {
          const probe = document.createElement('div')
          probe.dataset.scrollLockProbe = 'true'
          probe.style.cssText = 'display:block;width:200vw;height:1px;pointer-events:none;'
          scrollRegion.append(probe)
          scrollRegion.scrollTo(0, 0)
          requestAnimationFrame(() => {
            const styles = window.getComputedStyle(scrollRegion)
            resolve({
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + Math.min(Math.max(rect.height / 2, 48), rect.height - 8)),
              initialScrollLeft: scrollRegion.scrollLeft,
              scrollWidth: scrollRegion.scrollWidth,
              clientWidth: scrollRegion.clientWidth,
              overflowX: styles.overflowX,
              overscrollBehaviorX: styles.overscrollBehaviorX
            })
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a scroll region for horizontal scroll lock smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: target.x,
    y: target.y,
    deltaX: 220,
    deltaY: 0
  })
  await wait(160)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const scrollRegion = document.querySelector('.scroll-region')
      const probe = scrollRegion?.querySelector('[data-scroll-lock-probe="true"]')
      const result = {
        scrollLeft: scrollRegion?.scrollLeft ?? null,
        scrollWidth: scrollRegion?.scrollWidth ?? 0,
        clientWidth: scrollRegion?.clientWidth ?? 0
      }
      probe?.remove()
      return result
    })()`
  }).then((result: any) => result.result.value)

  return { ...target, afterScrollLeft: after.scrollLeft, afterScrollWidth: after.scrollWidth, afterClientWidth: after.clientWidth }
}

async function waitForTooltipRect(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const tooltip = document.querySelector('[data-slot="tooltip-content"]')
        const rect = tooltip?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          const tooltipText = tooltip.querySelector('.chip-text') || tooltip.querySelector('.history-entry-title-tooltip')
          const textRect = tooltipText?.getBoundingClientRect()
          const textStyles = tooltipText ? window.getComputedStyle(tooltipText) : null
          const textLineHeight = Number.parseFloat(textStyles?.lineHeight || '') || null
          const lineNodes = Array.from(tooltipText?.querySelectorAll('.page-chip-tooltip-line, .history-entry-title-tooltip-line') || [])
          const tooltipLineTexts = lineNodes.length > 0
            ? lineNodes.map((node) => node.textContent || '')
            : [tooltipText?.textContent || '']
          const styles = window.getComputedStyle(tooltip)
          const outlineWidth = Number.parseFloat(styles.outlineWidth) || 0
          resolve({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            visualLeft: Math.round(rect.left - outlineWidth),
            visualRight: Math.round(rect.right + outlineWidth),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            textLeft: textRect ? Math.round(textRect.left * 100) / 100 : null,
            textTop: textRect ? Math.round(textRect.top * 100) / 100 : null,
            textWidth: textRect ? Math.round(textRect.width * 100) / 100 : null,
            textHeight: textRect ? Math.round(textRect.height * 100) / 100 : null,
            textLineHeight,
            text: tooltip.textContent || '',
            tooltipLineCount: textRect && textLineHeight ? Math.max(1, Math.round(textRect.height / textLineHeight)) : null,
            tooltipLineTexts,
            outlineWidth,
            side: tooltip.getAttribute('data-side'),
            align: tooltip.getAttribute('data-align'),
            topLeftRadius: styles.borderTopLeftRadius,
            topRightRadius: styles.borderTopRightRadius,
            transitionDuration: styles.transitionDuration,
            transitionProperty: styles.transitionProperty,
            webkitLineClamp: textStyles?.webkitLineClamp || null,
            svgCount: tooltip.querySelectorAll('svg').length,
            viewportRight: window.innerWidth
          })
        } else if (Date.now() - start > 2000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

const MARKER_WRAP_REFLOW_SMOKE_LABEL = 'Content: All content overview'

/**
 * Marker-wrap smoke: a path-group chip whose resting title wraps around
 * compact suppression/placeholder pills. Multi-line resting chips reveal in
 * place (pills hydrate on their resting lines); single-line resting chips
 * whose hydrated reveal exceeds the viewport allowance wrap at the packed
 * allowance instead of the resting width, so a pill starts a continuation
 * line only when the previous line has no room for it.
 */
async function measureMarkerWrapExpansionReflow(session: CdpSession, options: { forcedTextWidth?: number; viewportWidth?: number } = {}) {
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddMarkerWrapPathGroupTabs?.()`
  })
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewportWidth || 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      let forceSettled = false
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('.page-chip-expanded') &&
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(MARKER_WRAP_REFLOW_SMOKE_LABEL)})
          )
        if (!(chipText instanceof HTMLElement) || chipText.closest('.page-chips-overflow')) {
          // The crowded contentful card can tuck this path group behind an
          // overflow whose Page Chips are not mounted until it is expanded.
          const card = document.querySelector('[data-tabout="domain-card"][data-tabout-domain="contentful.com"]')
          const toggles = card?.querySelectorAll('[data-tabout-part="overflow-expander"]') ?? []
          if (toggles.length > 0) {
            toggles.forEach((toggle) => toggle.click())
            setTimeout(wait, 300)
            return
          }
        }
        if (chipText instanceof HTMLElement && !forceSettled) {
          const forcedTextWidth = ${JSON.stringify(options.forcedTextWidth || 0)}
          chipText.style.flex = forcedTextWidth ? '0 0 ' + forcedTextWidth + 'px' : ''
          chipText.style.maxWidth = forcedTextWidth ? forcedTextWidth + 'px' : ''
          // Forced geometry changes re-run the clamped-title capture; let it
          // settle before reading line counts (see the tooltip helper above).
          forceSettled = true
          setTimeout(wait, 160)
          return
        }
        const rect = chipText?.getBoundingClientRect()
        if (
          chipText instanceof HTMLElement &&
          rect &&
          (rect.top < 24 || rect.bottom > window.innerHeight - 24)
        ) {
          chipText.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (chipText instanceof HTMLElement && rect && rect.width > 80 && rect.height > 8) {
          const styles = window.getComputedStyle(chipText)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
            chipLineCount: Math.max(1, Math.round(rect.height / lineHeight)),
            suppressionPillCount: chipText.querySelectorAll('.chip-title-suppression-marker').length,
            labeledPlaceholderCount: chipText.querySelectorAll('.chip-strip-indicator[aria-label]').length,
            pillLines: Array.from(chipText.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator[aria-label]')).map((pill) => {
              const pillRect = pill.getBoundingClientRect()
              return Math.round((pillRect.top - rect.top) / lineHeight)
            })
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  if (!target) return { target, expansion: null }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await waitForPageChipExpansionRect(session, MARKER_WRAP_REFLOW_SMOKE_LABEL)

  const expansion = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(MARKER_WRAP_REFLOW_SMOKE_LABEL)}))
      const textEl = chip?.querySelector('.chip-text')
      if (!(chip instanceof HTMLElement) || !(textEl instanceof HTMLElement)) return null

      const paintedContentRight = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
          }
        })
        const range = document.createRange()
        let maxRight = 0
        while (true) {
          const node = walker.nextNode()
          if (!node) break
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (rect.width > 0) maxRight = Math.max(maxRight, rect.right)
          }
        }
        for (const pill of root.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator')) {
          const rect = pill.getBoundingClientRect()
          if (rect.width > 0) maxRight = Math.max(maxRight, rect.right)
        }
        return maxRight
      }

      const lines = Array.from(chip.querySelectorAll('.page-chip-expanded-line'))
      const lineContentRights = lines.map((line) => Math.round(paintedContentRight(line) * 100) / 100)
      const viewportAllowanceRight = window.innerWidth - 12
      const textRect = textEl.getBoundingClientRect()
      const lineHeight = Number.parseFloat(window.getComputedStyle(textEl).lineHeight) || 16.25
      const pills = Array.from(textEl.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator[aria-label]')).map((pill) => {
        const rect = pill.getBoundingClientRect()
        const lineIndex = lines.findIndex((line) => line.contains(pill))
        const line = lineIndex >= 0 ? lines[lineIndex] : null
        const startsLine = !!line && rect.left - line.getBoundingClientRect().left <= 2
        const previousLineFreeRoom = lineIndex > 0
          ? Math.round((viewportAllowanceRight - lineContentRights[lineIndex - 1]) * 100) / 100
          : 0
        return {
          text: pill.textContent || '',
          width: Math.round(rect.width * 100) / 100,
          lineIndex,
          visualLine: Math.round((rect.top - textRect.top) / lineHeight),
          startsLine,
          previousLineFreeRoom
        }
      })
      const strandedPills = pills.filter((pill) => (
        pill.lineIndex > 0 && pill.startsLine && pill.previousLineFreeRoom >= pill.width + 6
      ))
      return {
        text: textEl.textContent || '',
        expandedLineCount: lines.length,
        lineTexts: lines.map((line) => line.textContent || ''),
        lineContentRights,
        innerWidth: window.innerWidth,
        pills,
        strandedPills
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await waitForNoPageChipExpansion(session)

  return { target, expansion }
}

const MARKER_ONLY_LINE_SMOKE_LABEL = 'Platform Ops Dev 2026'

/**
 * Marker-only-line stability smoke: a chip whose resting layout puts a
 * trailing suppression pill ALONE on a middle line (title fills line 1, the
 * nowrap URL suffix wraps to line 3). Hydrating that pill displaces nothing
 * on its line, so the expansion must keep it anchored on the same visible
 * line instead of reflowing it up into the title line.
 */
async function measureMarkerOnlyLineExpansion(session: CdpSession) {
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddMarkerWrapPathGroupTabs?.()`
  })
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      let forceSettled = false
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('.page-chip-expanded') &&
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(MARKER_ONLY_LINE_SMOKE_LABEL)}) &&
            candidate.textContent?.includes('assignee')
          )
        if (!(chipText instanceof HTMLElement) || chipText.closest('.page-chips-overflow')) {
          const card = document.querySelector('[data-tabout="domain-card"][data-tabout-domain="atlassian.net"]')
          const toggles = card?.querySelectorAll('[data-tabout-part="overflow-expander"]') ?? []
          if (toggles.length > 0) {
            toggles.forEach((toggle) => toggle.click())
            setTimeout(wait, 300)
            return
          }
        }
        if (chipText instanceof HTMLElement && !forceSettled) {
          chipText.style.flex = '0 0 276px'
          chipText.style.maxWidth = '276px'
          forceSettled = true
          setTimeout(wait, 160)
          return
        }
        const rect = chipText?.getBoundingClientRect()
        if (
          chipText instanceof HTMLElement &&
          rect &&
          (rect.top < 24 || rect.bottom > window.innerHeight - 24)
        ) {
          chipText.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (chipText instanceof HTMLElement && rect && rect.width > 80 && rect.height > 8) {
          const styles = window.getComputedStyle(chipText)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          const marker = chipText.querySelector('.chip-title-suppression-marker')
          const markerRect = marker?.getBoundingClientRect()
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
            chipLineCount: Math.max(1, Math.round(rect.height / lineHeight)),
            markerLine: markerRect ? Math.round((markerRect.top - rect.top) / lineHeight) : null,
            markerLeftOffset: markerRect ? Math.round(markerRect.left - rect.left) : null
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  if (!target) return { target, expansion: null }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await waitForPageChipExpansionRect(session, MARKER_ONLY_LINE_SMOKE_LABEL)

  const expansion = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(MARKER_ONLY_LINE_SMOKE_LABEL)}))
      const textEl = chip?.querySelector('.chip-text')
      if (!(chip instanceof HTMLElement) || !(textEl instanceof HTMLElement)) return null
      const textRect = textEl.getBoundingClientRect()
      const lineHeight = Number.parseFloat(window.getComputedStyle(textEl).lineHeight) || 16.25
      const marker = textEl.querySelector('.chip-title-suppression-marker')
      const markerRect = marker?.getBoundingClientRect()
      return {
        markerLine: markerRect ? Math.round((markerRect.top - textRect.top) / lineHeight) : null,
        markerText: marker?.textContent || '',
        visualLineCount: Math.max(1, Math.round(textRect.height / lineHeight)),
        text: (textEl.textContent || '').slice(0, 160)
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await waitForNoPageChipExpansion(session)

  return { target, expansion }
}

const VARIANT_TITLE_ROW_SMOKE_LABEL = 'Skills for Real Engineers'

/**
 * Variant-group title-row stability smoke: the merged same-title chip's
 * title row starts with a labeled structural indicator and rests as two
 * lines. Hydrating the indicator label must widen line 1 in place — the
 * second line's text stays on the second line instead of reflowing up.
 */
async function measureVariantTitleRowStability(session: CdpSession) {
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddMarkerWrapPathGroupTabs?.()`
  })
  // Wide viewport: the hydrated indicator label needs rightward room on its
  // frozen first line wherever the masonry parks this card; the scenario
  // pins line stability, not the viewport-constrained wrap.
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const probeExpression = (mode: 'rest' | 'expanded') => `new Promise((resolve) => {
    const start = Date.now()
    let forceSettled = ${JSON.stringify(mode === 'expanded')}
    const wait = () => {
      const root = ${mode === 'rest'
        ? `Array.from(document.querySelectorAll('.page-chip:not(.page-chip-expanded) .chip-title-row'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(VARIANT_TITLE_ROW_SMOKE_LABEL)}))`
        : `Array.from(document.querySelectorAll('.page-chip-expanded .chip-title-row'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(VARIANT_TITLE_ROW_SMOKE_LABEL)}))`}
      const chipText = root?.closest('.chip-text')
      if (root instanceof HTMLElement && chipText instanceof HTMLElement && !forceSettled) {
        chipText.style.flex = '0 0 260px'
        chipText.style.maxWidth = '260px'
        forceSettled = true
        setTimeout(wait, 160)
        return
      }
      const rect = root?.getBoundingClientRect()
      if (root instanceof HTMLElement && rect && (rect.top < 24 || rect.bottom > window.innerHeight - 24)) {
        root.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(wait, 120)
        return
      }
      if (root instanceof HTMLElement && rect && rect.width > 80 && rect.height > 8) {
        const lineHeight = Number.parseFloat(window.getComputedStyle(root).lineHeight) || 16.25
        const indicator = root.querySelector('.chip-strip-indicator')
        const indicatorRect = indicator?.getBoundingClientRect()
        // Bionic rendering splits words across text nodes, so bucket painted
        // characters into visual lines and find the anchor phrase per line.
        const lineTexts = []
        const range = document.createRange()
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
          }
        })
        while (true) {
          const node = walker.nextNode()
          if (!node) break
          const text = node.textContent || ''
          for (let offset = 0; offset < text.length; offset += 1) {
            range.setStart(node, offset)
            range.setEnd(node, offset + 1)
            const rects = Array.from(range.getClientRects()).filter((candidate) => candidate.width > 0 || candidate.height > 0)
            const charRect = rects.at(-1)
            if (!charRect) continue
            const line = Math.max(0, Math.round((charRect.top - rect.top) / lineHeight))
            lineTexts[line] = (lineTexts[line] || '') + text[offset]
          }
        }
        resolve({
          x: Math.round(rect.left + Math.min(24, rect.width / 2)),
          y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
          titleRowLines: Math.max(1, Math.round(rect.height / lineHeight)),
          indicatorLine: indicatorRect ? Math.round((indicatorRect.top - rect.top) / lineHeight) : null,
          indicatorText: (indicator?.textContent || '').slice(0, 40),
          anchorLine: lineTexts.findIndex((text) => (text || '').includes('from my'))
        })
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(wait, 50)
      }
    }
    wait()
  })`

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: probeExpression('rest')
  }).then((result: any) => result.result.value)

  if (!target) return { target, expansion: null }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await waitForPageChipExpansionRect(session, VARIANT_TITLE_ROW_SMOKE_LABEL)

  const expansion = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: probeExpression('expanded')
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await waitForNoPageChipExpansion(session)

  return { target, expansion }
}

async function waitForPageChipExpansionRect(session: CdpSession, text: string, timeoutMs = 2000) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}))
        const rect = chip?.getBoundingClientRect()
        const chipText = chip?.querySelector('.chip-text')
        const textRect = chipText?.getBoundingClientRect()
        if (chip instanceof HTMLElement && rect && chipText && textRect && rect.width > 0 && rect.height > 0) {
          const styles = window.getComputedStyle(chipText)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          resolve({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            textLeft: Math.round(textRect.left * 100) / 100,
            textTop: Math.round(textRect.top * 100) / 100,
            textWidth: Math.round(textRect.width * 100) / 100,
            textHeight: Math.round(textRect.height * 100) / 100,
            textLineHeight: Math.round(lineHeight * 100) / 100,
            textLineCount: Math.max(1, Math.round(textRect.height / lineHeight)),
            text: chip.textContent || '',
            visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
              const tooltipRect = tooltip.getBoundingClientRect()
              return tooltipRect.width > 0 && tooltipRect.height > 0 && !tooltip.hasAttribute('data-ending-style')
            }).length,
            viewportRight: window.innerWidth
          })
        } else if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function waitForHistoryEntryExpansionRect(session: CdpSession, text: string, timeoutMs = 2000) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}))
        const rect = entry?.getBoundingClientRect()
        const title = entry?.querySelector('.history-entry-title')
        const titleRect = title?.getBoundingClientRect()
        if (entry instanceof HTMLElement && rect && title instanceof HTMLElement && titleRect && rect.width > 0 && rect.height > 0) {
          const styles = window.getComputedStyle(title)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          const lineNodes = Array.from(title.querySelectorAll('.history-entry-expanded-line'))
          const expandedLineTexts = lineNodes.length > 0
            ? lineNodes.map((node) => node.textContent || '')
            : [title.textContent || '']
          const expandedLineOverflows = lineNodes.map((node) => node.scrollWidth - node.clientWidth > 1)
          resolve({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            titleLeft: Math.round(titleRect.left * 100) / 100,
            titleTop: Math.round(titleRect.top * 100) / 100,
            titleWidth: Math.round(titleRect.width * 100) / 100,
            titleHeight: Math.round(titleRect.height * 100) / 100,
            titleLineHeight: Math.round(lineHeight * 100) / 100,
            expandedLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
            expandedLineTexts,
            expandedLineOverflows,
            text: entry.textContent || '',
            visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
              const tooltipRect = tooltip.getBoundingClientRect()
              return tooltipRect.width > 0 && tooltipRect.height > 0 && !tooltip.hasAttribute('data-ending-style')
            }).length,
            viewportRight: window.innerWidth,
            webkitLineClamp: styles.webkitLineClamp || null
          })
        } else if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function waitForHistoryScrollbarThumbOpacity(session: CdpSession, opacity: string, timeoutMs = 1000) {
  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const thumb = document.querySelector('.history-entry-scrollbar-thumb')
        if (thumb && window.getComputedStyle(thumb).opacity === ${JSON.stringify(opacity)}) {
          resolve(true)
        } else if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(false)
        } else {
          requestAnimationFrame(wait)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

async function getVisibleTooltipTexts(session: CdpSession) {
  return evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .filter((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
      })
      .map((tooltip) => tooltip.textContent || '')`
  }).then((result: any) => result.result.value)
}

async function measureTooltipFreeze(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          const startX = Math.round(rect.left + Math.min(24, rect.width / 2))
          const y = Math.round(rect.top + rect.height / 2)
          resolve({
            startX,
            moveX: Math.round(Math.min(rect.right - 8, startX + 80)),
            textLeft: Math.round(rect.left),
            textLeftExact: Math.round(rect.left * 100) / 100,
            textRight: Math.round(rect.right),
            textTop: Math.round(rect.top),
            textTopExact: Math.round(rect.top * 100) / 100,
            y
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for tooltip smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.moveX,
    y: target.y
  })
  await wait(150)
  const second = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollBy(0, 160)`
  })
  await waitForNoPageChipExpansion(session)
  const afterScrollExpandedCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-expanded').length`
  }).then((result: any) => result.result.value)

  return { target, first, second, afterScrollExpandedCount, closing: null }
}

async function measureTooltipTextPaddingHitArea(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const hitArea = Array.from(document.querySelectorAll('.chip-text-expansion-hit-area'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text')
          )
        const chip = hitArea?.closest('.page-chip')
        const chipText = hitArea?.querySelector('.chip-text-truncated')
        const chipRect = chip?.getBoundingClientRect()
        const hitRect = hitArea?.getBoundingClientRect()
        const textRect = chipText?.getBoundingClientRect()
        if (
          chipRect &&
          hitRect &&
          textRect &&
          chipRect.left + 2 < hitRect.left - 1 &&
          hitRect.width > 120 &&
          textRect.width > 120 &&
          hitRect.top < textRect.top &&
          hitRect.bottom > textRect.bottom
        ) {
          const topGap = textRect.top - hitRect.top
          const bottomGap = hitRect.bottom - textRect.bottom
          resolve({
            x: Math.round(textRect.left + Math.min(24, textRect.width / 2)),
            aboveY: Math.round(textRect.top - Math.max(1, topGap / 2)),
            belowY: Math.round(textRect.bottom + Math.max(1, bottomGap / 2)),
            chipSurfaceX: Math.round(chipRect.left + Math.max(2, (hitRect.left - chipRect.left) / 2)),
            chipSurfaceY: Math.round(textRect.top + Math.min(textRect.height / 2, 10)),
            chipLeft: Math.round(chipRect.left),
            chipRight: Math.round(chipRect.right),
            hitTop: Math.round(hitRect.top),
            hitBottom: Math.round(hitRect.bottom),
            hitLeft: Math.round(hitRect.left),
            textLeft: Math.round(textRect.left),
            textLeftExact: Math.round(textRect.left * 100) / 100,
            textTop: Math.round(textRect.top),
            textTopExact: Math.round(textRect.top * 100) / 100,
            textBottom: Math.round(textRect.bottom)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip expansion hit area for padding hover smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY
  })
  const above = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.belowY
  })
  const below = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.chipSurfaceX,
    y: target.chipSurfaceY
  })
  const chipSurface = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, above, below, chipSurface }
}

async function measurePageChipInternalPointerMoveExpansion(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes('enough tooltip text'))
        const chipText = chip?.querySelector('.chip-text-truncated')
        const chipRect = chip?.getBoundingClientRect()
        const textRect = chipText?.getBoundingClientRect()
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          textRect &&
          chipRect.left + 2 < textRect.left - 1 &&
          textRect.width > 120 &&
          textRect.height > 8
        ) {
          resolve({
            x: Math.round(chipRect.left + Math.max(2, (textRect.left - chipRect.left) / 2)),
            y: Math.round(textRect.top + Math.min(textRect.height / 2, 10)),
            chipLeft: Math.round(chipRect.left),
            chipRight: Math.round(chipRect.right),
            textLeft: Math.round(textRect.left),
            textTopExact: Math.round(textRect.top * 100) / 100
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip with left-side internal hover surface')

  const before = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-expanded').length`
  }).then((result: any) => result.result.value)

  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes('enough tooltip text'))
      chip?.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: ${target.x},
        clientY: ${target.y},
        pointerId: 1,
        pointerType: 'mouse'
      }))
    })()`
  })
  const expansion = await waitForPageChipExpansionRect(session, 'enough tooltip text')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, before, expansion }
}

async function measureTooltipAfterActiveStateChanges(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })

  async function setActiveTab(tabId: number, windowId = 1) {
    await evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      expression: `window.__tabOutSmokeSetActiveTab?.(${tabId}, ${windowId})`
    })
    await evaluateWithNavigationRetry(session, {
      expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
    })
    await waitForDashboardSettled(session)
  }

  async function findTarget() {
    return evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const start = Date.now()
        const wait = () => {
          const chip = Array.from(document.querySelectorAll('.page-chip'))
            .find((candidate) =>
              candidate.textContent?.includes('Example 2 with enough tooltip text')
            )
          const chipText = chip?.querySelector('.chip-text-truncated')
          const rect = chipText?.getBoundingClientRect()
          if (chip && rect && rect.width > 120 && rect.height > 8) {
            resolve({
              activeFrame: !!chip.querySelector('.active-chip-frame'),
              currentActive: chip.classList.contains('current-active-chip'),
              x: Math.round(rect.left + Math.min(24, rect.width / 2)),
              y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
              textLeftExact: Math.round(rect.left * 100) / 100,
              textTopExact: Math.round(rect.top * 100) / 100
            })
          } else if (Date.now() - start > 5000) {
            resolve(null)
          } else {
            setTimeout(wait, 50)
          }
        }
        wait()
      })`
    }).then((result: any) => result.result.value)
  }

  async function hoverTarget(target: { x: number; y: number }) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x,
      y: target.y
    })
    const tooltip = await waitForPageChipExpansionRect(session, 'Example 2 with enough tooltip text')
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8
    })
    await waitForNoPageChipExpansion(session)
    return tooltip
  }

  await setActiveTab(2, 2)
  const activeTarget = await findTarget()
  assert.ok(activeTarget, 'expected active-state tooltip target')
  const activeTooltip = await hoverTarget(activeTarget)

  await setActiveTab(1)
  const inactiveTarget = await findTarget()
  assert.ok(inactiveTarget, 'expected inactive-state tooltip target')
  const inactiveTooltip = await hoverTarget(inactiveTarget)

  return { activeTarget, activeTooltip, inactiveTarget, inactiveTooltip }
}

async function measureSuppressionMarkerTooltipLine(session: CdpSession, label: string) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10))
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a title-suppression page chip for ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await waitForPageChipExpansionRect(session, label)

  const result = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const expandedChip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
      const expandedText = expandedChip?.querySelector('.chip-text')
      const marker = expandedChip?.querySelector('.chip-title-suppression-marker')
      const tooltipRect = expandedChip?.getBoundingClientRect()
      const textRect = expandedText?.getBoundingClientRect()
      const markerRect = marker?.getBoundingClientRect()
      if (!expandedChip || !expandedText || !marker || !tooltipRect || !textRect || !markerRect) return null

      const textStyles = window.getComputedStyle(expandedText)
      const markerStyles = window.getComputedStyle(marker)
      const lineHeight = Number.parseFloat(textStyles.lineHeight) || 16.25
      const markerLine = Math.round((markerRect.top - textRect.top) / lineHeight) + 1
      const lineTop = textRect.top + (markerLine - 1) * lineHeight
      const markerCenter = markerRect.top + markerRect.height / 2
      const lineCenter = lineTop + lineHeight / 2

      return {
        label: ${JSON.stringify(label)},
        text: expandedChip.textContent || '',
        markerLine,
        markerCenterDelta: Math.round((markerCenter - lineCenter) * 100) / 100,
        markerHeight: Math.round(markerRect.height * 100) / 100,
        markerLineHeight: markerStyles.lineHeight,
        markerVerticalAlign: markerStyles.verticalAlign,
        textLineHeight: Math.round(lineHeight * 100) / 100,
        tooltipRight: Math.round(tooltipRect.right),
        viewportRight: window.innerWidth,
        tooltipTop: Math.round(tooltipRect.top),
        textTop: Math.round(textRect.top),
        markerTop: Math.round(markerRect.top)
      }
    })()`
  }).then((measurement: any) => measurement.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, result }
}

async function measureSuppressionMarkerChipLine(session: CdpSession, label: string) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const result = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        const marker = chipText?.querySelector('.chip-title-suppression-marker')
        const glyph = marker?.querySelector('.chip-title-suppression-glyph')
        const textRect = chipText?.getBoundingClientRect()
        const markerRect = marker?.getBoundingClientRect()
        const glyphRect = glyph?.getBoundingClientRect()
        if (chipText && marker && glyph && textRect && markerRect && glyphRect && textRect.width > 120 && textRect.height > 8) {
          const textStyles = window.getComputedStyle(chipText)
          const markerStyles = window.getComputedStyle(marker)
          const lineHeight = Number.parseFloat(textStyles.lineHeight) || 16.25
          const markerLine = Math.round((markerRect.top - textRect.top) / lineHeight) + 1
          const lineTop = textRect.top + (markerLine - 1) * lineHeight
          const markerCenter = markerRect.top + markerRect.height / 2
          const glyphCenter = glyphRect.top + glyphRect.height / 2
          const lineCenter = lineTop + lineHeight / 2
          resolve({
            label: ${JSON.stringify(label)},
            text: chipText.textContent || '',
            markerLine,
            markerCenterDelta: Math.round((markerCenter - lineCenter) * 100) / 100,
            glyphCenterDelta: Math.round((glyphCenter - markerCenter) * 100) / 100,
            markerHeight: Math.round(markerRect.height * 100) / 100,
            glyphHeight: Math.round(glyphRect.height * 100) / 100,
            markerLineHeight: markerStyles.lineHeight,
            markerVerticalAlign: markerStyles.verticalAlign,
            textLineHeight: Math.round(lineHeight * 100) / 100,
            textTop: Math.round(textRect.top),
            markerTop: Math.round(markerRect.top)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((measurement: any) => measurement.result.value)

  return { result }
}

async function measureSuppressionTokenCloseHighlight(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1420,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const token = Array.from(document.querySelectorAll('.title-suppression-token'))
          .find((el) => (el.textContent || '').trim().startsWith('— Shared Workspace'))
        if (token instanceof HTMLElement) {
          token.scrollIntoView({ block: 'center' })
          const rect = token.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            resolve({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })
            return
          }
        }
        if (Date.now() - start > 5000) resolve(null)
        else setTimeout(wait, 50)
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a "— Shared Workspace" title-suppression token for the close-highlight smoke test')

  const readHighlightedChips = () => evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-suppression-highlighted').length`
  }).then((result: any) => result.result.value)

  const baseline = await readHighlightedChips()

  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await wait(150)
  const onHover = await readHighlightedChips()

  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, x: target.x, y: target.y })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, x: target.x, y: target.y })
  await waitForContextMenuState(session, true)

  const onRightClick = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const menu = document.querySelector('[data-slot="context-menu-content"]')
      return {
        highlightedChips: document.querySelectorAll('.page-chip-suppression-highlighted').length,
        menuOpen: !!menu && menu.getClientRects().length > 0,
        itemTexts: Array.from(document.querySelectorAll('[data-slot="context-menu-item"]')).map((item) => (item.textContent || '').trim())
      }
    })()`
  }).then((result: any) => result.result.value)

  // Close the menu by clicking elsewhere with the mouse (away from the menu). Base UI
  // restores focus to the token on close; the highlight must still clear because that
  // restored focus is not :focus-visible (mouse modality), so onFocus does not re-arm it.
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 860 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: 8, y: 860 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: 8, y: 860 })
  await waitForContextMenuState(session, false)

  const afterClickAway = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => ({
      menuOpen: !!document.querySelector('[data-slot="context-menu-content"]'),
      highlightedChips: document.querySelectorAll('.page-chip-suppression-highlighted').length,
      activeIsToken: !!(document.activeElement && document.activeElement.classList.contains('title-suppression-token'))
    }))()`
  }).then((result: any) => result.result.value)

  // Park the pointer away so later smoke measurements start clean.
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 })
  await wait(150)

  return { baseline, onHover, onRightClick, afterClickAway }
}

async function measurePageChipTooltipLineCount(
  session: CdpSession,
  label: string,
  options: { forcedTextWidth?: number; forcedMaxLines?: number; hoverWaitMs?: number; viewportWidth?: number } = {}
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewportWidth || 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      let forceSettled = false
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        if (${JSON.stringify(!!options.forcedTextWidth)} && chipText instanceof HTMLElement) {
          chipText.style.flex = '0 0 ${options.forcedTextWidth || 0}px'
          chipText.style.maxWidth = '${options.forcedTextWidth || 0}px'
        }
        if (${JSON.stringify(!!options.forcedMaxLines)} && chipText instanceof HTMLElement) {
          chipText.style.maxHeight = 'calc(${options.forcedMaxLines || 1}lh)'
        }
        if (${JSON.stringify(!!(options.forcedTextWidth || options.forcedMaxLines))} && !forceSettled) {
          // Forced geometry changes re-run the clamped-title capture (observer
          // -> invalidate -> re-capture); give it a couple frames to settle
          // before reading line counts.
          forceSettled = true
          setTimeout(wait, 160)
          return
        }
        const rect = chipText?.getBoundingClientRect()
        if (
          chipText instanceof HTMLElement &&
          rect &&
          (rect.top < 24 || rect.bottom > window.innerHeight - 24)
        ) {
          chipText.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (chipText && rect && rect.width > 80 && rect.height > 8) {
          const styles = window.getComputedStyle(chipText)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          const chipLineCount = Math.max(1, Math.round(rect.height / lineHeight))
          const collectLineTexts = (root, limit) => {
            const rootRect = root.getBoundingClientRect()
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
              }
            })
            const range = document.createRange()
            const lines = Array.from({ length: limit }, () => '')
            while (true) {
              const node = walker.nextNode()
              if (!node) break
              const text = node.textContent || ''
              for (let offset = 0; offset < text.length; offset += 1) {
                range.setStart(node, offset)
                range.setEnd(node, offset + 1)
                const rects = Array.from(range.getClientRects())
                const paintedRects = rects.filter((candidate) => candidate.width > 0 || candidate.height > 0)
                const charRect = paintedRects.at(-1)
                if (!charRect) continue
                const lineIndex = Math.max(0, Math.round((charRect.top - rootRect.top) / lineHeight))
                if (lineIndex >= limit) return lines
                lines[lineIndex] += text[offset]
              }
            }
            return lines
          }
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
            chipText: chipText.textContent || '',
            chipLineTexts: collectLineTexts(chipText, chipLineCount),
            chipLeft: Math.round(rect.left),
            chipLeftExact: Math.round(rect.left * 100) / 100,
            chipTop: Math.round(rect.top),
            chipTopExact: Math.round(rect.top * 100) / 100,
            chipWidth: Math.round(rect.width),
            chipHeight: Math.round(rect.height),
            chipLineHeight: Math.round(lineHeight * 100) / 100,
            chipLineCount
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a page chip for tooltip line-count check: ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  if (options.hoverWaitMs === undefined) {
    await waitForPageChipExpansionRect(session, label)
  } else {
    await wait(options.hoverWaitMs)
  }

  const tooltip = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
      const tooltipText = tooltip?.querySelector('.chip-text')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const textRect = tooltipText?.getBoundingClientRect()
      if (!(tooltip instanceof HTMLElement) || !(tooltipText instanceof HTMLElement) || !tooltipRect || !textRect) return null
      const styles = window.getComputedStyle(tooltipText)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
      const lineNodes = Array.from(tooltipText.querySelectorAll('.page-chip-expanded-line'))
      const tooltipLineTexts = lineNodes.length > 0
        ? lineNodes.map((node) => node.textContent || '')
        : [tooltipText.textContent || '']
      const tooltipLineOverflows = lineNodes.map((node) => {
        const nodeRect = node.getBoundingClientRect()
        const range = document.createRange()
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode(textNode) {
            return textNode.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
          }
        })
        try {
          if (node.scrollWidth - node.clientWidth > 1) return true
          while (true) {
            const textNode = walker.nextNode()
            if (!textNode) break
            range.selectNodeContents(textNode)
            for (const rect of range.getClientRects()) {
              if (rect.width > 0 && rect.right - nodeRect.right > 1) return true
            }
          }
          return false
        } finally {
          range.detach()
        }
      })
      return {
        text: tooltip.textContent || '',
        tooltipLineTexts,
        tooltipLineOverflows,
        visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length,
        left: Math.round(tooltipRect.left),
        right: Math.round(tooltipRect.right),
        top: Math.round(tooltipRect.top),
        width: Math.round(tooltipRect.width),
        textWidth: Math.round(textRect.width),
        textHeight: Math.round(textRect.height),
        textLeft: Math.round(textRect.left * 100) / 100,
        textTop: Math.round(textRect.top * 100) / 100,
        textLineHeight: Math.round(lineHeight * 100) / 100,
        tooltipLineCount: Math.max(1, Math.round(textRect.height / lineHeight)),
        viewportRight: window.innerWidth
      }
    })()`
  }).then((measurement: any) => measurement.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, tooltip }
}

async function measureFoldedPageChipTooltipTitleLineCount(
  session: CdpSession,
  label: string,
  options: { forcedTextWidth?: number } = {}
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-folded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
        const chipText = chip?.querySelector('.chip-text')
        if (${JSON.stringify(!!options.forcedTextWidth)} && chipText instanceof HTMLElement) {
          chipText.style.flex = '0 0 ${options.forcedTextWidth || 0}px'
          chipText.style.maxWidth = '${options.forcedTextWidth || 0}px'
        }
        const titleRow = chip?.querySelector('.chip-title-row')
        const envRow = chip?.querySelector('.chip-env-row')
        const chipTextRect = chipText?.getBoundingClientRect()
        const titleRect = titleRow?.getBoundingClientRect()
        const envRect = envRow?.getBoundingClientRect()
        if (chipText && titleRow && envRow && chipTextRect && titleRect && envRect && chipTextRect.width > 80 && chipTextRect.height > 8) {
          const styles = window.getComputedStyle(titleRow)
          const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
          resolve({
            x: Math.round(chipTextRect.left + Math.min(24, chipTextRect.width / 2)),
            y: Math.round(chipTextRect.top + Math.min(titleRect.height / 2, 10)),
            titleText: titleRow.textContent || '',
            envText: envRow.textContent || '',
            titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
            titleWidth: Math.round(titleRect.width),
            chipTextWidth: Math.round(chipTextRect.width)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a folded page chip for tooltip check: ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await waitForPageChipExpansionRect(session, label)

  const tooltip = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const tooltip = Array.from(document.querySelectorAll('.page-chip-expanded.page-chip-folded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
      const tooltipText = tooltip?.querySelector('.chip-text')
      const titleRow = tooltip?.querySelector('.chip-title-row')
      const tooltipRect = tooltip?.getBoundingClientRect()
      const titleRect = titleRow?.getBoundingClientRect()
      if (!(tooltip instanceof HTMLElement) || !(tooltipText instanceof HTMLElement) || !(titleRow instanceof HTMLElement) || !tooltipRect || !titleRect) return null
      const styles = window.getComputedStyle(titleRow)
      const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
      return {
        text: tooltip.textContent || '',
        titleText: titleRow.textContent || '',
        envCount: tooltip.querySelectorAll('.chip-env').length,
        visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).length,
        titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
        titleWidth: Math.round(titleRect.width),
        textWidth: Math.round(tooltipText.getBoundingClientRect().width),
        width: Math.round(tooltipRect.width),
        right: Math.round(tooltipRect.right),
        viewportRight: window.innerWidth
      }
    })()`
  }).then((measurement: any) => measurement.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, tooltip }
}

async function measureFoldedEnvHoverTooltips(
  session: CdpSession,
  label: string
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await Promise.all([
    waitForDashboardSettled(session),
    waitForNoTitleExpansion(session)
  ])

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-folded'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
        const envButton = chip?.querySelector('.chip-env')
        const rect = envButton?.getBoundingClientRect()
        if (envButton && rect && rect.width > 10 && rect.height > 10) {
          resolve({
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            text: envButton.textContent || ''
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a folded env button for tooltip check: ${label}`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await waitForTooltipRect(session)

  const tooltipTexts = await getVisibleTooltipTexts(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoTitleExpansion(session)

  return { target, tooltipTexts }
}

async function measureInteractiveTooltipClickReturnFocus(
  session: CdpSession,
  selector: string,
  marker: string,
  targetLabel: string,
  requiredDescendantSelector: string
) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const trigger = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .find((candidate) => {
            const hasRequiredDescendant =
              candidate.matches(${JSON.stringify(requiredDescendantSelector)}) ||
              !!candidate.querySelector(${JSON.stringify(requiredDescendantSelector)})
            return candidate.textContent?.includes(${JSON.stringify(marker)}) && hasRequiredDescendant
          })
        const rect = trigger?.getBoundingClientRect()
        if (trigger && rect && rect.width > 120 && rect.height > 8) {
          const focusTarget = trigger.closest('.page-chip') || trigger
          focusTarget.setAttribute('data-smoke-click-return-target', ${JSON.stringify(targetLabel)})
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, `expected a ${targetLabel} tooltip trigger for click-return smoke test`)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const expansion = await waitForPageChipExpansionRect(session, marker)
  const first = { found: !!expansion, expansion }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await wait(120)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  const afterReturnFocus = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const trigger = document.querySelector(${JSON.stringify(`[data-smoke-click-return-target="${targetLabel}"]`)})
      if (!(trigger instanceof HTMLElement)) return null
      trigger.blur()
      window.dispatchEvent(new Event('blur'))
      trigger.focus()
      window.dispatchEvent(new Event('focus'))
      return {
        active: document.activeElement === trigger,
        focusVisible: trigger.matches(':focus-visible')
      }
    })()`
  }).then((result: any) => result.result.value)
  await wait(240)

  return {
    target,
    first,
    afterReturnFocus,
    afterReturnTooltips: await getVisibleTooltipTexts(session)
  }
}

async function measurePageChipOriginalSlotLeave(session: CdpSession) {
  const label = 'Tooltip Boundary Alpha'
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            !candidate.closest('[data-slot="tooltip-content"]') &&
            candidate.textContent?.includes(${JSON.stringify(label)})
          )
        if (chipText instanceof HTMLElement) {
          chipText.style.flex = '0 0 130px'
          chipText.style.maxWidth = '130px'
          chipText.style.maxHeight = 'calc(1lh)'
        }
        const chip = chipText?.closest('.page-chip')
        const slot = chip?.closest('[data-tabout-part="slot"]') || chip
        const rect = chipText?.getBoundingClientRect()
        const slotRect = slot?.getBoundingClientRect()
        if (
          chipText instanceof HTMLElement &&
          chip instanceof HTMLElement &&
          slot instanceof HTMLElement &&
          rect &&
          slotRect &&
          slotRect.width > 80 &&
          slotRect.height > 8
        ) {
          resolve({
            startX: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
            slotLeft: Math.round(slotRect.left),
            slotRight: Math.round(slotRect.right),
            slotTop: Math.round(slotRect.top),
            slotBottom: Math.round(slotRect.bottom),
            slotWidth: Math.round(slotRect.width),
            slotHeight: Math.round(slotRect.height),
            textLeft: Math.round(rect.left),
            textTop: Math.round(rect.top),
            chipText: chipText.textContent || '',
            chipTextWidth: Math.round(rect.width)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for original-slot leave smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, label)

  assert.ok(first, `page chip should expand before original-slot leave check: ${JSON.stringify({ target, first })}`)
  assert.ok(
    first.right > target.slotRight + 8,
    `original-slot leave smoke needs an expanded-only horizontal area: ${JSON.stringify({ target, first })}`
  )

  const expandedOnlyPoint = {
    x: Math.round(Math.min(first.right - 4, target.slotRight + 16)),
    y: Math.round((Math.max(first.top, target.slotTop) + Math.min(first.bottom, target.slotBottom)) / 2)
  }
  assert.ok(
    expandedOnlyPoint.x > target.slotRight + 1 && expandedOnlyPoint.x < first.right,
    `original-slot leave point should be outside the original slot and inside the expanded chip: ${JSON.stringify({ target, first, expandedOnlyPoint })}`
  )
  assert.ok(
    expandedOnlyPoint.y >= first.top && expandedOnlyPoint.y <= first.bottom,
    `original-slot leave point should stay vertically inside the expanded chip: ${JSON.stringify({ target, first, expandedOnlyPoint })}`
  )

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: expandedOnlyPoint.x,
    y: expandedOnlyPoint.y
  })
  await wait(220)
  const afterOriginalSlotLeave = await waitForPageChipExpansionRect(session, label, 250)

  for (let index = 0; index < 8; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8 + index * 16,
      y: 8 + index * 5
    })
    await wait(80)
  }
  const afterLeaveTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('.page-chip-expanded'))
      .map((chip) => chip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, expandedOnlyPoint, afterOriginalSlotLeave, afterLeaveTooltips }
}

async function measureTooltipPopupClickFocus(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.scroll-region')?.scrollTo(0, 0)
      window.__tabOutSmokeFocusUpdates = []
      window.__tabOutSmokeOriginalTabsUpdate ||= chrome.tabs.update
      window.__tabOutSmokeOriginalWindowsUpdate ||= chrome.windows.update
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return window.__tabOutSmokeOriginalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return window.__tabOutSmokeOriginalWindowsUpdate(...args)
      }
    })()`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for popup click smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)
  assert.ok(first, `page chip should expand before in-place click check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  const popupStyle = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)}))
      if (!(chip instanceof HTMLElement)) return null
      const styles = window.getComputedStyle(chip)
      return {
        cursor: styles.cursor,
        userSelect: styles.userSelect
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: popupPoint.x,
    y: popupPoint.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: popupPoint.x,
    y: popupPoint.y
  })
  await waitForFocusUpdates(session)

  const updates = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const focusUpdates = window.__tabOutSmokeFocusUpdates || []
      chrome.tabs.update = window.__tabOutSmokeOriginalTabsUpdate
      chrome.windows.update = window.__tabOutSmokeOriginalWindowsUpdate
      return focusUpdates
    })()`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, popupStyle, updates }
}

async function measureHistoryEntryExpansionClickFocus(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.history-entry-list')?.scrollTo(0, 0)
      window.__tabOutSmokeFocusUpdates = []
      window.__tabOutSmokeOriginalTabsUpdate ||= chrome.tabs.update
      window.__tabOutSmokeOriginalWindowsUpdate ||= chrome.windows.update
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return window.__tabOutSmokeOriginalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return window.__tabOutSmokeOriginalWindowsUpdate(...args)
      }
    })()`
  })
  await Promise.all([
    waitForDashboardSettled(session),
    waitForScrollTop(session, '.history-entry-list')
  ])

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
          .find((candidate) =>
            candidate.closest('.history-entry-row')?.textContent?.includes('Low score history item with enough tooltip text')
          )
        const row = title?.closest('.history-entry-row')
        row?.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = title?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a history-panel entry to hover for expansion click smoke test')
  await wait(180)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  assert.ok(first, `history entry should expand before click check: ${JSON.stringify({ target, first })}`)

  const expandedPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  const expandedStyle = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const entry = document.querySelector('.history-entry-expanded')
      if (!entry) return null
	      const styles = window.getComputedStyle(entry)
	      return {
	        cursor: styles.cursor,
	        pointerEvents: styles.pointerEvents,
	        userSelect: styles.userSelect
	      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await waitForFocusUpdates(session)

  const updates = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const focusUpdates = window.__tabOutSmokeFocusUpdates || []
      chrome.tabs.update = window.__tabOutSmokeOriginalTabsUpdate
      chrome.windows.update = window.__tabOutSmokeOriginalWindowsUpdate
      return focusUpdates
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoHistoryEntryExpansion(session)

  return { target, first, expandedPoint, activationPoint: target, expandedStyle, updates }
}

async function measurePageChipContextMenuSave(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.scroll-region')?.scrollTo(0, 0)
      window.__tabOutSmokeSavedStore = {}
      window.__tabOutSmokeSavedSets = []
      window.__tabOutSmokeCopiedText = null
      window.__tabOutSmokeFocusUpdates = []
      window.__tabOutSmokeOriginalTabsUpdate = chrome.tabs.update
      window.__tabOutSmokeOriginalWindowsUpdate = chrome.windows.update
      chrome.storage.local.get = async () => window.__tabOutSmokeSavedStore
      chrome.storage.local.set = async (next) => {
        window.__tabOutSmokeSavedStore = { ...window.__tabOutSmokeSavedStore, ...next }
        window.__tabOutSmokeSavedSets.push(next)
      }
      chrome.tabs.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
        return window.__tabOutSmokeOriginalTabsUpdate(...args)
      }
      chrome.windows.update = async (...args) => {
        window.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
        return window.__tabOutSmokeOriginalWindowsUpdate(...args)
      }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__tabOutSmokeCopiedText = text
          }
        }
      })
    })()`
  })
  await waitForDashboardSettled(session)

  async function findPageChipTarget(label: string, xOffset = 96) {
    return evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const start = Date.now()
        const wait = () => {
          const chip = Array.from(document.querySelectorAll('.page-chip'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
          const rect = chip?.getBoundingClientRect()
          if (rect && rect.width > 120 && rect.height > 8) {
            resolve({
              label: ${JSON.stringify(label)},
              x: Math.round(rect.left + Math.min(${xOffset}, rect.width - 8)),
              y: Math.round(rect.top + rect.height / 2)
            })
          } else if (Date.now() - start > 5000) {
            resolve(null)
          } else {
            setTimeout(wait, 50)
          }
        }
        wait()
      })`
    }).then((result: any) => result.result.value)
  }

  async function findPageChipFaviconTarget(label: string) {
    return evaluateWithNavigationRetry(session, {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const start = Date.now()
        const wait = () => {
          const chip = Array.from(document.querySelectorAll('.page-chip'))
            .find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)}))
          const faviconFrame = chip?.querySelector('.chip-favicon-frame')
          const rect = faviconFrame?.getBoundingClientRect()
          if (rect && rect.width > 4 && rect.height > 4) {
            resolve({
              label: ${JSON.stringify(label)},
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2)
            })
          } else if (Date.now() - start > 5000) {
            resolve(null)
          } else {
            setTimeout(wait, 50)
          }
        }
        wait()
      })`
    }).then((result: any) => result.result.value)
  }

  const target = await findPageChipTarget('Short title')
  const targetFavicon = await findPageChipFaviconTarget('Short title')
  const replacementTarget = await findPageChipTarget('Example 2 with enough tooltip text', 140)
  const historyMatchTarget = await findPageChipTarget('Example 3 with enough tooltip text', 16)

  assert.ok(target, 'expected a live page chip for context menu save smoke test')
  assert.ok(targetFavicon, 'expected a live page chip favicon target for close-hover smoke test')
  assert.ok(replacementTarget, 'expected a second live page chip for context menu replacement smoke test')
  assert.ok(historyMatchTarget, 'expected a live page chip with a matching history entry for context menu hover smoke test')

  async function openContextMenuAt(menuTarget: { x: number; y: number }) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: menuTarget.x,
      y: menuTarget.y
    })
    await wait(80)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'right',
      buttons: 2,
      clickCount: 1,
      x: menuTarget.x,
      y: menuTarget.y
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'right',
      buttons: 0,
      clickCount: 1,
      x: menuTarget.x,
      y: menuTarget.y
    })
    await waitForContextMenuState(session, true)
  }

  async function readContextMenuState() {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const visibleMenus = Array.from(document.querySelectorAll('[data-slot="context-menu-content"]'))
          .filter((menu) => !menu.hidden && menu.getClientRects().length > 0 && window.getComputedStyle(menu).visibility !== 'hidden')
        return {
          visibleMenuCount: visibleMenus.length,
          itemTexts: visibleMenus.flatMap((menu) =>
            Array.from(menu.querySelectorAll('[data-slot="context-menu-item"]'))
              .map((item) => item.textContent?.trim() || '')
          ),
          backdropCount: document.querySelectorAll('[data-slot="context-menu-backdrop"]:not([hidden])').length
        }
      })()`
    }).then((result: any) => result.result.value)
  }

  async function readPageChipVisualState(menuTarget: { label: string }) {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(menuTarget.label)}))
        if (!(chip instanceof HTMLElement)) return null
        const styles = window.getComputedStyle(chip)
        const closeButton = chip.querySelector('.chip-close-favicon')
        const faviconContent = chip.querySelector('.chip-favicon-content')
        const duplicateStack = chip.querySelector('.chip-favicon-stack')
        const expandedFill = chip.querySelector('.page-chip-expanded-fill')
        const readPart = (part) => {
          if (!(part instanceof HTMLElement)) return null
          const partStyles = window.getComputedStyle(part)
          return {
            opacity: partStyles.opacity,
            pointerEvents: partStyles.pointerEvents
          }
        }
        return {
          backgroundColor: styles.backgroundColor,
          className: chip.className,
          contextMenuOpen: chip.classList.contains('page-chip-context-menu-open'),
          expanded: chip.classList.contains('page-chip-expanded'),
          tooltipOpen: chip.classList.contains('page-chip-tooltip-open'),
          transitionProperty: styles.transitionProperty,
          width: Math.round(chip.getBoundingClientRect().width),
          closeButton: readPart(closeButton),
          duplicateStack: readPart(duplicateStack),
          expandedFill: expandedFill instanceof HTMLElement
            ? {
                backgroundColor: window.getComputedStyle(expandedFill).backgroundColor,
                opacity: window.getComputedStyle(expandedFill).opacity
              }
            : null,
          faviconContent: readPart(faviconContent),
          hover: chip.matches(':hover'),
          urlPreview: document.querySelector('.url-preview span')?.textContent || ''
        }
      })()`
    }).then((result: any) => result.result.value)
  }

  async function dismissContextMenuWithPointer() {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: 8,
      y: 8
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      x: 8,
      y: 8
    })
    await waitForContextMenuState(session, false)
  }

  async function clickMenuItem(label: string) {
    await openContextMenuAt(target)

    const item = await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const item = Array.from(document.querySelectorAll('[data-slot="context-menu-item"]'))
          .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)})
        const rect = item?.getBoundingClientRect()
        if (!rect) return null
        return {
          text: item.textContent?.trim() || '',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        }
      })()`
    }).then((result: any) => result.result.value)

    assert.ok(item, `expected ${label} context menu item after right-click: ${JSON.stringify({ target })}`)

    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: item.x,
      y: item.y
    })
    await wait(80)
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: item.x,
      y: item.y
    })
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      x: item.x,
      y: item.y
    })
    await waitForBrowserCondition(
      session,
      (actionLabel: string) => {
        const smokeWindow = window as typeof window & {
          __tabOutSmokeCopiedText?: string | null
          __tabOutSmokeSavedSets?: unknown[]
        }
        const menu = document.querySelector('[data-slot="context-menu-content"]')
        const menuClosed = !menu || menu.getClientRects().length === 0
        if (actionLabel === 'Copy page title text') {
          return menuClosed && smokeWindow.__tabOutSmokeCopiedText !== null
        }
        if (actionLabel === 'Save page') {
          return menuClosed && (smokeWindow.__tabOutSmokeSavedSets?.length || 0) > 0
        }
        return menuClosed
      },
      `${label} context-menu action should complete`,
      { args: [label] }
    )

    return item
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(180)
  const restingChipState = await readPageChipVisualState(target)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(180)
  const hoverChipState = await readPageChipVisualState(target)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: targetFavicon.x,
    y: targetFavicon.y
  })
  await wait(180)
  const hoverFaviconState = await readPageChipVisualState(target)
  await openContextMenuAt(target)
  const contextMenuOpenChipState = await readPageChipVisualState(target)
  const firstOpenState = await readContextMenuState()
  assert.ok(restingChipState, `expected chip visual state before context menu: ${JSON.stringify({ target, restingChipState })}`)
  assert.ok(hoverChipState, `expected chip hover visual state before context menu: ${JSON.stringify({ target, hoverChipState })}`)
  assert.ok(hoverFaviconState, `expected chip favicon hover visual state before context menu: ${JSON.stringify({ targetFavicon, hoverFaviconState })}`)
  assert.ok(contextMenuOpenChipState, `expected chip visual state while context menu is open: ${JSON.stringify({ target, contextMenuOpenChipState })}`)
  assert.notEqual(hoverChipState.backgroundColor, restingChipState.backgroundColor, `hover should visibly change the page chip background before the context menu opens: ${JSON.stringify({ restingChipState, hoverChipState })}`)
  assert.equal(hoverChipState.closeButton?.opacity, '0', `hovering the page chip away from its favicon should keep the favicon-slot close button hidden: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverChipState.closeButton?.pointerEvents, 'none', `hovering the page chip away from its favicon should keep the close button non-interactive: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverChipState.faviconContent?.opacity, '1', `hovering the page chip away from its favicon should keep the favicon visible: ${JSON.stringify({ hoverChipState })}`)
  assert.equal(hoverFaviconState.closeButton?.opacity, '1', `hovering the favicon should show the favicon-slot close button: ${JSON.stringify({ hoverFaviconState })}`)
  assert.equal(hoverFaviconState.closeButton?.pointerEvents, 'auto', `hovering the favicon should make the close button interactive: ${JSON.stringify({ hoverFaviconState })}`)
  assert.equal(hoverFaviconState.faviconContent?.opacity, '0', `hovering the favicon should hide the favicon beneath the close button: ${JSON.stringify({ hoverFaviconState })}`)
  assert.equal(contextMenuOpenChipState.contextMenuOpen, true, `context menu trigger should carry an explicit menu-open class: ${JSON.stringify({ contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.backgroundColor, hoverChipState.backgroundColor, `page chip should keep its hover-like background while its context menu is open: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.closeButton?.opacity, hoverChipState.closeButton?.opacity, `opening the context menu from the page chip should not reveal the favicon-slot close button: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.closeButton?.pointerEvents, hoverChipState.closeButton?.pointerEvents, `opening the context menu from the page chip should keep the close button non-interactive: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  assert.equal(contextMenuOpenChipState.faviconContent?.opacity, hoverChipState.faviconContent?.opacity, `opening the context menu from the page chip should keep the favicon visible: ${JSON.stringify({ hoverChipState, contextMenuOpenChipState })}`)
  await openContextMenuAt(replacementTarget)
  const replacementState = await readContextMenuState()
  assert.equal(firstOpenState.visibleMenuCount, 1, `first right-click should open one visible context menu: ${JSON.stringify(firstOpenState)}`)
  assert.ok(firstOpenState.backdropCount > 0, `an open context menu should render a backdrop to consume outside clicks: ${JSON.stringify(firstOpenState)}`)
  assert.ok(replacementState.visibleMenuCount <= 1, `right-clicking a second chip should not stack context menus: ${JSON.stringify(replacementState)}`)
  await dismissContextMenuWithPointer()

  const freshHistoryMatchTarget = await findPageChipTarget('Example 3 with enough tooltip text', 16)
  assert.ok(freshHistoryMatchTarget, 'expected the matching-history page chip target to remain visible after context-menu replacement smoke')
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: freshHistoryMatchTarget.x,
    y: freshHistoryMatchTarget.y
  })
  await wait(180)
  const hoveredHistoryChipState = await readPageChipVisualState(freshHistoryMatchTarget)
  await openContextMenuAt(freshHistoryMatchTarget)
  const contextMenuHistoryChipState = await readPageChipVisualState(freshHistoryMatchTarget)
  assert.equal(hoveredHistoryChipState?.urlPreview, 'https://tab-out-smoke-03.com/docs/3', `hovering the matching-history page chip should set the shared hover URL before the context menu opens: ${JSON.stringify({ hoveredHistoryChipState, freshHistoryMatchTarget })}`)
  assert.equal(contextMenuHistoryChipState?.contextMenuOpen, true, `matching-history page chip should carry the context-menu-open class: ${JSON.stringify({ contextMenuHistoryChipState })}`)
  assert.equal(contextMenuHistoryChipState?.urlPreview, hoveredHistoryChipState?.urlPreview, `opening the page chip context menu should keep the shared hover URL active for cross-surface matching: ${JSON.stringify({ hoveredHistoryChipState, contextMenuHistoryChipState })}`)
  await dismissContextMenuWithPointer()

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: replacementTarget.x,
    y: replacementTarget.y
  })
  await waitForPageChipExpansionRect(session, 'Example 2 with enough tooltip text')
  const expandedHoverChipState = await readPageChipVisualState(replacementTarget)
  const visibleTooltipCountBeforeMenu = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
      const rect = tooltip.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
    }).length`
  }).then((result: any) => result.result.value)
  assert.equal(expandedHoverChipState?.expanded, true, `page chip should expand in place before context-menu shield check: ${JSON.stringify({ replacementTarget, expandedHoverChipState })}`)
  assert.equal(expandedHoverChipState?.hover, true, `expanded page chip should still be under the pointer before context-menu shield check: ${JSON.stringify({ expandedHoverChipState })}`)
  assert.equal(expandedHoverChipState?.tooltipOpen, false, `in-place expansion should not impersonate an open tooltip: ${JSON.stringify({ expandedHoverChipState })}`)
  assert.equal(visibleTooltipCountBeforeMenu, 0, `in-place page chip expansion should not create a tooltip popup before context-menu shield check: ${JSON.stringify({ replacementTarget, expandedHoverChipState, visibleTooltipCountBeforeMenu })}`)
  assert.equal(expandedHoverChipState?.expandedFill?.opacity, '1', `hovered expanded page chip should show its opaque backing fill: ${JSON.stringify({ hoverChipState, expandedHoverChipState })}`)
  assert.notEqual(expandedHoverChipState?.expandedFill?.backgroundColor, 'rgba(0, 0, 0, 0)', `hovered expanded page chip should paint a backing fill instead of letting content behind it show through: ${JSON.stringify({ hoverChipState, expandedHoverChipState })}`)
  assert.doesNotMatch(expandedHoverChipState?.expandedFill?.backgroundColor || '', /(?:rgba\([^)]*,\s*0\.\d+\)|\/\s*0\.\d+)/, `expanded page chip backing fill should not be a low-alpha overlay: ${JSON.stringify({ hoverChipState, expandedHoverChipState })}`)
  assert.doesNotMatch(expandedHoverChipState?.transitionProperty || '', /box-shadow/, `expanded page chip shadow should appear in the same frame as the background instead of transitioning later: ${JSON.stringify({ expandedHoverChipState })}`)
  assert.equal(expandedHoverChipState?.closeButton?.opacity, hoverChipState.closeButton?.opacity, `page chip expansion should not reveal the favicon-slot close button: ${JSON.stringify({ hoverChipState, expandedHoverChipState })}`)
  assert.equal(expandedHoverChipState?.faviconContent?.opacity, hoverChipState.faviconContent?.opacity, `page chip expansion should keep the favicon visible away from favicon hover: ${JSON.stringify({ hoverChipState, expandedHoverChipState })}`)
  await openContextMenuAt(replacementTarget)
  const expandedAfterMenu = await readPageChipVisualState(replacementTarget)
  assert.equal(expandedAfterMenu?.expanded, true, `right-clicking to open a page chip context menu should not collapse an in-place expansion: ${JSON.stringify({ expandedHoverChipState, expandedAfterMenu })}`)
  const backdropDismissPoint = await findPageChipTarget('Example 2 with enough tooltip text', 40)
  assert.ok(backdropDismissPoint, `expected a page-chip point outside the context menu for backdrop-dismiss smoke: ${JSON.stringify({ replacementTarget })}`)
  const backdropDismissOpenState = await readPageChipVisualState(replacementTarget)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y
  })
  await wait(30)
  const backdropDismissPressedState = await readPageChipVisualState(replacementTarget)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y
  })
  await wait(20)
  const backdropDismissReleasedState = await readPageChipVisualState(replacementTarget)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)
  await waitForBrowserCondition(
    session,
    () => !document.querySelector('.page-chip-context-menu-open'),
    'page chip context-menu visual state should clear after backdrop dismissal'
  )
  const backdropDismissAfterState = await readPageChipVisualState(replacementTarget)
  const backdropDismissMenuState = await readContextMenuState()
  assert.equal(backdropDismissOpenState?.contextMenuOpen, true, `page chip should carry the context-menu-open class before backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState })}`)
  assert.equal(backdropDismissPressedState?.contextMenuOpen, true, `page chip should keep the context-menu-open visual class during backdrop dismissal: ${JSON.stringify({ backdropDismissPressedState })}`)
  assert.equal(backdropDismissPressedState?.backgroundColor, backdropDismissOpenState?.backgroundColor, `clicking the context menu backdrop over the page chip should not flash the chip background: ${JSON.stringify({ backdropDismissOpenState, backdropDismissPressedState })}`)
  assert.equal(backdropDismissReleasedState?.backgroundColor, backdropDismissOpenState?.backgroundColor, `page chip should bridge the first backdrop dismissal frame without a background flash: ${JSON.stringify({ backdropDismissOpenState, backdropDismissReleasedState })}`)
  assert.equal(backdropDismissAfterState?.contextMenuOpen, false, `page chip should clear the context-menu-open class after backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState, backdropDismissAfterState })}`)
  assert.equal(backdropDismissAfterState?.expanded, false, `page chip should close its in-place expansion after backdrop dismissal and pointer exit: ${JSON.stringify({ backdropDismissOpenState, backdropDismissAfterState })}`)
  assert.equal(backdropDismissMenuState.visibleMenuCount, 0, `backdrop dismissal over the page chip should close the context menu: ${JSON.stringify({ backdropDismissMenuState })}`)
  await openContextMenuAt(replacementTarget)
  const tooltipShieldPoint = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      document.querySelector('[data-smoke-tooltip-shield]')?.remove()
      const syntheticTooltip = document.createElement('div')
      syntheticTooltip.dataset.slot = 'tooltip-content'
      syntheticTooltip.dataset.smokeTooltipShield = 'true'
      syntheticTooltip.textContent = 'Synthetic tooltip shield target'
      syntheticTooltip.style.cssText = [
        'position:fixed',
        'left:24px',
        'top:24px',
        'width:220px',
        'height:32px',
        'z-index:50',
        'pointer-events:auto',
        'background:canvas',
        'color:canvastext'
      ].join(';')
      syntheticTooltip.addEventListener('click', () => {
        chrome.tabs.update(1, { active: true })
      })
      document.body.append(syntheticTooltip)
      const rect = syntheticTooltip.getBoundingClientRect()
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      }
    })()`
  }).then((result: any) => result.result.value)
  const shieldBeforeClick = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      window.__tabOutSmokeFocusUpdates = []
      const target = document.elementFromPoint(${tooltipShieldPoint.x}, ${tooltipShieldPoint.y})
      const owner = target?.closest?.('[data-slot]')
      return {
        point: ${JSON.stringify(tooltipShieldPoint)},
        topSlot: owner?.getAttribute('data-slot') || '',
        topText: owner?.textContent?.trim() || '',
        menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])'),
        tooltipOpen: !!document.querySelector('[data-slot="tooltip-content"]:not([hidden])')
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y
  })
  await waitForContextMenuState(session, false)
  const shieldAfterClick = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const focusUpdates = window.__tabOutSmokeFocusUpdates || []
      chrome.tabs.update = window.__tabOutSmokeOriginalTabsUpdate
      chrome.windows.update = window.__tabOutSmokeOriginalWindowsUpdate
      document.querySelector('[data-smoke-tooltip-shield]')?.remove()
      return {
        focusUpdateCount: focusUpdates.length,
        menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])')
      }
    })()`
  }).then((result: any) => result.result.value)
  assert.notEqual(shieldBeforeClick.topSlot, 'tooltip-content', `context menu backdrop should cover visible tooltips: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)
  assert.equal(shieldAfterClick.focusUpdateCount, 0, `clicking where a tooltip is visible while context menu is open should not focus/open the page: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)
  assert.equal(shieldAfterClick.menuOpen, false, `clicking the context menu backdrop over a tooltip should dismiss the menu: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)

  const copyItem = await clickMenuItem('Copy page title text')
  const copyResult = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `({
      copiedText: window.__tabOutSmokeCopiedText,
      menuOpen: !!document.querySelector('[data-slot="context-menu-content"]')
    })`
  }).then((result: any) => result.result.value)

  const saveItem = await clickMenuItem('Save page')

  const saveResult = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const store = window.__tabOutSmokeSavedStore?.tabOutSavedPagesV1
      const pageKeys = store?.pages ? Object.keys(store.pages) : []
      return {
        itemText: ${JSON.stringify('Save page')},
        menuOpen: !!document.querySelector('[data-slot="context-menu-content"]'),
        pageKeys,
        setCount: window.__tabOutSmokeSavedSets?.length || 0
      }
    })()`
  }).then((result: any) => result.result.value)

  await openContextMenuAt(target)
  const sourceButtonTarget = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const button = Array.from(document.querySelectorAll('.source-switch-option'))
        .find((candidate) => candidate.textContent?.trim() === 'Bookmarks')
      const activeBefore = document.querySelector('.source-switch-option[data-active]')?.textContent?.trim() || ''
      const rect = button?.getBoundingClientRect()
      if (!rect) return null
      return {
        activeBefore,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      }
    })()`
  }).then((result: any) => result.result.value)

  assert.ok(sourceButtonTarget, 'expected the Bookmarks source switch button for context menu outside-click smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y
  })
  await wait(80)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y
  })
  await waitForBrowserCondition(
    session,
    () => {
      const active = document.querySelector('.source-switch-option[data-active]')?.textContent?.trim()
      const menu = document.querySelector('[data-slot="context-menu-content"]')
      return active === 'Tabs' && (!menu || menu.getClientRects().length === 0)
    },
    'outside click should close the context menu without activating Bookmarks'
  )

  const outsideClickResult = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `({
      activeBefore: ${JSON.stringify(sourceButtonTarget.activeBefore)},
      activeAfter: document.querySelector('.source-switch-option[data-active]')?.textContent?.trim() || '',
      menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])')
    })`
  }).then((result: any) => result.result.value)

  return { target, firstOpenState, replacementState, shieldBeforeClick, shieldAfterClick, copyItem, copyResult, saveItem, saveResult, outsideClickResult }
}

async function measureTooltipPopupWheelScroll(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip to hover for popup wheel smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  assert.ok(first, `page chip should expand before in-place wheel check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y
  })
  await wait(80)

  const beforeScrollTop = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelector('.scroll-region')?.scrollTop ?? 0`
  }).then((result: any) => result.result.value)

  const wheelSteps = []
  for (let index = 0; index < 4; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 36,
      x: popupPoint.x,
      y: popupPoint.y
    })
    await wait(60)
    wheelSteps.push(await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const scrollRegion = document.querySelector('.scroll-region')
        return {
          scrollTop: scrollRegion?.scrollTop ?? 0,
          expandedCount: document.querySelectorAll('.page-chip-expanded').length,
          tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
        }
      })()`
    }).then((result: any) => result.result.value))
  }
  await waitForNoPageChipExpansion(session)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const scrollRegion = document.querySelector('.scroll-region')
      return {
        scrollTop: scrollRegion?.scrollTop ?? 0,
        expandedCount: document.querySelectorAll('.page-chip-expanded').length,
        tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoTitleExpansion(session)

  const afterLeaveExpandedCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('.page-chip-expanded').length`
  }).then((result: any) => result.result.value)

  return { target, first, popupPoint, beforeScrollTop, wheelSteps, after, afterLeaveExpandedCount }
}

async function measureHistoryEntryExpansionSurfaceHitArea(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.history-entry-list')?.scrollTo(0, 0)`
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await Promise.all([
    waitForDashboardSettled(session),
    waitForScrollTop(session, '.history-entry-list'),
    waitForNoTitleExpansion(session)
  ])

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const row = Array.from(document.querySelectorAll('.history-entry-row'))
          .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
        row?.scrollIntoView({ block: 'center', inline: 'nearest' })
        const frame = row?.querySelector('.history-entry-favicon-frame')
        const main = row?.querySelector('.history-entry-main')
        const frameRect = frame?.getBoundingClientRect()
        const mainRect = main?.getBoundingClientRect()
        if (
          row &&
          frameRect &&
          mainRect &&
          frameRect.width > 4 &&
          frameRect.height > 4 &&
          mainRect.top < frameRect.top - 1 &&
          mainRect.bottom > frameRect.bottom + 1
        ) {
          resolve({
            x: Math.round(frameRect.left + frameRect.width / 2),
            aboveY: Math.round(mainRect.top + Math.max(1, (frameRect.top - mainRect.top) / 2)),
            belowY: Math.round(frameRect.bottom + Math.max(1, (mainRect.bottom - frameRect.bottom) / 2)),
            frameTop: Math.round(frameRect.top),
            frameBottom: Math.round(frameRect.bottom),
            mainTop: Math.round(mainRect.top),
            mainBottom: Math.round(mainRect.bottom)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a history entry favicon frame with vertical padding for expansion hit-area smoke test')
  await wait(180)

  async function visibleTooltipTexts() {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
        .filter((tooltip) => !tooltip.hidden && tooltip.getClientRects().length > 0 && window.getComputedStyle(tooltip).visibility !== 'hidden')
        .map((tooltip) => tooltip.textContent || '')`
    }).then((result: any) => result.result.value)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY
  })
  const above = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  const aboveTooltipTexts = await visibleTooltipTexts()

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoHistoryEntryExpansion(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.belowY
  })
  const below = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  const belowTooltipTexts = await visibleTooltipTexts()

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoHistoryEntryExpansion(session)

  return { target, above, below, aboveTooltipTexts, belowTooltipTexts }
}

async function measureHistoryEntryExpansionWheelScroll(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.history-entry-list')?.scrollTo(0, 0)`
  })
  await Promise.all([
    waitForDashboardSettled(session),
    waitForScrollTop(session, '.history-entry-list')
  ])

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
          .find((candidate) =>
            candidate.closest('.history-entry-row')?.textContent?.includes('Low score history item with enough tooltip text')
          )
        const row = title?.closest('.history-entry-row')
        row?.scrollIntoView({ block: 'center', inline: 'nearest' })
        const rect = title?.getBoundingClientRect()
        const entry = title?.closest('.history-entry')
        const slot = entry?.closest('.history-entry-slot') || entry
        const slotRect = slot?.getBoundingClientRect()
        const titleStyles = title ? window.getComputedStyle(title) : null
        const lineHeight = Number.parseFloat(titleStyles?.lineHeight || '') || 0
        const titleMaskImage = titleStyles?.maskImage || titleStyles?.webkitMaskImage || ''
        const list = document.querySelector('.history-entry-list')
        if (rect && slotRect && list && rect.width > 120 && rect.height > 8) {
          const titleLineCount = Math.max(1, Math.round(rect.height / lineHeight))
          const collectLineTexts = (root, limit) => {
            const rootRect = root.getBoundingClientRect()
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
              }
            })
            const range = document.createRange()
            const lines = Array.from({ length: limit }, () => '')
            while (true) {
              const node = walker.nextNode()
              if (!node) break
              const text = node.textContent || ''
              for (let offset = 0; offset < text.length; offset += 1) {
                range.setStart(node, offset)
                range.setEnd(node, offset + 1)
                const rects = Array.from(range.getClientRects())
                const paintedRects = rects.filter((candidate) => candidate.width > 0 || candidate.height > 0)
                const charRect = paintedRects.at(-1)
                if (!charRect) continue
                const lineIndex = Math.max(0, Math.round((charRect.top - rootRect.top) / lineHeight))
                if (lineIndex >= limit) return lines
                lines[lineIndex] += text[offset]
              }
            }
            return lines
          }
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2),
            titleLineCount,
            titleLineTexts: collectLineTexts(title, titleLineCount),
            titleLeft: Math.round(rect.left),
            titleLeftExact: Math.round(rect.left * 100) / 100,
            titleTop: Math.round(rect.top),
            titleTopExact: Math.round(rect.top * 100) / 100,
            titleWidth: Math.round(rect.width),
            titleWidthExact: Math.round(rect.width * 100) / 100,
            titleHeight: Math.round(rect.height * 100) / 100,
            titleLineHeight: lineHeight,
            titleMaskImage,
            titleWebkitLineClamp: titleStyles?.webkitLineClamp || null,
            slotLeft: Math.round(slotRect.left),
            slotRight: Math.round(slotRect.right),
            slotTop: Math.round(slotRect.top),
            slotBottom: Math.round(slotRect.bottom),
            slotWidth: Math.round(slotRect.width),
            slotHeight: Math.round(slotRect.height),
            listScrollHeight: list.scrollHeight,
            listClientHeight: list.clientHeight,
            listMaxScrollTop: Math.max(0, list.scrollHeight - list.clientHeight)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a history-panel entry to hover for expansion wheel smoke test')
  await wait(180)

  const scrollbarGeometry = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const panel = document.querySelector('.tab-history-panel')
      const list = document.querySelector('.history-entry-list')
      const scrollbar = document.querySelector('.history-entry-scrollbar')
      const thumb = document.querySelector('.history-entry-scrollbar-thumb')
      const panelRect = panel?.getBoundingClientRect()
      const listRect = list?.getBoundingClientRect()
      const scrollbarRect = scrollbar?.getBoundingClientRect()
      const thumbRect = thumb?.getBoundingClientRect()
      const listStyles = list ? window.getComputedStyle(list) : null
      if (!panelRect || !listRect || !scrollbarRect || !thumbRect || !list) return null
      return {
        listClientHeight: list.clientHeight,
        listRight: Math.round(listRect.right * 100) / 100,
        listScrollHeight: list.scrollHeight,
        nativeScrollbarWidth: listStyles?.scrollbarWidth || '',
        panelRight: Math.round(panelRect.right * 100) / 100,
        revealPoint: {
          x: Math.round(scrollbarRect.left + scrollbarRect.width / 2),
          y: Math.round(scrollbarRect.bottom - 8)
        },
        scrollbarRight: Math.round(scrollbarRect.right * 100) / 100,
        scrollbarWidth: Math.round(scrollbarRect.width * 100) / 100,
        thumbHeight: Math.round(thumbRect.height * 100) / 100,
        viewportWidth: window.innerWidth
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: scrollbarGeometry.revealPoint.x,
    y: scrollbarGeometry.revealPoint.y
  })
  await wait(60)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  await waitForHistoryScrollbarThumbOpacity(session, '1')

  assert.ok(first, `history entry should expand before wheel check: ${JSON.stringify({ target, first })}`)

  const tooltipOpenEntryState = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      const row = Array.from(document.querySelectorAll('.history-entry-row'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      const scrollbar = document.querySelector('.history-entry-scrollbar')
      const styles = entry ? window.getComputedStyle(entry) : null
      const rowStyles = row ? window.getComputedStyle(row) : null
      const indexStyles = row?.firstElementChild instanceof HTMLElement ? window.getComputedStyle(row.firstElementChild) : null
      const scrollbarStyles = scrollbar ? window.getComputedStyle(scrollbar) : null
      return {
        backgroundColor: styles?.backgroundColor || '',
        expandedZIndex: styles?.zIndex || '',
        expandedInsideHistoryList: !!entry?.closest('.history-entry-list'),
        expandedInsidePanel: !!entry?.closest('.tab-history-panel'),
        expandedInsideDashboardShell: !!entry?.closest('[data-tabout="dashboard-shell"]'),
        expandedInsideOverlay: !!entry?.closest('.history-entry-overlay'),
        indexColor: indexStyles?.color || '',
        rowOpacity: rowStyles?.opacity || '',
        scrollbarZIndex: scrollbarStyles?.zIndex || '',
        rowExpandedOpen: row?.classList.contains('history-entry-row-expanded-open') || false,
        expandedOpen: entry?.classList.contains('history-entry-expanded-open') || false
      }
    })()`
  }).then((result: any) => result.result.value)

  const scrollbarOverlapState = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      const scrollbar = document.querySelector('.history-entry-scrollbar')
      const thumb = document.querySelector('.history-entry-scrollbar-thumb')
      if (!(entry instanceof HTMLElement) || !(scrollbar instanceof HTMLElement) || !(thumb instanceof HTMLElement)) return null
      const entryRect = entry.getBoundingClientRect()
      const scrollbarRect = scrollbar.getBoundingClientRect()
      const thumbRect = thumb.getBoundingClientRect()
      const overlapTop = Math.max(entryRect.top, thumbRect.top)
      const overlapBottom = Math.min(entryRect.bottom, thumbRect.bottom)
      if (overlapBottom - overlapTop <= 1) {
        return {
          clipPath: window.getComputedStyle(scrollbar).clipPath,
          entryRect: { left: entryRect.left, right: entryRect.right, top: entryRect.top, bottom: entryRect.bottom },
          scrollbarRect: { left: scrollbarRect.left, right: scrollbarRect.right, top: scrollbarRect.top, bottom: scrollbarRect.bottom },
          thumbRect: { left: thumbRect.left, right: thumbRect.right, top: thumbRect.top, bottom: thumbRect.bottom },
          overlapPoint: null,
          hitScrollbar: null
        }
      }
      const overlapPoint = {
        x: Math.round((Math.max(entryRect.left, thumbRect.left) + Math.min(entryRect.right, thumbRect.right)) / 2),
        y: Math.round((overlapTop + overlapBottom) / 2)
      }
      const visibleThumbSegments = [
        { top: thumbRect.top, bottom: Math.min(thumbRect.bottom, entryRect.top) },
        { top: Math.max(thumbRect.top, entryRect.bottom), bottom: thumbRect.bottom }
      ].filter((segment) => segment.bottom - segment.top > 1)
      const visibleThumbSegment = visibleThumbSegments.sort(
        (left, right) => (right.bottom - right.top) - (left.bottom - left.top)
      )[0] || null
      const visibleThumbPoint = visibleThumbSegment
        ? {
            x: overlapPoint.x,
            y: Math.round((visibleThumbSegment.top + visibleThumbSegment.bottom) / 2)
          }
        : null
      const visibleThumbNode = visibleThumbPoint
        ? document.elementFromPoint(visibleThumbPoint.x, visibleThumbPoint.y)
        : null
      const previousEntryTransform = entry.style.transform
      const overlapNode = document.elementFromPoint(overlapPoint.x, overlapPoint.y)
      entry.style.transform = 'translateY(24px)'
      const shiftedEntryRect = entry.getBoundingClientRect()
      const shiftedOverlapTop = Math.max(shiftedEntryRect.top, thumbRect.top)
      const shiftedOverlapBottom = Math.min(shiftedEntryRect.bottom, thumbRect.bottom)
      const shiftedOverlapPoint = shiftedOverlapBottom - shiftedOverlapTop > 1
        ? {
            x: overlapPoint.x,
            y: Math.round((shiftedOverlapTop + shiftedOverlapBottom) / 2)
          }
        : null
      const shiftedNode = shiftedOverlapPoint
        ? document.elementFromPoint(shiftedOverlapPoint.x, shiftedOverlapPoint.y)
        : null
      entry.style.transform = previousEntryTransform
      return {
        clipPath: window.getComputedStyle(scrollbar).clipPath,
        thumbOpacity: window.getComputedStyle(thumb).opacity,
        entryRect: { left: entryRect.left, right: entryRect.right, top: entryRect.top, bottom: entryRect.bottom },
        scrollbarRect: { left: scrollbarRect.left, right: scrollbarRect.right, top: scrollbarRect.top, bottom: scrollbarRect.bottom },
        thumbRect: { left: thumbRect.left, right: thumbRect.right, top: thumbRect.top, bottom: thumbRect.bottom },
        overlapPoint,
        visibleThumbLength: visibleThumbSegment ? visibleThumbSegment.bottom - visibleThumbSegment.top : 0,
        visibleThumbPoint,
        visibleThumbHitScrollbar: !!(visibleThumbNode instanceof Element && visibleThumbNode.closest('.history-entry-scrollbar')),
        hitScrollbar: !!(overlapNode instanceof Element && overlapNode.closest('.history-entry-scrollbar')),
        hitExpanded: !!(overlapNode instanceof Element && overlapNode.closest('.history-entry-expanded')),
        hitInputShield: !!(overlapNode instanceof Element && overlapNode.closest('.history-entry-scrollbar-input-shield')),
        hitInsideHistoryList: !!(overlapNode instanceof Element && overlapNode.closest('.history-entry-list')),
        shiftedEntryTop: shiftedEntryRect.top,
        shiftedOverlapPoint,
        shiftedHitScrollbar: !!(shiftedNode instanceof Element && shiftedNode.closest('.history-entry-scrollbar')),
        shiftedHitExpanded: !!(shiftedNode instanceof Element && shiftedNode.closest('.history-entry-expanded')),
        shiftedHitInputShield: !!(shiftedNode instanceof Element && shiftedNode.closest('.history-entry-scrollbar-input-shield')),
        shiftedHitInsideHistoryList: !!(shiftedNode instanceof Element && shiftedNode.closest('.history-entry-list'))
      }
    })()`
  }).then((result: any) => result.result.value)

  const expandedPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2)
  }
  assert.ok(
    first.right > target.slotRight + 8,
    `history original-slot leave smoke needs an expanded-only horizontal area: ${JSON.stringify({ target, first })}`
  )
  const expandedOnlyPoint = {
    x: Math.round(Math.min(first.right - 4, target.slotRight + 16)),
    y: Math.round((Math.max(first.top, target.slotTop) + Math.min(first.bottom, target.slotBottom)) / 2)
  }
  assert.ok(
    expandedOnlyPoint.x > target.slotRight + 1 && expandedOnlyPoint.x < first.right,
    `history original-slot leave point should be outside the original slot and inside the expanded entry: ${JSON.stringify({ target, first, expandedOnlyPoint })}`
  )
	  const expandedOnlyHitTarget = await evaluateWithNavigationRetry(session, {
	    returnByValue: true,
	    expression: `(() => {
	      const expandedEntry = Array.from(document.querySelectorAll('.history-entry-expanded'))
	        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
	      const node = document.elementFromPoint(${JSON.stringify(expandedOnlyPoint.x)}, ${JSON.stringify(expandedOnlyPoint.y)})
	      const entry = node instanceof Element ? node.closest('.history-entry-expanded') : null
	      return {
	        className: node instanceof Element ? node.className || '' : '',
	        hitInsideExpanded: !!entry,
	        text: entry?.textContent || '',
	        visualText: expandedEntry?.textContent || ''
	      }
	    })()`
  }).then((result: any) => result.result.value)

  const expandedOnlyClipCheck = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const expandedEntry = Array.from(document.querySelectorAll('.history-entry-expanded'))
        .find((candidate) => candidate.textContent?.includes('Low score history item with enough tooltip text'))
      if (!(expandedEntry instanceof HTMLElement)) return { hitInsideExpanded: false, text: '' }
      const previousPointerEvents = expandedEntry.style.pointerEvents
      expandedEntry.style.pointerEvents = 'auto'
      const node = document.elementFromPoint(${JSON.stringify(expandedOnlyPoint.x)}, ${JSON.stringify(expandedOnlyPoint.y)})
      const entry = node instanceof Element ? node.closest('.history-entry-expanded') : null
      expandedEntry.style.pointerEvents = previousPointerEvents
      return {
        className: node instanceof Element ? node.className || '' : '',
        hitInsideExpanded: !!entry,
        text: entry?.textContent || ''
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: expandedOnlyPoint.x,
    y: expandedOnlyPoint.y
  })
  await waitForNoHistoryEntryExpansion(session)
  const afterOriginalSlotLeave = null

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const reopened = await waitForHistoryEntryExpansionRect(session, 'Low score history item with enough tooltip text')
  assert.ok(reopened, `history entry should reopen before wheel check: ${JSON.stringify({ target, first, afterOriginalSlotLeave })}`)

  const beforeScrollTop = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      return {
        dashboardScrollTop: document.querySelector('.scroll-region')?.scrollTop ?? 0,
        historyScrollTop: document.querySelector('.history-entry-list')?.scrollTop ?? 0
      }
    })()`
  }).then((result: any) => result.result.value)

  const wheelDeltaY = beforeScrollTop.historyScrollTop >= target.listMaxScrollTop - 1 ? -18 : 18
  for (let index = 0; index < 4; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: wheelDeltaY,
      x: target.x,
      y: target.y
    })
    await wait(60)
  }
  await waitForNoHistoryEntryExpansion(session)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const historyList = document.querySelector('.history-entry-list')
      const dashboardScrollRegion = document.querySelector('.scroll-region')
      return {
        dashboardScrollTop: dashboardScrollRegion?.scrollTop ?? 0,
        historyScrollTop: historyList?.scrollTop ?? 0,
        expansionCount: document.querySelectorAll('.history-entry-expanded').length,
        tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
      }
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoTitleExpansion(session)

  const afterLeaveExpansionState = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => ({
      expansionCount: document.querySelectorAll('.history-entry-expanded').length,
      tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length
    }))()`
  }).then((result: any) => result.result.value)

  return { target, first, scrollbarGeometry, scrollbarOverlapState, expandedPoint, expandedOnlyPoint, expandedOnlyClipCheck, expandedOnlyHitTarget, afterOriginalSlotLeave, tooltipOpenEntryState, beforeScrollTop, wheelDeltaY, after, afterLeaveExpansionState }
}

function assertHistoryScrollbarLayering(result: Awaited<ReturnType<typeof measureHistoryEntryExpansionWheelScroll>>) {
  assert.ok(
    result.scrollbarOverlapState?.overlapPoint,
    `history scrollbar overlap smoke needs the visible thumb and expanded entry to intersect: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.clipPath,
    'none',
    `history scrollbar should not rely on a fixed geometry cutout: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.thumbOpacity,
    '1',
    `history scrollbar should remain visible while the expanded entry covers only their overlap: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.ok(
    result.scrollbarOverlapState?.visibleThumbLength > 1,
    `history scrollbar should retain a visible thumb segment outside the expanded entry: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.visibleThumbHitScrollbar,
    true,
    `the uncovered thumb segment should remain pointer-interactive: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.hitScrollbar,
    false,
    `expanded history entry should keep the covered scrollbar band from receiving input: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.hitExpanded,
    true,
    `expanded history entry should own its scrollbar overlap under production pointer events: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.hitInputShield,
    true,
    `expanded history entry should expose its narrow scrollbar input shield at the overlap: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.hitInsideHistoryList,
    true,
    `wheel input over the covered scrollbar band should stay in the history scroller event path: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.ok(
    result.scrollbarOverlapState?.shiftedEntryTop > result.scrollbarOverlapState.entryRect.top + 20,
    `history stacking probe should move the expanded entry away from its initial scrollbar overlap: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.shiftedHitScrollbar,
    false,
    `the shifted expanded entry should continue painting above the scrollbar: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.shiftedHitExpanded,
    true,
    `the moving expanded entry should carry the scrollbar redaction with it: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.shiftedHitInputShield,
    true,
    `the moving expanded entry should carry its scrollbar input shield with it: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
  assert.equal(
    result.scrollbarOverlapState?.shiftedHitInsideHistoryList,
    true,
    `the shifted scrollbar input shield should remain in the history scroller event path: ${JSON.stringify(result.scrollbarOverlapState)}`
  )
}

async function measureHistoryLeftGutterWheelScroll(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1800,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.history-entry-list')?.scrollTo(0, 0)
      document.querySelector('.scroll-region')?.scrollTo(0, 0)
    })()`
  })
  await Promise.all([
    waitForDashboardSettled(session),
    waitForScrollTop(session, '.history-entry-list')
  ])

  const target = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const shell = document.querySelector('[data-tabout="dashboard-shell"]')
      const panel = document.querySelector('.tab-history-panel')
      const list = document.querySelector('.history-entry-list')
      const content = document.querySelector('.history-entry-list-content')
      const hitArea = document.querySelector('[data-tabout-part="history-scroll-hit-area"]')
      const shellRect = shell?.getBoundingClientRect()
      const panelRect = panel?.getBoundingClientRect()
      const listRect = list?.getBoundingClientRect()
      const contentRect = content?.getBoundingClientRect()
      const hitAreaRect = hitArea?.getBoundingClientRect()
      if (!shellRect || !panelRect || !listRect || !contentRect || !hitAreaRect) return null
      const x = Math.max(4, Math.round(shellRect.left / 2))
      const y = Math.round(Math.min(window.innerHeight - 20, Math.max(20, contentRect.top + 90)))
      const node = document.elementFromPoint(x, y)
      const hitPart = node instanceof Element
        ? node.closest('[data-tabout-part]')?.getAttribute('data-tabout-part') || ''
        : ''
      return {
        x,
        y,
        hitPart,
        shellLeft: Math.round(shellRect.left * 100) / 100,
        panelLeft: Math.round(panelRect.left * 100) / 100,
        listLeft: Math.round(listRect.left * 100) / 100,
        contentLeft: Math.round(contentRect.left * 100) / 100,
        hitAreaLeft: Math.round(hitAreaRect.left * 100) / 100,
        hitAreaRight: Math.round(hitAreaRect.right * 100) / 100,
        hitAreaWidth: Math.round(hitAreaRect.width * 100) / 100,
        viewportWidth: window.innerWidth
      }
    })()`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected history left gutter target to be measurable')

  const beforeScrollTop = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => ({
      dashboardScrollTop: document.querySelector('.scroll-region')?.scrollTop ?? 0,
      historyScrollTop: document.querySelector('.history-entry-list')?.scrollTop ?? 0
    }))()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  await wait(80)

  for (let index = 0; index < 4; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 36,
      x: target.x,
      y: target.y
    })
    await wait(60)
  }
  await wait(160)

  const after = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => ({
      dashboardScrollTop: document.querySelector('.scroll-region')?.scrollTop ?? 0,
      historyScrollTop: document.querySelector('.history-entry-list')?.scrollTop ?? 0
    }))()`
  }).then((result: any) => result.result.value)

  return { target, beforeScrollTop, after }
}

async function measureNarrowViewportScrollbarEdges(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      document.querySelector('.history-entry-list')?.scrollTo(0, 0)
      document.querySelector('.scroll-region')?.scrollTo(0, 0)
      document.scrollingElement?.scrollTo(0, 0)
    })()`
  })
  await Promise.all([
    waitForDashboardSettled(session),
    waitForScrollTop(session, '.history-entry-list')
  ])

  async function readSnapshot() {
    return evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const round = (value) => Math.round(value * 100) / 100
        const shell = document.querySelector('[data-tabout="dashboard-shell"]')
        const main = document.querySelector('.dashboard-main')
        const scrollRegion = document.querySelector('.scroll-region')
        const historyList = document.querySelector('.history-entry-list')
        const historyContent = document.querySelector('.history-entry-list-content')
        const historyScrollbar = document.querySelector('.history-entry-scrollbar')
        const historyTrack = document.querySelector('.history-entry-scrollbar-track')
        const historyThumb = document.querySelector('.history-entry-scrollbar-thumb')
        const filter = document.querySelector('[data-tabout="filter-query"]')
        const sourceSwitch = document.querySelector('[data-tabout="source-switch"]')
        const headerControls = document.querySelector('.header-controls')
        const missions = document.querySelector('.missions:not(.missions-empty)')
        const card = document.querySelector('[data-tabout="domain-card"] .mission-card') || document.querySelector('.mission-card')
        const shellRect = shell?.getBoundingClientRect()
        const mainRect = main?.getBoundingClientRect()
        const scrollRegionRect = scrollRegion?.getBoundingClientRect()
        const historyListRect = historyList?.getBoundingClientRect()
        const historyContentRect = historyContent?.getBoundingClientRect()
        const historyScrollbarRect = historyScrollbar?.getBoundingClientRect()
        const historyTrackRect = historyTrack?.getBoundingClientRect()
        const historyThumbRect = historyThumb?.getBoundingClientRect()
        const filterRect = filter?.getBoundingClientRect()
        const sourceSwitchRect = sourceSwitch?.getBoundingClientRect()
        const headerControlsRect = headerControls?.getBoundingClientRect()
        const missionsRect = missions?.getBoundingClientRect()
        const cardRect = card?.getBoundingClientRect()
        if (
          !(scrollRegion instanceof HTMLElement) ||
          !(historyList instanceof HTMLElement) ||
          !shellRect ||
          !mainRect ||
          !scrollRegionRect ||
          !historyListRect ||
          !historyContentRect ||
          !historyScrollbarRect ||
          !historyTrackRect ||
          !historyThumbRect ||
          !filterRect ||
          !sourceSwitchRect ||
          !headerControlsRect ||
          !missionsRect ||
          !cardRect
        ) {
          return null
        }
        const shellStyles = window.getComputedStyle(shell)
        const historyThumbStyles = window.getComputedStyle(historyThumb)
        const scrollbarSize = Number.parseFloat(shellStyles.getPropertyValue('--dashboard-scrollbar-size')) || 0
        const scrollbarPadding = Number.parseFloat(shellStyles.getPropertyValue('--dashboard-scrollbar-padding')) || 0
        const scrollbarThumbSize = Number.parseFloat(shellStyles.getPropertyValue('--dashboard-scrollbar-thumb-size')) || 0
        const scrollbarPaddingHover = Number.parseFloat(shellStyles.getPropertyValue('--dashboard-scrollbar-padding-hover')) || 0
        const scrollbarThumbSizeHover = Number.parseFloat(shellStyles.getPropertyValue('--dashboard-scrollbar-thumb-size-hover')) || 0
        const historyThumbBorderLeft = Number.parseFloat(historyThumbStyles.borderLeftWidth) || 0
        const historyThumbBorderRight = Number.parseFloat(historyThumbStyles.borderRightWidth) || 0
        const pageGutter = Number.parseFloat(shellStyles.getPropertyValue('--dashboard-page-gutter')) || 0
        const historyTargetX = Math.round(Math.min(historyContentRect.right - 24, Math.max(historyContentRect.left + 24, historyContentRect.left + historyContentRect.width / 3)))
        const historyTargetY = Math.round(Math.min(window.innerHeight - 24, Math.max(24, historyContentRect.top + 84)))
        const historyRailTargetX = Math.round(historyTrackRect.left + historyTrackRect.width / 2)
        const historyRailTargetY = Math.round(Math.min(historyScrollbarRect.bottom - 24, Math.max(historyScrollbarRect.top + 24, historyTrackRect.top + 84)))
        const historyThumbCenterX = Math.round(historyThumbRect.left + historyThumbRect.width / 2)
        const historyThumbCenterY = Math.round(historyThumbRect.top + historyThumbRect.height / 2)
        const dashboardTargetX = Math.round(Math.min(cardRect.right - 24, Math.max(cardRect.left + 24, cardRect.left + cardRect.width / 3)))
        const dashboardTargetY = Math.round(Math.min(window.innerHeight - 24, Math.max(24, cardRect.top + Math.min(84, cardRect.height / 2))))
        const historyNode = document.elementFromPoint(historyTargetX, historyTargetY)
        const dashboardNode = document.elementFromPoint(dashboardTargetX, dashboardTargetY)
        return {
          viewportWidth: window.innerWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body?.scrollWidth || 0,
          shellRight: round(shellRect.right),
          mainLeft: round(mainRect.left),
          mainRight: round(mainRect.right),
          scrollRegionLeft: round(scrollRegionRect.left),
          scrollRegionRight: round(scrollRegionRect.right),
          scrollRegionWidth: round(scrollRegionRect.width),
          scrollRegionNativeTrackWidth: scrollRegion.offsetWidth - scrollRegion.clientWidth,
          scrollRegionClientHeight: scrollRegion.clientHeight,
          scrollRegionScrollHeight: scrollRegion.scrollHeight,
          scrollRegionScrollTop: round(scrollRegion.scrollTop),
          historyListRight: round(historyListRect.right),
          historyScrollbarLeft: round(historyScrollbarRect.left),
          historyScrollbarRight: round(historyScrollbarRect.right),
          historyScrollbarWidth: round(historyScrollbarRect.width),
          historyTrackRight: round(historyTrackRect.right),
          historyTrackWidth: round(historyTrackRect.width),
          historyThumbRight: round(historyThumbRect.right),
          historyThumbWidth: round(historyThumbRect.width),
          historyThumbVisibleRight: round(historyThumbRect.right - historyThumbBorderRight),
          historyThumbVisibleWidth: round(historyThumbRect.width - historyThumbBorderLeft - historyThumbBorderRight),
          historyThumbBorderLeft: round(historyThumbBorderLeft),
          historyThumbBorderRight: round(historyThumbBorderRight),
          historyTrackCursor: window.getComputedStyle(historyTrack).cursor,
          historyThumbCursor: window.getComputedStyle(historyThumb).cursor,
          historyListClientHeight: historyList.clientHeight,
          historyListScrollHeight: historyList.scrollHeight,
          historyListScrollTop: round(historyList.scrollTop),
          filterLeft: round(filterRect.left),
          filterRight: round(filterRect.right),
          sourceSwitchRight: round(sourceSwitchRect.right),
          headerControlsRight: round(headerControlsRect.right),
          missionsRight: round(missionsRect.right),
          cardLeft: round(cardRect.left),
          cardRight: round(cardRect.right),
          pageGutter,
          scrollbarSize,
          scrollbarPadding,
          scrollbarThumbSize,
          scrollbarPaddingHover,
          scrollbarThumbSizeHover,
          historyTargetX,
          historyTargetY,
          historyRailTargetX,
          historyRailTargetY,
          historyThumbCenterX,
          historyThumbCenterY,
          dashboardTargetX,
          dashboardTargetY,
          historyHitClass: historyNode instanceof Element ? historyNode.className || '' : '',
          historyHitPart: historyNode instanceof Element ? historyNode.closest('[data-tabout-part]')?.getAttribute('data-tabout-part') || '' : '',
          dashboardHitClass: dashboardNode instanceof Element ? dashboardNode.className || '' : '',
          dashboardHitTabout: dashboardNode instanceof Element ? dashboardNode.closest('[data-tabout]')?.getAttribute('data-tabout') || '' : '',
          windowScrollX: window.scrollX,
          documentScrollLeft: document.scrollingElement?.scrollLeft || 0
        }
      })()`
    }).then((result: any) => result.result.value)
  }

  const initial = await readSnapshot()
  assert.ok(initial, 'expected narrow viewport scrollbar geometry to be measurable')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.historyRailTargetX,
    y: initial.historyRailTargetY
  })
  await wait(360)
  const afterHistoryRailHover = await readSnapshot()

  // Hover the visible thumb itself: this is what widens the rail (mirrors the
  // native ::-webkit-scrollbar-thumb:hover), so target the thumb center, not
  // the empty track gutter the rail-hover step above lands in.
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.historyThumbCenterX,
    y: initial.historyThumbCenterY
  })
  await wait(360)
  const afterHistoryThumbHover = await readSnapshot()

  // Press the thumb, then drag the pointer well OFF the rail: a native bar stays
  // at its wide grabbed size for the whole drag, so the thumb must keep hover
  // width here even though the pointer is no longer over it.
  const dragOffRailX = Math.max(20, initial.historyThumbCenterX - 220)
  const dragOffRailY = initial.historyThumbCenterY + 40
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: initial.historyThumbCenterX, y: initial.historyThumbCenterY, button: 'left', buttons: 1, clickCount: 1
  })
  await wait(60)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragOffRailX, y: dragOffRailY, button: 'left', buttons: 1 })
  await wait(220)
  const duringHistoryThumbDrag = await readSnapshot()
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragOffRailX, y: dragOffRailY, button: 'left' })
  await wait(120)
  // Reset scroll so the drag doesn't perturb the independent-scroll checks below.
  await evaluateWithNavigationRetry(session, { expression: `document.querySelector('.history-entry-list')?.scrollTo(0, 0)` })
  await waitForScrollTop(session, '.history-entry-list')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.historyTargetX,
    y: initial.historyTargetY
  })
  await wait(80)
  for (let index = 0; index < 5; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 48,
      x: initial.historyTargetX,
      y: initial.historyTargetY
    })
    await wait(50)
  }
  await wait(180)
  const afterHistoryWheel = await readSnapshot()

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.dashboardTargetX,
    y: initial.dashboardTargetY
  })
  await wait(80)
  for (let index = 0; index < 5; index += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 48,
      x: initial.dashboardTargetX,
      y: initial.dashboardTargetY
    })
    await wait(50)
  }
  await wait(180)
  const afterDashboardWheel = await readSnapshot()

  return { initial, afterHistoryRailHover, afterHistoryThumbHover, duringHistoryThumbDrag, afterHistoryWheel, afterDashboardWheel }
}

async function measureTooltipWindowBlurClose(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip for expansion window-blur smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateWithNavigationRetry(session, {
    expression: `window.dispatchEvent(new Event('blur'))`
  })
  await waitForNoTitleExpansion(session)

  const afterBlurTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('.page-chip-expanded'))
      .map((chip) => chip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, afterBlurTooltips }
}

async function measureTooltipVisibilityChangeClose(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
          .find((candidate) =>
            candidate.closest('.page-chip')?.textContent?.includes(${JSON.stringify(PAGE_CHIP_EXPANSION_SMOKE_LABEL)})
          )
        const rect = chipText?.getBoundingClientRect()
        if (rect && rect.width > 120 && rect.height > 8) {
          resolve({
            x: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2)
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a page chip for expansion visibility-change smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await wait(180)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateWithNavigationRetry(session, {
    expression: `(() => {
      const stateDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
      const hiddenDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
      try {
        Object.defineProperty(Document.prototype, 'visibilityState', {
          configurable: true,
          get: () => 'hidden'
        })
        Object.defineProperty(Document.prototype, 'hidden', {
          configurable: true,
          get: () => true
        })
        document.dispatchEvent(new Event('visibilitychange'))
      } finally {
        if (stateDescriptor) {
          Object.defineProperty(Document.prototype, 'visibilityState', stateDescriptor)
        }
        if (hiddenDescriptor) {
          Object.defineProperty(Document.prototype, 'hidden', hiddenDescriptor)
        }
      }
    })()`
  })
  await waitForNoTitleExpansion(session)

  const afterVisibilityChangeTooltips = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `Array.from(document.querySelectorAll('.page-chip-expanded'))
      .map((chip) => chip.textContent || '')`
  }).then((result: any) => result.result.value)

  return { target, first, afterVisibilityChangeTooltips }
}

async function measureActionTooltipClickClose(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const button = document.querySelector('[data-tabout-part="section-pin-button"]')
        const rect = button?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          resolve({
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            label: button.getAttribute('aria-label')
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a pin button for tooltip click-close smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const first = await waitForTooltipRect(session)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y
  })
  await wait(120)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoVisibleTooltip(session)

  const afterLeaveTooltips = await getVisibleTooltipTexts(session)

  const focusedAfterLeave = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.activeElement?.matches('[data-tabout-part="section-pin-button"]') || false`
  }).then((result: any) => result.result.value)

  return { target, first, afterLeaveTooltips, focusedAfterLeave }
}

async function measureMarkerToChipTooltipHandoff(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) =>
            candidate.textContent?.includes('Hover Handoff Title') &&
            candidate.querySelector('.chip-strip-indicator')
          )
        const marker = chip?.querySelector('.chip-strip-indicator')
        const text = chip?.querySelector('.chip-text')
        const markerRect = marker?.getBoundingClientRect()
        const textRect = text?.getBoundingClientRect()
        if (markerRect && textRect && markerRect.width > 0 && textRect.width > 0) {
          resolve({
            markerX: Math.round(markerRect.left + markerRect.width / 2),
            textX: Math.round(Math.min(textRect.right - 8, markerRect.right + 16)),
            y: Math.round(markerRect.top + markerRect.height / 2),
            markerText: marker.textContent || '',
            chipText: chip?.textContent || ''
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a chip with a strip indicator for expansion handoff smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.markerX,
    y: target.y
  })
  const markerTooltipExpansion = await waitForPageChipExpansionRect(session, 'Hover Handoff Title')
  const markerTooltip = {
    found: !!markerTooltipExpansion,
    expansion: markerTooltipExpansion,
    tooltips: await getVisibleTooltipTexts(session)
  }

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.textX,
    y: target.y
  })
  const chipTooltipExpansion = await waitForPageChipExpansionRect(session, 'Hover Handoff Title')
  const chipTooltip = {
    found: !!chipTooltipExpansion,
    expansion: chipTooltipExpansion,
    tooltips: await getVisibleTooltipTexts(session)
  }

  return { target, markerTooltip, chipTooltip }
}

async function measureShortChipTooltipAbsence(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes('Short title'))
        const textEl = chip?.querySelector('.chip-text')
        const rect = textEl?.getBoundingClientRect()
        if (rect && textEl && rect.width > 120 && rect.height > 8) {
          resolve({
            startX: Math.round(rect.left + Math.min(24, rect.width / 2)),
            y: Math.round(rect.top + rect.height / 2),
            isTruncated: textEl.classList.contains('chip-text-truncated')
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a short page chip to hover for tooltip absence smoke test')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  await wait(650)

  const tooltipCount = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `document.querySelectorAll('[data-slot="tooltip-content"]').length`
  }).then((result: any) => result.result.value)

  return { target, tooltipCount }
}

async function measureTooltipEdgeFlip(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chips = Array.from(document.querySelectorAll('.page-chip'))
          .filter((chip) => chip.textContent?.includes('viewport-edge'))
          .map((chip) => {
            const textEl = chip.querySelector('.chip-text')
            const rect = textEl?.getBoundingClientRect()
            return { rect }
          })
          .filter(({ rect }) => rect && rect.width > 120 && rect.height > 8)
          .sort((a, b) => b.rect.right - a.rect.right)

        const target = chips[0]
        if (target) {
          resolve({
            startX: Math.round(target.rect.right - 4),
            textLeft: Math.round(target.rect.left),
            textRight: Math.round(target.rect.right),
            y: Math.round(target.rect.top + target.rect.height / 2),
            viewportRight: window.innerWidth
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected a right-edge page chip to hover for expansion smoke test')

  await waitForDashboardSettled(session)
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y
  })
  const first = await waitForPageChipExpansionRect(session, 'viewport-edge')

  return { target, first }
}

async function measureCompactTitleVariantExpansion(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddCompactTitleVariantTabs?.()`
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) =>
            candidate.textContent?.includes('Order Page') &&
            candidate.textContent?.includes('productId=1060') &&
            candidate.textContent?.includes('productId=9707')
          )
        const chipRect = chip?.getBoundingClientRect()
        const titleRow = chip?.querySelector('.chip-title-row')
        const variantLabels = Array.from(chip?.querySelectorAll('.chip-title-variant-label') || [])
        const titleRect = titleRow?.getBoundingClientRect()
        const labelRects = variantLabels.map((label) => label.getBoundingClientRect())
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)
        ) {
          chip.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (
          chip instanceof HTMLElement &&
          titleRow instanceof HTMLElement &&
          chipRect &&
          titleRect &&
          labelRects.length === 2 &&
          labelRects.every((rect) => rect.width > 40 && rect.height > 8)
        ) {
          const contentRight = Math.max(titleRect.right, ...labelRects.map((rect) => rect.right)) + 20
          resolve({
            x: Math.round(titleRect.left + Math.min(24, titleRect.width / 2)),
            y: Math.round(titleRect.top + Math.min(titleRect.height / 2, 10)),
            chipWidth: Math.round(chipRect.width),
            contentWidth: Math.round(contentRight - chipRect.left),
            titleWidth: Math.round(titleRect.width),
            labelWidths: labelRects.map((rect) => Math.round(rect.width))
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected compact same-title URL variant chip for expansion width smoke')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const expansion = await waitForPageChipExpansionRect(session, 'Order Page')
  const expandedVariantLabels = await evaluateWithNavigationRetry(session, {
    returnByValue: true,
    expression: `(() => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes('Order Page'))
      return Array.from(chip?.querySelectorAll('.chip-title-variant-label') || []).map((label) => {
        const rect = label.getBoundingClientRect()
        return {
          text: label.textContent || '',
          clientWidth: Math.round((label.clientWidth || 0) * 100) / 100,
          scrollWidth: Math.round((label.scrollWidth || 0) * 100) / 100,
          width: Math.round(rect.width * 100) / 100
        }
      })
    })()`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, expansion, expandedVariantLabels }
}

async function measurePlainTitleVariantEdgeExpansion(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddPlainTitleVariantTabs?.()`
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) =>
            candidate.textContent?.includes('Plain Title Variant') &&
            candidate.textContent?.includes('focusedCommentId=667321') &&
            candidate.textContent?.includes('comment-667321')
          )
        const chipRect = chip?.getBoundingClientRect()
        const variantLabels = Array.from(chip?.querySelectorAll('.chip-title-variant-label') || [])
        const labelRects = variantLabels.map((label) => label.getBoundingClientRect())
        const overflowingLabels = variantLabels.filter((label) => label.scrollWidth - label.clientWidth > 1).length
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)
        ) {
          chip.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          labelRects.length === 2 &&
          labelRects.every((rect) => rect.width > 0 && rect.height > 8) &&
          overflowingLabels > 0
        ) {
          const slot = chip.closest('[data-tabout-part="slot"]')
          const slotOnlyPoint = (() => {
            if (!(slot instanceof HTMLElement)) return null
            const slotRect = slot.getBoundingClientRect()
            const points = [
              { x: chipRect.left + 1, y: chipRect.top + 1 },
              { x: chipRect.right - 1, y: chipRect.top + 1 },
              { x: chipRect.left + 1, y: chipRect.bottom - 1 },
              { x: chipRect.right - 1, y: chipRect.bottom - 1 },
              { x: chipRect.left + 2, y: chipRect.top + 2 },
              { x: chipRect.right - 2, y: chipRect.top + 2 },
              { x: chipRect.left + 2, y: chipRect.bottom - 2 },
              { x: chipRect.right - 2, y: chipRect.bottom - 2 }
            ]
            return points.find((point) => {
              if (point.x < slotRect.left || point.x > slotRect.right || point.y < slotRect.top || point.y > slotRect.bottom) return false
              const hit = document.elementFromPoint(point.x, point.y)
              return hit instanceof Element && slot.contains(hit) && !chip.contains(hit)
            }) || null
          })()
          const targetLabelRect = labelRects[0]
          const titleRect = chip.querySelector('.chip-title-row')?.getBoundingClientRect()
          resolve({
            x: Math.round(chipRect.right - 4),
            y: Math.round(targetLabelRect.top + targetLabelRect.height / 2),
            chipLeft: Math.round(chipRect.left),
            chipRight: Math.round(chipRect.right),
            chipWidth: Math.round(chipRect.width),
            labelClientWidths: variantLabels.map((label) => Math.round((label.clientWidth || 0) * 100) / 100),
            labelScrollWidths: variantLabels.map((label) => Math.round((label.scrollWidth || 0) * 100) / 100),
            overflowingLabels,
            viewportRight: window.innerWidth,
            surfaces: {
              ...(slotOnlyPoint ? {
                slotOnlyDefaultSurface: {
                  x: Math.round(slotOnlyPoint.x),
                  y: Math.round(slotOnlyPoint.y)
                }
              } : {}),
              labelRightEdge: {
                x: Math.round(chipRect.right - 4),
                y: Math.round(targetLabelRect.top + targetLabelRect.height / 2)
              },
              leftGutter: {
                x: Math.round(chipRect.left + 4),
                y: Math.round((titleRect?.top || chipRect.top) + (titleRect?.height || chipRect.height) / 2)
              },
              titleRightEdge: {
                x: Math.round(chipRect.right - 4),
                y: Math.round((titleRect?.top || chipRect.top) + (titleRect?.height || chipRect.height) / 2)
              }
            }
          })
        } else if (Date.now() - start > 5000) {
          resolve({
            chips: Array.from(document.querySelectorAll('.page-chip'))
              .filter((candidate) => candidate.textContent?.includes('Plain Title Variant'))
              .map((candidate) => ({
                className: candidate.className,
                text: candidate.textContent,
                variantLabels: Array.from(candidate.querySelectorAll('.chip-title-variant-label')).map((label) => label.textContent)
              })),
            missing: true
          })
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target?.surfaces, `expected plain same-title URL variant chip for edge expansion smoke: ${JSON.stringify(target)}`)

  const surfaceResults = []
  for (const [surface, point] of Object.entries(target.surfaces)) {
    const preHoverState = await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const point = ${JSON.stringify(point)}
        const slot = Array.from(document.querySelectorAll('[data-tabout-part="slot"]'))
          .find((candidate) => candidate.textContent?.includes('Plain Title Variant'))
        const chip = slot?.querySelector('.page-chip')
        const hit = document.elementFromPoint(point.x, point.y)
        return {
          hitClassName: hit instanceof Element ? hit.className : '',
          hitInsideChip: !!(chip && hit instanceof Node && chip.contains(hit)),
          hitInsideSlot: !!(slot && hit instanceof Node && slot.contains(hit)),
          hitTagName: hit instanceof Element ? hit.tagName : '',
          chipHovered: !!(chip instanceof HTMLElement && chip.matches(':hover')),
          slotHovered: !!(slot instanceof HTMLElement && slot.matches(':hover'))
        }
      })()`
    }).then((result: any) => result.result.value)

    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: (point as { x: number; y: number }).x,
      y: (point as { x: number; y: number }).y
    })
    const expansion = await waitForPageChipExpansionRect(session, 'Plain Title Variant')
    const expandedVariantLabels = await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
          .find((candidate) => candidate.textContent?.includes('Plain Title Variant'))
        return Array.from(chip?.querySelectorAll('.chip-title-variant-label') || []).map((label) => ({
          clientWidth: Math.round((label.clientWidth || 0) * 100) / 100,
          scrollWidth: Math.round((label.scrollWidth || 0) * 100) / 100,
          text: label.textContent || ''
        }))
      })()`
    }).then((result: any) => result.result.value)
    const hoverState = await evaluateWithNavigationRetry(session, {
      returnByValue: true,
      expression: `(() => {
        const point = ${JSON.stringify(point)}
        const slot = Array.from(document.querySelectorAll('[data-tabout-part="slot"]'))
          .find((candidate) => candidate.textContent?.includes('Plain Title Variant'))
        const chip = slot?.querySelector('.page-chip')
        const defaultVariant = slot?.querySelector('.chip-title-variant[data-tabout-default-variant]')
        const hit = document.elementFromPoint(point.x, point.y)
        const defaultVariantStyle = defaultVariant instanceof HTMLElement
          ? window.getComputedStyle(defaultVariant)
          : null
        return {
          defaultVariantBackground: defaultVariantStyle?.backgroundColor || '',
          defaultVariantColor: defaultVariantStyle?.color || '',
          hitClassName: hit instanceof Element ? hit.className : '',
          hitInsideChip: !!(chip && hit instanceof Node && chip.contains(hit)),
          hitInsideSlot: !!(slot && hit instanceof Node && slot.contains(hit)),
          hitTagName: hit instanceof Element ? hit.tagName : '',
          chipHovered: !!(chip instanceof HTMLElement && chip.matches(':hover')),
          slotHovered: !!(slot instanceof HTMLElement && slot.matches(':hover'))
        }
      })()`
    }).then((result: any) => result.result.value)

    surfaceResults.push({ expandedVariantLabels, expansion, hoverState, point, preHoverState, surface })

    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8
    })
    await waitForNoPageChipExpansion(session)
  }

  return { target, surfaceResults }
}

async function measureWrappedTitleVariantExpansion(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddWrappedTitleVariantTabs?.()`
  })
  await evaluateWithNavigationRetry(session, {
    expression: `document.querySelector('.scroll-region')?.scrollTo(0, 0)`
  })
  await waitForDashboardSettled(session)

  const target = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) =>
            candidate.textContent?.includes('Example Store') &&
            candidate.textContent?.includes('?example=alpha')
          )
        const chipRect = chip?.getBoundingClientRect()
        const titleRow = chip?.querySelector('.chip-title-row')
        const titleRect = titleRow?.getBoundingClientRect()
        const markerCount = titleRow?.querySelectorAll('.chip-title-suppression-marker').length || 0
        if (
          chip instanceof HTMLElement &&
          chipRect &&
          (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)
        ) {
          chip.scrollIntoView({ block: 'center', inline: 'nearest' })
          setTimeout(wait, 120)
          return
        }
        if (
          chip instanceof HTMLElement &&
          titleRow instanceof HTMLElement &&
          chipRect &&
          titleRect &&
          titleRect.width > 120 &&
          titleRect.height > 8
        ) {
          const lineHeight = Number.parseFloat(window.getComputedStyle(titleRow).lineHeight) || 16.25
          resolve({
            x: Math.round(titleRect.left + Math.min(24, titleRect.width / 2)),
            y: Math.round(titleRect.top + Math.min(titleRect.height / 2, 10)),
            chipWidth: Math.round(chipRect.width),
            titleText: titleRow.textContent || '',
            titleWidth: Math.round(titleRect.width),
            titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
            markerCount
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  assert.ok(target, 'expected wrapped same-title URL variant chip for expansion width smoke')

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y
  })
  const expansion = await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
          .find((candidate) => candidate.textContent?.includes('Example Store'))
        const titleRow = chip?.querySelector('.chip-title-row')
        const chipRect = chip?.getBoundingClientRect()
        const titleRect = titleRow?.getBoundingClientRect()
        if (
          chip instanceof HTMLElement &&
          titleRow instanceof HTMLElement &&
          chipRect &&
          titleRect &&
          chipRect.width > 0 &&
          chipRect.height > 0
        ) {
          const lineHeight = Number.parseFloat(window.getComputedStyle(titleRow).lineHeight) || 16.25
          resolve({
            width: Math.round(chipRect.width),
            titleText: titleRow.textContent || '',
            titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
            titleLineTexts: Array.from(titleRow.querySelectorAll('.page-chip-expanded-line')).map((line) => line.textContent || '')
          })
        } else if (Date.now() - start > 2000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)

  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8
  })
  await waitForNoPageChipExpansion(session)

  return { target, expansion }
}

async function measureDuplicateStackGeometry(session: CdpSession) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddDuplicateStackTabs?.()`
  })

  return evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const start = Date.now()
      const wait = () => {
        const chip = Array.from(document.querySelectorAll('.page-chip'))
          .find((candidate) => candidate.textContent?.includes('Duplicate Stack Target'))
        const frame = chip?.querySelector('.chip-favicon-stack')
        const layers = Array.from(frame?.querySelectorAll('.chip-favicon-stack-layer') || [])
        if (chip instanceof HTMLElement && frame instanceof HTMLElement && layers.length >= 2) {
          const rectFor = (element) => {
            const rect = element.getBoundingClientRect()
            return {
              left: Math.round(rect.left * 100) / 100,
              top: Math.round(rect.top * 100) / 100,
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100
            }
          }
          resolve({
            chip: rectFor(chip),
            frame: rectFor(frame),
            layers: layers.map(rectFor),
            className: frame.className
          })
        } else if (Date.now() - start > 5000) {
          resolve(null)
        } else {
          setTimeout(wait, 50)
        }
      }
      wait()
    })`
  }).then((result: any) => result.result.value)
}

test('dashboard cards repack when the viewport resizes', async ({ page, context }) => {
  test.setTimeout(180_000)
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const session = cdpSessionAdapter(await context.newCDPSession(page))

  if (RUN_HISTORY_SCROLLBAR_OVERLAP_ONLY) {
    const historyScrollbarOverlap = await measureHistoryEntryExpansionWheelScroll(session)
    assertHistoryScrollbarLayering(historyScrollbarOverlap)
    return
  }

  const wide = await measureDashboard(session, 1420)
  const tailFill = await measureTruncatedTitleTailFill(session)
  const constrained = await measureDashboard(session, 920)
  const narrow = await measureDashboard(session, 760)
  const initialTooltipMeasureNodes = await measureInitialTooltipMeasureNodes(session)

  assert.ok(wide.cardCount >= 12, `dashboard should render enough cards for a column smoke test: ${JSON.stringify(wide)}`)
  assert.ok(wide.columns > narrow.columns, `expected columns to shrink after resize, got ${wide.columns} -> ${narrow.columns}`)
  assert.notEqual(wide.firstWidth, narrow.firstWidth, 'card width should respond to viewport resize')
  assert.ok(Math.abs(wide.headerControlsRight - wide.missionsRight) <= 1, `wide header controls should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(wide)}`)
  assert.ok(Math.abs(wide.sourceSwitchRight - wide.missionsRight) <= 1, `wide source switch should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(wide)}`)
  assert.ok(Math.abs(constrained.headerControlsRight - constrained.missionsRight) <= 1, `constrained history layout header controls should align to the scrollable missions grid: ${JSON.stringify(constrained)}`)
  assert.ok(Math.abs(constrained.sourceSwitchRight - constrained.missionsRight) <= 1, `constrained history layout source switch should align to the scrollable missions grid: ${JSON.stringify(constrained)}`)
  assert.equal(initialTooltipMeasureNodes.pageChipMeasureNodes, 0, `page chips should not mount hidden tooltip measurement nodes before hover: ${JSON.stringify(initialTooltipMeasureNodes)}`)
  assert.equal(initialTooltipMeasureNodes.historyExpansionMeasureNodes, 0, `history rows should not mount hidden expansion measurement nodes before hover: ${JSON.stringify(initialTooltipMeasureNodes)}`)
  assert.equal(initialTooltipMeasureNodes.visibleTooltipNodes, 0, `dashboard should not show tooltip popups before hover: ${JSON.stringify(initialTooltipMeasureNodes)}`)

  assert.ok(tailFill.history.truncatedCount > 0, `smoke fixture should render truncated history titles for the tail-fill check: ${JSON.stringify(tailFill)}`)
  assert.equal(tailFill.history.clampedCount, tailFill.history.truncatedCount, `every truncated history title should swap to captured clamped lines: ${JSON.stringify(tailFill)}`)
  assert.ok(tailFill.history.tailOverflows, `each clamped history title's last line should overflow the box so the fade lands on glyphs: ${JSON.stringify(tailFill)}`)
  assert.ok(tailFill.history.headsFit, `clamped history head lines should reproduce the natural wrap without overflowing: ${JSON.stringify(tailFill)}`)
  assert.ok(tailFill.chips.truncatedCount > 0, `smoke fixture should render truncated page chips for the tail-fill check: ${JSON.stringify(tailFill)}`)
  assert.equal(tailFill.chips.clampedCount, tailFill.chips.truncatedCount, `every truncated non-variant page chip should swap to captured clamped lines: ${JSON.stringify(tailFill)}`)
  assert.ok(tailFill.chips.tailOverflows, `each clamped page chip's last line should overflow the box so the fade lands on glyphs: ${JSON.stringify(tailFill)}`)
  assert.ok(tailFill.clampedPillsKeepGlyph, `suppression pills inside clamped rows should keep their live glyph: ${JSON.stringify(tailFill)}`)
  assert.equal(tailFill.untruncatedWithClamp, 0, `titles that fit should keep their natural rendering: ${JSON.stringify(tailFill)}`)

  const horizontalScroll = await measureHorizontalScrollLock(session)
  assert.equal(horizontalScroll.overflowX, 'hidden', `scroll region should hide horizontal overflow: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.overscrollBehaviorX, 'none', `scroll region should suppress x-axis overscroll: ${JSON.stringify(horizontalScroll)}`)
  assert.ok(horizontalScroll.scrollWidth > horizontalScroll.clientWidth, `smoke probe should create horizontal overflow: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.initialScrollLeft, 0, `scroll region should start at the left edge: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.afterScrollLeft, 0, `horizontal wheel input should not move the scroll region sideways: ${JSON.stringify(horizontalScroll)}`)

  const historyLeftGutterScroll = await measureHistoryLeftGutterWheelScroll(session)
  assert.ok(historyLeftGutterScroll.target.shellLeft > 40, `wide smoke viewport should create a left dashboard gutter: ${JSON.stringify(historyLeftGutterScroll)}`)
  assert.equal(historyLeftGutterScroll.target.listLeft, 0, `history scrollbox should bleed to the viewport edge on wide screens: ${JSON.stringify(historyLeftGutterScroll)}`)
  assert.ok(
    historyLeftGutterScroll.target.x >= historyLeftGutterScroll.target.hitAreaLeft &&
      historyLeftGutterScroll.target.x <= historyLeftGutterScroll.target.hitAreaRight,
    `history left gutter wheel target should land inside the scroll hit area: ${JSON.stringify(historyLeftGutterScroll)}`
  )
  assert.equal(historyLeftGutterScroll.target.hitPart, 'history-scroll-hit-area', `left gutter should hit the history scroll target: ${JSON.stringify(historyLeftGutterScroll)}`)
  assert.ok(
    historyLeftGutterScroll.after.historyScrollTop - historyLeftGutterScroll.beforeScrollTop.historyScrollTop > 72,
    `wheel input in the left gutter should scroll activation history: ${JSON.stringify(historyLeftGutterScroll)}`
  )
  assert.equal(
    historyLeftGutterScroll.after.dashboardScrollTop,
    historyLeftGutterScroll.beforeScrollTop.dashboardScrollTop,
    `left gutter history scroll should not scroll the domain cards pane: ${JSON.stringify(historyLeftGutterScroll)}`
  )

  const narrowScrollbarEdges = await measureNarrowViewportScrollbarEdges(session)
  assert.ok(narrowScrollbarEdges.afterHistoryRailHover, `expected narrow history rail hover geometry: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(narrowScrollbarEdges.afterHistoryWheel, `expected narrow history wheel geometry: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(narrowScrollbarEdges.afterDashboardWheel, `expected narrow dashboard wheel geometry: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyScrollbarRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow activation history scrollbar rail should reach the viewport right edge: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.scrollRegionRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow dashboard scroll region should place the native rail at the viewport right edge: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyTrackRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow activation history hover track should reach the viewport edge: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyScrollbarWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow activation history rail should use the shared scrollbar width: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyTrackWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow activation history hover track should match the native rail width: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow activation history thumb box should reach the viewport edge like the native rail: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbVisibleRight - (narrowScrollbarEdges.initial.viewportWidth - narrowScrollbarEdges.initial.scrollbarPadding)) <= 1,
    `narrow activation history visible thumb should keep the shared scrollbar padding at the viewport edge: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow activation history thumb box should match the native rail width: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbVisibleWidth - narrowScrollbarEdges.initial.scrollbarThumbSize) <= 1,
    `narrow activation history visible thumb should use the shared visible thumb width: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryRailHover.historyTrackWidth - narrowScrollbarEdges.initial.historyTrackWidth) <= 1,
    `hovering activation history should not change the interactive track width: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryThumbHover.historyThumbVisibleWidth - narrowScrollbarEdges.initial.scrollbarThumbSizeHover) <= 1,
    `hovering the activation history thumb should widen it to the shared hover thumb size: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    narrowScrollbarEdges.afterHistoryThumbHover.historyThumbVisibleWidth > narrowScrollbarEdges.initial.historyThumbVisibleWidth + 1,
    `hovering the activation history thumb should make it visibly wider than at rest: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryThumbHover.historyThumbVisibleRight - (narrowScrollbarEdges.initial.viewportWidth - narrowScrollbarEdges.initial.scrollbarPaddingHover)) <= 1,
    `the widened activation history thumb should stay inset by the hover padding, not flush to the edge: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryThumbHover.historyTrackWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `widening the thumb on hover should not change the reserved gutter width: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.duringHistoryThumbDrag.historyThumbVisibleWidth - narrowScrollbarEdges.initial.scrollbarThumbSizeHover) <= 1,
    `dragging the thumb with the pointer off the rail should keep it at hover width, not snap back: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.notEqual(narrowScrollbarEdges.initial.historyTrackCursor, 'grab', `activation history track should not use a grab cursor: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.notEqual(narrowScrollbarEdges.initial.historyThumbCursor, 'grab', `activation history thumb should not use a grab cursor: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.notEqual(narrowScrollbarEdges.afterHistoryRailHover.historyThumbCursor, 'grabbing', `activation history hover should not use a grabbing cursor: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.cardLeft - narrowScrollbarEdges.initial.pageGutter) <= 1,
    `moving the native rail outward should keep dashboard card content at the page gutter: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.filterLeft - narrowScrollbarEdges.initial.pageGutter) <= 1,
    `moving the native rail outward should keep header/filter content at the page gutter: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    narrowScrollbarEdges.initial.cardRight <= narrowScrollbarEdges.initial.viewportWidth - narrowScrollbarEdges.initial.pageGutter + 1,
    `dashboard card content should stay inside the existing right content gutter: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.headerControlsRight - narrowScrollbarEdges.initial.missionsRight) <= 1,
    `narrow header controls should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.sourceSwitchRight - narrowScrollbarEdges.initial.missionsRight) <= 1,
    `narrow source switch should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    narrowScrollbarEdges.initial.documentScrollWidth <= narrowScrollbarEdges.initial.documentClientWidth + 1,
    `narrow scrollbar rail should not introduce horizontal page overflow: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.equal(narrowScrollbarEdges.initial.windowScrollX, 0, `narrow viewport should not scroll the page horizontally: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.equal(narrowScrollbarEdges.initial.documentScrollLeft, 0, `narrow viewport should not move the document scroller horizontally: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(
    narrowScrollbarEdges.initial.historyListScrollHeight > narrowScrollbarEdges.initial.historyListClientHeight + 8,
    `narrow activation history smoke needs an independently scrollable history list: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    narrowScrollbarEdges.initial.scrollRegionScrollHeight > narrowScrollbarEdges.initial.scrollRegionClientHeight + 8,
    `narrow dashboard smoke needs an independently scrollable card list: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    narrowScrollbarEdges.afterHistoryWheel.historyListScrollTop - narrowScrollbarEdges.initial.historyListScrollTop > 96,
    `wheel input over activation history should scroll history independently: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.equal(
    narrowScrollbarEdges.afterHistoryWheel.scrollRegionScrollTop,
    narrowScrollbarEdges.initial.scrollRegionScrollTop,
    `wheel input over activation history should not scroll the dashboard cards: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    narrowScrollbarEdges.afterDashboardWheel.scrollRegionScrollTop - narrowScrollbarEdges.afterHistoryWheel.scrollRegionScrollTop > 96,
    `wheel input over dashboard cards should scroll the dashboard independently: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterDashboardWheel.historyListScrollTop - narrowScrollbarEdges.afterHistoryWheel.historyListScrollTop) <= 1,
    `wheel input over dashboard cards should not scroll activation history: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  // The native .scroll-region rail must actually render the custom
  // ::-webkit-scrollbar at the shared width. getBoundingClientRect cannot see a
  // scrollbar pseudo-element, but the layout width it consumes (offsetWidth -
  // clientWidth) is an exact proxy: 8px = custom bar honored, 0 = a standard
  // overlay bar is silently overriding it (the bug this guards against), ~15px
  // = an unstyled standard bar. Without this the history mirror could match a
  // reference bar that the browser never paints.
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.scrollRegionNativeTrackWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow dashboard scroll region must render the custom ::-webkit-scrollbar at the shared width, not a standard/overlay bar: ${JSON.stringify(narrowScrollbarEdges)}`
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.scrollRegionNativeTrackWidth - narrowScrollbarEdges.initial.historyScrollbarWidth) <= 1,
    `narrow dashboard native rail and activation history rail must occupy the same width: ${JSON.stringify(narrowScrollbarEdges)}`
  )

  const shortTooltip = await measureShortChipTooltipAbsence(session)
  assert.equal(shortTooltip.target.isTruncated, false, `short chip text should fit for tooltip absence smoke test: ${JSON.stringify(shortTooltip)}`)
  assert.equal(shortTooltip.tooltipCount, 0, `page chip should not show a tooltip when its text fits: ${JSON.stringify(shortTooltip)}`)

  const contextMenuSave = await measurePageChipContextMenuSave(session)
  assert.ok(contextMenuSave.firstOpenState.itemTexts.includes('Reload'), `right-clicking a live page chip should show Reload: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.firstOpenState.itemTexts.includes('Duplicate'), `right-clicking a live page chip should show Duplicate: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyItem.text, 'Copy page title text', `right-clicking a live page chip should show the copy-title action: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyResult.copiedText, 'Short title', `Copy page title text should copy the chip title: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyResult.menuOpen, false, `context menu should close after choosing Copy page title text: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.saveItem.text, 'Save page', `right-clicking a live page chip should show the save action: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.saveResult.menuOpen, false, `context menu should close after choosing Save page: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.saveResult.pageKeys.includes('https://tab-out-smoke-01.com/docs/1'), `Save page should persist the chip URL: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.saveResult.setCount > 0, `Save page should write through chrome.storage.local: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.activeBefore, 'Tabs', `outside-click smoke should start on the Tabs source: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.activeAfter, 'Tabs', `clicking outside an open context menu should dismiss it without activating the underlying source button: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.menuOpen, false, `outside click should dismiss the context menu: ${JSON.stringify(contextMenuSave)}`)

  const expansion = await measureTooltipFreeze(session)
  assert.ok(expansion.first, `page chip should expand in place on hover: ${JSON.stringify(expansion)}`)
  assert.ok(expansion.second, `page chip should stay expanded during an in-chip pointer move: ${JSON.stringify(expansion)}`)
  assert.ok((expansion.first.width || 0) > expansion.target.textRight - expansion.target.textLeft + 8, `page chip expansion should grow wider than the resting text: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs((expansion.first.textLeft || 0) - expansion.target.textLeftExact) <= 0.1, `page chip expanded text should keep the original chip text x-origin: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs((expansion.first.textTop || 0) - expansion.target.textTopExact) <= 0.1, `page chip expanded text should keep the original chip text y-origin: ${JSON.stringify(expansion)}`)
  assert.equal(expansion.first.visibleTooltipCount, 0, `page chip text expansion should not create a tooltip popup: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs(expansion.first.left - expansion.second.left) <= 1, `page chip expansion left should freeze after open: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs(expansion.first.top - expansion.second.top) <= 1, `page chip expansion top should freeze after open: ${JSON.stringify(expansion)}`)
  assert.equal(expansion.afterScrollExpandedCount, 0, `page chip expansion should close when the dashboard scrolls: ${JSON.stringify(expansion)}`)

  const tooltipHitArea = await measureTooltipTextPaddingHitArea(session)
  assert.ok(tooltipHitArea.target.hitTop < tooltipHitArea.target.textTop, `expansion hit area should include space above chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.target.hitBottom > tooltipHitArea.target.textBottom, `expansion hit area should include space below chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.target.chipSurfaceX < tooltipHitArea.target.hitLeft, `surface-hover smoke should target chip space outside the text hit area: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.above?.text.includes('enough tooltip text'), `page chip should expand from the vertical space above chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.below?.text.includes('enough tooltip text'), `page chip should expand from the vertical space below chip text: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(tooltipHitArea.chipSurface?.text.includes('enough tooltip text'), `page chip should expand from the non-text chip surface: ${JSON.stringify(tooltipHitArea)}`)
  assert.equal(tooltipHitArea.above?.visibleTooltipCount, 0, `page chip expansion from hit-area padding should not create a tooltip popup: ${JSON.stringify(tooltipHitArea)}`)
  assert.equal(tooltipHitArea.chipSurface?.visibleTooltipCount, 0, `page chip expansion from the non-text chip surface should not create a tooltip popup: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.textLeft || 0) - tooltipHitArea.target.textLeftExact) <= 0.1, `expanded chip text x-origin should stay precise from the padding hit area: ${JSON.stringify(tooltipHitArea)}`)
  assert.ok(Math.abs((tooltipHitArea.above.textTop || 0) - tooltipHitArea.target.textTopExact) <= 0.1, `expanded chip text y-origin should stay precise from the padding hit area: ${JSON.stringify(tooltipHitArea)}`)

  const internalPointerMoveExpansion = await measurePageChipInternalPointerMoveExpansion(session)
  assert.equal(internalPointerMoveExpansion.before, 0, `internal pointer-move smoke should start without an expanded chip: ${JSON.stringify(internalPointerMoveExpansion)}`)
  assert.ok(
    internalPointerMoveExpansion.expansion?.text.includes('enough tooltip text'),
    `page chip should expand when pointer movement starts inside the chip surface: ${JSON.stringify(internalPointerMoveExpansion)}`
  )
  assert.equal(
    internalPointerMoveExpansion.expansion?.visibleTooltipCount,
    0,
    `internal pointer-move expansion should not create a tooltip popup: ${JSON.stringify(internalPointerMoveExpansion)}`
  )

  const activeStateTooltip = await measureTooltipAfterActiveStateChanges(session)
  assert.equal(activeStateTooltip.activeTarget.activeFrame, true, `active-state smoke target should start with an active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.equal(activeStateTooltip.inactiveTarget.activeFrame, false, `active-state smoke target should lose the active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.activeTooltip, `page chip should expand after the chip becomes active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.inactiveTooltip, `page chip should expand after the chip stops being active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textLeft || 0) - activeStateTooltip.activeTarget.textLeftExact) <= 0.1,
    `expanded chip x-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textTop || 0) - activeStateTooltip.activeTarget.textTopExact) <= 0.1,
    `expanded chip y-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textLeft || 0) - activeStateTooltip.inactiveTarget.textLeftExact) <= 0.1,
    `expanded chip x-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textTop || 0) - activeStateTooltip.inactiveTarget.textTopExact) <= 0.1,
    `expanded chip y-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`
  )

  const suppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    suppressionMarkerLines.push(await measureSuppressionMarkerTooltipLine(session, markerLabel))
  }
  const suppressionMarkerLineNumbers = suppressionMarkerLines.map(({ result }) => result?.markerLine)
  assert.deepEqual(
    suppressionMarkerLineNumbers,
    [1, 2, 3],
    `suppression marker expansion should keep marker labels on the same visible chip lines: ${JSON.stringify(suppressionMarkerLines)}`
  )
  for (const line of suppressionMarkerLines) {
    assert.ok(line.result, `suppression marker expansion should expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.text.includes('Shared Workspace'), `suppression marker expansion should show the hidden title text in place: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 16, `suppression marker should not make wrapped expanded chip lines taller: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `suppression marker should sit centered in its expanded chip line: ${JSON.stringify(line)}`)
  }
  const compactSuppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    compactSuppressionMarkerLines.push(await measureSuppressionMarkerChipLine(session, markerLabel))
  }
  for (const line of compactSuppressionMarkerLines) {
    assert.ok(line.result, `compact suppression marker should expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 14, `compact suppression marker should stay smaller than the rendered chip line: ${JSON.stringify(line)}`)
    assert.ok(line.result.glyphHeight <= 7, `compact suppression marker glyph should stay small inside its badge: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.glyphCenterDelta) <= 0.75, `compact suppression marker glyph should sit centered inside its badge: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `compact suppression marker should sit centered in its chip line: ${JSON.stringify(line)}`)
  }

  const tooltipLineCounts = [
    await measurePageChipTooltipLineCount(session, 'Marker line one'),
    await measurePageChipTooltipLineCount(session, 'Marker line two'),
    await measurePageChipTooltipLineCount(session, 'Marker line three', {
      forcedTextWidth: 168,
      forcedMaxLines: 3
    })
  ]
  assert.deepEqual(
    tooltipLineCounts.map(({ target }) => target.chipLineCount),
    [1, 2, 3],
    `line-count smoke should cover one-, two-, and three-line chips: ${JSON.stringify(tooltipLineCounts)}`
  )
  for (const lineCount of tooltipLineCounts) {
    assert.ok(lineCount.tooltip, `page chip should expand for line-count check: ${JSON.stringify(lineCount)}`)
    assert.equal(
      lineCount.tooltip.visibleTooltipCount,
      0,
      `page chip line-count expansion should not create a tooltip popup: ${JSON.stringify(lineCount)}`
    )
    const isViewportConstrained = lineCount.tooltip.right >= lineCount.tooltip.viewportRight - 12
    if (isViewportConstrained) {
      assert.ok(
        lineCount.tooltip.tooltipLineCount >= lineCount.target.chipLineCount,
        `regular page chip expansion may add rows only when constrained by the browser viewport edge: ${JSON.stringify(lineCount)}`
      )
    } else {
      assert.equal(
        lineCount.tooltip.tooltipLineCount,
        lineCount.target.chipLineCount,
        `regular page chip expansion should match the visible chip line count when viewport width allows it: ${JSON.stringify(lineCount)}`
      )
    }
    assert.ok(
      lineCount.tooltip.right <= lineCount.tooltip.viewportRight + 1,
      `regular page chip expansion should stay within the browser viewport: ${JSON.stringify(lineCount)}`
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textLeft - lineCount.target.chipLeftExact) <= 0.1,
      `regular page chip expansion text should keep the visible chip x-origin: ${JSON.stringify(lineCount)}`
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textTop - lineCount.target.chipTopExact) <= 0.1,
      `regular page chip expansion text should keep the visible chip y-origin: ${JSON.stringify(lineCount)}`
    )
    const normalizeLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
    const chipLines = lineCount.target.chipLineTexts.map(normalizeLineText).filter(Boolean)
    const tooltipLines = lineCount.tooltip.tooltipLineTexts.map(normalizeLineText).filter(Boolean)
    assert.ok(
      tooltipLines.length >= chipLines.length,
      `regular page chip expansion should keep at least the visible chip line rows: ${JSON.stringify(lineCount)}`
    )
    for (let index = 0; index < chipLines.length - 1; index += 1) {
      assert.equal(
        tooltipLines[index],
        chipLines[index],
        `regular page chip expansion should preserve visible line breaks before the tail row: ${JSON.stringify(lineCount)}`
      )
    }
    const lastChipLine = chipLines.at(-1)
    const lastTooltipLine = tooltipLines[chipLines.length - 1]
    assert.ok(
      lastTooltipLine?.startsWith(lastChipLine),
      `regular page chip expansion tail row should start with the same visible text before revealing more: ${JSON.stringify(lineCount)}`
    )
  }
  const structuralTailTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Boundary Alpha', {
    forcedTextWidth: 170,
    forcedMaxLines: 2
  })
  assert.ok(structuralTailTooltip.tooltip, `structural-tail tooltip should open: ${JSON.stringify(structuralTailTooltip)}`)
  assert.equal(
    structuralTailTooltip.tooltip.tooltipLineCount,
    structuralTailTooltip.target.chipLineCount,
    `structural-tail tooltip should keep the visible chip line count: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.text.includes('Example Website') && structuralTailTooltip.tooltip.text.includes('Contentful'),
    `structural-tail tooltip should expand compact suppression markers into text: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('Example Website'),
    `structural-tail tooltip should widen enough for expanded non-tail suppression text instead of clipping it: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    !structuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('env-alpha') &&
      structuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('env-alpha') &&
      structuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `structural-tail tooltip should split before the structural marker without duplicating it: ${JSON.stringify(structuralTailTooltip)}`
  )
  assert.ok(
    structuralTailTooltip.tooltip.width > structuralTailTooltip.target.chipWidth + 20,
    `structural-tail tooltip should grow wider than the compact chip when non-tail markers expand: ${JSON.stringify(structuralTailTooltip)}`
  )
  const oneLineStructuralTailTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Boundary Alpha', {
    forcedTextWidth: 130,
    forcedMaxLines: 1,
    viewportWidth: 1600
  })
  assert.ok(oneLineStructuralTailTooltip.tooltip, `one-line structural-tail tooltip should open: ${JSON.stringify(oneLineStructuralTailTooltip)}`)
  assert.equal(
    oneLineStructuralTailTooltip.target.chipLineCount,
    1,
    `one-line structural-tail smoke target should render as one visible chip line: ${JSON.stringify(oneLineStructuralTailTooltip)}`
  )
  assert.equal(
    oneLineStructuralTailTooltip.tooltip.tooltipLineCount,
    1,
    `one-line structural-tail tooltip should widen enough to stay on one line: ${JSON.stringify(oneLineStructuralTailTooltip)}`
  )
  const wrappedContentfulScreenshotTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Screenshot Alpha', {
    forcedTextWidth: 280,
    forcedMaxLines: 2,
    viewportWidth: 1600
  })
  assert.ok(wrappedContentfulScreenshotTooltip.tooltip, `wrapped Contentful tooltip should open: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`)
  assert.equal(
    wrappedContentfulScreenshotTooltip.target.chipLineCount,
    2,
    `wrapped Contentful smoke target should render as two visible chip lines so line 2 carries only the trailing marker: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`
  )
  assert.equal(
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineCount,
    2,
    `wrapped Contentful tooltip should split the expanded title into two rows even when chip line 2 has no text node: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`
  )
  assert.ok(
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[0]?.includes('dev2') &&
      !wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[1]?.includes('dev2') &&
      wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `wrapped Contentful tooltip should keep dev2 on row 1 and Contentful on row 2: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`
  )
  const wrappedTrailingMarkerTooltip = await measurePageChipTooltipLineCount(session, 'Wrap Trailing Marker Alpha', {
    forcedTextWidth: 230,
    forcedMaxLines: 2,
    viewportWidth: 1600
  })
  assert.ok(wrappedTrailingMarkerTooltip.tooltip, `wrapped trailing-marker tooltip should open: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`)
  assert.equal(
    wrappedTrailingMarkerTooltip.target.chipLineCount,
    2,
    `wrapped trailing-marker chip should render as two visible lines so line 2 carries only the trailing suppression marker: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  assert.equal(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineCount,
    2,
    `wrapped trailing-marker tooltip should split when the chip wraps with only a trailing suppression marker on line 2: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  assert.ok(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[0]?.includes('Wrap Trailing Marker Alpha') &&
      !wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[0]?.includes('JIRA') &&
      wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[1]?.includes('JIRA'),
    `wrapped trailing-marker tooltip should keep the title on row 1 and drop the JIRA marker onto row 2: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  assert.ok(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `wrapped trailing-marker tooltip lines should not visually overflow: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`
  )
  const splitStructuralTailTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Line Alpha', {
    forcedTextWidth: 310,
    forcedMaxLines: 2
  })
  assert.ok(splitStructuralTailTooltip.tooltip, `split structural-tail tooltip should open: ${JSON.stringify(splitStructuralTailTooltip)}`)
  assert.equal(
    splitStructuralTailTooltip.tooltip.tooltipLineCount,
    splitStructuralTailTooltip.target.chipLineCount,
    `split structural-tail tooltip should keep the visible chip line count: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.text.includes('Shared Website') && splitStructuralTailTooltip.tooltip.text.includes('Contentful'),
    `split structural-tail tooltip should expand hidden website and source markers: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    !splitStructuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('Shared Website') &&
      splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Shared Website'),
    `split structural-tail tooltip should keep the expanded website marker on the wrapped marker line: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    !splitStructuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('env-beta'),
    `split structural-tail tooltip should not duplicate the structural marker into the first row: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('env-beta') && splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `split structural-tail tooltip should keep the structural label and trailing marker on the second visible line: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `split structural-tail tooltip lines should not visually overflow: ${JSON.stringify(splitStructuralTailTooltip)}`
  )
  const edgeConstrainedTooltip = await measurePageChipTooltipLineCount(session, 'Tooltip Edge Alpha', {
    forcedTextWidth: 310,
    forcedMaxLines: 2
  })
  assert.ok(edgeConstrainedTooltip.tooltip, `edge-constrained tooltip should open: ${JSON.stringify(edgeConstrainedTooltip)}`)
  assert.ok(
    edgeConstrainedTooltip.tooltip.right <= edgeConstrainedTooltip.tooltip.viewportRight - 12,
    `wrapped marker expansion should not grow to the browser viewport edge when the marker label fits on its wrapped line: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.tooltipLineCount >= edgeConstrainedTooltip.target.chipLineCount,
    `edge-constrained tooltip may add rows after it reaches the browser viewport edge: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.text.includes('Shared Website With Long Workspace Label For Tooltip Boundary') && edgeConstrainedTooltip.tooltip.text.includes('Contentful'),
    `edge-constrained tooltip should still expose the expanded hidden markers: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `edge-constrained tooltip lines should wrap instead of overflowing: ${JSON.stringify(edgeConstrainedTooltip)}`
  )
  const foldedTooltip = await measureFoldedPageChipTooltipTitleLineCount(session, 'Folded Tooltip Lenses', {
    forcedTextWidth: 270
  })
  assert.ok(foldedTooltip.tooltip, `folded chip should expand in place: ${JSON.stringify(foldedTooltip)}`)
  assert.equal(
    foldedTooltip.tooltip.visibleTooltipCount,
    0,
    `folded chip expansion should not create a tooltip popup: ${JSON.stringify(foldedTooltip)}`
  )
  assert.equal(
    foldedTooltip.target.titleLineCount,
    1,
    `folded chip visible title row should fit on one line for this smoke: ${JSON.stringify(foldedTooltip)}`
  )
  assert.equal(
    foldedTooltip.tooltip.titleLineCount,
    foldedTooltip.target.titleLineCount,
    `folded chip expansion title row should match the visible title row line count: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.titleText.includes('Example Optical'),
    `folded chip expansion should expand the hidden title marker inline: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.envCount > 0,
    `folded chip expansion should keep the existing env buttons in the chip: ${JSON.stringify(foldedTooltip)}`
  )
  assert.ok(
    foldedTooltip.tooltip.textWidth > foldedTooltip.target.chipTextWidth,
    `folded chip expansion should grow wider than the compact folded chip when hidden title text expands: ${JSON.stringify(foldedTooltip)}`
  )
  const foldedWrappedTooltip = await measureFoldedPageChipTooltipTitleLineCount(session, 'Folded Tooltip Lenses', {
    forcedTextWidth: 160
  })
  assert.ok(foldedWrappedTooltip.tooltip, `wrapped folded chip should expand in place: ${JSON.stringify(foldedWrappedTooltip)}`)
  assert.equal(
    foldedWrappedTooltip.tooltip.visibleTooltipCount,
    0,
    `wrapped folded chip expansion should not create a tooltip popup: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.target.titleLineCount > 1,
    `wrapped folded chip visible title row should span multiple lines for this smoke: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.equal(
    foldedWrappedTooltip.tooltip.titleLineCount,
    foldedWrappedTooltip.target.titleLineCount,
    `wrapped folded chip expansion title row should keep the visible title line breaks: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.titleText.includes('Example Optical'),
    `wrapped folded chip expansion should still expand the hidden title marker: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.envCount > 0,
    `wrapped folded chip expansion should keep the existing env buttons in the chip: ${JSON.stringify(foldedWrappedTooltip)}`
  )
  const foldedEnvHover = await measureFoldedEnvHoverTooltips(session, 'Folded Tooltip Lenses')
  assert.deepEqual(
    foldedEnvHover.tooltipTexts,
    [],
    `hovering a folded env button should not open a tooltip: ${JSON.stringify(foldedEnvHover)}`
  )

  const originalSlotLeave = await measurePageChipOriginalSlotLeave(session)
  assert.equal(
    originalSlotLeave.first.visibleTooltipCount,
    0,
    `page chip expansion should not create a tooltip popup: ${JSON.stringify(originalSlotLeave)}`
  )
  assert.ok(
    originalSlotLeave.afterOriginalSlotLeave,
    `page chip should STAY expanded while the pointer is inside the grown bounds past the original slot, so the cursor can travel onto the revealed content instead of blinking shut at the seam: ${JSON.stringify(originalSlotLeave)}`
  )
  assert.ok(
    !originalSlotLeave.afterLeaveTooltips.some((text: string) => text === originalSlotLeave.first.text),
    `page chip expansion should collapse once the pointer leaves the expanded chip entirely: ${JSON.stringify(originalSlotLeave)}`
  )

  const popupClickFocus = await measureTooltipPopupClickFocus(session)
  assert.equal(popupClickFocus.popupStyle?.cursor, 'default', `expanded page chip should keep the default cursor: ${JSON.stringify(popupClickFocus)}`)
  assert.equal(popupClickFocus.first.visibleTooltipCount, 0, `clickable expanded page chip should not create a tooltip popup: ${JSON.stringify(popupClickFocus)}`)
  assert.ok(
    popupClickFocus.updates.some((update: { kind: string; args: [number, { active?: boolean }] }) => (
      update.kind === 'tab' && update.args[1]?.active === true
    )),
    `clicking the expanded page chip should focus the matching tab: ${JSON.stringify(popupClickFocus)}`
  )
  assert.ok(
    popupClickFocus.updates.some((update: { kind: string; args: [number, { focused?: boolean }] }) => (
      update.kind === 'window' && update.args[1]?.focused === true
    )),
    `clicking the expanded page chip should focus the matching window: ${JSON.stringify(popupClickFocus)}`
  )
  const historyPopupClickFocus = await measureHistoryEntryExpansionClickFocus(session)
	  assert.equal(historyPopupClickFocus.expandedStyle?.cursor, 'default', `expanded history entry should keep the default cursor: ${JSON.stringify(historyPopupClickFocus)}`)
	  assert.equal(historyPopupClickFocus.expandedStyle?.pointerEvents, 'none', `expanded history entry should let native pointer and wheel input reach the original row underneath: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.equal(historyPopupClickFocus.first.visibleTooltipCount, 0, `expanded history entry should not create a tooltip popup: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.ok(
    historyPopupClickFocus.updates.some((update: { kind: string; args: [number, { active?: boolean }] }) => (
      update.kind === 'tab' && update.args[1]?.active === true
    )),
    `clicking the expanded history entry should focus the matching tab: ${JSON.stringify(historyPopupClickFocus)}`
  )
  assert.ok(
    historyPopupClickFocus.updates.some((update: { kind: string; args: [number, { focused?: boolean }] }) => (
      update.kind === 'window' && update.args[1]?.focused === true
    )),
    `clicking the expanded history entry should focus the matching window: ${JSON.stringify(historyPopupClickFocus)}`
  )

  const popupWheelScroll = await measureTooltipPopupWheelScroll(session)
  assert.ok(popupWheelScroll.first, `page chip should expand before wheel check: ${JSON.stringify(popupWheelScroll)}`)
  assert.equal(popupWheelScroll.first.visibleTooltipCount, 0, `expanded page chip wheel target should not create a tooltip popup: ${JSON.stringify(popupWheelScroll)}`)
  assert.ok(
    popupWheelScroll.after.scrollTop - popupWheelScroll.beforeScrollTop > 72,
    `repeated wheel input over an expanded page chip should keep scrolling the dashboard: ${JSON.stringify(popupWheelScroll)}`
  )
  // Scroll no longer dismisses the expansion on its own; this wheel input scrolls
  // far enough (144px) that the ~43px chip slot moves out from under the resting
  // pointer, so the pointer-left-the-area close fires. Either way it ends closed.
  assert.equal(
    popupWheelScroll.after.expandedCount,
    0,
    `page chip expansion should close once the chip slot scrolls out from under the pointer: ${JSON.stringify(popupWheelScroll)}`
  )
  assert.equal(
    popupWheelScroll.afterLeaveExpandedCount,
    0,
    `page chip expansion should stay closed after the pointer leaves the chip's slot area: ${JSON.stringify(popupWheelScroll)}`
  )

  const historyPopupWheelScroll = await measureHistoryEntryExpansionWheelScroll(session)
  assertHistoryScrollbarLayering(historyPopupWheelScroll)
  assert.ok(
    Math.abs(historyPopupWheelScroll.first.titleLeft - historyPopupWheelScroll.target.titleLeftExact) <= 0.1,
    `expanded history entry should keep the title text x-origin: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    Math.abs(historyPopupWheelScroll.first.titleTop - historyPopupWheelScroll.target.titleTopExact) <= 0.1,
    `expanded history entry should keep the title text y-origin: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.scrollbarGeometry,
    `history panel should render a local scrollbar mirror: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    Math.abs(historyPopupWheelScroll.scrollbarGeometry.scrollbarRight - historyPopupWheelScroll.scrollbarGeometry.panelRight) <= 1,
    `history scrollbar mirror should sit on the history panel edge: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.scrollbarGeometry.listRight - historyPopupWheelScroll.scrollbarGeometry.scrollbarRight > 400,
    `history scrollbox should stay wide for expansion while the visible scrollbar stays local: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.scrollbarGeometry.nativeScrollbarWidth,
    'none',
    `native history scrollbar should be hidden behind the local mirror: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(historyPopupWheelScroll.first.visibleTooltipCount, 0, `history expansion should not create a tooltip popup: ${JSON.stringify(historyPopupWheelScroll)}`)
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedOpen,
    true,
    `history entry should keep an explicit expanded-open class while expanded: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.rowExpandedOpen,
    true,
    `dimmed history row should carry expanded-open state on the opacity owner while expanded: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    Number(historyPopupWheelScroll.tooltipOpenEntryState.expandedZIndex) > Number(historyPopupWheelScroll.tooltipOpenEntryState.scrollbarZIndex),
    `expanded history entry should paint above the local scrollbar mirror: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.rowOpacity,
    '1',
    `dimmed history row should use full opacity while hovered and expanded: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.match(
    historyPopupWheelScroll.tooltipOpenEntryState.backgroundColor,
    /^(rgb|color)\(/,
    `expanded history entry should use an opaque background: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.doesNotMatch(
    historyPopupWheelScroll.tooltipOpenEntryState.backgroundColor,
    /rgba\([^)]*, 0\.\d+\)/,
    `expanded history entry background should not let content underneath show through: ${JSON.stringify(historyPopupWheelScroll)}`
  )
	  assert.ok(
	    historyPopupWheelScroll.expandedOnlyHitTarget.visualText.includes('Low score history item'),
	    `expanded history entry should remain visually rendered outside the original history pane: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.expandedOnlyHitTarget.hitInsideExpanded,
	    false,
	    `expanded history entry should stay pointer-transparent so wheel input reaches the scroll list: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
  assert.equal(
    historyPopupWheelScroll.expandedOnlyClipCheck.hitInsideExpanded,
    true,
    `expanded history entry should remain visibly hit-testable outside the clipped history list when pointer events are enabled for measurement: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterOriginalSlotLeave,
    null,
    `history entry should collapse when the pointer leaves the original entry slot, even inside the grown bounds: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.notEqual(
    historyPopupWheelScroll.target.titleWebkitLineClamp,
    '2',
    `history entry title should use the PageChip fade mask instead of CSS line-clamp ellipsis: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.target.titleMaskImage && historyPopupWheelScroll.target.titleMaskImage !== 'none',
    `truncated history entry title should use a fade mask: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    historyPopupWheelScroll.target.titleHeight > historyPopupWheelScroll.target.titleLineHeight * 1.5,
    `long history entry title should render as two visible lines: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  const historyFaviconHitArea = await measureHistoryEntryExpansionSurfaceHitArea(session)
  assert.ok(historyFaviconHitArea.above?.text.includes('Low score history item'), `hovering the vertical space above the history favicon should expand the entry: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.ok(historyFaviconHitArea.below?.text.includes('Low score history item'), `hovering the vertical space below the history favicon should expand the entry: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.deepEqual(historyFaviconHitArea.aboveTooltipTexts, [], `history entry expansion from favicon padding should not create a tooltip popup: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.deepEqual(historyFaviconHitArea.belowTooltipTexts, [], `history entry expansion from favicon padding should not create a tooltip popup: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.notEqual(
    historyPopupWheelScroll.first.webkitLineClamp,
    '2',
    `expanded history entry should not reuse the clipped row's CSS line clamp: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  const historyExpansionViewportConstrained = historyPopupWheelScroll.first.right >= historyPopupWheelScroll.first.viewportRight - 12
  if (historyExpansionViewportConstrained) {
    assert.ok(
      historyPopupWheelScroll.first.expandedLineCount >= historyPopupWheelScroll.target.titleLineCount,
      `history expansion may add rows only when constrained by the browser viewport edge: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  } else {
    assert.equal(
      historyPopupWheelScroll.first.expandedLineCount,
      historyPopupWheelScroll.target.titleLineCount,
      `history expansion should match the visible history title line count when viewport width allows it: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  }
  const normalizeHistoryLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
  const historyTitleLines = historyPopupWheelScroll.target.titleLineTexts.map(normalizeHistoryLineText).filter(Boolean)
  const historyTooltipLines = historyPopupWheelScroll.first.expandedLineTexts.map(normalizeHistoryLineText).filter(Boolean)
  assert.ok(
    historyTooltipLines.length >= historyTitleLines.length,
    `history expansion should keep at least the visible title line rows: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  for (let index = 0; index < historyTitleLines.length - 1; index += 1) {
    assert.equal(
      historyTooltipLines[index],
      historyTitleLines[index],
      `history expansion should preserve visible line breaks before the tail row: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  }
  assert.ok(
    historyTooltipLines[historyTitleLines.length - 1]?.startsWith(historyTitleLines[historyTitleLines.length - 1]),
    `history expansion tail row should start with the same visible text before revealing more: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.ok(
    (historyPopupWheelScroll.first.titleWidth || 0) > historyPopupWheelScroll.target.titleWidthExact + 8,
    `history expansion title should expand beyond the clipped visible title width: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  if (!historyExpansionViewportConstrained) {
    assert.ok(
      Math.abs((historyPopupWheelScroll.first.titleHeight || 0) - historyPopupWheelScroll.target.titleHeight) <= 1,
      `history expansion should keep the same two-line flow as the visible title when it can expand: ${JSON.stringify(historyPopupWheelScroll)}`
    )
  }
	  assert.ok(
	    historyPopupWheelScroll.target.listScrollHeight > historyPopupWheelScroll.target.listClientHeight,
	    `history panel should be scrollable for popup-wheel check: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideHistoryList,
	    true,
	    `expanded history entry should stay in the native scroll-list ancestry: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsidePanel,
	    true,
	    `expanded history entry should remain parented to the history panel instead of a portal layer: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideDashboardShell,
	    true,
	    `expanded history entry should still stay within the dashboard shell: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.equal(
	    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideOverlay,
	    false,
	    `expanded history entry should not rely on a sibling overlay for wheel scrolling: ${JSON.stringify(historyPopupWheelScroll)}`
	  )
	  assert.ok(
	    historyPopupWheelScroll.wheelDeltaY > 0
	      ? historyPopupWheelScroll.after.historyScrollTop > historyPopupWheelScroll.beforeScrollTop.historyScrollTop
      : historyPopupWheelScroll.after.historyScrollTop < historyPopupWheelScroll.beforeScrollTop.historyScrollTop,
    `repeated wheel input over an expanded history entry should keep scrolling the history panel: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.dashboardScrollTop,
    historyPopupWheelScroll.beforeScrollTop.dashboardScrollTop,
    `wheel input over an expanded history entry should not scroll the dashboard pane first: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  // Scroll no longer dismisses the expansion on its own; this wheel input scrolls
  // the list ~72px, more than the ~43px entry slot, so the entry moves out from
  // under the resting pointer and the pointer-left-the-area close fires.
  assert.equal(
    historyPopupWheelScroll.after.expansionCount,
    0,
    `history expansion should close once the entry slot scrolls out from under the pointer: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.after.tooltipCount,
    0,
    `history expansion should not leave a tooltip popup after wheel input: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveExpansionState.expansionCount,
    0,
    `history expansion should stay closed after the pointer leaves the wheel-scrolled entry: ${JSON.stringify(historyPopupWheelScroll)}`
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveExpansionState.tooltipCount,
    0,
    `history expansion should not leave a tooltip popup after pointer leave: ${JSON.stringify(historyPopupWheelScroll)}`
  )

  const windowBlurTooltip = await measureTooltipWindowBlurClose(session)
  assert.ok(windowBlurTooltip.first, `page chip should expand before window-blur check: ${JSON.stringify(windowBlurTooltip)}`)
  assert.deepEqual(windowBlurTooltip.afterBlurTooltips, [], `page chip expansion should close when the window loses focus: ${JSON.stringify(windowBlurTooltip)}`)

  const visibilityTooltip = await measureTooltipVisibilityChangeClose(session)
  assert.ok(visibilityTooltip.first, `page chip should expand before visibility-change check: ${JSON.stringify(visibilityTooltip)}`)
  assert.deepEqual(
    visibilityTooltip.afterVisibilityChangeTooltips,
    [],
    `page chip expansion should close synchronously when the page becomes hidden: ${JSON.stringify(visibilityTooltip)}`
  )

  const actionTooltip = await measureActionTooltipClickClose(session)
  assert.ok(actionTooltip.first, `pin tooltip should open before click-close check: ${JSON.stringify(actionTooltip)}`)
  assert.equal(actionTooltip.focusedAfterLeave, true, `pin button should keep focus after click so this smoke covers pointer-focus behavior: ${JSON.stringify(actionTooltip)}`)
  assert.deepEqual(actionTooltip.afterLeaveTooltips, [], `pin tooltip should close after click when the pointer leaves the focused button: ${JSON.stringify(actionTooltip)}`)

  const pageChipReturnTooltip = await measureInteractiveTooltipClickReturnFocus(
    session,
    '.page-chip .chip-text',
    PAGE_CHIP_EXPANSION_SMOKE_LABEL,
    'page-chip',
    '.chip-text'
  )
  assert.ok(pageChipReturnTooltip.first.found, `page chip should expand before click-return check: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.active, true, `page chip should be refocused during click-return smoke test: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.focusVisible, false, `page chip click-return focus should not be keyboard-visible focus: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.deepEqual(pageChipReturnTooltip.afterReturnTooltips, [], `page chip expansion should not leave a tooltip popup after pointer-click return focus: ${JSON.stringify(pageChipReturnTooltip)}`)

  const markerHandoff = await measureMarkerToChipTooltipHandoff(session)
  assert.ok(markerHandoff.target.markerText.startsWith('/'), `strip indicator should render compact path marker text in the chip: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.markerTooltip.found, `strip indicator hover should expand the page chip first: ${JSON.stringify(markerHandoff)}`)
  assert.ok(
    markerHandoff.markerTooltip.expansion?.text.includes('dev2') &&
      markerHandoff.markerTooltip.expansion?.text.includes('Hover Handoff Title'),
    `strip indicator should use chip-level in-place expansion instead of a marker-only tooltip: ${JSON.stringify(markerHandoff)}`
  )
  assert.deepEqual(markerHandoff.markerTooltip.tooltips, [], `strip indicator hover should not create a tooltip popup: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.chipTooltip.found, `page chip should remain expanded after moving from the strip indicator to chip text: ${JSON.stringify(markerHandoff)}`)

  const edgeTooltip = await measureTooltipEdgeFlip(session)
  assert.ok(edgeTooltip.first, `page chip should expand near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  assert.equal(edgeTooltip.first.visibleTooltipCount, 0, `viewport-edge page chip expansion should not create a tooltip popup: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(edgeTooltip.first.right <= edgeTooltip.target.viewportRight - 12, `expanded page chip should keep viewport collision padding near the text edge: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(Math.abs(edgeTooltip.first.textLeft - edgeTooltip.target.textLeft) <= 1, `expanded page chip should preserve the original text origin near the viewport edge: ${JSON.stringify(edgeTooltip)}`)

  const compactTitleVariantExpansion = await measureCompactTitleVariantExpansion(session)
  assert.ok(compactTitleVariantExpansion.expansion, `compact same-title variant chip should expand in place: ${JSON.stringify(compactTitleVariantExpansion)}`)
  assert.ok(
    compactTitleVariantExpansion.expansion.width <= Math.max(
      compactTitleVariantExpansion.target.chipWidth,
      compactTitleVariantExpansion.target.contentWidth + 72
    ) + 1,
    `compact same-title variant chip should not grow beyond its resting width/content budget when the content is short: ${JSON.stringify(compactTitleVariantExpansion)}`
  )
  assert.ok(
    compactTitleVariantExpansion.expansion.width >= compactTitleVariantExpansion.target.chipWidth - 1,
    `compact same-title variant chip expansion should not shrink below its resting chip width: ${JSON.stringify(compactTitleVariantExpansion)}`
  )
  assert.ok(
    compactTitleVariantExpansion.expandedVariantLabels.every((label: { clientWidth: number; scrollWidth: number }) => label.scrollWidth - label.clientWidth <= 1),
    `compact same-title variant chip expansion should keep its URL variant labels untruncated when viewport room allows: ${JSON.stringify(compactTitleVariantExpansion)}`
  )
  const plainTitleVariantEdgeExpansion = await measurePlainTitleVariantEdgeExpansion(session)
  assert.ok(
    plainTitleVariantEdgeExpansion.target.surfaces.slotOnlyDefaultSurface,
    `plain same-title variant smoke should find a slot-only default surface outside the rounded chip: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`
  )
  assert.ok(
    plainTitleVariantEdgeExpansion.target.overflowingLabels > 0,
    `plain same-title variant smoke should start with a clipped URL distinguisher: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`
  )
  const slotOnlyTitleVariantSurface = plainTitleVariantEdgeExpansion.surfaceResults.find((surface: { surface: string }) => surface.surface === 'slotOnlyDefaultSurface')
  assert.ok(
    slotOnlyTitleVariantSurface?.preHoverState?.hitInsideSlot && !slotOnlyTitleVariantSurface?.preHoverState?.hitInsideChip,
    `plain same-title variant slot-only surface should hover the slot without entering the rounded chip: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`
  )
  assert.ok(
    plainTitleVariantEdgeExpansion.surfaceResults.every((surface: { expansion: unknown }) => surface.expansion),
    `plain same-title variant chip should expand from every highlighted hover surface: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`
  )
  assert.ok(
    plainTitleVariantEdgeExpansion.surfaceResults.every((surface: { expansion: { left: number; right: number } | null }) =>
      surface.expansion &&
        surface.expansion.left >= plainTitleVariantEdgeExpansion.target.chipLeft - 1 &&
        surface.expansion.right <= plainTitleVariantEdgeExpansion.target.viewportRight - 12
    ),
    `plain same-title variant chip should clamp to right-side room instead of growing left: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`
  )
  const wrappedTitleVariantExpansion = await measureWrappedTitleVariantExpansion(session)
  assert.equal(
    wrappedTitleVariantExpansion.target.titleLineCount,
    2,
    `wrapped same-title variant title should start as two visible lines: ${JSON.stringify(wrappedTitleVariantExpansion)}`
  )
  assert.ok(
    wrappedTitleVariantExpansion.target.markerCount > 0,
    `wrapped same-title variant title should include a compact suppression marker: ${JSON.stringify(wrappedTitleVariantExpansion)}`
  )
  assert.ok(wrappedTitleVariantExpansion.expansion, `wrapped same-title variant chip should expand in place: ${JSON.stringify(wrappedTitleVariantExpansion)}`)
  assert.ok(
    Math.abs(wrappedTitleVariantExpansion.expansion.width - wrappedTitleVariantExpansion.target.chipWidth) <= 1,
    `wrapped same-title variant chip should not grow when expanded title text fits in the resting line count: ${JSON.stringify(wrappedTitleVariantExpansion)}`
  )
  assert.equal(
    wrappedTitleVariantExpansion.expansion.titleLineCount,
    wrappedTitleVariantExpansion.target.titleLineCount,
    `wrapped same-title variant expansion should keep the resting title line count: ${JSON.stringify(wrappedTitleVariantExpansion)}`
  )
  assert.ok(
    wrappedTitleVariantExpansion.expansion.titleText.includes('Example Optical'),
    `wrapped same-title variant expansion should reveal the suppressed title text: ${JSON.stringify(wrappedTitleVariantExpansion)}`
  )

  const duplicateStackGeometry = await measureDuplicateStackGeometry(session)
  assert.ok(duplicateStackGeometry, `duplicate page chip stack should render in the browser smoke harness: ${JSON.stringify(duplicateStackGeometry)}`)
  assert.ok(
    duplicateStackGeometry.frame.width <= 18 && duplicateStackGeometry.frame.height <= 18,
    `duplicate page chip favicon stack frame should stay favicon-sized: ${JSON.stringify(duplicateStackGeometry)}`
  )
  assert.equal(duplicateStackGeometry.layers.length, 2, `duplicate page chip should render two stack layers for 4 copies: ${JSON.stringify(duplicateStackGeometry)}`)
  assert.ok(
    duplicateStackGeometry.layers.every((layer: { width: number; height: number }) => layer.width <= 18 && layer.height <= 18),
    `duplicate page chip stack layers should not stretch into a tall overlay: ${JSON.stringify(duplicateStackGeometry)}`
  )

  await evaluateWithNavigationRetry(session, {
    awaitPromise: true,
    expression: `window.__tabOutSmokeAddPathGroupPlaceholderTabs?.()`
  })
  const oneLinePathGroupPlaceholderTooltip = await measurePageChipTooltipLineCount(session, 'at story/ABC-123_2', {
    forcedTextWidth: 130,
    forcedMaxLines: 1,
    hoverWaitMs: 40,
    viewportWidth: 2200
  })
  assert.ok(oneLinePathGroupPlaceholderTooltip.tooltip, `one-line path-group placeholder tooltip should open: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`)
  assert.equal(
    oneLinePathGroupPlaceholderTooltip.target.chipLineCount,
    1,
    `one-line path-group placeholder smoke target should render as one visible chip line: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`
  )
  assert.equal(
    oneLinePathGroupPlaceholderTooltip.tooltip.tooltipLineCount,
    1,
    `one-line path-group placeholder tooltip should widen enough to stay on one line: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`
  )

  // Runs near the end (before the bookmark-source switch) so its hover/right-click
  // interactions cannot perturb the timing-sensitive tabs-source measurements above.
  const suppressionTokenClose = await measureSuppressionTokenCloseHighlight(session)
  assert.equal(suppressionTokenClose.baseline, 0, `suppression chips should not be highlighted before hover: ${JSON.stringify(suppressionTokenClose)}`)
  assert.equal(suppressionTokenClose.onHover, 3, `hovering the "— Shared Workspace" token should highlight its 3 chips: ${JSON.stringify(suppressionTokenClose)}`)
  assert.equal(suppressionTokenClose.onRightClick.highlightedChips, 3, `right-clicking the token must keep its 3 chips highlighted while the close menu is open: ${JSON.stringify(suppressionTokenClose)}`)
  assert.ok(suppressionTokenClose.onRightClick.menuOpen, `right-clicking the token should open the close menu: ${JSON.stringify(suppressionTokenClose)}`)
  assert.ok(suppressionTokenClose.onRightClick.itemTexts.includes('Suspend 3 tabs'), `token close menu should offer "Suspend 3 tabs": ${JSON.stringify(suppressionTokenClose)}`)
  assert.ok(suppressionTokenClose.onRightClick.itemTexts.includes('Close 3 tabs'), `token close menu should offer "Close 3 tabs": ${JSON.stringify(suppressionTokenClose)}`)
  assert.equal(suppressionTokenClose.afterClickAway.menuOpen, false, `clicking elsewhere should close the token close menu: ${JSON.stringify(suppressionTokenClose)}`)
  assert.equal(suppressionTokenClose.afterClickAway.highlightedChips, 0, `closing the menu by clicking away must clear the suppression highlight even though focus returns to the token: ${JSON.stringify(suppressionTokenClose)}`)

  // Multi-line resting chips reveal in place: every pill hydrates on the
  // visible line it occupied at rest, whatever mix of text and pills shares
  // that line — the expansion widens lines, it does not re-deal them.
  const markerWrapStability = await measureMarkerWrapExpansionReflow(session, { forcedTextWidth: 205 })
  assert.ok(markerWrapStability.target, `marker-wrap stability smoke should find its path-group chip: ${JSON.stringify(markerWrapStability)}`)
  assert.ok(
    markerWrapStability.target.chipLineCount >= 2,
    `marker-wrap stability smoke target should rest as a wrapped multi-line title: ${JSON.stringify(markerWrapStability.target)}`
  )
  assert.ok(
    markerWrapStability.target.suppressionPillCount >= 2,
    `marker-wrap stability smoke target should carry two suppression pills at rest: ${JSON.stringify(markerWrapStability.target)}`
  )
  assert.ok(markerWrapStability.expansion, `marker-wrap chip should expand in place: ${JSON.stringify(markerWrapStability)}`)
  assert.ok(
    ['Example Website', 'Contentful', 'dev2'].every((part) => markerWrapStability.expansion.text.includes(part)),
    `marker-wrap expansion should reveal every suppressed/placeholder label: ${JSON.stringify(markerWrapStability.expansion)}`
  )
  assert.deepEqual(
    markerWrapStability.expansion.pills.map((pill: { visualLine: number }) => pill.visualLine),
    markerWrapStability.target.pillLines,
    `expanded pills must stay on the visible lines they occupied at rest: ${JSON.stringify(markerWrapStability)}`
  )

  // Single-line-resting variant of the same defect: the compact glyph title
  // fits one resting line, but the hydrated reveal exceeds the rightward
  // viewport allowance. The old "don't widen at all — keep the resting width
  // and wrap" rule for that shape re-strands pills at the narrow resting
  // width; with hydrating pills the reveal must take the packed allowance
  // instead, so pills drop down only when genuinely out of room.
  const markerWrapConstrainedReflow = await measureMarkerWrapExpansionReflow(session, { viewportWidth: 430 })
  assert.ok(markerWrapConstrainedReflow.target, `constrained marker-wrap smoke should find its path-group chip: ${JSON.stringify(markerWrapConstrainedReflow)}`)
  assert.equal(
    markerWrapConstrainedReflow.target.chipLineCount,
    1,
    `constrained marker-wrap smoke target should rest as a single compact line: ${JSON.stringify(markerWrapConstrainedReflow.target)}`
  )
  assert.ok(markerWrapConstrainedReflow.expansion, `constrained marker-wrap chip should expand in place: ${JSON.stringify(markerWrapConstrainedReflow)}`)
  assert.ok(
    ['Example Website', 'Contentful', 'dev2'].every((part) => markerWrapConstrainedReflow.expansion.text.includes(part)),
    `constrained marker-wrap expansion should reveal every suppressed/placeholder label: ${JSON.stringify(markerWrapConstrainedReflow.expansion)}`
  )
  assert.equal(
    markerWrapConstrainedReflow.expansion.strandedPills.length,
    0,
    `expanded suppression pills must not start a continuation line while the previous line has viewport room for them (resting-width wrap): ${JSON.stringify(markerWrapConstrainedReflow.expansion)}`
  )

  const markerOnlyLine = await measureMarkerOnlyLineExpansion(session)
  assert.ok(markerOnlyLine.target, `marker-only-line smoke should find its suffixed chip: ${JSON.stringify(markerOnlyLine)}`)
  assert.ok(
    (markerOnlyLine.target.markerLine ?? 0) >= 1 && (markerOnlyLine.target.markerLeftOffset ?? 99) <= 8,
    `marker-only-line smoke target should rest with its trailing pill starting a middle line: ${JSON.stringify(markerOnlyLine.target)}`
  )
  assert.ok(markerOnlyLine.expansion, `marker-only-line chip should expand in place: ${JSON.stringify(markerOnlyLine)}`)
  assert.equal(
    markerOnlyLine.expansion.markerLine,
    markerOnlyLine.target.markerLine,
    `a pill alone on its resting line must stay on that visible line when it hydrates (reveal in place): ${JSON.stringify(markerOnlyLine)}`
  )
  assert.ok(
    markerOnlyLine.expansion.text.includes('assignee=712020'),
    `marker-only-line expansion should reveal the full URL suffix: ${JSON.stringify(markerOnlyLine.expansion)}`
  )

  const variantTitleRow = await measureVariantTitleRowStability(session)
  assert.ok(variantTitleRow.target, `variant title-row smoke should find its merged chip: ${JSON.stringify(variantTitleRow)}`)
  assert.equal(
    variantTitleRow.target.titleRowLines,
    2,
    `variant title-row smoke target should rest as two title lines: ${JSON.stringify(variantTitleRow.target)}`
  )
  assert.ok(
    variantTitleRow.target.indicatorLine === 0 && variantTitleRow.target.anchorLine === 1,
    `variant title-row smoke target should rest with the indicator on line 1 and "from my" on line 2: ${JSON.stringify(variantTitleRow.target)}`
  )
  assert.ok(variantTitleRow.expansion, `variant title-row chip should expand in place: ${JSON.stringify(variantTitleRow)}`)
  assert.ok(
    variantTitleRow.expansion.indicatorText.includes('example-owner/skills'),
    `variant title-row expansion should hydrate the structural indicator label: ${JSON.stringify(variantTitleRow.expansion)}`
  )
  assert.equal(
    variantTitleRow.expansion.anchorLine,
    variantTitleRow.target.anchorLine,
    `text after the hydrating indicator must stay on its resting line when the title expands: ${JSON.stringify(variantTitleRow)}`
  )
  assert.equal(
    variantTitleRow.expansion.indicatorLine,
    0,
    `the hydrated indicator should stay on the first title line: ${JSON.stringify(variantTitleRow.expansion)}`
  )

  const largeBookmarks = await measureLargeBookmarkProgressiveRender(session)
  assert.ok(largeBookmarks.initial, `bookmark source should render an initial progressive chunk: ${JSON.stringify(largeBookmarks)}`)
  assert.ok(largeBookmarks.initial.count <= 24, `bookmark source should not mount all large-list cards in the first chunk: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.initial.measureNodeCount, 0, `large bookmark switch should not create hidden page-chip measure nodes initially: ${JSON.stringify(largeBookmarks)}`)
  assert.ok(largeBookmarks.steady, `bookmark source should reach a bounded top-of-list steady state: ${JSON.stringify(largeBookmarks)}`)
  assert.ok(largeBookmarks.steady.count <= 96, `bookmark source should not drain every card while the user remains at the top: ${JSON.stringify(largeBookmarks)}`)
  assert.ok(largeBookmarks.steady.elementCount <= 3_500, `bookmark source should keep its top-of-list DOM bounded: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.steady.scrollTop, 0, `progressive rendering should not move the user's scroll position: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.final.count, 1008, `scrolling through a large bookmark source should keep every synthetic card reachable: ${JSON.stringify(largeBookmarks)}`)
  assert.equal(largeBookmarks.final.measureNodeCount, 0, `large bookmark source should not create hidden page-chip measure nodes after all chunks render: ${JSON.stringify(largeBookmarks)}`)
})

test('domain card menu keeps close suspended visible and disabled at zero', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const contentfulCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="contentful.com"]')
  await expect(contentfulCard).toBeVisible()
  await contentfulCard.hover()

  const cardMenu = contentfulCard.locator('[data-tabout-part="card-menu"]')
  await cardMenu.hover()
  await cardMenu.click()

  const closeSuspended = page.locator('[data-slot="menu-content"]:visible [data-tabout-part="close-suspended-button"]')
  await expect(closeSuspended).toBeVisible()
  await expect(closeSuspended).toContainText('Close all 0 suspended tabs')
  await expect(closeSuspended).toHaveAttribute('data-disabled', '')
})

test('rapid domain pin writes preserve the latest optimistic state', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await page.evaluate(() => {
    const storage = window.chrome.storage.local
    const originalSet = storage.set.bind(storage)
    const { promise: firstWriteGate, resolve: releaseFirstWrite } = Promise.withResolvers<void>()
    const audit = {
      active: 0,
      maxActive: 0,
      releaseFirstWrite,
      writes: [] as string[][]
    }
    ;(window as typeof window & { __tabOutPinWriteAudit: typeof audit }).__tabOutPinWriteAudit = audit
    storage.set = async (items) => {
      if (!Object.hasOwn(items, 'tabOutPinnedDomainsV1')) {
        await originalSet(items)
        return
      }
      const pinnedDomains = Object.entries(items).find(([key]) => key === 'tabOutPinnedDomainsV1')?.[1]
      if (
        !Array.isArray(pinnedDomains) ||
        !pinnedDomains.every((domain): domain is string => typeof domain === 'string')
      ) {
        throw new TypeError('Expected every pinned-domain write to contain only strings')
      }
      audit.writes.push([...pinnedDomains])
      audit.active += 1
      audit.maxActive = Math.max(audit.maxActive, audit.active)
      if (audit.writes.length === 1) await firstWriteGate
      await originalSet(items)
      audit.active -= 1
    }
  })

  const contentfulCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="contentful.com"]')
  await contentfulCard.hover()
  const contentfulMenu = contentfulCard.locator('[data-tabout-part="card-menu"]')
  await contentfulMenu.hover()
  await contentfulMenu.click()
  await page.locator('[data-slot="menu-content"]:visible [data-tabout-part="pin-button"]').click()
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __tabOutPinWriteAudit: { writes: string[][] } }
  ).__tabOutPinWriteAudit.writes.length)).toBe(1)
  const suppressionCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="suppression-smoke.example"]')
  await suppressionCard.hover()
  const suppressionMenu = suppressionCard.locator('[data-tabout-part="card-menu"]')
  await suppressionMenu.hover()
  await suppressionMenu.click()
  await page.locator('[data-slot="menu-content"]:visible [data-tabout-part="pin-button"]').click()
  await expect(contentfulCard).toHaveAttribute('data-tabout-domain-pinned', 'true')
  await expect(suppressionCard).toHaveAttribute('data-tabout-domain-pinned', 'true')

  await page.evaluate(() => (
    window as typeof window & { __tabOutPinWriteAudit: { releaseFirstWrite(): void } }
  ).__tabOutPinWriteAudit.releaseFirstWrite())
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __tabOutPinWriteAudit: { writes: string[][] } }
  ).__tabOutPinWriteAudit.writes.length)).toBe(2)

  const result = await page.evaluate(async () => {
    const audit = (
      window as typeof window & {
        __tabOutPinWriteAudit: { active: number; maxActive: number; writes: string[][] }
      }
    ).__tabOutPinWriteAudit
    const stored = await window.chrome.storage.local.get('tabOutPinnedDomainsV1')
    return {
      active: audit.active,
      maxActive: audit.maxActive,
      stored: stored.tabOutPinnedDomainsV1,
      writes: audit.writes
    }
  })

  expect(result).toEqual({
    active: 0,
    maxActive: 1,
    stored: ['contentful.com', 'suppression-smoke.example'],
    writes: [
      ['contentful.com'],
      ['contentful.com', 'suppression-smoke.example']
    ]
  })
})

test('history scrollbar cancels a drag on pointer cancellation', async ({ page }) => {
  await page.setViewportSize({ width: 1420, height: 360 })
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const thumb = page.locator('.history-entry-scrollbar-thumb')
  await expect(thumb).toBeAttached()
  const start = await thumb.evaluate((element) => {
    const list = document.querySelector<HTMLElement>('.history-entry-list')
    const rect = element.getBoundingClientRect()
    if (!list) throw new Error('History list is missing')
    list.scrollTop = 0
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
  })

  await thumb.dispatchEvent('pointerdown', {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: start.clientX,
    clientY: start.clientY,
    pointerId: 7,
    pointerType: 'mouse'
  })
  await expect(thumb).toHaveAttribute('data-dragging', 'true')

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      pointerId: 7,
      pointerType: 'mouse'
    }))
  })
  await expect(thumb).not.toHaveAttribute('data-dragging')
  const afterCancel = await page.locator('.history-entry-list').evaluate((element) => element.scrollTop)

  await page.evaluate(({ clientX, clientY }) => {
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      buttons: 1,
      clientX,
      clientY: clientY + 200,
      pointerId: 7,
      pointerType: 'mouse'
    }))
  }, start)
  const afterMove = await page.locator('.history-entry-list').evaluate((element) => element.scrollTop)
  expect(afterMove).toBe(afterCancel)
})
