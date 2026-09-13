import { useEffect, useRef, useState, type RefObject } from 'react'

/** Owns the trailing space and observes its actual end, including that space. */
export function DashboardScrollBottom({ scrollRegionRef }: { scrollRegionRef: RefObject<HTMLDivElement | null> }) {
  const endRef = useRef<HTMLSpanElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)

  useEffect(() => {
    const root = scrollRegionRef.current
    const end = endRef.current
    if (!root || !end) return

    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setCanScrollDown(entry.intersectionRatio < 1)
    }, {
      root,
      // Scroll offsets can be fractional; treat the final pixel as the end.
      rootMargin: '0px 0px 1px 0px',
      threshold: 1,
    })
    observer.observe(end)
    return () => observer.disconnect()
  }, [scrollRegionRef])

  return (
    <>
      {/* Keep the empty spacer out of first-paint layout-shift accounting. */}
      <div aria-hidden="true" className="pointer-events-none invisible relative h-12.5">
        <span ref={endRef} data-tabout-part="scroll-end" className="absolute bottom-0 left-0 size-px" />
      </div>
      {/* Stay in the scroller's stacking context, below expanded chip slots. */}
      <div aria-hidden="true" className="pointer-events-none sticky bottom-0 z-3 h-0">
        <div
          data-tabout-part="scroll-bottom-blur"
          data-visible={canScrollDown ? '' : undefined}
          className="absolute inset-x-0 bottom-0 h-(--dashboard-scroll-edge-height) bg-linear-to-b from-transparent to-(--paper) opacity-0 backdrop-blur-xs transition-opacity duration-160 ease-out mask-[linear-gradient(to_bottom,transparent,#000)] data-visible:opacity-100"
        />
      </div>
    </>
  )
}
