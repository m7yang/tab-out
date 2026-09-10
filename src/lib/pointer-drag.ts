export type PointerDragHandlers = {
  onMove: (event: PointerEvent) => void
  /** The pointer was released; listeners are already detached when this runs. */
  onEnd: (event: PointerEvent) => void
  /** The drag was cancelled by the browser or the window lost focus. */
  onCancel: () => void
}

export type PointerDragHandle = {
  /** Detach every listener without invoking a handler. */
  dispose: () => void
}

type PointerDragTarget = Pick<EventTarget, 'addEventListener'>

/**
 * Owns the window-level listener lifecycle of one pointer drag: moves stream
 * to `onMove`, a release ends the drag, and pointer cancellation or window
 * blur cancels it. Pointer listeners register in the capture phase so a
 * target that stops propagation cannot strand the drag.
 */
export function startPointerDrag(
  handlers: PointerDragHandlers,
  { target = window }: { target?: PointerDragTarget } = {},
): PointerDragHandle {
  const controller = new AbortController()
  const { signal } = controller
  const pointerOptions = { capture: true, signal }

  function finish(run: () => void) {
    controller.abort()
    run()
  }

  target.addEventListener('pointermove', (event) => handlers.onMove(event as PointerEvent), pointerOptions)
  target.addEventListener('pointerup', (event) => finish(() => handlers.onEnd(event as PointerEvent)), pointerOptions)
  target.addEventListener('pointercancel', () => finish(handlers.onCancel), pointerOptions)
  target.addEventListener('blur', () => finish(handlers.onCancel), { signal })

  return {
    dispose: () => controller.abort(),
  }
}
