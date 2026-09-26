import { isTabOutPageUrl } from './tab-out-url.js'

export type PageTarget = {
  tabId?: number | string
  hoverTabIds?: readonly number[]
  tabUrl?: string
  url?: string
  rawUrl?: string
}

export function pageTargetUrl(target: PageTarget | null | undefined): string {
  return target?.tabUrl || target?.url || ''
}

function pageTargetRawUrl(target: PageTarget | null | undefined): string {
  return target?.rawUrl || pageTargetUrl(target)
}

export function pageTargetMatchUrls(target: PageTarget | null | undefined): string[] {
  return [...new Set([pageTargetUrl(target), pageTargetRawUrl(target)].filter(Boolean))]
}

export function pageTargetMatchesHover(
  target: PageTarget | null | undefined,
  activeHoverUrl: string,
  activeHoverUrls: readonly string[] = [],
  activeHoverTabIds?: readonly number[],
): boolean {
  // New-tab aliases can name different documents and preserved display buckets.
  if (activeHoverTabIds && isTabOutPageUrl(pageTargetUrl(target))) {
    const tabIds = target?.hoverTabIds ?? (typeof target?.tabId === 'number' ? [target.tabId] : [])
    return tabIds.some((id) => activeHoverTabIds.includes(id))
  }
  return pageTargetMatchUrls(target).some((url) => url === activeHoverUrl || activeHoverUrls.includes(url))
}
