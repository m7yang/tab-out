import { domainGroupCardId } from './domain-card-id.js'
import { pickFavicon, pickTabFavicon } from './favicons.js'
import { isGroupedTab, groupDotColor } from './groups.js'
import { compareNumericText } from './numeric-sort.js'
import { aggregateAudioState, mergeAudioStates } from './tab-audio.js'
import { cleanTitleWithRemovedSuffix, stripTitleNoise } from './titles.js'
import { subdomainPrefix } from './domains.js'
import { resolvePathGroup } from './path-groups.js'
import { resolveGenericWebsitePathSection, resolveWebsitePathSection } from './website-path-sections.js'
import { allocateCardSuppressionTones } from './title-suppression-tones.js'
import { tabMatchesCompiledFilter } from './filter-match.js'
import { compileFilterQuery } from './filter-query.js'
import { countClosableDuplicateExtras } from './tab-dedupe-policy.js'
import { canonicalDedupeKey } from './url-canonical.js'
import { allOpenTargetsSuspended, dashboardItemNameForTabs, isClosedSavedDashboardTab } from './dashboard-source.js'
import { pathgroupPinId, subdomainPinId, websitePathPinId } from './section-pins.js'
import { pageChipFoldRepresentativeUrl, pageChipPinId, pageChipPinKeyForFoldUrls, pageChipPinKeyForUrl, pageChipPinScopeId, pinnedPageChipOrder } from './page-chip-pins.js'
import type { PinnedPageChipIndex } from './page-chip-pins.js'
import type { CompiledFilterQuery } from './filter-query.js'
import type { DashboardCardVM, DashboardChipData, DashboardChipPriorityMap, DashboardClusterVM, DashboardSectionVM, DashboardSegment, DashboardSource, DashboardTab, DashboardTitleSuppression, DashboardWebsitePathSectionVM, DomainGroup, PathGroupResult, WebsitePathSectionResult } from './types'

type CardMode = 'matched' | 'unmatched'
type ComputeCardOptions = {
  filter?: string
  filterQuery?: CompiledFilterQuery
  mode?: CardMode
  source?: DashboardSource
  allowMutations?: boolean
  currentWindowId?: number | null
  chipOrder?: Map<string, number>
  chipPriority?: DashboardChipPriorityMap
  pinnedSections?: ReadonlySet<string>
  pinnedPageChips?: PinnedPageChipIndex
}

const EMPTY_PINNED_SECTIONS: ReadonlySet<string> = new Set<string>()

// Stable pinned-first sort: unpinned items keep their incoming order.
// Treats absent isPinned (test mocks built before this feature) as false.
function sortPinnedFirst<T extends { isPinned?: boolean }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => Number(b.isPinned === true) - Number(a.isPinned === true))
}
type PathCategory = NonNullable<PathGroupResult['category']>
type TitlePresentation = {
  displayTitle: string
  suppressedTitleParts: string[]
  suppressedTitlePartPositions: number[]
  suppressedTitlePartsBeforeStructuralTail: string[]
}
type BaseTitlePresentation = {
  displayTitle: string
  removedDomainTitleSuffix: string
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
type SectionContentVM = {
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  clusters: DashboardClusterVM[]
}
type WebsitePathSectionBucket = WebsitePathSectionResult & {
  tabs: DashboardTab[]
}
type ChipBuildEntry = {
  tab: DashboardTab
  chip: DashboardChipData
  titleKey: string
}
type TabOutDisplayBucketKind = 'current' | 'chrome-pinned' | 'chrome-grouped' | 'ordinary'
type TabOutDisplayMeta = {
  tabs: DashboardTab[]
  isCurrentTabOut: boolean
  chromePinned: boolean
  pagePinDisabled: boolean
}

const TITLE_SEGMENT_SEPARATORS = [' - ', ' | ', ' — ', ' · ', ' – ']
const TITLE_STRUCTURAL_PLACEHOLDER_SEPARATORS = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']
const TITLE_BOUNDARY_SEPARATOR_RE = /^[-\u2013\u2014\u00b7|:]/
const TITLE_BOUNDARY_TRAILING_SEPARATOR_RE = /[-\u2013\u2014\u00b7|:]$/

function dashboardChipOrderKey(sourceType: DashboardTab['sourceType'] | undefined, kind: 'url' | 'fold', value: string): string {
  const orderSource = sourceType === 'saved-page' || sourceType === 'retained-page'
    ? 'tab'
    : sourceType || 'tab'
  return `${orderSource}:${kind}:${value}`
}

function dashboardFoldChipOrderKey(sourceType: DashboardTab['sourceType'] | undefined, urls: readonly string[]): string {
  return dashboardChipOrderKey(sourceType, 'fold', pageChipFoldRepresentativeUrl(urls))
}

export function dashboardChipOrderKeyForTab(tab: Pick<DashboardTab, 'sourceType' | 'url'>): string {
  return dashboardChipOrderKey(tab.sourceType, 'url', tab.url)
}

function dashboardChipOrderAltKeyForTab(tab: Pick<DashboardTab, 'sourceType' | 'rawUrl' | 'url'>): string | null {
  return tab.rawUrl && tab.rawUrl !== tab.url ? dashboardChipOrderKey(tab.sourceType, 'url', tab.rawUrl) : null
}

export function dashboardChipOrderKeyForChip(chip: Pick<DashboardChipData, 'sourceType' | 'tabUrl' | 'envs'>): string {
  const envUrls = chip.envs?.map((env) => env.tabUrl).filter(Boolean)
  if (envUrls?.length) return dashboardFoldChipOrderKey(chip.sourceType, envUrls)
  return dashboardChipOrderKey(chip.sourceType, 'url', chip.tabUrl)
}

export function dashboardChipOrderAltKeyForChip(chip: Pick<DashboardChipData, 'sourceType' | 'rawUrl' | 'tabUrl' | 'envs'>): string | null {
  if (chip.envs?.length) return null
  return chip.rawUrl && chip.rawUrl !== chip.tabUrl ? dashboardChipOrderKey(chip.sourceType, 'url', chip.rawUrl) : null
}

function pickDashboardChipFavicon(tab: DashboardTab): string {
  if ((tab.sourceType || 'tab') === 'tab') return pickTabFavicon(tab)
  return pickFavicon(tab)
}

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
function injectBreakPoints(str: string): string {
  if (!str) return str
  return str.replace(/[A-Za-z0-9_]{15,}/g, (token) => token.replace(/(.{5})(?=.)/g, '$1\u200B'))
}

function trailingTitleSegment(title: string): { index: number; separator: string; suffix: string } | null {
  let match: { index: number; separator: string; suffix: string } | null = null
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
      .filter(([key]) => key)
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
  isSuppressibleSegment = isSuppressibleTrailingTitleSegment
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
      structuralTailIndex: structuralTail?.index ?? null
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
          structuralTailIndex: structuralTail.index
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

function isActiveInOtherWindow(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active) return false
  if (tab.isApp) return false
  if (typeof currentWindowId !== 'number') return true
  return tab.windowId !== currentWindowId
}

function isOpenTabLoading(tab: DashboardTab): boolean {
  return (tab.sourceType ?? 'tab') === 'tab' &&
    !isClosedSavedDashboardTab(tab) &&
    !tab.suspended &&
    tab.status === 'loading'
}

function isCurrentTabOutPage(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active || !tab.isTabOut || tab.isApp) return false
  if (typeof currentWindowId !== 'number') return false
  return tab.windowId === currentWindowId
}

function isActiveInCurrentWindow(tab: DashboardTab, currentWindowId: number | null): boolean {
  if (!tab.active || tab.isApp) return false
  if (typeof currentWindowId !== 'number') return false
  return tab.windowId === currentWindowId
}

function activeFrameStateForDuplicateSet(
  tabs: readonly DashboardTab[],
  currentWindowId: number | null
): { activeInOtherWindow: boolean; activeChipFrame: boolean } {
  const activeInOtherWindow = tabs.some((tab) => isActiveInOtherWindow(tab, currentWindowId))
  const activeCurrentWindowDuplicate = tabs.length > 1 && tabs.some((tab) => isActiveInCurrentWindow(tab, currentWindowId))
  const activeCurrentTabOutPage = tabs.some((tab) => isCurrentTabOutPage(tab, currentWindowId))

  return {
    activeInOtherWindow,
    activeChipFrame: activeInOtherWindow || activeCurrentWindowDuplicate || activeCurrentTabOutPage
  }
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
function stripPgLabel(label: string, pgLabel: string): DashboardSegment[] {
  if (!pgLabel || !label || label === pgLabel) {
    return [label]
  }
  const seps = [' — ', ' – ', ' - ', ' · ', ' | ', ': ', ' ']
  const EL = RegExp.escape(pgLabel)
  const SEP = `(?:${seps.map((separator) => RegExp.escape(separator)).join('|')})`
  const re = new RegExp(`(^|${SEP})(${EL})`, 'g')

  const hits: Array<{ index: number; length: number; prefixSep: string }> = []
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

function isBoundaryWrappedTitleSuppression(part: string): boolean {
  const text = part.trim()
  return TITLE_BOUNDARY_SEPARATOR_RE.test(text) && TITLE_BOUNDARY_TRAILING_SEPARATOR_RE.test(text)
}

function titleSuppressionPartPosition(title: string, part: string): number {
  const index = title.toLowerCase().indexOf(part.toLowerCase())
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

function titleSuppressionTailLabel(part: string): string {
  return part.trim().replace(TITLE_BOUNDARY_SEPARATOR_RE, '').trim()
}

function insertTitleSuppressionSegmentsBeforeStructuralPlaceholder(
  segments: DashboardSegment[],
  suppressedTitleParts: string[]
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
      ...segments.slice(placeholderIndex)
    ]
  }

  return [
    ...segments.slice(0, placeholderIndex),
    ...inserted,
    ...segments.slice(placeholderIndex)
  ]
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
    if (mergeTextBySequence.has(sequenceKey)) return mergeTextBySequence.get(sequenceKey) ?? null

    const firstPart = sequence[0]
    if (firstPart === undefined) return null
    const occurrenceKey = occurrenceKeyByPart.get(firstPart)
    if (!occurrenceKey || !sequence.every((part) => occurrenceKeyByPart.get(part) === occurrenceKey)) {
      mergeTextBySequence.set(sequenceKey, null)
      return null
    }

    const rowIndexes = rowIndexesByPart.get(firstPart) || []
    let mergedText = ''
    for (const rowIndex of rowIndexes) {
      const row = rows[rowIndex]
      if (!row) return null
      if (!rowHasSuppressionSequence(row.suppressedTitleParts, sequence)) {
        mergeTextBySequence.set(sequenceKey, null)
        return null
      }
      const span = continuousSuppressionSpan(row.rawTitle, sequence)
      if (!span || (mergedText && span !== mergedText)) {
        mergeTextBySequence.set(sequenceKey, null)
        return null
      }
      mergedText = span
    }

    mergeTextBySequence.set(sequenceKey, mergedText || null)
    return mergedText || null
  }

  for (const row of rows) {
    if (row.suppressedTitleParts.length < 2) continue

    const partsBeforeStructuralTail = new Set(row.suppressedTitlePartsBeforeStructuralTail)
    const nextParts: string[] = []
    const nextPartPositions: number[] = []
    const nextPartsBeforeStructuralTail: string[] = []
    for (let index = 0; index < row.suppressedTitleParts.length;) {
      let merged: { text: string; endIndex: number } | null = null
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

/**
 * disambiguatingPaths(urls) — given a list of URLs that share a
 * visible title, return just the *differing* tokens for each. Path
 * segments, query string, and hash are all treated as tokens in a
 * single list, so differences in any of them can disambiguate. The
 * longest common leading AND trailing tokens are stripped; only
 * what differs is shown.
 *
 *   ["/api/v1/accounts/team/dashboard",
 *    "/api/v1/accounts/me/dashboard"]      → ["…/team", "…/me"]
 *   ["/admin/dashboard", "/user/dashboard"] → ["/admin", "/user"]
 *   ["/dashboard", "/admin/dashboard"]      → ["/", "/admin"]
 *   ["/rewards?state=open",
 *    "/rewards?state=closed"]               → ["…?state=open", "…?state=closed"]
 *   ["/doc#intro", "/doc#conclusion"]       → ["…#intro", "…#conclusion"]
 */
/**
 * @param {string[]} urls
 * @returns {string[]}
 */
function disambiguatingPaths(urls: string[]): string[] {
  const tokens = urls.map((u) => {
    const parsed = URL.parse(u)
    if (!parsed) return []
    const t = parsed.pathname.split('/').filter(Boolean)
    if (parsed.search) t.push(parsed.search) // "?foo=bar"
    if (parsed.hash) t.push(parsed.hash) // "#section"
    return t
  })
  const firstTokens = tokens[0]
  if (!firstTokens) return []
  const minLen = Math.min(...tokens.map((t) => t.length))

  let commonLead = 0
  for (let i = 0; i < minLen; i++) {
    const seg = firstTokens[i]
    if (tokens.every((t) => t[i] === seg)) commonLead = i + 1
    else break
  }

  let commonTrail = 0
  const maxTrail = minLen - commonLead
  for (let i = 1; i <= maxTrail; i++) {
    const seg = firstTokens.at(-i)
    if (tokens.every((t) => t.at(-i) === seg)) commonTrail = i
    else break
  }

  return tokens.map((t) => {
    const show = t.slice(commonLead, t.length - commonTrail)
    if (show.length === 0) return '/'
    // Path segments join with '/'; query/hash attach without a slash
    // (their leading sigil '?' or '#' is already a delimiter).
    let joined = ''
    for (const seg of show) {
      if (seg.startsWith('?') || seg.startsWith('#')) joined += seg
      else joined += (joined ? '/' : '') + seg
    }
    const first = show[0] || ''
    const firstIsPath = !first.startsWith('?') && !first.startsWith('#')
    const lead = commonLead > 0 ? '…' : ''
    return lead + (firstIsPath ? '/' : '') + joined
  })
}

/* ---- Domain card view-model ----
   Builds the per-card data consumed by <DomainCard>. Filtering used
   to be done imperatively in filter.js — walk each chip's DOM,
   toggle style.display, update each section-count, recompute the
   close-domain / dedup labels from per-card state. The whole thing
   is now inside this function: pass `{ filter, mode }` and get back
   a VM whose visibleChips / sections / closableCount already reflect
   the current filter scope.

     • filter — normalized (trim + lowercase) query string ('' means
                no filter)
     • mode   — 'matched' (keep tabs that match the filter) or
                'unmatched' (keep tabs that DON'T match; used for the
                secondary "Other tabs" grid). Empty filter in
                'unmatched' yields an all-hidden card — nothing can
                not-match an empty query.

   Returned fields:
     • isHidden     — true when the card has zero chips under the
                      current filter; <Missions> skips it entirely
     • displayMode  — 'normal' | 'unmatched'; <DomainCard> applies
                      the card-unmatched class + suppresses bulk-
                      close buttons when 'unmatched'
     • filtering    — convenience flag; sections/chips use it to
                      bypass the "+N more" overflow split so every
                      matching chip is visible at once
*/
/**
 * @param {DomainGroup} group
 * @param {{ filter?: string, mode?: 'matched' | 'unmatched', allowMutations?: boolean, currentWindowId?: number | null }} [opts]
 * @returns {DashboardCardVM}
 */
export function computeDomainCardViewModel(group: DomainGroup, { filter = '', filterQuery, mode = 'matched', source = 'tabs', allowMutations = true, currentWindowId = null, chipOrder, chipPriority, pinnedSections = EMPTY_PINNED_SECTIONS, pinnedPageChips }: ComputeCardOptions = {}): DashboardCardVM {
  const compiledFilter = filterQuery ?? compileFilterQuery(filter)
  const allTabs = group.tabs || []
  const filtering = compiledFilter.active
  const displayMode = mode === 'unmatched' ? 'unmatched' : 'normal'
  const stableId = domainGroupCardId(group)
  const isAppsGroup = group.domain === '__standalone-apps__'
  const parsedUrlByValue = new Map<string, URL | null>()
  const canonicalKeyByValue = new Map<string, string>()
  const pathGroupByValue = new Map<string, PathGroupResult | null>()
  const strippedTitleByValue = new Map<string, string>()
  const subdomainPrefixByValue = new Map<string, string>()

  function parseUrl(url: string): URL | null {
    if (parsedUrlByValue.has(url)) return parsedUrlByValue.get(url) ?? null
    const parsed = URL.parse(url)
    parsedUrlByValue.set(url, parsed)
    return parsed
  }

  function strippedTitle(title: string): string {
    return strippedTitleByValue.getOrInsertComputed(title, stripTitleNoise)
  }

  function canonicalKey(url: string): string {
    return canonicalKeyByValue.getOrInsertComputed(
      url,
      () => canonicalDedupeKey(url)
    )
  }

  function subdomainForUrl(url: string): string {
    return subdomainPrefixByValue.getOrInsertComputed(url, () => {
      const parsed = parseUrl(url)
      return parsed ? subdomainPrefix(parsed.hostname, group.domain) : ''
    })
  }

  // First thing: narrow the tab set to what this grid should show.
  // Unfiltered matched mode keeps everything; unmatched mode with an
  // empty filter keeps nothing (secondary grid is hidden upstream in
  // that case anyway, but bail early so we don't produce a ghost
  // VM full of chips).
  const filterCandidates = mode === 'unmatched'
    ? isAppsGroup
      ? []
      : allTabs.filter((tab) => !isClosedSavedDashboardTab(tab))
    : filtering && isAppsGroup
      ? allTabs.filter(isClosedSavedDashboardTab)
      : allTabs
  const tabs =
    filtering
      ? filterCandidates.filter((t) => {
          const m = tabMatchesCompiledFilter(t, compiledFilter)
          return mode === 'unmatched' ? !m : m
        })
      : mode === 'unmatched'
        ? []
        : allTabs

  if (tabs.length === 0) {
    return { stableId, isHidden: true, displayMode, filtering }
  }

  const openTabs = tabs.filter((tab) => !isClosedSavedDashboardTab(tab))
  const totalOpenTabs = allTabs.filter((tab) => !isClosedSavedDashboardTab(tab))
  const closedSavedTabs = tabs.filter(isClosedSavedDashboardTab)
  const totalClosedSavedTabs = allTabs.filter(isClosedSavedDashboardTab)
  const tabCount = openTabs.length
  const totalTabCount = totalOpenTabs.length
  const closedSavedCount = closedSavedTabs.length
  const totalClosedSavedCount = totalClosedSavedTabs.length
  const itemLabel = dashboardItemNameForTabs(totalOpenTabs, 'open tab')
  const openCountLabel = filtering && tabCount !== totalTabCount && tabCount > 0 ? `${tabCount}/${totalTabCount}` : `${tabCount}`
  const savedCountText = filtering && closedSavedCount !== totalClosedSavedCount
    ? `${closedSavedCount}/${totalClosedSavedCount}`
    : `${closedSavedCount}`
  const closedOnlyCountLabel = tabCount === 0 && closedSavedCount > 0
    ? `${savedCountText} closed`
    : ''
  const savedCountLabel = closedSavedCount > 0 ? ` + ${savedCountText} closed` : ''
  const tabCountLabel = closedOnlyCountLabel || `${openCountLabel}${savedCountLabel}`
  const tabCountTitleParts = [
    filtering
      ? `${tabCount} of ${totalTabCount} ${itemLabel}${totalTabCount !== 1 ? 's' : ''} shown while filtering`
      : `${tabCount} ${itemLabel}${tabCount !== 1 ? 's' : ''}`,
    closedSavedCount > 0
      ? filtering
        ? `${closedSavedCount} of ${totalClosedSavedCount} closed page${totalClosedSavedCount !== 1 ? 's' : ''} shown while filtering`
        : `${closedSavedCount} closed page${closedSavedCount !== 1 ? 's' : ''}`
      : ''
  ].filter(Boolean)
  const tabCountTitle = tabCountTitleParts.join(', ')
  const isTabOutGroup = group.domain === '__tab-out__'

  // Tabs in a Chrome group are preserved by bulk close / dedup actions.
  const isBulkClosableTab = (tab: DashboardTab) =>
    !isClosedSavedDashboardTab(tab) &&
    !isGroupedTab(tab) &&
    !(isTabOutGroup && tab.pinned)
  const closableTabs = openTabs.filter(isBulkClosableTab)
  const closableCount = closableTabs.length
  const suspendableTabs = closableTabs.filter((t) => !t.suspended)
  const suspendableCount = suspendableTabs.length
  const closableSuspendedCount = closableTabs.filter((t) => t.suspended).length

  // Count duplicates per URL and delegate the closeability rules to the
  // shared dedupe policy so dashboard counts mirror tab mutation behavior.
  const keyOf = (t: DashboardTab) => canonicalKey(t.url)
  const tabsByUrl = Map.groupBy(openTabs, keyOf)

  function closableForUrl(u: string): number {
    return countClosableDuplicateExtras(tabsByUrl.get(u) || [], { isTabOutGroup, currentWindowId })
  }
  const closableDupeUrls = tabsByUrl.keys().filter((u) => closableForUrl(u) > 0).toArray()
  const closableExtras = closableDupeUrls.reduce((s, u) => s + closableForUrl(u), 0)

  const tabOutDisplayMeta = new WeakMap<DashboardTab, TabOutDisplayMeta>()

  function tabOutBucketForTab(tab: DashboardTab): { key: string; kind: TabOutDisplayBucketKind; rank: number; groupId: number } {
    if (isCurrentTabOutPage(tab, currentWindowId)) return { key: 'current', kind: 'current', rank: 0, groupId: -1 }
    if (tab.pinned) return { key: 'chrome-pinned', kind: 'chrome-pinned', rank: 1, groupId: -1 }
    if (isGroupedTab(tab)) return { key: `chrome-grouped:${tab.groupId}`, kind: 'chrome-grouped', rank: 2, groupId: tab.groupId }
    return { key: 'ordinary', kind: 'ordinary', rank: 3, groupId: -1 }
  }

  function tabOutDisplayTabsForUrl(urlTabs: DashboardTab[]): DashboardTab[] {
    if (urlTabs.length <= 1) {
      const tab = urlTabs[0]
      if (tab) {
        tabOutDisplayMeta.set(tab, {
          tabs: [tab],
          isCurrentTabOut: isCurrentTabOutPage(tab, currentWindowId),
          chromePinned: !!tab.pinned,
          pagePinDisabled: false
        })
      }
      return urlTabs
    }

    const buckets = new Map<string, {
      kind: TabOutDisplayBucketKind
      rank: number
      groupId: number
      firstSeen: number
      tabs: DashboardTab[]
    }>()
    urlTabs.forEach((tab, firstSeen) => {
      const bucket = tabOutBucketForTab(tab)
      buckets
        .getOrInsertComputed(bucket.key, () => ({ ...bucket, firstSeen, tabs: [] }))
        .tabs.push(tab)
    })

    return buckets.values().toArray()
      .sort((a, b) => a.rank - b.rank || a.groupId - b.groupId || a.firstSeen - b.firstSeen)
      .flatMap((bucket) => {
        const representative = bucket.tabs[0]
        if (!representative) return []
        tabOutDisplayMeta.set(representative, {
          tabs: bucket.tabs,
          isCurrentTabOut: bucket.kind === 'current',
          chromePinned: bucket.tabs.some((tab) => tab.pinned),
          pagePinDisabled: true
        })
        return [representative]
      })
  }

  // Deduplicate for display: ordinary cards show each URL once, while the
  // New tabs utility card keeps state-preserved physical Tab Out buckets visible.
  const uniqueTabs: DashboardTab[] = []
  if (isTabOutGroup) {
    const displayTabsByUrl = Map.groupBy(tabs, keyOf)
    for (const urlTabs of displayTabsByUrl.values()) {
      uniqueTabs.push(...tabOutDisplayTabsForUrl(urlTabs))
    }
  } else {
    const seen = new Set<string>()
    for (const tab of tabs) {
      const key = tab.sourceType === 'saved-page'
        ? `saved:${tab.savedPageKey || `${tab.isApp ? 'app' : 'normal-tab'}:${tab.url}`}`
        : tab.sourceType === 'retained-page'
          ? `retained:${tab.retainedPageIdentity || keyOf(tab)}`
          : `open:${keyOf(tab)}`
      if (!seen.has(key)) {
        seen.add(key)
        uniqueTabs.push(tab)
      }
    }
  }

  function baseTitlePresentation(tab: DashboardTab): BaseTitlePresentation {
    const hostname = parseUrl(tab.url)?.hostname ?? group.domain
    const cleaned = cleanTitleWithRemovedSuffix(strippedTitle(tab.title || ''), hostname, titleNoiseSuffixesForUrl(tab.url))
    return {
      displayTitle: cleaned.title,
      removedDomainTitleSuffix: cleaned.removedSuffix
    }
  }

  function titleNoiseSuffixesForUrl(url: string): string[] {
    const parsed = parseUrl(url)
    if (parsed?.hostname.endsWith('.atlassian.net') && parsed.pathname.startsWith('/wiki/')) return ['Confluence']
    return []
  }

  function structuralPathGroup(tab: DashboardTab): PathGroupResult | null {
    return pathGroupByValue.getOrInsertComputed(tab.url, () => {
      const parsed = parseUrl(tab.url)
      if (!parsed) return null
      try {
        return resolvePathGroup(parsed)
      } catch {
        return null
      }
    })
  }

  function buildTitlePresentations(): Map<string, TitlePresentation> {
    const rows: TitlePresentationRow[] = uniqueTabs.map((tab) => {
      const rawTitle = strippedTitle(tab.title || '')
      const baseTitle = baseTitlePresentation(tab)
      const pathGroup = structuralPathGroup(tab)
      return {
        url: tab.url,
        rawTitle,
        displayTitle: baseTitle.displayTitle,
        removedDomainTitleSuffix: baseTitle.removedDomainTitleSuffix,
        removedDomainTitleSuffixLabel: titleSuppressionTailLabel(baseTitle.removedDomainTitleSuffix),
        suppressedTitleParts: [] as string[],
        suppressedTitlePartPositions: [] as number[],
        suppressedTitlePartsBeforeStructuralTail: [] as string[],
        structuralTails: pathGroup?.label ? [{ label: pathGroup.label, includeSeparatorInSuppression: true }] : ([] as StructuralTitleTail[]),
        pathGroupKey: pathGroup?.key || ''
      }
    })

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
            includeSeparatorInSuppression: false
          })
        }
      }
    }

    if (filtering || rows.length < 2) {
      mergeContinuousSuppressedTitleParts(rows)
      return new Map(rows.map((row) => [row.url, {
        displayTitle: row.displayTitle,
        suppressedTitleParts: row.suppressedTitleParts,
        suppressedTitlePartPositions: row.suppressedTitlePartPositions,
        suppressedTitlePartsBeforeStructuralTail: row.suppressedTitlePartsBeforeStructuralTail
      }]))
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
      pathGroup: boolean
    ): TitleSuppressionCandidate[] {
      const cache = pathGroup
        ? pathGroupCandidatesByTitle
        : cardCandidatesByTitle
      const byStructuralTail = cache.getOrInsertComputed(
        row.displayTitle,
        () => new Map()
      )
      const structuralTailKey = row.structuralTails.map((tail) =>
        `${tail.label}\u0000${tail.includeSeparatorInSuppression ? '1' : '0'}`
      ).join('\u0001')
      return byStructuralTail.getOrInsertComputed(structuralTailKey, () =>
        titleSuppressionCandidates(
          row.displayTitle,
          row.structuralTails,
          pathGroup ? isSuppressiblePathGroupTrailingTitleSegment : undefined
        ).filter((candidate) =>
          row.displayTitle.slice(0, candidate.index).trim().length >= 3
        )
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
          .map(([suffix]) => suffix)
      )
      const pathGroupSuffixesToSuppress = new Map<string, Set<string>>()
      for (const [pathGroupKey, groupCounts] of pathGroupCounts.entries()) {
        const groupSize = pathGroupSizes.get(pathGroupKey) || 0
        if (groupSize < 2) continue
        const suffixes = new Set(
          groupCounts.entries()
            .filter(([, count]) => count >= 2 && count / groupSize >= 0.75)
            .map(([suffix]) => suffix)
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
    return new Map(rows.map((row) => [row.url, {
      displayTitle: row.displayTitle,
      suppressedTitleParts: row.suppressedTitleParts,
      suppressedTitlePartPositions: row.suppressedTitlePartPositions,
      suppressedTitlePartsBeforeStructuralTail: row.suppressedTitlePartsBeforeStructuralTail
    }]))
  }

  const titlePresentationByUrl = buildTitlePresentations()

  function titlePresentation(tab: DashboardTab): TitlePresentation {
    return titlePresentationByUrl.get(tab.url) || {
      displayTitle: strippedTitle(tab.title || ''),
      suppressedTitleParts: [],
      suppressedTitlePartPositions: [],
      suppressedTitlePartsBeforeStructuralTail: []
    }
  }

  // Build the exact title string the chip displays BEFORE path crumbs
  // and path-group placeholders. Shared by sort order and collision
  // detection so both reason over the same visible label.
  function displayTitle(tab: DashboardTab): string {
    return titlePresentation(tab).displayTitle
  }

  const lowerDisplayTitleByValue = new Map<string, string>()
  const trimmedLowerDisplayTitleByValue = new Map<string, string>()
  function lowerDisplayTitle(tab: DashboardTab, trim = false): string {
    const cache = trim
      ? trimmedLowerDisplayTitleByValue
      : lowerDisplayTitleByValue
    const title = displayTitle(tab)
    const value = trim ? title.trim() : title
    return cache.getOrInsertComputed(value, () => value.toLowerCase())
  }

  function titleSuppressionSummary() {
    const partsByText = new Map<string, { text: string; count: number; firstTitlePosition: number; firstPartIndex: number; firstSeen: number }>()
    const beforeByKey = new Map<string, Set<string>>()
    let firstSeen = 0
    for (const presentation of titlePresentationByUrl.values()) {
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
          firstSeen
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

  const suppressedTitleParts = titleSuppressionSummary()
  const suppressedTitlePartOrder = new Map(suppressedTitleParts.map((part, index) => [part.text.toLowerCase(), index]))

  function titleSuppressionKey(text: string): string {
    return text.trim().toLowerCase()
  }

  function aggregateSuppressedTitleParts(tabs: DashboardTab[]): string[] {
    const partsByKey = new Map<string, { text: string; order: number; firstSeen: number }>()
    let firstSeen = 0
    for (const tab of tabs) {
      for (const part of titlePresentation(tab).suppressedTitleParts) {
        const key = part.toLowerCase()
        partsByKey.getOrInsertComputed(key, () => ({
          text: part,
          order: suppressedTitlePartOrder.get(key) ?? Number.MAX_SAFE_INTEGER,
          firstSeen: firstSeen++
        }))
      }
    }

    return partsByKey.values().toArray()
      .sort((a, b) => a.order - b.order || a.firstSeen - b.firstSeen)
      .map((part) => part.text)
  }

  // Sort by title — the exact string the chip displays, so the visible
  // order never diverges from the sort order. `numeric: true` gives
  // natural number ordering (Dashboard 2 before Dashboard 11, PR #4488
  // before PR #4706).
  function sortLabel(tab: DashboardTab): string {
    return lowerDisplayTitle(tab)
  }
  function chipPriorityScore(tab: DashboardTab): number {
    const score = chipPriority?.get(tab.url || '') ?? chipPriority?.get(tab.rawUrl || '')
    return typeof score === 'number' && Number.isFinite(score) ? score : 0
  }

  function chipPriorityScoreForTabs(priorityTabs: readonly DashboardTab[]): number {
    return priorityTabs.reduce((max, tab) => Math.max(max, chipPriorityScore(tab)), 0)
  }

  function comparePriorityScores(aPriority: number, bPriority: number): number {
    return aPriority === bPriority ? 0 : bPriority - aPriority
  }

  function compareWithPriority(aPriority: number, bPriority: number, fallback: () => number): number {
    return comparePriorityScores(aPriority, bPriority) || fallback()
  }

  function chipOrderForKey(key: string, altKey: string | null = null): number | undefined {
    return chipOrder?.get(key) ?? (altKey ? chipOrder?.get(altKey) : undefined)
  }

  function compareWithPriorityThenRememberedChipOrder(aKey: string, bKey: string, aPriority: number, bPriority: number, fallback: () => number, aAltKey: string | null = null, bAltKey: string | null = null): number {
    const priorityDelta = comparePriorityScores(aPriority, bPriority)
    if (priorityDelta !== 0) return priorityDelta
    const aOrder = chipOrderForKey(aKey, aAltKey)
    const bOrder = chipOrderForKey(bKey, bAltKey)
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder
    if (aOrder !== undefined && bOrder === undefined) return -1
    if (aOrder === undefined && bOrder !== undefined) return 1
    return fallback()
  }
  const pagePinOrderById = new Map<string, number>()

  function annotatePageChipPin(chip: DashboardChipData, scopeId: string, chipKey: string): DashboardChipData {
    if (source !== 'tabs' || chip.iconOnly || chip.isApp || chip.pagePinDisabled) return chip
    const pinId = pageChipPinId(source, scopeId, chipKey)
    const order = pinnedPageChipOrder(pinnedPageChips, source, scopeId, chipKey)
    if (order !== null) pagePinOrderById.set(pinId, order)
    return {
      ...chip,
      pagePinId: pinId,
      pagePinned: order !== null
    }
  }

  function pagePinOrderForChip(chip: DashboardChipData): number | null {
    const directOrder = chip.pagePinId ? pagePinOrderById.get(chip.pagePinId) : undefined
    if (directOrder !== undefined) return directOrder

    let earliestVariantOrder: number | null = null
    for (const variant of chip.titleVariantChips || []) {
      const variantOrder = variant.pagePinId ? pagePinOrderById.get(variant.pagePinId) : undefined
      if (variantOrder === undefined) continue
      if (earliestVariantOrder === null || variantOrder < earliestVariantOrder) {
        earliestVariantOrder = variantOrder
      }
    }
    return earliestVariantOrder
  }

  function comparePageChipPins(a: DashboardChipData, b: DashboardChipData): number {
    const aOrder = pagePinOrderForChip(a)
    const bOrder = pagePinOrderForChip(b)
    if (aOrder !== null && bOrder !== null) return aOrder - bOrder
    if (aOrder !== null) return -1
    if (bOrder !== null) return 1
    return 0
  }

  function sortPageChipsInScope<T extends DashboardChipData>(chips: readonly T[]): T[] {
    return chips.toSorted(comparePageChipPins)
  }
  function tabOpenStateRank(tab: DashboardTab): number {
    return isClosedSavedDashboardTab(tab) ? 1 : 0
  }
  const hasRememberedChipOrder = !!chipOrder && chipOrder.size > 0
  const uniqueTabSortMeta = new Map(uniqueTabs.map((tab) => [tab, {
    priority: chipPriorityScore(tab),
    openStateRank: tabOpenStateRank(tab),
    sortLabel: sortLabel(tab),
    ...(hasRememberedChipOrder
      ? {
          orderKey: dashboardChipOrderKeyForTab(tab),
          orderAltKey: dashboardChipOrderAltKeyForTab(tab)
        }
      : {})
  }]))
  uniqueTabs.sort((a, b) => {
    const aMeta = uniqueTabSortMeta.get(a)!
    const bMeta = uniqueTabSortMeta.get(b)!
    const fallback = () => aMeta.openStateRank - bMeta.openStateRank ||
      compareNumericText(aMeta.sortLabel, bMeta.sortLabel)
    if (!hasRememberedChipOrder) {
      return compareWithPriority(aMeta.priority, bMeta.priority, fallback)
    }
    return compareWithPriorityThenRememberedChipOrder(
      aMeta.orderKey!,
      bMeta.orderKey!,
      aMeta.priority,
      bMeta.priority,
      fallback,
      aMeta.orderAltKey,
      bMeta.orderAltKey
    )
  })

  // Detect cross-subdomain shared pages — the "same page in dev2us +
  // dev11us + qaus" pattern that floods multi-env cards with near-
  // duplicates. A path (pathname + search + hash) with the same visible
  // title in 2+ named subdomains gets folded into a single chip that
  // carries an env-pill stack; those tabs are then excluded from the
  // per-subdomain sections below so they don't appear twice.
  const foldedTabUrls = new Set<string>()
  const foldGroups: DashboardTab[][] = [] // each entry shares the same path and visible title
  {
    const pageMap = new Map<string, DashboardTab[]>()
    for (const tab of uniqueTabs) {
      const parsed = parseUrl(tab.url)
      if (!parsed) continue
      const sub = subdomainForUrl(tab.url)
      if (!sub) continue // root-level tabs have no env to compare
      const pathKey = parsed.pathname + parsed.search + parsed.hash
      const titleKey = lowerDisplayTitle(tab, true)
      const pageKey = `${pathKey}\u0000${titleKey}`
      pageMap.getOrInsertComputed(pageKey, () => []).push(tab)
    }
    for (const tabs of pageMap.values()) {
      const subs = new Set<string>()
      for (const t of tabs) {
        subs.add(subdomainForUrl(t.url))
      }
      if (subs.size < 2) continue
      foldGroups.push(tabs)
      tabs.forEach((t) => foldedTabUrls.add(t.url))
    }
  }

  // Group tabs by subdomain/port within the card, EXCLUDING any tabs
  // that got folded into the shared section above. Root tabs (no
  // subdomain or lone "www") sit under an empty-string key.
  const bySubdomain = new Map<string, DashboardTab[]>()
  for (const tab of uniqueTabs) {
    if (foldedTabUrls.has(tab.url)) continue
    let key = ''
    const parsed = parseUrl(tab.url)
    if (parsed) {
      if (parsed.hostname === 'localhost' && parsed.port) {
        key = parsed.port
      } else {
        key = subdomainForUrl(tab.url)
      }
    }
    bySubdomain.getOrInsertComputed(key, () => []).push(tab)
  }

  // Sort policy: high-priority sections surface first; ties fall back to
  // root tabs (empty key) first, then alphabetically by subdomain.
  const sections = bySubdomain.entries().toArray().sort((a, b) => {
    return compareWithPriority(
      chipPriorityScoreForTabs(a[1]),
      chipPriorityScoreForTabs(b[1]),
      () => {
        if (a[0] === b[0]) return 0
        if (a[0] === '') return -1
        if (b[0] === '') return 1
        return a[0].localeCompare(b[0])
      }
    )
  })
  const multipleSections = sections.length > 1
  // Single-subdomain card: hoist the subdomain up to a pill next to
  // the card title so chips don't repeat the prefix on every row.
  // Only for non-empty keys — all-root cards don't need a pill.
  const onlySection = sections.length === 1 ? sections[0] : undefined
  const singleSubdomainKey = onlySection?.[0] || ''

  // Localhost cards use the port as the "subdomain" key (see the
  // bySubdomain loop above), so the pill / header for those should
  // render as `:3000` — prefix colon, no trailing dot — instead of
  // the FQDN-style `dev2us.` treatment. Flag it here so <DomainCard>
  // + <SubdomainSection> + the CSS pseudo-elements can branch.
  const isPortGroup = group.domain === 'localhost'
  const singleSubdomainIsPort = isPortGroup && !!singleSubdomainKey

  // Per-chip data builder. Closes over group + urlCounts so the
  // section loop below can call it without repeating context.
  // Returns the display-only fields <PageChip> needs — title,
  // favicon URL, tooltip, prefix/path/pg/dupe annotations. Phase 5
  // replaced the old renderChip HTML-string emitter with this
  // data-shape so components can render declaratively.
  function buildChipData(
    tab: DashboardTab,
    showPrefix: boolean,
    pathSuffix: string,
    pathGroupLabel: string,
    stripLabel = '',
    { iconOnly = false, rawTitle = false }: { iconOnly?: boolean; rawTitle?: boolean } = {}
  ): DashboardChipData {
    const parsed = parseUrl(tab.url)
    // rawTitle: bypass the presentation pipeline entirely (no noise strip,
    // no suppression pills) — app chips mirror the history list, which
    // shows titles exactly as Chrome reports them.
    const presentation = rawTitle
      ? {
          displayTitle: (tab.title || '').trim(),
          suppressedTitleParts: [],
          suppressedTitlePartPositions: [],
          suppressedTitlePartsBeforeStructuralTail: []
        }
      : titlePresentation(tab)
    const label = presentation.displayTitle
    let subPrefix = ''
    let portPrefix = ''
    if (parsed && showPrefix) {
      if (parsed.hostname === 'localhost' && parsed.port) portPrefix = parsed.port
      else subPrefix = subdomainForUrl(tab.url)
    }
    const leadPrefix = subPrefix || portPrefix
    const pgLabel = pathGroupLabel || ''
    const rawSegments = insertTitleSuppressionSegmentsBeforeStructuralPlaceholder(
      stripPgLabel(label, stripLabel || pgLabel),
      presentation.suppressedTitlePartsBeforeStructuralTail
    )
    // Inject zero-width spaces into long unbreakable tokens so the
    // browser can break them if layout needs to — without us setting
    // global `word-break: break-all` (which would also break SHORT
    // words awkwardly, e.g. "Highlight c / ode"). ZWSP is invisible
    // and doesn't render as a hyphen, so line-2 breaks on these long
    // tokens read as a clipped edge (the fade mask handles the
    // visual). Threshold 15 chars + every 5-char split keeps natural
    // English words (which are almost always <15 chars outside
    // "internationalization"-class outliers) intact and only tags
    // compound identifiers / usernames / hashes / slugs. Page-chip
    // tooltip rendering intentionally reuses these display segments so
    // highlighting and visual structure match the source chip.
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    const tooltip = [leadPrefix, label, pathSuffix].filter(Boolean).join(' · ')
    const grouped = isGroupedTab(tab)
    const tabOutMeta = tabOutDisplayMeta.get(tab)
    // Closed Saved and retained targets are exact, independent snapshots. A
    // canonical-equivalent live tab may share their presentation group, but it
    // must not lend them live-only state such as loading, suspension, audio, or
    // an active frame.
    const duplicateTabs = isClosedSavedDashboardTab(tab)
      ? [tab]
      : tabOutMeta?.tabs || tabsByUrl.get(keyOf(tab)) || [tab]
    const { activeInOtherWindow, activeChipFrame } = activeFrameStateForDuplicateSet(duplicateTabs, currentWindowId)
    return {
      ...(tab.id === undefined ? {} : { tabId: tab.id }),
      tabUrl: tab.url,
      rawUrl: tab.rawUrl || tab.url,
      sourceType: tab.sourceType || 'tab',
      saved: !!tab.saved,
      closedSaved: isClosedSavedDashboardTab(tab),
      suspended: allOpenTargetsSuspended(duplicateTabs),
      loading: duplicateTabs.some(isOpenTabLoading),
      ...(tab.savedPageKey === undefined ? {} : { savedPageKey: tab.savedPageKey }),
      ...(tab.retainedPageIdentity === undefined
        ? {}
        : { retainedPageIdentity: tab.retainedPageIdentity }),
      ...(tab.retainedPageClosureToken === undefined
        ? {}
        : { retainedPageClosureToken: tab.retainedPageClosureToken }),
      pagePinDisabled: !!tabOutMeta?.pagePinDisabled,
      leadPrefix,
      pathGroupLabel: pgLabel,
      title: label,
      displaySegments,
      suppressedTitleParts: presentation.suppressedTitleParts,
      pathSuffix: pathSuffix || '',
      tooltip,
      dupeCount: isClosedSavedDashboardTab(tab)
        ? 1
        : tabOutMeta?.tabs.length || tabsByUrl.get(keyOf(tab))?.length || 1,
      faviconUrl: pickDashboardChipFavicon(tab),
      actionTitle: tab.title,
      ...(tab.favIconUrl ? { actionFaviconUrl: tab.favIconUrl } : {}),
      isGrouped: grouped,
      groupDotColor: grouped ? groupDotColor(tab.groupId) : null,
      isApp: !!tab.isApp,
      activeInOtherWindow,
      activeChipFrame,
      isCurrentTabOut: tabOutMeta?.isCurrentTabOut || isCurrentTabOutPage(tab, currentWindowId),
      chromePinned: tabOutMeta?.chromePinned || (isTabOutGroup && !!tab.pinned),
      chromeGroupId: tab.groupId,
      iconOnly,
      audioState: aggregateAudioState(duplicateTabs),
      envs: null
    }
  }

  // Per-section visible limit. With multiple subdomain sections in one
  // card, a global 8 would flood the card; 5 per section keeps each
  // sub-group scannable while the card stays compact.
  const CHIPS_PER_SECTION = 5

  // "+N more" collapses hidden chips behind an expander button. But
  // when N would be 1, the button itself takes about the same vertical
  // space as rendering the one chip inline — so the collapse saves
  // nothing. Roll that last chip into the visible set instead.
  //
  // While filtering we bypass the split entirely: every chip that
  // made it through the filter is, by definition, something the user
  // is trying to see. Collapsing any of them behind "+N more" would
  // defeat the filter. (Previously filter.js forced all .page-chips-
  // overflow elements to display:contents; the VM handles it now.)
  function splitForOverflow<T>(tabs: T[]): { vis: T[]; hid: T[] } {
    if (filtering || tabs.length <= CHIPS_PER_SECTION + 1) {
      return { vis: tabs, hid: [] }
    }
    return { vis: tabs.slice(0, CHIPS_PER_SECTION), hid: tabs.slice(CHIPS_PER_SECTION) }
  }

  // Order chips within a cluster by sub-category (if the adapter
  // provided one), then by their display-label order (preserved via
  // stable sort, since the input tabs are already sorted by display
  // label above). Unknown categories fall to 'other'.
  const CATEGORY_ORDER: Record<PathCategory, number> = { pull: 0, issue: 1, commit: 2, code: 3, other: 4 }
  const categoryRank = (category?: PathGroupResult['category']) => CATEGORY_ORDER[category ?? 'other']

  function titleCollisionPathByUrl(groupTabs: DashboardTab[]): Map<string, string> {
    const pathByUrl = new Map<string, string>()
    const sameTitle = Map.groupBy(groupTabs, (tab) => lowerDisplayTitle(tab))
    for (const collided of sameTitle.values()) {
      if (collided.length < 2) continue
      const collidedUrls = collided.map((t) => t.url)
      if (new Set(collidedUrls).size < 2) continue
      const suffixes = uniqueTitleVariantPathSuffixes(collidedUrls)
      collided.forEach((t, i) => pathByUrl.set(t.url, suffixes[i] ?? ''))
    }
    return pathByUrl
  }

  function duplicateLabels(labels: readonly string[]): Set<string> {
    const counts = new Map<string, number>()
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1)
    return new Set(counts.entries().filter(([, count]) => count > 1).map(([label]) => label))
  }

  function titleVariantLabelForUrl(url: string): string {
    const parsed = parseUrl(url)
    return parsed ? `${parsed.pathname || '/'}${parsed.search}${parsed.hash}` || '/' : url || '/'
  }

  function titleVariantHostLabelForUrl(url: string): string {
    const parsed = parseUrl(url)
    return parsed ? `${parsed.host}${parsed.pathname || '/'}${parsed.search}${parsed.hash}` || url || '/' : url || '/'
  }

  function uniqueTitleVariantFallbackLabels(urls: readonly string[]): string[] {
    const pathLabels = urls.map(titleVariantLabelForUrl)
    if (duplicateLabels(pathLabels).size === 0) return pathLabels

    const hostLabels = urls.map(titleVariantHostLabelForUrl)
    if (duplicateLabels(hostLabels).size === 0) return hostLabels

    return urls.map((url) => url || '/')
  }

  function uniqueTitleVariantPathSuffixes(urls: readonly string[]): string[] {
    const suffixes = disambiguatingPaths([...urls])
    const duplicatedSuffixes = duplicateLabels(suffixes)
    if (duplicatedSuffixes.size === 0) return suffixes

    const fallbackLabels = uniqueTitleVariantFallbackLabels(urls)
    return suffixes.map((suffix, index) => (
      duplicatedSuffixes.has(suffix)
        ? fallbackLabels[index] || suffix || '/'
        : suffix
    ))
  }

  function titleVariantGroupChip(variants: DashboardChipData[], representative: DashboardChipData): DashboardChipData {
    const activeInCurrentWindow = variants.some((variant) => !!variant.activeChipFrame && !variant.activeInOtherWindow)
    const activeInOtherWindow = !activeInCurrentWindow && variants.some((variant) => !!variant.activeInOtherWindow)
    const allVariantsSaved = variants.length > 0 && variants.every((variant) => !!variant.saved)
    const allVariantsClosedSaved = variants.length > 0 && variants.every((variant) => isClosedSavedDashboardTab(variant))
    const stateRepresentative = !isClosedSavedDashboardTab(representative)
      ? representative
      : variants.find((variant) => !isClosedSavedDashboardTab(variant)) || representative
    const groupedChip: DashboardChipData = {
      ...stateRepresentative,
      saved: allVariantsSaved,
      closedSaved: allVariantsClosedSaved,
      suspended: allOpenTargetsSuspended(variants),
      loading: variants.some((variant) => !!variant.loading),
      pathSuffix: '',
      tooltip: `${representative.tooltip} · ${variants.length} URL variants`,
      dupeCount: 1,
      activeChipFrame: activeInCurrentWindow || activeInOtherWindow,
      activeInOtherWindow,
      audioState: mergeAudioStates(variants.map((variant) => variant.audioState ?? null)),
      titleVariantChips: variants
    }
    delete groupedChip.savedPageKey
    delete groupedChip.retainedPageIdentity
    delete groupedChip.retainedPageClosureToken
    delete groupedChip.pagePinId
    delete groupedChip.pagePinned
    return groupedChip
  }

  function buildChipDataList(contentTabs: DashboardTab[], showChipPrefix: boolean, pathByUrl: Map<string, string>, pathGroupLabel: string, pinScopeId: string, stripLabel = ''): DashboardChipData[] {
    const entries: ChipBuildEntry[] = contentTabs.map((tab) => {
      const pathSuffix = pathByUrl.get(tab.url) || ''
      return {
        tab,
        chip: buildChipData(tab, showChipPrefix, pathSuffix, pathGroupLabel, stripLabel),
        titleKey: lowerDisplayTitle(tab, true)
      }
    })
    const entriesByTitle = Map.groupBy(entries, (entry) => entry.titleKey)
    entriesByTitle.delete('')
    const groupedTitleKeys = new Set(
      entriesByTitle.entries()
        .filter(([, groupEntries]) => groupEntries.length > 1 && new Set(groupEntries.map((entry) => entry.tab.url)).size > 1)
        .map(([titleKey]) => titleKey)
    )
    const emittedTitleKeys = new Set<string>()
    const result: DashboardChipData[] = []
    for (const entry of entries) {
      if (!groupedTitleKeys.has(entry.titleKey)) {
        result.push(annotatePageChipPin(entry.chip, pinScopeId, pageChipPinKeyForUrl(entry.tab.url)))
        continue
      }
      if (emittedTitleKeys.has(entry.titleKey)) continue
      emittedTitleKeys.add(entry.titleKey)
      const variants = (entriesByTitle.get(entry.titleKey) || []).map((variantEntry) => {
        const variant = variantEntry.chip
        const ungroupedVariant = { ...variant }
        delete ungroupedVariant.titleVariantChips
        return annotatePageChipPin({
          ...ungroupedVariant,
          pathSuffix: variant.pathSuffix || titleVariantLabelForUrl(variant.tabUrl),
        }, pinScopeId, pageChipPinKeyForUrl(variantEntry.tab.url))
      })
      const representative = variants[0]
      if (representative) result.push(titleVariantGroupChip(sortPageChipsInScope(variants), representative))
    }
    return sortPageChipsInScope(result)
  }

  function buildSectionContent(contentTabs: DashboardTab[], showChipPrefix: boolean, redundantLabels: Set<string>, pinContext: { subdomainKey: string; websitePathKey: string }): SectionContentVM {
    // Path-group pills: resolve each tab's path group (github repo,
    // jira project, contentful env, etc.) and only keep labels whose
    // group has ≥2 members in this content group. A lone group is
    // usually silent clutter — the signal is "these belong together,"
    // which takes at least two chips to convey.
    //
    // Exception: adapters can opt in to `alwaysCluster: true` to
    // bypass the threshold. Jira uses this so ticket keys stay as
    // their own cluster even at member-count 1 — a self-contained
    // identifier and, more importantly, a position-stable anchor.
    //
    // Extra guardrail: drop labels already carried by the parent
    // domain/subdomain/path-section context.
    const pgByUrl = new Map<string, PathGroupResult>()
    const pgKeyCount = new Map<string, number>()
    for (const t of contentTabs) {
      const pg = structuralPathGroup(t)
      if (!pg) continue
      pgByUrl.set(t.url, pg)
      pgKeyCount.set(pg.key, (pgKeyCount.get(pg.key) || 0) + 1)
    }
    const pgLabelByUrl = new Map<string, string>()
    for (const [url, pg] of pgByUrl) {
      if (!pg.alwaysCluster && (pgKeyCount.get(pg.key) ?? 0) < 2) continue
      if (redundantLabels.has(pg.label)) continue
      pgLabelByUrl.set(url, pg.label)
    }

    // Build cluster blocks (≥2 members share a path-group label) and
    // a singleton block. Clusters render as labeled sub-sections; the
    // pill becomes the header and inner chips skip their per-chip
    // pill. Singletons follow flat with no header. Each block manages
    // its OWN visible/hidden split and its OWN "+N more" expander.
    const clusterByLabel = new Map<string, DashboardTab[]>()
    const singletonTabs: DashboardTab[] = []
    for (const t of contentTabs) {
      const lbl = pgLabelByUrl.get(t.url)
      if (!lbl) {
        singletonTabs.push(t)
        continue
      }
      clusterByLabel.getOrInsertComputed(lbl, () => []).push(t)
    }
    const sortedClusters = clusterByLabel.entries().toArray().sort((a, b) => compareWithPriority(
      chipPriorityScoreForTabs(a[1]),
      chipPriorityScoreForTabs(b[1]),
      () => compareNumericText(a[0], b[0])
    ))

    // Pull requests deserve their own section under a repo: they're
    // action items ("review me"), not browsing state ("I'm reading
    // this file"). Splitting them into a sibling sub-cluster lets
    // each half claim its own CHIPS_PER_SECTION limit instead of
    // fighting over one.
    const rawClusters: Array<{ label: string; tabs: DashboardTab[]; key: string; isPR: boolean }> = []
    for (const [lbl, tabs] of sortedClusters) {
      const prTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category === 'pull')
      const nonPrTabs = tabs.filter((t) => pgByUrl.get(t.url)?.category !== 'pull')
      if (prTabs.length >= 2 && nonPrTabs.length >= 1) {
        rawClusters.push({ label: lbl, tabs: nonPrTabs, key: lbl, isPR: false })
        rawClusters.push({ label: lbl, tabs: prTabs, key: lbl + ':pr', isPR: true })
      } else {
        const allArePRs = prTabs.length === tabs.length && tabs.length > 0
        rawClusters.push({ label: lbl, tabs, key: lbl, isPR: allArePRs })
      }
    }

    const unsortedClusters = rawClusters.map(({ label, tabs, key, isPR }) => {
      const orderedTabs = tabs.toSorted((a, b) => {
        const aCat = categoryRank(pgByUrl.get(a.url)?.category)
        const bCat = categoryRank(pgByUrl.get(b.url)?.category)
        return aCat - bCat
      })
      // Title-collision disambiguation is scoped to the rendered
      // group. If path-group headers already separate same-title
      // chips, URL crumbs would duplicate that structural signal.
      const pathByUrl = titleCollisionPathByUrl(orderedTabs)
      const pinScopeId = pageChipPinScopeId(group.domain, pinContext.subdomainKey, pinContext.websitePathKey, key)
      const chipData = buildChipDataList(orderedTabs, showChipPrefix, pathByUrl, '', pinScopeId, label)
      const { vis, hid } = splitForOverflow(chipData)
      const clusterClosable = allowMutations ? orderedTabs.filter(isBulkClosableTab) : []
      return {
        key,
        label,
        isPR,
        count: tabs.length,
        closableUrls: clusterClosable.map((t) => t.url),
        visibleChips: vis,
        hiddenChips: hid,
        hiddenCount: hid.length,
        isPinned: pinnedSections.has(pathgroupPinId(group.domain, pinContext.subdomainKey, pinContext.websitePathKey, key))
      }
    })
    const clusters = sortPinnedFirst(unsortedClusters)

    const flatPathByUrl = titleCollisionPathByUrl(singletonTabs)
    const flatPinScopeId = pageChipPinScopeId(group.domain, pinContext.subdomainKey, pinContext.websitePathKey, '')
    const flatChipData = buildChipDataList(singletonTabs, showChipPrefix, flatPathByUrl, '', flatPinScopeId)
    const { vis: flatVisibleChips, hid: flatHiddenChips } = splitForOverflow(flatChipData)

    return {
      hasFlat: singletonTabs.length > 0,
      flatVisibleChips,
      flatHiddenChips,
      flatHiddenCount: flatHiddenChips.length,
      clusters
    }
  }

  if (isAppsGroup) {
    // Apps render as regular titled chips (favicon + title, stacked) — the
    // icon-only presentation hid which window was which once several apps
    // were open. PageChip still branches on iconOnly for callers that want
    // the compact form. Titles stay RAW (rawTitle) to match history rows.
    const appChips = uniqueTabs.map((tab) => buildChipData(tab, false, '', '', '', { rawTitle: true }))
    const { vis: visibleAppChips, hid: hiddenAppChips } = splitForOverflow(appChips)
    const vmClosableCount = displayMode === 'unmatched' || !allowMutations ? 0 : closableCount
    const vmClosableExtras = displayMode === 'unmatched' || !allowMutations ? 0 : closableExtras
    const vmClosableDupeUrls = displayMode === 'unmatched' || !allowMutations ? [] : closableDupeUrls
    return {
      stableId,
      isHidden: false,
      displayMode,
      filtering,
      tabCount,
      totalTabCount,
      tabCountLabel,
      tabCountTitle,
      closableCount: vmClosableCount,
      closableCountLabel:
        closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`,
      closableDupeUrls: vmClosableDupeUrls,
      closableExtras: vmClosableExtras,
      singleSubdomainKey: '',
      singleSubdomainIsPort: false,
      displayName: group.label || 'Apps',
      suppressedTitleParts: [],
      allSuppressedTitleParts: [],
      sections: [
        {
          key: '__apps__',
          sectionCount: tabs.length,
          sectionClosableUrls: displayMode === 'unmatched' || !allowMutations ? [] : closableTabs.map((tab) => tab.url),
          showHeader: false,
          isShared: false,
          isPort: false,
          hasFlat: true,
          flatVisibleChips: visibleAppChips,
          flatHiddenChips: hiddenAppChips,
          flatHiddenCount: hiddenAppChips.length,
          suppressedTitleParts: [],
          clusters: [],
          websitePathSections: [],
          isPinned: false
        }
      ]
    }
  }

  // Folded (cross-env) chip data — one chip representing the same path
  // and visible title present in 2+ subdomains. The env-pill stack
  // replaces the usual subdomain prefix; clicking a pill focuses that
  // env's tab and the chip's close button (handled in PageChip) closes
  // every env copy.
  function buildFoldedChipData(tabs: DashboardTab[]): DashboardChipData {
    const primary = tabs[0]
    if (!primary) throw new Error('Folded chip requires at least one tab')
    const liveTabs = tabs.filter((tab) => !isClosedSavedDashboardTab(tab))
    const stateRepresentative = liveTabs[0] || primary
    const presentation = titlePresentation(primary)
    const label = presentation.displayTitle
    const rawSegments = stripPgLabel(label, '')
    const displaySegments = rawSegments.map((seg) => (typeof seg === 'string' ? injectBreakPoints(seg) : seg))
    // Sort envs by prefix with numeric-aware compare so dev2us lands
    // before dev11us (plain lexicographic would give dev11us, dev2us,
    // qaus — technically right but wrong for a human-natural read).
    // Stable across refreshes since `tabs` is derived from the same
    // page identity and subdomain prefix every time.
    const envs = tabs
      .map((t) => {
        const sub = subdomainForUrl(t.url)
        return {
          ...(t.id === undefined ? {} : { tabId: t.id }),
          prefix: sub || '?',
          tabUrl: t.url,
          rawUrl: t.rawUrl || t.url,
          sourceType: t.sourceType || 'tab',
          saved: !!t.saved,
          closedSaved: isClosedSavedDashboardTab(t),
          ...(t.savedPageKey === undefined ? {} : { savedPageKey: t.savedPageKey }),
          ...(t.retainedPageIdentity === undefined
            ? {}
            : { retainedPageIdentity: t.retainedPageIdentity }),
          ...(t.retainedPageClosureToken === undefined
            ? {}
            : { retainedPageClosureToken: t.retainedPageClosureToken }),
          title: displayTitle(t),
          faviconUrl: pickDashboardChipFavicon(t),
          actionTitle: t.title,
          ...(t.favIconUrl ? { actionFaviconUrl: t.favIconUrl } : {}),
          isApp: !!t.isApp,
          activeInOtherWindow: isActiveInOtherWindow(t, currentWindowId)
        }
      })
      .sort((a, b) => compareNumericText(a.prefix, b.prefix))
    const tooltip = [envs.map((e) => e.prefix).join(' · '), label].filter(Boolean).join(' · ')
    return {
      tabUrl: stateRepresentative.url,
      rawUrl: stateRepresentative.rawUrl || stateRepresentative.url,
      sourceType: stateRepresentative.sourceType || 'tab',
      closedSaved: liveTabs.length === 0,
      suspended: allOpenTargetsSuspended(tabs),
      loading: tabs.some(isOpenTabLoading),
      leadPrefix: '',
      pathGroupLabel: '',
      displaySegments,
      suppressedTitleParts: aggregateSuppressedTitleParts(tabs),
      pathSuffix: '',
      tooltip,
      dupeCount: 1,
      faviconUrl: pickDashboardChipFavicon(stateRepresentative),
      isGrouped: false,
      groupDotColor: null,
      // Folded chip reads as "app" only when every env tab behind it
      // is running in an app window — a mixed set isn't clearly one
      // or the other, so we bias toward "not app" (no dashed marker).
      isApp: tabs.every((t) => t.isApp),
      activeInOtherWindow: envs.some((env) => env.activeInOtherWindow),
      activeChipFrame: envs.some((env) => env.activeInOtherWindow),
      audioState: aggregateAudioState(tabs),
      envs
    }
  }

  // Assemble the shared section (appears first in the card when any
  // fold groups exist). It's a virtual subdomain: one flat list of
  // folded chips, no cluster sub-sections. Close-section closes every
  // tab across every env in every fold group.
  let sharedSectionData: DashboardSectionVM | null = null
  if (foldGroups.length > 0) {
    const sortedFolds = foldGroups.toSorted((a, b) => compareWithPriorityThenRememberedChipOrder(
      dashboardFoldChipOrderKey(a[0]?.sourceType, a.map((tab) => tab.url)),
      dashboardFoldChipOrderKey(b[0]?.sourceType, b.map((tab) => tab.url)),
      chipPriorityScoreForTabs(a),
      chipPriorityScoreForTabs(b),
      () => {
        const aFirst = a[0]
        const bFirst = b[0]
        if (!aFirst || !bFirst) return a.length - b.length
        return compareNumericText(sortLabel(aFirst), sortLabel(bFirst))
      }
    ))
    const sharedPinScopeId = pageChipPinScopeId(group.domain, '__shared__', '', '')
    const foldedChipData = sortPageChipsInScope(sortedFolds.map((tabs) => annotatePageChipPin(
      buildFoldedChipData(tabs),
      sharedPinScopeId,
      pageChipPinKeyForFoldUrls(tabs.map((tab) => tab.url))
    )))
    const { vis, hid } = splitForOverflow(foldedChipData)
    const sharedClosableUrls = allowMutations
      ? sortedFolds.flatMap((tabs) => tabs.filter(isBulkClosableTab).map((t) => t.url))
      : []
    const totalFoldedTabs = sortedFolds.reduce((sum, tabs) => sum + tabs.length, 0)
    sharedSectionData = {
      key: '__shared__',
      sectionCount: totalFoldedTabs,
      sectionClosableUrls: sharedClosableUrls,
      showHeader: false,
      isShared: true,
      hasFlat: true,
      flatVisibleChips: vis,
      flatHiddenChips: hid,
      flatHiddenCount: hid.length,
      suppressedTitleParts: [],
      clusters: [],
      websitePathSections: [],
      isPinned: false
    }
  }

  const unsortedSectionsData: DashboardSectionVM[] = sections.map(([key, sectionTabs]) => {
    // Header appears only when a card has 2+ subdomain sections AND
    // the section isn't the empty-key "root" (card title already says
    // the root). When shown, the header replaces the per-chip prefix —
    // repeating "dev2ca" on every chip under a "dev2ca" header is noise.
    const showHeader = multipleSections && key !== ''
    // Suppress chip prefix whenever the subdomain info is shown
    // elsewhere — either a section header (multi-subdomain card) or
    // the card-title pill (single-subdomain card).
    const showChipPrefix = !showHeader && !singleSubdomainKey

    const parentRedundantLabels = new Set([key, group.domain].filter(Boolean))
    const websitePathBuckets = new Map<string, WebsitePathSectionBucket>()
    const genericWebsitePathBuckets = new Map<string, WebsitePathSectionBucket>()
    const tabsWithoutWebsitePathSection: DashboardTab[] = []
    for (const tab of sectionTabs) {
      const websitePathSection = resolveWebsitePathSection(tab.url)
      if (websitePathSection) {
        websitePathBuckets
          .getOrInsertComputed(websitePathSection.key, () => ({ ...websitePathSection, tabs: [] }))
          .tabs.push(tab)
        continue
      }

      const genericWebsitePathSection = resolveGenericWebsitePathSection(tab.url)
      if (!genericWebsitePathSection) {
        tabsWithoutWebsitePathSection.push(tab)
        continue
      }

      genericWebsitePathBuckets
        .getOrInsertComputed(
          genericWebsitePathSection.key,
          () => ({ ...genericWebsitePathSection, tabs: [] })
        )
        .tabs.push(tab)
    }
    for (const bucket of genericWebsitePathBuckets.values()) {
      if (bucket.tabs.length >= 2) {
        websitePathBuckets.set(bucket.key, bucket)
      } else {
        tabsWithoutWebsitePathSection.push(...bucket.tabs)
      }
    }
    const websitePathBucketList = websitePathBuckets.values().toArray().sort((a, b) => compareWithPriority(
      chipPriorityScoreForTabs(a.tabs),
      chipPriorityScoreForTabs(b.tabs),
      () => compareNumericText(a.label, b.label)
    ))
    const showWebsitePathSections =
      websitePathBucketList.length > 1 ||
      ((websitePathBucketList[0]?.tabs.length ?? 0) >= 2 && tabsWithoutWebsitePathSection.length > 0)
    const parentTabs = showWebsitePathSections ? tabsWithoutWebsitePathSection : sectionTabs
    const parentContent = buildSectionContent(parentTabs, showChipPrefix, parentRedundantLabels, { subdomainKey: key, websitePathKey: '' })
    const unsortedWebsitePathSections: DashboardWebsitePathSectionVM[] = showWebsitePathSections
      ? websitePathBucketList.map((websitePathSection) => {
          const content = buildSectionContent(
            websitePathSection.tabs,
            showChipPrefix,
            new Set([...parentRedundantLabels, websitePathSection.label]),
            { subdomainKey: key, websitePathKey: websitePathSection.key }
          )
          return {
            key: websitePathSection.key,
            label: websitePathSection.label,
            sectionCount: websitePathSection.tabs.length,
            sectionClosableUrls: allowMutations ? websitePathSection.tabs.filter(isBulkClosableTab).map((t) => t.url) : [],
            ...content,
            suppressedTitleParts: [],
            isPinned: pinnedSections.has(websitePathPinId(group.domain, key, websitePathSection.key))
          }
        })
      : []
    const websitePathSections = sortPinnedFirst(unsortedWebsitePathSections)

    // Closable URLs for the subdomain-level close button in the
    // SubdomainSection header (shown only on multi-subdomain cards,
    // where the header itself is visible). Filters out tabs already
    // in a Chrome tab group — matches the preserveGroups semantics
    // used elsewhere. Union of every chip's URL in this section.
    const sectionClosableUrls = allowMutations ? sectionTabs.filter(isBulkClosableTab).map((t) => t.url) : []

    return {
      key,
      sectionCount: sectionTabs.length,
      sectionClosableUrls,
      showHeader,
      isShared: false,
      isPort: isPortGroup,
      ...parentContent,
      suppressedTitleParts: [],
      websitePathSections,
      isPinned: pinnedSections.has(subdomainPinId(group.domain, key))
    }
  })

  // Float pinned subdomain sections to the top of the card. The shared
  // (cross-env) section, prepended below, is a virtual aggregation —
  // not user-pinnable — so the sort runs before the unshift to keep
  // shared above everything.
  const sectionsData = sortPinnedFirst(unsortedSectionsData)

  // Prepend the cross-env fold section so it sits above the per-
  // subdomain sections — it reads as a TL;DR of "these pages are the
  // same across your envs, you probably want to see them grouped."
  if (sharedSectionData) sectionsData.unshift(sharedSectionData)

  function renderedChipsInSections(sectionsToScan: DashboardSectionVM[]): DashboardChipData[] {
    return sectionsToScan.flatMap((section) => [
      ...section.flatVisibleChips,
      ...section.flatHiddenChips,
      ...section.clusters.flatMap((cluster) => [...cluster.visibleChips, ...cluster.hiddenChips]),
      ...(section.websitePathSections ?? []).flatMap((websitePathSection) => [
        ...websitePathSection.flatVisibleChips,
        ...websitePathSection.flatHiddenChips,
        ...websitePathSection.clusters.flatMap((cluster) => [...cluster.visibleChips, ...cluster.hiddenChips])
      ])
    ])
  }

  function renderedSuppressionCountsByKey(sectionsToScan: DashboardSectionVM[]): Map<string, { count: number; titleVariantCount: number }> {
    const countsByKey = new Map<string, { count: number; titleVariantCount: number }>()
    for (const chip of renderedChipsInSections(sectionsToScan)) {
      const chipKeys = new Set((chip.suppressedTitleParts || []).map(titleSuppressionKey))
      for (const key of chipKeys) {
        const current = countsByKey.getOrInsertComputed(
          key,
          () => ({ count: 0, titleVariantCount: 0 })
        )
        current.count += 1
        if ((chip.titleVariantChips?.length || 0) > 1) current.titleVariantCount += 1
      }
    }
    return countsByKey
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

  function inlineSingletonSuppressionsInSegments(
    segments: DashboardSegment[],
    partsToInline: string[]
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
      nextSegments
    ))
  }

  function titleTextFromSegments(segments: DashboardSegment[]): string {
    return segments.map((segment) => {
      if (typeof segment === 'string') return segment
      if ('titleSuppression' in segment) return segment.titleSuppression
      if ('placeholder' in segment) return segment.label || ''
      return ''
    }).join('').replaceAll('\u200B', '')
  }

  function tooltipForChipTitle(chip: DashboardChipData, title: string): string {
    const titlePart = title.trim()
    if (chip.envs?.length) {
      return [chip.envs.map((env) => env.prefix).join(' · '), titlePart].filter(Boolean).join(' · ')
    }
    const tooltip = [chip.leadPrefix, titlePart, chip.pathSuffix].filter(Boolean).join(' · ')
    return chip.titleVariantChips?.length ? `${tooltip} · ${chip.titleVariantChips.length} URL variants` : tooltip
  }

  function inlineSingletonSuppressionsInChip(chip: DashboardChipData, singletonKeys: Set<string>): DashboardChipData {
    const partsToInline = (chip.suppressedTitleParts || []).filter((part) => singletonKeys.has(titleSuppressionKey(part)))
    const titleVariantChips = chip.titleVariantChips?.map((variant) => inlineSingletonSuppressionsInChip(variant, singletonKeys))
    if (partsToInline.length === 0) {
      return titleVariantChips ? { ...chip, titleVariantChips } : chip
    }

    const displaySegments = inlineSingletonSuppressionsInSegments(chip.displaySegments, partsToInline)
    const suppressedTitleParts = chip.suppressedTitleParts.filter((part) => !singletonKeys.has(titleSuppressionKey(part)))
    const chipWithVariants = titleVariantChips ? { ...chip, titleVariantChips } : chip
    return {
      ...chipWithVariants,
      displaySegments,
      suppressedTitleParts,
      tooltip: tooltipForChipTitle(chipWithVariants, titleTextFromSegments(displaySegments))
    }
  }

  function inlineSingletonSuppressionsInSections(
    sectionsToNormalize: DashboardSectionVM[],
    singletonKeys: Set<string>
  ): DashboardSectionVM[] {
    if (singletonKeys.size === 0) return sectionsToNormalize
    return sectionsToNormalize.map((section) => ({
      ...section,
      flatVisibleChips: section.flatVisibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
      flatHiddenChips: section.flatHiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
      clusters: section.clusters.map((cluster) => ({
        ...cluster,
        visibleChips: cluster.visibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        hiddenChips: cluster.hiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys))
      })),
      websitePathSections: (section.websitePathSections ?? []).map((websitePathSection) => ({
        ...websitePathSection,
        flatVisibleChips: websitePathSection.flatVisibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        flatHiddenChips: websitePathSection.flatHiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
        clusters: websitePathSection.clusters.map((cluster) => ({
          ...cluster,
          visibleChips: cluster.visibleChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys)),
          hiddenChips: cluster.hiddenChips.map((chip) => inlineSingletonSuppressionsInChip(chip, singletonKeys))
        }))
      }))
    }))
  }

  const renderedSuppressionCounts = renderedSuppressionCountsByKey(sectionsData)
  const singletonSuppressionKeys = new Set(
    renderedSuppressionCounts.entries()
      .filter(([, counts]) => counts.count <= 1 && counts.titleVariantCount === counts.count)
      .map(([key]) => key)
  )
  const visibleSuppressedTitleParts = suppressedTitleParts
    .filter((part) => !singletonSuppressionKeys.has(titleSuppressionKey(part.text)))
    .map((part) => {
      const renderedCounts = renderedSuppressionCounts.get(titleSuppressionKey(part.text))
      return {
        ...part,
        count: renderedCounts?.titleVariantCount ? renderedCounts.count : part.count
      }
    })

  function suppressionTargetsByText(tabs: readonly DashboardTab[]): Record<string, Array<{ tabId: number; tabUrl: string }>> {
    const targetsByText: Record<string, Array<{ tabId: number; tabUrl: string }>> = {}
    const targetsByKey = new Map<string, Array<{ tabId: number; tabUrl: string }>>()
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue
      const actualTitle = strippedTitle(tab.title || '')
      for (const part of titlePresentation(tab).suppressedTitleParts) {
        // Display presentations are URL-deduplicated, but destructive actions
        // operate on physical tabs. Same-URL duplicates can carry different
        // live titles, so only include a tab whose own title contains the token.
        if (titleSuppressionPartPosition(actualTitle, part) === Number.MAX_SAFE_INTEGER) continue
        const key = titleSuppressionKey(part)
        targetsByKey.getOrInsertComputed(key, () => []).push({ tabId: tab.id, tabUrl: tab.url })
      }
    }
    for (const [key, targets] of targetsByKey) targetsByText[key] = targets
    return targetsByText
  }

  // Map each suppressed-title token to the exact open tabs whose title carries it,
  // so the dashboard can offer token-scoped "Close N tabs" and "Suspend N tabs".
  // Keyed by the normalized suppression key. Left empty for read-only sources and
  // the unmatched grid, mirroring how every other bulk mutation is suppressed there.
  const allowTitleSuppressionActions = displayMode !== 'unmatched' && allowMutations
  const suppressionCloseTargetsByText = allowTitleSuppressionActions ? suppressionTargetsByText(closableTabs) : {}
  const suppressionSuspendTargetsByText = allowTitleSuppressionActions ? suppressionTargetsByText(suspendableTabs) : {}

  const sectionsDataWithInlineSingletonSuppressions = inlineSingletonSuppressionsInSections(sectionsData, singletonSuppressionKeys)
  const hasMultipleVisibleSuppressionMeaningsAfterMerge = visibleSuppressedTitleParts.length > 1

  function scopeSuppressedTitleParts(sectionsToScope: DashboardSectionVM[]) {
    type ScopeTracker = {
      part: DashboardTitleSuppression
      sectionIndexes: Set<number>
      flatSectionIndexes: Set<number>
      clusterRefs: Set<string>
      websitePathSectionRefs: Set<string>
      websitePathFlatRefs: Set<string>
      websitePathClusterRefs: Set<string>
    }

    const trackers = new Map<string, ScopeTracker>()
    for (const part of visibleSuppressedTitleParts) {
      trackers.set(titleSuppressionKey(part.text), {
        part,
        sectionIndexes: new Set(),
        flatSectionIndexes: new Set(),
        clusterRefs: new Set(),
        websitePathSectionRefs: new Set(),
        websitePathFlatRefs: new Set(),
        websitePathClusterRefs: new Set()
      })
    }

    function childGroupScopedPart(part: DashboardTitleSuppression, spansRenderedChildGroups: boolean): DashboardTitleSuppression {
      return hasMultipleVisibleSuppressionMeaningsAfterMerge && spansRenderedChildGroups ? { ...part, spansRenderedChildGroups: true } : part
    }

    function clusterRef(sectionIndex: number, clusterIndex: number): string {
      return `cluster\u0000${sectionIndex}\u0000${clusterIndex}`
    }

    function websitePathSectionRef(sectionIndex: number, websitePathSectionIndex: number): string {
      return `website-path-section\u0000${sectionIndex}\u0000${websitePathSectionIndex}`
    }

    function websitePathClusterRef(sectionIndex: number, websitePathSectionIndex: number, clusterIndex: number): string {
      return `website-path-cluster\u0000${sectionIndex}\u0000${websitePathSectionIndex}\u0000${clusterIndex}`
    }

    function sectionChildGroupCount(tracker: ScopeTracker, sectionIndex: number): number {
      let count = tracker.flatSectionIndexes.has(sectionIndex) ? 1 : 0
      const clusterPrefix = `cluster\u0000${sectionIndex}\u0000`
      const websitePathSectionPrefix = `website-path-section\u0000${sectionIndex}\u0000`
      for (const ref of tracker.clusterRefs) {
        if (ref.startsWith(clusterPrefix)) count += 1
      }
      for (const ref of tracker.websitePathSectionRefs) {
        if (ref.startsWith(websitePathSectionPrefix)) count += 1
      }
      return count
    }

    function websitePathChildGroupCount(tracker: ScopeTracker, sectionIndex: number, websitePathSectionIndex: number): number {
      const websiteRef = websitePathSectionRef(sectionIndex, websitePathSectionIndex)
      let count = tracker.websitePathFlatRefs.has(websiteRef) ? 1 : 0
      const prefix = `website-path-cluster\u0000${sectionIndex}\u0000${websitePathSectionIndex}\u0000`
      for (const ref of tracker.websitePathClusterRefs) {
        if (ref.startsWith(prefix)) count += 1
      }
      return count
    }

    function recordChip(
      chip: DashboardChipData,
      sectionIndex: number,
      clusterIndex: number | null,
      websitePathSectionIndex: number | null = null,
      websitePathSectionClusterIndex: number | null = null
    ) {
      for (const part of chip.suppressedTitleParts || []) {
        const tracker = trackers.get(titleSuppressionKey(part))
        if (!tracker) continue
        tracker.sectionIndexes.add(sectionIndex)
        if (websitePathSectionIndex !== null) {
          const websiteRef = websitePathSectionRef(sectionIndex, websitePathSectionIndex)
          tracker.websitePathSectionRefs.add(websiteRef)
          if (websitePathSectionClusterIndex === null) {
            tracker.websitePathFlatRefs.add(websiteRef)
          } else {
            tracker.websitePathClusterRefs.add(websitePathClusterRef(sectionIndex, websitePathSectionIndex, websitePathSectionClusterIndex))
          }
        } else if (clusterIndex === null) {
          tracker.flatSectionIndexes.add(sectionIndex)
        } else {
          tracker.clusterRefs.add(clusterRef(sectionIndex, clusterIndex))
        }
      }
    }

    sectionsToScope.forEach((section, sectionIndex) => {
      section.flatVisibleChips.forEach((chip) => recordChip(chip, sectionIndex, null))
      section.flatHiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null))
      section.clusters.forEach((cluster, clusterIndex) => {
        cluster.visibleChips.forEach((chip) => recordChip(chip, sectionIndex, clusterIndex))
        cluster.hiddenChips.forEach((chip) => recordChip(chip, sectionIndex, clusterIndex))
      })
      const sectionWebsitePathSections = section.websitePathSections ?? []
      sectionWebsitePathSections.forEach((websitePathSection, websitePathSectionIndex) => {
        websitePathSection.flatVisibleChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, null))
        websitePathSection.flatHiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, null))
        websitePathSection.clusters.forEach((cluster, clusterIndex) => {
          cluster.visibleChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, clusterIndex))
          cluster.hiddenChips.forEach((chip) => recordChip(chip, sectionIndex, null, websitePathSectionIndex, clusterIndex))
        })
      })
    })

    const cardParts: DashboardTitleSuppression[] = []
    const sectionPartsByIndex = new Map<number, DashboardTitleSuppression[]>()
    const clusterPartsByRef = new Map<string, DashboardTitleSuppression[]>()
    const websitePathSectionPartsByRef = new Map<string, DashboardTitleSuppression[]>()
    const websitePathClusterPartsByRef = new Map<string, DashboardTitleSuppression[]>()

    for (const part of visibleSuppressedTitleParts) {
      const tracker = trackers.get(titleSuppressionKey(part.text))
      if (!tracker || tracker.sectionIndexes.size === 0) {
        cardParts.push(part)
        continue
      }

      if (
        tracker.clusterRefs.size === 1 &&
        tracker.flatSectionIndexes.size === 0 &&
        tracker.websitePathSectionRefs.size === 0
      ) {
        const clusterRefKey = [...tracker.clusterRefs][0]
        if (clusterRefKey === undefined) continue
        clusterPartsByRef.getOrInsertComputed(clusterRefKey, () => []).push(part)
        continue
      }

      if (
        tracker.websitePathClusterRefs.size === 1 &&
        tracker.websitePathFlatRefs.size === 0 &&
        tracker.clusterRefs.size === 0 &&
        tracker.flatSectionIndexes.size === 0
      ) {
        const clusterRefKey = [...tracker.websitePathClusterRefs][0]
        if (clusterRefKey === undefined) continue
        websitePathClusterPartsByRef.getOrInsertComputed(clusterRefKey, () => []).push(part)
        continue
      }

      if (
        tracker.websitePathSectionRefs.size === 1 &&
        tracker.clusterRefs.size === 0 &&
        tracker.flatSectionIndexes.size === 0
      ) {
        const websiteRef = [...tracker.websitePathSectionRefs][0]
        if (websiteRef === undefined) continue
        const [, sectionIndexText, websitePathSectionIndexText] = websiteRef.split('\u0000')
        if (sectionIndexText === undefined || websitePathSectionIndexText === undefined) continue
        const sectionIndex = Number(sectionIndexText)
        const websitePathSectionIndex = Number(websitePathSectionIndexText)
        websitePathSectionPartsByRef.getOrInsertComputed(websiteRef, () => []).push(
          childGroupScopedPart(part, websitePathChildGroupCount(tracker, sectionIndex, websitePathSectionIndex) > 1)
        )
        continue
      }

      if (tracker.sectionIndexes.size === 1) {
        const sectionIndex = [...tracker.sectionIndexes][0]
        if (sectionIndex === undefined) continue
        sectionPartsByIndex.getOrInsertComputed(sectionIndex, () => []).push(
          childGroupScopedPart(part, sectionChildGroupCount(tracker, sectionIndex) > 1)
        )
        continue
      }

      cardParts.push(childGroupScopedPart(part, tracker.sectionIndexes.size > 1))
    }

    const scopedSections = sectionsToScope.map((section, sectionIndex) => ({
      ...section,
      suppressedTitleParts: sectionPartsByIndex.get(sectionIndex) ?? [],
      clusters: section.clusters.map((cluster, clusterIndex) => ({
        ...cluster,
        suppressedTitleParts: clusterPartsByRef.get(clusterRef(sectionIndex, clusterIndex)) ?? []
      })),
      websitePathSections: (section.websitePathSections ?? []).map((websitePathSection, websitePathSectionIndex) => ({
        ...websitePathSection,
        suppressedTitleParts: websitePathSectionPartsByRef.get(websitePathSectionRef(sectionIndex, websitePathSectionIndex)) ?? [],
        clusters: websitePathSection.clusters.map((cluster, clusterIndex) => ({
          ...cluster,
          suppressedTitleParts: websitePathClusterPartsByRef.get(websitePathClusterRef(sectionIndex, websitePathSectionIndex, clusterIndex)) ?? []
        }))
      }))
    }))

    return { cardParts, scopedSections }
  }

  const { cardParts: cardSuppressedTitleParts, scopedSections: scopedSectionsData } = scopeSuppressedTitleParts(sectionsDataWithInlineSingletonSuppressions)

  // Labels derived for the React component to consume directly.
  // closableCountLabel mirrors the original "Close all N tabs" vs
  // "Close N ungrouped tabs" split so the button text matches.
  const closableCountLabel =
    closableCount === tabCount ? `Close all ${closableCount} tab${closableCount !== 1 ? 's' : ''}` : `Close ${closableCount} ungrouped tab${closableCount !== 1 ? 's' : ''}`
  const suspendableCountLabel =
    suspendableCount === tabCount
      ? `Suspend all ${suspendableCount} tab${suspendableCount !== 1 ? 's' : ''}`
      : closableCount !== tabCount
        ? `Suspend ${suspendableCount} ungrouped tab${suspendableCount !== 1 ? 's' : ''}`
        : `Suspend ${suspendableCount} active tab${suspendableCount !== 1 ? 's' : ''}`
  const closableSuspendedCountLabel =
    closableCount === tabCount
      ? `Close all ${closableSuspendedCount} suspended tab${closableSuspendedCount !== 1 ? 's' : ''}`
      : `Close ${closableSuspendedCount} suspended ungrouped tab${closableSuspendedCount !== 1 ? 's' : ''}`

  const displayName = group.label || group.domain.replace(/^www\./, '')

  // In the secondary ("unmatched") grid, every bulk-close action is
  // suppressed — we don't want to offer a "Close 4 tabs" on a card
  // rendered as the user's NON-match set, that would close the tabs
  // they didn't type "github" about. Zero out the closable fields so
  // the buttons just don't render (components are already conditional
  // on closableCount > 0 / closableUrls.length > 0).
  const isUnmatched = displayMode === 'unmatched'
  const vmClosableCount = isUnmatched || !allowMutations ? 0 : closableCount
  const vmSuspendableCount = isUnmatched || !allowMutations ? 0 : suspendableCount
  const vmClosableSuspendedCount = isUnmatched || !allowMutations ? 0 : closableSuspendedCount
  const vmClosableExtras = isUnmatched || !allowMutations ? 0 : closableExtras
  const vmClosableDupeUrls = isUnmatched || !allowMutations ? [] : closableDupeUrls
  const vmSections = isUnmatched
    ? scopedSectionsData.map((s) => ({
        ...s,
        sectionClosableUrls: [],
        clusters: s.clusters.map((c) => ({ ...c, closableUrls: [] })),
        websitePathSections: (s.websitePathSections ?? []).map((websitePathSection) => ({
          ...websitePathSection,
          sectionClosableUrls: [],
          clusters: websitePathSection.clusters.map((c) => ({ ...c, closableUrls: [] }))
        }))
      }))
    : scopedSectionsData

  const { cardSuppressionToneScope, sections: tonedSections } = allocateCardSuppressionTones(cardSuppressedTitleParts, vmSections)

  return {
    stableId,
    isHidden: false,
    displayMode,
    filtering,
    tabCount,
    totalTabCount,
    tabCountLabel,
    tabCountTitle,
    closableCount: vmClosableCount,
    closableCountLabel,
    suspendableCount: vmSuspendableCount,
    suspendableCountLabel,
    closableSuspendedCount: vmClosableSuspendedCount,
    closableSuspendedCountLabel,
    closableDupeUrls: vmClosableDupeUrls,
    closableExtras: vmClosableExtras,
    singleSubdomainKey,
    singleSubdomainIsPort,
    displayName,
    suppressedTitleParts: cardSuppressedTitleParts,
    allSuppressedTitleParts: visibleSuppressedTitleParts,
    suppressionCloseTargetsByText,
    suppressionSuspendTargetsByText,
    cardSuppressionToneScope,
    sections: tonedSections
  }
}
