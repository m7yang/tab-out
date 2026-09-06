/* ================================================================
   Browser Tabs Gateway — the Dashboard's single crossing point to
   live browser tabs, windows, tab groups, and recently-closed
   sessions (see CONTEXT.md).

   Interface contract:
   • Commands only, browser vocabulary. Tab Action policy (matching,
     dedupe, suspend eligibility, undo ordering) stays with callers.
   • Never throws. Read operations whose empty value has product meaning expose
     an `*Result` form so callers can distinguish a confirmed empty collection
     from an unknown one; convenience wrappers retain the normalized value API.
   • The chrome-shaped input is resolved from `globalThis.chrome`
     PER CALL — never cached at module load — so tests and fixtures
     that patch the global in any order keep working. Tests may also
     inject directly via setChromeTabsApi().
   • Stateless. The `openTabs` cache stays in tabs.ts.
   ================================================================ */

export type ChromeTabsApi = {
  tabs: {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>
    get?(tabId: number): Promise<chrome.tabs.Tab>
    getCurrent?(): Promise<chrome.tabs.Tab | undefined>
    highlight?(highlightInfo: chrome.tabs.HighlightInfo): Promise<chrome.windows.Window>
    remove?(tabIds: number | number[]): Promise<void>
    update?(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
    create?(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>
    reload?(tabId: number): Promise<void>
    duplicate?(tabId: number): Promise<chrome.tabs.Tab | undefined>
    move?(tabId: number, moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | chrome.tabs.Tab[] | undefined>
    group?(options: { tabIds: number | number[], groupId?: number }): Promise<number>
  }
  windows?: {
    get?(windowId: number): Promise<chrome.windows.Window>
    getAll?(): Promise<chrome.windows.Window[]>
    getCurrent?(): Promise<chrome.windows.Window>
    update?(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window | undefined>
    create?(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>
  }
  tabGroups?: {
    query(queryInfo: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]>
    move?(
      groupId: number,
      moveProperties: chrome.tabGroups.MoveProperties,
    ): Promise<chrome.tabGroups.TabGroup>
  }
  sessions?: {
    getRecentlyClosed?(filter?: chrome.sessions.Filter): Promise<chrome.sessions.Session[]>
    restore?(sessionId?: string): Promise<chrome.sessions.Session>
  }
  runtime?: {
    id?: string
    sendMessage?(extensionId: string, message: unknown): Promise<unknown>
  }
}

export type BrowserReadResult<T> =
  | { ok: true, value: T }
  | { ok: false, value: T }

let injectedChromeTabsApi: ChromeTabsApi | null = null

/** Test seam: inject a chrome-shaped api directly; pass null to restore global resolution. */
export function setChromeTabsApi(api: ChromeTabsApi | null): void {
  injectedChromeTabsApi = api
}

function chromeTabsApi(): ChromeTabsApi | null {
  if (injectedChromeTabsApi) return injectedChromeTabsApi
  const globalChrome = (globalThis as { chrome?: ChromeTabsApi }).chrome
  // Partial fakes are common in tests (a sessions-only or tabs-only patch);
  // every op fully-chains its own guard, so any chrome-shaped object is fine.
  return globalChrome ?? null
}

export async function queryAllTabsResult(): Promise<BrowserReadResult<chrome.tabs.Tab[]>> {
  const api = chromeTabsApi()
  if (!api?.tabs?.query) return { ok: false, value: [] }
  try {
    return { ok: true, value: await api.tabs.query({}) }
  } catch {
    return { ok: false, value: [] }
  }
}

export async function queryTabsInWindowResult(windowId: number): Promise<BrowserReadResult<chrome.tabs.Tab[]>> {
  const api = chromeTabsApi()
  if (!api?.tabs?.query) return { ok: false, value: [] }
  try {
    return { ok: true, value: await api.tabs.query({ windowId }) }
  } catch {
    return { ok: false, value: [] }
  }
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.get) return null
  try {
    return (await api.tabs.get(tabId)) ?? null
  } catch {
    return null
  }
}

export async function getCurrentTab(): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.getCurrent) return null
  try {
    return (await api.tabs.getCurrent()) ?? null
  } catch {
    return null
  }
}

/**
 * removeTabs — close each tab with its own acknowledgement. Chrome may remove
 * a prefix of an array before rejecting it, so an array rejection cannot prove
 * which removals belong to this command. Returns only individually accepted ids.
 */
export type RemoveTabsOptions = {
  beforeSingleRemove?: (tabId: number) => boolean | Promise<boolean>
}

export async function removeTabs(
  tabIds: number[],
  { beforeSingleRemove }: RemoveTabsOptions = {},
): Promise<number[]> {
  const api = chromeTabsApi()
  if (!api?.tabs?.remove || tabIds.length === 0) return []
  const removed: number[] = []
  for (const tabId of new Set(tabIds)) {
    try {
      if (beforeSingleRemove && !(await beforeSingleRemove(tabId))) continue
      await api.tabs.remove(tabId)
      removed.push(tabId)
    } catch {
      /* Ineligible, unreadable, or rejected — preserve earlier acknowledgements. */
    }
  }
  return removed
}

export async function updateTab(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.update) return null
  try {
    return (await api.tabs.update(tabId, updateProperties)) ?? null
  } catch {
    return null
  }
}

export async function createTab(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.create) return null
  try {
    return await api.tabs.create(createProperties)
  } catch {
    return null
  }
}

export async function reloadTab(tabId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.tabs?.reload) return false
  try {
    await api.tabs.reload(tabId)
    return true
  } catch {
    return false
  }
}

export async function duplicateTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.duplicate) return null
  try {
    return (await api.tabs.duplicate(tabId)) ?? null
  } catch {
    return null
  }
}

/** highlightTabs -- replace a window's native tab selection without focusing the window itself. */
export async function highlightTabs(windowId: number, tabIndexes: number[]): Promise<boolean> {
  const api = chromeTabsApi()
  const tabs = [...new Set(tabIndexes.filter((index) => Number.isInteger(index) && index >= 0))]
  if (!api?.tabs?.highlight || tabs.length === 0) return false
  try {
    await api.tabs.highlight({ windowId, tabs })
    return true
  } catch {
    return false
  }
}

/**
 * createTabWithFallbackUrl — Chrome refuses to create tabs for another
 * extension's URL (e.g. a suspender page). Try the requested URL first,
 * then retry once with the fallback when it differs.
 */
export async function createTabWithFallbackUrl(createProperties: chrome.tabs.CreateProperties, fallbackUrl: string): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.create) return null
  try {
    return await api.tabs.create(createProperties)
  } catch {
    if (!fallbackUrl || fallbackUrl === createProperties.url) return null
    try {
      return await api.tabs.create({ ...createProperties, url: fallbackUrl })
    } catch {
      return null
    }
  }
}

/** groupTabs — re-attach tabs to a Chrome tab group; false when grouping is unavailable or the group is gone. */
export async function groupTabs(tabIds: number[], groupId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.tabs?.group || tabIds.length === 0) return false
  try {
    await api.tabs.group({ tabIds, groupId })
    return true
  } catch {
    return false
  }
}

export async function moveTab(tabId: number, moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | chrome.tabs.Tab[] | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.move) return null
  try {
    return (await api.tabs.move(tabId, moveProperties)) ?? null
  } catch {
    return null
  }
}

export async function moveTabGroup(
  groupId: number,
  moveProperties: chrome.tabGroups.MoveProperties,
): Promise<chrome.tabGroups.TabGroup | null> {
  const api = chromeTabsApi()
  if (!api?.tabGroups?.move) return null
  try {
    return (await api.tabGroups.move(groupId, moveProperties)) ?? null
  } catch {
    return null
  }
}

export async function getAllWindowsResult(): Promise<BrowserReadResult<chrome.windows.Window[]>> {
  const api = chromeTabsApi()
  if (!api?.windows?.getAll) return { ok: false, value: [] }
  try {
    return { ok: true, value: await api.windows.getAll() }
  } catch {
    return { ok: false, value: [] }
  }
}

export async function getWindow(windowId: number): Promise<chrome.windows.Window | null> {
  const api = chromeTabsApi()
  if (!api?.windows?.get) return null
  try {
    return (await api.windows.get(windowId)) ?? null
  } catch {
    return null
  }
}

export async function getCurrentWindowResult(): Promise<BrowserReadResult<chrome.windows.Window | null>> {
  const api = chromeTabsApi()
  if (!api?.windows?.getCurrent) return { ok: false, value: null }
  try {
    return { ok: true, value: (await api.windows.getCurrent()) ?? null }
  } catch {
    return { ok: false, value: null }
  }
}

export async function getCurrentWindow(): Promise<chrome.windows.Window | null> {
  return (await getCurrentWindowResult()).value
}

export async function focusWindow(windowId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.windows?.update) return false
  try {
    await api.windows.update(windowId, { focused: true })
    return true
  } catch {
    return false
  }
}

export async function createWindow(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | null> {
  const api = chromeTabsApi()
  if (!api?.windows?.create) return null
  try {
    return (await api.windows.create(createData)) ?? null
  } catch {
    return null
  }
}

export async function queryTabGroupsResult(): Promise<BrowserReadResult<chrome.tabGroups.TabGroup[]>> {
  const api = chromeTabsApi()
  // The API is optional when the permission is absent. That is a known lack of
  // metadata, not a transient read failure, so the deterministic color fallback
  // can take over.
  if (!api?.tabGroups?.query) return { ok: true, value: [] }
  try {
    return { ok: true, value: (await api.tabGroups.query({})) ?? [] }
  } catch {
    return { ok: false, value: [] }
  }
}

export async function getRecentlyClosedResult(filter?: chrome.sessions.Filter): Promise<BrowserReadResult<chrome.sessions.Session[]>> {
  const api = chromeTabsApi()
  if (!api?.sessions?.getRecentlyClosed) return { ok: true, value: [] }
  try {
    return { ok: true, value: (await api.sessions.getRecentlyClosed(filter)) ?? [] }
  } catch {
    return { ok: false, value: [] }
  }
}

/** restoreSession — reopen a recently-closed session entry; false when unavailable or already gone. */
export async function restoreSession(sessionId?: string): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.sessions?.restore) return false
  try {
    await api.sessions.restore(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * requestExternalUnsuspend — ask another extension (a tab suspender) to
 * unsuspend a tab it owns. False when the target is this extension itself,
 * messaging is unavailable, or the suspender reports an error.
 */
export async function requestExternalUnsuspend(extensionId: string, tabId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!extensionId || !api?.runtime?.sendMessage || extensionId === api.runtime.id) return false
  try {
    const response = await api.runtime.sendMessage(extensionId, { action: 'unsuspend', tabId })
    return !(typeof response === 'string' && response.startsWith('Error:'))
  } catch {
    return false
  }
}
