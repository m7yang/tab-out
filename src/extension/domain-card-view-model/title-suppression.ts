/* ================================================================
   Title suppression — the pure per-card engine behind repeated
   title-noise removal.

   Input is one seed row per display-unique tab (raw/cleaned title,
   removed domain suffix, path-group label/key); output is the
   per-URL TitlePresentation plus the card-level summary helpers.
   The pipeline: dedupe repeated removed-domain suffixes, then run
   the iterative shared-suffix suppression (card-wide 25% threshold
   and per-path-group 75% threshold, up to three passes), then merge
   adjacent suppressed parts that form one continuous span of the
   raw title, and finally order the card summary by the
   before/after relation observed across titles.

   Everything here is data-in/data-out: rendering the suppressed
   parts as segments, scoping tokens to sections, and tone
   allocation stay with the view-model assembly in
   ../domain-card-view-model.ts.
   ================================================================ */

import { compareNumericText } from '../numeric-sort.js'
import type { DashboardTitleSuppression } from '../types'

export type TitlePresentation = {
  displayTitle: string
  suppressedTitleParts: string[]
  suppressedTitlePartPositions: number[]
  suppressedTitlePartsBeforeStructuralTail: string[]
}
export type TitlePresentationSeedRow = {
  url: string
  rawTitle: string
  displayTitle: string
  removedDomainTitleSuffix: string
  pathGroupLabel: string
  pathGroupKey: string
}
type StructuralTitleTail = {
  label: string
  includeSeparatorInSuppression: boolean
}
type TitleSuppressionCandidate = {
  index: number
  text: string
  structuralTailIndex: number | null
}
type TitlePresentationRow = {
  url: string
  rawTitle: string
  displayTitle: string
  removedDomainTitleSuffix: string
  removedDomainTitleSuffixLabel: string
  suppressedTitleParts: string[]
  suppressedTitlePartPositions: number[]
  suppressedTitlePartsBeforeStructuralTail: string[]
  structuralTails: StructuralTitleTail[]
  pathGroupKey: string
}

const TITLE_SEGMENT_SEPARATORS = [' - ', ' | ', ' — ', ' · ', ' – ']
const TITLE_BOUNDARY_SEPARATOR_RE = /^[-\u2013\u2014\u00b7|:]/
const TITLE_BOUNDARY_TRAILING_SEPARATOR_RE = /[-\u2013\u2014\u00b7|:]$/

export function titleSuppressionKey(text: string): string {
  return text.trim().toLowerCase()
}

export function titleSuppressionPartPosition(title: string, part: string): number {
  const index = title.toLowerCase().indexOf(part.toLowerCase())
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export function isBoundaryWrappedTitleSuppression(part: string): boolean {
  const text = part.trim()
  return TITLE_BOUNDARY_SEPARATOR_RE.test(text) && TITLE_BOUNDARY_TRAILING_SEPARATOR_RE.test(text)
}

function titleSuppressionTailLabel(part: string): string {
  return part.trim().replace(TITLE_BOUNDARY_SEPARATOR_RE, '').trim()
}

function trailingTitleSegment(title: string): { index: number, separator: string, suffix: string } | null {
  let match: { index: number, separator: string, suffix: string } | null = null
  for (const separator of TITLE_SEGMENT_SEPARATORS) {
    const index = title.lastIndexOf(separator)
    if (index === -1 || index < (match?.index ?? -1)) continue
    match = { index, separator, suffix: title.slice(index + separator.length).trim() }
  }
  return match?.suffix ? match : null
}

function isSuppressibleTrailingTitleSegment(segment: string): boolean {
  const text = segment.trim()
  if (text.length < 4 || /[\d/#?&=]/.test(text)) return false
  const words = text.split(/\s+/).filter(Boolean)
  return words.length >= 2 || /^[A-Z]{2,}$/.test(text)
}

function isSuppressiblePathGroupTrailingTitleSegment(segment: string): boolean {
  const text = segment.trim()
  if (isSuppressibleTrailingTitleSegment(text)) return true
  if (text.length < 4 || /[\d/#?&=]/.test(text) || !/[A-Za-z]/.test(text)) return false
  return /[-_]/.test(text)
}

function isExpandableStructuralTitleSegment(segment: string): boolean {
  const text = segment.trim()
  if (text.length < 4 || /[\d/#?&=]/.test(text)) return false
  return text.split(/\s+/).filter(Boolean).length === 1
}

function matchingStructuralTrailingTitleSegment(title: string, structuralTails: StructuralTitleTail[]) {
  const tailsByKey = new Map(
    structuralTails
      .map((tail) => [tail.label.trim().toLowerCase(), tail] as const)
      .filter(([key]) => key),
  )
  if (tailsByKey.size === 0) return null
  const segment = trailingTitleSegment(title)
  if (!segment) return null
  const suffixKey = segment.suffix.trim().toLowerCase()
  const tail = tailsByKey.get(suffixKey)
  return tail ? { ...segment, includeSeparatorInSuppression: tail.includeSeparatorInSuppression } : null
}

function titleSuppressionCandidates(
  title: string,
  structuralTails: StructuralTitleTail[] = [],
  isSuppressibleSegment = isSuppressibleTrailingTitleSegment,
): TitleSuppressionCandidate[] {
  const structuralTail = matchingStructuralTrailingTitleSegment(title, structuralTails)
  const scopeTitle = structuralTail ? title.slice(0, structuralTail.index).trim() : title
  const segment = trailingTitleSegment(scopeTitle)
  if (!segment) return []

  const candidates: TitleSuppressionCandidate[] = []
  const suffix = scopeTitle.slice(segment.index + segment.separator.length).trim()
  if (isSuppressibleSegment(suffix)) {
    candidates.push({
      index: segment.index,
      text: title.slice(segment.index, structuralTail ? structuralTail.index + (structuralTail.includeSeparatorInSuppression ? structuralTail.separator.length : 0) : undefined).trim(),
      structuralTailIndex: structuralTail?.index ?? null,
    })
  }

  if (structuralTail) {
    const prefix = scopeTitle.slice(0, segment.index).trim()
    const previousSegment = trailingTitleSegment(prefix)
    if (previousSegment && isExpandableStructuralTitleSegment(previousSegment.suffix)) {
      const expandedSuffix = scopeTitle.slice(previousSegment.index + previousSegment.separator.length).trim()
      if (isSuppressibleSegment(expandedSuffix)) {
        candidates.push({
          index: previousSegment.index,
          text: title.slice(previousSegment.index, structuralTail.index + (structuralTail.includeSeparatorInSuppression ? structuralTail.separator.length : 0)).trim(),
          structuralTailIndex: structuralTail.index,
        })
      }
    }
  }

  return candidates
}

function uniqueTitleSuppressionCandidates(candidates: TitleSuppressionCandidate[]): TitleSuppressionCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.index}\u0000${candidate.structuralTailIndex ?? ''}\u0000${candidate.text.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function rowHasSuppressionSequence(parts: string[], sequence: string[]): boolean {
  for (let index = 0; index <= parts.length - sequence.length; index += 1) {
    if (sequence.every((part, offset) => parts[index + offset] === part)) return true
  }
  return false
}

function continuousSuppressionSpan(title: string, parts: string[]): string | null {
  if (parts.length < 2) return null

  const lowerTitle = title.toLowerCase()
  const firstPartText = parts[0]
  if (firstPartText === undefined) return null
  const firstPart = firstPartText.toLowerCase()
  let searchStart = 0

  while (searchStart < lowerTitle.length) {
    const startIndex = lowerTitle.indexOf(firstPart, searchStart)
    if (startIndex === -1) return null

    let cursor = startIndex + firstPartText.length
    let matched = true
    for (const part of parts.slice(1)) {
      const partIndex = lowerTitle.indexOf(part.toLowerCase(), cursor)
      if (partIndex === -1 || title.slice(cursor, partIndex).trim()) {
        matched = false
        break
      }
      cursor = partIndex + part.length
    }

    if (matched) return title.slice(startIndex, cursor).trim()
    searchStart = startIndex + 1
  }

  return null
}

function mergeContinuousSuppressedTitleParts(rows: TitlePresentationRow[]) {
  const rowIndexesByPart = new Map<string, number[]>()
  rows.forEach((row, rowIndex) => {
    for (const part of row.suppressedTitleParts) {
      const indexes = rowIndexesByPart.getOrInsertComputed(part, () => [])
      if (indexes.at(-1) !== rowIndex) indexes.push(rowIndex)
    }
  })

  const occurrenceKeyByPart = new Map<string, string>()
  for (const [part, rowIndexes] of rowIndexesByPart) {
    occurrenceKeyByPart.set(part, rowIndexes.join('\u0000'))
  }

  const mergeTextBySequence = new Map<string, string | null>()
  function mergeTextFor(sequence: string[]): string | null {
    const sequenceKey = sequence.join('\u0001')
    const firstPart = sequence[0]
    if (firstPart === undefined) return null
    return mergeTextBySequence.getOrInsertComputed(sequenceKey, () => {
      const occurrenceKey = occurrenceKeyByPart.get(firstPart)
      if (!occurrenceKey || !sequence.every((part) => occurrenceKeyByPart.get(part) === occurrenceKey)) {
        return null
      }

      const rowIndexes = rowIndexesByPart.get(firstPart) || []
      let mergedText = ''
      for (const rowIndex of rowIndexes) {
        const row = rows[rowIndex]
        if (!row || !rowHasSuppressionSequence(row.suppressedTitleParts, sequence)) return null
        const span = continuousSuppressionSpan(row.rawTitle, sequence)
        if (!span || (mergedText && span !== mergedText)) return null
        mergedText = span
      }

      return mergedText || null
    })
  }

  for (const row of rows) {
    if (row.suppressedTitleParts.length < 2) continue

    const partsBeforeStructuralTail = new Set(row.suppressedTitlePartsBeforeStructuralTail)
    const nextParts: string[] = []
    const nextPartPositions: number[] = []
    const nextPartsBeforeStructuralTail: string[] = []
    for (let index = 0; index < row.suppressedTitleParts.length;) {
      let merged: { text: string, endIndex: number } | null = null
      for (let endIndex = row.suppressedTitleParts.length; endIndex > index + 1; endIndex -= 1) {
        const sequence = row.suppressedTitleParts.slice(index, endIndex)
        const text = mergeTextFor(sequence)
        if (text) {
          merged = { text, endIndex }
          break
        }
      }

      if (merged) {
        const sequence = row.suppressedTitleParts.slice(index, merged.endIndex)
        nextParts.push(merged.text)
        nextPartPositions.push(titleSuppressionPartPosition(row.rawTitle, merged.text))
        if (sequence.every((part) => partsBeforeStructuralTail.has(part))) {
          nextPartsBeforeStructuralTail.push(merged.text)
        }
        index = merged.endIndex
        continue
      }

      const part = row.suppressedTitleParts[index]
      if (part === undefined) break
      nextParts.push(part)
      nextPartPositions.push(row.suppressedTitlePartPositions[index] ?? titleSuppressionPartPosition(row.rawTitle, part))
      if (partsBeforeStructuralTail.has(part)) nextPartsBeforeStructuralTail.push(part)
      index += 1
    }

    row.suppressedTitleParts = nextParts
    row.suppressedTitlePartPositions = nextPartPositions
    row.suppressedTitlePartsBeforeStructuralTail = nextPartsBeforeStructuralTail
  }
}

function presentationsByUrl(rows: readonly TitlePresentationRow[]): Map<string, TitlePresentation> {
  return new Map(rows.map((row) => [row.url, {
    displayTitle: row.displayTitle,
    suppressedTitleParts: row.suppressedTitleParts,
    suppressedTitlePartPositions: row.suppressedTitlePartPositions,
    suppressedTitlePartsBeforeStructuralTail: row.suppressedTitlePartsBeforeStructuralTail,
  }]))
}

export function computeTitlePresentations(
  seedRows: readonly TitlePresentationSeedRow[],
  { filtering }: { filtering: boolean },
): Map<string, TitlePresentation> {
  // Working rows are engine-local: seeds stay untouched, and every
  // pass below mutates only these copies.
  const rows: TitlePresentationRow[] = seedRows.map((seed) => ({
    url: seed.url,
    rawTitle: seed.rawTitle,
    displayTitle: seed.displayTitle,
    removedDomainTitleSuffix: seed.removedDomainTitleSuffix,
    removedDomainTitleSuffixLabel: titleSuppressionTailLabel(seed.removedDomainTitleSuffix),
    suppressedTitleParts: [],
    suppressedTitlePartPositions: [],
    suppressedTitlePartsBeforeStructuralTail: [],
    structuralTails: seed.pathGroupLabel ? [{ label: seed.pathGroupLabel, includeSeparatorInSuppression: true }] : [],
    pathGroupKey: seed.pathGroupKey,
  }))

  const removedDomainTitleSuffixCounts = new Map<string, number>()
  for (const row of rows) {
    if (!row.removedDomainTitleSuffix) continue
    removedDomainTitleSuffixCounts.set(row.removedDomainTitleSuffix, (removedDomainTitleSuffixCounts.get(row.removedDomainTitleSuffix) || 0) + 1)
  }
  for (const row of rows) {
    if (!row.removedDomainTitleSuffix) continue
    if ((removedDomainTitleSuffixCounts.get(row.removedDomainTitleSuffix) || 0) > 1) {
      row.suppressedTitleParts.push(row.removedDomainTitleSuffix)
      row.suppressedTitlePartPositions.push(titleSuppressionPartPosition(row.rawTitle, row.removedDomainTitleSuffix))
    } else {
      row.displayTitle = row.rawTitle
      if (row.removedDomainTitleSuffixLabel) {
        row.structuralTails.push({
          label: row.removedDomainTitleSuffixLabel,
          includeSeparatorInSuppression: false,
        })
      }
    }
  }

  if (filtering || rows.length < 2) {
    mergeContinuousSuppressedTitleParts(rows)
    return presentationsByUrl(rows)
  }

  const pathGroupSizes = new Map<string, number>()
  for (const row of rows) {
    if (!row.pathGroupKey) continue
    pathGroupSizes.set(row.pathGroupKey, (pathGroupSizes.get(row.pathGroupKey) || 0) + 1)
  }

  const minCount = rows.length <= 3 ? 2 : 3
  const cardCandidatesByTitle = new Map<
    string,
    Map<string, TitleSuppressionCandidate[]>
  >()
  const pathGroupCandidatesByTitle = new Map<
    string,
    Map<string, TitleSuppressionCandidate[]>
  >()
  function cachedTitleSuppressionCandidates(
    row: TitlePresentationRow,
    pathGroup: boolean,
  ): TitleSuppressionCandidate[] {
    const cache = pathGroup
      ? pathGroupCandidatesByTitle
      : cardCandidatesByTitle
    const byStructuralTail = cache.getOrInsertComputed(
      row.displayTitle,
      () => new Map(),
    )
    const structuralTailKey = row.structuralTails.map((tail) =>
      `${tail.label}\u0000${tail.includeSeparatorInSuppression ? '1' : '0'}`,
    ).join('\u0001')
    return byStructuralTail.getOrInsertComputed(structuralTailKey, () =>
      titleSuppressionCandidates(
        row.displayTitle,
        row.structuralTails,
        pathGroup ? isSuppressiblePathGroupTrailingTitleSegment : undefined,
      ).filter((candidate) =>
        row.displayTitle.slice(0, candidate.index).trim().length >= 3,
      ),
    )
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const counts = new Map<string, number>()
    const pathGroupCounts = new Map<string, Map<string, number>>()
    const candidatesByUrl = new Map<string, TitleSuppressionCandidate[]>()
    for (const row of rows) {
      const cardCandidates = cachedTitleSuppressionCandidates(row, false)
      const pathGroupCandidates = row.pathGroupKey
        ? cachedTitleSuppressionCandidates(row, true)
        : []
      const candidates = uniqueTitleSuppressionCandidates([...cardCandidates, ...pathGroupCandidates])
      candidatesByUrl.set(row.url, candidates)
      for (const candidate of cardCandidates) {
        const key = candidate.text.toLowerCase()
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      if (row.pathGroupKey) {
        const groupCounts = pathGroupCounts.getOrInsertComputed(row.pathGroupKey, () => new Map())
        for (const candidate of pathGroupCandidates) {
          const key = candidate.text.toLowerCase()
          groupCounts.set(key, (groupCounts.get(key) || 0) + 1)
        }
      }
    }

    const suffixesToSuppress = new Set(
      counts.entries()
        .filter(([, count]) => count >= minCount && count / rows.length >= 0.25)
        .map(([suffix]) => suffix),
    )
    const pathGroupSuffixesToSuppress = new Map<string, Set<string>>()
    for (const [pathGroupKey, groupCounts] of pathGroupCounts.entries()) {
      const groupSize = pathGroupSizes.get(pathGroupKey) || 0
      if (groupSize < 2) continue
      const suffixes = new Set(
        groupCounts.entries()
          .filter(([, count]) => count >= 2 && count / groupSize >= 0.75)
          .map(([suffix]) => suffix),
      )
      if (suffixes.size > 0) pathGroupSuffixesToSuppress.set(pathGroupKey, suffixes)
    }
    if (suffixesToSuppress.size === 0 && pathGroupSuffixesToSuppress.size === 0) break

    let changed = false
    for (const row of rows) {
      const pathGroupSuffixes = pathGroupSuffixesToSuppress.get(row.pathGroupKey)
      const candidate = (candidatesByUrl.get(row.url) || [])
        .filter((candidate) => {
          const key = candidate.text.toLowerCase()
          return suffixesToSuppress.has(key) || !!pathGroupSuffixes?.has(key)
        })
        .sort((a, b) => b.text.length - a.text.length)[0]
      if (!candidate) continue
      const stripped = row.displayTitle.slice(0, candidate.index).trim()
      if (stripped.length < 3) continue
      row.displayTitle = stripped + (candidate.structuralTailIndex === null ? '' : row.displayTitle.slice(candidate.structuralTailIndex))
      row.suppressedTitleParts.unshift(candidate.text)
      row.suppressedTitlePartPositions.unshift(titleSuppressionPartPosition(row.rawTitle, candidate.text))
      if (candidate.structuralTailIndex !== null) {
        row.suppressedTitlePartsBeforeStructuralTail.unshift(candidate.text)
      }
      changed = true
    }
    if (!changed) break
  }

  mergeContinuousSuppressedTitleParts(rows)
  return presentationsByUrl(rows)
}

export function summarizeTitleSuppression(presentations: Iterable<TitlePresentation>): DashboardTitleSuppression[] {
  const partsByText = new Map<string, { text: string, count: number, firstTitlePosition: number, firstPartIndex: number, firstSeen: number }>()
  const beforeByKey = new Map<string, Set<string>>()
  let firstSeen = 0
  for (const presentation of presentations) {
    const partKeys = presentation.suppressedTitleParts.map(titleSuppressionKey)
    partKeys.forEach((key, index) => {
      const laterParts = beforeByKey.getOrInsertComputed(key, () => new Set())
      for (const laterKey of partKeys.slice(index + 1)) laterParts.add(laterKey)
    })
    presentation.suppressedTitleParts.forEach((part, partIndex) => {
      const existing = partsByText.get(part)
      const titlePosition = presentation.suppressedTitlePartPositions[partIndex] ?? Number.MAX_SAFE_INTEGER
      if (existing) {
        existing.count += 1
        existing.firstTitlePosition = Math.min(existing.firstTitlePosition, titlePosition)
        existing.firstPartIndex = Math.min(existing.firstPartIndex, partIndex)
        return
      }
      partsByText.set(part, {
        text: part,
        count: 1,
        firstTitlePosition: titlePosition,
        firstPartIndex: partIndex,
        firstSeen,
      })
      firstSeen += 1
    })
  }

  const reachesCache = new Map<string, boolean>()
  function reaches(fromKey: string, toKey: string, seen = new Set<string>()): boolean {
    const cacheKey = `${fromKey}\u0000${toKey}`
    if (reachesCache.has(cacheKey)) return !!reachesCache.get(cacheKey)
    if (seen.has(fromKey)) return false
    seen.add(fromKey)
    const direct = beforeByKey.get(fromKey)
    const result = direct
      ? direct.has(toKey) || direct.values().some((nextKey) => reaches(nextKey, toKey, seen))
      : false
    reachesCache.set(cacheKey, result)
    return result
  }

  return partsByText.values().toArray()
    .filter((part) => part.count > 1)
    .sort((a, b) => {
      const aKey = titleSuppressionKey(a.text)
      const bKey = titleSuppressionKey(b.text)
      const aBeforeB = reaches(aKey, bKey)
      const bBeforeA = reaches(bKey, aKey)
      if (aBeforeB && !bBeforeA) return -1
      if (bBeforeA && !aBeforeB) return 1
      return a.firstTitlePosition - b.firstTitlePosition || a.firstPartIndex - b.firstPartIndex || b.count - a.count || a.firstSeen - b.firstSeen || compareNumericText(a.text, b.text)
    })
    .map(({ text, count }) => ({ text, count }))
}

export function aggregateSuppressedTitleParts(
  presentations: readonly TitlePresentation[],
  partOrder: ReadonlyMap<string, number>,
): string[] {
  const partsByKey = new Map<string, { text: string, order: number, firstSeen: number }>()
  let firstSeen = 0
  for (const presentation of presentations) {
    for (const part of presentation.suppressedTitleParts) {
      const key = part.toLowerCase()
      partsByKey.getOrInsertComputed(key, () => ({
        text: part,
        order: partOrder.get(key) ?? Number.MAX_SAFE_INTEGER,
        firstSeen: firstSeen++,
      }))
    }
  }

  return partsByKey.values().toArray()
    .sort((a, b) => a.order - b.order || a.firstSeen - b.firstSeen)
    .map((part) => part.text)
}
