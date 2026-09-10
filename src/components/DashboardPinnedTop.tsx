import { useEffect, useState, type ReactNode, type RefObject } from 'react'

type DashboardPinnedTopProps = {
  className: string
  scrollRegionRef: RefObject<HTMLDivElement | null>
  scrollSentinelRef: RefObject<HTMLSpanElement | null>
  children: ReactNode
}

/**
 * Reports whether the dashboard scroll region has left its top edge. A
 * one-pixel sentinel sits at the top of the region; while it stays fully
 * visible the region is unscrolled. IntersectionObserver delivers the initial
 * state and every later crossing, so the header needs no scroll listener and
 * its shadow keeps the time-based fade declared in base.css.
 */
function useScrollRegionScrolled(
  scrollRegionRef: RefObject<HTMLDivElement | null>,
  scrollSentinelRef: RefObject<HTMLSpanElement | null>,
): boolean {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const scrollRegion = scrollRegionRef.current
    const scrollSentinel = scrollSentinelRef.current
    if (!scrollRegion || !scrollSentinel) return

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      setScrolled(entry.intersectionRatio < 1)
    }, {
      root: scrollRegion,
      threshold: 1,
    })
    observer.observe(scrollSentinel)

    return () => observer.disconnect()
  }, [scrollRegionRef, scrollSentinelRef])

  return scrolled
}

/**
 * The header band pinned above the scroll region. Its `data-scrolled` flag is
 * the only state here, so a crossing re-renders this wrapper and not the
 * header content passed in as children.
 */
export function DashboardPinnedTop({ className, scrollRegionRef, scrollSentinelRef, children }: DashboardPinnedTopProps) {
  const scrolled = useScrollRegionScrolled(scrollRegionRef, scrollSentinelRef)

  return (
    <div data-scrolled={scrolled ? '' : undefined} className={className}>
      {children}
    </div>
  )
}
