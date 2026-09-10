import assert from 'node:assert/strict'
import test from 'node:test'
import { startPointerDrag, type PointerDragHandlers } from '../src/lib/pointer-drag.js'

function recordingHandlers() {
  const calls: string[] = []
  const handlers: PointerDragHandlers = {
    onMove: (event) => calls.push(`move:${event.type}`),
    onEnd: (event) => calls.push(`end:${event.type}`),
    onCancel: () => calls.push('cancel'),
  }
  return { calls, handlers }
}

function dispatch(target: EventTarget, type: string) {
  target.dispatchEvent(new Event(type))
}

test('a release delivers moves then one end and detaches every listener', () => {
  const target = new EventTarget()
  const { calls, handlers } = recordingHandlers()
  startPointerDrag(handlers, { target })

  dispatch(target, 'pointermove')
  dispatch(target, 'pointermove')
  dispatch(target, 'pointerup')
  dispatch(target, 'pointermove')
  dispatch(target, 'pointerup')
  dispatch(target, 'blur')

  assert.deepEqual(calls, ['move:pointermove', 'move:pointermove', 'end:pointerup'])
})

test('pointer cancellation and window blur each cancel once', () => {
  for (const cancelType of ['pointercancel', 'blur']) {
    const target = new EventTarget()
    const { calls, handlers } = recordingHandlers()
    startPointerDrag(handlers, { target })

    dispatch(target, cancelType)
    dispatch(target, 'pointerup')
    dispatch(target, cancelType)

    assert.deepEqual(calls, ['cancel'], `${cancelType} should cancel exactly once`)
  }
})

test('disposing a drag detaches silently without running a handler', () => {
  const target = new EventTarget()
  const { calls, handlers } = recordingHandlers()
  const drag = startPointerDrag(handlers, { target })

  drag.dispose()
  dispatch(target, 'pointermove')
  dispatch(target, 'pointerup')
  dispatch(target, 'blur')

  assert.deepEqual(calls, [])
})
