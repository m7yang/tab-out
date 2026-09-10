// Page functions for Activation History smoke measurements. Each runs in the
// page realm through evaluateInPage, so only page globals and the params
// argument are in scope.

export function findHistoryEntryHoverTarget(params: { label: string }): Promise<{ dismissX: number, x: number, y: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
        .find((candidate) => candidate.closest('.history-entry-row')?.textContent?.includes(params.label))
      const row = title?.closest('.history-entry-row')
      const entry = title?.closest('.history-entry')
      row?.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = title?.getBoundingClientRect()
      const entryRect = entry?.getBoundingClientRect()
      if (rect && rect.width > 120 && rect.height > 8 && entryRect && entryRect.width > 40) {
        resolve({
          dismissX: Math.round(entryRect.left + 20),
          x: Math.round(rect.left + Math.min(24, rect.width / 2)),
          y: Math.round(rect.top + rect.height / 2),
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

export function readExpandedHistoryEntryStyle() {
  const entry = document.querySelector('.history-entry-expanded')
  if (!entry) return null
  const styles = window.getComputedStyle(entry)
  return {
    cursor: styles.cursor,
    pointerEvents: styles.pointerEvents,
    userSelect: styles.userSelect,
  }
}

export function scrollHistoryListToTop(): void {
  document.querySelector('.history-entry-list')?.scrollTo(0, 0)
}

export function scrollHistoryAndDashboardToTop(): void {
  document.querySelector('.history-entry-list')?.scrollTo(0, 0)
  document.querySelector('.scroll-region')?.scrollTo(0, 0)
}

export function findHistoryEntryFaviconFrameTarget(params: { label: string }) {
  const describe = (frameRect: DOMRect, mainRect: DOMRect) => ({
    x: Math.round(frameRect.left + frameRect.width / 2),
    aboveY: Math.round(mainRect.top + Math.max(1, (frameRect.top - mainRect.top) / 2)),
    belowY: Math.round(frameRect.bottom + Math.max(1, (mainRect.bottom - frameRect.bottom) / 2)),
    frameTop: Math.round(frameRect.top),
    frameBottom: Math.round(frameRect.bottom),
    mainTop: Math.round(mainRect.top),
    mainBottom: Math.round(mainRect.bottom),
  })
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const row = Array.from(document.querySelectorAll('.history-entry-row'))
        .find((candidate) => candidate.textContent?.includes(params.label))
      row?.scrollIntoView({ block: 'center', inline: 'nearest' })
      const frameRect = row?.querySelector('.history-entry-favicon-frame')?.getBoundingClientRect()
      const mainRect = row?.querySelector('.history-entry-main')?.getBoundingClientRect()
      const usable = row && frameRect && mainRect &&
        frameRect.width > 4 &&
        frameRect.height > 4 &&
        mainRect.top < frameRect.top - 1 &&
        mainRect.bottom > frameRect.bottom + 1
      if (usable) {
        resolve(describe(frameRect, mainRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function findHistoryEntryWheelTarget(params: { label: string }) {
  const collectLineTexts = (root: Element, limit: number, lineHeight: number) => {
    const rootRect = root.getBoundingClientRect()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
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
        const paintedRects = Array.from(range.getClientRects()).filter((candidate) => candidate.width > 0 || candidate.height > 0)
        const charRect = paintedRects.at(-1)
        if (!charRect) continue
        const lineIndex = Math.max(0, Math.round((charRect.top - rootRect.top) / lineHeight))
        if (lineIndex >= limit) return lines
        lines[lineIndex] = (lines[lineIndex] ?? '') + text.charAt(offset)
      }
    }
    return lines
  }
  const describe = (title: Element, rect: DOMRect, slotRect: DOMRect, list: Element) => {
    const titleStyles = window.getComputedStyle(title)
    const lineHeight = Number.parseFloat(titleStyles.lineHeight || '') || 0
    const titleLineCount = Math.max(1, Math.round(rect.height / lineHeight))
    return {
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + rect.height / 2),
      titleLineCount,
      titleLineTexts: collectLineTexts(title, titleLineCount, lineHeight),
      titleLeft: Math.round(rect.left),
      titleLeftExact: Math.round(rect.left * 100) / 100,
      titleTop: Math.round(rect.top),
      titleTopExact: Math.round(rect.top * 100) / 100,
      titleWidth: Math.round(rect.width),
      titleWidthExact: Math.round(rect.width * 100) / 100,
      titleHeight: Math.round(rect.height * 100) / 100,
      titleLineHeight: lineHeight,
      titleMaskImage: titleStyles.maskImage || titleStyles.webkitMaskImage || '',
      titleWebkitLineClamp: titleStyles.webkitLineClamp || null,
      slotLeft: Math.round(slotRect.left),
      slotRight: Math.round(slotRect.right),
      slotTop: Math.round(slotRect.top),
      slotBottom: Math.round(slotRect.bottom),
      slotWidth: Math.round(slotRect.width),
      slotHeight: Math.round(slotRect.height),
      listScrollHeight: list.scrollHeight,
      listClientHeight: list.clientHeight,
      listMaxScrollTop: Math.max(0, list.scrollHeight - list.clientHeight),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
        .find((candidate) => candidate.closest('.history-entry-row')?.textContent?.includes(params.label))
      title?.closest('.history-entry-row')?.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = title?.getBoundingClientRect()
      const entry = title?.closest('.history-entry')
      const slot = entry?.closest('.history-entry-slot') || entry
      const slotRect = slot?.getBoundingClientRect()
      const list = document.querySelector('.history-entry-list')
      if (title && rect && slotRect && list && rect.width > 120 && rect.height > 8) {
        resolve(describe(title, rect, slotRect, list))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readHistoryScrollbarGeometry() {
  const panel = document.querySelector('.tab-history-panel')
  const list = document.querySelector('.history-entry-list')
  const scrollbar = document.querySelector('.history-entry-scrollbar')
  const thumb = document.querySelector('.history-entry-scrollbar-thumb')
  const panelRect = panel?.getBoundingClientRect()
  const listRect = list?.getBoundingClientRect()
  const scrollbarRect = scrollbar?.getBoundingClientRect()
  const thumbRect = thumb?.getBoundingClientRect()
  if (!panelRect || !listRect || !scrollbarRect || !thumbRect || !list) return null
  return {
    listClientHeight: list.clientHeight,
    listRight: Math.round(listRect.right * 100) / 100,
    listScrollHeight: list.scrollHeight,
    nativeScrollbarWidth: window.getComputedStyle(list).scrollbarWidth || '',
    panelRight: Math.round(panelRect.right * 100) / 100,
    revealPoint: {
      x: Math.round(scrollbarRect.left + scrollbarRect.width / 2),
      y: Math.round(scrollbarRect.bottom - 8),
    },
    scrollbarRight: Math.round(scrollbarRect.right * 100) / 100,
    scrollbarWidth: Math.round(scrollbarRect.width * 100) / 100,
    thumbHeight: Math.round(thumbRect.height * 100) / 100,
    viewportWidth: window.innerWidth,
  }
}

export function readExpandedEntryLayering(params: { label: string }) {
  const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  const row = Array.from(document.querySelectorAll('.history-entry-row'))
    .find((candidate) => candidate.textContent?.includes(params.label))
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
    expandedOpen: entry?.classList.contains('history-entry-expanded-open') || false,
  }
}

type RectEdges = { left: number, right: number, top: number, bottom: number }

// Probes whether the expanded entry owns its overlap with the history
// scrollbar thumb, before and after shifting the entry down the rail.
export function probeScrollbarOverlap(params: { label: string }) {
  const edges = (rect: DOMRect): RectEdges => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  const within = (node: Element | null, selector: string) => !!(node instanceof Element && node.closest(selector))
  const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  const scrollbar = document.querySelector('.history-entry-scrollbar')
  const thumb = document.querySelector('.history-entry-scrollbar-thumb')
  if (!(entry instanceof HTMLElement) || !(scrollbar instanceof HTMLElement) || !(thumb instanceof HTMLElement)) return null
  const entryRect = entry.getBoundingClientRect()
  const scrollbarRect = scrollbar.getBoundingClientRect()
  const thumbRect = thumb.getBoundingClientRect()
  const overlapTop = Math.max(entryRect.top, thumbRect.top)
  const overlapBottom = Math.min(entryRect.bottom, thumbRect.bottom)
  const rects = { entryRect: edges(entryRect), scrollbarRect: edges(scrollbarRect), thumbRect: edges(thumbRect) }
  if (overlapBottom - overlapTop <= 1) {
    return {
      clipPath: window.getComputedStyle(scrollbar).clipPath,
      thumbOpacity: null as string | null,
      ...rects,
      overlapPoint: null as { x: number, y: number } | null,
      visibleThumbLength: 0,
      visibleThumbPoint: null as { x: number, y: number } | null,
      visibleThumbHitScrollbar: false,
      hitScrollbar: null as boolean | null,
      hitExpanded: false,
      hitInputShield: false,
      hitInsideHistoryList: false,
      shiftedEntryTop: Number.NaN,
      shiftedOverlapPoint: null as { x: number, y: number } | null,
      shiftedHitScrollbar: false,
      shiftedHitExpanded: false,
      shiftedHitInputShield: false,
      shiftedHitInsideHistoryList: false,
    }
  }
  const overlapPoint = {
    x: Math.round((Math.max(entryRect.left, thumbRect.left) + Math.min(entryRect.right, thumbRect.right)) / 2),
    y: Math.round((overlapTop + overlapBottom) / 2),
  }
  const visibleThumbSegments = [
    { top: thumbRect.top, bottom: Math.min(thumbRect.bottom, entryRect.top) },
    { top: Math.max(thumbRect.top, entryRect.bottom), bottom: thumbRect.bottom },
  ].filter((segment) => segment.bottom - segment.top > 1)
  const visibleThumbSegment = visibleThumbSegments.sort(
    (left, right) => (right.bottom - right.top) - (left.bottom - left.top),
  )[0] || null
  const visibleThumbPoint = visibleThumbSegment
    ? {
        x: overlapPoint.x,
        y: Math.round((visibleThumbSegment.top + visibleThumbSegment.bottom) / 2),
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
        y: Math.round((shiftedOverlapTop + shiftedOverlapBottom) / 2),
      }
    : null
  const shiftedNode = shiftedOverlapPoint
    ? document.elementFromPoint(shiftedOverlapPoint.x, shiftedOverlapPoint.y)
    : null
  entry.style.transform = previousEntryTransform
  return {
    clipPath: window.getComputedStyle(scrollbar).clipPath,
    thumbOpacity: window.getComputedStyle(thumb).opacity as string | null,
    ...rects,
    overlapPoint: overlapPoint as { x: number, y: number } | null,
    visibleThumbLength: visibleThumbSegment ? visibleThumbSegment.bottom - visibleThumbSegment.top : 0,
    visibleThumbPoint,
    visibleThumbHitScrollbar: within(visibleThumbNode, '.history-entry-scrollbar'),
    hitScrollbar: within(overlapNode, '.history-entry-scrollbar') as boolean | null,
    hitExpanded: within(overlapNode, '.history-entry-expanded'),
    hitInputShield: within(overlapNode, '.history-entry-scrollbar-input-shield'),
    hitInsideHistoryList: within(overlapNode, '.history-entry-list'),
    shiftedEntryTop: shiftedEntryRect.top,
    shiftedOverlapPoint,
    shiftedHitScrollbar: within(shiftedNode, '.history-entry-scrollbar'),
    shiftedHitExpanded: within(shiftedNode, '.history-entry-expanded'),
    shiftedHitInputShield: within(shiftedNode, '.history-entry-scrollbar-input-shield'),
    shiftedHitInsideHistoryList: within(shiftedNode, '.history-entry-list'),
  }
}

export function hitTestExpandedEntry(params: { label: string, point: { x: number, y: number } }) {
  const expandedEntry = Array.from(document.querySelectorAll('.history-entry-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  const node = document.elementFromPoint(params.point.x, params.point.y)
  const entry = node instanceof Element ? node.closest('.history-entry-expanded') : null
  return {
    className: node instanceof Element ? node.className || '' : '',
    hitInsideExpanded: !!entry,
    text: entry?.textContent || '',
    visualText: expandedEntry?.textContent || '',
  }
}

export function hitTestExpandedEntryWithPointerEvents(params: { label: string, point: { x: number, y: number } }) {
  const expandedEntry = Array.from(document.querySelectorAll('.history-entry-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  if (!(expandedEntry instanceof HTMLElement)) return { className: '', hitInsideExpanded: false, text: '' }
  const previousPointerEvents = expandedEntry.style.pointerEvents
  expandedEntry.style.pointerEvents = 'auto'
  const node = document.elementFromPoint(params.point.x, params.point.y)
  const entry = node instanceof Element ? node.closest('.history-entry-expanded') : null
  expandedEntry.style.pointerEvents = previousPointerEvents
  return {
    className: node instanceof Element ? node.className || '' : '',
    hitInsideExpanded: !!entry,
    text: entry?.textContent || '',
  }
}

export function readHistoryWheelState() {
  return {
    dashboardScrollTop: document.querySelector('.scroll-region')?.scrollTop ?? 0,
    historyScrollTop: document.querySelector('.history-entry-list')?.scrollTop ?? 0,
    expansionCount: document.querySelectorAll('.history-entry-expanded').length,
    tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length,
  }
}

export function readExpansionCounts() {
  return {
    expansionCount: document.querySelectorAll('.history-entry-expanded').length,
    tooltipCount: document.querySelectorAll('[data-slot="tooltip-content"]').length,
  }
}

export function readHistoryLeftGutterTarget() {
  const shellRect = document.querySelector('[data-tabout="dashboard-shell"]')?.getBoundingClientRect()
  const panelRect = document.querySelector('.tab-history-panel')?.getBoundingClientRect()
  const listRect = document.querySelector('.history-entry-list')?.getBoundingClientRect()
  const contentRect = document.querySelector('.history-entry-list-content')?.getBoundingClientRect()
  const hitAreaRect = document.querySelector('[data-tabout-part="history-scroll-hit-area"]')?.getBoundingClientRect()
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
    viewportWidth: window.innerWidth,
  }
}

export function readNarrowViewportSnapshot() {
  const round = (value: number) => Math.round(value * 100) / 100
  const shell = document.querySelector('[data-tabout="dashboard-shell"]')
  const main = document.querySelector('.dashboard-main')
  const scrollRegion = document.querySelector('.scroll-region')
  const historyList = document.querySelector('.history-entry-list')
  const historyContent = document.querySelector('.history-entry-list-content')
  const historyScrollbar = document.querySelector('.history-entry-scrollbar')
  const historyTrack = document.querySelector('.history-entry-scrollbar-track')
  const historyThumb = document.querySelector('.history-entry-scrollbar-thumb')
  const filter = document.querySelector('[data-tabout="filter-query"]')
  const sourceSwitch = document.querySelector('[data-tabout="dashboard-view"]')
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
    !shell ||
    !historyTrack ||
    !historyThumb ||
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
  const shellNumber = (property: string) => Number.parseFloat(shellStyles.getPropertyValue(property)) || 0
  const historyThumbBorderLeft = Number.parseFloat(historyThumbStyles.borderLeftWidth) || 0
  const historyThumbBorderRight = Number.parseFloat(historyThumbStyles.borderRightWidth) || 0
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
    historyThumbCursor: historyThumbStyles.cursor,
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
    pageGutter: shellNumber('--dashboard-page-gutter'),
    scrollbarSize: shellNumber('--dashboard-scrollbar-size'),
    scrollbarPadding: shellNumber('--dashboard-scrollbar-padding'),
    scrollbarThumbSize: shellNumber('--dashboard-scrollbar-thumb-size'),
    scrollbarPaddingHover: shellNumber('--dashboard-scrollbar-padding-hover'),
    scrollbarThumbSizeHover: shellNumber('--dashboard-scrollbar-thumb-size-hover'),
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
    documentScrollLeft: document.scrollingElement?.scrollLeft || 0,
  }
}
