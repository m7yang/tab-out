import type { ReactNode } from 'react'

export type InlineTextRenderer = (text: string, keyPrefix: string, textOffset: number) => ReactNode

type TextRange = { start: number, end: number }

const BIONIC_TITLE_WORD_PATTERN = /(?:\p{Script=Latin}|\p{N})(?:[\p{Script=Latin}\p{M}\p{N}\u200B]|['’](?=[\p{Script=Latin}\p{N}]))*/gu
const JIRA_TICKET_REFERENCE_PATTERN = /\b[A-Z][A-Z0-9_]+-\d+\b/g
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i
const HOSTLIKE_TITLE_HOST_PATTERN = /^(?:localhost|(?:[\w-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+))$/i
const NUMERIC_TITLE_WORD_PATTERN = /^\p{N}+$/u
const ASCII_TITLE_WORD_PATTERN = /^[\u0000-\u007F]+$/
const ASCII_NUMERIC_TITLE_WORD_PATTERN = /^\d+$/
const BIONIC_TITLE_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const BIONIC_TITLE_FIXATION_CACHE_LIMIT = 512
const bionicTitleFixationCache = new Map<string, readonly TextRange[]>()

function cleanDisplayText(text: string) {
  return text.replaceAll('\u200B', '').trim()
}

export function isUrlLikeTitle(text: string) {
  const value = cleanDisplayText(text)
  if (!value || /\s/.test(value)) return false
  if (URL_SCHEME_PATTERN.test(value)) return true
  const parsed = URL.parse(`https://${value}`)
  return parsed !== null && HOSTLIKE_TITLE_HOST_PATTERN.test(parsed.hostname)
}

function findJiraTicketReferenceRanges(text: string): TextRange[] {
  const units = text.split('')
    .map((char, index) => ({ char, index }))
    .filter(({ char }) => char !== '\u200B')
  const normalizedText = units.map(({ char }) => char).join('')
  return [...normalizedText.matchAll(JIRA_TICKET_REFERENCE_PATTERN)].map((match) => {
    const start = match.index ?? 0
    const end = start + match[0].length
    return {
      start: units[start]?.index ?? 0,
      end: units[end]?.index ?? text.length,
    }
  })
}

function overlapsTextRange(start: number, end: number, ranges: readonly TextRange[]) {
  return ranges.some((range) => start < range.end && end > range.start)
}

function bionicTitleFixationEnd(word: string): number {
  if (ASCII_TITLE_WORD_PATTERN.test(word)) {
    if (ASCII_NUMERIC_TITLE_WORD_PATTERN.test(word)) return 0
    return word.length <= 3 ? 1 : Math.ceil(word.length / 2)
  }
  if (NUMERIC_TITLE_WORD_PATTERN.test(word.replaceAll('\u200B', ''))) return 0

  const visibleSegmentEnds = [...BIONIC_TITLE_GRAPHEME_SEGMENTER.segment(word)]
    .filter(({ segment }) => segment !== '\u200B')
    .map(({ segment, index }) => index + segment.length)
  const fixationLength = visibleSegmentEnds.length <= 3
    ? 1
    : Math.ceil(visibleSegmentEnds.length / 2)
  return visibleSegmentEnds[fixationLength - 1] ?? 0
}

function computeBionicTitleFixationRanges(text: string): readonly TextRange[] {
  if (!text || isUrlLikeTitle(text)) return []

  const protectedRanges = findJiraTicketReferenceRanges(text)
  return [...text.matchAll(BIONIC_TITLE_WORD_PATTERN)].flatMap((match) => {
    const word = match[0]
    const start = match.index ?? 0
    if (overlapsTextRange(start, start + word.length, protectedRanges)) return []

    const fixationEnd = bionicTitleFixationEnd(word)
    return fixationEnd <= 0 ? [] : [{ start, end: start + fixationEnd }]
  })
}

function findBionicTitleFixationRanges(text: string): readonly TextRange[] {
  const cached = bionicTitleFixationCache.get(text)
  if (cached) return cached

  const fixationRanges = computeBionicTitleFixationRanges(text)
  if (bionicTitleFixationCache.size >= BIONIC_TITLE_FIXATION_CACHE_LIMIT) {
    const oldestTitle = bionicTitleFixationCache.keys().next().value
    if (oldestTitle !== undefined) bionicTitleFixationCache.delete(oldestTitle)
  }
  bionicTitleFixationCache.set(text, fixationRanges)
  return fixationRanges
}

function bionicTitleTextNodes(
  text: string,
  keyPrefix: string,
  textOffset: number,
  fixationRanges: readonly TextRange[],
): ReactNode {
  if (!text) return text

  // Clamp each fixation range to this fragment; ranges arrive ascending and
  // non-overlapping, so the previous kept range ends where the next gap starts.
  const fragmentEnd = textOffset + text.length
  const localRanges = fixationRanges
    .map((range) => ({
      start: Math.max(range.start, textOffset),
      localStart: Math.max(range.start, textOffset) - textOffset,
      localEnd: Math.min(range.end, fragmentEnd) - textOffset,
    }))
    .filter(({ localStart, localEnd }) => localStart < localEnd)

  const fixationNodes = localRanges.flatMap(({ start, localStart, localEnd }, rangeIndex) => {
    const gapStart = localRanges[rangeIndex - 1]?.localEnd ?? 0
    const gap = localStart > gapStart ? [text.slice(gapStart, localStart)] : []
    return [
      ...gap,
      <span key={`${keyPrefix}:${start}:fixation`} className="chip-title-fixation font-semibold">
        {text.slice(localStart, localEnd)}
      </span>,
    ]
  })

  const tailStart = localRanges.at(-1)?.localEnd ?? 0
  const nodes = tailStart < text.length ? [...fixationNodes, text.slice(tailStart)] : fixationNodes
  return nodes.length > 0 ? nodes : text
}

export function createBionicTitleTextRenderer(titleText: string): InlineTextRenderer {
  const fixationRanges = findBionicTitleFixationRanges(titleText)
  return (text, keyPrefix, textOffset) => bionicTitleTextNodes(text, keyPrefix, textOffset, fixationRanges)
}
