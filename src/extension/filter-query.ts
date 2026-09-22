import type { DashboardTab } from './types'

export type FilterQueryTerm = {
  kind: 'token' | 'phrase'
  value: string
}

export type FilterQuery = {
  raw: string
  terms: FilterQueryTerm[]
}

export type CompiledFilterQuery = {
  raw: string
  active: boolean
  terms: ReadonlyArray<{
    kind: FilterQueryTerm['kind']
    value: string
    matchValues: readonly string[]
  }>
}

type DashboardItemSearchableParts = {
  title: string
  url: string
}

const TOKEN_MATCH_ALIASES = new Map<string, readonly string[]>([
  ['pr', ['pull request']],
])

function separatorMatchVariants(value: string): string[] {
  const parts = value.split(/[\s-]+/).filter(Boolean)
  if (parts.length < 2) return [value]
  return [...new Set([value, parts.join(' '), parts.join('-')])]
}

function pushTerm(terms: FilterQueryTerm[], kind: FilterQueryTerm['kind'], value: string) {
  const text = value.trim().toLowerCase()
  if (!text) return
  terms.push({ kind, value: text })
}

export function parseFilterQuery(input = ''): FilterQuery {
  const terms: FilterQueryTerm[] = []
  let index = 0

  while (index < input.length) {
    while (index < input.length && /\s/.test(input.charAt(index))) index += 1
    if (index >= input.length) break

    if (input[index] === '"') {
      index += 1
      const start = index
      while (index < input.length && input[index] !== '"') index += 1
      pushTerm(terms, 'phrase', input.slice(start, index))
      if (input[index] === '"') index += 1
      continue
    }

    const start = index
    while (index < input.length && !/\s/.test(input.charAt(index))) index += 1
    pushTerm(terms, 'token', input.slice(start, index))
  }

  return {
    raw: input,
    terms,
  }
}

export function matchValuesForFilterTerm(term: FilterQueryTerm): string[] {
  const values = term.kind === 'token'
    ? [term.value, ...(TOKEN_MATCH_ALIASES.get(term.value) ?? [])]
    : [term.value]
  return [...new Set(values.flatMap(separatorMatchVariants))]
}

/**
 * Parse a filter and expand its aliases/separator variants once so a caller
 * can reuse the result while walking a whole dashboard snapshot.
 */
export function compileFilterQuery(input = ''): CompiledFilterQuery {
  const query = parseFilterQuery(input)
  return {
    raw: query.raw,
    active: query.raw.trim().length > 0,
    terms: query.terms.map((term) => ({
      ...term,
      matchValues: matchValuesForFilterTerm(term),
    })),
  }
}

function searchablePartsForDashboardItem(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>): DashboardItemSearchableParts {
  // Prevent the dashboard from matching the filter echoed in its title or URL.
  const rawTitle = tab.title || ''
  const title = tab.isTabOut ? rawTitle.replace(/^.+ - Tab Out$/i, 'Tab Out') : rawTitle
  let url = tab.url || ''

  if (tab.isTabOut) {
    const parsed = URL.parse(url)
    if (parsed) {
      parsed.search = ''
      url = parsed.toString()
    }
  }

  return { title, url }
}

export function searchableTextForDashboardItem(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>): string {
  const { title, url } = searchablePartsForDashboardItem(tab)
  return `${title}\n${url}`.toLowerCase()
}
