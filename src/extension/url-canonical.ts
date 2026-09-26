/* ================================================================
   URL canonicalization for dedup

   canonicalDedupeKey(url) maps a page URL to the key Tab Out uses to
   decide whether two tabs are "the same page" for duplicate counting,
   chip grouping, and the close-duplicates action.

   Per-site rules (mirroring path-groups.ts) strip redundant/noise
   params and fragments so URLs that render the identical page share a
   key.

   SAFE BY DEFAULT: when no rule matches, a rule returns null, or
   anything throws, the ORIGINAL url is returned — i.e. today's exact
   string match. A missing/buggy rule can only ever under-dedupe.

   Callers pass an already-suspender-unwrapped URL (same convention as
   path-groups.ts).
   ================================================================ */

import { isTabOutDashboardUrl, TAB_OUT_FAVICON_URL, tabOutDashboardCanonicalUrl } from './tab-out-url.js'
import { isGitHubRepositoryRootPath } from './github-url.js'
import type { UrlCanonicalizerRule } from './types'

const BUILT_IN_CANONICALIZERS: UrlCanonicalizerRule[] = [
  // GitHub repository roots: normalize both /{owner}/{repo}/ and
  // /{owner}/{repo} to the serialized no-slash identity. Handling both forms
  // keeps URL serialization (for example, percent-encoding) consistent.
  // Keep nested and reserved top-level routes exact by default.
  {
    hostname: 'github.com',
    canonicalize: (u: URL) => {
      if (!isGitHubRepositoryRootPath(u.pathname)) return null
      const pathname = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname
      return `${u.origin}${pathname}${u.search}${u.hash}`
    },
  },

  // Atlassian Jira: /browse/{ISSUE}-{N} → dedup by issue + focused comment.
  // Drops sourceType, page, and the redundant #comment-N hash. The focused
  // comment is taken from focusedCommentId or the #comment-N hash, whichever
  // is present (focusedCommentId wins). Distinct purpose from the /browse
  // path-GROUP rule (which clusters by project); both share the host and the
  // first non-null result wins.
  {
    hostnameEndsWith: '.atlassian.net',
    canonicalize: (u: URL) => {
      const m = u.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+-\d+)/)
      if (!m) return null
      const comment = u.searchParams.get('focusedCommentId') || (u.hash.match(/^#comment-(\d+)$/)?.[1] ?? '')
      const base = `${u.origin}/browse/${m[1]}`
      return comment ? `${base}?focusedCommentId=${comment}` : base
    },
  },
]

export function canonicalDedupeKey(url: string, favIconUrl?: string): string {
  if (!url) return url

  // Chrome gives native and overridden new tabs the same virtual URL.
  // Only a reported Tab Out favicon identifies the alias as our dashboard;
  // missing or unfamiliar metadata must not merge different documents.
  if (isTabOutDashboardUrl(url) || (url === 'chrome://newtab/' && favIconUrl === TAB_OUT_FAVICON_URL)) {
    return tabOutDashboardCanonicalUrl() ?? url
  }

  // Chrome exposes the native document through either spelling.
  if (url === 'chrome://new-tab-page/') return 'chrome://newtab/'

  const parsed = URL.parse(url)
  if (!parsed) return url

  for (const rule of BUILT_IN_CANONICALIZERS) {
    const hostMatch = rule.hostname
      ? parsed.hostname === rule.hostname
      : rule.hostnameEndsWith
        ? parsed.hostname.endsWith(rule.hostnameEndsWith)
        : false
    if (!hostMatch) continue
    try {
      const key = rule.canonicalize(parsed)
      if (key) return key
    } catch {
      // Adapter threw on an unexpected URL shape — fall through to exact.
    }
  }

  return url
}
