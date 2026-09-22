import { pointWithinRect } from '../pointer-position'

/** Use Chrome's hit target to resolve the subpixel fringe of a surface. */
export function pointerWithinExpansionSurface(
  event: { clientX: number, clientY: number, target: EventTarget | null },
  surface: HTMLElement,
): boolean {
  const rect = surface.getBoundingClientRect()
  const point = { x: event.clientX, y: event.clientY }
  if (pointWithinRect(point, rect)) return true

  // Hit testing can select a surface just outside its fractional layout edge.
  // Require both the native target and the one-CSS-pixel fringe: overflowing
  // descendants (including an expansion closing during this event) must not
  // extend the resting slot's ownership arbitrarily far.
  return event.target instanceof Node && surface.contains(event.target) && pointWithinRect(point, {
    left: rect.left - 1,
    right: rect.right + 1,
    top: rect.top - 1,
    bottom: rect.bottom + 1,
  })
}
