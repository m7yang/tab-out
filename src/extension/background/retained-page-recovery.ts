import { retainedPageEffectiveUrl } from '../retained-page-identity.js'
import { isRetainedPageActivationEligible } from '../retained-page-activation-policy.js'
import type { RetainedPageRecord } from '../retained-pages-ledger.js'
import type { RetainedPageActivationDisposition } from './retained-pages-service.js'
import type { ChromeApi } from './chrome-api.js'

interface LiveRetainedPageTarget {
  readonly tabId: number
  readonly windowId: number
  readonly needsNavigation: boolean
}

export type RecoverablePageSnapshot = Pick<RetainedPageRecord, 'surfaceKind' | 'url'>

export interface RetainedPageRecoveryOptions {
  readonly confirmationAttempts?: number
  readonly currentWindowId?: number
  readonly waitBetweenConfirmationAttempts?: () => PromiseLike<void>
}

const DEFAULT_CONFIRMATION_ATTEMPTS = 20
const CONFIRMATION_POLL_MS = 50

type LiveTargetRead =
  | { readonly ok: false }
  | {
      readonly ok: true
      readonly normalWindowId: number | null
      readonly target: LiveRetainedPageTarget | null
    }

async function readExactLiveTarget(
  chromeApi: ChromeApi,
  page: RecoverablePageSnapshot,
  currentWindowId?: number
): Promise<LiveTargetRead> {
  try {
    const [tabs, windows] = await Promise.all([
      chromeApi.tabs.query({}),
      chromeApi.windows.getAll()
    ])
    const windowTypes = new Map<number, chrome.windows.Window['type']>()
    for (const window of windows) {
      if (typeof window.id === 'number' && window.type) {
        windowTypes.set(window.id, window.type)
      }
    }

    const normalWindow = windows.find((window) =>
      window.id === currentWindowId &&
      window.type === 'normal' &&
      typeof window.id === 'number'
    ) ?? windows.find((window) =>
      window.type === 'normal' && window.focused && typeof window.id === 'number'
    ) ?? windows.find((window) =>
      window.type === 'normal' && typeof window.id === 'number'
    )
    let exactNormalTarget: LiveRetainedPageTarget | null = null
    let pendingExactTarget = false
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue
      const windowType = windowTypes.get(tab.windowId)
      const surfaceKind = windowType === 'app' || windowType === 'popup'
        ? 'app'
        : windowType === undefined
          ? null
          : 'normal-tab'
      const committedUrl = tab.url || ''
      const exactUrl = retainedPageEffectiveUrl({ url: committedUrl })
      if (
        exactUrl !== page.url &&
        retainedPageEffectiveUrl({ url: tab.pendingUrl || '' }) === page.url &&
        surfaceKind !== 'app'
      ) {
        pendingExactTarget = true
      }
      if (exactUrl !== page.url) continue
      if (surfaceKind === null) {
        // A matching URL in an unclassified window is enough to make browser
        // inventory incomplete. Creating another target could duplicate it.
        return { ok: false }
      }
      const target = {
        tabId: tab.id,
        windowId: tab.windowId,
        needsNavigation: committedUrl !== page.url
      }
      if (surfaceKind === 'normal-tab' && exactNormalTarget === null) {
        exactNormalTarget = target
      }
    }
    if (!exactNormalTarget && pendingExactTarget) {
      return { ok: false }
    }
    return {
      ok: true,
      normalWindowId: normalWindow?.id ?? null,
      target: exactNormalTarget
    }
  } catch {
    // An unknown browser inventory cannot prove that creating would not
    // duplicate an exact target, so activation remains retained and fails.
    return { ok: false }
  }
}

async function confirmExactNormalTarget(
  chromeApi: ChromeApi,
  target: LiveRetainedPageTarget,
  targetUrl: string
): Promise<boolean> {
  try {
    const tab = await chromeApi.tabs.get(target.tabId)
    if (
      tab.windowId !== target.windowId ||
      !committedTabRepresentsTarget(tab, targetUrl)
    ) return false
    const window = await chromeApi.windows.get(tab.windowId)
    return window.type === 'normal'
  } catch {
    return false
  }
}

async function confirmExistingTarget(
  chromeApi: ChromeApi,
  target: LiveRetainedPageTarget,
  targetUrl: string,
  expectedWindowId: number
): Promise<boolean> {
  try {
    const tab = await chromeApi.tabs.get(target.tabId)
    return tab.windowId === expectedWindowId && committedTabRepresentsTarget(tab, targetUrl)
  } catch {
    return false
  }
}

function committedTabRepresentsTarget(
  tab: chrome.tabs.Tab,
  targetUrl: string
): boolean {
  return retainedPageEffectiveUrl({ url: tab.url || '' }) === targetUrl
}

function waitForConfirmationPoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_MS))
}

async function confirmCreatedTabTarget(
  chromeApi: ChromeApi,
  created: chrome.tabs.Tab,
  targetUrl: string,
  options: RetainedPageRecoveryOptions
): Promise<boolean> {
  if (typeof created.id !== 'number') return false

  const attempts = Math.max(
    1,
    Math.trunc(options.confirmationAttempts ?? DEFAULT_CONFIRMATION_ATTEMPTS)
  )
  const wait = options.waitBetweenConfirmationAttempts ?? waitForConfirmationPoll
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let tab: chrome.tabs.Tab
    try {
      tab = await chromeApi.tabs.get(created.id)
    } catch {
      return false
    }
    if (committedTabRepresentsTarget(tab, targetUrl)) return true
    if (tab.status === 'complete' && !!tab.url) return false
    if (attempt + 1 < attempts) await wait()
  }
  return false
}

async function confirmCreatedWindowTarget(
  chromeApi: ChromeApi,
  created: chrome.windows.Window,
  targetUrl: string,
  options: RetainedPageRecoveryOptions
): Promise<boolean> {
  if (typeof created.id !== 'number') return false

  // The object returned by windows.create describes the requested mutation,
  // not necessarily the URL Chrome ultimately committed. Re-read every
  // reported tab before falling back to a window query.
  for (const createdTab of created.tabs || []) {
    if (typeof createdTab.id !== 'number') continue
    try {
      const tab = await chromeApi.tabs.get(createdTab.id)
      if (committedTabRepresentsTarget(tab, targetUrl)) return true
      if (tab.status === 'complete' && !!tab.url) return false
    } catch {
      // A query below can still confirm a tab omitted or replaced by Chrome.
    }
  }

  const attempts = Math.max(
    1,
    Math.trunc(options.confirmationAttempts ?? DEFAULT_CONFIRMATION_ATTEMPTS)
  )
  const wait = options.waitBetweenConfirmationAttempts ?? waitForConfirmationPoll
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let tabs: chrome.tabs.Tab[]
    try {
      tabs = await chromeApi.tabs.query({ windowId: created.id })
    } catch {
      return false
    }
    if (tabs.some((tab) => committedTabRepresentsTarget(tab, targetUrl))) return true
    if (tabs.length > 0 && tabs.every((tab) => tab.status === 'complete' && !!tab.url)) {
      return false
    }
    if (attempt + 1 < attempts) await wait()
  }
  return false
}

async function focusExactLiveTarget(
  chromeApi: ChromeApi,
  target: LiveRetainedPageTarget,
  targetUrl: string,
  options: RetainedPageRecoveryOptions,
  expectedWindowId = target.windowId
): Promise<boolean> {
  let updated: chrome.tabs.Tab | undefined
  try {
    updated = await chromeApi.tabs.update(target.tabId, {
      ...(target.needsNavigation ? { url: targetUrl } : {}),
      active: true
    })
  } catch {
    return false
  }
  const confirmed = target.needsNavigation
    ? !!updated && await confirmCreatedTabTarget(chromeApi, updated, targetUrl, options)
    : (
        !!updated &&
        updated.windowId === expectedWindowId &&
        committedTabRepresentsTarget(updated, targetUrl)
      ) || await confirmExistingTarget(chromeApi, target, targetUrl, expectedWindowId)
  if (!confirmed) return false
  try {
    await chromeApi.windows.update(expectedWindowId, { focused: true })
  } catch {
    // Activating the exact target is still a confirmed partial focus success.
  }
  return true
}

async function moveExactLiveTarget(
  chromeApi: ChromeApi,
  page: RecoverablePageSnapshot,
  target: LiveRetainedPageTarget,
  destinationWindowId: number,
  activate: boolean,
  options: RetainedPageRecoveryOptions
): Promise<boolean> {
  if (target.windowId !== destinationWindowId) {
    try {
      await chromeApi.tabs.move(target.tabId, {
        windowId: destinationWindowId,
        index: -1
      })
    } catch {
      return false
    }
    if (!await confirmExistingTarget(
      chromeApi,
      target,
      page.url,
      destinationWindowId
    )) return false
  }

  if (target.needsNavigation || activate) {
    let updated: chrome.tabs.Tab | undefined
    try {
      updated = await chromeApi.tabs.update(target.tabId, {
        ...(target.needsNavigation ? { url: page.url } : {}),
        ...(activate ? { active: true } : {})
      })
    } catch {
      return false
    }
    const confirmed = target.needsNavigation
      ? !!updated && await confirmCreatedTabTarget(chromeApi, updated, page.url, options)
      : await confirmExistingTarget(chromeApi, target, page.url, destinationWindowId)
    if (!confirmed) return false
  }

  // Even the apparent no-op background gesture must revalidate after the
  // initial inventory read. The exact tab may have navigated while activation
  // was in flight, and that uncertainty must preserve retention.
  if (!await confirmExistingTarget(
    chromeApi,
    target,
    page.url,
    destinationWindowId
  )) return false

  if (activate) {
    try {
      await chromeApi.windows.update(destinationWindowId, { focused: true })
    } catch {
      // The tab is active in the requested window, which is partial success.
    }
  }
  return true
}

async function moveExactLiveTargetToNewWindow(
  chromeApi: ChromeApi,
  page: RecoverablePageSnapshot,
  target: LiveRetainedPageTarget,
  options: RetainedPageRecoveryOptions
): Promise<boolean> {
  let created: chrome.windows.Window | undefined
  try {
    created = await chromeApi.windows.create({
      tabId: target.tabId,
      focused: true,
      type: 'normal'
    })
  } catch {
    return false
  }
  if (!created || typeof created.id !== 'number') return false
  if (!await confirmExistingTarget(chromeApi, target, page.url, created.id)) return false
  if (!target.needsNavigation) return true

  let updated: chrome.tabs.Tab | undefined
  try {
    updated = await chromeApi.tabs.update(target.tabId, {
      url: page.url,
      active: true
    })
  } catch {
    return false
  }
  return !!updated && confirmCreatedTabTarget(chromeApi, updated, page.url, options)
}

async function recoverExactLiveTarget(
  chromeApi: ChromeApi,
  page: RecoverablePageSnapshot,
  target: LiveRetainedPageTarget,
  normalWindowId: number | null,
  disposition: RetainedPageActivationDisposition,
  options: RetainedPageRecoveryOptions
): Promise<boolean> {
  if (disposition === 'focus-tab') {
    return focusExactLiveTarget(chromeApi, target, page.url, options)
  }
  if (disposition === 'new-window') {
    return moveExactLiveTargetToNewWindow(chromeApi, page, target, options)
  }
  if (normalWindowId !== null) {
    return moveExactLiveTarget(
      chromeApi,
      page,
      target,
      normalWindowId,
      disposition === 'foreground-tab',
      options
    )
  }

  let created: chrome.windows.Window | undefined
  try {
    created = await chromeApi.windows.create({
      tabId: target.tabId,
      focused: disposition === 'foreground-tab',
      type: 'normal'
    })
  } catch {
    return false
  }
  if (!created || typeof created.id !== 'number') return false
  if (!await confirmExistingTarget(chromeApi, target, page.url, created.id)) return false
  return moveExactLiveTarget(
    chromeApi,
    page,
    { ...target, windowId: created.id },
    created.id,
    disposition === 'foreground-tab',
    options
  )
}

async function createNormalTab(
  chromeApi: ChromeApi,
  page: RecoverablePageSnapshot,
  active: boolean,
  normalWindowId: number | null,
  options: RetainedPageRecoveryOptions
): Promise<boolean> {
  if (normalWindowId === null) {
    try {
      const created = await chromeApi.windows.create({
        url: page.url,
        focused: active,
        type: 'normal'
      })
      return !!created && confirmCreatedWindowTarget(chromeApi, created, page.url, options)
    } catch {
      return false
    }
  }
  try {
    const created = await chromeApi.tabs.create({
      windowId: normalWindowId,
      url: page.url,
      active
    })
    return !!created && confirmCreatedTabTarget(chromeApi, created, page.url, options)
  } catch {
    return false
  }
}

/**
 * Reopen the exact retained URL without consulting Chrome's recently-closed
 * sessions. Standalone app records always recover through an ordinary browser
 * tab/window and never reactivate a matching app-window target.
 */
export async function recoverRetainedPageSnapshot(
  chromeApi: ChromeApi,
  page: RecoverablePageSnapshot,
  disposition: RetainedPageActivationDisposition,
  options: RetainedPageRecoveryOptions = {}
): Promise<boolean> {
  if (!isRetainedPageActivationEligible(page.url)) return false

  let liveTargetRead = await readExactLiveTarget(
    chromeApi,
    page,
    options.currentWindowId
  )
  if (!liveTargetRead.ok) return false
  if (
    page.surfaceKind === 'app' &&
    liveTargetRead.target &&
    !await confirmExactNormalTarget(chromeApi, liveTargetRead.target, page.url)
  ) {
    // The normal fallback can move into an app window after inventory was
    // read. Refresh once before mutation so that app target is ignored and a
    // fresh normal fallback can be created without touching it.
    liveTargetRead = await readExactLiveTarget(
      chromeApi,
      page,
      options.currentWindowId
    )
    if (!liveTargetRead.ok) return false
    if (
      liveTargetRead.target &&
      !await confirmExactNormalTarget(chromeApi, liveTargetRead.target, page.url)
    ) return false
  }
  if (liveTargetRead.target) {
    return recoverExactLiveTarget(
      chromeApi,
      page,
      liveTargetRead.target,
      liveTargetRead.normalWindowId,
      disposition,
      options
    )
  }

  if (disposition === 'new-window') {
    try {
      const created = await chromeApi.windows.create({
        url: page.url,
        focused: true,
        type: 'normal'
      })
      return !!created && confirmCreatedWindowTarget(chromeApi, created, page.url, options)
    } catch {
      return false
    }
  }

  return createNormalTab(
    chromeApi,
    page,
    disposition !== 'background-tab',
    liveTargetRead.normalWindowId,
    options
  )
}
