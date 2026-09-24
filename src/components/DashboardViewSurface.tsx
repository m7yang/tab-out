import { useEffect, useRef, useState } from 'react'
import { createCapsuleGeometry, type CapsuleGeometry } from '@fleet/continuous-capsule'

interface Surface {
  width: number
  height: number
  geometry: CapsuleGeometry | null
}

/** Paints the measured control without changing its layout or hit target. */
export function DashboardViewSurface({ variant }: { variant: 'frame' | 'selection' | 'focus' }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [surface, setSurface] = useState<Surface | null>(null)

  useEffect(() => {
    const control = svgRef.current?.parentElement
    if (!control) return

    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0]
      if (!box) return
      const width = box.inlineSize
      // Keyboard focus retains the existing 4px vertical inset of each tab.
      const height = Math.max(0, box.blockSize - (variant === 'focus' ? 8 : 0))
      setSurface((previous) => previous?.width === width && previous.height === height
        ? previous
        : {
            width,
            height,
            geometry: createCapsuleGeometry({ width, height, borderWidth: variant === 'frame' ? 1 : 0 }),
          })
    })
    observer.observe(control, { box: 'border-box' })
    return () => observer.disconnect()
  }, [variant])

  const geometry = surface?.geometry
  return (
    <svg
      ref={svgRef}
      className={`dashboard-view-capsule dashboard-view-capsule-${variant}`}
      data-capsule-ready={geometry ? '' : undefined}
      width={surface?.width ?? 0}
      height={surface?.height ?? 0}
      viewBox={`0 0 ${surface?.width ?? 0} ${surface?.height ?? 0}`}
      style={{ width: surface?.width ?? 0, height: surface?.height ?? 0 }}
      aria-hidden="true"
      focusable="false"
    >
      {geometry && (
        <path
          transform={`translate(${geometry.inset} ${geometry.inset})`}
          d={geometry.surfacePath}
          strokeWidth={variant === 'focus' ? 2 : 1}
        />
      )}
    </svg>
  )
}
