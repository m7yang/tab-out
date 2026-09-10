import assert from 'node:assert/strict'
import { expect, test } from '@playwright/test'
import * as contextMenuPage from './page-realm/context-menu.js'
import * as dashboardPage from './page-realm/dashboard.js'
import type { ClassRetentionProbeTarget } from './page-realm/dashboard.js'
import { createDashboardHarness, evaluateInPage, wait, waitForBrowserCondition } from './page-realm/harness.js'
import type { DashboardHarness } from './page-realm/harness.js'
import * as focusUpdatesPage from './page-realm/focus-updates.js'
import * as historyEntryPage from './page-realm/history-entry.js'
import * as pageChipExpansionPage from './page-realm/page-chip-expansion.js'
import * as titleExpansionPage from './page-realm/title-expansion.js'
import * as titleVariantsPage from './page-realm/title-variants.js'
import * as tooltipPage from './page-realm/tooltip.js'

type FilterReloadTrace = {
  replacedFilterValues: Array<string | null>
}

declare global {
  interface Window {
    __tabOutFilterReloadTrace: FilterReloadTrace
  }
}

test('restored filter stays visible and URL-stable through attachment and immediate reload', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const trace: FilterReloadTrace = {
      replacedFilterValues: [],
    }
    window.__tabOutFilterReloadTrace = trace

    const replaceState = window.history.replaceState.bind(window.history)
    window.history.replaceState = (data, unused, url) => {
      replaceState(data, unused, url)
      trace.replacedFilterValues.push(new URL(window.location.href).searchParams.get('filter'))
    }
  })
  const appModuleGate = Promise.withResolvers<void>()
  await page.route('**/extension/dist/app.js', async (route) => {
    await appModuleGate.promise
    await route.continue()
  })

  const navigation = page.goto('/tests/fixtures/dashboard-resize.html?filter=Example%20Query')
  const filterInput = page.locator('[data-tabout="filter-query"] input')
  let preAttachmentError: unknown
  try {
    await expect(filterInput).toHaveValue('Example Query')
    await expect(filterInput).not.toBeFocused()
  } catch (error) {
    preAttachmentError = error
  } finally {
    appModuleGate.resolve()
  }
  await navigation
  if (preAttachmentError) throw preAttachmentError
  await expect.poll(() => page.title()).toBe('Example Query - Tab Out')
  const firstAttachment = await page.evaluate(() => ({
    href: window.location.href,
    trace: window.__tabOutFilterReloadTrace,
  }))

  await page.reload()
  await expect(filterInput).toHaveValue('Example Query')
  await expect.poll(() => page.title()).toBe('Example Query - Tab Out')
  const secondAttachment = await page.evaluate(() => ({
    href: window.location.href,
    trace: window.__tabOutFilterReloadTrace,
  }))

  for (const attachment of [firstAttachment, secondAttachment]) {
    expect(new URL(attachment.href).searchParams.get('filter')).toBe('Example Query')
    expect(attachment.trace.replacedFilterValues).not.toContain(null)
  }
})

test('pre-app clear remains authoritative over a URL filter', async ({ page }) => {
  const appModuleGate = Promise.withResolvers<void>()
  await page.route('**/extension/dist/app.js', async (route) => {
    await appModuleGate.promise
    await route.continue()
  })

  const navigation = page.goto(
    '/tests/fixtures/dashboard-resize.html?focusFilter=1&filter=Example%20Query&marker=kept#results',
  )
  const filterInput = page.locator('[data-tabout="filter-query"] input')
  let preAttachmentError: unknown
  try {
    await expect(filterInput).toHaveValue('Example Query')
    await expect(filterInput).toBeFocused()
    await filterInput.fill('')
  } catch (error) {
    preAttachmentError = error
  } finally {
    appModuleGate.resolve()
  }
  await navigation
  if (preAttachmentError) throw preAttachmentError

  await expect(filterInput).toHaveValue('')
  await expect.poll(() => page.evaluate(() => {
    const url = new URL(window.location.href)
    return {
      filter: url.searchParams.get('filter'),
      focusFilter: url.searchParams.get('focusFilter'),
      hash: url.hash,
      marker: url.searchParams.get('marker'),
    }
  })).toEqual({
    filter: null,
    focusFilter: null,
    hash: '#results',
    marker: 'kept',
  })
})

test('filter shortcut startup preserves the prerendered input and its focus-visible shadow', async ({
  page,
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
      blur: 0,
    }
    const startupInput = {
      element: null as HTMLInputElement | null,
      seeded: false,
    }

    function sampleFocusShadow() {
      const inputs = document.querySelectorAll<HTMLInputElement>(
        '[data-tabout="filter-query"] input',
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
          ...shadowLengths.filter((_, index) => index % 3 === 2),
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
      selectionStart: filterInputElement.selectionStart,
    }
  })).toEqual({
    sameElement: true,
    selectionEnd: 2,
    selectionStart: 2,
  })
  expect(hydrationErrors).toEqual([])
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutFocusShadowPaint: { blur: number } })
      .__tabOutFocusShadowPaint.blur,
  )).toBeGreaterThan(2.8)

  const focusStyle = await filterInput.evaluate((input) => ({
    restingFilter: getComputedStyle(input.parentElement!, '::before').filter,
    focusFilter: getComputedStyle(input.parentElement!, '::after').filter,
    focusBoxShadow: getComputedStyle(input.parentElement!, '::after').boxShadow,
    focusBorderColor: getComputedStyle(input.parentElement!, '::after').borderColor,
    focusOpacity: getComputedStyle(input.parentElement!, '::after').opacity,
    caretColor: getComputedStyle(input).caretColor,
    inputFilter: getComputedStyle(input).filter,
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
    (window as typeof window & { __tabOutFilterBlurCount?: number }).__tabOutFilterBlurCount,
  )).toBe(0)

  const focusShadowPaint = await page.evaluate(() =>
    (window as typeof window & {
      __tabOutFocusShadowPaint: {
        owner: string
        presentations: number
        visible: boolean
        blur: number
      }
    }).__tabOutFocusShadowPaint,
  )
  expect(focusShadowPaint).toMatchObject({
    owner: 'app',
    presentations: 1,
    visible: true,
  })

  const refocusPaint = await filterInput.evaluate(async (input) => {
    const borderLayer = input.parentElement!
    input.blur()
    await new Promise((resolve) => setTimeout(resolve, 200))
    input.focus()
    const samples: Array<{ borderColor: string, filter: string, opacity: number }> = []
    const start = performance.now()
    do {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      const focusLayer = getComputedStyle(borderLayer, '::after')
      samples.push({
        borderColor: focusLayer.borderColor,
        filter: focusLayer.filter,
        opacity: Number.parseFloat(focusLayer.opacity),
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
      },
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
        historyOrder: historyRows.map((row) => row.dataset.taboutLayoutKey ?? ''),
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
        y: bounds.y,
      }
    }
    return {
      filter: rect('[data-tabout="filter-query"]'),
      header: rect('.pinned-top'),
      sourceSwitch: rect('[data-tabout="dashboard-view"]'),
    }
  })

  const pendingState = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-tabout="domain-card"]').length,
    clearVisible: getComputedStyle(document.querySelector<HTMLElement>('[data-tabout-part="clear-button"]')!).display !== 'none',
    headerShadowOpacity: Number(getComputedStyle(document.querySelector<HTMLElement>('.pinned-top')!, '::after').opacity),
    storagePending: (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true,
  }))
  expect(pendingState).toMatchObject({
    cards: 0,
    clearVisible: true,
    headerShadowOpacity: 0,
    storagePending: true,
  })
  await expect(page.locator('[data-tabout="dashboard-startup-status"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(filterInput).toHaveValue('')

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __tabOutStartupCommit: { firstContent: unknown }
    }).__tabOutStartupCommit.firstContent,
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
    }).__tabOutStartupCommit.firstContent,
  )
  expect(firstContent.domainCards).toBeGreaterThan(0)
  expect(firstContent.dedupeText).toBe('')
  expect(firstContent.headerStats).toMatch(/\d+(?:\/\d+)? tabs/)
  expect(firstContent.historyEntries).toBeGreaterThan(0)
  expect(await page.locator('[data-tabout="activation-history-entry"]').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.taboutLayoutKey ?? ''),
  )).toEqual(firstContent.historyOrder)
  expect(await page.evaluate(() => {
    function rect(selector: string) {
      const bounds = document.querySelector(selector)?.getBoundingClientRect()
      if (!bounds) throw new Error(`Missing filled shell landmark: ${selector}`)
      return {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x,
        y: bounds.y,
      }
    }
    return {
      filter: rect('[data-tabout="filter-query"]'),
      header: rect('.pinned-top'),
      sourceSwitch: rect('[data-tabout="dashboard-view"]'),
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
        '[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]',
      ) !== null
    }).observe(document, { childList: true, subtree: true })
  })

  await page.goto('/tests/fixtures/dashboard-resize.html?focusFilter=1&filter=Bookmark%201&initialBookmarks=3')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __tabOutFilteredStartup: { firstFrameHasBookmark: boolean | null }
    }).__tabOutFilteredStartup.firstFrameHasBookmark,
  )).toBe(true)
})

test('startup coalesces rapid filter input before its browser History read', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?slowInitialStorage=1')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true,
  )).toBe(true)

  const filterInput = page.locator('[data-tabout="filter-query"] input')
  await filterInput.fill('a')
  await filterInput.fill('al')
  await filterInput.fill('alp')
  await filterInput.fill('alpha')

  await expect(page.locator('[data-tabout="domain-card"]').first()).toBeVisible()
  expect(await page.evaluate(() =>
    (window as typeof window & { __tabOutSmokeHistorySearchQueries: string[] })
      .__tabOutSmokeHistorySearchQueries,
  )).toEqual(['alpha'])
})

test('filter recovery from startup failure stays coalesced before History reads', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?failFirstStartupStorage=1')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true,
  )).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === false,
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
      .__tabOutSmokeHistorySearchQueries,
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
      .__tabOutInitialStoragePending === true,
  )).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === false,
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
      .__tabOutStartupPresentation,
  )).toEqual({ failureCopySeen: false, retryButtonSeen: false })
})

test('a source choice made in the shell selects the admitted startup frame', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?slowInitialStorage=1&marker=kept#results')
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === true,
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
  await expect.poll(() => page.evaluate(() => {
    const url = new URL(window.location.href)
    return {
      hash: url.hash,
      marker: url.searchParams.get('marker'),
      slowInitialStorage: url.searchParams.get('slowInitialStorage'),
      view: url.searchParams.get('view'),
    }
  })).toEqual({
    hash: '#results',
    marker: 'kept',
    slowInitialStorage: '1',
    view: 'bookmarks',
  })
  const bookmarkCard = page.locator(
    '[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]',
  )
  await expect(bookmarkCard).toHaveCount(0)

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __tabOutInitialStoragePending?: boolean })
      .__tabOutInitialStoragePending === false,
  )).toBe(true)
  await expect(bookmarkCard).toHaveCount(1)
  expect(await page.evaluate(() =>
    (window as typeof window & {
      __tabOutStartupSourceFrames: { contentSources: string[] }
    }).__tabOutStartupSourceFrames.contentSources,
  )).toEqual(['bookmarks'])
})

const RUN_HISTORY_SCROLLBAR_OVERLAP_ONLY = process.env.HISTORY_SCROLLBAR_OVERLAP_ONLY === '1'
const PAGE_CHIP_EXPANSION_SMOKE_LABEL = 'Hover Handoff Title'

async function waitForDashboardSettled(harness: DashboardHarness) {
  await waitForBrowserCondition(
    harness,
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
    { timeoutMs: 5000 },
  )
}

async function waitForScrollTop(harness: DashboardHarness, selector: string, expected = 0) {
  await waitForBrowserCondition(
    harness,
    (targetSelector: string, targetScrollTop: number) => {
      const scroller = document.querySelector(targetSelector)
      return !!scroller && Math.abs(scroller.scrollTop - targetScrollTop) <= 1
    },
    `${selector} should reach scrollTop ${expected}`,
    { args: [selector, expected] },
  )
}

async function waitForNoPageChipExpansion(harness: DashboardHarness) {
  await waitForBrowserCondition(
    harness,
    () => !document.querySelector('.page-chip-expanded'),
    'page chip expansion should close',
  )
}

async function waitForNoHistoryEntryExpansion(harness: DashboardHarness) {
  await waitForBrowserCondition(
    harness,
    () => !document.querySelector('.history-entry-expanded'),
    'history entry expansion should close',
  )
}

async function waitForNoVisibleTooltip(harness: DashboardHarness) {
  await waitForBrowserCondition(
    harness,
    () => !Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).some((tooltip) => {
      const rect = tooltip.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
    }),
    'visible tooltip should close',
  )
}

async function waitForNoTitleExpansion(harness: DashboardHarness) {
  await Promise.all([
    waitForNoPageChipExpansion(harness),
    waitForNoHistoryEntryExpansion(harness),
    waitForNoVisibleTooltip(harness),
  ])
}

async function waitForContextMenuState(harness: DashboardHarness, open: boolean) {
  await waitForBrowserCondition(
    harness,
    (shouldBeOpen: boolean) => {
      const menu = document.querySelector('[data-slot="context-menu-content"]')
      return shouldBeOpen
        ? !!menu && menu.getClientRects().length > 0
        : !menu || menu.getClientRects().length === 0
    },
    `context menu should ${open ? 'open' : 'close'}`,
    { args: [open] },
  )
}

async function startClassRetentionProbe(harness: DashboardHarness, target: ClassRetentionProbeTarget) {
  return evaluateInPage(harness, dashboardPage.startClassRetentionProbe, target)
}

async function finishClassRetentionProbe(harness: DashboardHarness) {
  return evaluateInPage(harness, dashboardPage.finishClassRetentionProbe)
}

async function waitForFocusUpdates(harness: DashboardHarness) {
  await waitForBrowserCondition(
    harness,
    () => {
      const smokeWindow = window as typeof window & {
        __tabOutSmokeFocusUpdates?: Array<{ kind: string }>
      }
      const updates = smokeWindow.__tabOutSmokeFocusUpdates || []
      return updates.some((update) => update.kind === 'tab') &&
        updates.some((update) => update.kind === 'window')
    },
    'tab and window focus updates should complete',
  )
}

async function measureDashboard(harness: DashboardHarness, width: number) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  return evaluateInPage(harness, dashboardPage.measureDashboard)
}

async function measureInitialTooltipMeasureNodes(harness: DashboardHarness) {
  return evaluateInPage(harness, dashboardPage.readTooltipMeasureNodeCounts)
}

async function measureTruncatedTitleTailFill(harness: DashboardHarness) {
  return evaluateInPage(harness, dashboardPage.measureTruncatedTitleTailFill)
}

async function measureLargeBookmarkProgressiveRender(harness: DashboardHarness) {
  return evaluateInPage(harness, dashboardPage.measureLargeBookmarkProgressiveRender)
}

async function measureHorizontalScrollLock(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const target = await evaluateInPage(harness, dashboardPage.findScrollLockTarget)

  assert.ok(target, 'expected a scroll region for horizontal scroll lock smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: target.x,
    y: target.y,
    deltaX: 220,
    deltaY: 0,
  })
  await wait(160)

  const after = await evaluateInPage(harness, dashboardPage.readScrollLockAfter)

  return { ...target, afterScrollLeft: after.scrollLeft, afterScrollWidth: after.scrollWidth, afterClientWidth: after.clientWidth }
}

async function waitForTooltipRect(harness: DashboardHarness) {
  return evaluateInPage(harness, dashboardPage.waitForTooltipRect)
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
async function measureMarkerWrapExpansionReflow(harness: DashboardHarness, options: { forcedTextWidth?: number, viewportWidth?: number } = {}) {
  await evaluateInPage(harness, titleExpansionPage.addMarkerWrapPathGroupTabs)
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewportWidth || 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, titleExpansionPage.findMarkerWrapChipTarget, {
    label: MARKER_WRAP_REFLOW_SMOKE_LABEL,
    forcedTextWidth: options.forcedTextWidth || 0,
  })

  if (!target) return { target, expansion: null }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await waitForPageChipExpansionRect(harness, MARKER_WRAP_REFLOW_SMOKE_LABEL)

  const expansion = await evaluateInPage(harness, titleExpansionPage.readMarkerWrapExpansion, { label: MARKER_WRAP_REFLOW_SMOKE_LABEL })

  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await waitForNoPageChipExpansion(harness)

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
async function measureMarkerOnlyLineExpansion(harness: DashboardHarness) {
  await evaluateInPage(harness, titleExpansionPage.addMarkerWrapPathGroupTabs)
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, titleExpansionPage.findMarkerOnlyLineChipTarget, { label: MARKER_ONLY_LINE_SMOKE_LABEL })

  if (!target) return { target, expansion: null }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await waitForPageChipExpansionRect(harness, MARKER_ONLY_LINE_SMOKE_LABEL)

  const expansion = await evaluateInPage(harness, titleExpansionPage.readMarkerOnlyLineExpansion, { label: MARKER_ONLY_LINE_SMOKE_LABEL })

  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await waitForNoPageChipExpansion(harness)

  return { target, expansion }
}

const VARIANT_TITLE_ROW_SMOKE_LABEL = 'Skills for Real Engineers'

/**
 * Variant-group title-row stability smoke: the merged same-title chip's
 * title row starts with a labeled structural indicator and rests as two
 * lines. Hydrating the indicator label must widen line 1 in place — the
 * second line's text stays on the second line instead of reflowing up.
 */
async function measureVariantTitleRowStability(harness: DashboardHarness) {
  await evaluateInPage(harness, titleExpansionPage.addMarkerWrapPathGroupTabs)
  // Wide viewport: the hydrated indicator label needs rightward room on its
  // frozen first line wherever the masonry parks this card; the scenario
  // pins line stability, not the viewport-constrained wrap.
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, titleExpansionPage.probeVariantTitleRow, { mode: 'rest', label: VARIANT_TITLE_ROW_SMOKE_LABEL })

  if (!target) return { target, expansion: null }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await waitForPageChipExpansionRect(harness, VARIANT_TITLE_ROW_SMOKE_LABEL)

  const expansion = await evaluateInPage(harness, titleExpansionPage.probeVariantTitleRow, { mode: 'expanded', label: VARIANT_TITLE_ROW_SMOKE_LABEL })

  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await waitForNoPageChipExpansion(harness)

  return { target, expansion }
}

async function waitForPageChipExpansionRect(harness: DashboardHarness, text: string, timeoutMs = 2000) {
  return evaluateInPage(harness, titleExpansionPage.waitForPageChipExpansionRect, { text, timeoutMs })
}

async function waitForHistoryEntryExpansionRect(harness: DashboardHarness, text: string, timeoutMs = 2000) {
  return evaluateInPage(harness, titleExpansionPage.waitForHistoryEntryExpansionRect, { text, timeoutMs })
}

async function waitForHistoryScrollbarThumbOpacity(harness: DashboardHarness, opacity: string, timeoutMs = 1000) {
  return evaluateInPage(harness, titleExpansionPage.waitForHistoryScrollbarThumbOpacity, { opacity, timeoutMs })
}

async function getVisibleTooltipTexts(harness: DashboardHarness) {
  return evaluateInPage(harness, tooltipPage.readVisibleTooltipTexts)
}

async function measureTooltipFreeze(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })

  const target = await evaluateInPage(harness, tooltipPage.findTooltipFreezeTarget, { label: PAGE_CHIP_EXPANSION_SMOKE_LABEL })

  assert.ok(target, 'expected a page chip to hover for tooltip smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.moveX,
    y: target.y,
  })
  await wait(150)
  const second = await waitForPageChipExpansionRect(harness, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateInPage(harness, dashboardPage.scrollDashboardBy, { top: 160 })
  await waitForNoPageChipExpansion(harness)
  const afterScrollExpandedCount = await evaluateInPage(harness, dashboardPage.countExpandedPageChips)

  return { target, first, second, afterScrollExpandedCount, closing: null }
}

async function measureTooltipTextPaddingHitArea(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findExpansionHitAreaTarget)

  assert.ok(target, 'expected a page chip expansion hit area for padding hover smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY,
  })
  const above = await waitForPageChipExpansionRect(harness, 'enough tooltip text')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.belowY,
  })
  const below = await waitForPageChipExpansionRect(harness, 'enough tooltip text')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.chipSurfaceX,
    y: target.chipSurfaceY,
  })
  const chipSurface = await waitForPageChipExpansionRect(harness, 'enough tooltip text')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, above, below, chipSurface }
}

async function measurePageChipInternalPointerMoveExpansion(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findInternalPointerTarget)

  assert.ok(target, 'expected a page chip with left-side internal hover surface')

  const before = await evaluateInPage(harness, dashboardPage.countExpandedPageChips)

  await evaluateInPage(harness, tooltipPage.dispatchChipPointerMove, { label: 'enough tooltip text', x: target.x, y: target.y })
  const expansion = await waitForPageChipExpansionRect(harness, 'enough tooltip text')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, before, expansion }
}

async function measureTooltipAfterActiveStateChanges(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })

  async function setActiveTab(tabId: number, windowId = 1) {
    await evaluateInPage(harness, tooltipPage.setActiveTab, { tabId, windowId })
    await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
    await waitForDashboardSettled(harness)
  }

  async function findTarget() {
    return evaluateInPage(harness, tooltipPage.findActiveStateTarget)
  }

  async function hoverTarget(target: { x: number, y: number }) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: target.x,
      y: target.y,
    })
    const tooltip = await waitForPageChipExpansionRect(harness, 'Example 2 with enough tooltip text')
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8,
    })
    await waitForNoPageChipExpansion(harness)
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

async function measureSuppressionMarkerTooltipLine(harness: DashboardHarness, label: string) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findSuppressionMarkerChipTarget, { label })

  assert.ok(target, `expected a title-suppression page chip for ${label}`)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await waitForPageChipExpansionRect(harness, label)

  const result = await evaluateInPage(harness, tooltipPage.readSuppressionMarkerExpansionLine, { label })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, result }
}

async function measureSuppressionMarkerChipLine(harness: DashboardHarness, label: string) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const result = await evaluateInPage(harness, tooltipPage.measureSuppressionMarkerRestingLine, { label })

  return { result }
}

async function measureSuppressionTokenCloseHighlight(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1420,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findSuppressionTokenTarget, { prefix: '— Shared Workspace' })

  assert.ok(target, 'expected a "— Shared Workspace" title-suppression token for the close-highlight smoke test')

  const readHighlightedChips = () => evaluateInPage(harness, tooltipPage.countSuppressionHighlightedChips)

  const baseline = await readHighlightedChips()

  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await wait(150)
  const onHover = await readHighlightedChips()

  await harness.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, x: target.x, y: target.y })
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, x: target.x, y: target.y })
  await waitForContextMenuState(harness, true)

  const onRightClick = await evaluateInPage(harness, tooltipPage.readSuppressionHighlightMenuState)

  // Close the menu by clicking elsewhere with the mouse (away from the menu). Base UI
  // restores focus to the token on close; the highlight must still clear because that
  // restored focus is not :focus-visible (mouse modality), so onFocus does not re-arm it.
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 860 })
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: 8, y: 860 })
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: 8, y: 860 })
  await waitForContextMenuState(harness, false)

  const afterClickAway = await evaluateInPage(harness, tooltipPage.readSuppressionHighlightAfterClickAway)

  // Park the pointer away so later smoke measurements start clean.
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 })
  await wait(150)

  return { baseline, onHover, onRightClick, afterClickAway }
}

async function measurePageChipTooltipLineCount(
  harness: DashboardHarness,
  label: string,
  options: { forcedTextWidth?: number, forcedMaxLines?: number, hoverWaitMs?: number, viewportWidth?: number } = {},
) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: options.viewportWidth || 1000,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, pageChipExpansionPage.findPageChipLineCountTarget, {
    label,
    forcedTextWidth: options.forcedTextWidth || 0,
    forcedMaxLines: options.forcedMaxLines || 0,
  })

  assert.ok(target, `expected a page chip for tooltip line-count check: ${label}`)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  if (options.hoverWaitMs === undefined) {
    await waitForPageChipExpansionRect(harness, label)
  } else {
    await wait(options.hoverWaitMs)
  }

  const tooltip = await evaluateInPage(harness, pageChipExpansionPage.readPageChipExpansionLines, { label })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, tooltip }
}

async function measureFoldedPageChipTooltipTitleLineCount(
  harness: DashboardHarness,
  label: string,
  options: { forcedTextWidth?: number } = {},
) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, pageChipExpansionPage.findFoldedChipTarget, { label, forcedTextWidth: options.forcedTextWidth || 0 })

  assert.ok(target, `expected a folded page chip for tooltip check: ${label}`)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await waitForPageChipExpansionRect(harness, label)

  const tooltip = await evaluateInPage(harness, pageChipExpansionPage.readFoldedChipExpansion, { label })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, tooltip }
}

async function measureFoldedEnvHoverTooltips(
  harness: DashboardHarness,
  label: string,
) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await Promise.all([
    waitForDashboardSettled(harness),
    waitForNoTitleExpansion(harness),
  ])

  const target = await evaluateInPage(harness, pageChipExpansionPage.findFoldedEnvButtonTarget, { label })

  assert.ok(target, `expected a folded env button for tooltip check: ${label}`)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await waitForTooltipRect(harness)

  const tooltipTexts = await getVisibleTooltipTexts(harness)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoTitleExpansion(harness)

  return { target, tooltipTexts }
}

async function measureInteractiveTooltipClickReturnFocus(
  harness: DashboardHarness,
  selector: string,
  marker: string,
  targetLabel: string,
  requiredDescendantSelector: string,
) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, pageChipExpansionPage.findClickReturnTrigger, { selector, requiredDescendantSelector, marker, targetLabel })

  assert.ok(target, `expected a ${targetLabel} tooltip trigger for click-return smoke test`)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const expansion = await waitForPageChipExpansionRect(harness, marker)
  const first = { found: !!expansion, expansion }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await wait(120)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  const afterReturnFocus = await evaluateInPage(harness, pageChipExpansionPage.refocusClickReturnTarget, { targetLabel })
  await wait(240)

  return {
    target,
    first,
    afterReturnFocus,
    afterReturnTooltips: await getVisibleTooltipTexts(harness),
  }
}

async function measurePageChipOriginalSlotLeave(harness: DashboardHarness) {
  const label = 'Tooltip Boundary Alpha'
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, pageChipExpansionPage.findOriginalSlotLeaveTarget, { label })

  assert.ok(target, 'expected a page chip to hover for original-slot leave smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, label)

  assert.ok(first, `page chip should expand before original-slot leave check: ${JSON.stringify({ target, first })}`)
  assert.ok(
    first.right > target.slotRight + 8,
    `original-slot leave smoke needs an expanded-only horizontal area: ${JSON.stringify({ target, first })}`,
  )

  const expandedOnlyPoint = {
    x: Math.round(Math.min(first.right - 4, target.slotRight + 16)),
    y: Math.round((Math.max(first.top, target.slotTop) + Math.min(first.bottom, target.slotBottom)) / 2),
  }
  assert.ok(
    expandedOnlyPoint.x > target.slotRight + 1 && expandedOnlyPoint.x < first.right,
    `original-slot leave point should be outside the original slot and inside the expanded chip: ${JSON.stringify({ target, first, expandedOnlyPoint })}`,
  )
  assert.ok(
    expandedOnlyPoint.y >= first.top && expandedOnlyPoint.y <= first.bottom,
    `original-slot leave point should stay vertically inside the expanded chip: ${JSON.stringify({ target, first, expandedOnlyPoint })}`,
  )

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: expandedOnlyPoint.x,
    y: expandedOnlyPoint.y,
  })
  await wait(220)
  const afterOriginalSlotLeave = await waitForPageChipExpansionRect(harness, label, 250)

  for (let index = 0; index < 8; index += 1) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8 + index * 16,
      y: 8 + index * 5,
    })
    await wait(80)
  }
  const afterLeaveTooltips = await evaluateInPage(harness, dashboardPage.readExpandedPageChipTexts)

  return { target, first, expandedOnlyPoint, afterOriginalSlotLeave, afterLeaveTooltips }
}

async function measureTooltipPopupClickFocus(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, focusUpdatesPage.installFocusUpdateStubs, { scrollSelector: '.scroll-region' })
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findPageChipHoverPoint, { label: PAGE_CHIP_EXPANSION_SMOKE_LABEL })

  assert.ok(target, 'expected a page chip to hover for popup click smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, PAGE_CHIP_EXPANSION_SMOKE_LABEL)
  assert.ok(first, `page chip should expand before in-place click check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2),
  }
  const popupStyle = await evaluateInPage(harness, pageChipExpansionPage.readExpandedChipStyle, { label: PAGE_CHIP_EXPANSION_SMOKE_LABEL })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y,
  })
  await wait(80)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: popupPoint.x,
    y: popupPoint.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: popupPoint.x,
    y: popupPoint.y,
  })
  await waitForFocusUpdates(harness)

  const updates = await evaluateInPage(harness, focusUpdatesPage.collectFocusUpdates)

  return { target, first, popupPoint, popupStyle, updates }
}

async function measureHistoryEntryExpansionClickFocus(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, focusUpdatesPage.installFocusUpdateStubs, { scrollSelector: '.history-entry-list' })
  await Promise.all([
    waitForDashboardSettled(harness),
    waitForScrollTop(harness, '.history-entry-list'),
  ])

  const target = await evaluateInPage(harness, historyEntryPage.findHistoryEntryHoverTarget, { label: 'Low score history item with enough tooltip text' })

  assert.ok(target, 'expected a history-panel entry to hover for expansion click smoke test')
  await wait(180)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForHistoryEntryExpansionRect(harness, 'Low score history item with enough tooltip text')
  assert.ok(first, `history entry should expand before click check: ${JSON.stringify({ target, first })}`)

  const expandedPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2),
  }
  const expandedStyle = await evaluateInPage(harness, historyEntryPage.readExpandedHistoryEntryStyle)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'right',
    buttons: 2,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'right',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await waitForContextMenuState(harness, true)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.dismissX,
    y: target.y,
  })
  await wait(80)
  const expansionCollapseProbeStarted = await startClassRetentionProbe(harness, {
    selector: '[data-tabout="activation-history-entry"]',
    label: 'Low score history item with enough tooltip text',
    className: 'history-entry-row-expanded-open',
  })
  assert.equal(expansionCollapseProbeStarted, true, `expected to observe history-entry expansion during backdrop dismissal: ${JSON.stringify({ target, first })}`)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.dismissX,
    y: target.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.dismissX,
    y: target.y,
  })
  await waitForContextMenuState(harness, false)
  const expansionCollapsedDuringBackdropDismissal = await finishClassRetentionProbe(harness)
  assert.equal(expansionCollapsedDuringBackdropDismissal, false, `clicking the context menu backdrop over the original history-entry slot should not collapse and reopen its expansion: ${JSON.stringify({ target, first })}`)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await wait(80)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await waitForFocusUpdates(harness)

  const updates = await evaluateInPage(harness, focusUpdatesPage.collectFocusUpdates)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoHistoryEntryExpansion(harness)

  return { target, first, expandedPoint, activationPoint: target, expandedStyle, updates }
}

async function measurePageChipContextMenuSave(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, contextMenuPage.installSmokeChromeStubs)
  await waitForDashboardSettled(harness)

  async function findPageChipTarget(label: string, xOffset = 96) {
    return evaluateInPage(harness, contextMenuPage.findPageChipTarget, { label, xOffset })
  }

  async function findPageChipFaviconTarget(label: string) {
    return evaluateInPage(harness, contextMenuPage.findPageChipFaviconTarget, { label })
  }

  const target = await findPageChipTarget('Short title')
  const targetFavicon = await findPageChipFaviconTarget('Short title')
  const replacementTarget = await findPageChipTarget('Example 2 with enough tooltip text', 140)
  const historyMatchTarget = await findPageChipTarget('Example 3 with enough tooltip text', 16)

  assert.ok(target, 'expected a live page chip for context menu save smoke test')
  assert.ok(targetFavicon, 'expected a live page chip favicon target for close-hover smoke test')
  assert.ok(replacementTarget, 'expected a second live page chip for context menu replacement smoke test')
  assert.ok(historyMatchTarget, 'expected a live page chip with a matching history entry for context menu hover smoke test')
  // Hoisted function declarations do not see the narrowing above.
  const chipTarget = target

  async function openContextMenuAt(menuTarget: { x: number, y: number }) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: menuTarget.x,
      y: menuTarget.y,
    })
    await wait(80)
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'right',
      buttons: 2,
      clickCount: 1,
      x: menuTarget.x,
      y: menuTarget.y,
    })
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'right',
      buttons: 0,
      clickCount: 1,
      x: menuTarget.x,
      y: menuTarget.y,
    })
    await waitForContextMenuState(harness, true)
  }

  async function readContextMenuState() {
    return evaluateInPage(harness, contextMenuPage.readContextMenuState)
  }

  async function readPageChipVisualState(menuTarget: { label: string }) {
    return evaluateInPage(harness, contextMenuPage.readPageChipVisualState, { label: menuTarget.label })
  }

  async function dismissContextMenuWithPointer() {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8,
    })
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: 8,
      y: 8,
    })
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      x: 8,
      y: 8,
    })
    await waitForContextMenuState(harness, false)
  }

  async function clickMenuItem(label: string) {
    await openContextMenuAt(chipTarget)

    const item = await evaluateInPage(harness, contextMenuPage.findContextMenuItem, { label })

    assert.ok(item, `expected ${label} context menu item after right-click: ${JSON.stringify({ target })}`)

    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: item.x,
      y: item.y,
    })
    await wait(80)
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      buttons: 1,
      clickCount: 1,
      x: item.x,
      y: item.y,
    })
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      clickCount: 1,
      x: item.x,
      y: item.y,
    })
    await waitForBrowserCondition(
      harness,
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
      { args: [label] },
    )

    return item
  }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await wait(180)
  const restingChipState = await readPageChipVisualState(target)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await wait(180)
  const hoverChipState = await readPageChipVisualState(target)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: targetFavicon.x,
    y: targetFavicon.y,
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
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: freshHistoryMatchTarget.x,
    y: freshHistoryMatchTarget.y,
  })
  await wait(180)
  const hoveredHistoryChipState = await readPageChipVisualState(freshHistoryMatchTarget)
  await openContextMenuAt(freshHistoryMatchTarget)
  const contextMenuHistoryChipState = await readPageChipVisualState(freshHistoryMatchTarget)
  assert.equal(hoveredHistoryChipState?.urlPreview, 'https://tab-out-smoke-03.com/docs/3', `hovering the matching-history page chip should set the shared hover URL before the context menu opens: ${JSON.stringify({ hoveredHistoryChipState, freshHistoryMatchTarget })}`)
  assert.equal(contextMenuHistoryChipState?.contextMenuOpen, true, `matching-history page chip should carry the context-menu-open class: ${JSON.stringify({ contextMenuHistoryChipState })}`)
  assert.equal(contextMenuHistoryChipState?.urlPreview, hoveredHistoryChipState?.urlPreview, `opening the page chip context menu should keep the shared hover URL active for cross-surface matching: ${JSON.stringify({ hoveredHistoryChipState, contextMenuHistoryChipState })}`)
  await dismissContextMenuWithPointer()

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: replacementTarget.x,
    y: replacementTarget.y,
  })
  await waitForPageChipExpansionRect(harness, 'Example 2 with enough tooltip text')
  const expandedHoverChipState = await readPageChipVisualState(replacementTarget)
  const visibleTooltipCountBeforeMenu = await evaluateInPage(harness, contextMenuPage.countVisibleTooltips)
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
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y,
  })
  await wait(80)
  const expansionCollapseProbeStarted = await startClassRetentionProbe(harness, {
    selector: '[data-tabout="page-chip"]',
    label: replacementTarget.label,
    className: 'page-chip-expanded',
  })
  assert.equal(expansionCollapseProbeStarted, true, `expected to observe page-chip expansion during backdrop dismissal: ${JSON.stringify({ replacementTarget })}`)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y,
  })
  await wait(30)
  const backdropDismissPressedState = await readPageChipVisualState(replacementTarget)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y,
  })
  await wait(20)
  const backdropDismissReleasedState = await readPageChipVisualState(replacementTarget)
  await waitForContextMenuState(harness, false)
  const expansionCollapsedDuringBackdropDismissal = await finishClassRetentionProbe(harness)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)
  await waitForBrowserCondition(
    harness,
    () => !document.querySelector('.page-chip-context-menu-open'),
    'page chip context-menu visual state should clear after backdrop dismissal',
  )
  const backdropDismissAfterState = await readPageChipVisualState(replacementTarget)
  const backdropDismissMenuState = await readContextMenuState()
  assert.equal(backdropDismissOpenState?.contextMenuOpen, true, `page chip should carry the context-menu-open class before backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState })}`)
  assert.equal(backdropDismissPressedState?.contextMenuOpen, true, `page chip should keep the context-menu-open visual class during backdrop dismissal: ${JSON.stringify({ backdropDismissPressedState })}`)
  assert.equal(backdropDismissPressedState?.backgroundColor, backdropDismissOpenState?.backgroundColor, `clicking the context menu backdrop over the page chip should not flash the chip background: ${JSON.stringify({ backdropDismissOpenState, backdropDismissPressedState })}`)
  assert.equal(backdropDismissReleasedState?.backgroundColor, backdropDismissOpenState?.backgroundColor, `page chip should bridge the first backdrop dismissal frame without a background flash: ${JSON.stringify({ backdropDismissOpenState, backdropDismissReleasedState })}`)
  assert.equal(expansionCollapsedDuringBackdropDismissal, false, `clicking the context menu backdrop over the expanded page chip should not collapse and reopen its expansion: ${JSON.stringify({ backdropDismissOpenState, backdropDismissPressedState, backdropDismissReleasedState })}`)
  assert.equal(backdropDismissAfterState?.contextMenuOpen, false, `page chip should clear the context-menu-open class after backdrop dismissal: ${JSON.stringify({ backdropDismissOpenState, backdropDismissAfterState })}`)
  assert.equal(backdropDismissAfterState?.expanded, false, `page chip should close its in-place expansion after backdrop dismissal and pointer exit: ${JSON.stringify({ backdropDismissOpenState, backdropDismissAfterState })}`)
  assert.equal(backdropDismissMenuState.visibleMenuCount, 0, `backdrop dismissal over the page chip should close the context menu: ${JSON.stringify({ backdropDismissMenuState })}`)
  await openContextMenuAt(replacementTarget)
  const tooltipShieldPoint = await evaluateInPage(harness, contextMenuPage.installTooltipShield)
  const shieldBeforeClick = await evaluateInPage(harness, contextMenuPage.readTooltipShieldTarget, { point: tooltipShieldPoint })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y,
  })
  await wait(80)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: tooltipShieldPoint.x,
    y: tooltipShieldPoint.y,
  })
  await waitForContextMenuState(harness, false)
  const shieldAfterClick = await evaluateInPage(harness, contextMenuPage.restoreFocusUpdateStubs)
  assert.notEqual(shieldBeforeClick.topSlot, 'tooltip-content', `context menu backdrop should cover visible tooltips: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)
  assert.equal(shieldAfterClick.focusUpdateCount, 0, `clicking where a tooltip is visible while context menu is open should not focus/open the page: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)
  assert.equal(shieldAfterClick.menuOpen, false, `clicking the context menu backdrop over a tooltip should dismiss the menu: ${JSON.stringify({ shieldBeforeClick, shieldAfterClick })}`)

  const copyItem = await clickMenuItem('Copy page title text')
  const copyResult = await evaluateInPage(harness, contextMenuPage.readCopyResult)

  const saveItem = await clickMenuItem('Save page')

  const saveResult = await evaluateInPage(harness, contextMenuPage.readSaveResult, { itemText: 'Save page' })

  await openContextMenuAt(target)
  const sourceButtonTarget = await evaluateInPage(harness, contextMenuPage.findSourceSwitchButton, { label: 'Bookmarks' })

  assert.ok(sourceButtonTarget, 'expected the Bookmarks source switch button for context menu outside-click smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y,
  })
  await wait(80)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: sourceButtonTarget.x,
    y: sourceButtonTarget.y,
  })
  await waitForBrowserCondition(
    harness,
    () => {
      const active = document.querySelector('.source-switch-option[data-active]')?.textContent?.trim()
      const menu = document.querySelector('[data-slot="context-menu-content"]')
      return active === 'All Tabs' && (!menu || menu.getClientRects().length === 0)
    },
    'outside click should close the context menu without activating Bookmarks',
  )

  const outsideClickResult = await evaluateInPage(harness, contextMenuPage.readOutsideClickResult, { activeBefore: sourceButtonTarget.activeBefore })

  return { target, firstOpenState, replacementState, shieldBeforeClick, shieldAfterClick, copyItem, copyResult, saveItem, saveResult, outsideClickResult }
}

async function measureTooltipPopupWheelScroll(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findPageChipHoverPoint, { label: PAGE_CHIP_EXPANSION_SMOKE_LABEL })

  assert.ok(target, 'expected a page chip to hover for popup wheel smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  assert.ok(first, `page chip should expand before in-place wheel check: ${JSON.stringify({ target, first })}`)

  const popupPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2),
  }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popupPoint.x,
    y: popupPoint.y,
  })
  await wait(80)

  const beforeScrollTop = await evaluateInPage(harness, dashboardPage.readDashboardScrollTop)

  const wheelSteps = []
  for (let index = 0; index < 4; index += 1) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 36,
      x: popupPoint.x,
      y: popupPoint.y,
    })
    await wait(60)
    wheelSteps.push(await evaluateInPage(harness, dashboardPage.readWheelScrollState))
  }
  await waitForNoPageChipExpansion(harness)

  const after = await evaluateInPage(harness, dashboardPage.readWheelScrollState)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoTitleExpansion(harness)

  const afterLeaveExpandedCount = await evaluateInPage(harness, dashboardPage.countExpandedPageChips)

  return { target, first, popupPoint, beforeScrollTop, wheelSteps, after, afterLeaveExpandedCount }
}

const HISTORY_SMOKE_ENTRY_LABEL = 'Low score history item with enough tooltip text'

async function measureHistoryEntryExpansionSurfaceHitArea(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, historyEntryPage.scrollHistoryListToTop)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await Promise.all([
    waitForDashboardSettled(harness),
    waitForScrollTop(harness, '.history-entry-list'),
    waitForNoTitleExpansion(harness),
  ])

  const target = await evaluateInPage(harness, historyEntryPage.findHistoryEntryFaviconFrameTarget, { label: HISTORY_SMOKE_ENTRY_LABEL })

  assert.ok(target, 'expected a history entry favicon frame with vertical padding for expansion hit-area smoke test')
  await wait(180)

  async function visibleTooltipTexts() {
    return evaluateInPage(harness, tooltipPage.readOpenTooltipTexts)
  }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.aboveY,
  })
  const above = await waitForHistoryEntryExpansionRect(harness, 'Low score history item with enough tooltip text')
  const aboveTooltipTexts = await visibleTooltipTexts()

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoHistoryEntryExpansion(harness)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.belowY,
  })
  const below = await waitForHistoryEntryExpansionRect(harness, 'Low score history item with enough tooltip text')
  const belowTooltipTexts = await visibleTooltipTexts()

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoHistoryEntryExpansion(harness)

  return { target, above, below, aboveTooltipTexts, belowTooltipTexts }
}

async function measureHistoryEntryExpansionWheelScroll(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, historyEntryPage.scrollHistoryListToTop)
  await Promise.all([
    waitForDashboardSettled(harness),
    waitForScrollTop(harness, '.history-entry-list'),
  ])

  const target = await evaluateInPage(harness, historyEntryPage.findHistoryEntryWheelTarget, { label: HISTORY_SMOKE_ENTRY_LABEL })

  assert.ok(target, 'expected a history-panel entry to hover for expansion wheel smoke test')
  await wait(180)

  const scrollbarGeometry = await evaluateInPage(harness, historyEntryPage.readHistoryScrollbarGeometry)
  assert.ok(scrollbarGeometry, 'expected history scrollbar geometry for the expansion wheel smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: scrollbarGeometry.revealPoint.x,
    y: scrollbarGeometry.revealPoint.y,
  })
  await wait(60)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForHistoryEntryExpansionRect(harness, 'Low score history item with enough tooltip text')
  await waitForHistoryScrollbarThumbOpacity(harness, '1')

  assert.ok(first, `history entry should expand before wheel check: ${JSON.stringify({ target, first })}`)

  const tooltipOpenEntryState = await evaluateInPage(harness, historyEntryPage.readExpandedEntryLayering, { label: HISTORY_SMOKE_ENTRY_LABEL })

  const scrollbarOverlapState = await evaluateInPage(harness, historyEntryPage.probeScrollbarOverlap, { label: HISTORY_SMOKE_ENTRY_LABEL })

  const expandedPoint = {
    x: Math.round(first.left + first.width / 2),
    y: Math.round(first.top + first.height / 2),
  }
  assert.ok(
    first.right > target.slotRight + 8,
    `history original-slot leave smoke needs an expanded-only horizontal area: ${JSON.stringify({ target, first })}`,
  )
  const expandedOnlyPoint = {
    x: Math.round(Math.min(first.right - 4, target.slotRight + 16)),
    y: Math.round((Math.max(first.top, target.slotTop) + Math.min(first.bottom, target.slotBottom)) / 2),
  }
  assert.ok(
    expandedOnlyPoint.x > target.slotRight + 1 && expandedOnlyPoint.x < first.right,
    `history original-slot leave point should be outside the original slot and inside the expanded entry: ${JSON.stringify({ target, first, expandedOnlyPoint })}`,
  )
  const expandedOnlyHitTarget = await evaluateInPage(harness, historyEntryPage.hitTestExpandedEntry, { label: HISTORY_SMOKE_ENTRY_LABEL, point: expandedOnlyPoint })

  const expandedOnlyClipCheck = await evaluateInPage(harness, historyEntryPage.hitTestExpandedEntryWithPointerEvents, { label: HISTORY_SMOKE_ENTRY_LABEL, point: expandedOnlyPoint })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: expandedOnlyPoint.x,
    y: expandedOnlyPoint.y,
  })
  await waitForNoHistoryEntryExpansion(harness)
  const afterOriginalSlotLeave = null

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const reopened = await waitForHistoryEntryExpansionRect(harness, 'Low score history item with enough tooltip text')
  assert.ok(reopened, `history entry should reopen before wheel check: ${JSON.stringify({ target, first, afterOriginalSlotLeave })}`)

  const beforeScrollTop = await evaluateInPage(harness, dashboardPage.readScrollTops)

  const wheelDeltaY = beforeScrollTop.historyScrollTop >= target.listMaxScrollTop - 1 ? -18 : 18
  for (let index = 0; index < 4; index += 1) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: wheelDeltaY,
      x: target.x,
      y: target.y,
    })
    await wait(60)
  }
  await waitForNoHistoryEntryExpansion(harness)

  const after = await evaluateInPage(harness, historyEntryPage.readHistoryWheelState)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoTitleExpansion(harness)

  const afterLeaveExpansionState = await evaluateInPage(harness, historyEntryPage.readExpansionCounts)

  return { target, first, scrollbarGeometry, scrollbarOverlapState, expandedPoint, expandedOnlyPoint, expandedOnlyClipCheck, expandedOnlyHitTarget, afterOriginalSlotLeave, tooltipOpenEntryState, beforeScrollTop, wheelDeltaY, after, afterLeaveExpansionState }
}

function assertHistoryScrollbarLayering(result: Awaited<ReturnType<typeof measureHistoryEntryExpansionWheelScroll>>) {
  const overlap = result.scrollbarOverlapState
  assert.ok(
    overlap?.overlapPoint,
    `history scrollbar overlap smoke needs the visible thumb and expanded entry to intersect: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.clipPath,
    'none',
    `history scrollbar should not rely on a fixed geometry cutout: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.thumbOpacity,
    '1',
    `history scrollbar should remain visible while the expanded entry covers only their overlap: ${JSON.stringify(overlap)}`,
  )
  assert.ok(
    overlap.visibleThumbLength > 1,
    `history scrollbar should retain a visible thumb segment outside the expanded entry: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.visibleThumbHitScrollbar,
    true,
    `the uncovered thumb segment should remain pointer-interactive: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.hitScrollbar,
    false,
    `expanded history entry should keep the covered scrollbar band from receiving input: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.hitExpanded,
    true,
    `expanded history entry should own its scrollbar overlap under production pointer events: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.hitInputShield,
    true,
    `expanded history entry should expose its narrow scrollbar input shield at the overlap: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.hitInsideHistoryList,
    true,
    `wheel input over the covered scrollbar band should stay in the history scroller event path: ${JSON.stringify(overlap)}`,
  )
  assert.ok(
    overlap.shiftedEntryTop > overlap.entryRect.top + 20,
    `history stacking probe should move the expanded entry away from its initial scrollbar overlap: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.shiftedHitScrollbar,
    false,
    `the shifted expanded entry should continue painting above the scrollbar: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.shiftedHitExpanded,
    true,
    `the moving expanded entry should carry the scrollbar redaction with it: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.shiftedHitInputShield,
    true,
    `the moving expanded entry should carry its scrollbar input shield with it: ${JSON.stringify(overlap)}`,
  )
  assert.equal(
    overlap.shiftedHitInsideHistoryList,
    true,
    `the shifted scrollbar input shield should remain in the history scroller event path: ${JSON.stringify(overlap)}`,
  )
}

async function measureHistoryLeftGutterWheelScroll(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1800,
    height: 260,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, historyEntryPage.scrollHistoryAndDashboardToTop)
  await Promise.all([
    waitForDashboardSettled(harness),
    waitForScrollTop(harness, '.history-entry-list'),
  ])

  const target = await evaluateInPage(harness, historyEntryPage.readHistoryLeftGutterTarget)

  assert.ok(target, 'expected history left gutter target to be measurable')

  const beforeScrollTop = await evaluateInPage(harness, dashboardPage.readScrollTops)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  await wait(80)

  for (let index = 0; index < 4; index += 1) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 36,
      x: target.x,
      y: target.y,
    })
    await wait(60)
  }
  await wait(160)

  const after = await evaluateInPage(harness, dashboardPage.readScrollTops)

  return { target, beforeScrollTop, after }
}

async function measureNarrowViewportScrollbarEdges(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollAllToTop)
  await Promise.all([
    waitForDashboardSettled(harness),
    waitForScrollTop(harness, '.history-entry-list'),
  ])

  async function readSnapshot() {
    return evaluateInPage(harness, historyEntryPage.readNarrowViewportSnapshot)
  }

  const initial = await readSnapshot()
  assert.ok(initial, 'expected narrow viewport scrollbar geometry to be measurable')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.historyRailTargetX,
    y: initial.historyRailTargetY,
  })
  await wait(360)
  const afterHistoryRailHover = await readSnapshot()

  // Hover the visible thumb itself: this is what widens the rail (mirrors the
  // native ::-webkit-scrollbar-thumb:hover), so target the thumb center, not
  // the empty track gutter the rail-hover step above lands in.
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.historyThumbCenterX,
    y: initial.historyThumbCenterY,
  })
  await wait(360)
  const afterHistoryThumbHover = await readSnapshot()
  assert.ok(afterHistoryThumbHover, 'expected narrow viewport geometry after hovering the history thumb')

  // Press the thumb, then drag the pointer well OFF the rail: a native bar stays
  // at its wide grabbed size for the whole drag, so the thumb must keep hover
  // width here even though the pointer is no longer over it.
  const dragOffRailX = Math.max(20, initial.historyThumbCenterX - 220)
  const dragOffRailY = initial.historyThumbCenterY + 40
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: initial.historyThumbCenterX, y: initial.historyThumbCenterY, button: 'left', buttons: 1, clickCount: 1,
  })
  await wait(60)
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragOffRailX, y: dragOffRailY, button: 'left', buttons: 1 })
  await wait(220)
  const duringHistoryThumbDrag = await readSnapshot()
  assert.ok(duringHistoryThumbDrag, 'expected narrow viewport geometry during the history thumb drag')
  await harness.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragOffRailX, y: dragOffRailY, button: 'left' })
  await wait(120)
  // Reset scroll so the drag doesn't perturb the independent-scroll checks below.
  await evaluateInPage(harness, historyEntryPage.scrollHistoryListToTop)
  await waitForScrollTop(harness, '.history-entry-list')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.historyTargetX,
    y: initial.historyTargetY,
  })
  await wait(80)
  for (let index = 0; index < 5; index += 1) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 48,
      x: initial.historyTargetX,
      y: initial.historyTargetY,
    })
    await wait(50)
  }
  await wait(180)
  const afterHistoryWheel = await readSnapshot()

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: initial.dashboardTargetX,
    y: initial.dashboardTargetY,
  })
  await wait(80)
  for (let index = 0; index < 5; index += 1) {
    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      deltaX: 0,
      deltaY: 48,
      x: initial.dashboardTargetX,
      y: initial.dashboardTargetY,
    })
    await wait(50)
  }
  await wait(180)
  const afterDashboardWheel = await readSnapshot()

  return { initial, afterHistoryRailHover, afterHistoryThumbHover, duringHistoryThumbDrag, afterHistoryWheel, afterDashboardWheel }
}

async function measureTooltipWindowBlurClose(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findPageChipHoverPoint, { label: PAGE_CHIP_EXPANSION_SMOKE_LABEL })

  assert.ok(target, 'expected a page chip for expansion window-blur smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateInPage(harness, tooltipPage.dispatchWindowBlur)
  await waitForNoTitleExpansion(harness)

  const afterBlurTooltips = await evaluateInPage(harness, dashboardPage.readExpandedPageChipTexts)

  return { target, first, afterBlurTooltips }
}

async function measureTooltipVisibilityChangeClose(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findPageChipHoverPoint, { label: PAGE_CHIP_EXPANSION_SMOKE_LABEL })

  assert.ok(target, 'expected a page chip for expansion visibility-change smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await wait(180)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, PAGE_CHIP_EXPANSION_SMOKE_LABEL)

  await evaluateInPage(harness, tooltipPage.simulateDocumentHidden)
  await waitForNoTitleExpansion(harness)

  const afterVisibilityChangeTooltips = await evaluateInPage(harness, dashboardPage.readExpandedPageChipTexts)

  return { target, first, afterVisibilityChangeTooltips }
}

async function measureActionTooltipClickClose(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findSectionPinButton)

  assert.ok(target, 'expected a pin button for tooltip click-close smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const first = await waitForTooltipRect(harness)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: target.x,
    y: target.y,
  })
  await wait(120)

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoVisibleTooltip(harness)

  const afterLeaveTooltips = await getVisibleTooltipTexts(harness)

  const focusedAfterLeave = await evaluateInPage(harness, tooltipPage.isSectionPinButtonFocused)

  return { target, first, afterLeaveTooltips, focusedAfterLeave }
}

async function measureMarkerToChipTooltipHandoff(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findHandoffChipTarget, { label: 'Hover Handoff Title' })

  assert.ok(target, 'expected a chip with a strip indicator for expansion handoff smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.markerX,
    y: target.y,
  })
  const markerTooltipExpansion = await waitForPageChipExpansionRect(harness, 'Hover Handoff Title')
  const markerTooltip = {
    found: !!markerTooltipExpansion,
    expansion: markerTooltipExpansion,
    tooltips: await getVisibleTooltipTexts(harness),
  }

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.textX,
    y: target.y,
  })
  const chipTooltipExpansion = await waitForPageChipExpansionRect(harness, 'Hover Handoff Title')
  const chipTooltip = {
    found: !!chipTooltipExpansion,
    expansion: chipTooltipExpansion,
    tooltips: await getVisibleTooltipTexts(harness),
  }

  return { target, markerTooltip, chipTooltip }
}

async function measureShortChipTooltipAbsence(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const target = await evaluateInPage(harness, tooltipPage.findShortChipTarget, { label: 'Short title' })

  assert.ok(target, 'expected a short page chip to hover for tooltip absence smoke test')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y,
  })
  await wait(650)

  const tooltipCount = await evaluateInPage(harness, tooltipPage.countTooltipNodes)

  return { target, tooltipCount }
}

async function measureTooltipEdgeFlip(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, tooltipPage.findViewportEdgeChipTarget, { marker: 'viewport-edge' })

  assert.ok(target, 'expected a right-edge page chip to hover for expansion smoke test')

  await waitForDashboardSettled(harness)
  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.startX,
    y: target.y,
  })
  const first = await waitForPageChipExpansionRect(harness, 'viewport-edge')

  return { target, first }
}

async function measureCompactTitleVariantExpansion(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, titleVariantsPage.injectSmokeTabs, { hook: '__tabOutSmokeAddCompactTitleVariantTabs' })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, titleVariantsPage.findCompactVariantChipTarget)

  assert.ok(target, 'expected compact same-title URL variant chip for expansion width smoke')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const expansion = await waitForPageChipExpansionRect(harness, 'Order Page')
  const expandedVariantLabels = await evaluateInPage(harness, titleVariantsPage.readExpandedVariantLabels, { label: 'Order Page' })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, expansion, expandedVariantLabels }
}

async function measurePlainTitleVariantEdgeExpansion(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, titleVariantsPage.injectSmokeTabs, { hook: '__tabOutSmokeAddPlainTitleVariantTabs' })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, titleVariantsPage.findPlainVariantChipTarget)

  assert.ok(target?.surfaces, `expected plain same-title URL variant chip for edge expansion smoke: ${JSON.stringify(target)}`)

  const surfaceResults = []
  for (const [surface, point] of Object.entries(target.surfaces)) {
    const preHoverState = await evaluateInPage(harness, titleVariantsPage.readPlainVariantHoverState, { point })

    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: (point as { x: number, y: number }).x,
      y: (point as { x: number, y: number }).y,
    })
    const expansion = await waitForPageChipExpansionRect(harness, 'Plain Title Variant')
    const expandedVariantLabels = await evaluateInPage(harness, titleVariantsPage.readExpandedVariantLabels, { label: 'Plain Title Variant' })
    const hoverState = await evaluateInPage(harness, titleVariantsPage.readPlainVariantHoverState, { point })

    surfaceResults.push({ expandedVariantLabels, expansion, hoverState, point, preHoverState, surface })

    await harness.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 8,
      y: 8,
    })
    await waitForNoPageChipExpansion(harness)
  }

  return { target, surfaceResults }
}

async function measureWrappedTitleVariantExpansion(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, titleVariantsPage.injectSmokeTabs, { hook: '__tabOutSmokeAddWrappedTitleVariantTabs' })
  await evaluateInPage(harness, dashboardPage.scrollDashboardToTop)
  await waitForDashboardSettled(harness)

  const target = await evaluateInPage(harness, titleVariantsPage.findWrappedVariantChipTarget)

  assert.ok(target, 'expected wrapped same-title URL variant chip for expansion width smoke')

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
  })
  const expansion = await evaluateInPage(harness, titleVariantsPage.waitForWrappedVariantExpansion, { label: 'Example Store' })

  await harness.session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 8,
    y: 8,
  })
  await waitForNoPageChipExpansion(harness)

  return { target, expansion }
}

async function measureDuplicateStackGeometry(harness: DashboardHarness) {
  await harness.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await evaluateInPage(harness, titleVariantsPage.injectSmokeTabs, { hook: '__tabOutSmokeAddDuplicateStackTabs' })

  return evaluateInPage(harness, titleVariantsPage.measureDuplicateStackGeometry)
}

// Recorded Chrome focus calls carry their raw arguments; the update
// properties object is the second argument.
function focusUpdateTargets(
  updates: readonly focusUpdatesPage.FocusUpdate[],
  kind: focusUpdatesPage.FocusUpdate['kind'],
  flag: 'active' | 'focused',
): boolean {
  return updates.some((update) => {
    const properties = update.args[1]
    return update.kind === kind &&
      typeof properties === 'object' &&
      properties !== null &&
      (properties as Record<string, unknown>)[flag] === true
  })
}

// Missing geometry reads as misaligned, matching the NaN comparison the
// untyped measurements relied on.
function alignedWithin(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= 1
}

test('dashboard cards repack when the viewport resizes', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const harness = await createDashboardHarness(page)

  if (RUN_HISTORY_SCROLLBAR_OVERLAP_ONLY) {
    const historyScrollbarOverlap = await measureHistoryEntryExpansionWheelScroll(harness)
    assertHistoryScrollbarLayering(historyScrollbarOverlap)
    return
  }

  const wide = await measureDashboard(harness, 1420)
  const tailFill = await measureTruncatedTitleTailFill(harness)
  const besideFloor = await measureDashboard(harness, 1000)
  const constrained = await measureDashboard(harness, 920)
  const narrow = await measureDashboard(harness, 760)
  const initialTooltipMeasureNodes = await measureInitialTooltipMeasureNodes(harness)

  assert.ok(wide.cardCount >= 12, `dashboard should render enough cards for a column smoke test: ${JSON.stringify(wide)}`)
  assert.ok(wide.columns > narrow.columns, `expected columns to shrink after resize, got ${wide.columns} -> ${narrow.columns}`)
  assert.notEqual(wide.firstWidth, narrow.firstWidth, 'card width should respond to viewport resize')
  assert.ok(alignedWithin(wide.headerControlsRight, wide.missionsRight), `wide header controls should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(wide)}`)
  assert.ok(alignedWithin(wide.sourceSwitchRight, wide.missionsRight), `wide source switch should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(wide)}`)
  assert.ok(alignedWithin(besideFloor.headerControlsRight, besideFloor.missionsRight), `beside-history floor header controls should align to the scrollable missions grid: ${JSON.stringify(besideFloor)}`)
  assert.ok(alignedWithin(besideFloor.sourceSwitchRight, besideFloor.missionsRight), `beside-history floor source switch should align to the scrollable missions grid: ${JSON.stringify(besideFloor)}`)
  assert.ok(alignedWithin(constrained.headerControlsRight, constrained.missionsRight), `stacked history layout header controls should align to the scrollable missions grid: ${JSON.stringify(constrained)}`)
  assert.ok(alignedWithin(constrained.sourceSwitchRight, constrained.missionsRight), `stacked history layout source switch should align to the scrollable missions grid: ${JSON.stringify(constrained)}`)
  assert.ok(alignedWithin(narrow.headerControlsRight, narrow.missionsRight), `narrow layout header controls should align to the scrollable missions grid: ${JSON.stringify(narrow)}`)
  assert.ok(alignedWithin(narrow.sourceSwitchRight, narrow.missionsRight), `narrow layout source switch should align to the scrollable missions grid: ${JSON.stringify(narrow)}`)
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

  const horizontalScroll = await measureHorizontalScrollLock(harness)
  assert.equal(horizontalScroll.overflowX, 'hidden', `scroll region should hide horizontal overflow: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.overscrollBehaviorX, 'none', `scroll region should suppress x-axis overscroll: ${JSON.stringify(horizontalScroll)}`)
  assert.ok(horizontalScroll.scrollWidth > horizontalScroll.clientWidth, `smoke probe should create horizontal overflow: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.initialScrollLeft, 0, `scroll region should start at the left edge: ${JSON.stringify(horizontalScroll)}`)
  assert.equal(horizontalScroll.afterScrollLeft, 0, `horizontal wheel input should not move the scroll region sideways: ${JSON.stringify(horizontalScroll)}`)

  const historyLeftGutterScroll = await measureHistoryLeftGutterWheelScroll(harness)
  assert.ok(historyLeftGutterScroll.target.shellLeft > 40, `wide smoke viewport should create a left dashboard gutter: ${JSON.stringify(historyLeftGutterScroll)}`)
  assert.equal(historyLeftGutterScroll.target.listLeft, 0, `history scrollbox should bleed to the viewport edge on wide screens: ${JSON.stringify(historyLeftGutterScroll)}`)
  assert.ok(
    historyLeftGutterScroll.target.x >= historyLeftGutterScroll.target.hitAreaLeft &&
    historyLeftGutterScroll.target.x <= historyLeftGutterScroll.target.hitAreaRight,
    `history left gutter wheel target should land inside the scroll hit area: ${JSON.stringify(historyLeftGutterScroll)}`,
  )
  assert.equal(historyLeftGutterScroll.target.hitPart, 'history-scroll-hit-area', `left gutter should hit the history scroll target: ${JSON.stringify(historyLeftGutterScroll)}`)
  assert.ok(
    historyLeftGutterScroll.after.historyScrollTop - historyLeftGutterScroll.beforeScrollTop.historyScrollTop > 72,
    `wheel input in the left gutter should scroll activation history: ${JSON.stringify(historyLeftGutterScroll)}`,
  )
  assert.equal(
    historyLeftGutterScroll.after.dashboardScrollTop,
    historyLeftGutterScroll.beforeScrollTop.dashboardScrollTop,
    `left gutter history scroll should not scroll the domain cards pane: ${JSON.stringify(historyLeftGutterScroll)}`,
  )

  const narrowScrollbarEdges = await measureNarrowViewportScrollbarEdges(harness)
  assert.ok(narrowScrollbarEdges.afterHistoryRailHover, `expected narrow history rail hover geometry: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(narrowScrollbarEdges.afterHistoryWheel, `expected narrow history wheel geometry: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(narrowScrollbarEdges.afterDashboardWheel, `expected narrow dashboard wheel geometry: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyScrollbarRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow activation history scrollbar rail should reach the viewport right edge: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.scrollRegionRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow dashboard scroll region should place the native rail at the viewport right edge: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyTrackRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow activation history hover track should reach the viewport edge: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyScrollbarWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow activation history rail should use the shared scrollbar width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyTrackWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow activation history hover track should match the native rail width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbRight - narrowScrollbarEdges.initial.viewportWidth) <= 1,
    `narrow activation history thumb box should reach the viewport edge like the native rail: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbVisibleRight - (narrowScrollbarEdges.initial.viewportWidth - narrowScrollbarEdges.initial.scrollbarPadding)) <= 1,
    `narrow activation history visible thumb should keep the shared scrollbar padding at the viewport edge: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `narrow activation history thumb box should match the native rail width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.historyThumbVisibleWidth - narrowScrollbarEdges.initial.scrollbarThumbSize) <= 1,
    `narrow activation history visible thumb should use the shared visible thumb width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryRailHover.historyTrackWidth - narrowScrollbarEdges.initial.historyTrackWidth) <= 1,
    `hovering activation history should not change the interactive track width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryThumbHover.historyThumbVisibleWidth - narrowScrollbarEdges.initial.scrollbarThumbSizeHover) <= 1,
    `hovering the activation history thumb should widen it to the shared hover thumb size: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    narrowScrollbarEdges.afterHistoryThumbHover.historyThumbVisibleWidth > narrowScrollbarEdges.initial.historyThumbVisibleWidth + 1,
    `hovering the activation history thumb should make it visibly wider than at rest: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryThumbHover.historyThumbVisibleRight - (narrowScrollbarEdges.initial.viewportWidth - narrowScrollbarEdges.initial.scrollbarPaddingHover)) <= 1,
    `the widened activation history thumb should stay inset by the hover padding, not flush to the edge: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterHistoryThumbHover.historyTrackWidth - narrowScrollbarEdges.initial.scrollbarSize) <= 1,
    `widening the thumb on hover should not change the reserved gutter width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.duringHistoryThumbDrag.historyThumbVisibleWidth - narrowScrollbarEdges.initial.scrollbarThumbSizeHover) <= 1,
    `dragging the thumb with the pointer off the rail should keep it at hover width, not snap back: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.notEqual(narrowScrollbarEdges.initial.historyTrackCursor, 'grab', `activation history track should not use a grab cursor: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.notEqual(narrowScrollbarEdges.initial.historyThumbCursor, 'grab', `activation history thumb should not use a grab cursor: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.notEqual(narrowScrollbarEdges.afterHistoryRailHover.historyThumbCursor, 'grabbing', `activation history hover should not use a grabbing cursor: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.cardLeft - narrowScrollbarEdges.initial.pageGutter) <= 1,
    `moving the native rail outward should keep dashboard card content at the page gutter: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.filterLeft - narrowScrollbarEdges.initial.pageGutter) <= 1,
    `moving the native rail outward should keep header/filter content at the page gutter: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    narrowScrollbarEdges.initial.cardRight <= narrowScrollbarEdges.initial.viewportWidth - narrowScrollbarEdges.initial.pageGutter + 1,
    `dashboard card content should stay inside the existing right content gutter: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.headerControlsRight - narrowScrollbarEdges.initial.missionsRight) <= 1,
    `narrow header controls should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.sourceSwitchRight - narrowScrollbarEdges.initial.missionsRight) <= 1,
    `narrow source switch should align to the scrollable missions grid, not the native scrollbar gutter: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    narrowScrollbarEdges.initial.documentScrollWidth <= narrowScrollbarEdges.initial.documentClientWidth + 1,
    `narrow scrollbar rail should not introduce horizontal page overflow: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.equal(narrowScrollbarEdges.initial.windowScrollX, 0, `narrow viewport should not scroll the page horizontally: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.equal(narrowScrollbarEdges.initial.documentScrollLeft, 0, `narrow viewport should not move the document scroller horizontally: ${JSON.stringify(narrowScrollbarEdges)}`)
  assert.ok(
    narrowScrollbarEdges.initial.historyListScrollHeight > narrowScrollbarEdges.initial.historyListClientHeight + 8,
    `narrow activation history smoke needs an independently scrollable history list: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    narrowScrollbarEdges.initial.scrollRegionScrollHeight > narrowScrollbarEdges.initial.scrollRegionClientHeight + 8,
    `narrow dashboard smoke needs an independently scrollable card list: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    narrowScrollbarEdges.afterHistoryWheel.historyListScrollTop - narrowScrollbarEdges.initial.historyListScrollTop > 96,
    `wheel input over activation history should scroll history independently: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.equal(
    narrowScrollbarEdges.afterHistoryWheel.scrollRegionScrollTop,
    narrowScrollbarEdges.initial.scrollRegionScrollTop,
    `wheel input over activation history should not scroll the dashboard cards: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    narrowScrollbarEdges.afterDashboardWheel.scrollRegionScrollTop - narrowScrollbarEdges.afterHistoryWheel.scrollRegionScrollTop > 96,
    `wheel input over dashboard cards should scroll the dashboard independently: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.afterDashboardWheel.historyListScrollTop - narrowScrollbarEdges.afterHistoryWheel.historyListScrollTop) <= 1,
    `wheel input over dashboard cards should not scroll activation history: ${JSON.stringify(narrowScrollbarEdges)}`,
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
    `narrow dashboard scroll region must render the custom ::-webkit-scrollbar at the shared width, not a standard/overlay bar: ${JSON.stringify(narrowScrollbarEdges)}`,
  )
  assert.ok(
    Math.abs(narrowScrollbarEdges.initial.scrollRegionNativeTrackWidth - narrowScrollbarEdges.initial.historyScrollbarWidth) <= 1,
    `narrow dashboard native rail and activation history rail must occupy the same width: ${JSON.stringify(narrowScrollbarEdges)}`,
  )

  const shortTooltip = await measureShortChipTooltipAbsence(harness)
  assert.equal(shortTooltip.target.isTruncated, false, `short chip text should fit for tooltip absence smoke test: ${JSON.stringify(shortTooltip)}`)
  assert.equal(shortTooltip.tooltipCount, 0, `page chip should not show a tooltip when its text fits: ${JSON.stringify(shortTooltip)}`)

  const contextMenuSave = await measurePageChipContextMenuSave(harness)
  assert.ok(contextMenuSave.firstOpenState.itemTexts.includes('Reload'), `right-clicking a live page chip should show Reload: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.firstOpenState.itemTexts.includes('Duplicate'), `right-clicking a live page chip should show Duplicate: ${JSON.stringify(contextMenuSave)}`)
  assert.deepEqual(
    contextMenuSave.firstOpenState.sequence,
    [
      'Reload',
      'Duplicate',
      'separator',
      'Pin',
      'Save page',
      'Suspend',
      'separator',
      'Copy page title text',
      'Copy URL',
    ],
    `a live page chip context menu should group browser, page-management, and copy actions: ${JSON.stringify(contextMenuSave)}`,
  )
  assert.equal(contextMenuSave.firstOpenState.separatorInsets.length, 2, `a live page chip context menu should render two separators: ${JSON.stringify(contextMenuSave)}`)
  for (const inset of contextMenuSave.firstOpenState.separatorInsets) {
    assert.ok(Math.abs(inset.left - 8) <= 1, `context menu separators should be inset 8px from the left edge: ${JSON.stringify(contextMenuSave)}`)
    assert.ok(Math.abs(inset.right - 8) <= 1, `context menu separators should be inset 8px from the right edge: ${JSON.stringify(contextMenuSave)}`)
  }
  assert.equal(contextMenuSave.copyItem.text, 'Copy page title text', `right-clicking a live page chip should show the copy-title action: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyResult.copiedText, 'Short title', `Copy page title text should copy the chip title: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.copyResult.menuOpen, false, `context menu should close after choosing Copy page title text: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.saveItem.text, 'Save page', `right-clicking a live page chip should show the save action: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.saveResult.menuOpen, false, `context menu should close after choosing Save page: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.saveResult.pageKeys.includes('https://tab-out-smoke-01.com/docs/1'), `Save page should persist the chip URL: ${JSON.stringify(contextMenuSave)}`)
  assert.ok(contextMenuSave.saveResult.setCount > 0, `Save page should write through chrome.storage.local: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.activeBefore, 'All Tabs', `outside-click smoke should start on All Tabs: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.activeAfter, 'All Tabs', `clicking outside an open context menu should dismiss it without activating the underlying Dashboard View option: ${JSON.stringify(contextMenuSave)}`)
  assert.equal(contextMenuSave.outsideClickResult.menuOpen, false, `outside click should dismiss the context menu: ${JSON.stringify(contextMenuSave)}`)

  const expansion = await measureTooltipFreeze(harness)
  assert.ok(expansion.first, `page chip should expand in place on hover: ${JSON.stringify(expansion)}`)
  assert.ok(expansion.second, `page chip should stay expanded during an in-chip pointer move: ${JSON.stringify(expansion)}`)
  assert.ok((expansion.first.width || 0) > expansion.target.textRight - expansion.target.textLeft + 8, `page chip expansion should grow wider than the resting text: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs((expansion.first.textLeft || 0) - expansion.target.textLeftExact) <= 0.1, `page chip expanded text should keep the original chip text x-origin: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs((expansion.first.textTop || 0) - expansion.target.textTopExact) <= 0.1, `page chip expanded text should keep the original chip text y-origin: ${JSON.stringify(expansion)}`)
  assert.equal(expansion.first.visibleTooltipCount, 0, `page chip text expansion should not create a tooltip popup: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs(expansion.first.left - expansion.second.left) <= 1, `page chip expansion left should freeze after open: ${JSON.stringify(expansion)}`)
  assert.ok(Math.abs(expansion.first.top - expansion.second.top) <= 1, `page chip expansion top should freeze after open: ${JSON.stringify(expansion)}`)
  assert.equal(expansion.afterScrollExpandedCount, 0, `page chip expansion should close when the dashboard scrolls: ${JSON.stringify(expansion)}`)

  const tooltipHitArea = await measureTooltipTextPaddingHitArea(harness)
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

  const internalPointerMoveExpansion = await measurePageChipInternalPointerMoveExpansion(harness)
  assert.equal(internalPointerMoveExpansion.before, 0, `internal pointer-move smoke should start without an expanded chip: ${JSON.stringify(internalPointerMoveExpansion)}`)
  assert.ok(
    internalPointerMoveExpansion.expansion?.text.includes('enough tooltip text'),
    `page chip should expand when pointer movement starts inside the chip surface: ${JSON.stringify(internalPointerMoveExpansion)}`,
  )
  assert.equal(
    internalPointerMoveExpansion.expansion?.visibleTooltipCount,
    0,
    `internal pointer-move expansion should not create a tooltip popup: ${JSON.stringify(internalPointerMoveExpansion)}`,
  )

  const activeStateTooltip = await measureTooltipAfterActiveStateChanges(harness)
  assert.equal(activeStateTooltip.activeTarget.activeFrame, true, `active-state smoke target should start with an active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.equal(activeStateTooltip.inactiveTarget.activeFrame, false, `active-state smoke target should lose the active chip frame: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.activeTooltip, `page chip should expand after the chip becomes active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(activeStateTooltip.inactiveTooltip, `page chip should expand after the chip stops being active: ${JSON.stringify(activeStateTooltip)}`)
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textLeft || 0) - activeStateTooltip.activeTarget.textLeftExact) <= 0.1,
    `expanded chip x-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`,
  )
  assert.ok(
    Math.abs((activeStateTooltip.activeTooltip.textTop || 0) - activeStateTooltip.activeTarget.textTopExact) <= 0.1,
    `expanded chip y-origin should stay precise after active state is applied: ${JSON.stringify(activeStateTooltip)}`,
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textLeft || 0) - activeStateTooltip.inactiveTarget.textLeftExact) <= 0.1,
    `expanded chip x-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`,
  )
  assert.ok(
    Math.abs((activeStateTooltip.inactiveTooltip.textTop || 0) - activeStateTooltip.inactiveTarget.textTopExact) <= 0.1,
    `expanded chip y-origin should stay precise after active state is removed: ${JSON.stringify(activeStateTooltip)}`,
  )

  const suppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    suppressionMarkerLines.push(await measureSuppressionMarkerTooltipLine(harness, markerLabel))
  }
  const suppressionMarkerLineNumbers = suppressionMarkerLines.map(({ result }) => result?.markerLine)
  assert.deepEqual(
    suppressionMarkerLineNumbers,
    [1, 2, 3],
    `suppression marker expansion should keep marker labels on the same visible chip lines: ${JSON.stringify(suppressionMarkerLines)}`,
  )
  for (const line of suppressionMarkerLines) {
    assert.ok(line.result, `suppression marker expansion should expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.text.includes('Shared Workspace'), `suppression marker expansion should show the hidden title text in place: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 16, `suppression marker should not make wrapped expanded chip lines taller: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `suppression marker should sit centered in its expanded chip line: ${JSON.stringify(line)}`)
  }
  const compactSuppressionMarkerLines = []
  for (const markerLabel of ['Marker line one', 'Marker line two', 'Marker line three']) {
    compactSuppressionMarkerLines.push(await measureSuppressionMarkerChipLine(harness, markerLabel))
  }
  for (const line of compactSuppressionMarkerLines) {
    assert.ok(line.result, `compact suppression marker should expose marker geometry: ${JSON.stringify(line)}`)
    assert.ok(line.result.markerHeight <= 14, `compact suppression marker should stay smaller than the rendered chip line: ${JSON.stringify(line)}`)
    assert.ok(line.result.glyphHeight <= 7, `compact suppression marker glyph should stay small inside its badge: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.glyphCenterDelta) <= 0.75, `compact suppression marker glyph should sit centered inside its badge: ${JSON.stringify(line)}`)
    assert.ok(Math.abs(line.result.markerCenterDelta) <= 0.75, `compact suppression marker should sit centered in its chip line: ${JSON.stringify(line)}`)
  }

  const tooltipLineCounts = [
    await measurePageChipTooltipLineCount(harness, 'Marker line one'),
    await measurePageChipTooltipLineCount(harness, 'Marker line two'),
    await measurePageChipTooltipLineCount(harness, 'Marker line three', {
      forcedTextWidth: 168,
      forcedMaxLines: 3,
    }),
  ]
  assert.deepEqual(
    tooltipLineCounts.map(({ target }) => target.chipLineCount),
    [1, 2, 3],
    `line-count smoke should cover one-, two-, and three-line chips: ${JSON.stringify(tooltipLineCounts)}`,
  )
  for (const lineCount of tooltipLineCounts) {
    assert.ok(lineCount.tooltip, `page chip should expand for line-count check: ${JSON.stringify(lineCount)}`)
    assert.equal(
      lineCount.tooltip.visibleTooltipCount,
      0,
      `page chip line-count expansion should not create a tooltip popup: ${JSON.stringify(lineCount)}`,
    )
    const isViewportConstrained = lineCount.tooltip.right >= lineCount.tooltip.viewportRight - 12
    if (isViewportConstrained) {
      assert.ok(
        lineCount.tooltip.tooltipLineCount >= lineCount.target.chipLineCount,
        `regular page chip expansion may add rows only when constrained by the browser viewport edge: ${JSON.stringify(lineCount)}`,
      )
    } else {
      assert.equal(
        lineCount.tooltip.tooltipLineCount,
        lineCount.target.chipLineCount,
        `regular page chip expansion should match the visible chip line count when viewport width allows it: ${JSON.stringify(lineCount)}`,
      )
    }
    assert.ok(
      lineCount.tooltip.right <= lineCount.tooltip.viewportRight + 1,
      `regular page chip expansion should stay within the browser viewport: ${JSON.stringify(lineCount)}`,
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textLeft - lineCount.target.chipLeftExact) <= 0.1,
      `regular page chip expansion text should keep the visible chip x-origin: ${JSON.stringify(lineCount)}`,
    )
    assert.ok(
      Math.abs(lineCount.tooltip.textTop - lineCount.target.chipTopExact) <= 0.1,
      `regular page chip expansion text should keep the visible chip y-origin: ${JSON.stringify(lineCount)}`,
    )
    const normalizeLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
    const chipLines = lineCount.target.chipLineTexts.map(normalizeLineText).filter(Boolean)
    const tooltipLines = lineCount.tooltip.tooltipLineTexts.map(normalizeLineText).filter(Boolean)
    assert.ok(
      tooltipLines.length >= chipLines.length,
      `regular page chip expansion should keep at least the visible chip line rows: ${JSON.stringify(lineCount)}`,
    )
    for (let index = 0; index < chipLines.length - 1; index += 1) {
      assert.equal(
        tooltipLines[index],
        chipLines[index],
        `regular page chip expansion should preserve visible line breaks before the tail row: ${JSON.stringify(lineCount)}`,
      )
    }
    const lastChipLine = chipLines.at(-1)
    const lastTooltipLine = tooltipLines[chipLines.length - 1]
    assert.ok(
      lastChipLine !== undefined && lastTooltipLine?.startsWith(lastChipLine),
      `regular page chip expansion tail row should start with the same visible text before revealing more: ${JSON.stringify(lineCount)}`,
    )
  }
  const structuralTailTooltip = await measurePageChipTooltipLineCount(harness, 'Tooltip Boundary Alpha', {
    forcedTextWidth: 170,
    forcedMaxLines: 2,
  })
  assert.ok(structuralTailTooltip.tooltip, `structural-tail tooltip should open: ${JSON.stringify(structuralTailTooltip)}`)
  assert.equal(
    structuralTailTooltip.tooltip.tooltipLineCount,
    structuralTailTooltip.target.chipLineCount,
    `structural-tail tooltip should keep the visible chip line count: ${JSON.stringify(structuralTailTooltip)}`,
  )
  assert.ok(
    structuralTailTooltip.tooltip.text.includes('Example Website') && structuralTailTooltip.tooltip.text.includes('Contentful'),
    `structural-tail tooltip should expand compact suppression markers into text: ${JSON.stringify(structuralTailTooltip)}`,
  )
  assert.ok(
    structuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('Example Website'),
    `structural-tail tooltip should widen enough for expanded non-tail suppression text instead of clipping it: ${JSON.stringify(structuralTailTooltip)}`,
  )
  assert.ok(
    !structuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('env-alpha') &&
    structuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('env-alpha') &&
    structuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `structural-tail tooltip should split before the structural marker without duplicating it: ${JSON.stringify(structuralTailTooltip)}`,
  )
  assert.ok(
    structuralTailTooltip.tooltip.width > structuralTailTooltip.target.chipWidth + 20,
    `structural-tail tooltip should grow wider than the compact chip when non-tail markers expand: ${JSON.stringify(structuralTailTooltip)}`,
  )
  const oneLineStructuralTailTooltip = await measurePageChipTooltipLineCount(harness, 'Tooltip Boundary Alpha', {
    forcedTextWidth: 130,
    forcedMaxLines: 1,
    viewportWidth: 1600,
  })
  assert.ok(oneLineStructuralTailTooltip.tooltip, `one-line structural-tail tooltip should open: ${JSON.stringify(oneLineStructuralTailTooltip)}`)
  assert.equal(
    oneLineStructuralTailTooltip.target.chipLineCount,
    1,
    `one-line structural-tail smoke target should render as one visible chip line: ${JSON.stringify(oneLineStructuralTailTooltip)}`,
  )
  assert.equal(
    oneLineStructuralTailTooltip.tooltip.tooltipLineCount,
    1,
    `one-line structural-tail tooltip should widen enough to stay on one line: ${JSON.stringify(oneLineStructuralTailTooltip)}`,
  )
  const wrappedContentfulScreenshotTooltip = await measurePageChipTooltipLineCount(harness, 'Tooltip Screenshot Alpha', {
    forcedTextWidth: 280,
    forcedMaxLines: 2,
    viewportWidth: 1600,
  })
  assert.ok(wrappedContentfulScreenshotTooltip.tooltip, `wrapped Contentful tooltip should open: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`)
  assert.equal(
    wrappedContentfulScreenshotTooltip.target.chipLineCount,
    2,
    `wrapped Contentful smoke target should render as two visible chip lines so line 2 carries only the trailing marker: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`,
  )
  assert.equal(
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineCount,
    2,
    `wrapped Contentful tooltip should split the expanded title into two rows even when chip line 2 has no text node: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`,
  )
  assert.ok(
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[0]?.includes('dev2') &&
    !wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[1]?.includes('dev2') &&
    wrappedContentfulScreenshotTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `wrapped Contentful tooltip should keep dev2 on row 1 and Contentful on row 2: ${JSON.stringify(wrappedContentfulScreenshotTooltip)}`,
  )
  const wrappedTrailingMarkerTooltip = await measurePageChipTooltipLineCount(harness, 'Wrap Trailing Marker Alpha', {
    forcedTextWidth: 230,
    forcedMaxLines: 2,
    viewportWidth: 1600,
  })
  assert.ok(wrappedTrailingMarkerTooltip.tooltip, `wrapped trailing-marker tooltip should open: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`)
  assert.equal(
    wrappedTrailingMarkerTooltip.target.chipLineCount,
    2,
    `wrapped trailing-marker chip should render as two visible lines so line 2 carries only the trailing suppression marker: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`,
  )
  assert.equal(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineCount,
    2,
    `wrapped trailing-marker tooltip should split when the chip wraps with only a trailing suppression marker on line 2: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`,
  )
  assert.ok(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[0]?.includes('Wrap Trailing Marker Alpha') &&
    !wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[0]?.includes('JIRA') &&
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineTexts[1]?.includes('JIRA'),
    `wrapped trailing-marker tooltip should keep the title on row 1 and drop the JIRA marker onto row 2: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`,
  )
  assert.ok(
    wrappedTrailingMarkerTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `wrapped trailing-marker tooltip lines should not visually overflow: ${JSON.stringify(wrappedTrailingMarkerTooltip)}`,
  )
  const splitStructuralTailTooltip = await measurePageChipTooltipLineCount(harness, 'Tooltip Line Alpha', {
    forcedTextWidth: 310,
    forcedMaxLines: 2,
  })
  assert.ok(splitStructuralTailTooltip.tooltip, `split structural-tail tooltip should open: ${JSON.stringify(splitStructuralTailTooltip)}`)
  assert.equal(
    splitStructuralTailTooltip.tooltip.tooltipLineCount,
    splitStructuralTailTooltip.target.chipLineCount,
    `split structural-tail tooltip should keep the visible chip line count: ${JSON.stringify(splitStructuralTailTooltip)}`,
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.text.includes('Shared Website') && splitStructuralTailTooltip.tooltip.text.includes('Contentful'),
    `split structural-tail tooltip should expand hidden website and source markers: ${JSON.stringify(splitStructuralTailTooltip)}`,
  )
  assert.ok(
    !splitStructuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('Shared Website') &&
    splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Shared Website'),
    `split structural-tail tooltip should keep the expanded website marker on the wrapped marker line: ${JSON.stringify(splitStructuralTailTooltip)}`,
  )
  assert.ok(
    !splitStructuralTailTooltip.tooltip.tooltipLineTexts[0]?.includes('env-beta'),
    `split structural-tail tooltip should not duplicate the structural marker into the first row: ${JSON.stringify(splitStructuralTailTooltip)}`,
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('env-beta') && splitStructuralTailTooltip.tooltip.tooltipLineTexts[1]?.includes('Contentful'),
    `split structural-tail tooltip should keep the structural label and trailing marker on the second visible line: ${JSON.stringify(splitStructuralTailTooltip)}`,
  )
  assert.ok(
    splitStructuralTailTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `split structural-tail tooltip lines should not visually overflow: ${JSON.stringify(splitStructuralTailTooltip)}`,
  )
  const edgeConstrainedTooltip = await measurePageChipTooltipLineCount(harness, 'Tooltip Edge Alpha', {
    forcedTextWidth: 310,
    forcedMaxLines: 2,
  })
  assert.ok(edgeConstrainedTooltip.tooltip, `edge-constrained tooltip should open: ${JSON.stringify(edgeConstrainedTooltip)}`)
  assert.ok(
    edgeConstrainedTooltip.tooltip.right <= edgeConstrainedTooltip.tooltip.viewportRight - 12,
    `wrapped marker expansion should not grow to the browser viewport edge when the marker label fits on its wrapped line: ${JSON.stringify(edgeConstrainedTooltip)}`,
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.tooltipLineCount >= edgeConstrainedTooltip.target.chipLineCount,
    `edge-constrained tooltip may add rows after it reaches the browser viewport edge: ${JSON.stringify(edgeConstrainedTooltip)}`,
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.text.includes('Shared Website With Long Workspace Label For Tooltip Boundary') && edgeConstrainedTooltip.tooltip.text.includes('Contentful'),
    `edge-constrained tooltip should still expose the expanded hidden markers: ${JSON.stringify(edgeConstrainedTooltip)}`,
  )
  assert.ok(
    edgeConstrainedTooltip.tooltip.tooltipLineOverflows.every((overflows: boolean) => !overflows),
    `edge-constrained tooltip lines should wrap instead of overflowing: ${JSON.stringify(edgeConstrainedTooltip)}`,
  )
  const foldedTooltip = await measureFoldedPageChipTooltipTitleLineCount(harness, 'Folded Tooltip Lenses', {
    forcedTextWidth: 270,
  })
  assert.ok(foldedTooltip.tooltip, `folded chip should expand in place: ${JSON.stringify(foldedTooltip)}`)
  assert.equal(
    foldedTooltip.tooltip.visibleTooltipCount,
    0,
    `folded chip expansion should not create a tooltip popup: ${JSON.stringify(foldedTooltip)}`,
  )
  assert.equal(
    foldedTooltip.target.titleLineCount,
    1,
    `folded chip visible title row should fit on one line for this smoke: ${JSON.stringify(foldedTooltip)}`,
  )
  assert.equal(
    foldedTooltip.tooltip.titleLineCount,
    foldedTooltip.target.titleLineCount,
    `folded chip expansion title row should match the visible title row line count: ${JSON.stringify(foldedTooltip)}`,
  )
  assert.ok(
    foldedTooltip.tooltip.titleText.includes('Example Optical'),
    `folded chip expansion should expand the hidden title marker inline: ${JSON.stringify(foldedTooltip)}`,
  )
  assert.ok(
    foldedTooltip.tooltip.envCount > 0,
    `folded chip expansion should keep the existing env buttons in the chip: ${JSON.stringify(foldedTooltip)}`,
  )
  assert.ok(
    foldedTooltip.tooltip.textWidth > foldedTooltip.target.chipTextWidth,
    `folded chip expansion should grow wider than the compact folded chip when hidden title text expands: ${JSON.stringify(foldedTooltip)}`,
  )
  const foldedWrappedTooltip = await measureFoldedPageChipTooltipTitleLineCount(harness, 'Folded Tooltip Lenses', {
    forcedTextWidth: 160,
  })
  assert.ok(foldedWrappedTooltip.tooltip, `wrapped folded chip should expand in place: ${JSON.stringify(foldedWrappedTooltip)}`)
  assert.equal(
    foldedWrappedTooltip.tooltip.visibleTooltipCount,
    0,
    `wrapped folded chip expansion should not create a tooltip popup: ${JSON.stringify(foldedWrappedTooltip)}`,
  )
  assert.ok(
    foldedWrappedTooltip.target.titleLineCount > 1,
    `wrapped folded chip visible title row should span multiple lines for this smoke: ${JSON.stringify(foldedWrappedTooltip)}`,
  )
  assert.equal(
    foldedWrappedTooltip.tooltip.titleLineCount,
    foldedWrappedTooltip.target.titleLineCount,
    `wrapped folded chip expansion title row should keep the visible title line breaks: ${JSON.stringify(foldedWrappedTooltip)}`,
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.titleText.includes('Example Optical'),
    `wrapped folded chip expansion should still expand the hidden title marker: ${JSON.stringify(foldedWrappedTooltip)}`,
  )
  assert.ok(
    foldedWrappedTooltip.tooltip.envCount > 0,
    `wrapped folded chip expansion should keep the existing env buttons in the chip: ${JSON.stringify(foldedWrappedTooltip)}`,
  )
  const foldedEnvHover = await measureFoldedEnvHoverTooltips(harness, 'Folded Tooltip Lenses')
  assert.deepEqual(
    foldedEnvHover.tooltipTexts,
    [],
    `hovering a folded env button should not open a tooltip: ${JSON.stringify(foldedEnvHover)}`,
  )

  const originalSlotLeave = await measurePageChipOriginalSlotLeave(harness)
  assert.equal(
    originalSlotLeave.first.visibleTooltipCount,
    0,
    `page chip expansion should not create a tooltip popup: ${JSON.stringify(originalSlotLeave)}`,
  )
  assert.ok(
    originalSlotLeave.afterOriginalSlotLeave,
    `page chip should STAY expanded while the pointer is inside the grown bounds past the original slot, so the cursor can travel onto the revealed content instead of blinking shut at the seam: ${JSON.stringify(originalSlotLeave)}`,
  )
  assert.ok(
    !originalSlotLeave.afterLeaveTooltips.some((text: string) => text === originalSlotLeave.first.text),
    `page chip expansion should collapse once the pointer leaves the expanded chip entirely: ${JSON.stringify(originalSlotLeave)}`,
  )

  const popupClickFocus = await measureTooltipPopupClickFocus(harness)
  assert.equal(popupClickFocus.popupStyle?.cursor, 'default', `expanded page chip should keep the default cursor: ${JSON.stringify(popupClickFocus)}`)
  assert.equal(popupClickFocus.first.visibleTooltipCount, 0, `clickable expanded page chip should not create a tooltip popup: ${JSON.stringify(popupClickFocus)}`)
  assert.ok(
    focusUpdateTargets(popupClickFocus.updates, 'tab', 'active'),
    `clicking the expanded page chip should focus the matching tab: ${JSON.stringify(popupClickFocus)}`,
  )
  assert.ok(
    focusUpdateTargets(popupClickFocus.updates, 'window', 'focused'),
    `clicking the expanded page chip should focus the matching window: ${JSON.stringify(popupClickFocus)}`,
  )
  const historyPopupClickFocus = await measureHistoryEntryExpansionClickFocus(harness)
  assert.equal(historyPopupClickFocus.expandedStyle?.cursor, 'default', `expanded history entry should keep the default cursor: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.equal(historyPopupClickFocus.expandedStyle?.pointerEvents, 'none', `expanded history entry should let native pointer and wheel input reach the original row underneath: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.equal(historyPopupClickFocus.first.visibleTooltipCount, 0, `expanded history entry should not create a tooltip popup: ${JSON.stringify(historyPopupClickFocus)}`)
  assert.ok(
    focusUpdateTargets(historyPopupClickFocus.updates, 'tab', 'active'),
    `clicking the expanded history entry should focus the matching tab: ${JSON.stringify(historyPopupClickFocus)}`,
  )
  assert.ok(
    focusUpdateTargets(historyPopupClickFocus.updates, 'window', 'focused'),
    `clicking the expanded history entry should focus the matching window: ${JSON.stringify(historyPopupClickFocus)}`,
  )

  const popupWheelScroll = await measureTooltipPopupWheelScroll(harness)
  assert.ok(popupWheelScroll.first, `page chip should expand before wheel check: ${JSON.stringify(popupWheelScroll)}`)
  assert.equal(popupWheelScroll.first.visibleTooltipCount, 0, `expanded page chip wheel target should not create a tooltip popup: ${JSON.stringify(popupWheelScroll)}`)
  assert.ok(
    popupWheelScroll.after.scrollTop - popupWheelScroll.beforeScrollTop > 72,
    `repeated wheel input over an expanded page chip should keep scrolling the dashboard: ${JSON.stringify(popupWheelScroll)}`,
  )
  // Scroll no longer dismisses the expansion on its own; this wheel input scrolls
  // far enough (144px) that the ~43px chip slot moves out from under the resting
  // pointer, so the pointer-left-the-area close fires. Either way it ends closed.
  assert.equal(
    popupWheelScroll.after.expandedCount,
    0,
    `page chip expansion should close once the chip slot scrolls out from under the pointer: ${JSON.stringify(popupWheelScroll)}`,
  )
  assert.equal(
    popupWheelScroll.afterLeaveExpandedCount,
    0,
    `page chip expansion should stay closed after the pointer leaves the chip's slot area: ${JSON.stringify(popupWheelScroll)}`,
  )

  const historyPopupWheelScroll = await measureHistoryEntryExpansionWheelScroll(harness)
  assertHistoryScrollbarLayering(historyPopupWheelScroll)
  assert.ok(
    Math.abs(historyPopupWheelScroll.first.titleLeft - historyPopupWheelScroll.target.titleLeftExact) <= 0.1,
    `expanded history entry should keep the title text x-origin: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    Math.abs(historyPopupWheelScroll.first.titleTop - historyPopupWheelScroll.target.titleTopExact) <= 0.1,
    `expanded history entry should keep the title text y-origin: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    historyPopupWheelScroll.scrollbarGeometry,
    `history panel should render a local scrollbar mirror: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    Math.abs(historyPopupWheelScroll.scrollbarGeometry.scrollbarRight - historyPopupWheelScroll.scrollbarGeometry.panelRight) <= 1,
    `history scrollbar mirror should sit on the history panel edge: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    historyPopupWheelScroll.scrollbarGeometry.listRight - historyPopupWheelScroll.scrollbarGeometry.scrollbarRight > 400,
    `history scrollbox should stay wide for expansion while the visible scrollbar stays local: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.scrollbarGeometry.nativeScrollbarWidth,
    'none',
    `native history scrollbar should be hidden behind the local mirror: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(historyPopupWheelScroll.first.visibleTooltipCount, 0, `history expansion should not create a tooltip popup: ${JSON.stringify(historyPopupWheelScroll)}`)
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedOpen,
    true,
    `history entry should keep an explicit expanded-open class while expanded: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.rowExpandedOpen,
    true,
    `dimmed history row should carry expanded-open state on the opacity owner while expanded: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    Number(historyPopupWheelScroll.tooltipOpenEntryState.expandedZIndex) > Number(historyPopupWheelScroll.tooltipOpenEntryState.scrollbarZIndex),
    `expanded history entry should paint above the local scrollbar mirror: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.rowOpacity,
    '1',
    `dimmed history row should use full opacity while hovered and expanded: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.match(
    historyPopupWheelScroll.tooltipOpenEntryState.backgroundColor,
    /^(rgb|color)\(/,
    `expanded history entry should use an opaque background: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.doesNotMatch(
    historyPopupWheelScroll.tooltipOpenEntryState.backgroundColor,
    /rgba\([^)]*, 0\.\d+\)/,
    `expanded history entry background should not let content underneath show through: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    historyPopupWheelScroll.expandedOnlyHitTarget.visualText.includes('Low score history item'),
    `expanded history entry should remain visually rendered outside the original history pane: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.expandedOnlyHitTarget.hitInsideExpanded,
    false,
    `expanded history entry should stay pointer-transparent so wheel input reaches the scroll list: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.expandedOnlyClipCheck.hitInsideExpanded,
    true,
    `expanded history entry should remain visibly hit-testable outside the clipped history list when pointer events are enabled for measurement: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.afterOriginalSlotLeave,
    null,
    `history entry should collapse when the pointer leaves the original entry slot, even inside the grown bounds: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.notEqual(
    historyPopupWheelScroll.target.titleWebkitLineClamp,
    '2',
    `history entry title should use the PageChip fade mask instead of CSS line-clamp ellipsis: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    historyPopupWheelScroll.target.titleMaskImage && historyPopupWheelScroll.target.titleMaskImage !== 'none',
    `truncated history entry title should use a fade mask: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    historyPopupWheelScroll.target.titleHeight > historyPopupWheelScroll.target.titleLineHeight * 1.5,
    `long history entry title should render as two visible lines: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  const historyFaviconHitArea = await measureHistoryEntryExpansionSurfaceHitArea(harness)
  assert.ok(historyFaviconHitArea.above?.text.includes('Low score history item'), `hovering the vertical space above the history favicon should expand the entry: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.ok(historyFaviconHitArea.below?.text.includes('Low score history item'), `hovering the vertical space below the history favicon should expand the entry: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.deepEqual(historyFaviconHitArea.aboveTooltipTexts, [], `history entry expansion from favicon padding should not create a tooltip popup: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.deepEqual(historyFaviconHitArea.belowTooltipTexts, [], `history entry expansion from favicon padding should not create a tooltip popup: ${JSON.stringify(historyFaviconHitArea)}`)
  assert.notEqual(
    historyPopupWheelScroll.first.webkitLineClamp,
    '2',
    `expanded history entry should not reuse the clipped row's CSS line clamp: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  const historyExpansionViewportConstrained = historyPopupWheelScroll.first.right >= historyPopupWheelScroll.first.viewportRight - 12
  if (historyExpansionViewportConstrained) {
    assert.ok(
      historyPopupWheelScroll.first.expandedLineCount >= historyPopupWheelScroll.target.titleLineCount,
      `history expansion may add rows only when constrained by the browser viewport edge: ${JSON.stringify(historyPopupWheelScroll)}`,
    )
  } else {
    assert.equal(
      historyPopupWheelScroll.first.expandedLineCount,
      historyPopupWheelScroll.target.titleLineCount,
      `history expansion should match the visible history title line count when viewport width allows it: ${JSON.stringify(historyPopupWheelScroll)}`,
    )
  }
  const normalizeHistoryLineText = (value: string) => value.replace(/\s+/g, ' ').trim()
  const historyTitleLines = historyPopupWheelScroll.target.titleLineTexts.map(normalizeHistoryLineText).filter(Boolean)
  const historyTooltipLines = historyPopupWheelScroll.first.expandedLineTexts.map(normalizeHistoryLineText).filter(Boolean)
  assert.ok(
    historyTooltipLines.length >= historyTitleLines.length,
    `history expansion should keep at least the visible title line rows: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  for (let index = 0; index < historyTitleLines.length - 1; index += 1) {
    assert.equal(
      historyTooltipLines[index],
      historyTitleLines[index],
      `history expansion should preserve visible line breaks before the tail row: ${JSON.stringify(historyPopupWheelScroll)}`,
    )
  }
  const historyTailLine = historyTitleLines[historyTitleLines.length - 1]
  assert.ok(
    historyTailLine !== undefined && historyTooltipLines[historyTitleLines.length - 1]?.startsWith(historyTailLine),
    `history expansion tail row should start with the same visible text before revealing more: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    (historyPopupWheelScroll.first.titleWidth || 0) > historyPopupWheelScroll.target.titleWidthExact + 8,
    `history expansion title should expand beyond the clipped visible title width: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  if (!historyExpansionViewportConstrained) {
    assert.ok(
      Math.abs((historyPopupWheelScroll.first.titleHeight || 0) - historyPopupWheelScroll.target.titleHeight) <= 1,
      `history expansion should keep the same two-line flow as the visible title when it can expand: ${JSON.stringify(historyPopupWheelScroll)}`,
    )
  }
  assert.ok(
    historyPopupWheelScroll.target.listScrollHeight > historyPopupWheelScroll.target.listClientHeight,
    `history panel should be scrollable for popup-wheel check: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideHistoryList,
    true,
    `expanded history entry should stay in the native scroll-list ancestry: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsidePanel,
    true,
    `expanded history entry should remain parented to the history panel instead of a portal layer: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideDashboardShell,
    true,
    `expanded history entry should still stay within the dashboard shell: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.tooltipOpenEntryState.expandedInsideOverlay,
    false,
    `expanded history entry should not rely on a sibling overlay for wheel scrolling: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.ok(
    historyPopupWheelScroll.wheelDeltaY > 0
      ? historyPopupWheelScroll.after.historyScrollTop > historyPopupWheelScroll.beforeScrollTop.historyScrollTop
      : historyPopupWheelScroll.after.historyScrollTop < historyPopupWheelScroll.beforeScrollTop.historyScrollTop,
    `repeated wheel input over an expanded history entry should keep scrolling the history panel: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.after.dashboardScrollTop,
    historyPopupWheelScroll.beforeScrollTop.dashboardScrollTop,
    `wheel input over an expanded history entry should not scroll the dashboard pane first: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  // Scroll no longer dismisses the expansion on its own; this wheel input scrolls
  // the list ~72px, more than the ~43px entry slot, so the entry moves out from
  // under the resting pointer and the pointer-left-the-area close fires.
  assert.equal(
    historyPopupWheelScroll.after.expansionCount,
    0,
    `history expansion should close once the entry slot scrolls out from under the pointer: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.after.tooltipCount,
    0,
    `history expansion should not leave a tooltip popup after wheel input: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveExpansionState.expansionCount,
    0,
    `history expansion should stay closed after the pointer leaves the wheel-scrolled entry: ${JSON.stringify(historyPopupWheelScroll)}`,
  )
  assert.equal(
    historyPopupWheelScroll.afterLeaveExpansionState.tooltipCount,
    0,
    `history expansion should not leave a tooltip popup after pointer leave: ${JSON.stringify(historyPopupWheelScroll)}`,
  )

  const windowBlurTooltip = await measureTooltipWindowBlurClose(harness)
  assert.ok(windowBlurTooltip.first, `page chip should expand before window-blur check: ${JSON.stringify(windowBlurTooltip)}`)
  assert.deepEqual(windowBlurTooltip.afterBlurTooltips, [], `page chip expansion should close when the window loses focus: ${JSON.stringify(windowBlurTooltip)}`)

  const visibilityTooltip = await measureTooltipVisibilityChangeClose(harness)
  assert.ok(visibilityTooltip.first, `page chip should expand before visibility-change check: ${JSON.stringify(visibilityTooltip)}`)
  assert.deepEqual(
    visibilityTooltip.afterVisibilityChangeTooltips,
    [],
    `page chip expansion should close synchronously when the page becomes hidden: ${JSON.stringify(visibilityTooltip)}`,
  )

  const actionTooltip = await measureActionTooltipClickClose(harness)
  assert.ok(actionTooltip.first, `pin tooltip should open before click-close check: ${JSON.stringify(actionTooltip)}`)
  assert.equal(actionTooltip.focusedAfterLeave, true, `pin button should keep focus after click so this smoke covers pointer-focus behavior: ${JSON.stringify(actionTooltip)}`)
  assert.deepEqual(actionTooltip.afterLeaveTooltips, [], `pin tooltip should close after click when the pointer leaves the focused button: ${JSON.stringify(actionTooltip)}`)

  const pageChipReturnTooltip = await measureInteractiveTooltipClickReturnFocus(
    harness,
    '.page-chip .chip-text',
    PAGE_CHIP_EXPANSION_SMOKE_LABEL,
    'page-chip',
    '.chip-text',
  )
  assert.ok(pageChipReturnTooltip.first.found, `page chip should expand before click-return check: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.active, true, `page chip should be refocused during click-return smoke test: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.equal(pageChipReturnTooltip.afterReturnFocus?.focusVisible, false, `page chip click-return focus should not be keyboard-visible focus: ${JSON.stringify(pageChipReturnTooltip)}`)
  assert.deepEqual(pageChipReturnTooltip.afterReturnTooltips, [], `page chip expansion should not leave a tooltip popup after pointer-click return focus: ${JSON.stringify(pageChipReturnTooltip)}`)

  const markerHandoff = await measureMarkerToChipTooltipHandoff(harness)
  assert.ok(markerHandoff.target.markerText.startsWith('/'), `strip indicator should render compact path marker text in the chip: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.markerTooltip.found, `strip indicator hover should expand the page chip first: ${JSON.stringify(markerHandoff)}`)
  assert.ok(
    markerHandoff.markerTooltip.expansion?.text.includes('dev2') &&
    markerHandoff.markerTooltip.expansion?.text.includes('Hover Handoff Title'),
    `strip indicator should use chip-level in-place expansion instead of a marker-only tooltip: ${JSON.stringify(markerHandoff)}`,
  )
  assert.deepEqual(markerHandoff.markerTooltip.tooltips, [], `strip indicator hover should not create a tooltip popup: ${JSON.stringify(markerHandoff)}`)
  assert.ok(markerHandoff.chipTooltip.found, `page chip should remain expanded after moving from the strip indicator to chip text: ${JSON.stringify(markerHandoff)}`)

  const edgeTooltip = await measureTooltipEdgeFlip(harness)
  assert.ok(edgeTooltip.first, `page chip should expand near the viewport edge: ${JSON.stringify(edgeTooltip)}`)
  assert.equal(edgeTooltip.first.visibleTooltipCount, 0, `viewport-edge page chip expansion should not create a tooltip popup: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(edgeTooltip.first.right <= edgeTooltip.target.viewportRight - 12, `expanded page chip should keep viewport collision padding near the text edge: ${JSON.stringify(edgeTooltip)}`)
  assert.ok(Math.abs(edgeTooltip.first.textLeft - edgeTooltip.target.textLeft) <= 1, `expanded page chip should preserve the original text origin near the viewport edge: ${JSON.stringify(edgeTooltip)}`)

  const compactTitleVariantExpansion = await measureCompactTitleVariantExpansion(harness)
  assert.ok(compactTitleVariantExpansion.expansion, `compact same-title variant chip should expand in place: ${JSON.stringify(compactTitleVariantExpansion)}`)
  assert.ok(
    compactTitleVariantExpansion.expansion.width <= Math.max(
      compactTitleVariantExpansion.target.chipWidth,
      compactTitleVariantExpansion.target.contentWidth + 72,
    ) + 1,
    `compact same-title variant chip should not grow beyond its resting width/content budget when the content is short: ${JSON.stringify(compactTitleVariantExpansion)}`,
  )
  assert.ok(
    compactTitleVariantExpansion.expansion.width >= compactTitleVariantExpansion.target.chipWidth - 1,
    `compact same-title variant chip expansion should not shrink below its resting chip width: ${JSON.stringify(compactTitleVariantExpansion)}`,
  )
  assert.ok(
    compactTitleVariantExpansion.expandedVariantLabels.every((label: { clientWidth: number, scrollWidth: number }) => label.scrollWidth - label.clientWidth <= 1),
    `compact same-title variant chip expansion should keep its URL variant labels untruncated when viewport room allows: ${JSON.stringify(compactTitleVariantExpansion)}`,
  )
  const plainTitleVariantEdgeExpansion = await measurePlainTitleVariantEdgeExpansion(harness)
  assert.ok(
    plainTitleVariantEdgeExpansion.target.surfaces.slotOnlyDefaultSurface,
    `plain same-title variant smoke should find a slot-only default surface outside the rounded chip: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`,
  )
  assert.ok(
    plainTitleVariantEdgeExpansion.target.overflowingLabels > 0,
    `plain same-title variant smoke should start with a clipped URL distinguisher: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`,
  )
  const slotOnlyTitleVariantSurface = plainTitleVariantEdgeExpansion.surfaceResults.find((surface: { surface: string }) => surface.surface === 'slotOnlyDefaultSurface')
  assert.ok(
    slotOnlyTitleVariantSurface?.preHoverState?.hitInsideSlot && !slotOnlyTitleVariantSurface?.preHoverState?.hitInsideChip,
    `plain same-title variant slot-only surface should hover the slot without entering the rounded chip: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`,
  )
  assert.ok(
    plainTitleVariantEdgeExpansion.surfaceResults.every((surface: { expansion: unknown }) => surface.expansion),
    `plain same-title variant chip should expand from every highlighted hover surface: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`,
  )
  assert.ok(
    plainTitleVariantEdgeExpansion.surfaceResults.every((surface: { expansion: { left: number, right: number } | null }) =>
      surface.expansion &&
      surface.expansion.left >= plainTitleVariantEdgeExpansion.target.chipLeft - 1 &&
      surface.expansion.right <= plainTitleVariantEdgeExpansion.target.viewportRight - 12,
    ),
    `plain same-title variant chip should clamp to right-side room instead of growing left: ${JSON.stringify(plainTitleVariantEdgeExpansion)}`,
  )
  const wrappedTitleVariantExpansion = await measureWrappedTitleVariantExpansion(harness)
  assert.equal(
    wrappedTitleVariantExpansion.target.titleLineCount,
    2,
    `wrapped same-title variant title should start as two visible lines: ${JSON.stringify(wrappedTitleVariantExpansion)}`,
  )
  assert.ok(
    wrappedTitleVariantExpansion.target.markerCount > 0,
    `wrapped same-title variant title should include a compact suppression marker: ${JSON.stringify(wrappedTitleVariantExpansion)}`,
  )
  assert.ok(wrappedTitleVariantExpansion.expansion, `wrapped same-title variant chip should expand in place: ${JSON.stringify(wrappedTitleVariantExpansion)}`)
  assert.ok(
    Math.abs(wrappedTitleVariantExpansion.expansion.width - wrappedTitleVariantExpansion.target.chipWidth) <= 1,
    `wrapped same-title variant chip should not grow when expanded title text fits in the resting line count: ${JSON.stringify(wrappedTitleVariantExpansion)}`,
  )
  assert.equal(
    wrappedTitleVariantExpansion.expansion.titleLineCount,
    wrappedTitleVariantExpansion.target.titleLineCount,
    `wrapped same-title variant expansion should keep the resting title line count: ${JSON.stringify(wrappedTitleVariantExpansion)}`,
  )
  assert.ok(
    wrappedTitleVariantExpansion.expansion.titleText.includes('Example Optical'),
    `wrapped same-title variant expansion should reveal the suppressed title text: ${JSON.stringify(wrappedTitleVariantExpansion)}`,
  )

  const duplicateStackGeometry = await measureDuplicateStackGeometry(harness)
  assert.ok(duplicateStackGeometry, `duplicate page chip stack should render in the browser smoke harness: ${JSON.stringify(duplicateStackGeometry)}`)
  assert.ok(
    duplicateStackGeometry.frame.width <= 18 && duplicateStackGeometry.frame.height <= 18,
    `duplicate page chip favicon stack frame should stay favicon-sized: ${JSON.stringify(duplicateStackGeometry)}`,
  )
  assert.equal(duplicateStackGeometry.layers.length, 2, `duplicate page chip should render two stack layers for 4 copies: ${JSON.stringify(duplicateStackGeometry)}`)
  assert.ok(
    duplicateStackGeometry.layers.every((layer: { width: number, height: number }) => layer.width <= 18 && layer.height <= 18),
    `duplicate page chip stack layers should not stretch into a tall overlay: ${JSON.stringify(duplicateStackGeometry)}`,
  )

  await evaluateInPage(harness, titleVariantsPage.injectSmokeTabs, { hook: '__tabOutSmokeAddPathGroupPlaceholderTabs' })
  const oneLinePathGroupPlaceholderTooltip = await measurePageChipTooltipLineCount(harness, 'at story/ABC-123_2', {
    forcedTextWidth: 130,
    forcedMaxLines: 1,
    hoverWaitMs: 40,
    viewportWidth: 2200,
  })
  assert.ok(oneLinePathGroupPlaceholderTooltip.tooltip, `one-line path-group placeholder tooltip should open: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`)
  assert.equal(
    oneLinePathGroupPlaceholderTooltip.target.chipLineCount,
    1,
    `one-line path-group placeholder smoke target should render as one visible chip line: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`,
  )
  assert.equal(
    oneLinePathGroupPlaceholderTooltip.tooltip.tooltipLineCount,
    1,
    `one-line path-group placeholder tooltip should widen enough to stay on one line: ${JSON.stringify(oneLinePathGroupPlaceholderTooltip)}`,
  )

  // Runs near the end (before the bookmark-source switch) so its hover/right-click
  // interactions cannot perturb the timing-sensitive tabs-source measurements above.
  const suppressionTokenClose = await measureSuppressionTokenCloseHighlight(harness)
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
  const markerWrapStability = await measureMarkerWrapExpansionReflow(harness, { forcedTextWidth: 205 })
  assert.ok(markerWrapStability.target, `marker-wrap stability smoke should find its path-group chip: ${JSON.stringify(markerWrapStability)}`)
  assert.ok(
    markerWrapStability.target.chipLineCount >= 2,
    `marker-wrap stability smoke target should rest as a wrapped multi-line title: ${JSON.stringify(markerWrapStability.target)}`,
  )
  assert.ok(
    markerWrapStability.target.suppressionPillCount >= 2,
    `marker-wrap stability smoke target should carry two suppression pills at rest: ${JSON.stringify(markerWrapStability.target)}`,
  )
  assert.ok(markerWrapStability.expansion, `marker-wrap chip should expand in place: ${JSON.stringify(markerWrapStability)}`)
  assert.ok(
    ['Example Website', 'Contentful', 'dev2'].every((part) => markerWrapStability.expansion?.text.includes(part)),
    `marker-wrap expansion should reveal every suppressed/placeholder label: ${JSON.stringify(markerWrapStability.expansion)}`,
  )
  assert.deepEqual(
    markerWrapStability.expansion.pills.map((pill: { visualLine: number }) => pill.visualLine),
    markerWrapStability.target.pillLines,
    `expanded pills must stay on the visible lines they occupied at rest: ${JSON.stringify(markerWrapStability)}`,
  )

  // Single-line-resting variant of the same defect: the compact glyph title
  // fits one resting line, but the hydrated reveal exceeds the rightward
  // viewport allowance. The old "don't widen at all — keep the resting width
  // and wrap" rule for that shape re-strands pills at the narrow resting
  // width; with hydrating pills the reveal must take the packed allowance
  // instead, so pills drop down only when genuinely out of room.
  const markerWrapConstrainedReflow = await measureMarkerWrapExpansionReflow(harness, { viewportWidth: 430 })
  assert.ok(markerWrapConstrainedReflow.target, `constrained marker-wrap smoke should find its path-group chip: ${JSON.stringify(markerWrapConstrainedReflow)}`)
  assert.equal(
    markerWrapConstrainedReflow.target.chipLineCount,
    1,
    `constrained marker-wrap smoke target should rest as a single compact line: ${JSON.stringify(markerWrapConstrainedReflow.target)}`,
  )
  assert.ok(markerWrapConstrainedReflow.expansion, `constrained marker-wrap chip should expand in place: ${JSON.stringify(markerWrapConstrainedReflow)}`)
  assert.ok(
    ['Example Website', 'Contentful', 'dev2'].every((part) => markerWrapConstrainedReflow.expansion?.text.includes(part)),
    `constrained marker-wrap expansion should reveal every suppressed/placeholder label: ${JSON.stringify(markerWrapConstrainedReflow.expansion)}`,
  )
  assert.equal(
    markerWrapConstrainedReflow.expansion.strandedPills.length,
    0,
    `expanded suppression pills must not start a continuation line while the previous line has viewport room for them (resting-width wrap): ${JSON.stringify(markerWrapConstrainedReflow.expansion)}`,
  )

  const markerOnlyLine = await measureMarkerOnlyLineExpansion(harness)
  assert.ok(markerOnlyLine.target, `marker-only-line smoke should find its suffixed chip: ${JSON.stringify(markerOnlyLine)}`)
  assert.ok(
    (markerOnlyLine.target.markerLine ?? 0) >= 1 && (markerOnlyLine.target.markerLeftOffset ?? 99) <= 8,
    `marker-only-line smoke target should rest with its trailing pill starting a middle line: ${JSON.stringify(markerOnlyLine.target)}`,
  )
  assert.ok(markerOnlyLine.expansion, `marker-only-line chip should expand in place: ${JSON.stringify(markerOnlyLine)}`)
  assert.equal(
    markerOnlyLine.expansion.markerLine,
    markerOnlyLine.target.markerLine,
    `a pill alone on its resting line must stay on that visible line when it hydrates (reveal in place): ${JSON.stringify(markerOnlyLine)}`,
  )
  // Long opaque assignee values render as bounded stable fingerprints, so the
  // hydrated suffix is the readable query key plus each variant's fingerprint.
  assert.ok(
    ['assignee=', '1RLVW78', '08KCGBG'].every((part) => markerOnlyLine.expansion?.text.includes(part)),
    `marker-only-line expansion should reveal the fingerprinted URL suffixes: ${JSON.stringify(markerOnlyLine.expansion)}`,
  )

  const variantTitleRow = await measureVariantTitleRowStability(harness)
  assert.ok(variantTitleRow.target, `variant title-row smoke should find its merged chip: ${JSON.stringify(variantTitleRow)}`)
  assert.equal(
    variantTitleRow.target.titleRowLines,
    2,
    `variant title-row smoke target should rest as two title lines: ${JSON.stringify(variantTitleRow.target)}`,
  )
  assert.ok(
    variantTitleRow.target.indicatorLine === 0 && variantTitleRow.target.anchorLine === 1,
    `variant title-row smoke target should rest with the indicator on line 1 and "from my" on line 2: ${JSON.stringify(variantTitleRow.target)}`,
  )
  assert.ok(variantTitleRow.expansion, `variant title-row chip should expand in place: ${JSON.stringify(variantTitleRow)}`)
  assert.ok(
    variantTitleRow.expansion.indicatorText.includes('example-owner/skills'),
    `variant title-row expansion should hydrate the structural indicator label: ${JSON.stringify(variantTitleRow.expansion)}`,
  )
  assert.equal(
    variantTitleRow.expansion.anchorLine,
    variantTitleRow.target.anchorLine,
    `text after the hydrating indicator must stay on its resting line when the title expands: ${JSON.stringify(variantTitleRow)}`,
  )
  assert.equal(
    variantTitleRow.expansion.indicatorLine,
    0,
    `the hydrated indicator should stay on the first title line: ${JSON.stringify(variantTitleRow.expansion)}`,
  )

  const largeBookmarks = await measureLargeBookmarkProgressiveRender(harness)
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

test('destructive menu actions stay red at rest and through pointer and keyboard highlight', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?retainedFocus=1&retainedMixedFocus=1')

  const retainedChip = page.locator(
    '[data-tabout="domain-card"][data-tabout-domain="retained-focus-only.test"] [data-tabout="page-chip"]',
  ).first()
  await expect(retainedChip).toBeVisible()
  await retainedChip.click({ button: 'right' })

  const contextMenu = page.locator('[data-slot="context-menu-content"]:visible')
  const saveItem = contextMenu.locator('[data-slot="context-menu-item"]', { hasText: 'Save page' })
  const removeItem = contextMenu.locator('[data-slot="context-menu-item"]', { hasText: 'Remove from Tabs' })
  await expect(contextMenu).toBeVisible()
  await expect(saveItem).toHaveAttribute('data-variant', 'default')
  await expect(removeItem).toHaveAttribute('data-variant', 'destructive')

  await page.mouse.move(0, 0)
  await expect(removeItem).not.toHaveAttribute('data-highlighted', '')
  const saveRestColor = await saveItem.evaluate((element) => getComputedStyle(element).color)
  const removeRestColor = await removeItem.evaluate((element) => getComputedStyle(element).color)
  const removeRestBackground = await removeItem.evaluate((element) => getComputedStyle(element).backgroundColor)
  const destructiveColor = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--color-destructive)'
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  expect(removeRestColor).toBe(destructiveColor)
  expect(removeRestColor).not.toBe(saveRestColor)

  await removeItem.hover()
  await expect(removeItem).toHaveAttribute('data-highlighted', '')
  const removePointerColor = await removeItem.evaluate((element) => getComputedStyle(element).color)
  const removePointerBackground = await removeItem.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(removePointerColor).toBe(removeRestColor)
  expect(removePointerBackground).not.toBe(removeRestBackground)

  await page.mouse.move(0, 0)
  await expect(removeItem).not.toHaveAttribute('data-highlighted', '')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(removeItem).toHaveAttribute('data-highlighted', '')
  const removeKeyboardColor = await removeItem.evaluate((element) => getComputedStyle(element).color)
  const removeKeyboardBackground = await removeItem.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(removeKeyboardColor).toBe(removeRestColor)
  expect(removeKeyboardBackground).toBe(removePointerBackground)

  await page.keyboard.press('Escape')
  await expect(contextMenu).toHaveCount(0)

  const retainedCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="retained-focus-only.test"]')
  await retainedCard.hover()
  await retainedCard.locator('[data-tabout-part="card-menu"]').click()
  const cardMenu = page.locator('[data-slot="menu-content"]:visible')
  const cardRemoveItem = cardMenu.locator('[data-tabout-part="remove-from-tabs-button"]')
  await expect(cardMenu).toBeVisible()
  await expect(cardMenu).toBeFocused()
  await page.keyboard.press('End')
  await expect(cardRemoveItem).toHaveAttribute('data-variant', 'destructive')
  await expect(cardRemoveItem).toHaveAttribute('data-highlighted', '')
  const cardRemoveColor = await cardRemoveItem.evaluate((element) => getComputedStyle(element).color)
  expect(cardRemoveColor).toBe(destructiveColor)

  await page.keyboard.press('Escape')
  await expect(cardMenu).toHaveCount(0)

  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-01.com"]')
  await card.hover()
  await card.locator('[data-tabout-part="card-menu"]').click()
  const closeItem = page.locator('[data-slot="menu-content"]:visible [data-tabout-part="close-button"]')
  await expect(closeItem).toHaveAttribute('data-variant', 'default')
  const closeRestColor = await closeItem.evaluate((element) => getComputedStyle(element).color)
  expect(closeRestColor).toBe(saveRestColor)
  expect(closeRestColor).not.toBe(removeRestColor)
})

test('Page Chip context-menu separators stay conditional for retained and copy-only pages', async ({ page }) => {
  async function expectContextMenuSequence(domain: string, sequence: string[]) {
    const trigger = page.locator(
      `[data-tabout="domain-card"][data-tabout-domain="${domain}"] [data-tabout="page-chip"]`,
    ).first()
    await expect(trigger).toBeVisible()
    await trigger.click({ button: 'right' })

    const menu = page.locator('[data-slot="context-menu-content"]:visible')
    await expect(menu).toBeVisible()
    const actualSequence = await menu.locator(':scope > [data-slot]').evaluateAll((elements) => (
      elements.map((element) => (
        element.getAttribute('data-slot') === 'context-menu-separator'
          ? 'separator'
          : element.textContent?.trim() || ''
      ))
    ))
    expect(actualSequence).toEqual(sequence)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  }

  await page.goto('/tests/fixtures/dashboard-resize.html?retainedFocus=1')
  await expectContextMenuSequence('retained-focus-only.test', [
    'Pin',
    'Save page',
    'Remove from Tabs',
    'separator',
    'Copy page title text',
    'Copy URL',
  ])

  await page.goto('/tests/fixtures/dashboard-resize.html?initialBookmarks=1')
  await page.getByRole('tab', { name: 'Bookmarks' }).click()
  await expectContextMenuSequence('bookmark-smoke-0001.test', [
    'Copy page title text',
    'Copy URL',
  ])
})

test('domain card menu conditionally groups actions and puts retained-page removal last', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?retainedFocus=1&retainedMixedFocus=1')

  async function expectCardMenuSequence(domain: string, sequence: string[], labels?: string[]) {
    const card = page.locator(`[data-tabout="domain-card"][data-tabout-domain="${domain}"]`)
    await expect(card).toBeVisible()
    await card.hover()
    await card.locator('[data-tabout-part="card-menu"]').click()

    const menu = page.locator('[data-slot="menu-content"]:visible')
    await expect(menu).toBeVisible()
    const actualSequence = await menu.locator(':scope > [data-slot]').evaluateAll((elements) => (
      elements.map((element) => element.getAttribute('data-tabout-part') ?? element.getAttribute('data-slot'))
    ))
    expect(actualSequence).toEqual(sequence)
    const separatorInsets = await menu.locator(':scope > [data-slot="menu-separator"]').evaluateAll((separators) => {
      return separators.map((separator) => {
        const popupRect = separator.parentElement?.getBoundingClientRect()
        const rect = separator.getBoundingClientRect()
        return {
          left: popupRect ? rect.left - popupRect.left : 0,
          right: popupRect ? popupRect.right - rect.right : 0,
        }
      })
    })
    for (const inset of separatorInsets) {
      expect(inset.left).toBeCloseTo(8, 0)
      expect(inset.right).toBeCloseTo(8, 0)
    }
    if (labels) await expect(menu.locator('[data-slot="menu-item"]')).toHaveText(labels)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  }

  await expectCardMenuSequence('contentful.com', [
    'pin-button',
    'menu-separator',
    'suspend-button',
    'close-suspended-button',
    'close-button',
  ])
  await expectCardMenuSequence('__hostless-pages__', [
    'remove-from-tabs-button',
  ])
  await expectCardMenuSequence('retained-focus-only.test', [
    'pin-button',
    'menu-separator',
    'remove-from-tabs-button',
  ])

  await page.evaluate(async () => {
    await chrome.tabs.create({
      active: false,
      url: 'https://retained-focus.test/live',
    })
    await chrome.tabs.create({
      active: false,
      url: 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fretained-focus.test%2Fsleep',
    })

    const dispatch = Reflect.get(chrome.tabs.onCreated, 'dispatch')
    if (typeof dispatch !== 'function') throw new Error('Fake Chrome tabs.onCreated dispatch is unavailable')
    Reflect.apply(dispatch, chrome.tabs.onCreated, [])
  })

  const mixedCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="retained-focus.test"]')
  await expect(mixedCard.locator('[data-tabout="page-chip"]')).toHaveCount(5)
  await expectCardMenuSequence(
    'retained-focus.test',
    [
      'pin-button',
      'menu-separator',
      'suspend-button',
      'close-suspended-button',
      'close-button',
      'menu-separator',
      'remove-from-tabs-button',
    ],
    [
      'Pin card',
      'Suspend 1 active tab',
      'Close 1 suspended tab',
      'Close all 2 tabs',
      'Remove 3 from Tabs',
    ],
  )
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
      writes: [] as string[][],
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
        __tabOutPinWriteAudit: { active: number, maxActive: number, writes: string[][] }
      }
    ).__tabOutPinWriteAudit
    const stored = await window.chrome.storage.local.get('tabOutPinnedDomainsV1')
    return {
      active: audit.active,
      maxActive: audit.maxActive,
      stored: stored.tabOutPinnedDomainsV1,
      writes: audit.writes,
    }
  })

  expect(result).toEqual({
    active: 0,
    maxActive: 1,
    stored: ['contentful.com', 'suppression-smoke.example'],
    writes: [
      ['contentful.com'],
      ['contentful.com', 'suppression-smoke.example'],
    ],
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
    pointerType: 'mouse',
  })
  await expect(thumb).toHaveAttribute('data-dragging', 'true')

  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      pointerId: 7,
      pointerType: 'mouse',
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
      pointerType: 'mouse',
    }))
  }, start)
  const afterMove = await page.locator('.history-entry-list').evaluate((element) => element.scrollTop)
  expect(afterMove).toBe(afterCancel)
})
