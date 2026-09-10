// Page functions for Activation History smoke measurements. Each runs in the
// page realm through evaluateInPage, so only page globals and the params
// argument are in scope.

export function findHistoryEntryHoverTarget(params: { label: string }): Promise<{ dismissX: number, x: number, y: number } | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const title = Array.from(document.querySelectorAll('.history-entry-title-truncated'))
        .find((candidate) => candidate.closest('.history-entry-row')?.textContent?.includes(params.label))
      const row = title?.closest('.history-entry-row')
      const entry = title?.closest('.history-entry')
      row?.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = title?.getBoundingClientRect()
      const entryRect = entry?.getBoundingClientRect()
      if (rect && rect.width > 120 && rect.height > 8 && entryRect && entryRect.width > 40) {
        resolve({
          dismissX: Math.round(entryRect.left + 20),
          x: Math.round(rect.left + Math.min(24, rect.width / 2)),
          y: Math.round(rect.top + rect.height / 2),
        })
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readExpandedHistoryEntryStyle() {
  const entry = document.querySelector('.history-entry-expanded')
  if (!entry) return null
  const styles = window.getComputedStyle(entry)
  return {
    cursor: styles.cursor,
    pointerEvents: styles.pointerEvents,
    userSelect: styles.userSelect,
  }
}
