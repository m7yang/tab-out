// The interactive half of the popup, dynamic-imported by the paint-first
// boot in popup.ts after the prerendered shell commits its first frame.
// popup.html links the shared dist/assets/app.css directly: Tailwind scans
// source files, so the dashboard stylesheet already carries every popup
// class and the popup build stays a single standalone popup.js.
import { hydrateRoot } from 'react-dom/client'

import { TabActionsPopup } from './components/TabActionsPopup'
import { installPageToastPresenter } from './components/toast'
import { getAppRuntime } from './extension/app-runtime.js'

installPageToastPresenter()

const el = document.getElementById('popupRoot')
if (el) {
  hydrateRoot(el, <TabActionsPopup />, {
    onUncaughtError: (error, errorInfo) => {
      console.error('[tab-out] uncaught popup render error', error, errorInfo.componentStack)
    },
    onRecoverableError: (error, errorInfo) => {
      console.error('[tab-out] recoverable popup hydration error', error, errorInfo.componentStack)
    },
  })
}

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return
  void getAppRuntime().dispose()
})
