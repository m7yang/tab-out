import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFilterResultNavigationSession,
  type FilterResultNavigationContext,
  type FilterResultNavigationSurface,
} from '../src/components/filter-result-navigation/session.js'
import type { FilterResultCandidate, FilterResultKeyboardEvent } from '../src/extension/filter-result-navigation.js'

function candidate(key: string, identity = key): FilterResultCandidate {
  return { key, identity, domId: `result-${key}` }
}

const alpha = candidate('alpha')
const bravo = candidate('bravo')

function fixture() {
  const mounted = new Map<string, NonNullable<ReturnType<FilterResultNavigationSurface['rect']>>>()
  const observed: {
    selected: FilterResultCandidate | undefined
    scrolls: string[]
    activations: Array<{ key: string, modifiers: Parameters<FilterResultNavigationSurface['activate']>[1] }>
    onActivate?: () => void
  } = { selected: undefined, scrolls: [], activations: [] }
  const session = createFilterResultNavigationSession({
    isMounted: (target) => mounted.has(target.key),
    rect: (target) => mounted.get(target.key) ?? null,
    select(target, scroll) {
      observed.selected = target
      if (target && scroll) observed.scrolls.push(target.key)
    },
    activate(target, modifiers) {
      observed.activations.push({ key: target.key, modifiers })
      observed.onActivate?.()
    },
  })
  let context: FilterResultNavigationContext = {
    dashboardView: 'all-tabs',
    source: 'tabs',
    sourceSelection: 'tabs',
    filter: 'reference',
    filterResultCandidates: [],
    filterResultSearchSettled: false,
  }
  function commit(changes: Partial<FilterResultNavigationContext> = {}) {
    context = { ...context, ...changes }
    session.commit(context)
  }
  function mount(target: FilterResultCandidate, left = 0, top = 0) {
    mounted.set(target.key, { left, top, right: left + 80, bottom: top + 20 })
  }
  function press(key: string, options: Omit<FilterResultKeyboardEvent, 'key'> = {}) {
    let prevented = false
    session.handleKeyDown({ key, ...options, preventDefault: () => { prevented = true } })
    return prevented
  }
  return { session, observed, commit, mount, mounted, press }
}

test('pending Enter activates the first mounted match once, with its original modifiers', () => {
  const f = fixture()
  f.commit({ filterResultCandidates: [alpha, bravo] })
  assert.equal(f.press('Enter', { metaKey: true, shiftKey: true }), true)
  f.commit()
  assert.deepEqual(f.observed.activations, [])
  // The first candidate is still hidden; only Bravo can receive the action.
  f.mount(bravo)
  f.observed.onActivate = () => f.commit()
  f.commit()
  f.mount(alpha)
  f.commit({ filterResultSearchSettled: true })
  assert.deepEqual(f.observed.activations, [{
    key: bravo.key,
    modifiers: { altKey: false, ctrlKey: false, metaKey: true, shiftKey: true },
  }])
  assert.equal(f.observed.selected, undefined)
  assert.deepEqual(f.observed.scrolls, [])
})

test('a pending Arrow waits for mounting and then selects without activating', () => {
  const f = fixture()
  f.commit()
  f.press('ArrowDown')
  f.commit({ filterResultCandidates: [alpha, bravo] })
  assert.equal(f.observed.selected, undefined)
  f.mount(alpha)
  f.commit()
  assert.equal(f.observed.selected, alpha)
  assert.deepEqual(f.observed.scrolls, [alpha.key])
  f.commit({ filterResultSearchSettled: true })
  assert.deepEqual(f.observed.scrolls, [alpha.key])
  assert.deepEqual(f.observed.activations, [])
})

test('the latest pending key wins while companion results are unavailable', () => {
  const f = fixture()
  f.commit()
  f.press('Enter')
  f.press('ArrowUp')
  f.mount(alpha)
  f.mount(bravo)
  f.commit({ filterResultCandidates: [alpha, bravo] })
  assert.equal(f.observed.selected, bravo)
  assert.deepEqual(f.observed.activations, [])
})

test('mounted matches respond immediately while companion searches are pending', () => {
  const f = fixture()
  f.mount(alpha)
  f.commit({ filterResultCandidates: [alpha, bravo] })
  f.press('ArrowDown')
  f.press('Enter', { ctrlKey: true })
  assert.equal(f.observed.selected, alpha)
  assert.equal(f.observed.activations.length, 1)
  assert.equal(f.observed.activations[0]?.modifiers.ctrlKey, true)
  f.mount(bravo)
  f.press('ArrowDown')
  assert.equal(f.observed.selected, bravo)
})

test('editing the Filter Query cancels pending activation, including edit-away-and-back', () => {
  const f = fixture()
  f.commit()
  f.press('Enter')
  f.session.queryChanged()
  f.commit({ filter: 'other reference' })
  f.mount(alpha)
  f.commit({ filter: 'reference', filterResultCandidates: [alpha] })
  assert.deepEqual(f.observed.activations, [])
  f.press('ArrowDown')
  assert.equal(f.observed.selected, alpha)
  f.commit({ filter: 'changed query' })
  assert.equal(f.observed.selected, undefined)
})

test('changed queries cannot receive activation queued for an earlier query', () => {
  const f = fixture()
  f.commit()
  f.press('Enter')
  f.mount(alpha)
  f.commit({ filter: 'other', filterResultCandidates: [alpha] })
  assert.deepEqual(f.observed.activations, [])
})

test('Dashboard View and Source changes cancel pending keys and reset selection', () => {
  for (const changes of [
    { dashboardView: 'open-saved' },
    { sourceSelection: 'bookmarks' },
    { source: 'bookmarks', sourceSelection: 'bookmarks', dashboardView: 'bookmarks' },
  ] satisfies Partial<FilterResultNavigationContext>[]) {
    const f = fixture()
    f.commit()
    f.press('Enter')
    f.commit(changes)
    f.mount(alpha)
    f.commit({ source: 'tabs', sourceSelection: 'tabs', dashboardView: 'all-tabs', filterResultCandidates: [alpha] })
    assert.deepEqual(f.observed.activations, [])
    f.press('ArrowDown')
    assert.equal(f.observed.selected, alpha)
    f.commit(changes)
    assert.equal(f.observed.selected, undefined)
  }
})

test('settling with no mounted matches consumes the pending action', () => {
  for (const key of ['Enter', 'ArrowDown']) {
    const f = fixture()
    f.commit()
    f.press(key)
    f.commit({ filterResultSearchSettled: true })
    f.mount(alpha)
    f.commit({ filterResultCandidates: [alpha] })
    assert.equal(f.observed.selected, undefined)
    assert.deepEqual(f.observed.activations, [])
  }
})

test('selection follows Dashboard Item Identity across replacement without scrolling', () => {
  const f = fixture()
  const bookmark = candidate('bookmark', 'https://example.test/reference')
  const tab = candidate('tab', bookmark.identity)
  f.mount(bookmark)
  f.commit({ filterResultCandidates: [bookmark] })
  f.press('ArrowDown')
  f.mounted.delete(bookmark.key)
  f.mount(tab)
  f.mount(alpha)
  f.commit({ filterResultCandidates: [alpha, tab] })
  assert.equal(f.observed.selected, tab)
  assert.deepEqual(f.observed.scrolls, [bookmark.key])
  f.press('Enter')
  assert.equal(f.observed.activations[0]?.key, tab.key)
  f.mounted.delete(tab.key)
  f.commit()
  assert.equal(f.observed.selected, alpha)
})

test('horizontal navigation uses mounted geometry after selection leaves the input', () => {
  const f = fixture()
  const below = candidate('below')
  f.mount(alpha)
  f.mount(below, 0, 40)
  f.mount(bravo, 100, 0)
  f.commit({ filterResultCandidates: [alpha, below, bravo] })
  assert.equal(f.press('ArrowRight'), false)
  assert.equal(f.press('ArrowLeft'), false)
  f.press('ArrowDown')
  f.press('ArrowRight')
  assert.equal(f.observed.selected, bravo)
  f.press('ArrowRight')
  assert.equal(f.observed.selected, bravo)
  f.press('ArrowLeft')
  assert.equal(f.observed.selected, alpha)
})

test('IME, Alt, empty queries and an unapplied Source preserve native key handling', () => {
  const f = fixture()
  f.mount(alpha)
  f.commit({ filterResultCandidates: [alpha] })
  assert.equal(f.press('Enter', { isComposing: true }), false)
  assert.equal(f.press('ArrowDown', { altKey: true }), false)
  f.commit({ filter: '' })
  assert.equal(f.press('Enter'), false)
  f.commit({ filter: 'reference', sourceSelection: 'bookmarks' })
  assert.equal(f.press('ArrowDown'), false)
  assert.equal(f.observed.selected, undefined)
  assert.deepEqual(f.observed.activations, [])
})

test('disposal clears selection and pending intent and permits a fresh React setup', () => {
  const f = fixture()
  f.mount(alpha)
  f.commit({ filterResultCandidates: [alpha] })
  f.press('ArrowDown')
  f.session.dispose()
  assert.equal(f.observed.selected, undefined)
  assert.equal(f.press('Enter'), false)
  f.commit({ filterResultCandidates: [] })
  f.press('Enter')
  f.session.dispose()
  f.commit({ filterResultCandidates: [alpha] })
  assert.deepEqual(f.observed.activations, [])
  f.press('Enter')
  assert.equal(f.observed.activations.length, 1)
})

test('mounted headers have independent navigation sessions', () => {
  const first = fixture()
  const second = fixture()
  first.commit()
  second.mount(alpha)
  second.commit({ filterResultCandidates: [alpha] })
  first.press('Enter')
  second.commit()
  assert.deepEqual(second.observed.activations, [])
  second.press('ArrowDown')
  first.session.dispose()
  assert.equal(second.observed.selected, alpha)
})
