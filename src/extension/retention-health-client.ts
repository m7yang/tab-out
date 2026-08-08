import type { RetentionHealthEpisode } from './retention-health.js'
import { showToast } from './toast.js'

interface RetentionHealthVisibility {
  readonly isVisible: () => boolean
  readonly subscribe: (listener: () => void) => () => void
}

interface RetentionHealthReporterOptions {
  readonly notify: (message: string) => void
  readonly visibility: RetentionHealthVisibility
}

function episodeKey(episode: RetentionHealthEpisode): string {
  return [
    episode.startedAt,
    episode.failureKind,
    episode.operationKind,
    episode.retryState
  ].join(':')
}

export function retentionHealthNotice(episode: RetentionHealthEpisode): string {
  return episode.failureKind === 'capture'
    ? "Some closed pages couldn't be retained"
    : "Some closed pages couldn't be restored."
}

export function createRetentionHealthReporter({
  notify,
  visibility
}: RetentionHealthReporterOptions): (
  episode: RetentionHealthEpisode | null
) => void {
  const reportedEpisodeKeys = new Set<string>()
  let pending: RetentionHealthEpisode | null = null
  let unsubscribe: (() => void) | null = null

  function stopWaiting(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  function flush(): void {
    if (!pending || !visibility.isVisible()) return
    const candidate = pending
    pending = null
    stopWaiting()
    const key = episodeKey(candidate)
    if (reportedEpisodeKeys.has(key)) return
    reportedEpisodeKeys.add(key)
    try {
      notify(retentionHealthNotice(candidate))
    } catch {}
  }

  return (episode) => {
    if (!episode) {
      pending = null
      stopWaiting()
      return
    }
    if (reportedEpisodeKeys.has(episodeKey(episode))) return
    pending = episode
    if (visibility.isVisible()) {
      flush()
    } else if (!unsubscribe) {
      unsubscribe = visibility.subscribe(flush)
    }
  }
}

const browserVisibility: RetentionHealthVisibility = {
  isVisible: () => globalThis.document?.visibilityState !== 'hidden',
  subscribe: (listener) => {
    globalThis.document?.addEventListener('visibilitychange', listener)
    return () => globalThis.document?.removeEventListener('visibilitychange', listener)
  }
}

export const reportRetentionHealthEpisode = createRetentionHealthReporter({
  notify: showToast,
  visibility: browserVisibility
})
