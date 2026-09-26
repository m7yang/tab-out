/* ================================================================
   Favicon resolver

   Uses Chrome's internal favicon cache for ordinary page URLs and
   closed snapshots while preserving awake/read-only data: favicons.
   ================================================================ */

import { isClosedSavedDashboardTab } from './dashboard-source.js'
import type { DashboardTab } from './types'

function faviconCacheUrl(url: string): string {
  if (!url || !globalThis.chrome?.runtime?.getURL) return ''
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`
}

export function pickFavicon(tab?: (Pick<DashboardTab, 'favIconUrl' | 'url'> & Partial<Pick<DashboardTab, 'sourceType' | 'closedSaved'>>) | null): string {
  const fav = tab?.favIconUrl || ''
  // The alias may represent an override. Keep its reported icon, otherwise
  // ask for the native document's icon rather than the overriding extension's.
  if (tab?.url === 'chrome://newtab/') return fav || faviconCacheUrl('chrome://new-tab-page/')
  // Closed snapshots can contain a suspender's pre-faded data: image without
  // retaining its provenance. Resolve the effective page before dimming it,
  // including for snapshots saved before this policy was introduced.
  if (fav.startsWith('data:') && (!tab || !isClosedSavedDashboardTab(tab))) return fav

  const url = tab?.url || ''
  if (!url) return ''
  return faviconCacheUrl(url) || fav
}

/**
 * pickTabFavicon(tab) — favicon for an OPEN tab. Live tabs keep data:
 * favicons verbatim (some sites set their real icon as a data: URI, and
 * data: URIs cannot be blocked cross-origin); suspended tabs never do —
 * their reported icon is the suspender's own pre-faded copy, so the
 * unwrapped original URL resolves through the cache instead and the
 * dashboard stays in charge of how suspension looks. Remote favicons
 * resolve through Chrome's local favicon cache instead of hot-linking:
 * sites that send Cross-Origin-Resource-Policy: same-origin (claude.ai,
 * notion.so, …) make the browser discard their favicon bytes on extension
 * pages, so the raw favIconUrl only serves as a fallback where the favicon
 * API is unavailable.
 */
export function pickTabFavicon(tab: Pick<DashboardTab, 'favIconUrl' | 'url' | 'suspended'>): string {
  const fav = tab.favIconUrl || ''
  if (tab.suspended) return faviconCacheUrl(tab.url || '') || fav
  if (fav.startsWith('data:')) return fav
  // Chrome supplies no favIconUrl for its native new-tab document.
  if (fav || tab.url === 'chrome://newtab/' || tab.url === 'chrome://new-tab-page/') return pickFavicon(tab) || fav
  return ''
}
