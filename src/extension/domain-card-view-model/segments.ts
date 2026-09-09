/* ================================================================
   Display segments — pure builders for the chip title segment
   arrays (text, path-group placeholders, and title-suppression
   pills) consumed by <PageChip>.

   Owns turning a display title into segments (stripPgLabel), the
   structural-placeholder suppression insertion, singleton pill
   inlining, break-point injection for long tokens, and reading a
   plain-text title back out of a segment array. Which parts get
   inlined or suppressed is decided by the view-model assembly and
   the title-suppression engine; nothing here looks at tabs.
   ================================================================ */

import { isBoundaryWrappedTitleSuppression, titleSuppressionKey } from './title-suppression.js'
import type { DashboardSegment } from '../types'

const TITLE_STRUCTURAL_PLACEHOLDER_SEPARATORS = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']

/**
 * injectBreakPoints(str) — insert U+200B (zero-width space) into
 * long unbreakable tokens so the browser can wrap them without us
 * setting `word-break: break-all`. ZWSP is a Unicode break
 * opportunity that renders as nothing — no hyphen, no visible glyph,
 * just an invisible break point.
 *
 * Threshold: tokens of 15+ letters/digits/underscore get a ZWSP
 * inserted every 5 chars. Below that threshold, words pass through
 * untouched so natural-length English wraps at word boundaries and
 * short words never break mid-character.
 */
/**
 * @param {string} str
 * @returns {string}
 */
export function injectBreakPoints(str: string): string {
  if (!str) return str
  return str.replace(/[A-Za-z0-9_]{15,}/g, (token) => token.replace(/(.{5})(?=.)/g, '$1\u200B'))
}

/**
 * stripPgLabel(label, pgLabel) — build the chip title as a segment
 * array where EVERY occurrence of the pill label (as an exact
 * literal, nothing absorbed on either side) is replaced in place
 * by a placeholder object. Whatever characters follow the match
 * — a "@sha" commit hash, a "/tree/main" subpath, plain text —
 * are kept verbatim; only the label itself becomes the placeholder.
 * The char BEFORE the match must be a boundary (start of string or
 * a separator) so "label" inside "prelabel" isn't falsely matched.
 *
 *   prefix:   "owner/repo PR #4706"                   → [PH, " PR #4706"]
 *   suffix:   "Pull Request #4706 · owner/repo"       → ["Pull Request #4706 · ", PH]
 *   middle:   "PR #4706 · owner/repo · GitHub"        → ["PR #4706", " · ", PH, " · GitHub"]
 *   ref tail: "Size preview · owner/repo@296a5f1"     → ["Size preview", " · ", PH, "@296a5f1"]
 *   multi:    "owner/repo · log · owner/repo · PR"    → [PH, " · log", " · ", PH, " · PR"]
 *
 * When no boundary-preceded occurrence is found, or when stripping
 * would leave only separators + placeholders (e.g. the title is just
 * the label, or label-sep-label with nothing else), the original
 * label is returned as a single-segment array.
 */
export function stripPgLabel(label: string, pgLabel: string): DashboardSegment[] {
  if (!pgLabel || !label || label === pgLabel) {
    return [label]
  }
  const seps = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']
  const EL = RegExp.escape(pgLabel)
  const SEP = `(?:${seps.map((separator) => RegExp.escape(separator)).join('|')})`
  const re = new RegExp(`(^|${SEP})(${EL})`, 'g')

  const hits: Array<{ index: number, length: number, prefixSep: string }> = []
  for (const match of label.matchAll(re)) {
    hits.push({ index: match.index, length: match[0].length, prefixSep: match[1] ?? '' })
  }
  if (hits.length === 0) return [label]

  const segments: DashboardSegment[] = []
  let cursor = 0
  for (const hit of hits) {
    const textBefore = label.slice(cursor, hit.index)
    if (textBefore) segments.push(textBefore)
    if (hit.prefixSep) segments.push(hit.prefixSep)
    segments.push({ placeholder: true, label: pgLabel })
    cursor = hit.index + hit.length
  }
  const textAfter = label.slice(cursor)
  if (textAfter) segments.push(textAfter)

  const hasText = segments.some((s) => typeof s === 'string' && s.trim())
  if (!hasText) return [label]

  return segments
}

function isStructuralPlaceholderSegment(segment: DashboardSegment): segment is { placeholder: true } {
  return typeof segment !== 'string' && 'placeholder' in segment
}

export function insertTitleSuppressionSegmentsBeforeStructuralPlaceholder(
  segments: DashboardSegment[],
  suppressedTitleParts: string[],
): DashboardSegment[] {
  if (suppressedTitleParts.length === 0) return segments

  const placeholderIndex = segments.findLastIndex(isStructuralPlaceholderSegment)
  if (placeholderIndex <= 0) return segments

  const separator = segments[placeholderIndex - 1]
  if (typeof separator !== 'string' || !TITLE_STRUCTURAL_PLACEHOLDER_SEPARATORS.includes(separator)) {
    return segments
  }

  const inserted: DashboardSegment[] = []
  const suppressionsIncludeBoundary = suppressedTitleParts.some(isBoundaryWrappedTitleSuppression)
  for (const part of suppressedTitleParts) {
    inserted.push({ titleSuppression: part }, suppressionsIncludeBoundary ? ' ' : separator)
  }

  if (suppressionsIncludeBoundary) {
    return [
      ...segments.slice(0, placeholderIndex - 1),
      ' ',
      ...inserted,
      ...segments.slice(placeholderIndex),
    ]
  }

  return [
    ...segments.slice(0, placeholderIndex),
    ...inserted,
    ...segments.slice(placeholderIndex),
  ]
}

function mergeAdjacentTextSegments(segments: DashboardSegment[]): DashboardSegment[] {
  return segments.reduce<DashboardSegment[]>((merged, segment) => {
    const previous = merged.at(-1)
    if (typeof previous === 'string' && typeof segment === 'string') {
      merged[merged.length - 1] = previous + segment
      return merged
    }
    merged.push(segment)
    return merged
  }, [])
}

function inlineSuppressionTextAfterSegments(segments: DashboardSegment[], part: string): DashboardSegment[] {
  const last = segments.at(-1)
  const needsSpace = typeof last === 'string' && last.length > 0 && !/\s$/.test(last) && !/^\s/.test(part)
  return mergeAdjacentTextSegments([...segments, `${needsSpace ? ' ' : ''}${injectBreakPoints(part)}`])
}

export function inlineSingletonSuppressionsInSegments(
  segments: DashboardSegment[],
  partsToInline: string[],
): DashboardSegment[] {
  const partKeysToInline = new Set(partsToInline.map(titleSuppressionKey))
  const inlinedKeys = new Set<string>()
  const nextSegments = segments.map((segment) => {
    if (typeof segment === 'string') return segment
    if ('titleSuppression' in segment && partKeysToInline.has(titleSuppressionKey(segment.titleSuppression))) {
      inlinedKeys.add(titleSuppressionKey(segment.titleSuppression))
      return injectBreakPoints(segment.titleSuppression)
    }
    return segment
  })

  return mergeAdjacentTextSegments(partsToInline.reduce(
    (currentSegments, part) => (
      inlinedKeys.has(titleSuppressionKey(part))
        ? currentSegments
        : inlineSuppressionTextAfterSegments(currentSegments, part)
    ),
    nextSegments,
  ))
}

export function titleTextFromSegments(segments: DashboardSegment[]): string {
  return segments.map((segment) => {
    if (typeof segment === 'string') return segment
    if ('titleSuppression' in segment) return segment.titleSuppression
    if ('placeholder' in segment) return segment.label || ''
    return ''
  }).join('').replaceAll('\u200B', '')
}
