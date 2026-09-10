import { useDocumentEvent, useWindowEvent } from '../../hooks/useGlobalEvent'
import { pointWithinRect } from '../pointer-position'
import type { TitleExpansionController } from './controller'

export type CloseOnOutsideActivityOptions = {
  /** The expansion this hook guards; listeners attach only while it is open. */
  expanded: boolean
  controller: TitleExpansionController
  /**
   * The pointer region that keeps the expansion open. Returning nothing keeps
   * the current pointer position from closing it.
   */
  getPointerRegion: () => DOMRect | undefined
}

/**
 * Closes an open title expansion when the pointer leaves its region, the
 * window blurs, or the page hides. Owners describe their region; the
 * controller still vetoes closes while a menu or keyboard focus holds them.
 */
export function useCloseOnOutsideActivity({ expanded, controller, getPointerRegion }: CloseOnOutsideActivityOptions): void {
  useWindowEvent('blur', () => {
    controller.closeNow()
  }, { enabled: expanded })

  useWindowEvent('pointermove', (event) => {
    const region = getPointerRegion()
    if (!region) return
    if (!pointWithinRect({ x: event.clientX, y: event.clientY }, region)) controller.close({ delayed: false })
  }, { capture: true, enabled: expanded })

  useDocumentEvent('visibilitychange', () => {
    if (document.hidden) controller.closeNow()
  }, { enabled: expanded })
}
