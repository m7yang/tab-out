// Page functions for dashboard-level smoke measurements: masonry geometry,
// truncation fills, progressive bookmark rendering, scroll locking, and the
// class-retention probe. Each runs in the page realm through evaluateInPage,
// so only page globals and the params argument are in scope.

export type ClassRetentionProbeTarget = {
  selector: string
  label: string
  className: string
}

type ClassRetentionProbe = {
  target: HTMLElement
  classWasRemoved: boolean
  observer: MutationObserver | null
  consume(records: MutationRecord[]): void
}

type DashboardSmokeWindow = Window & {
  __tabOutSmokeClassRetentionProbe?: ClassRetentionProbe
  __tabOutSmokeErrors?: unknown[]
  __tabOutSmokeSetBookmarks?: (count: number) => void
}

export function scrollDashboardToTop(): void {
  document.querySelector('.scroll-region')?.scrollTo(0, 0)
}

export function startClassRetentionProbe(params: ClassRetentionProbeTarget): boolean {
  const smokeWindow = window as unknown as DashboardSmokeWindow
  const target = Array.from(document.querySelectorAll(params.selector))
    .find((candidate) => candidate.textContent?.includes(params.label))
  if (!(target instanceof HTMLElement) || !target.classList.contains(params.className)) {
    return false
  }

  const classListIncludes = (value: string | null | undefined) => (value || '').split(/\s+/).includes(params.className)
  const probe: ClassRetentionProbe = {
    target,
    classWasRemoved: false,
    observer: null,
    consume(records) {
      for (let index = 0; index < records.length; index += 1) {
        const before = classListIncludes(records[index]?.oldValue)
        const after = classListIncludes(records[index + 1]?.oldValue ?? target.getAttribute('class'))
        if (before && !after) probe.classWasRemoved = true
      }
    },
  }
  const observer = new MutationObserver((records) => probe.consume(records))
  probe.observer = observer
  observer.observe(target, {
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  })
  smokeWindow.__tabOutSmokeClassRetentionProbe = probe
  return true
}

export function finishClassRetentionProbe(): boolean | null {
  const smokeWindow = window as unknown as DashboardSmokeWindow
  const probe = smokeWindow.__tabOutSmokeClassRetentionProbe
  if (!probe?.observer) return null
  // MutationObserver callbacks may batch the removal and re-addition. The
  // next record's oldValue is the state after this record, so it preserves
  // transitions that are already healed by the time the callback runs.
  probe.consume(probe.observer.takeRecords())
  probe.observer.disconnect()
  const classWasRemoved = probe.classWasRemoved
  delete smokeWindow.__tabOutSmokeClassRetentionProbe
  return classWasRemoved
}

export function measureDashboard() {
  const smokeWindow = window as unknown as DashboardSmokeWindow
  const round = (value: number) => Math.round(value * 100) / 100
  const done = () => {
    const cards = Array.from(document.querySelectorAll('.domain-block'))
    const rects = cards.map((card) => card.getBoundingClientRect()).filter((rect) => rect.width > 0)
    const lefts = Array.from(new Set(rects.map((rect) => Math.round(rect.left))))
    const sourceSwitchRect = document.querySelector('[data-tabout="dashboard-view"]')?.getBoundingClientRect()
    const headerControlsRect = document.querySelector('.header-controls')?.getBoundingClientRect()
    const missionsRect = document.querySelector('.missions:not(.missions-empty)')?.getBoundingClientRect()
    return {
      cardCount: rects.length,
      columns: lefts.length,
      firstWidth: Math.round(rects[0]?.width || 0),
      headerControlsRight: headerControlsRect ? round(headerControlsRect.right) : null,
      missionsRight: missionsRect ? round(missionsRect.right) : null,
      rootHtmlLength: document.getElementById('appRoot')?.innerHTML.length || 0,
      sourceSwitchRight: sourceSwitchRect ? round(sourceSwitchRect.right) : null,
      errors: smokeWindow.__tabOutSmokeErrors || [],
    }
  }
  return new Promise<ReturnType<typeof done>>((resolve) => {
    const start = Date.now()
    const poll = () => {
      if (document.querySelectorAll('.domain-block').length >= 12) {
        requestAnimationFrame(() => setTimeout(() => resolve(done()), 700))
      } else if (Date.now() - start > 5000) {
        resolve(done())
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readTooltipMeasureNodeCounts() {
  return {
    pageChipMeasureNodes: document.querySelectorAll('.page-chip-tooltip-measure').length,
    historyExpansionMeasureNodes: document.querySelectorAll('.history-entry-title-expansion-measure').length,
    visibleTooltipNodes: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
      const rect = tooltip.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
    }).length,
  }
}

export function measureTruncatedTitleTailFill() {
  const summarize = (elements: Element[]) => {
    const truncated = elements.filter((el) => el.querySelector('.clamped-title-line'))
    return {
      truncatedCount: elements.length,
      clampedCount: truncated.length,
      tailOverflows: truncated.every((el) => {
        const rows = el.querySelectorAll('.clamped-title-line')
        const tail = rows[rows.length - 1]
        return rows.length > 1 && !!tail && tail.scrollWidth > el.clientWidth
      }),
      headsFit: truncated.every((el) => {
        const rows = Array.from(el.querySelectorAll('.clamped-title-line')).slice(0, -1)
        return rows.every((row) => row.scrollWidth <= el.clientWidth + 1)
      }),
    }
  }
  const measure = () => {
    const clampedPills = Array.from(document.querySelectorAll('.clamped-title-line .chip-title-suppression-marker'))
    return {
      history: summarize(Array.from(document.querySelectorAll('.history-entry-title.history-entry-title-truncated'))),
      chips: summarize(Array.from(document.querySelectorAll('.chip-text.chip-text-truncated')).filter((el) => (
        !el.closest('.page-chip-expanded') &&
        !el.querySelector('.chip-title-variant-list, .chip-folded-content')
      ))),
      clampedPillCount: clampedPills.length,
      clampedPillsKeepGlyph: clampedPills.every((pill) => !!pill.querySelector('svg.chip-title-suppression-glyph')),
      untruncatedWithClamp: document.querySelectorAll('.history-entry-title:not(.history-entry-title-truncated) .clamped-title-line').length,
    }
  }
  return new Promise<ReturnType<typeof measure>>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(measure()), 120)))
  })
}

type ProgressiveRenderSnapshot = {
  count: number
  elapsedMs: number
  elementCount: number
  measureNodeCount: number
  scrollTop: number
}

type ProgressiveRenderInitial = {
  count: number
  elapsedMs: number
  measureNodeCount: number
}

export function measureLargeBookmarkProgressiveRender() {
  const smokeWindow = window as unknown as DashboardSmokeWindow
  return new Promise<{
    initial: ProgressiveRenderInitial | null
    steady: ProgressiveRenderSnapshot | null
    final: ProgressiveRenderSnapshot
  }>((resolve) => {
    smokeWindow.__tabOutSmokeSetBookmarks?.(1008)
    const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-tabout-part="dashboard-view-option"]'))
      .find((candidate) => candidate.textContent?.trim() === 'Bookmarks')
    const start = performance.now()
    let initial: ProgressiveRenderInitial | null = null
    let steady: ProgressiveRenderSnapshot | null = null
    let lastScrollAt = 0
    const committedSource = () => document.querySelector('[data-tabout="dashboard-shell"]')?.getAttribute('data-source') || ''
    const cardCount = () => document.querySelectorAll('#openTabsMissions .domain-block').length
    const snapshot = (): ProgressiveRenderSnapshot => ({
      count: cardCount(),
      elapsedMs: Math.round(performance.now() - start),
      elementCount: document.querySelectorAll('#openTabsMissions *').length,
      measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length,
      scrollTop: Math.round(document.querySelector('[data-tabout-part="scroll-region"]')?.scrollTop || 0),
    })
    const captureInitialCommit = () => {
      if (initial || committedSource() !== 'bookmarks') return
      const count = cardCount()
      if (count === 0) return
      initial = {
        count,
        elapsedMs: Math.round(performance.now() - start),
        measureNodeCount: document.querySelectorAll('.page-chip-tooltip-measure').length,
      }
    }
    const observer = new MutationObserver(captureInitialCommit)
    const appRoot = document.getElementById('appRoot')
    if (appRoot) {
      observer.observe(appRoot, {
        attributes: true,
        attributeFilter: ['data-source'],
        subtree: true,
      })
    }
    trigger?.click()
    captureInitialCommit()
    const poll = () => {
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
      const complete = initial && steady && committedSource() === 'bookmarks' && current.count >= 1008
      if (complete || elapsed > 12000) {
        observer.disconnect()
        resolve({ initial, steady, final: current })
        return
      }
      setTimeout(poll, 16)
    }
    poll()
  })
}

export function findScrollLockTarget() {
  return new Promise<{
    x: number
    y: number
    initialScrollLeft: number
    scrollWidth: number
    clientWidth: number
    overflowX: string
    overscrollBehaviorX: string
  } | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const scrollRegion = document.querySelector<HTMLElement>('.scroll-region')
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
            overscrollBehaviorX: styles.overscrollBehaviorX,
          })
        })
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readScrollLockAfter() {
  const scrollRegion = document.querySelector('.scroll-region')
  const probe = scrollRegion?.querySelector('[data-scroll-lock-probe="true"]')
  const result = {
    scrollLeft: scrollRegion?.scrollLeft ?? null,
    scrollWidth: scrollRegion?.scrollWidth ?? 0,
    clientWidth: scrollRegion?.clientWidth ?? 0,
  }
  probe?.remove()
  return result
}

export type TooltipRect = {
  left: number
  right: number
  visualLeft: number
  visualRight: number
  top: number
  bottom: number
  width: number
  height: number
  textLeft: number | null
  textTop: number | null
  textWidth: number | null
  textHeight: number | null
  textLineHeight: number | null
  text: string
  tooltipLineCount: number | null
  tooltipLineTexts: string[]
  outlineWidth: number
  side: string | null
  align: string | null
  topLeftRadius: string
  topRightRadius: string
  transitionDuration: string
  transitionProperty: string
  webkitLineClamp: string | null
  svgCount: number
  viewportRight: number
}

export function waitForTooltipRect(): Promise<TooltipRect | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const tooltip = document.querySelector('[data-slot="tooltip-content"]')
      const rect = tooltip?.getBoundingClientRect()
      if (tooltip && rect && rect.width > 0 && rect.height > 0) {
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
          viewportRight: window.innerWidth,
        })
      } else if (Date.now() - start > 2000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}
