import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DashboardChipEnv } from '../extension/types'

const PROGRESSIVE_FOLDED_ENV_THRESHOLD = 80
const PROGRESSIVE_FOLDED_ENV_INITIAL_COUNT = 24
const PROGRESSIVE_FOLDED_ENV_CHUNK_SIZE = 24

type ProgressiveFoldedEnvListProps = {
  envs: readonly DashboardChipEnv[]
  renderEnv: (env: DashboardChipEnv) => ReactNode
}

export function ProgressiveFoldedEnvList({ envs, renderEnv }: ProgressiveFoldedEnvListProps) {
  const progressive = envs.length > PROGRESSIVE_FOLDED_ENV_THRESHOLD
  const initialVisibleCount = progressive
    ? Math.min(PROGRESSIVE_FOLDED_ENV_INITIAL_COUNT, envs.length)
    : envs.length
  const [mountedCount, setMountedCount] = useState(initialVisibleCount)
  const visibleCount = progressive
    ? Math.min(Math.max(mountedCount, initialVisibleCount), envs.length)
    : envs.length
  const remaining = Math.max(0, envs.length - visibleCount)
  const sentinelRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || remaining === 0) return

    const root = sentinel.closest<HTMLElement>('[data-tabout-part="scroll-region"]')
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      setMountedCount((currentCount) => Math.min(
        envs.length,
        Math.max(currentCount, visibleCount) + PROGRESSIVE_FOLDED_ENV_CHUNK_SIZE
      ))
    }, {
      root,
      rootMargin: '0px 0px 480px 0px'
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [envs.length, remaining, visibleCount])

  return (
    <>
      {envs.slice(0, visibleCount).map(renderEnv)}
      {remaining > 0 && (
        <span
          ref={sentinelRef}
          data-tabout-part="progressive-env-sentinel"
          data-tabout-progressive-remaining={remaining}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
          aria-hidden="true"
        />
      )}
    </>
  )
}
