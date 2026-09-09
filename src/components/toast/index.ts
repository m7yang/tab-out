import { installToastPresenter } from '../../extension/toast.js'
import type { ToastPresenter } from '../../extension/toast.js'

type ToastRuntime = typeof import('./mountToast')

let toastRuntimePromise: Promise<ToastRuntime> | null = null

function loadToastRuntime(): Promise<ToastRuntime> {
  toastRuntimePromise ??= import('./mountToast').catch((error) => {
    toastRuntimePromise = null
    throw error
  })
  return toastRuntimePromise
}

const presentPageToast: ToastPresenter = (title, action, options) => {
  // Toasts are a page-only enhancement. Keep the React mount out of worker-like
  // contexts and out of the initial dashboard chunk until the first notice.
  if (
    typeof document === 'undefined' ||
    typeof document.getElementById !== 'function' ||
    !document.body
  ) return
  void loadToastRuntime()
    .then(({ showMountedToast }) => showMountedToast(title, action, options))
    .catch((error: unknown) => {
      console.error('Could not load toast UI', error)
    })
}

export function installPageToastPresenter(): () => void {
  return installToastPresenter(presentPageToast)
}
