import { expect, test } from '@playwright/test'

test('dashboard avoids eager tooltip measurement surfaces', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await expect(page.locator('.page-chip-tooltip-measure')).toHaveCount(0)
  await expect(page.locator('.history-entry-title-expansion-measure')).toHaveCount(0)
  await expect(page.locator('[data-slot="tooltip-content"]:visible')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('direct Bookmarks URL paints its final filter placeholder before React', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const hydrationErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydration|didn't match/i.test(message.text())) {
      hydrationErrors.push(message.text())
    }
  })
  const appModuleGate = Promise.withResolvers<void>()
  await page.route('**/extension/dist/app.js', async (route) => {
    await appModuleGate.promise
    await route.continue()
  })

  const navigation = page.goto('/tests/fixtures/dashboard-resize.html?view=bookmarks')

  const filterInput = page.locator(
    '[data-tabout="filter-query"] [data-tabout-part="input"]',
  )
  const startupPlaceholder = page.locator('.bookmarks-filter-startup-placeholder')
  try {
    await expect(filterInput).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-tabout-startup-view', 'bookmarks')
    await expect(filterInput).toHaveAttribute('placeholder', 'Filter tabs, bookmarks, history…')
    await expect(filterInput).toHaveAccessibleName('Filter dashboard')
    await expect(startupPlaceholder).toBeVisible()
    await expect(startupPlaceholder).toHaveText('Filter bookmarks…')
    expect(await filterInput.evaluate((input) => input.matches(':placeholder-shown'))).toBe(true)
    const startupPaint = await filterInput.evaluate(async (input) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      const startupPlaceholder = input.parentElement?.querySelector<HTMLElement>(
        '.bookmarks-filter-startup-placeholder',
      )
      const inputStyle = getComputedStyle(input)
      const inputRect = input.getBoundingClientRect()
      const startupPlaceholderRect = startupPlaceholder?.getBoundingClientRect()
      return {
        placeholderOpacity: getComputedStyle(input, '::placeholder').opacity,
        textInsetMatches: startupPlaceholderRect
          ? startupPlaceholderRect.left === inputRect.left +
          Number.parseFloat(inputStyle.borderLeftWidth) +
          Number.parseFloat(inputStyle.paddingLeft)
          : false,
        textStylesMatch: startupPlaceholder
          ? ['color', 'font-family', 'font-size', 'font-weight'].every(
              (property) => getComputedStyle(startupPlaceholder).getPropertyValue(property) ===
                getComputedStyle(input, '::placeholder').getPropertyValue(property),
            ) && getComputedStyle(startupPlaceholder).lineHeight === getComputedStyle(input).lineHeight
          : false,
      }
    })
    expect(startupPaint).toEqual({
      placeholderOpacity: '0',
      textInsetMatches: true,
      textStylesMatch: true,
    })
    await filterInput.fill('Example Query')
    await expect(startupPlaceholder).toBeHidden()
    await filterInput.fill('')
    await expect(startupPlaceholder).toBeVisible()
  } finally {
    appModuleGate.resolve()
    await navigation
  }

  await expect(page.locator('html')).not.toHaveAttribute('data-tabout-startup-view')
  await expect(page.locator('.bookmarks-filter-startup-placeholder')).toBeHidden()
  await expect(filterInput).toHaveAttribute('placeholder', 'Filter bookmarks…')
  await expect(filterInput).toHaveAccessibleName('Filter dashboard')
  expect(hydrationErrors).toEqual([])
})

for (const viewport of [
  { label: 'wide', width: 1200 },
  { label: 'compressed', width: 920 },
  { label: 'narrow', width: 800 },
]) {
  test(`direct Bookmarks URL keeps the filter in its first-paint position at ${viewport.label} layout`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 800 })
    await page.addInitScript(() => {
      const measurements = {
        count: 0,
        maxLeft: Number.NEGATIVE_INFINITY,
        maxTop: Number.NEGATIVE_INFINITY,
        maxWidth: Number.NEGATIVE_INFINITY,
        minLeft: Number.POSITIVE_INFINITY,
        minTop: Number.POSITIVE_INFINITY,
        minWidth: Number.POSITIVE_INFINITY,
      }
      Reflect.set(window, '__tabOutBookmarksFilterPositions', measurements)

      const sampleFilterPosition = () => {
        const input = document.querySelector('[data-tabout="filter-query"] [data-tabout-part="input"]')
        if (input instanceof HTMLInputElement) {
          const rect = input.getBoundingClientRect()
          measurements.count += 1
          measurements.maxLeft = Math.max(measurements.maxLeft, rect.left)
          measurements.maxTop = Math.max(measurements.maxTop, rect.top)
          measurements.maxWidth = Math.max(measurements.maxWidth, rect.width)
          measurements.minLeft = Math.min(measurements.minLeft, rect.left)
          measurements.minTop = Math.min(measurements.minTop, rect.top)
          measurements.minWidth = Math.min(measurements.minWidth, rect.width)
        }
        requestAnimationFrame(sampleFilterPosition)
      }
      requestAnimationFrame(sampleFilterPosition)
    })

    await page.goto('/tests/fixtures/dashboard-resize.html?view=bookmarks&initialBookmarks=3&slowInitialStorage=1', {
      waitUntil: 'domcontentloaded',
    })

    await expect(page.locator('[data-tabout="activation-history"]')).toBeHidden()
    await expect(page.locator('[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]')).toBeVisible()
    await expect(page.locator('html')).not.toHaveAttribute('data-tabout-startup-view')
    await expect(page.locator('[data-tabout="activation-history"]')).toHaveCount(0)

    const positions = await page.evaluate(() => {
      const measurements = Reflect.get(window, '__tabOutBookmarksFilterPositions')
      if (typeof measurements !== 'object' || measurements === null) {
        throw new Error('Bookmarks filter-position measurements are unavailable')
      }
      const count = Reflect.get(measurements, 'count')
      const maxLeft = Reflect.get(measurements, 'maxLeft')
      const maxTop = Reflect.get(measurements, 'maxTop')
      const maxWidth = Reflect.get(measurements, 'maxWidth')
      const minLeft = Reflect.get(measurements, 'minLeft')
      const minTop = Reflect.get(measurements, 'minTop')
      const minWidth = Reflect.get(measurements, 'minWidth')
      if (
        typeof count !== 'number' ||
        typeof maxLeft !== 'number' ||
        typeof maxTop !== 'number' ||
        typeof maxWidth !== 'number' ||
        typeof minLeft !== 'number' ||
        typeof minTop !== 'number' ||
        typeof minWidth !== 'number'
      ) throw new Error('Bookmarks filter-position measurements are invalid')
      return { count, maxLeft, maxTop, maxWidth, minLeft, minTop, minWidth }
    })

    expect(positions.count).toBeGreaterThan(5)
    expect(positions.maxLeft - positions.minLeft).toBeLessThanOrEqual(0.5)
    expect(positions.maxTop - positions.minTop).toBeLessThanOrEqual(0.5)
    expect(positions.maxWidth - positions.minWidth).toBeLessThanOrEqual(0.5)
  })
}

test('toast renderer stays off startup and loads for the first notification', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/dashboard-resize.html', {
    waitUntil: 'networkidle',
  })

  const startupScripts = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name.split('/').pop() ?? ''),
  )
  expect(startupScripts.some((name) => name.startsWith('mountToast-'))).toBe(
    false,
  )

  await page
    .getByRole('button', { name: 'Close this tab' })
    .first()
    .dispatchEvent('click')
  await expect(page.getByText('Tab closed', { exact: true })).toBeVisible()

  const toast = page.locator('[data-tabout="toast"]')
  const toastClose = toast.locator('[data-tabout-part="close-button"]')
  await expect(toastClose).toHaveCSS('opacity', '0')
  await expect(toastClose).toHaveCSS('pointer-events', 'none')
  const [toastBounds, closeBounds] = await Promise.all([
    toast.boundingBox(),
    toastClose.boundingBox(),
  ])
  if (!toastBounds || !closeBounds) {
    throw new Error('Toast close-button geometry is unavailable')
  }
  expect(closeBounds).toMatchObject({ height: 20, width: 20 })
  expect(closeBounds.x - toastBounds.x).toBeCloseTo(-6, 1)
  expect(closeBounds.y - toastBounds.y).toBeCloseTo(-6, 1)

  await toast.hover({ position: { x: 100, y: 24 } })
  await expect(toastClose).toHaveCSS('opacity', '1')
  await expect(toastClose).toHaveCSS('pointer-events', 'auto')
  await expect(toastClose).toHaveAccessibleName('Close')

  await page.mouse.move(900, 100)
  await toastClose.focus()
  await expect(toastClose).toHaveCSS('opacity', '1')
  await expect(toastClose).toHaveCSS('pointer-events', 'auto')
  await page.keyboard.press('Enter')
  await expect(toast).not.toBeAttached()

  const interactionScripts = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name.split('/').pop() ?? ''),
  )
  expect(
    interactionScripts.some((name) => name.startsWith('mountToast-')),
  ).toBe(true)
})

test('dashboard coalesces collapsed-title layout reads during startup', async ({ page }) => {
  await page.addInitScript(() => {
    const counts = {
      chipTextFadeRangeRects: 0,
      chipTextComputedStyles: 0,
      chipTextRangeRects: 0,
      chipTextRects: 0,
      chipTextSizeReads: 0,
      chipTextSizeReadsAfterTruncationWrite: 0,
      chipTextChildRemovals: 0,
      chipTextTruncationWrites: 0,
      domainCardRects: 0,
      historyTitleFadeRangeRects: 0,
      historyTitleRangeRects: 0,
      historyTitleRangeRectsAfterTruncationWrite: 0,
      historyTitleRects: 0,
      historyTitleSizeReads: 0,
      historyTitleSizeReadsAfterTruncationWrite: 0,
      historyTitleChildRemovals: 0,
      historyTitleTruncationWrites: 0,
      numericLocaleCompareCalls: 0,
      pathgroupLabelSizeReads: 0,
      titleTemplateCreates: 0,
      layoutShift: 0,
    }
    const benchmarkWindow = window as typeof window & {
      __tabOutFirstPaintMeasurements: typeof counts
    }
    benchmarkWindow.__tabOutFirstPaintMeasurements = counts

    const localeCompare = String.prototype.localeCompare
    String.prototype.localeCompare = function getInstrumentedLocaleCompare(
      compareString: string,
      locales?: Intl.LocalesArgument,
      options?: Intl.CollatorOptions,
    ) {
      if (options?.numeric === true) counts.numericLocaleCompareCalls += 1
      return localeCompare.call(this, compareString, locales, options)
    }

    const createElement = Document.prototype.createElement
    Document.prototype.createElement = function createInstrumentedElement(
      this: Document,
      qualifiedName: string,
      options?: ElementCreationOptions,
    ) {
      if (qualifiedName.toLowerCase() === 'template') counts.titleTemplateCreates += 1
      return createElement.call(this, qualifiedName, options)
    } as typeof Document.prototype.createElement

    const getComputedStyle = window.getComputedStyle
    window.getComputedStyle = function getInstrumentedComputedStyle(element, pseudoElt) {
      if (
        element instanceof HTMLElement &&
        (element.classList.contains('chip-text') || element.classList.contains('chip-title-row'))
      ) {
        counts.chipTextComputedStyles += 1
      }
      return getComputedStyle.call(this, element, pseudoElt)
    }

    const getBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getInstrumentedBoundingClientRect() {
      if (this instanceof HTMLElement) {
        if (this.matches('[data-tabout="domain-card"]')) counts.domainCardRects += 1
        if (this.classList.contains('history-entry-title')) counts.historyTitleRects += 1
        if (this.classList.contains('chip-text') || this.classList.contains('chip-title-row')) {
          counts.chipTextRects += 1
        }
      }
      return getBoundingClientRect.call(this)
    }

    const toggleClass = DOMTokenList.prototype.toggle
    DOMTokenList.prototype.toggle = function toggleInstrumentedClass(token, force) {
      const result = force === undefined
        ? toggleClass.call(this, token)
        : toggleClass.call(this, token, force)
      if (token === 'history-entry-title-truncated' && force === true) {
        counts.historyTitleTruncationWrites += 1
      }
      if (token === 'chip-text-truncated' && force === true) {
        counts.chipTextTruncationWrites += 1
      }
      return result
    }

    const removeChild = Node.prototype.removeChild
    Node.prototype.removeChild = function removeInstrumentedChild<T extends Node>(child: T) {
      if (this instanceof HTMLElement) {
        if (this.classList.contains('chip-text')) counts.chipTextChildRemovals += 1
        if (this.classList.contains('history-entry-title')) counts.historyTitleChildRemovals += 1
      }
      return removeChild.call(this, child) as T
    }

    for (const property of ['clientHeight', 'clientWidth', 'scrollHeight', 'scrollWidth'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property)
      const getSize = descriptor?.get
      if (!descriptor || !getSize) continue
      Object.defineProperty(Element.prototype, property, {
        ...descriptor,
        get() {
          if (this instanceof HTMLElement) {
            if (this.classList.contains('chip-text') || this.classList.contains('chip-title-row')) {
              counts.chipTextSizeReads += 1
              if (counts.chipTextTruncationWrites > 0) {
                counts.chipTextSizeReadsAfterTruncationWrite += 1
              }
            }
            if (this.classList.contains('history-entry-title')) {
              counts.historyTitleSizeReads += 1
              if (counts.historyTitleTruncationWrites > 0) {
                counts.historyTitleSizeReadsAfterTruncationWrite += 1
              }
            }
            if (
              (property === 'clientWidth' || property === 'scrollWidth') &&
              this.matches('.pathgroup-header .chip-pathgroup')
            ) {
              counts.pathgroupLabelSizeReads += 1
            }
          }
          return getSize.call(this)
        },
      })
    }

    const getClientRects = Range.prototype.getClientRects
    Range.prototype.getClientRects = function getInstrumentedClientRects() {
      const ancestor = this.commonAncestorContainer
      const element = ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement
      const chipText = element?.closest('.chip-text, .chip-title-row') as HTMLElement | null
      const historyTitle = element?.closest('.history-entry-title') as HTMLElement | null
      if (chipText) {
        counts.chipTextRangeRects += 1
        if (this.startContainer === chipText && this.endContainer === chipText) {
          counts.chipTextFadeRangeRects += 1
        }
      }
      if (historyTitle) {
        counts.historyTitleRangeRects += 1
        if (counts.historyTitleTruncationWrites > 0) {
          counts.historyTitleRangeRectsAfterTruncationWrite += 1
        }
        if (this.startContainer === historyTitle && this.endContainer === historyTitle) {
          counts.historyTitleFadeRangeRects += 1
        }
      }
      return getClientRects.call(this)
    }

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & {
        hadRecentInput: boolean
        value: number
      }>) {
        if (!entry.hadRecentInput) counts.layoutShift += entry.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await expect(page.locator('.missions.is-packed')).toHaveCount(1)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  const measurements = await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & {
      __tabOutFirstPaintMeasurements: {
        chipTextFadeRangeRects: number
        chipTextComputedStyles: number
        chipTextRangeRects: number
        chipTextRects: number
        chipTextSizeReads: number
        chipTextSizeReadsAfterTruncationWrite: number
        chipTextChildRemovals: number
        chipTextTruncationWrites: number
        domainCardRects: number
        historyTitleFadeRangeRects: number
        historyTitleRangeRects: number
        historyTitleRangeRectsAfterTruncationWrite: number
        historyTitleRects: number
        historyTitleSizeReads: number
        historyTitleSizeReadsAfterTruncationWrite: number
        historyTitleChildRemovals: number
        historyTitleTruncationWrites: number
        numericLocaleCompareCalls: number
        pathgroupLabelSizeReads: number
        titleTemplateCreates: number
        layoutShift: number
      }
    }
    return {
      ...benchmarkWindow.__tabOutFirstPaintMeasurements,
      chipCount: document.querySelectorAll('[data-tabout="page-chip"][data-tabout-context="domain-card"]').length,
      domainCardCount: document.querySelectorAll('[data-tabout="domain-card"]').length,
      historyTitleCount: document.querySelectorAll('.history-entry-title').length,
      pathgroupLabelCount: document.querySelectorAll('.pathgroup-header .chip-pathgroup').length,
    }
  })

  expect(measurements.chipCount).toBeGreaterThan(0)
  expect(measurements.domainCardCount).toBeGreaterThan(0)
  expect(measurements.historyTitleCount).toBeGreaterThan(0)
  expect(measurements.chipTextFadeRangeRects).toBe(0)
  expect(measurements.chipTextComputedStyles / measurements.chipCount).toBeLessThanOrEqual(1)
  expect(measurements.chipTextRangeRects / measurements.chipCount).toBeLessThanOrEqual(12)
  expect(measurements.chipTextRects / measurements.chipCount).toBeLessThanOrEqual(1)
  expect(measurements.chipTextChildRemovals / measurements.chipCount).toBeLessThanOrEqual(1)
  expect(measurements.chipTextTruncationWrites).toBeGreaterThan(0)
  expect(measurements.chipTextSizeReads / measurements.chipCount).toBeLessThanOrEqual(4)
  expect(measurements.chipTextSizeReadsAfterTruncationWrite).toBe(0)
  expect(measurements.domainCardRects / measurements.domainCardCount).toBeLessThanOrEqual(2)
  expect(measurements.historyTitleFadeRangeRects).toBe(0)
  expect(measurements.historyTitleRangeRects / measurements.historyTitleCount).toBeLessThanOrEqual(12)
  expect(measurements.historyTitleRangeRectsAfterTruncationWrite).toBe(0)
  expect(measurements.historyTitleRects / measurements.historyTitleCount).toBeLessThanOrEqual(1)
  expect(measurements.historyTitleChildRemovals / measurements.historyTitleCount).toBeLessThanOrEqual(1)
  expect(measurements.historyTitleTruncationWrites).toBeGreaterThan(0)
  expect(measurements.historyTitleSizeReads / measurements.historyTitleCount).toBeLessThanOrEqual(4)
  expect(measurements.historyTitleSizeReadsAfterTruncationWrite).toBe(0)
  expect(measurements.numericLocaleCompareCalls).toBe(0)
  expect(measurements.titleTemplateCreates / measurements.chipCount).toBeLessThanOrEqual(1.5)
  expect(measurements.pathgroupLabelCount).toBeGreaterThan(0)
  expect(measurements.pathgroupLabelSizeReads / measurements.pathgroupLabelCount).toBeLessThanOrEqual(2)
  expect(measurements.layoutShift).toBe(0)
})

test('Activation History paints title fades and a content frame before scrollbar geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1420, height: 360 })
  await page.addInitScript(() => {
    type FirstHistoryContentFrame = {
      historyTitleCount: number
      scrollbarGeometryReads: number
      scrollbarMounted: boolean
      truncatedTitleCount: number
      truncatedTitleFadeCount: number
    }
    type AfterFirstHistoryPaint = {
      scrollbarGeometryReads: number
      scrollbarMounted: boolean
    }
    const paintWindow = window as typeof window & {
      __tabOutAfterFirstHistoryPaint: AfterFirstHistoryPaint | null
      __tabOutFirstHistoryContentFrame: FirstHistoryContentFrame | null
    }
    paintWindow.__tabOutAfterFirstHistoryPaint = null
    paintWindow.__tabOutFirstHistoryContentFrame = null
    let scrollbarGeometryReads = 0

    for (const property of ['clientHeight', 'scrollHeight', 'scrollTop'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property)
      const getSize = descriptor?.get
      if (!descriptor || !getSize) continue
      Object.defineProperty(Element.prototype, property, {
        ...descriptor,
        get() {
          if (this instanceof HTMLElement && this.classList.contains('history-entry-list')) {
            scrollbarGeometryReads += 1
          }
          return getSize.call(this)
        },
      })
    }

    let frameCount = 0
    const captureFrame = () => {
      frameCount += 1
      const historyTitleCount = document.querySelectorAll('.history-entry-title').length
      if (historyTitleCount > 0) {
        const truncatedTitles = Array.from(document.querySelectorAll<HTMLElement>(
          '.history-entry-title-truncated',
        ))
        paintWindow.__tabOutFirstHistoryContentFrame = {
          historyTitleCount,
          scrollbarGeometryReads,
          scrollbarMounted: !!document.querySelector('[data-tabout-part="history-scrollbar"]'),
          truncatedTitleCount: truncatedTitles.length,
          truncatedTitleFadeCount: truncatedTitles.filter(
            (title) => getComputedStyle(title).maskImage !== 'none',
          ).length,
        }
        requestAnimationFrame(() => {
          paintWindow.__tabOutAfterFirstHistoryPaint = {
            scrollbarGeometryReads,
            scrollbarMounted: !!document.querySelector('[data-tabout-part="history-scrollbar"]'),
          }
        })
        return
      }
      if (frameCount < 120) requestAnimationFrame(captureFrame)
    }
    requestAnimationFrame(captureFrame)
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutFirstHistoryContentFrame: unknown
    }
    return paintWindow.__tabOutFirstHistoryContentFrame
  })).not.toBeNull()

  const firstContentFrame = await page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutFirstHistoryContentFrame: {
        historyTitleCount: number
        scrollbarGeometryReads: number
        scrollbarMounted: boolean
        truncatedTitleCount: number
        truncatedTitleFadeCount: number
      }
    }
    return paintWindow.__tabOutFirstHistoryContentFrame
  })

  expect(firstContentFrame.historyTitleCount).toBeGreaterThan(0)
  expect(firstContentFrame.scrollbarGeometryReads).toBe(0)
  expect(firstContentFrame.scrollbarMounted).toBe(false)
  expect(firstContentFrame.truncatedTitleCount).toBeGreaterThan(0)
  expect(firstContentFrame.truncatedTitleFadeCount).toBe(firstContentFrame.truncatedTitleCount)
  await expect.poll(() => page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutAfterFirstHistoryPaint: unknown
    }
    return paintWindow.__tabOutAfterFirstHistoryPaint
  })).not.toBeNull()
  const afterFirstHistoryPaint = await page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutAfterFirstHistoryPaint: {
        scrollbarGeometryReads: number
        scrollbarMounted: boolean
      }
    }
    return paintWindow.__tabOutAfterFirstHistoryPaint
  })
  expect(afterFirstHistoryPaint.scrollbarGeometryReads).toBe(0)
  expect(afterFirstHistoryPaint.scrollbarMounted).toBe(false)
  const scrollbar = page.locator('[data-tabout-part="history-scrollbar"]')
  await expect(scrollbar).toHaveCount(1)
  await expect(scrollbar.locator('.history-entry-scrollbar-thumb')).toHaveCSS('opacity', '0')
})

test('long Page Chip paints its final truncation treatment on the first refresh frame', async ({ page }) => {
  const targetTitle = 'Example 2 with enough tooltip text to prove viewport-edge collision flipping keeps the popup visible'
  await page.addInitScript((title) => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: Array<{
        fadeEnd: number
        hasFade: boolean
        maskImage: string
        width: number
        verticalOverflow: number
      }>
    }
    paintWindow.__tabOutTitlePaintFrames = []

    let frameCount = 0
    const captureFrame = () => {
      frameCount += 1
      const chip = Array.from(document.querySelectorAll<HTMLElement>('[data-tabout="page-chip"][data-tabout-context="domain-card"]'))
        .find((element) => element.textContent?.includes(title))
      const text = chip?.querySelector<HTMLElement>('.chip-text')
      if (text) {
        paintWindow.__tabOutTitlePaintFrames.push({
          fadeEnd: Number.parseFloat(text.style.getPropertyValue('--title-fade-end')),
          hasFade: text.classList.contains('chip-text-truncated'),
          maskImage: getComputedStyle(text).maskImage,
          width: text.getBoundingClientRect().width,
          verticalOverflow: text.scrollHeight - text.clientHeight,
        })
      }
      if (frameCount < 120) requestAnimationFrame(captureFrame)
    }
    requestAnimationFrame(captureFrame)
  }, targetTitle)

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: unknown[]
    }
    return paintWindow.__tabOutTitlePaintFrames.length
  })).toBeGreaterThan(1)

  const firstTitleFrame = await page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: Array<{
        fadeEnd: number
        hasFade: boolean
        maskImage: string
        width: number
        verticalOverflow: number
      }>
    }
    return paintWindow.__tabOutTitlePaintFrames[0]
  })
  expect(firstTitleFrame).toBeDefined()
  if (!firstTitleFrame) throw new Error('The first title paint frame was not captured')

  expect(firstTitleFrame.hasFade).toBe(true)
  expect(firstTitleFrame.maskImage).not.toBe('none')
  expect(Math.abs(firstTitleFrame.fadeEnd - firstTitleFrame.width)).toBeLessThanOrEqual(0.1)
  expect(firstTitleFrame.verticalOverflow).toBeLessThanOrEqual(1)
})
