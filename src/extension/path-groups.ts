/* ================================================================
   Path-group adapters

   Given a tab URL (already suspender-unwrapped upstream in tabs.js),
   return a { key, label } identifying which "path group" the tab
   belongs to — a cluster of tabs that share a meaningful path-level
   grouping on a given site (e.g. all issues for the same Jira
   project, all PRs for the same GitHub repo).

   The render layer turns the label into a small inline pill on each
   chip, but only when 2+ chips in the same subdomain section share
   a key. A chip with no matching adapter returns null (no pill, no
   noise). A lone "group" of one is silent clutter, so we drop it.

   Adapter shape:
     { hostname, extract(urlObj) → { key, label } | null }
     { hostnameEndsWith, extract(urlObj) → { key, label } | null }

   Multiple adapters can match the same hostname — the first one to
   return a non-null result wins. That's how Jira and Confluence can
   share the atlassian.net host: whichever path pattern hits first.
   ================================================================ */

import { isGitHubRepositoryOwnerPathSegment } from './github-url.js'
import type { PathGroupResult, PathGroupRule } from './types'

const BUILT_IN_PATH_GROUPERS: PathGroupRule[] = [
  // GitHub: /{owner}/{repo}/... → group by "owner/repo".
  // RESERVED owners are GitHub's top-level routes (not user/org names)
  // so they can't produce spurious groups like "settings/billing".
  {
    hostname: 'github.com',
    extract: (u: URL) => {
      // Capture up to the fourth path segment. The third segment
      // classifies the page area (pull / issues / commits / code);
      // the fourth distinguishes a specific item (a PR number, an
      // issue number) from the browsing list at that path — e.g.
      // /pull/1234 (action item) vs /pulls?q=… (browse all PRs).
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/)
      if (!m) return null
      const owner = m[1]
      const repository = m[2]
      if (!owner || !repository || !isGitHubRepositoryOwnerPathSegment(owner)) return null
      const label = `${owner}/${repository}`
      const sub = m[3] || ''
      const item = m[4] || ''
      // Category: used by render.js to order chips within a cluster so
      // PRs sit together, issues sit together, etc. — and (for PRs)
      // to split the cluster into a dedicated "PRs" sub-section with
      // its own display limit. `other` covers the repo homepage plus
      // pages like /actions, /releases, /wiki.
      //
      // IMPORTANT: `/pulls?q=…` (the browse-all-PRs list) is NOT a
      // PR — it's a browsing page. Only /pull/<N> (singular + item)
      // counts as a PR. Same rationale could apply to /issues/<N>
      // vs /issues?q=… but we leave issues unsplit for now since
      // they don't get their own sub-cluster anyway.
      let category: PathGroupResult['category'] = 'other'
      if (sub === 'pull' && item) category = 'pull'
      else if (sub === 'issues') category = 'issue'
      else if (sub === 'commits' || sub === 'commit') category = 'commit'
      else if (sub === 'blob' || sub === 'tree') category = 'code'
      return { key: label, label, category }
    }
  },

  // Atlassian Jira: /browse/PROJ-N → group by project key prefix.
  // Only /browse/ carries a project in its URL; list views like
  // /jira/for-you or /issues?jql=... stay ungrouped (no signal).
  //
  // `alwaysCluster: true` bypasses render.js's "needs ≥2 members"
  // threshold — a single ABC-123 tab still renders as a clustered
  // section under an [ABC] header. Reason: ticket keys are
  // self-contained identifiers that stay meaningful alone; the
  // bigger payoff is position stability. If a project had two
  // tickets clustered together and one gets closed, without this
  // flag the surviving ticket would suddenly jump down into the
  // flat singletons section — a jarring layout shift. With it, the
  // cluster persists at its current spot regardless of member count.
  {
    hostnameEndsWith: '.atlassian.net',
    extract: (u: URL) => {
      const m = u.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+)-\d+/)
      const project = m?.[1]
      if (!project) return null
      return { key: `jira:${project}`, label: project, alwaysCluster: true }
    }
  },

  // Atlassian Confluence: /wiki/spaces/<SPACE>/... → group by space.
  {
    hostnameEndsWith: '.atlassian.net',
    extract: (u: URL) => {
      const m = u.pathname.match(/^\/wiki\/spaces\/([^/]+)/)
      const space = m?.[1]
      if (!space) return null
      return { key: `wiki:${space}`, label: space }
    }
  },

  // Contentful: /spaces/<SPACE>/environments/<ENV>/... → group by env.
  // Environment is the axis that actually varies across tabs (env-a,
  // env-b, prod); the space is usually constant for a given user.
  // Keep every recognized environment as an explicit scope, including
  // single-tab environments, so the scope does not disappear as tabs
  // are opened and closed.
  {
    hostname: 'app.contentful.com',
    extract: (u: URL) => {
      const m = u.pathname.match(/^\/spaces\/([^/]+)\/environments\/([^/]+)/)
      const space = m?.[1]
      const environment = m?.[2]
      if (!space || !environment) return null
      return { key: `${space}/${environment}`, label: environment, alwaysCluster: true }
    }
  },

  // Figma: /design/<fileId>/<decodedName> (and /file/ for legacy).
  // Decode the slug into a human-readable label — figma URLs already
  // carry the file name, just URL-encoded with hyphens/underscores.
  {
    hostname: 'www.figma.com',
    extract: (u: URL) => {
      const m = u.pathname.match(/^\/(?:design|file)\/([^/]+)\/([^/?]+)/)
      const fileId = m?.[1]
      const encodedName = m?.[2]
      if (!fileId || !encodedName) return null
      let label
      try {
        label = decodeURIComponent(encodedName).replace(/[_-]+/g, ' ').trim()
      } catch {
        label = encodedName
      }
      return { key: fileId, label: label || fileId }
    }
  },

  // Reddit: /r/<subreddit>/... → group by subreddit.
  {
    hostname: 'www.reddit.com',
    extract: (u: URL) => {
      const m = u.pathname.match(/^\/r\/([^/]+)/)
      const subreddit = m?.[1]
      if (!subreddit) return null
      return { key: `r/${subreddit}`, label: `r/${subreddit}` }
    }
  },

  // Google Search deliberately stays out of path groups. The common
  // "- Google Search" suffix is title noise, not a user-meaningful
  // shared path, so title suppression handles it with the shared
  // keyword affordance instead of rendering a chip-pathgroup.
]

export function resolvePathGroup(url: string | URL): PathGroupResult | null {
  if (!url) return null
  const parsed = typeof url === 'string' ? URL.parse(url) : url
  if (!parsed) return null

  for (const rule of BUILT_IN_PATH_GROUPERS) {
    const hostMatch = rule.hostname ? parsed.hostname === rule.hostname : rule.hostnameEndsWith ? parsed.hostname.endsWith(rule.hostnameEndsWith) : false
    if (!hostMatch) continue
    try {
      const result = rule.extract(parsed)
      if (result && result.key && result.label) return result
    } catch {
      // Adapter threw on an unexpected URL shape — treat as no match.
    }
  }
  return null
}
