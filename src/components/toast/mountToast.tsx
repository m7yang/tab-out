import type { ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { Toast as BaseToast } from '@base-ui/react/toast'
import { cn } from '@/lib/utils'
import type { ToastAction, ToastOptions } from '../../extension/toast.js'

const baseToastManager = BaseToast.createToastManager()
const { promise: toastManagerReady, resolve: resolveToastManagerReady } = Promise.withResolvers<void>()
let markToastManagerReady: (() => void) | null = resolveToastManagerReady
// The external manager does not retain events sent before its Provider subscribes.
// Resolve the first lazy toast only after that subscription is installed.
const toastManager: typeof baseToastManager = {
  ...baseToastManager,
  ' subscribe': (listener) => {
    const unsubscribe = baseToastManager[' subscribe'](listener)
    markToastManagerReady?.()
    markToastManagerReady = null
    return unsubscribe
  },
}

let toastMounted = false

function mountToast() {
  if (toastMounted) return true
  const el = document.getElementById('toastRoot')
  if (!el) return false
  toastMounted = true
  createRoot(el).render(<Toast />)
  return true
}

export async function showMountedToast(
  title: string,
  action: ToastAction | null,
  options?: ToastOptions,
): Promise<void> {
  if (!mountToast()) return
  await toastManagerReady
  const toastId = toastManager.add({
    title,
    description: action?.description,
    type: 'success',
    ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    actionProps: action
      ? {
          children: action.label,
          onClick: () => {
            toastManager.close(toastId)
            void action.onClick()
          },
        }
      : undefined,
  })
}

function Toast() {
  return (
    <BaseToast.Provider toastManager={toastManager}>
      <BaseToast.Portal>
        {/* Inside the 288px toolbar popup the toast trades the dashboard's
           page insets for a uniform 6px margin matching the menu's density.
           Uniform beats a shadow-compensated bottom here: the 10%-opacity
           shadow is at the perception threshold in light mode and invisible
           against the dark popover, where a larger bottom would read as
           plain asymmetry. */}
        <BaseToast.Viewport className="fixed bottom-4 left-4 right-auto top-auto z-1 w-62.5 min-[500px]:bottom-8 min-[500px]:left-8 min-[500px]:w-75 [html[data-tabout-popup]_&]:bottom-1.5 [html[data-tabout-popup]_&]:left-1.5 [html[data-tabout-popup]_&]:w-69">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  )
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager()

  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      data-tabout="toast"
      className={cn(
        'group/toast absolute bottom-0 left-0 right-auto box-border w-full cursor-default select-none rounded-3xl [corner-shape:squircle] border border-[oklch(12%_0.036_264deg/7%)] bg-clip-padding p-4! text-[oklch(12%_0.02_264deg/90%)] [background:oklch(98%_0.001_264deg)] [box-shadow:0_2px_10px_rgb(0_0_0/0.1)] [font-synthesis:none] origin-[bottom_center]',
        '[--gap:0.75rem] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))] [--height:var(--toast-frontmost-height,var(--toast-height))]',
        '[--offset-y:calc(var(--toast-offset-y)*-1+(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] z-[calc(1000-var(--toast-index))] h-(--height)',
        'transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))]',
        '[transition:transform_0.5s_cubic-bezier(0.22,1,0.36,1),opacity_0.5s,height_0.15s]',
        'motion-reduce:[transition:opacity_0.1s,height_0.1s] motion-reduce:data-starting-style:transform-none! motion-reduce:data-ending-style:transform-none!',
        'after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-[""]',
        'data-expanded:h-(--toast-height) data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]',
        'data-starting-style:transform-[translateY(150%)] data-ending-style:opacity-0 data-ending-style:transform-[translateY(150%)] data-limited:opacity-0',
        '[&[data-ending-style][data-swipe-direction=down]]:transform-[translateY(calc(var(--toast-swipe-movement-y)+150%))]',
        '[&[data-ending-style][data-swipe-direction=up]]:transform-[translateY(calc(var(--toast-swipe-movement-y)-150%))]',
        '[&[data-ending-style][data-swipe-direction=left]]:transform-[translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]',
        '[&[data-ending-style][data-swipe-direction=right]]:transform-[translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]',
      )}
    >
      <BaseToast.Content className="overflow-hidden [transition:opacity_0.25s] data-behind:opacity-0 data-expanded:opacity-100">
        <BaseToast.Title className="m-0 text-[0.975rem] leading-5 font-bold" />
        <BaseToast.Description className="m-0 text-[0.925rem] leading-5" />
        <BaseToast.Action className="mt-2! inline-flex h-8 items-center justify-center rounded-xl [corner-shape:squircle] border-0 bg-[oklch(12%_0.02_264deg/90%)] px-3! text-[0.875rem] leading-5 font-normal text-[oklch(98%_0.001_264deg)] focus-visible:outline-2! focus-visible:-outline-offset-1! focus-visible:outline-[oklch(45%_0.2_264deg)]!" />
      </BaseToast.Content>
      <BaseToast.Close
        data-tabout-part="close-button"
        className="pointer-events-none absolute top-0 left-0 z-1 flex size-5 translate-x-[-35%] translate-y-[-35%] items-center justify-center rounded-full border border-[oklch(12%_0.036_264deg/7%)] bg-[oklch(98%_0.001_264deg)] p-0 text-[oklch(12%_0.02_264deg/62%)] opacity-0 transition-[opacity,background-color,border-color,color] duration-100 group-hover/toast:pointer-events-auto group-hover/toast:opacity-100 group-focus-within/toast:pointer-events-auto group-focus-within/toast:opacity-100 hover:border-[oklch(12%_0.036_264deg/11%)] hover:bg-[oklch(96%_0.003_264deg)] hover:text-[oklch(12%_0.02_264deg/90%)] focus-visible:outline-2! focus-visible:-outline-offset-1! focus-visible:outline-[oklch(45%_0.2_264deg)]! [html[data-tabout-popup]_&]:-translate-x-1/4"
        aria-label="Close"
      >
        <XIcon className="size-3" />
      </BaseToast.Close>
    </BaseToast.Root>
  ))
}

function XIcon(props: ComponentProps<'svg'>) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
