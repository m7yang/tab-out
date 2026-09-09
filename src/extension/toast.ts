export type ToastAction = {
  label: string
  description?: string
  onClick: () => void | Promise<void>
}

export type ToastOptions = {
  /** A value of zero keeps the toast open until the user dismisses it. */
  timeout?: number
}

export type ToastPresenter = (
  title: string,
  action: ToastAction | null,
  options?: ToastOptions,
) => void

let toastPresenter: ToastPresenter | null = null

export function installToastPresenter(presenter: ToastPresenter): () => void {
  toastPresenter = presenter
  return () => {
    if (toastPresenter === presenter) toastPresenter = null
  }
}

export function showToast(
  title: string,
  action: ToastAction | null = null,
  options?: ToastOptions,
): void {
  toastPresenter?.(title, action, options)
}
