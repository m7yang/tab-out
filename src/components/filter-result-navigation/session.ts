import {
  EMPTY_FILTER_RESULT_SELECTION,
  filterResultKeyboardIntent,
  reconcileFilterResultSelection,
  reconcileVisibleFilterResultSelection,
  selectAdjacentFilterResult,
  selectHorizontalFilterResult,
  type FilterResultCandidate,
  type FilterResultKeyboardEvent,
  type FilterResultMoveDirection,
  type FilterResultSelection,
  type PositionedFilterResultCandidate,
} from '../../extension/filter-result-navigation.js'
import type { DashboardView } from '../../extension/dashboard-view.js'
import type { DashboardSource } from '../../extension/types.js'

export type FilterResultNavigationContext = {
  dashboardView: DashboardView
  source: DashboardSource
  sourceSelection: DashboardSource
  filter: string
  filterResultCandidates: readonly FilterResultCandidate[]
  filterResultSearchSettled: boolean
}

type ActivationModifiers = Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/** Internal seam: the browser DOM and the in-memory sequence fixture. */
export type FilterResultNavigationSurface = {
  isMounted: (candidate: FilterResultCandidate) => boolean
  rect: (candidate: FilterResultCandidate) => PositionedFilterResultCandidate['rect'] | null
  select: (candidate: FilterResultCandidate | undefined, scroll: boolean) => void
  activate: (candidate: FilterResultCandidate, modifiers: ActivationModifiers) => void
}

type PendingAction = {
  query: string
  source: DashboardSource
} & (
  | { kind: 'move', direction: FilterResultMoveDirection }
  | { kind: 'activate', modifiers: ActivationModifiers }
)

const EMPTY_CANDIDATES: readonly FilterResultCandidate[] = []

/** One mounted Filter Query's navigation protocol; no work runs during creation. */
export function createFilterResultNavigationSession(surface: FilterResultNavigationSurface) {
  let context: FilterResultNavigationContext | null = null
  let selection = EMPTY_FILTER_RESULT_SELECTION
  let pendingAction: PendingAction | null = null

  function candidateForSelection(current: FilterResultSelection, candidates: readonly FilterResultCandidate[]) {
    return candidates.find((candidate) => candidate.key === current.candidateKey)
  }

  function availableCandidates(current: FilterResultNavigationContext) {
    return current.source === current.sourceSelection ? current.filterResultCandidates : EMPTY_CANDIDATES
  }

  function moveSelection(
    current: FilterResultSelection,
    query: string,
    candidates: readonly FilterResultCandidate[],
    direction: FilterResultMoveDirection,
  ) {
    if (direction === 'next' || direction === 'previous') {
      return selectAdjacentFilterResult(current, query, candidates, direction)
    }
    const positionedCandidates = candidates.flatMap((candidate) => {
      const rect = surface.rect(candidate)
      return rect ? [{ candidate, rect }] : []
    })
    return selectHorizontalFilterResult(current, query, positionedCandidates, direction)
  }

  function clearPending() {
    pendingAction = null
  }

  // Runs after results mount. Context reset precedes reconciliation, just as
  // it does when the selected Dashboard View changes without a Source change.
  function commit(next: FilterResultNavigationContext) {
    if (context && (
      context.dashboardView !== next.dashboardView ||
      context.source !== next.source ||
      context.sourceSelection !== next.sourceSelection
    )) {
      clearPending()
      selection = EMPTY_FILTER_RESULT_SELECTION
      surface.select(undefined, false)
    }
    context = next
    const candidates = availableCandidates(next)
    const action = pendingAction
    const actionMatches = action?.query === next.filter &&
      action.source === next.source && next.source === next.sourceSelection
    const mountedCandidates = actionMatches && action.kind === 'move'
      ? candidates.filter(surface.isMounted)
      : null
    let nextSelection: FilterResultSelection
    let nextCandidate: FilterResultCandidate | undefined
    if (mountedCandidates) {
      nextSelection = reconcileFilterResultSelection(selection, next.filter, mountedCandidates)
      nextCandidate = candidateForSelection(nextSelection, mountedCandidates)
    } else {
      const reconciled = reconcileVisibleFilterResultSelection(selection, next.filter, candidates, surface.isMounted)
      nextSelection = reconciled.selection
      nextCandidate = reconciled.candidate
    }

    if (actionMatches && action.kind === 'activate' && !nextCandidate) {
      nextCandidate = candidates.find(surface.isMounted)
    }
    let activation: Extract<PendingAction, { kind: 'activate' }> | null = null
    let scroll = false
    if (actionMatches && (
      nextCandidate ||
      (action.kind === 'move' && (mountedCandidates?.length ?? 0) > 0) ||
      next.filterResultSearchSettled
    )) {
      clearPending()
      if (action.kind === 'move') {
        nextSelection = moveSelection(nextSelection, next.filter, mountedCandidates ?? EMPTY_CANDIDATES, action.direction)
        nextCandidate = candidateForSelection(nextSelection, mountedCandidates ?? EMPTY_CANDIDATES)
        scroll = true
      } else {
        activation = action
      }
    }

    surface.select(candidateForSelection(nextSelection, mountedCandidates ?? candidates), scroll)
    selection = nextSelection
    // Consume first: activation can synchronously cause another commit.
    if (activation && nextCandidate) surface.activate(nextCandidate, activation.modifiers)
  }

  function handleKeyDown(event: FilterResultKeyboardEvent & { preventDefault: () => void }) {
    const current = context
    const intent = filterResultKeyboardIntent(event)
    if (!current || !intent || !current.filter.trim() || current.source !== current.sourceSelection) return

    const inputOwned = selection.query !== current.filter || selection.candidateKey === null
    if ((intent === 'left' || intent === 'right') && inputOwned) return

    event.preventDefault()
    const action: PendingAction = intent === 'activate'
      ? {
          kind: 'activate',
          modifiers: {
            altKey: !!event.altKey,
            ctrlKey: !!event.ctrlKey,
            metaKey: !!event.metaKey,
            shiftKey: !!event.shiftKey,
          },
          query: current.filter,
          source: current.source,
        }
      : { kind: 'move', direction: intent, query: current.filter, source: current.source }
    const candidates = availableCandidates(current).filter(surface.isMounted)
    const reconciled = reconcileFilterResultSelection(selection, current.filter, candidates)
    if (candidates.length === 0 && !current.filterResultSearchSettled) {
      pendingAction = action
      return
    }

    if (action.kind === 'move') {
      selection = moveSelection(reconciled, current.filter, candidates, action.direction)
      surface.select(candidateForSelection(selection, candidates), true)
      return
    }
    selection = reconciled
    surface.select(candidateForSelection(selection, candidates), false)
    const target = candidateForSelection(selection, candidates) ?? candidates[0]
    if (target) surface.activate(target, action.modifiers)
  }

  function dispose() {
    clearPending()
    selection = EMPTY_FILTER_RESULT_SELECTION
    context = null
    surface.select(undefined, false)
  }

  return { commit, handleKeyDown, queryChanged: clearPending, dispose }
}
