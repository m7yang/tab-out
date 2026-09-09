import type { ReactNode } from 'react'
import { matchValuesForFilterTerm, parseFilterQuery } from '../extension/filter-query.js'
import type { InlineTextRenderer } from './bionic-title-text'

const FILTER_HIGHLIGHT_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function highlightTermsForFilter(filter: string): string[] {
  const query = filter.trim()
  if (!query) return []
  return [...new Set(parseFilterQuery(query).terms.flatMap((term) => matchValuesForFilterTerm(term)))]
}

type TextRange = { start: number, end: number }

function renderedTextNodes(text: string, keyPrefix: string, textOffset: number, renderText: InlineTextRenderer): ReactNode[] {
  const rendered = renderText(text, keyPrefix, textOffset)
  return Array.isArray(rendered) ? rendered : [rendered]
}

function mergeOverlappingRanges(ranges: readonly TextRange[]): TextRange[] {
  return ranges
    .toSorted((a, b) => a.start - b.start || b.end - a.end)
    .reduce<TextRange[]>((merged, range) => {
      const previous = merged.at(-1)
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end)
        return merged
      }
      merged.push({ ...range })
      return merged
    }, [])
}

export function highlightedTextNodes(text: string, highlightTerms: readonly string[], keyPrefix: string, renderText: InlineTextRenderer = (value) => value): ReactNode {
  if (!text) return text
  if (highlightTerms.length === 0) return renderText(text, keyPrefix, 0)

  // Lowercasing can expand a grapheme into several units ('\u0130' \u2192 'i' +
  // combining dot), so every normalized unit maps back to the complete
  // original grapheme or later highlights drift and decomposed accents split.
  const units = [...FILTER_HIGHLIGHT_GRAPHEME_SEGMENTER.segment(text)]
    .filter(({ segment }) => segment !== '\u200B')
    .flatMap(({ segment, index }) => segment.toLowerCase().split('').map((unit) => ({
      unit,
      originalStart: index,
      originalEnd: index + segment.length,
    })))
  const normalizedText = units.map(({ unit }) => unit).join('')

  const normalizedRanges = highlightTerms
    .filter((term) => term !== '')
    .flatMap((term) => [...normalizedText.matchAll(new RegExp(RegExp.escape(term), 'g'))]
      .map((match) => ({ start: match.index, end: match.index + term.length })))

  if (normalizedRanges.length === 0) return renderText(text, keyPrefix, 0)

  const originalRanges = normalizedRanges.flatMap((range) => {
    const start = units[range.start]?.originalStart
    if (start === undefined) return []
    return [{ start, end: units[range.end - 1]?.originalEnd ?? text.length }]
  })
  const mergedRanges = mergeOverlappingRanges(originalRanges)

  const nodes = mergedRanges.flatMap((range, rangeIndex) => {
    const gapStart = mergedRanges[rangeIndex - 1]?.end ?? 0
    const gapNodes = range.start > gapStart
      ? renderedTextNodes(text.slice(gapStart, range.start), `${keyPrefix}:${gapStart}:${range.start}`, gapStart, renderText)
      : []
    return [
      ...gapNodes,
      <mark
        key={`${keyPrefix}-${range.start}-${range.end}`}
        className="chip-filter-match rounded-xs bg-[rgba(234,179,8,0.42)] text-foreground [font:inherit] [corner-shape:squircle] [box-decoration-break:clone]"
      >
        {renderText(text.slice(range.start, range.end), `${keyPrefix}:${range.start}:${range.end}:match`, range.start)}
      </mark>,
    ]
  })

  const tailStart = mergedRanges.at(-1)?.end ?? 0
  return tailStart < text.length
    ? [...nodes, ...renderedTextNodes(text.slice(tailStart), `${keyPrefix}:${tailStart}:tail`, tailStart, renderText)]
    : nodes
}
