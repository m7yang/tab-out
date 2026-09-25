import { useEffect, useState, type RefObject } from 'react'
import { createCapsuleGeometry, type CapsuleSurfaceGeometry } from '@fleet/continuous-capsule'

interface Surface {
  width: number
  height: number
  geometry: CapsuleSurfaceGeometry | null
}

/** Decoration only: the native input keeps its focus, events, and startup identity. */
export function HeaderFilterSurface({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const [surface, setSurface] = useState<Surface | null>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return

    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0]
      if (!box) return
      const { inlineSize: width, blockSize: height } = box
      // Geometry is cached with its measured dimensions, independent of query or theme.
      setSurface((previous) => previous?.width === width && previous.height === height
        ? previous
        : { width, height, geometry: createCapsuleGeometry({ width, height, includeFocus: false }) })
    })
    observer.observe(input, { box: 'border-box' })
    return () => observer.disconnect()
  }, [inputRef])

  if (!surface?.geometry) return null
  const { width, height, geometry } = surface
  return (
    <svg
      className="header-filter-surface"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`translate(${geometry.inset} ${geometry.inset})`}>
        <path className="header-filter-shadow" d={geometry.surfacePath} fill="none" strokeWidth={1} />
        <path className="header-filter-border" d={geometry.surfacePath} strokeWidth={1} />
        <path className="header-filter-focus" d={geometry.surfacePath} fill="none" strokeWidth={1} />
      </g>
    </svg>
  )
}
