import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import { createFilterResultNavigationDom } from './dom.js'
import { createFilterResultNavigationSession, type FilterResultNavigationContext } from './session.js'

export function useFilterResultNavigation({
  inputRef,
  dashboardView,
  source,
  sourceSelection,
  filter,
  filterResultCandidates,
  filterResultSearchSettled,
  onFilterChange,
}: FilterResultNavigationContext & { inputRef: RefObject<HTMLInputElement | null>, onFilterChange: (value: string) => void }) {
  const [{ dom, session }] = useState(() => {
    const dom = createFilterResultNavigationDom()
    return { dom, session: createFilterResultNavigationSession(dom) }
  })

  useLayoutEffect(() => () => {
    session.dispose()
    dom.attach(null)
  }, [dom, session])

  useLayoutEffect(() => {
    dom.attach(inputRef.current)
    session.commit({ dashboardView, source, sourceSelection, filter, filterResultCandidates, filterResultSearchSettled })
  }, [dom, session, inputRef, dashboardView, source, sourceSelection, filter, filterResultCandidates, filterResultSearchSettled])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    session.handleKeyDown({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      preventDefault: () => event.preventDefault(),
    })
  }

  function onQueryChange(value: string) {
    session.queryChanged()
    onFilterChange(value)
  }

  return { onKeyDown, onQueryChange }
}
