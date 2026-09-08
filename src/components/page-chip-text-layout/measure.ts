import {
  cssPixelValue,
  visibleChipTextLineCount,
} from './policy.js'
import {
  PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX,
  PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX,
  DEFAULT_CHIP_SLOT_SIZE,
} from './types.js'
import type { ChipSlotSize, ChipTextFadeMetrics } from './types.js'

function isChipTextTruncated(textEl: HTMLElement | null) {
  if (!textEl) return false
  return (
    textEl.scrollHeight - textEl.clientHeight > 1 ||
    textEl.scrollWidth - textEl.clientWidth > 1
  )
}

export function getChipTextWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().width * 100) / 100
}

export function getChipTextPaintedContentWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return 0

  const textRect = textEl.getBoundingClientRect()
  if (textRect.width <= 0) return 0

  const range = ownerDocument.createRange()
  const walker = ownerDocument.createTreeWalker(
    textEl,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent?.trim()
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      },
    },
  )
  let maxRight = 0

  function includeRect(rect: DOMRect) {
    if (rect.width <= 0 && rect.height <= 0) return
    maxRight = Math.max(maxRight, rect.right - textRect.left)
  }

  try {
    while (true) {
      const node = walker.nextNode()
      if (!(node instanceof win.Text)) break
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) includeRect(rect)
    }
  } finally {
    range.detach()
  }

  for (const marker of textEl.querySelectorAll<HTMLElement>('.chip-title-suppression-marker, .chip-strip-indicator')) {
    includeRect(marker.getBoundingClientRect())
  }

  return Math.round(Math.max(0, maxRight) * 100) / 100
}

export function getChipTextExpansionBaselineWidth(textEl: HTMLElement | null) {
  const boxWidth = getChipTextWidth(textEl)
  const contentWidth = getChipTextPaintedContentWidth(textEl)
  if (boxWidth <= 0 || contentWidth <= 0) return boxWidth
  return Math.round(Math.min(boxWidth, contentWidth + PAGE_CHIP_EXPANDED_WIDTH_GUARD_PX) * 100) / 100
}

function elementInlinePaddingWidth(element: HTMLElement) {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (!styles) return 0
  return cssPixelValue(styles.paddingLeft) + cssPixelValue(styles.paddingRight)
}

function elementColumnGap(element: HTMLElement) {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  return styles ? cssPixelValue(styles.columnGap) : 0
}

function visibleElementChildren(element: HTMLElement) {
  return Array.from(element.children).filter((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) return false
    const rect = child.getBoundingClientRect()
    return rect.width > 0 || child.scrollWidth > 0
  })
}

function titleVariantButtonMinimumWidth(button: HTMLElement) {
  const children = visibleElementChildren(button)
  const contentWidth = children.reduce((width, child) => {
    if (child.classList.contains('chip-title-variant-label')) {
      return width + Math.max(child.scrollWidth, child.getBoundingClientRect().width)
    }
    return width + Math.max(child.scrollWidth, child.getBoundingClientRect().width)
  }, 0)
  const gapWidth = Math.max(0, children.length - 1) * elementColumnGap(button)
  return elementInlinePaddingWidth(button) + gapWidth + contentWidth
}

export function getTitleVariantMinimumContentWidth(textEl: HTMLElement | null) {
  if (!textEl) return 0

  let width = 0
  for (const shell of textEl.querySelectorAll<HTMLElement>('.chip-title-variant-shell')) {
    const button = shell.querySelector<HTMLElement>('.chip-title-variant')
    if (!button) continue
    const list = shell.closest<HTMLElement>('.chip-title-variant-list')
    const listInlinePadding = list ? elementInlinePaddingWidth(list) : 0
    width = Math.max(
      width,
      listInlinePadding + elementInlinePaddingWidth(shell) + titleVariantButtonMinimumWidth(button),
    )
  }
  return Math.round(width * 100) / 100
}

function titleVariantLabelTruncationKey(textEl: HTMLElement | null) {
  if (!textEl) return ''
  return Array.from(
    textEl.querySelectorAll<HTMLElement>('.chip-title-variant-label'),
    (label) => label.scrollWidth - label.clientWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX ? '1' : '0',
  ).join('')
}

function titleVariantContentOverflows(textEl: HTMLElement | null) {
  const minimumWidth = getTitleVariantMinimumContentWidth(textEl)
  if (minimumWidth <= 0) return false
  const visibleWidth = getChipTextExpansionBaselineWidth(textEl)
  return minimumWidth - visibleWidth > PAGE_CHIP_EXPANDED_LINE_TOLERANCE_PX
}

export function chipTextHasExpandableContent(textEl: HTMLElement | null) {
  return isChipTextTruncated(textEl) || titleVariantLabelTruncationKey(textEl).includes('1') || titleVariantContentOverflows(textEl)
}

function getChipTextHeight(textEl: HTMLElement | null) {
  if (!textEl) return 0
  return Math.round(textEl.getBoundingClientRect().height * 100) / 100
}

export function getChipTextLineHeight(textEl: HTMLElement | null) {
  if (!textEl || typeof window === 'undefined') return 16
  const styles = window.getComputedStyle(textEl)
  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight

  const fontSize = Number.parseFloat(styles.fontSize)
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16
}

export function getVisibleChipTextLineCount(textEl: HTMLElement | null) {
  if (!textEl) return 1
  const lineHeight = getChipTextLineHeight(textEl)
  const textHeight = getChipTextHeight(textEl)
  return visibleChipTextLineCount(textHeight, lineHeight)
}

export function getExpandedPageChipHorizontalInset(chipEl: HTMLElement, textEl: HTMLElement | null) {
  if (!textEl) return 0
  const chipRect = chipEl.getBoundingClientRect()
  const textRect = textEl.getBoundingClientRect()
  return Math.max(0, textRect.left - chipRect.left) + Math.max(0, chipRect.right - textRect.right)
}

export function readChipTextFadeMetrics(
  textEl: HTMLElement,
  textRect = textEl.getBoundingClientRect(),
): ChipTextFadeMetrics {
  const isTruncated = isChipTextTruncated(textEl)
  const variantLabelTruncationKey = titleVariantLabelTruncationKey(textEl)
  const hasExpandableContent = isTruncated || variantLabelTruncationKey.includes('1') || titleVariantContentOverflows(textEl)
  return {
    hasExpandableContent,
    height: Math.round(textRect.height * 100) / 100,
    isTruncated,
    titleVariantLabelTruncationKey: variantLabelTruncationKey,
    width: Math.round(textRect.width * 100) / 100,
  }
}

export function waitsForInitialMasonryWidth(textEl: HTMLElement) {
  const card = textEl.closest<HTMLElement>('.domain-block')
  const container = textEl.closest<HTMLElement>('.missions')
  return !!card && !!container && !container.classList.contains('is-packed') && card.style.width === ''
}

export function getChipTextMasonryCardWidth(textEl: HTMLElement) {
  return textEl.closest<HTMLElement>('.domain-block')?.style.width || ''
}

export function roundedElementSize(element: HTMLElement | null): ChipSlotSize {
  if (!element) return DEFAULT_CHIP_SLOT_SIZE
  const rect = element.getBoundingClientRect()
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
  }
}
