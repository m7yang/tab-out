// Page functions for in-place Page Chip expansion smoke measurements: line
// counts, folded chips, click-return focus, original-slot leave, and popup
// clicks. Each runs in the page realm through evaluateInPage, so only page
// globals and the params argument are in scope.

export function findPageChipLineCountTarget(params: { label: string, forcedTextWidth: number, forcedMaxLines: number }) {
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
  const describe = (chipText: Element, rect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(chipText).lineHeight) || 16.25
    const chipLineCount = Math.max(1, Math.round(rect.height / lineHeight))
    return {
      x: Math.round(rect.left + Math.min(24, rect.width / 2)),
      y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
      chipText: chipText.textContent || '',
      chipLineTexts: collectLineTexts(chipText, chipLineCount, lineHeight),
      chipLeft: Math.round(rect.left),
      chipLeftExact: Math.round(rect.left * 100) / 100,
      chipTop: Math.round(rect.top),
      chipTopExact: Math.round(rect.top * 100) / 100,
      chipWidth: Math.round(rect.width),
      chipHeight: Math.round(rect.height),
      chipLineHeight: Math.round(lineHeight * 100) / 100,
      chipLineCount,
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    let forceSettled = false
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => (
          !candidate.closest('[data-slot="tooltip-content"]') &&
          candidate.textContent?.includes(params.label)
        ))
      if (params.forcedTextWidth && chipText instanceof HTMLElement) {
        chipText.style.flex = `0 0 ${params.forcedTextWidth}px`
        chipText.style.maxWidth = `${params.forcedTextWidth}px`
      }
      if (params.forcedMaxLines && chipText instanceof HTMLElement) {
        chipText.style.maxHeight = `calc(${params.forcedMaxLines}lh)`
      }
      if ((params.forcedTextWidth || params.forcedMaxLines) && !forceSettled) {
        // Forced geometry changes re-run the clamped-title capture (observer
        // -> invalidate -> re-capture); give it a couple frames to settle
        // before reading line counts.
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
      if (chipText && rect && rect.width > 80 && rect.height > 8) {
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

export function readPageChipExpansionLines(params: { label: string }) {
  const tooltip = Array.from(document.querySelectorAll('.page-chip-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  const tooltipText = tooltip?.querySelector('.chip-text')
  const tooltipRect = tooltip?.getBoundingClientRect()
  const textRect = tooltipText?.getBoundingClientRect()
  if (!(tooltip instanceof HTMLElement) || !(tooltipText instanceof HTMLElement) || !tooltipRect || !textRect) return null
  const lineHeight = Number.parseFloat(window.getComputedStyle(tooltipText).lineHeight) || 16.25
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
      },
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
    visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .filter((candidate) => {
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
    viewportRight: window.innerWidth,
  }
}

export function findFoldedChipTarget(params: { label: string, forcedTextWidth: number }) {
  const describe = (titleRow: Element, envRow: Element, chipTextRect: DOMRect, titleRect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(titleRow).lineHeight) || 16.25
    return {
      x: Math.round(chipTextRect.left + Math.min(24, chipTextRect.width / 2)),
      y: Math.round(chipTextRect.top + Math.min(titleRect.height / 2, 10)),
      titleText: titleRow.textContent || '',
      envText: envRow.textContent || '',
      titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
      titleWidth: Math.round(titleRect.width),
      chipTextWidth: Math.round(chipTextRect.width),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip-folded'))
        .find((candidate) => candidate.textContent?.includes(params.label))
      const chipText = chip?.querySelector('.chip-text')
      if (params.forcedTextWidth && chipText instanceof HTMLElement) {
        chipText.style.flex = `0 0 ${params.forcedTextWidth}px`
        chipText.style.maxWidth = `${params.forcedTextWidth}px`
      }
      const titleRow = chip?.querySelector('.chip-title-row')
      const envRow = chip?.querySelector('.chip-env-row')
      const chipTextRect = chipText?.getBoundingClientRect()
      const titleRect = titleRow?.getBoundingClientRect()
      const envRect = envRow?.getBoundingClientRect()
      if (chipText && titleRow && envRow && chipTextRect && titleRect && envRect && chipTextRect.width > 80 && chipTextRect.height > 8) {
        resolve(describe(titleRow, envRow, chipTextRect, titleRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readFoldedChipExpansion(params: { label: string }) {
  const tooltip = Array.from(document.querySelectorAll('.page-chip-expanded.page-chip-folded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  const tooltipText = tooltip?.querySelector('.chip-text')
  const titleRow = tooltip?.querySelector('.chip-title-row')
  const tooltipRect = tooltip?.getBoundingClientRect()
  const titleRect = titleRow?.getBoundingClientRect()
  if (!(tooltip instanceof HTMLElement) || !(tooltipText instanceof HTMLElement) || !(titleRow instanceof HTMLElement) || !tooltipRect || !titleRect) return null
  const lineHeight = Number.parseFloat(window.getComputedStyle(titleRow).lineHeight) || 16.25
  return {
    text: tooltip.textContent || '',
    titleText: titleRow.textContent || '',
    envCount: tooltip.querySelectorAll('.chip-env').length,
    visibleTooltipCount: Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }).length,
    titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
    titleWidth: Math.round(titleRect.width),
    textWidth: Math.round(tooltipText.getBoundingClientRect().width),
    width: Math.round(tooltipRect.width),
    right: Math.round(tooltipRect.right),
    viewportRight: window.innerWidth,
  }
}

export function findFoldedEnvButtonTarget(params: { label: string }): Promise<{ x: number, y: number, text: string } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip-folded'))
        .find((candidate) => candidate.textContent?.includes(params.label))
      const envButton = chip?.querySelector('.chip-env')
      const rect = envButton?.getBoundingClientRect()
      if (envButton && rect && rect.width > 10 && rect.height > 10) {
        resolve({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          text: envButton.textContent || '',
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

export function findClickReturnTrigger(
  params: { selector: string, requiredDescendantSelector: string, marker: string, targetLabel: string },
): Promise<{ x: number, y: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const trigger = Array.from(document.querySelectorAll(params.selector))
        .find((candidate) => {
          const hasRequiredDescendant =
            candidate.matches(params.requiredDescendantSelector) ||
            !!candidate.querySelector(params.requiredDescendantSelector)
          return candidate.textContent?.includes(params.marker) && hasRequiredDescendant
        })
      const rect = trigger?.getBoundingClientRect()
      if (trigger && rect && rect.width > 120 && rect.height > 8) {
        const focusTarget = trigger.closest('.page-chip') || trigger
        focusTarget.setAttribute('data-smoke-click-return-target', params.targetLabel)
        resolve({
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

export function refocusClickReturnTarget(params: { targetLabel: string }) {
  const trigger = document.querySelector(`[data-smoke-click-return-target="${params.targetLabel}"]`)
  if (!(trigger instanceof HTMLElement)) return null
  trigger.blur()
  window.dispatchEvent(new Event('blur'))
  trigger.focus()
  window.dispatchEvent(new Event('focus'))
  return {
    active: document.activeElement === trigger,
    focusVisible: trigger.matches(':focus-visible'),
  }
}

export function findOriginalSlotLeaveTarget(params: { label: string }) {
  const describe = (chipText: HTMLElement, rect: DOMRect, slotRect: DOMRect) => ({
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
    chipTextWidth: Math.round(rect.width),
  })
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => (
          !candidate.closest('[data-slot="tooltip-content"]') &&
          candidate.textContent?.includes(params.label)
        ))
      if (chipText instanceof HTMLElement) {
        chipText.style.flex = '0 0 130px'
        chipText.style.maxWidth = '130px'
        chipText.style.maxHeight = 'calc(1lh)'
      }
      const chip = chipText?.closest('.page-chip')
      const slot = chip?.closest('[data-tabout-part="slot"]') || chip
      const rect = chipText?.getBoundingClientRect()
      const slotRect = slot?.getBoundingClientRect()
      const usable = chipText instanceof HTMLElement && chip instanceof HTMLElement && slot instanceof HTMLElement &&
        rect && slotRect && slotRect.width > 80 && slotRect.height > 8
      if (usable) {
        resolve(describe(chipText, rect, slotRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readExpandedChipStyle(params: { label: string }) {
  const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  if (!(chip instanceof HTMLElement)) return null
  const styles = window.getComputedStyle(chip)
  return {
    cursor: styles.cursor,
    userSelect: styles.userSelect,
  }
}
