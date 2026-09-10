// Page functions for same-title URL variant and duplicate-stack smoke
// measurements. Each runs in the page realm through evaluateInPage, so only
// page globals and the params argument are in scope.

export type SmokeTabHook =
  | '__tabOutSmokeAddCompactTitleVariantTabs'
  | '__tabOutSmokeAddPlainTitleVariantTabs'
  | '__tabOutSmokeAddWrappedTitleVariantTabs'
  | '__tabOutSmokeAddDuplicateStackTabs'
  | '__tabOutSmokeAddPathGroupPlaceholderTabs'

export function injectSmokeTabs(params: { hook: SmokeTabHook }): unknown {
  const hooks = window as unknown as Record<SmokeTabHook, (() => unknown) | undefined>
  return hooks[params.hook]?.()
}

type Point = { x: number, y: number }

export function findCompactVariantChipTarget() {
  const describe = (chipRect: DOMRect, titleRect: DOMRect, labelRects: DOMRect[]) => {
    const contentRight = Math.max(titleRect.right, ...labelRects.map((rect) => rect.right)) + 20
    return {
      x: Math.round(titleRect.left + Math.min(24, titleRect.width / 2)),
      y: Math.round(titleRect.top + Math.min(titleRect.height / 2, 10)),
      chipWidth: Math.round(chipRect.width),
      contentWidth: Math.round(contentRight - chipRect.left),
      titleWidth: Math.round(titleRect.width),
      labelWidths: labelRects.map((rect) => Math.round(rect.width)),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => (
          candidate.textContent?.includes('Order Page') &&
          candidate.textContent?.includes('productId=1060') &&
          candidate.textContent?.includes('productId=9707')
        ))
      const chipRect = chip?.getBoundingClientRect()
      const titleRow = chip?.querySelector('.chip-title-row')
      const titleRect = titleRow?.getBoundingClientRect()
      const labelRects = Array.from(chip?.querySelectorAll('.chip-title-variant-label') || []).map((label) => label.getBoundingClientRect())
      if (chip instanceof HTMLElement && chipRect && (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)) {
        chip.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(poll, 120)
        return
      }
      const usable = chip instanceof HTMLElement && titleRow instanceof HTMLElement && chipRect && titleRect &&
        labelRects.length === 2 &&
        labelRects.every((rect) => rect.width > 40 && rect.height > 8)
      if (usable) {
        resolve(describe(chipRect, titleRect, labelRects))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readExpandedVariantLabels(params: { label: string }) {
  const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  return Array.from(chip?.querySelectorAll('.chip-title-variant-label') || []).map((label) => {
    const rect = label.getBoundingClientRect()
    return {
      text: label.textContent || '',
      clientWidth: Math.round((label.clientWidth || 0) * 100) / 100,
      scrollWidth: Math.round((label.scrollWidth || 0) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
    }
  })
}

type PlainVariantSurfaces = {
  slotOnlyDefaultSurface?: Point
  labelRightEdge: Point
  leftGutter: Point
  titleRightEdge: Point
}

type PlainVariantTarget = {
  x: number
  y: number
  chipLeft: number
  chipRight: number
  chipWidth: number
  labelClientWidths: number[]
  labelScrollWidths: number[]
  overflowingLabels: number
  viewportRight: number
  surfaces: PlainVariantSurfaces
}

type PlainVariantMissing = {
  missing: true
  innerHeight: number
  chips: Array<{
    rect: { top: number, bottom: number, width: number }
    variantLabels: Array<{ text: string | null, clientWidth: number, scrollWidth: number, height: number }>
  }>
  surfaces?: undefined
}

export function findPlainVariantChipTarget(): Promise<PlainVariantTarget | PlainVariantMissing> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      // The long opaque tail (page=...&sourceType=...#comment-...) renders as a
      // bounded stable fingerprint, so only the readable semantic query value
      // is a durable text anchor for this variant row.
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => (
          candidate.textContent?.includes('Plain Title Variant') &&
          candidate.textContent?.includes('focusedCommentId=667321')
        ))
      const chipRect = chip?.getBoundingClientRect()
      const variantLabels = Array.from(chip?.querySelectorAll('.chip-title-variant-label') || [])
      const labelRects = variantLabels.map((label) => label.getBoundingClientRect())
      const overflowingLabels = variantLabels.filter((label) => label.scrollWidth - label.clientWidth > 1).length
      if (chip instanceof HTMLElement && chipRect && (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)) {
        chip.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(poll, 120)
        return
      }
      const targetLabelRect = labelRects[0]
      const usable = chip instanceof HTMLElement && chipRect && targetLabelRect &&
        labelRects.length === 2 &&
        labelRects.every((rect) => rect.width > 0 && rect.height > 8) &&
        overflowingLabels > 0
      if (usable) {
        // Serialized by source text: the slot probe has to live inside.
        const slotOnlyPoint = (() => {
          const slot = chip.closest('[data-tabout-part="slot"]')
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
            { x: chipRect.right - 2, y: chipRect.bottom - 2 },
          ]
          return points.find((point) => {
            if (point.x < slotRect.left || point.x > slotRect.right || point.y < slotRect.top || point.y > slotRect.bottom) return false
            const hit = document.elementFromPoint(point.x, point.y)
            return hit instanceof Element && slot.contains(hit) && !chip.contains(hit)
          }) || null
        })()
        const titleRect = chip.querySelector('.chip-title-row')?.getBoundingClientRect()
        const titleCenterY = Math.round((titleRect?.top || chipRect.top) + (titleRect?.height || chipRect.height) / 2)
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
            ...(slotOnlyPoint
              ? { slotOnlyDefaultSurface: { x: Math.round(slotOnlyPoint.x), y: Math.round(slotOnlyPoint.y) } }
              : {}),
            labelRightEdge: {
              x: Math.round(chipRect.right - 4),
              y: Math.round(targetLabelRect.top + targetLabelRect.height / 2),
            },
            leftGutter: { x: Math.round(chipRect.left + 4), y: titleCenterY },
            titleRightEdge: { x: Math.round(chipRect.right - 4), y: titleCenterY },
          },
        })
      } else if (Date.now() - start > 5000) {
        resolve({
          chips: Array.from(document.querySelectorAll('.page-chip'))
            .filter((candidate) => candidate.textContent?.includes('Plain Title Variant'))
            .map((candidate) => {
              const rect = candidate.getBoundingClientRect()
              return {
                rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) },
                variantLabels: Array.from(candidate.querySelectorAll('.chip-title-variant-label')).map((label) => ({
                  text: label.textContent,
                  clientWidth: label.clientWidth,
                  scrollWidth: label.scrollWidth,
                  height: Math.round(label.getBoundingClientRect().height),
                })),
              }
            }),
          innerHeight: window.innerHeight,
          missing: true,
        })
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readPlainVariantHoverState(params: { point: Point }) {
  const slot = Array.from(document.querySelectorAll('[data-tabout-part="slot"]'))
    .find((candidate) => candidate.textContent?.includes('Plain Title Variant'))
  const chip = slot?.querySelector('.page-chip')
  const defaultVariant = slot?.querySelector('.chip-title-variant[data-tabout-default-variant]')
  const hit = document.elementFromPoint(params.point.x, params.point.y)
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
    slotHovered: !!(slot instanceof HTMLElement && slot.matches(':hover')),
  }
}

export function findWrappedVariantChipTarget() {
  const describe = (chipRect: DOMRect, titleRow: HTMLElement, titleRect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(titleRow).lineHeight) || 16.25
    return {
      x: Math.round(titleRect.left + Math.min(24, titleRect.width / 2)),
      y: Math.round(titleRect.top + Math.min(titleRect.height / 2, 10)),
      chipWidth: Math.round(chipRect.width),
      titleText: titleRow.textContent || '',
      titleWidth: Math.round(titleRect.width),
      titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
      markerCount: titleRow.querySelectorAll('.chip-title-suppression-marker').length,
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => (
          candidate.textContent?.includes('Example Store') &&
          candidate.textContent?.includes('?example=alpha')
        ))
      const chipRect = chip?.getBoundingClientRect()
      const titleRow = chip?.querySelector('.chip-title-row')
      const titleRect = titleRow?.getBoundingClientRect()
      if (chip instanceof HTMLElement && chipRect && (chipRect.top < 24 || chipRect.bottom > window.innerHeight - 24)) {
        chip.scrollIntoView({ block: 'center', inline: 'nearest' })
        setTimeout(poll, 120)
        return
      }
      if (chip instanceof HTMLElement && titleRow instanceof HTMLElement && chipRect && titleRect && titleRect.width > 120 && titleRect.height > 8) {
        resolve(describe(chipRect, titleRow, titleRect))
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function waitForWrappedVariantExpansion(params: { label: string }) {
  const describe = (chipRect: DOMRect, titleRow: HTMLElement, titleRect: DOMRect) => {
    const lineHeight = Number.parseFloat(window.getComputedStyle(titleRow).lineHeight) || 16.25
    return {
      width: Math.round(chipRect.width),
      titleText: titleRow.textContent || '',
      titleLineCount: Math.max(1, Math.round(titleRect.height / lineHeight)),
      titleLineTexts: Array.from(titleRow.querySelectorAll('.page-chip-expanded-line')).map((line) => line.textContent || ''),
    }
  }
  return new Promise<ReturnType<typeof describe> | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip-expanded'))
        .find((candidate) => candidate.textContent?.includes(params.label))
      const titleRow = chip?.querySelector('.chip-title-row')
      const chipRect = chip?.getBoundingClientRect()
      const titleRect = titleRow?.getBoundingClientRect()
      if (chip instanceof HTMLElement && titleRow instanceof HTMLElement && chipRect && titleRect && chipRect.width > 0 && chipRect.height > 0) {
        resolve(describe(chipRect, titleRow, titleRect))
      } else if (Date.now() - start > 2000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

type StackRect = { left: number, top: number, width: number, height: number }

export function measureDuplicateStackGeometry() {
  return new Promise<{ chip: StackRect, frame: StackRect, layers: StackRect[], className: string } | null>((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes('Duplicate Stack Target'))
      const frame = chip?.querySelector('.chip-favicon-stack')
      const layers = Array.from(frame?.querySelectorAll('.chip-favicon-stack-layer') || [])
      if (chip instanceof HTMLElement && frame instanceof HTMLElement && layers.length >= 2) {
        const rectFor = (element: Element): StackRect => {
          const rect = element.getBoundingClientRect()
          return {
            left: Math.round(rect.left * 100) / 100,
            top: Math.round(rect.top * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          }
        }
        resolve({
          chip: rectFor(chip),
          frame: rectFor(frame),
          layers: layers.map(rectFor),
          className: frame.className,
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
