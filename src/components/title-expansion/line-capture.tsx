import type { ReactNode } from 'react'

/* ================================================================
   Line capture and clamp/fade — Title Expansion internals. Rendered
   title text is measured with DOM Range APIs, each visual line is
   captured as an HTML string, and captured lines re-render as React
   nodes; the truncation fade anchors to the last visible line.

   Surfaces consume these through the module interface (index.ts).
   The per-surface capture engines in PageChip.tsx and
   TabHistoryPanel.tsx still differ in marker handling and caches;
   converge them here only when a change proves the bodies are
   genuinely the same.
   ================================================================ */

/** Last painted (non-empty) client rect of a Range — where its text visually ends. */
export function paintedRangeRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  return rects.at(-1) ?? null
}

export function expansionLineHtmlEquals(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

/** Serialize a cloned line fragment to HTML via a detached wrapper element. */
export function fragmentHtml(document: Document, fragment: DocumentFragment) {
  const container = document.createElement('span')
  container.append(fragment)
  return container.innerHTML
}

/**
 * expandedLineContentOverflows(line, tolerancePx) — true when a captured
 * expansion line paints wider than its box: scroll overflow, or any text
 * rect ending past the line's right edge by more than the surface's
 * tolerance (chips and history rows calibrate that differently).
 */
export function expandedLineContentOverflows(line: HTMLElement, tolerancePx: number) {
  if (line.scrollWidth - line.clientWidth > tolerancePx) return true

  const lineRect = line.getBoundingClientRect()
  const win = line.ownerDocument.defaultView
  if (!win || lineRect.width <= 0) return false

  const walker = line.ownerDocument.createTreeWalker(
    line,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      },
    },
  )
  const range = line.ownerDocument.createRange()

  try {
    while (true) {
      const node = walker.nextNode()
      if (!(node instanceof win.Text)) break
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        if (
          rect.width > 0 &&
          rect.right - lineRect.right > tolerancePx
        ) {
          return true
        }
      }
    }
  } finally {
    range.detach()
  }

  return false
}

/**
 * The truncation fade masks anchor their horizontal ramp to this custom
 * property instead of the element's right edge: line breaking (hyphenation,
 * unbreakable tokens) can end the last visible line well short of the box,
 * where an edge-anchored gradient fades nothing and the text hard-stops.
 */
const TITLE_FADE_END_PROPERTY = '--title-fade-end'

/** Fade ramp length — keep in sync with --title-fade-mask in base.css. */
const TITLE_FADE_RAMP_PX = 60
const TITLE_LINE_TOP_TOLERANCE_PX = 2
const TITLE_CLIP_BOTTOM_TOLERANCE_PX = 1

export type TitleLineFragmentRect = {
  top: number
  right: number
  width: number
  height: number
}

export type TitleFadeBox = {
  left: number
  top: number
  width: number
  clipHeight: number
}

/**
 * truncatedTitleFadeEndPx(fragments, box) — where the clamped title's last
 * visible line ends, in px from the element's left edge, clamped so at least
 * one fade ramp of text stays solid and the anchor never passes the box edge.
 * Fragments are inline client rects; lines below the clip height are the
 * overflow the mask hides, so they never anchor the fade.
 */
export function truncatedTitleFadeEndPx(
  fragments: readonly TitleLineFragmentRect[],
  box: TitleFadeBox,
): number | null {
  const clipBottom = box.top + box.clipHeight - TITLE_CLIP_BOTTOM_TOLERANCE_PX
  let lastLineTop = Number.NEGATIVE_INFINITY
  let lastLineRight = Number.NEGATIVE_INFINITY

  for (const fragment of fragments) {
    if (fragment.width <= 0 || fragment.height <= 0 || fragment.top >= clipBottom) continue
    if (fragment.top > lastLineTop + TITLE_LINE_TOP_TOLERANCE_PX) {
      lastLineTop = fragment.top
      lastLineRight = fragment.right
    } else if (fragment.top >= lastLineTop - TITLE_LINE_TOP_TOLERANCE_PX) {
      lastLineTop = Math.max(lastLineTop, fragment.top)
      lastLineRight = Math.max(lastLineRight, fragment.right)
    }
  }

  if (lastLineRight === Number.NEGATIVE_INFINITY) return null
  const fadeEnd = Math.min(Math.max(lastLineRight - box.left, TITLE_FADE_RAMP_PX), box.width)
  return Math.round(fadeEnd * 100) / 100
}

/**
 * syncTruncatedTitleFadeEnd(titleEl, isTruncated) — measure the rendered
 * title and pin the fade anchor on the element; clears the override (falling
 * back to the box edge) when the title isn't truncated or can't be measured.
 */
export function syncTruncatedTitleFadeEnd(titleEl: HTMLElement, isTruncated: boolean) {
  if (!isTruncated) {
    titleEl.style.removeProperty(TITLE_FADE_END_PROPERTY)
    return
  }

  const rect = titleEl.getBoundingClientRect()
  const range = titleEl.ownerDocument.createRange()
  range.selectNodeContents(titleEl)
  const fadeEnd = truncatedTitleFadeEndPx(Array.from(range.getClientRects()), {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    clipHeight: titleEl.clientHeight,
  })
  range.detach()

  if (fadeEnd === null) {
    titleEl.style.removeProperty(TITLE_FADE_END_PROPERTY)
    return
  }
  titleEl.style.setProperty(TITLE_FADE_END_PROPERTY, `${fadeEnd}px`)
}

/**
 * Captured clamped lines deliberately run their tail beyond the title box so
 * the fade always lands on glyphs. The box width is already part of the clamp
 * snapshot, so restore that final fade endpoint without another DOM read.
 */
export function syncClampedTitleFadeEnd(titleEl: HTMLElement, width: number) {
  if (width <= 0) return
  titleEl.style.setProperty(TITLE_FADE_END_PROPERTY, `${width}px`)
}

/** Find the first painting text node on a line; each surface owns its bounds and offsets. */
export function findFirstTextNodeOnLine(
  textNodes: readonly Text[],
  targetLineIndex: number,
  getTextLineBounds: (node: Text) => { first: number, last: number } | null,
): Text | null {
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

  // Preserve the previous engine's correctness with a cached linear fallback
  // if no monotonic candidate survived at all.
  if (candidateIndex < 0) {
    candidateIndex = textNodes.findIndex((node) => {
      const bounds = getTextLineBounds(node)
      return !!bounds && bounds.first <= targetLineIndex && bounds.last >= targetLineIndex
    })
  }
  if (candidateIndex < 0) return null

  return textNodes[candidateIndex] ?? null
}

type CapturedLineDomPosition = {
  node: Text
  offset: number
}

export type TitleLineCaptureGeometry = {
  elementRect: Pick<DOMRect, 'height' | 'top'>
  lineHeight: number
}

function capturedRawLineIndexForRect(
  rect: DOMRect,
  elementRect: TitleLineCaptureGeometry['elementRect'],
  lineHeight: number,
) {
  if (rect.width <= 0 && rect.height <= 0) return null
  return Math.max(0, Math.round((rect.top - elementRect.top) / lineHeight))
}

function firstCapturedTextOffsetOnLine(
  node: Text,
  targetLineIndex: number,
  range: Range,
  elementRect: TitleLineCaptureGeometry['elementRect'],
  lineHeight: number,
) {
  // The first visible line almost always begins at the first non-whitespace
  // character in its first painting text node. Prove that cheap candidate with
  // one glyph read; unusual inline/visibility cases fall through to the exact
  // prefix search used for later lines.
  if (targetLineIndex === 0) {
    const firstTextOffset = node.data.search(/\S/)
    if (firstTextOffset >= 0) {
      range.setStart(node, firstTextOffset)
      range.setEnd(node, firstTextOffset + 1)
      const rect = paintedRangeRect(range)
      if (rect && capturedRawLineIndexForRect(rect, elementRect, lineHeight) === 0) {
        return firstTextOffset
      }
    }
  }

  let low = 0
  let high = node.length - 1

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    range.setStart(node, 0)
    range.setEnd(node, middle + 1)
    const rect = paintedRangeRect(range)
    const lineIndex = rect
      ? capturedRawLineIndexForRect(rect, elementRect, lineHeight)
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
  return rect && capturedRawLineIndexForRect(rect, elementRect, lineHeight) === targetLineIndex
    ? low
    : null
}

/**
 * unwrapClampedTitleLines(root) — strip resting-state presentation wrappers
 * from a cloned fragment before serializing it. Clamped line blocks must not
 * leak into captured line HTML, where they would stop the expansion's tail
 * from wrapping. The keyed content root only exists to make clamp replacement
 * one subtree operation, so it should not become part of future captures.
 */
export function unwrapClampedTitleLines(root: ParentNode) {
  for (const line of root.querySelectorAll('.clamped-title-line, .captured-title-content-root')) {
    line.replaceWith(...line.childNodes)
  }
}

/**
 * captureVisibleLineHtml(el, visibleLineCount) — serialize what line breaking
 * put on each visible line of a clamped title: one HTML string per line, where
 * the LAST entry runs from its line start through the end of the content
 * (including anything clipped below the clamp). Finds the text node spanning
 * each line from one cached Range read per node, then binary-searches only that
 * node's text offsets. It only suits text-flow titles (text nodes plus inline
 * span/mark wrappers); surfaces with element markers keep their own engines.
 * A caller that just measured the same resting layout may pass that geometry
 * so line capture does not repeat the element rect and computed-style reads.
 */
export function captureVisibleLineHtml(
  el: HTMLElement,
  visibleLineCount: number,
  geometry?: TitleLineCaptureGeometry,
): string[] {
  if (visibleLineCount <= 1) return []

  const ownerDocument = el.ownerDocument
  const win = ownerDocument.defaultView
  if (!win) return []

  const elRect = geometry?.elementRect ?? el.getBoundingClientRect()
  const lineHeight = geometry?.lineHeight ??
    Number.parseFloat(win.getComputedStyle(el).lineHeight)
  if (elRect.height <= 0 || !lineHeight || !Number.isFinite(lineHeight)) return []

  const walker = ownerDocument.createTreeWalker(
    el,
    win.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.textContent
          ? win.NodeFilter.FILTER_ACCEPT
          : win.NodeFilter.FILTER_REJECT
      },
    },
  )
  const textNodes: Text[] = []
  while (true) {
    const node = walker.nextNode()
    if (!(node instanceof win.Text)) break
    if (node.data.trim()) textNodes.push(node)
  }

  const range = ownerDocument.createRange()
  const textLineBounds = new Map<Text, { first: number, last: number } | null>()
  function getTextLineBounds(node: Text) {
    return textLineBounds.getOrInsertComputed(node, () => {
      range.selectNodeContents(node)
      let first = Number.POSITIVE_INFINITY
      let last = Number.NEGATIVE_INFINITY
      for (const rect of range.getClientRects()) {
        const lineIndex = capturedRawLineIndexForRect(rect, elRect, lineHeight)
        if (lineIndex === null) continue
        first = Math.min(first, lineIndex)
        last = Math.max(last, lineIndex)
      }
      return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null
    })
  }

  function textPositionForLine(targetLineIndex: number): CapturedLineDomPosition | null {
    const node = findFirstTextNodeOnLine(textNodes, targetLineIndex, getTextLineBounds)
    if (!node) return null
    const offset = firstCapturedTextOffsetOnLine(node, targetLineIndex, range, elRect, lineHeight)
    return offset === null ? null : { node, offset }
  }

  const lineStarts: CapturedLineDomPosition[] = []
  for (let lineIndex = 0; lineIndex < visibleLineCount; lineIndex += 1) {
    const position = textPositionForLine(lineIndex)
    if (position) lineStarts.push(position)
  }
  range.detach()
  if (lineStarts.length <= 1) return []

  const lines: string[] = []
  for (let index = 0; index < lineStarts.length; index += 1) {
    const lineRange = ownerDocument.createRange()
    const start = lineStarts[index]
    if (!start) continue
    lineRange.setStart(start.node, start.offset)
    const next = lineStarts[index + 1]
    if (next) {
      lineRange.setEnd(next.node, next.offset)
    } else {
      lineRange.selectNodeContents(el)
      lineRange.setStart(start.node, start.offset)
    }
    const lineContents = lineRange.cloneContents()
    unwrapClampedTitleLines(lineContents)
    lines.push(fragmentHtml(ownerDocument, lineContents))
    lineRange.detach()
  }

  return lines
}

/**
 * Clamped-title rows rendered from captured lines. Each row is a no-wrap
 * block holding exactly one captured line, so earlier lines can never
 * re-wrap; the last row carries the remainder of the title and overflows
 * the clamp box horizontally. That overflow is the point: the truncation
 * fade mask always lands on glyphs instead of the gap line breaking would
 * have left, and the element keeps scroll overflow so truncation detection
 * stays true while this presentation is active.
 */
const CLAMPED_TITLE_LINE_CLASS_NAME = 'clamped-title-line block whitespace-nowrap'

/**
 * Rebuild hook for captured elements that must come back to life as real
 * React nodes instead of serialized markup — e.g. suppression-marker pills,
 * whose SVG glyph and context-driven tone classes a static rebuild would
 * freeze or drop. Return undefined to fall through to the static rebuild.
 */
export type CapturedElementRebuilder = (element: Element, key: string) => ReactNode | undefined

export function clampedTitleLineNodes(lineHtml: readonly string[], keyPrefix: string, rebuildElement?: CapturedElementRebuilder): ReactNode {
  return lineHtml.map((html, index) => (
    <span key={`${keyPrefix}-${index}:${html}`} className={CLAMPED_TITLE_LINE_CLASS_NAME}>
      {expansionLineNodesFromHtml(html, `${keyPrefix}-clamped-${index}`, rebuildElement)}
    </span>
  ))
}

export type ExpansionLineClasses = {
  wrapper: string
  line: string
  constrainedLine: string
  tailLine: string
}

const EXPANSION_LINE_NODE_CACHE_LIMIT = 240
const expansionLineNodeCache = new Map<string, ReactNode>()

function trimExpansionLineNodeCache() {
  if (expansionLineNodeCache.size <= EXPANSION_LINE_NODE_CACHE_LIMIT) return
  const oldestKey = expansionLineNodeCache.keys().next().value
  if (oldestKey) expansionLineNodeCache.delete(oldestKey)
}

/**
 * expansionLineMarkup(lineHtml, classes, viewportConstrained) — serialize
 * captured lines for the expanded overlay and its measure clone: earlier
 * lines hold their captured break (or wrap, when viewport-constrained),
 * the tail line carries the remainder and always wraps.
 */
export function expansionLineMarkup(lineHtml: readonly string[], classes: ExpansionLineClasses, viewportConstrained = false): string {
  const lastIndex = lineHtml.length - 1
  return `<span class="${classes.wrapper}">${lineHtml.map((html, index) => (
    `<span class="${index === lastIndex ? classes.tailLine : viewportConstrained ? classes.constrainedLine : classes.line}">${html}</span>`
  )).join('')}</span>`
}

/**
 * expansionLineNodesFromHtml(html, keyPrefix) — rebuild a captured line's
 * HTML as React nodes, preserving only the span/mark structure (classes and
 * aria-labels) the engines themselves serialized.
 */
export function expansionLineNodesFromHtml(html: string, keyPrefix: string, rebuildElement?: CapturedElementRebuilder): ReactNode {
  if (!html || typeof document === 'undefined') return html

  // Inert captured lines are immutable. React may render a new clamp twice
  // before committing it, so reuse the first safe rebuild instead of parsing
  // the same detached template again. Live marker rebuilders remain uncached.
  const cacheKey = rebuildElement ? '' : `${keyPrefix}\0${html}`
  function rebuildNodes(): ReactNode {
    const template = document.createElement('template')
    template.innerHTML = html

    function nodeFromDom(node: ChildNode, key: string): ReactNode {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
      if (node.nodeType !== Node.ELEMENT_NODE) return null

      const element = node as Element
      const rebuilt = rebuildElement?.(element, key)
      if (rebuilt !== undefined) return rebuilt
      const children = Array.from(element.childNodes).map((child, index) => nodeFromDom(child, `${key}-${index}`))
      const className = element.getAttribute('class') || undefined
      const ariaLabel = element.getAttribute('aria-label') || undefined

      if (element.tagName.toLowerCase() === 'span') {
        return <span key={key} className={className} aria-label={ariaLabel}>{children}</span>
      }
      if (element.tagName.toLowerCase() === 'mark') {
        return <mark key={key} className={className} aria-label={ariaLabel}>{children}</mark>
      }
      return element.textContent || ''
    }

    return Array.from(template.content.childNodes).map((node, index) => nodeFromDom(node, `${keyPrefix}-${index}`))
  }

  if (!cacheKey) return rebuildNodes()
  const nodes = expansionLineNodeCache.getOrInsertComputed(cacheKey, rebuildNodes)
  trimExpansionLineNodeCache()
  return nodes
}
