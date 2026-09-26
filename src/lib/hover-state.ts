export type HoverUrlSource = 'chip' | 'history' | 'working-set'
// An owner scopes departure/cleanup to the interaction that published the
// preview. Calls without an owner still support dashboard-wide clears.
export type HoverUrlChangeHandler = (url: string, source?: HoverUrlSource, matchUrls?: readonly string[], tabId?: number, owner?: string, matchTabIds?: readonly number[]) => void | Promise<void>

export type HoverState = {
  url: string
  urls: readonly string[]
  source: HoverUrlSource | null
  tabIds?: readonly number[] | undefined
}

export type HoverStateSelector<Selection> = (state: HoverState) => Selection

export type HoverStateStore = {
  getSnapshot: () => HoverState
  setSnapshot: (next: HoverState) => void
  subscribeSelector: <Selection>(
    selector: HoverStateSelector<Selection>,
    listener: () => void,
    equal?: (left: Selection, right: Selection) => boolean,
  ) => () => void
}

type HoverSelectorSubscription = {
  equal: (left: unknown, right: unknown) => boolean
  listener: () => void
  selected: unknown
  selector: HoverStateSelector<unknown>
}

const emptyHoverState: HoverState = {
  url: '',
  urls: [],
  source: null,
}

function sameHoverState(left: HoverState, right: HoverState): boolean {
  return (
    left.url === right.url &&
    left.source === right.source &&
    left.tabIds?.length === right.tabIds?.length &&
    (left.tabIds?.every((id, index) => id === right.tabIds?.[index]) ?? true) &&
    left.urls.length === right.urls.length &&
    left.urls.every((url, index) => url === right.urls[index])
  )
}

/**
 * Creates the volatile dashboard hover store. Selector subscriptions isolate
 * updates to the old and new matching leaves instead of invalidating the
 * entire dashboard context subtree.
 */
export function createHoverStateStore(initialState: HoverState = emptyHoverState): HoverStateStore {
  let state = initialState
  const subscriptions = new Set<HoverSelectorSubscription>()

  function subscribeSelector<Selection>(
    selector: HoverStateSelector<Selection>,
    listener: () => void,
    equal: (left: Selection, right: Selection) => boolean = Object.is,
  ) {
    const subscription: HoverSelectorSubscription = {
      equal: (left, right) => equal(left as Selection, right as Selection),
      listener,
      selected: selector(state),
      selector,
    }
    subscriptions.add(subscription)
    return () => {
      subscriptions.delete(subscription)
    }
  }

  return {
    getSnapshot() {
      return state
    },
    setSnapshot(next) {
      if (sameHoverState(state, next)) return
      state = next
      for (const subscription of subscriptions) {
        const nextSelected = subscription.selector(next)
        if (subscription.equal(subscription.selected, nextSelected)) continue
        subscription.selected = nextSelected
        subscription.listener()
      }
    },
    subscribeSelector,
  }
}
