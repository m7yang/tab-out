import { useCallback, useEffect, useRef, useState } from 'react'
import { useUrlPreview } from './useUrlPreview'
import { createNativeTabHighlightController } from '../extension/native-tab-highlight.js'
import { createHoverStateStore, type HoverUrlSource } from '../lib/hover-state.js'

/**
 * Owns the cross-dashboard hover-match state (which url/source is being hovered
 * and the related urls to highlight) together with the url preview it drives.
 * `clearHoverUrlNow` is stable so it can be used as an effect dependency.
 */
export function useHoverMatch() {
  const { urlPreviewStore, setUrlPreview, clearUrlPreviewNow } = useUrlPreview()
  const [hoverStateStore] = useState(createHoverStateStore)
  const [nativeTabHighlightController] = useState(createNativeTabHighlightController)
  const hoverOwnerRef = useRef<string | undefined>(undefined)

  const handleHoverUrlChange = useCallback(function handleHoverUrlChange(url: string, source: HoverUrlSource = 'chip', matchUrls?: readonly string[], tabId?: number, owner?: string) {
    const nextUrl = url || ''
    if (!nextUrl && owner !== undefined && hoverOwnerRef.current !== owner) return
    hoverOwnerRef.current = nextUrl ? owner : undefined
    const nextUrls = nextUrl
      ? [...new Set((matchUrls && matchUrls.length > 0 ? matchUrls : [nextUrl]).filter(Boolean))]
      : []
    const nextSource = nextUrls.length > 0 ? source : null
    hoverStateStore.setSnapshot({ url: nextUrl, urls: nextUrls, source: nextSource })
    setUrlPreview(nextUrl)
    return nativeTabHighlightController.setTarget(nextUrl ? tabId : null)
  }, [hoverStateStore, nativeTabHighlightController, setUrlPreview])

  const clearHoverUrlNow = useCallback(function clearHoverUrlNow() {
    hoverOwnerRef.current = undefined
    hoverStateStore.setSnapshot({ url: '', urls: [], source: null })
    clearUrlPreviewNow()
    return nativeTabHighlightController.clear()
  }, [clearUrlPreviewNow, hoverStateStore, nativeTabHighlightController])

  useEffect(() => () => {
    void nativeTabHighlightController.clear()
  }, [nativeTabHighlightController])

  return { hoverStateStore, urlPreviewStore, handleHoverUrlChange, clearHoverUrlNow }
}
