import { paintedRangeRect } from '../title-expansion'
import { getChipTextLineHeight } from './measure.js'
import {
  chipExpansionLineIndexForRect,
  chipExpansionRawLineIndexForRect,
  visibleChipTextLineCount,
} from './policy.js'
import { clampedChipFragmentHtml, expandedChipFragmentHtml, type ChipLineFragmentSerializer } from './fragments.js'
import type { ChipTextLineCaptureGeometry } from './types.js'

type ChipExpansionDomPosition =
  | {
    kind: 'text'
    node: Text
    offset: number
  }
  | {
    element: HTMLElement
    kind: 'element'
  }

function firstChipExpansionTextOffsetOnLine(
  node: Text,
  targetLineIndex: number,
  range: Range,
  textRect: DOMRect,
  lineHeight: number,
) {
  let low = 0
  let high = node.length - 1

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    range.setStart(node, 0)
    range.setEnd(node, middle + 1)
    const rect = paintedRangeRect(range)
    const lineIndex = rect
      ? chipExpansionRawLineIndexForRect(rect, textRect, lineHeight)
      : null
    if (lineIndex !== null && lineIndex >= targetLineIndex) {
      high = middle
    } else {
      low = middle + 1
    }
  }

  range.setStart(node, 0)
  range.setEnd(node, low + 1)
  const rect = paintedRangeRect(range)
  return rect && chipExpansionRawLineIndexForRect(rect, textRect, lineHeight) === targetLineIndex
    ? low
    : null
}

function chipExpansionPositionNode(position: ChipExpansionDomPosition) {
  return position.kind === 'text' ? position.node : position.element
}

function chipExpansionElementPrecedesPosition(element: HTMLElement, position: ChipExpansionDomPosition, win: Window & typeof globalThis) {
  const positionNode = chipExpansionPositionNode(position)
  return (
    element === positionNode ||
    element.contains(positionNode) ||
    !!(element.compareDocumentPosition(positionNode) & win.Node.DOCUMENT_POSITION_FOLLOWING)
  )
}

function setRangeStartAtChipExpansionPosition(range: Range, position: ChipExpansionDomPosition) {
  if (position.kind === 'text') {
    range.setStart(position.node, position.offset)
    return
  }
  range.setStartBefore(position.element)
}

function setRangeEndAtChipExpansionPosition(range: Range, position: ChipExpansionDomPosition) {
  if (position.kind === 'text') {
    range.setEnd(position.node, position.offset)
    return
  }
  range.setEndBefore(position.element)
}

export function getClampedPageChipLineHtml(
  textEl: HTMLElement | null,
  geometry?: ChipTextLineCaptureGeometry,
) {
  return getExpandedPageChipLineHtml(textEl, clampedChipFragmentHtml, geometry)
}

export function getExpandedPageChipLineHtml(
  textEl: HTMLElement | null,
  serializeFragment: ChipLineFragmentSerializer = expandedChipFragmentHtml,
  geometry?: ChipTextLineCaptureGeometry,
) {
  if (!textEl || typeof document === 'undefined') return []

  const ownerDocument = textEl.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const textRect = geometry?.textRect ?? textEl.getBoundingClientRect()
  const lineHeight = geometry?.lineHeight ?? getChipTextLineHeight(textEl)
  if (textRect.height <= 0 || lineHeight <= 0) return []
  const textHeight = Math.round(textRect.height * 100) / 100
  const visibleLineCount = visibleChipTextLineCount(textHeight, lineHeight)
  if (visibleLineCount <= 1) return []

  // A compact marker glyph can be the first painted item on a wrapped line.
  // Treat those marker elements as line-start candidates so the expanded label
  // stays on the same visible line instead of jumping back into the prior text.
  const walker = ownerDocument.createTreeWalker(
    textEl,
    win.NodeFilter.SHOW_TEXT | win.NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node instanceof win.Text) {
          return node.textContent
            ? win.NodeFilter.FILTER_ACCEPT
            : win.NodeFilter.FILTER_REJECT
        }
        if (
          node instanceof win.HTMLElement &&
          (
            node.classList.contains('chip-title-suppression-marker') ||
            node.classList.contains('chip-strip-indicator')
          )
        ) {
          return win.NodeFilter.FILTER_ACCEPT
        }
        return win.NodeFilter.FILTER_SKIP
      },
    },
  )
  const textNodes: Text[] = []
  const markerElements: HTMLElement[] = []
  while (true) {
    const node = walker.nextNode()
    if (!node) break

    if (node instanceof win.HTMLElement) {
      markerElements.push(node)
      continue
    }

    if (node instanceof win.Text && node.data.trim()) textNodes.push(node)
  }

  const range = ownerDocument.createRange()
  const textLineBounds = new Map<Text, { first: number, last: number } | null>()
  function getTextLineBounds(node: Text) {
    return textLineBounds.getOrInsertComputed(node, () => {
      range.selectNodeContents(node)
      let first = Number.POSITIVE_INFINITY
      let last = Number.NEGATIVE_INFINITY
      for (const rect of range.getClientRects()) {
        const lineIndex = chipExpansionRawLineIndexForRect(rect, textRect, lineHeight)
        if (lineIndex === null) continue
        first = Math.min(first, lineIndex)
        last = Math.max(last, lineIndex)
      }
      return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null
    })
  }

  function textPositionForLine(targetLineIndex: number): ChipExpansionDomPosition | null {
    if (textNodes.length === 0) return null

    let candidateIndex = -1
    if (targetLineIndex === 0) {
      candidateIndex = textNodes.findIndex((node) => {
        const bounds = getTextLineBounds(node)
        return !!bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex
      })
    } else {
      let low = 0
      let high = textNodes.length - 1
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        const middleNode = textNodes[middle]
        if (!middleNode) return null
        const bounds = getTextLineBounds(middleNode)
        if (bounds && bounds.last >= targetLineIndex) {
          high = middle
        } else {
          low = middle + 1
        }
      }
      const lowNode = textNodes[low]
      if (!lowNode) return null
      const bounds = getTextLineBounds(lowNode)
      if (bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex) {
        candidateIndex = low
      }
    }

    // Hidden/non-painting text can make the binary predicate sparse. Walk back
    // through that rare gap so a later valid node cannot hide an earlier line
    // start; ordinary wrapped-line searches stop after one predecessor.
    if (candidateIndex >= 0 && targetLineIndex > 0) {
      for (let index = candidateIndex - 1; index >= 0; index -= 1) {
        const candidateNode = textNodes[index]
        if (!candidateNode) continue
        const bounds = getTextLineBounds(candidateNode)
        if (!bounds) continue
        if (bounds.last < targetLineIndex) break
        if (bounds.first <= targetLineIndex) candidateIndex = index
      }
    }

    // Preserve the old engine's correctness with a cached linear fallback if
    // no monotonic candidate survived at all.
    if (candidateIndex < 0) {
      candidateIndex = textNodes.findIndex((node) => {
        const bounds = getTextLineBounds(node)
        return !!bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex
      })
    }
    if (candidateIndex < 0) return null

    const node = textNodes[candidateIndex]
    if (!node) return null
    const offset = firstChipExpansionTextOffsetOnLine(node, targetLineIndex, range, textRect, lineHeight)
    return offset === null ? null : { kind: 'text', node, offset }
  }

  const lineStartsByIndex: Array<ChipExpansionDomPosition | undefined> = Array.from({ length: visibleLineCount })
  for (let lineIndex = 0; lineIndex < visibleLineCount; lineIndex += 1) {
    lineStartsByIndex[lineIndex] = textPositionForLine(lineIndex) || undefined
  }
  for (const marker of markerElements) {
    const lineIndex = chipExpansionLineIndexForRect(marker.getBoundingClientRect(), textRect, lineHeight, visibleLineCount)
    if (lineIndex === null) continue
    const current = lineStartsByIndex[lineIndex]
    if (!current || chipExpansionElementPrecedesPosition(marker, current, win)) {
      lineStartsByIndex[lineIndex] = { element: marker, kind: 'element' }
    }
  }

  range.detach()
  const lineStarts = lineStartsByIndex.filter((position): position is ChipExpansionDomPosition => !!position)
  if (lineStarts.length <= 1) return []

  const lines: string[] = []
  for (let index = 0; index < lineStarts.length; index += 1) {
    const lineRange = ownerDocument.createRange()
    const start = lineStarts[index]
    if (!start) continue
    setRangeStartAtChipExpansionPosition(lineRange, start)
    const next = lineStarts[index + 1]
    if (next) {
      setRangeEndAtChipExpansionPosition(lineRange, next)
    } else {
      lineRange.selectNodeContents(textEl)
      setRangeStartAtChipExpansionPosition(lineRange, start)
    }
    lines.push(serializeFragment(ownerDocument, lineRange.cloneContents()))
    lineRange.detach()
  }

  return lines
}
