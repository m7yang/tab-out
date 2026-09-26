/* ================================================================
   Tab Out page URL helpers

   Single source of truth for "is this URL the Tab Out dashboard?",
   shared by close-duplicates protection (tabs.ts) and startup detection
   (app.tsx). Duplicate identity additionally checks the declared favicon
   before treating a chrome://newtab/ alias as the dashboard.

   The dashboard overrides the native new tab. Callers that need the actual
   extension document keep using isTabOutDashboardUrl, while callers that
   include native new tabs for protection use isTabOutPageUrl, so:
     - isTabOutDashboardUrl EXCLUDES chrome://newtab/
     - isTabOutPageUrl (dedupe / protection / startup) INCLUDES it and
       the native chrome://new-tab-page/ document
   ================================================================ */

const NEW_TAB_URL = 'chrome://newtab/'
export const TAB_OUT_FAVICON_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"

/**
 * The Tab Out dashboard's canonical URL (no search/hash), or null when no
 * extension runtime id is available (e.g. a unit test without a mock).
 */
export function tabOutDashboardCanonicalUrl(runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id): string | null {
  const id = runtimeId
  return id ? `chrome-extension://${id}/index.html` : null
}

/**
 * True when url is the Tab Out dashboard page (index.html), ignoring any
 * search params or hash. Does NOT match chrome://newtab/.
 */
export function isTabOutDashboardUrl(url?: string, runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id): boolean {
  if (!url) return false
  const base = tabOutDashboardCanonicalUrl(runtimeId)
  if (!base) return false
  return url === base || url.startsWith(`${base}?`) || url.startsWith(`${base}#`)
}

/**
 * True when url is any Tab Out page: the dashboard (any search/hash) or a
 * native new tab. Used for active-tab protection and startup detection.
 */
export function isTabOutPageUrl(url?: string, runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id): boolean {
  return url === NEW_TAB_URL || url === 'chrome://new-tab-page/' || isTabOutDashboardUrl(url, runtimeId)
}
