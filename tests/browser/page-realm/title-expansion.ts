// Page functions for Title Expansion smoke measurements: marker-wrap and
// marker-only-line reflow, variant title-row stability, and the expansion
// rect readers. Each runs in the page realm through evaluateInPage, so only
// page globals and the params argument are in scope.

type TitleExpansionSmokeWindow = Window & {
  __tabOutSmokeAddMarkerWrapPathGroupTabs?: () => unknown
}

export function addMarkerWrapPathGroupTabs(): unknown {
  return (window as unknown as TitleExpansionSmokeWindow).__tabOutSmokeAddMarkerWrapPathGroupTabs?.()
}

export function findMarkerWrapChipTarget(params: { label: string, forcedTextWidth: number }) {
  const describe = (chipText: HTMLElement, rect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(chipText).lineHeight) || 16.25
    return {
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
      chipLineCount: Math.max(1, Math.round(rect.height / lineHeight)),
      suppressionPillCount: chipText.querySelectorAll('.chip-title-suppression-marker').length,
      labeledPlaceholderCount: chipText.querySelectorAll('.chip-strip-indicator[aria-label]').length,
      pillLines: Array.from(chipText.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator[aria-label]')).map((pill) => {
        const pillRect = pill.getBoundingClientRect()
        return Math.round((pillRect.top - rect.top) / lineHeight)
      }),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    let forceSettled = false
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => (
          !candidate.closest('.page-chip-expanded') &&
          !candidate.closest('[data-slot="tooltip-content"]') &&
          candidate.textContent?.includes(params.label)
        ))
      if (!(chipText instanceof HTMLElement) || chipText.closest('.page-chips-overflow')) {
        // The crowded card can tuck this path group behind an overflow whose
        // Page Chips are not mounted until it is expanded.
        const card = document.querySelector('[data-tabout="domain-card"][data-tabout-domain="contentful.com"]')
        const toggles = card?.querySelectorAll<HTMLElement>('[data-tabout-part="overflow-expander"]') ?? []
        if (toggles.length > 0) {
          toggles.forEach((toggle) => toggle.click())
          setTimeout(poll, 300)
          return
        }
      }
      if (chipText instanceof HTMLElement && !forceSettled) {
        const forcedTextWidth = params.forcedTextWidth
        chipText.style.flex = forcedTextWidth ? '0 0 ' + forcedTextWidth + 'px' : ''
        chipText.style.maxWidth = forcedTextWidth ? forcedTextWidth + 'px' : ''
        // Forced geometry changes re-run the clamped-title capture; let it
        // settle before reading line counts.
        forceSettled = true
        setTimeout(poll, 160)
        return
      }
      const rect = chipText?.getBoundingClientRect()
      if (chipText instanceof HTMLElement && rect && (rect.top < 24 || rect.bottom > window.innerHeight - 24)) {
        chipText.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(poll, 120)
        return
      }
      if (chipText instanceof HTMLElement && rect && rect.width > 80 && rect.height > 8) {
        resolve(describe(chipText, rect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readMarkerWrapExpansion(params: { label: string }) {
  const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  const textEl = chip?.querySelector('.chip-text')
  if (!(chip instanceof HTMLElement) || !(textEl instanceof HTMLElement)) return null

  // Serialized by source text: the walker helper has to live inside.
  const contentRight = (root: Element): number => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
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
  const lineContentRights = lines.map((line) => Math.round(contentRight(line) * 100) / 100)
  const viewportAllowanceRight = window.innerWidth - 12
  const textRect = textEl.getBoundingClientRect()
  const lineHeight = Number.parseFloat(window.getComputedStyle(textEl).lineHeight) || 16.25
  const pills = Array.from(textEl.querySelectorAll('.chip-title-suppression-marker, .chip-strip-indicator[aria-label]')).map((pill) => {
    const rect = pill.getBoundingClientRect()
    const lineIndex = lines.findIndex((line) => line.contains(pill))
    const line = lineIndex >= 0 ? lines[lineIndex] ?? null : null
    const startsLine = !!line && rect.left - line.getBoundingClientRect().left <= 2
    const previousLineFreeRoom = lineIndex > 0
      ? Math.round((viewportAllowanceRight - (lineContentRights[lineIndex - 1] ?? Number.NaN)) * 100) / 100
      : 0
    return {
      text: pill.textContent || '',
      width: Math.round(rect.width * 100) / 100,
      lineIndex,
      visualLine: Math.round((rect.top - textRect.top) / lineHeight),
      startsLine,
      previousLineFreeRoom,
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
    strandedPills,
  }
}

export function findMarkerOnlyLineChipTarget(params: { label: string }) {
  const describe = (chipText: HTMLElement, rect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(chipText).lineHeight) || 16.25
    const markerRect = chipText.querySelector('.chip-title-suppression-marker')?.getBoundingClientRect()
    return {
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
      chipLineCount: Math.max(1, Math.round(rect.height / lineHeight)),
      markerLine: markerRect ? Math.round((markerRect.top - rect.top) / lineHeight) : null,
      markerLeftOffset: markerRect ? Math.round(markerRect.left - rect.left) : null,
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    let forceSettled = false
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => (
          !candidate.closest('.page-chip-expanded') &&
          !candidate.closest('[data-slot="tooltip-content"]') &&
          candidate.textContent?.includes(params.label) &&
          candidate.textContent?.includes('assignee')
        ))
      if (!(chipText instanceof HTMLElement) || chipText.closest('.page-chips-overflow')) {
        const card = document.querySelector('[data-tabout="domain-card"][data-tabout-domain="atlassian.net"]')
        const toggles = card?.querySelectorAll<HTMLElement>('[data-tabout-part="overflow-expander"]') ?? []
        if (toggles.length > 0) {
          toggles.forEach((toggle) => toggle.click())
          setTimeout(poll, 300)
          return
        }
      }
      if (chipText instanceof HTMLElement && !forceSettled) {
        chipText.style.flex = '0 0 276px'
        chipText.style.maxWidth = '276px'
        forceSettled = true
        setTimeout(poll, 160)
        return
      }
      const rect = chipText?.getBoundingClientRect()
      if (chipText instanceof HTMLElement && rect && (rect.top < 24 || rect.bottom > window.innerHeight - 24)) {
        chipText.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(poll, 120)
        return
      }
      if (chipText instanceof HTMLElement && rect && rect.width > 80 && rect.height > 8) {
        resolve(describe(chipText, rect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readMarkerOnlyLineExpansion(params: { label: string }) {
  const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
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
    text: (textEl.textContent || '').slice(0, 160),
  }
}

export function probeVariantTitleRow(params: { mode: 'rest' | 'expanded', label: string }) {
  const describe = (root: HTMLElement, rect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(root).lineHeight) || 16.25
    const indicator = root.querySelector('.chip-strip-indicator')
    const indicatorRect = indicator?.getBoundingClientRect()
    // Bionic rendering splits words across text nodes, so bucket painted
    // characters into visual lines and find the anchor phrase per line.
    const lineTexts: string[] = []
    const range = document.createRange()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
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
        lineTexts[line] = (lineTexts[line] || '') + text.charAt(offset)
      }
    }
    return {
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
      titleRowLines: Math.max(1, Math.round(rect.height / lineHeight)),
      indicatorLine: indicatorRect ? Math.round((indicatorRect.top - rect.top) / lineHeight) : null,
      indicatorText: (indicator?.textContent || '').slice(0, 40),
      anchorLine: lineTexts.findIndex((text) => (text || '').includes('from my')),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    let forceSettled = params.mode === 'expanded'
    const selector = params.mode === 'rest'
      ? '.page-chip:not(.page-chip-expanded) .chip-title-row'
      : '.page-chip-expanded .chip-title-row'
    const poll = () => {
      const root = Array.from(document.querySelectorAll(selector))
        .find((candidate) => candidate.textContent?.includes(params.label))
      const chipText = root?.closest('.chip-text')
      if (root instanceof HTMLElement && chipText instanceof HTMLElement && !forceSettled) {
        chipText.style.flex = '0 0 260px'
        chipText.style.maxWidth = '260px'
        forceSettled = true
        setTimeout(poll, 160)
        return
      }
      const rect = root?.getBoundingClientRect()
      if (root instanceof HTMLElement && rect && (rect.top < 24 || rect.bottom > window.innerHeight - 24)) {
        root.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(poll, 120)
        return
      }
      if (root instanceof HTMLElement && rect && rect.width > 80 && rect.height > 8) {
        resolve(describe(root, rect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function waitForPageChipExpansionRect(params: { text: string, timeoutMs: number }) {
  const describe = (chip: HTMLElement, rect: DOMRect, chipText: Element, textRect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(chipText).lineHeight) || 16.25
    return {
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
      viewportRight: window.innerWidth,
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(params.text))
      const rect = chip?.getBoundingClientRect()
      const chipText = chip?.querySelector('.chip-text')
      const textRect = chipText?.getBoundingClientRect()
      if (chip instanceof HTMLElement && rect && chipText && textRect && rect.width > 0 && rect.height > 0) {
        resolve(describe(chip, rect, chipText, textRect))
      } else if (Date.now() - start > params.timeoutMs) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function waitForHistoryEntryExpansionRect(params: { text: string, timeoutMs: number }) {
  const describe = (entry: HTMLElement, rect: DOMRect, title: HTMLElement, titleRect: DOMRect) => {
    const styles = window.getComputedStyle(title)
    const lineHeight = Number.parseFloat(styles.lineHeight) || 16.25
    const lineNodes = Array.from(title.querySelectorAll('.history-entry-expanded-line'))
    const expandedLineTexts = lineNodes.length > 0
      ? lineNodes.map((node) => node.textContent || '')
      : [title.textContent || '']
    const expandedLineOverflows = lineNodes.map((node) => node.scrollWidth - node.clientWidth > 1)
    return {
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
      webkitLineClamp: styles.webkitLineClamp || null,
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const entry = Array.from(document.querySelectorAll('.history-entry-expanded'))
        .find((candidate) => candidate.textContent?.includes(params.text))
      const rect = entry?.getBoundingClientRect()
      const title = entry?.querySelector('.history-entry-title')
      const titleRect = title?.getBoundingClientRect()
      if (entry instanceof HTMLElement && rect && title instanceof HTMLElement && titleRect && rect.width > 0 && rect.height > 0) {
        resolve(describe(entry, rect, title, titleRect))
      } else if (Date.now() - start > params.timeoutMs) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function waitForHistoryScrollbarThumbOpacity(params: { opacity: string, timeoutMs: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const thumb = document.querySelector('.history-entry-scrollbar-thumb')
      if (thumb && window.getComputedStyle(thumb).opacity === params.opacity) {
        resolve(true)
      } else if (Date.now() - start > params.timeoutMs) {
        resolve(false)
      } else {
        requestAnimationFrame(poll)
      }
    }
    poll()
  })
}
