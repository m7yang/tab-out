import { createCapsuleGeometry } from '@fleet/continuous-capsule'

/** React ref adapter: change only the contour; CSS still owns all paint/states. */
export function attachCapsuleBorder(element: HTMLElement | null) {
  if (!element || !CSS.supports('border-shape', 'path("M0 0L1 0L1 1Z")')) return

  let previousSize = ''
  let borderBox: ResizeObserverSize | undefined
  function update() {
    if (!element) return
    const style = getComputedStyle(element)
    // Inline title labels can fragment. Keep their per-line CSS rounding instead
    // of applying one bounding-box path across several lines.
    const rects = element.getClientRects()
    const rect = rects.length === 1 ? rects[0] : undefined
    const inline = style.display === 'inline'
    const width = inline ? rect?.width ?? 0 : borderBox?.inlineSize ?? 0
    const height = inline ? rect?.height ?? 0 : borderBox?.blockSize ?? 0
    const borderWidth = Number.parseFloat(style.borderTopWidth)
    const size = `${width}:${height}:${borderWidth}`
    if (size === previousSize) return
    previousSize = size
    const geometry = createCapsuleGeometry({ width, height, borderWidth })
    if (geometry) {
      // The default half-border-box origin supplies the package's half-stroke inset.
      element.style.setProperty('border-shape', `path("${geometry.surfacePath}")`)
      // This pinned profile contains only absolute M/L/C coordinates. Translate
      // them into the padded paint box, retaining the half-stroke inset.
      const paddedPath = geometry.surfacePath.replace(/-?\d*\.?\d+/g, (value) => String(Number(value) + 1 + geometry.inset))
      element.style.setProperty('--capsule-border-width', `${borderWidth}px`)
      element.style.setProperty('--capsule-fill-shape', `path("${paddedPath}")`)
      element.dataset.capsuleReady = ''
    } else {
      element.style.removeProperty('border-shape')
      element.style.removeProperty('--capsule-fill-shape')
      element.style.removeProperty('--capsule-border-width')
      delete element.dataset.capsuleReady
    }
  }

  const resize = new ResizeObserver((entries) => {
    const entry = entries.find((entry) => entry.target === element)
    if (entry) borderBox = entry.borderBoxSize[0]
    update()
  })
  resize.observe(element, { box: 'border-box' })
  // Non-replaced inline labels don't emit resize notifications. Their containing
  // line does, and text/class mutations cover label changes without line resizing.
  if (element.parentElement) resize.observe(element.parentElement)
  const mutations = new MutationObserver(update)
  mutations.observe(element, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true })
  return () => {
    resize.disconnect()
    mutations.disconnect()
    element.style.removeProperty('border-shape')
    element.style.removeProperty('--capsule-fill-shape')
    element.style.removeProperty('--capsule-border-width')
    delete element.dataset.capsuleReady
  }
}
