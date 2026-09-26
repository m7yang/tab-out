import { useEffect, useRef, type RefObject } from 'react'
import { createCapsuleGeometry } from '@fleet/continuous-capsule'

const DURATION = 120
type FrameKind = 'card' | 'page-chip'
const FRAME_OPTIONS = {
  card: {
    selector: '[data-tabout="domain-card"]:has(.page-chip-hover-match, .page-chip-overflow-hover-match)',
    attribute: 'data-history-match-frame',
    part: 'history-match-frame',
    outset: 8,
    className: 'pointer-events-none absolute top-0 left-0 box-border rounded-history-match-card border border-neutral-600/35 contain-strict [corner-shape:squircle]',
  },
  'page-chip': {
    selector: '.page-chip-hover-match, .page-chip-overflow-hover-match',
    attribute: 'data-history-page-match-frame',
    part: 'history-page-match-frame',
    outset: 0,
    // Keep the outside outline visible; paint containment would clip it.
    className: 'pointer-events-none absolute top-0 left-0 z-3 box-border outline-1 outline-offset-1 outline-(--accent-amber) contain-layout [corner-shape:squircle]',
  },
}

/** Presentation only: matching and preview ownership stay with the Page Chips. */
export function HistoryMatchFrame({ scrollRegionRef, kind = 'card' }: { scrollRegionRef: RefObject<HTMLDivElement | null>, kind?: FrameKind }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const capsulePathRef = useRef<SVGPathElement>(null)
  const options = FRAME_OPTIONS[kind]

  useEffect(() => {
    const root = scrollRegionRef.current
    const frame = frameRef.current
    if (!root || !frame) return

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    let pointerInput = false
    let scheduled = 0
    let animation: Animation | undefined
    let target: HTMLElement | undefined
    let lastTarget: HTMLElement | undefined
    let departedAt = -Infinity
    let departedBounds: DOMRect | undefined
    let destination = ''
    let capsule = false

    function paintCapsule(width: number, height: number) {
      const path = capsulePathRef.current
      if (!frame || !path) return
      const geometry = capsule ? createCapsuleGeometry({ width, height, borderWidth: 0, focusGap: 1, focusWidth: 1 }) : null
      if (geometry) {
        path.setAttribute('d', geometry.focusPath)
        frame.dataset.historyMatchCapsule = ''
      } else {
        delete frame.dataset.historyMatchCapsule
      }
    }

    function cancelMotion() {
      animation?.cancel()
      animation = undefined
    }

    const update = () => {
      scheduled = 0
      const matches = root.querySelectorAll<HTMLElement>(options.selector)
      const candidate = matches.length === 1 ? matches[0] : undefined
      // Expanded chips need their local stacking context. Icon-only chips
      // retain their existing kind-specific resting rings and match paint.
      const localChip = kind === 'page-chip' && candidate?.matches('.page-chip-expanded, .page-chip-icon-only')
      // CSS transform transitions don't emit mutations on each frame. Keep
      // outlines in the moving surface's coordinate space until FLIP cleanup.
      const movingTarget = candidate?.closest('.layout-moving, .intra-card-layout-moving')
      const next = localChip || movingTarget ? undefined : candidate
      if (!next) {
        if (target) {
          departedAt = performance.now()
          lastTarget = target
          departedBounds = frame.getBoundingClientRect()
          resizeObserver.unobserve(target)
        }
        target = undefined
        destination = ''
        cancelMotion()
        frame.hidden = true
        root.removeAttribute(options.attribute)
        // Multiple matches keep their existing independent frames. Never pick
        // an arbitrary card or carry a single frame out of that ambiguous set.
        if (matches.length > 1 || localChip || movingTarget) lastTarget = undefined
        return
      }

      const bounds = next.getBoundingClientRect()
      const container = root.getBoundingClientRect()
      const x = bounds.left - container.left - root.clientLeft + root.scrollLeft - options.outset
      const y = bounds.top - container.top - root.clientTop + root.scrollTop - options.outset
      const width = bounds.width + options.outset * 2
      const height = bounds.height + options.outset * 2
      capsule = kind === 'page-chip' && next.hasAttribute('data-capsule-ready')
      const targetStyle = kind === 'page-chip' ? getComputedStyle(next) : undefined
      const targetRadius = targetStyle?.borderRadius ?? ''
      const targetCorner = targetStyle?.getPropertyValue('corner-shape') ?? ''
      const nextDestination = `${x},${y},${width},${height},${capsule},${targetRadius},${targetCorner}`
      if (next === target && nextDestination === destination) return

      const previous = frame.hidden && departedBounds ? departedBounds : frame.getBoundingClientRect()
      const previousTarget = target ?? (performance.now() - departedAt <= DURATION ? lastTarget : undefined)
      const inViewport = (rect: DOMRect) => rect.bottom > container.top && rect.top < container.bottom && rect.right > container.left && rect.left < container.right
      const move = pointerInput && !reducedMotion.matches && previousTarget && previousTarget !== next &&
        previous.width > 0 && inViewport(previous) && inViewport(bounds)
      if (target !== next) {
        if (target) resizeObserver.unobserve(target)
        resizeObserver.observe(next)
      }
      target = next
      lastTarget = next
      destination = nextDestination
      cancelMotion()
      frame.hidden = false
      frame.style.transform = `translate(${x}px, ${y}px)`
      frame.style.width = `${width}px`
      frame.style.height = `${height}px`
      if (kind === 'page-chip') {
        frame.style.borderRadius = targetRadius
        frame.style.setProperty('corner-shape', targetCorner)
        paintCapsule(move ? previous.width : width, move ? previous.height : height)
      }
      root.setAttribute(options.attribute, '')

      if (move) {
        // Animate the isolated, absolutely positioned frame's dimensions:
        // scaling the border would distort its 1px stroke and target contour.
        animation = frame.animate([
          {
            transform: `translate(${previous.left - container.left - root.clientLeft + root.scrollLeft}px, ${previous.top - container.top - root.clientTop + root.scrollTop}px)`,
            // react-doctor-disable-next-line react-doctor/no-layout-property-animation -- ADR 0042: this contained, absolute decorative frame resizes to preserve a constant stroke and squircle radius; card layout is untouched.
            width: `${previous.width}px`,
            // react-doctor-disable-next-line react-doctor/no-layout-property-animation -- Same isolated-frame geometry exception as width; scaling would distort the border.
            height: `${previous.height}px`,
          },
          // react-doctor-disable-next-line react-doctor/no-layout-property-animation -- ADR 0042: only the contained decorative frame changes size, never dashboard content.
          { transform: frame.style.transform, width: frame.style.width, height: frame.style.height },
        ], { duration: DURATION, easing: getComputedStyle(frame).getPropertyValue('--ease-swift').trim() })
      }
    }

    function schedule() {
      if (!scheduled) scheduled = requestAnimationFrame(update)
    }
    function onPointer() {
      pointerInput = true
    }
    function onKeyboard() {
      pointerInput = false
      cancelMotion()
    }
    function onMotionPreference() {
      if (reducedMotion.matches) cancelMotion()
    }

    const resizeObserver = new ResizeObserver((entries) => {
      // ResizeObserver runs after animated layout and before paint. Draw the
      // offset contour at the rendered size, avoiding Chromium's native
      // border-shape outline artifacts without scaling the 1px SVG stroke.
      for (const entry of entries) {
        if (entry.target === frame) {
          const box = entry.borderBoxSize[0]
          if (box) paintCapsule(box.inlineSize, box.blockSize)
        }
      }
      if (entries.some((entry) => entry.target !== frame)) schedule()
    })
    resizeObserver.observe(root)
    if (kind === 'page-chip') resizeObserver.observe(frame, { box: 'border-box' })
    const mutations = new MutationObserver((records) => {
      // The overlay's own animation and geometry writes cannot feed back into
      // the observer. Root class/style changes do matter: card-motion-bleed
      // cleanup shifts its coordinate origin without resizing the content box.
      if (records.some((record) =>
        !(record.target instanceof Element && record.target.matches('[data-tabout-part="history-match-frame"], [data-tabout-part="history-page-match-frame"]')))) schedule()
    })
    mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-capsule-ready'] })
    document.addEventListener('pointerover', onPointer, true)
    document.addEventListener('keydown', onKeyboard, true)
    document.addEventListener('focusin', onKeyboard, true)
    // The frame shares the cards' scroll coordinate space, so scrolling needs
    // no listener or per-scroll measurement.
    root.addEventListener('transitionend', schedule)
    reducedMotion.addEventListener('change', onMotionPreference)
    schedule()
    return () => {
      cancelAnimationFrame(scheduled)
      cancelMotion()
      mutations.disconnect()
      resizeObserver.disconnect()
      document.removeEventListener('pointerover', onPointer, true)
      document.removeEventListener('keydown', onKeyboard, true)
      document.removeEventListener('focusin', onKeyboard, true)
      root.removeEventListener('transitionend', schedule)
      reducedMotion.removeEventListener('change', onMotionPreference)
      root.removeAttribute(options.attribute)
    }
  }, [scrollRegionRef, options, kind])

  return (
    <div
      ref={frameRef}
      data-tabout-part={options.part}
      aria-hidden="true"
      hidden
      className={options.className}
    >
      {kind === 'page-chip' && (
        <svg className="history-match-capsule absolute inset-0 hidden size-full overflow-visible" aria-hidden="true" focusable="false">
          <path ref={capsulePathRef} fill="none" stroke="var(--accent-amber)" strokeWidth={1} />
        </svg>
      )}
    </div>
  )
}
