import assert from 'node:assert/strict'
import { afterEach, it, vi } from '@effect/vitest'

import { createMoveAnimator } from '../../src/extension/move-animation.js'
import type { MoveAnimatorConfig, MovePositionMap } from '../../src/extension/move-animation.js'

afterEach(() => vi.useRealTimers())

type Rect = { left: number, top: number, width?: number, height?: number }

function fakeItem(key: string, rect: Rect) {
  const classes = new Set<string>()
  const listeners: Array<(e: unknown) => void> = []
  const state = { rect }
  const el = {
    dataset: { key },
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
    },
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: state.rect.left, top: state.rect.top, width: state.rect.width ?? 100, height: state.rect.height ?? 40 }),
    addEventListener: (_type: string, handler: (e: unknown) => void) => {
      listeners.push(handler)
    },
    removeEventListener: (_type: string, handler: (e: unknown) => void) => {
      const index = listeners.indexOf(handler)
      if (index >= 0) listeners.splice(index, 1)
    },
    matches: () => true,
  }
  return {
    el: el as unknown as HTMLElement,
    classes,
    listeners,
    style: el.style,
    moveTo(next: Rect) {
      state.rect = next
    },
  }
}

type Fake = ReturnType<typeof fakeItem>

function fakeRoot(items: Fake[], origin: { left: number, top: number } = { left: 0, top: 0 }) {
  return {
    querySelectorAll: () => items.map((item) => item.el),
    getBoundingClientRect: () => ({ left: origin.left, top: origin.top, width: 800, height: 600 }),
  } as unknown as HTMLElement
}

function makeConfig(overrides: Partial<MoveAnimatorConfig> = {}): MoveAnimatorConfig {
  return {
    itemSelector: '.item',
    keyOf: (el) => (el as unknown as { dataset: { key?: string } }).dataset.key || '',
    duration: 30,
    movingClass: 'moving',
    activeClass: 'moving-active',
    coordinateSpace: 'viewport',
    ...overrides,
  }
}

it('move animation inverts, plays on the motion token, and cleans up by timeout', async () => {
  vi.useFakeTimers()
  const item = fakeItem('a', { left: 100, top: 100 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig())

  const previous = animator.snapshot([root])
  item.moveTo({ left: 200, top: 150 })
  animator.animate([root], previous)

  assert.equal(item.style.transform, 'translate(-100px, -50px)')
  assert.equal(item.style.transition, 'none')
  assert.equal(item.classes.has('moving'), true)
  assert.equal(item.style.willChange ?? '', '')

  await vi.advanceTimersByTimeAsync(25)
  assert.equal(item.style.transform, 'translate(0, 0)')
  assert.equal(item.style.transition, 'transform 30ms var(--ease-swift)')
  assert.equal(item.classes.has('moving-active'), true)

  await vi.advanceTimersByTimeAsync(120)
  assert.equal(item.listeners.length, 0)
  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform, '')
  assert.equal(item.style.transition, '')
  assert.equal(item.style.willChange ?? '', '')
})

it('sub-pixel moves are skipped entirely', () => {
  const item = fakeItem('a', { left: 100, top: 100 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig())

  const previous = animator.snapshot([root])
  item.moveTo({ left: 100.4, top: 100.4 })
  animator.animate([root], previous)

  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform ?? '', '')
})

it('duplicate keys resolve by closest previous position', () => {
  const first = fakeItem('dup', { left: 0, top: 0 })
  const second = fakeItem('dup', { left: 500, top: 0 })
  const root = fakeRoot([first, second])
  const animator = createMoveAnimator(makeConfig())

  const previous = animator.snapshot([root])
  first.moveTo({ left: 490, top: 0 })
  second.moveTo({ left: 10, top: 0 })
  animator.animate([root], previous)

  assert.equal(first.style.transform, 'translate(10px, 0px)')
  assert.equal(second.style.transform, 'translate(-10px, 0px)')
})

it('cancel clears the move, listeners, and scheduled work', async () => {
  vi.useFakeTimers()
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig())

  const previous = animator.snapshot([root])
  item.moveTo({ left: 300, top: 0 })
  animator.animate([root], previous)
  assert.equal(item.classes.has('moving'), true)

  animator.cancel([root])
  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform, '')
  assert.equal(item.listeners.length, 0)
  assert.equal(vi.getTimerCount(), 0)

  await vi.advanceTimersByTimeAsync(150)
  assert.equal(item.classes.size, 0)
  assert.equal(item.style.transform, '')
})

it('transitionend on transform cleans up and cancels the fallback timeout', () => {
  vi.useFakeTimers()
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig({ duration: 5000 }))

  const previous = animator.snapshot([root])
  item.moveTo({ left: 300, top: 0 })
  animator.animate([root], previous)

  vi.advanceTimersByTime(16)
  assert.equal(item.classes.has('moving-active'), true)
  assert.equal(vi.getTimerCount(), 1)
  item.listeners.slice().forEach((handler) => handler({ target: item.el, propertyName: 'transform' }))

  assert.equal(item.listeners.length, 0)
  assert.equal(item.classes.size, 0)
  assert.equal(vi.getTimerCount(), 0)
})

it('the per-call beforePlay hook fires only when movers exist', () => {
  const calls: HTMLElement[][] = []
  const hooks = { beforePlay: (roots: HTMLElement[]) => calls.push(roots) }
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig())

  animator.animate([root], animator.snapshot([root]), hooks)
  assert.deepEqual(calls, [])

  const previous = animator.snapshot([root])
  item.moveTo({ left: 40, top: 0 })
  animator.animate([root], previous, hooks)
  assert.deepEqual(calls, [[root]])
  animator.cancel([root])

  const again = animator.snapshot([root])
  item.moveTo({ left: 80, top: 0 })
  animator.animate([root], again)
  assert.deepEqual(calls, [[root]])
  animator.cancel([root])
})

it('root coordinate space measures grid-local positions', () => {
  const item = fakeItem('a', { left: 312, top: 234 })
  const root = fakeRoot([item], { left: 300, top: 200 })
  const animator = createMoveAnimator(makeConfig({ coordinateSpace: 'root' }))

  const positions = animator.snapshot([root])
  assert.deepEqual(positions.get('a'), [{ left: 12, top: 34, width: 100, height: 40 }])
})

it('move animation can snapshot a structural anchor and animate its replacement item', () => {
  const anchor = fakeItem('a', { left: 40, top: 20, width: 60, height: 20 })
  const item = fakeItem('a', { left: 160, top: 80, width: 120, height: 40 })
  const selectors: string[] = []
  const root = {
    querySelectorAll: (selector: string) => {
      selectors.push(selector)
      return selector === '.anchor' ? [anchor.el] : [item.el]
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLElement
  const animator = createMoveAnimator(makeConfig({
    itemSelector: '.item',
    snapshotItemSelector: '.anchor',
  }))

  const previous = animator.snapshot([root])
  animator.animate([root], previous)

  assert.deepEqual(selectors.slice(0, 2), ['.anchor', '.item'])
  assert.equal(item.style.transform, 'translate(-120px, -60px)')
  animator.cancel([root])
})

it('nested move suppression animates the stable parent surface only', () => {
  const parent = fakeItem('section', { left: 20, top: 100, width: 300, height: 120 })
  const child = fakeItem('page', { left: 30, top: 140, width: 280, height: 36 })
  ;(parent.el as unknown as { contains: (candidate: unknown) => boolean }).contains = (candidate) => (
    candidate === parent.el || candidate === child.el
  )
  ;(child.el as unknown as { contains: (candidate: unknown) => boolean }).contains = (candidate) => (
    candidate === child.el
  )
  const root = fakeRoot([parent, child])
  const animator = createMoveAnimator(makeConfig({ suppressNestedMoves: true }))

  const previous = animator.snapshot([root])
  parent.moveTo({ left: 20, top: 60, width: 300, height: 120 })
  child.moveTo({ left: 30, top: 100, width: 280, height: 36 })
  animator.animate([root], previous)

  assert.equal(parent.style.transform, 'translate(0px, 40px)')
  assert.equal(parent.classes.has('moving'), true)
  assert.equal(child.style.transform ?? '', '')
  assert.equal(child.classes.has('moving'), false)
  animator.cancel([root])
})

it('a newer animator owns the element through an older animator cleanup deadline', () => {
  vi.useFakeTimers()
  const item = fakeItem('a', { left: 100, top: 0 })
  const root = fakeRoot([item])
  const firstAnimator = createMoveAnimator(makeConfig({ duration: 30 }))
  const secondAnimator = createMoveAnimator(makeConfig({ duration: 500 }))

  firstAnimator.animate([root], new Map([[
    'a',
    [{ left: 0, top: 0, width: 100, height: 40 }],
  ]]))
  vi.advanceTimersByTime(16)

  secondAnimator.animate([root], new Map([[
    'a',
    [{ left: 50, top: 0, width: 100, height: 40 }],
  ]]))
  vi.advanceTimersByTime(16)
  assert.equal(item.style.transition, 'transform 500ms var(--ease-swift)')

  vi.advanceTimersByTime(80)
  assert.equal(item.style.transition, 'transform 500ms var(--ease-swift)')
  assert.equal(item.classes.has('moving'), true)
  assert.equal(item.classes.has('moving-active'), true)
})

it('reduced motion disables snapshot and animate', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
  const item = fakeItem('a', { left: 0, top: 0 })
  const root = fakeRoot([item])
  const animator = createMoveAnimator(makeConfig())

  assert.equal(animator.snapshot([root]).size, 0)

  const previous: MovePositionMap = new Map([['a', [{ left: 500, top: 0, width: 100, height: 40 }]]])
  animator.animate([root], previous)
  assert.equal(item.classes.size, 0)
})
