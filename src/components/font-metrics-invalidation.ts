type FontMetricsSubscriber = () => void

const subscribers = new Set<FontMetricsSubscriber>()
let observedFontSet: FontFaceSet | null = null
let readyGeneration = 0
let notificationQueued = false

function notifySubscribers(): void {
  if (notificationQueued) return
  notificationQueued = true
  queueMicrotask(() => {
    notificationQueued = false
    for (const subscriber of subscribers) {
      try {
        subscriber()
      } catch {}
    }
  })
}

function onFontLoadingSettled(): void {
  notifySubscribers()
}

function attachFontSet(fontSet: FontFaceSet): void {
  if (observedFontSet === fontSet) return
  if (observedFontSet) {
    observedFontSet.removeEventListener('loadingdone', onFontLoadingSettled)
    observedFontSet.removeEventListener('loadingerror', onFontLoadingSettled)
  }

  observedFontSet = fontSet
  const generation = ++readyGeneration
  fontSet.addEventListener('loadingdone', onFontLoadingSettled)
  fontSet.addEventListener('loadingerror', onFontLoadingSettled)
  if (fontSet.status !== 'loaded') {
    void fontSet.ready.then(() => {
      if (generation === readyGeneration && observedFontSet === fontSet) notifySubscribers()
    })
  }
}

function detachFontSetIfIdle(): void {
  if (subscribers.size > 0 || !observedFontSet) return
  observedFontSet.removeEventListener('loadingdone', onFontLoadingSettled)
  observedFontSet.removeEventListener('loadingerror', onFontLoadingSettled)
  observedFontSet = null
  readyGeneration += 1
}

/**
 * Shares one FontFaceSet listener across every measured dashboard title. A
 * font settlement invalidates all registered metrics in one microtask instead
 * of installing a document-level listener for every Page Chip/history row.
 */
export function subscribeFontMetricsInvalidation(subscriber: FontMetricsSubscriber): () => void {
  subscribers.add(subscriber)
  attachFontSet(document.fonts)

  return () => {
    subscribers.delete(subscriber)
    detachFontSetIfIdle()
  }
}
