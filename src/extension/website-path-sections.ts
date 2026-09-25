import { isGitHubRepositoryOwnerPathSegment } from './github-url.js'
import type { WebsitePathSectionResult, WebsitePathSectionRule } from './types'

function recognizedPathPrefix(pathname: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix
  }
  return ''
}

function pathSection(prefix: string): WebsitePathSectionResult | null {
  return prefix ? { key: prefix, label: prefix } : null
}

function firstPathSegment(pathname: string): string {
  const segment = pathname.split('/').find(Boolean)
  return segment ? `/${segment}` : ''
}

const GOOGLE_DOCS_PREFIXES = [
  '/document',
  '/spreadsheets',
  '/presentation',
  '/forms',
  '/drawings',
]

const ATLASSIAN_PREFIXES = [
  '/jira',
  '/servicedesk',
  '/browse',
  '/issues',
  '/wiki',
]

const BUILT_IN_WEBSITE_PATH_SECTION_RULES: WebsitePathSectionRule[] = [
  {
    hostname: 'github.com',
    extract: (url) => {
      const prefix = firstPathSegment(url.pathname)
      return isGitHubRepositoryOwnerPathSegment(prefix.slice(1))
        ? { key: prefix, label: prefix, alwaysShow: true }
        : null
    },
  },
  {
    hostname: 'docs.google.com',
    extract: (url) => pathSection(recognizedPathPrefix(url.pathname, GOOGLE_DOCS_PREFIXES)),
  },
  {
    hostnameEndsWith: '.atlassian.net',
    extract: (url) => pathSection(recognizedPathPrefix(url.pathname, ATLASSIAN_PREFIXES)),
  },
]

export function resolveWebsitePathSection(url: string): WebsitePathSectionResult | null {
  if (!url) return null
  const parsed = URL.parse(url)
  if (!parsed) return null

  for (const rule of BUILT_IN_WEBSITE_PATH_SECTION_RULES) {
    const hostMatch = rule.hostname
      ? parsed.hostname === rule.hostname
      : rule.hostnameEndsWith
        ? parsed.hostname.endsWith(rule.hostnameEndsWith)
        : false
    if (!hostMatch) continue
    try {
      const result = rule.extract(parsed)
      if (result && result.key && result.label) return result
    } catch {
      return null
    }
  }

  return null
}

export function resolveGenericWebsitePathSection(url: string): WebsitePathSectionResult | null {
  if (!url) return null
  const parsed = URL.parse(url)
  return parsed ? pathSection(firstPathSegment(parsed.pathname)) : null
}
