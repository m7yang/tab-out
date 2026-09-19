import type { FilterResultCandidate } from '../../extension/filter-result-navigation.js'
import type { FilterResultNavigationSurface } from './session.js'

export function createFilterResultNavigationDom(): FilterResultNavigationSurface & { attach: (input: HTMLInputElement | null) => void } {
  let input: HTMLInputElement | null = null
  let selectedElement: HTMLElement | null = null
  let selectedInput: HTMLInputElement | null = null

  function elementFor(candidate: FilterResultCandidate) {
    const target = document.getElementById(candidate.domId)
    return target instanceof HTMLElement ? target : null
  }

  return {
    attach(nextInput) {
      input = nextInput
    },
    isMounted(candidate) {
      return (elementFor(candidate)?.getClientRects().length ?? 0) > 0
    },
    rect(candidate) {
      const target = elementFor(candidate)
      if (!target || target.getClientRects().length === 0) return null
      const rect = target.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    },
    select(candidate, scroll) {
      const nextElement = candidate ? elementFor(candidate) : null
      if (selectedElement !== nextElement) selectedElement?.removeAttribute('data-tabout-filter-result-selected')
      if (selectedInput !== input) selectedInput?.removeAttribute('aria-activedescendant')
      selectedInput = input
      selectedElement = nextElement
      if (!candidate || !nextElement) {
        input?.removeAttribute('aria-activedescendant')
        return
      }
      nextElement.setAttribute('data-tabout-filter-result-selected', 'true')
      input?.setAttribute('aria-activedescendant', candidate.domId)
      if (scroll) nextElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    },
    activate(candidate, modifiers) {
      elementFor(candidate)?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
        view: window,
        ...modifiers,
      }))
    },
  }
}
