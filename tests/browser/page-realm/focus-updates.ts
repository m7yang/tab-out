// Page functions that record the tab and window focus updates the dashboard
// issues through the Chrome API while a smoke scenario clicks around. Each
// runs in the page realm through evaluateInPage.

export type FocusUpdate = { kind: 'tab' | 'window', args: unknown[] }

type MutableChromeApi = {
  update: (...args: unknown[]) => Promise<unknown>
}

type FocusUpdateWindow = Window & {
  __tabOutSmokeFocusUpdates: FocusUpdate[]
  __tabOutSmokeOriginalTabsUpdate?: MutableChromeApi['update']
  __tabOutSmokeOriginalWindowsUpdate?: MutableChromeApi['update']
}

export function installFocusUpdateStubs(params: { scrollSelector: string }): void {
  document.querySelector(params.scrollSelector)?.scrollTo(0, 0)
  const smokeWindow = window as unknown as FocusUpdateWindow
  const tabs = chrome.tabs as unknown as MutableChromeApi
  const windows = chrome.windows as unknown as MutableChromeApi
  smokeWindow.__tabOutSmokeFocusUpdates = []
  const originalTabsUpdate = smokeWindow.__tabOutSmokeOriginalTabsUpdate ?? tabs.update
  const originalWindowsUpdate = smokeWindow.__tabOutSmokeOriginalWindowsUpdate ?? windows.update
  smokeWindow.__tabOutSmokeOriginalTabsUpdate = originalTabsUpdate
  smokeWindow.__tabOutSmokeOriginalWindowsUpdate = originalWindowsUpdate
  tabs.update = async (...args) => {
    smokeWindow.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
    return originalTabsUpdate(...args)
  }
  windows.update = async (...args) => {
    smokeWindow.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
    return originalWindowsUpdate(...args)
  }
}

export function collectFocusUpdates(): FocusUpdate[] {
  const smokeWindow = window as unknown as FocusUpdateWindow
  const tabs = chrome.tabs as unknown as MutableChromeApi
  const windows = chrome.windows as unknown as MutableChromeApi
  const focusUpdates = smokeWindow.__tabOutSmokeFocusUpdates || []
  if (smokeWindow.__tabOutSmokeOriginalTabsUpdate) tabs.update = smokeWindow.__tabOutSmokeOriginalTabsUpdate
  if (smokeWindow.__tabOutSmokeOriginalWindowsUpdate) windows.update = smokeWindow.__tabOutSmokeOriginalWindowsUpdate
  return focusUpdates
}
