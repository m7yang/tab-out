import { useEffect, useEffectEvent } from 'react'

export type GlobalEventOptions = {
  /** Register in the capture phase so the listener sees events before targets. */
  capture?: boolean
  /** Detach while false; the listener re-attaches when it turns true again. */
  enabled?: boolean
}

type GlobalEventTargetKind = 'window' | 'document'

function resolveGlobalEventTarget(kind: GlobalEventTargetKind): EventTarget {
  return kind === 'window' ? window : document
}

/**
 * Attaches one listener to a global target for as long as `enabled` holds.
 * The listener is an effect event, so it always sees the latest render's
 * props and state while the subscription itself only re-attaches when the
 * event type or listener options change. The target resolves inside the
 * effect, so components using these hooks still render without a DOM.
 */
function useGlobalEvent<EventValue extends Event>(
  targetKind: GlobalEventTargetKind,
  type: string,
  listener: (event: EventValue) => void,
  { capture = false, enabled = true }: GlobalEventOptions,
): void {
  const handleEvent = useEffectEvent(listener)

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the returned cleanup removes this exact listener from the resolved target; the rule only recognises removal on a literal window/document receiver.
  useEffect(() => {
    // A disabled hook resolves no target, so subscribe and cleanup are no-ops.
    const target = enabled ? resolveGlobalEventTarget(targetKind) : null
    function onEvent(event: Event) {
      handleEvent(event as EventValue)
    }
    target?.addEventListener(type, onEvent, { capture })

    return () => target?.removeEventListener(type, onEvent, { capture })
  }, [capture, enabled, targetKind, type])
}

export function useWindowEvent<Type extends keyof WindowEventMap>(
  type: Type,
  listener: (event: WindowEventMap[Type]) => void,
  options: GlobalEventOptions = {},
): void {
  useGlobalEvent('window', type, listener, options)
}

export function useDocumentEvent<Type extends keyof DocumentEventMap>(
  type: Type,
  listener: (event: DocumentEventMap[Type]) => void,
  options: GlobalEventOptions = {},
): void {
  useGlobalEvent('document', type, listener, options)
}
