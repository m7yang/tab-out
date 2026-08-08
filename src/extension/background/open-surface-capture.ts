import type { OpenSurfaceObservation } from '../open-surface-inventory.js'
import { liveTabUrlForIdentity } from '../live-tab-matching.js'
import { unwrapSuspenderTitle, unwrapSuspenderUrl } from '../suspension.js'
import type { ChromeApi } from './chrome-api.js'

export type OpenSurfaceCheckpointCapture =
  | { readonly status: 'captured'; readonly observation: OpenSurfaceObservation }
  | { readonly status: 'ineligible' }
  | { readonly status: 'unavailable' }

function surfaceKindFromWindowType(
  windowType: chrome.windows.Window['type'] | undefined
): OpenSurfaceObservation['surfaceKind'] | null {
  if (windowType === undefined) return null
  return windowType === 'app' || windowType === 'popup' ? 'app' : 'normal-tab'
}

export function openSurfaceObservationFromTab(
  tab: chrome.tabs.Tab,
  windowType?: chrome.windows.Window['type']
): OpenSurfaceObservation | null {
  // Incognito must be rejected before unwrapping, parsing, or copying any
  // private URL or title into an observation that could reach shared storage.
  if (tab.incognito || typeof tab.id !== 'number') return null
  const surfaceKind = surfaceKindFromWindowType(windowType)
  if (surfaceKind === null) return null
  const rawUrl = liveTabUrlForIdentity(tab)
  const url = unwrapSuspenderUrl(rawUrl)
  const suspendedTitle = unwrapSuspenderTitle(rawUrl)
  return {
    tabId: tab.id,
    surfaceKind,
    url,
    ...(rawUrl && rawUrl !== url ? { rawUrl } : {}),
    title: suspendedTitle || tab.title || '',
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {})
  }
}

export async function captureOpenSurfaceObservation(
  chromeApi: ChromeApi,
  tab: chrome.tabs.Tab
): Promise<OpenSurfaceObservation | null> {
  const captured = await captureOpenSurfaceCheckpoint(chromeApi, tab)
  return captured.status === 'captured' ? captured.observation : null
}

/**
 * Preserve the difference between a surface that is definitely ineligible and
 * browser metadata that disappeared while Chrome was delivering a close. A
 * transient lookup failure must not authorize deletion of a previously valid
 * physical lifetime.
 */
export async function captureOpenSurfaceCheckpoint(
  chromeApi: ChromeApi,
  tab: chrome.tabs.Tab
): Promise<OpenSurfaceCheckpointCapture> {
  if (tab.incognito || typeof tab.id !== 'number') return { status: 'ineligible' }

  let windowType: chrome.windows.Window['type'] | undefined
  try {
    windowType = (await chromeApi.windows.get(tab.windowId)).type
  } catch {
    return { status: 'unavailable' }
  }
  const observation = openSurfaceObservationFromTab(tab, windowType)
  return observation
    ? { status: 'captured', observation }
    : { status: 'ineligible' }
}

export async function captureCurrentOpenSurfaceObservations(
  chromeApi: ChromeApi
): Promise<OpenSurfaceObservation[]> {
  const [tabs, windows] = await Promise.all([
    chromeApi.tabs.query({}),
    chromeApi.windows.getAll()
  ])
  const windowTypeById = new Map<number, chrome.windows.Window['type']>()
  for (const window of windows) {
    if (typeof window.id === 'number' && window.type) {
      windowTypeById.set(window.id, window.type)
    }
  }

  const observations: OpenSurfaceObservation[] = []
  for (const tab of tabs) {
    const observation = openSurfaceObservationFromTab(
      tab,
      windowTypeById.get(tab.windowId)
    )
    if (observation) observations.push(observation)
  }
  return observations
}
