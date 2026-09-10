// Page functions for tooltip and hover-expansion smoke measurements: chip
// hover targets, active-state changes, and suppression-marker geometry. Each
// runs in the page realm through evaluateInPage, so only page globals and the
// params argument are in scope.

type TooltipSmokeWindow = Window & {
  __tabOutSmokeSetActiveTab?: (tabId: number, windowId: number) => unknown
}

export function readVisibleTooltipTexts(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="tooltip-content"]'))
    .filter((tooltip) => {
      const rect = tooltip.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
    })
    .map((tooltip) => tooltip.textContent || '')
}

export function findTooltipFreezeTarget(params: { label: string }) {
  const describe = (rect: DOMRect) => {
    const startX = Math.round(rect.left + Math.min(24, rect.width / 2))
    return {
      startX,
      moveX: Math.round(Math.min(rect.right - 8, startX + 80)),
      textLeft: Math.round(rect.left),
      textLeftExact: Math.round(rect.left * 100) / 100,
      textRight: Math.round(rect.right),
      textTop: Math.round(rect.top),
      textTopExact: Math.round(rect.top * 100) / 100,
      y: Math.round(rect.top + rect.height / 2),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => candidate.closest('.page-chip')?.textContent?.includes(params.label))
      const rect = chipText?.getBoundingClientRect()
      if (rect && rect.width > 120 && rect.height > 8) {
        resolve(describe(rect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function findExpansionHitAreaTarget() {
  const describe = (chipRect: DOMRect, hitRect: DOMRect, textRect: DOMRect) => {
    const topGap = textRect.top - hitRect.top
    const bottomGap = hitRect.bottom - textRect.bottom
    return {
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
      textBottom: Math.round(textRect.bottom),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const hitArea = Array.from(document.querySelectorAll('.chip-text-expansion-hit-area'))
        .find((candidate) => candidate.closest('.page-chip')?.textContent?.includes('enough tooltip text'))
      const chipRect = hitArea?.closest('.page-chip')?.getBoundingClientRect()
      const hitRect = hitArea?.getBoundingClientRect()
      const textRect = hitArea?.querySelector('.chip-text-truncated')?.getBoundingClientRect()
      const usable = chipRect && hitRect && textRect &&
        chipRect.left + 2 < hitRect.left - 1 &&
        hitRect.width > 120 &&
        textRect.width > 120 &&
        hitRect.top < textRect.top &&
        hitRect.bottom > textRect.bottom
      if (usable) {
        resolve(describe(chipRect, hitRect, textRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function findInternalPointerTarget() {
  const describe = (chipRect: DOMRect, textRect: DOMRect) => ({
    x: Math.round(chipRect.left + Math.max(2, (textRect.left - chipRect.left) / 2)),
    y: Math.round(textRect.top + Math.min(textRect.height / 2, 10)),
    chipLeft: Math.round(chipRect.left),
    chipRight: Math.round(chipRect.right),
    textLeft: Math.round(textRect.left),
    textTopExact: Math.round(textRect.top * 100) / 100,
  })
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes('enough tooltip text'))
      const chipRect = chip?.getBoundingClientRect()
      const textRect = chip?.querySelector('.chip-text-truncated')?.getBoundingClientRect()
      const usable = chip instanceof HTMLElement && chipRect && textRect &&
        chipRect.left + 2 < textRect.left - 1 &&
        textRect.width > 120 &&
        textRect.height > 8
      if (usable) {
        resolve(describe(chipRect, textRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function dispatchChipPointerMove(params: { label: string, x: number, y: number }): void {
  const chip = Array.from(document.querySelectorAll('.page-chip'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  chip?.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true,
    clientX: params.x,
    clientY: params.y,
    pointerId: 1,
    pointerType: 'mouse',
  }))
}

export function setActiveTab(params: { tabId: number, windowId: number }): unknown {
  return (window as unknown as TooltipSmokeWindow).__tabOutSmokeSetActiveTab?.(params.tabId, params.windowId)
}

export function findActiveStateTarget() {
  const describe = (chip: Element, rect: DOMRect) => ({
    activeFrame: !!chip.querySelector('.active-chip-frame'),
    currentActive: chip.classList.contains('current-active-chip'),
    x: Math.round(rect.left + Math.min(24, rect.width / 2)),
    y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
    textLeftExact: Math.round(rect.left * 100) / 100,
    textTopExact: Math.round(rect.top * 100) / 100,
  })
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes('Example 2 with enough tooltip text'))
      const rect = chip?.querySelector('.chip-text-truncated')?.getBoundingClientRect()
      if (chip && rect && rect.width > 120 && rect.height > 8) {
        resolve(describe(chip, rect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function findSuppressionMarkerChipTarget(params: { label: string }): Promise<{ x: number, y: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => (
          !candidate.closest('[data-slot="tooltip-content"]') &&
          candidate.textContent?.includes(params.label)
        ))
      const rect = chipText?.getBoundingClientRect()
      if (rect && rect.width > 120 && rect.height > 8) {
        resolve({
          x: Math.round(rect.left + Math.min(24, rect.width / 2)),
          y: Math.round(rect.top + Math.min(rect.height / 2, 10)),
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

export function readSuppressionMarkerExpansionLine(params: { label: string }) {
  const expandedChip = Array.from(document.querySelectorAll('.page-chip-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
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
    label: params.label,
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
    markerTop: Math.round(markerRect.top),
  }
}

export function measureSuppressionMarkerRestingLine(params: { label: string }) {
  const describe = (chipText: Element, marker: Element, textRect: DOMRect, markerRect: DOMRect, glyphRect: DOMRect) => {
    const textStyles = window.getComputedStyle(chipText)
    const markerStyles = window.getComputedStyle(marker)
    const lineHeight = Number.parseFloat(textStyles.lineHeight) || 16.25
    const markerLine = Math.round((markerRect.top - textRect.top) / lineHeight) + 1
    const lineTop = textRect.top + (markerLine - 1) * lineHeight
    const markerCenter = markerRect.top + markerRect.height / 2
    const glyphCenter = glyphRect.top + glyphRect.height / 2
    const lineCenter = lineTop + lineHeight / 2
    return {
      label: params.label,
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
      markerTop: Math.round(markerRect.top),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => (
          !candidate.closest('[data-slot="tooltip-content"]') &&
          candidate.textContent?.includes(params.label)
        ))
      const marker = chipText?.querySelector('.chip-title-suppression-marker')
      const glyph = marker?.querySelector('.chip-title-suppression-glyph')
      const textRect = chipText?.getBoundingClientRect()
      const markerRect = marker?.getBoundingClientRect()
      const glyphRect = glyph?.getBoundingClientRect()
      if (chipText && marker && glyph && textRect && markerRect && glyphRect && textRect.width > 120 && textRect.height > 8) {
        resolve(describe(chipText, marker, textRect, markerRect, glyphRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function findSuppressionTokenTarget(params: { prefix: string }): Promise<{ x: number, y: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const token = Array.from(document.querySelectorAll('.title-suppression-token'))
        .find((el) => (el.textContent || '').trim().startsWith(params.prefix))
      if (token instanceof HTMLElement) {
        token.scrollIntoView({ block: 'center' })
        const rect = token.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          resolve({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })
          return
        }
      }
      if (Date.now() - start > 5000) resolve(null)
      else setTimeout(poll, 50)
    }
    poll()
  })
}

export function countSuppressionHighlightedChips(): number {
  return document.querySelectorAll('.page-chip-suppression-highlighted').length
}

export function readSuppressionHighlightMenuState() {
  const menu = document.querySelector('[data-slot="context-menu-content"]')
  return {
    highlightedChips: document.querySelectorAll('.page-chip-suppression-highlighted').length,
    menuOpen: !!menu && menu.getClientRects().length > 0,
    itemTexts: Array.from(document.querySelectorAll('[data-slot="context-menu-item"]')).map((item) => (item.textContent || '').trim()),
  }
}

export function readSuppressionHighlightAfterClickAway() {
  return {
    menuOpen: !!document.querySelector('[data-slot="context-menu-content"]'),
    highlightedChips: document.querySelectorAll('.page-chip-suppression-highlighted').length,
    activeIsToken: !!(document.activeElement && document.activeElement.classList.contains('title-suppression-token')),
  }
}

export function findPageChipHoverPoint(params: { label: string }): Promise<{ x: number, y: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chipText = Array.from(document.querySelectorAll('.page-chip .chip-text'))
        .find((candidate) => candidate.closest('.page-chip')?.textContent?.includes(params.label))
      const rect = chipText?.getBoundingClientRect()
      if (rect && rect.width > 120 && rect.height > 8) {
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
