const PAGE_CHIP_FOCUS_TARGET_SELECTOR = [
  '[data-tabout="page-chip"][tabindex="0"]',
  'button.chip-env',
  'button.chip-title-variant'
].join(', ')

const FILTER_QUERY_INPUT_SELECTOR = '[data-tabout="filter-query"] [data-tabout-part="input"]'
const RETAINED_PAGE_IDENTITY_ATTRIBUTE = 'data-tabout-retained-page-identity'
const RETAINED_PAGE_CLOSURE_TOKEN_ATTRIBUTE = 'data-tabout-retained-page-closure-token'

type FocusCandidate = {
  element: HTMLElement
  removalKey: string | null
}

export type PageChipFocusRecovery = {
  complete: (targetDisappears: boolean) => void
  cancel: () => void
}

function visiblePageChipFocusTargets(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(PAGE_CHIP_FOCUS_TARGET_SELECTOR))
    .filter((element) => (
      element.isConnected &&
      !element.closest('[inert]') &&
      !element.closest('.closing') &&
      element.getClientRects().length > 0
    ))
}

function focusRemovalKey(element: HTMLElement): string | null {
  return element.closest<HTMLElement>('[data-tabout-removal-key]')
    ?.dataset.taboutRemovalKey ?? null
}

function describeFocusCandidate(element: HTMLElement): FocusCandidate {
  return {
    element,
    removalKey: focusRemovalKey(element)
  }
}

export function resolvePageChipFocusRecoveryCard(
  ownerDocument: Document,
  capturedCard: HTMLElement,
  missionGridId: string | undefined,
  domain: string | undefined
): HTMLElement | null {
  if (capturedCard.isConnected) return capturedCard
  if (!missionGridId || !domain) return null
  const missionGrid = ownerDocument.getElementById(missionGridId)
  if (!missionGrid) return null
  return Array.from(missionGrid.querySelectorAll<HTMLElement>('[data-tabout="domain-card"]'))
    .find((card) => card.dataset.taboutDomain === domain) ?? null
}

function resolveFocusCandidate(
  candidate: FocusCandidate,
  card: HTMLElement | null
): HTMLElement | null {
  if (
    candidate.element.isConnected &&
    !candidate.element.closest('[inert]') &&
    !candidate.element.closest('.closing') &&
    candidate.element.getClientRects().length > 0
  ) {
    return candidate.element
  }
  if (!card || !candidate.removalKey) return null
  return visiblePageChipFocusTargets(card)
    .find((element) => focusRemovalKey(element) === candidate.removalKey) ?? null
}

function focusCanStillTransfer(
  ownerDocument: Document,
  origin: HTMLElement
): 'ready' | 'wait' | 'cancel' {
  const activeElement = ownerDocument.activeElement
  if (
    !activeElement ||
    activeElement === ownerDocument.body ||
    activeElement === ownerDocument.documentElement ||
    activeElement === origin ||
    origin.contains(activeElement)
  ) {
    return 'ready'
  }
  if (
    activeElement instanceof HTMLElement &&
    activeElement.closest('[data-slot="context-menu-content"]')
  ) {
    return 'wait'
  }
  return 'cancel'
}

function retainedSnapshotStillRendered(
  origin: HTMLElement,
  identityDigest: string,
  closureToken: string
): boolean {
  return origin.isConnected &&
    origin.getAttribute(RETAINED_PAGE_IDENTITY_ATTRIBUTE) === identityDigest &&
    origin.getAttribute(RETAINED_PAGE_CLOSURE_TOKEN_ATTRIBUTE) === closureToken
}

/**
 * Capture focus order before an exact retained target triggers a Dashboard
 * refresh. Completion waits until the acted-on snapshot actually leaves the
 * DOM, including when foreground activation keeps Tab Out hidden until later.
 */
export function capturePageChipFocusRecovery(
  originValue: EventTarget | null | undefined
): PageChipFocusRecovery | null {
  if (!(originValue instanceof HTMLElement)) return null
  const origin = originValue
  const identityDigest = origin.getAttribute(RETAINED_PAGE_IDENTITY_ATTRIBUTE)
  const closureToken = origin.getAttribute(RETAINED_PAGE_CLOSURE_TOKEN_ATTRIBUTE)
  if (!identityDigest || !closureToken) return null
  const capturedIdentityDigest = identityDigest
  const capturedClosureToken = closureToken

  const ownerDocument = origin.ownerDocument
  const activeElement = ownerDocument.activeElement
  if (activeElement !== origin && !origin.contains(activeElement)) return null

  const capturedCard = origin.closest<HTMLElement>('[data-tabout="domain-card"]')
  if (!capturedCard) return null
  const capturedDomainCard = capturedCard
  const targets = visiblePageChipFocusTargets(capturedDomainCard)
  const originIndex = targets.indexOf(origin)
  if (originIndex < 0) return null

  const originCandidate = describeFocusCandidate(origin)
  const nextCandidates = targets.slice(originIndex + 1).map(describeFocusCandidate)
  const previousCandidates = targets.slice(0, originIndex)
    .reverse()
    .map(describeFocusCandidate)
  const domain = capturedDomainCard.dataset.taboutDomain
  const missionGridId = capturedDomainCard.closest<HTMLElement>('.missions[id]')?.id
  let completed = false
  let disposed = false
  let observer: MutationObserver | null = null
  let animationFrame = 0

  function dispose() {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    observer = null
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    ownerDocument.removeEventListener('visibilitychange', schedule)
    ownerDocument.removeEventListener('focusin', onFocusIn)
  }

  function onFocusIn(event: FocusEvent) {
    if (!completed || event.target === origin || origin.contains(event.target as Node)) return
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('[data-slot="context-menu-content"]')
    ) {
      return
    }
    dispose()
  }

  function recoverFocus() {
    animationFrame = 0
    if (disposed || !completed || ownerDocument.visibilityState !== 'visible') return
    if (retainedSnapshotStillRendered(origin, capturedIdentityDigest, capturedClosureToken)) return

    const transferState = focusCanStillTransfer(ownerDocument, origin)
    if (transferState === 'wait') return
    if (transferState === 'cancel') {
      dispose()
      return
    }

    const card = resolvePageChipFocusRecoveryCard(
      ownerDocument,
      capturedDomainCard,
      missionGridId,
      domain
    )
    const replacement = resolveFocusCandidate(originCandidate, card)
    if (replacement) {
      // React may reuse the same HTMLElement for the chip promoted into this
      // slot. The retained identity/token check above proves it is no longer
      // the acted-on snapshot, even when object identity is unchanged.
      replacement.focus({ preventScroll: true })
      dispose()
      return
    }
    for (const candidate of nextCandidates) {
      const target = resolveFocusCandidate(candidate, card)
      if (!target) continue
      target.focus({ preventScroll: true })
      dispose()
      return
    }

    // Overflow chips are progressively mounted. If the focused last-visible
    // chip disappears, its next logical target may only enter the DOM after
    // the refreshed projection promotes it. It occupies the removed target's
    // prior visible index.
    const promotedTarget = card
      ? visiblePageChipFocusTargets(card)[originIndex] ?? null
      : null
    if (promotedTarget) {
      promotedTarget.focus({ preventScroll: true })
      dispose()
      return
    }

    for (const candidate of previousCandidates) {
      const target = resolveFocusCandidate(candidate, card)
      if (!target) continue
      target.focus({ preventScroll: true })
      dispose()
      return
    }

    ownerDocument.querySelector<HTMLElement>(FILTER_QUERY_INPUT_SELECTOR)
      ?.focus({ preventScroll: true })
    dispose()
  }

  function schedule() {
    if (disposed || !completed || ownerDocument.visibilityState !== 'visible') return
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    animationFrame = requestAnimationFrame(recoverFocus)
  }

  return {
    complete(targetDisappears) {
      if (!targetDisappears) {
        dispose()
        return
      }
      completed = true
      observer = new MutationObserver(schedule)
      observer.observe(ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: [
          RETAINED_PAGE_IDENTITY_ATTRIBUTE,
          RETAINED_PAGE_CLOSURE_TOKEN_ATTRIBUTE
        ],
        childList: true,
        subtree: true
      })
      ownerDocument.addEventListener('visibilitychange', schedule)
      ownerDocument.addEventListener('focusin', onFocusIn)
      schedule()
    },
    cancel: dispose
  }
}
