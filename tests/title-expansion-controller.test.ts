import assert from 'node:assert/strict'
import test from 'node:test'

import { createTitleExpansionController, createTitleExpansionLane } from '../src/components/title-expansion/index.js'
function createRecordingController(lane = createTitleExpansionLane(), overrides: Record<string, unknown> = {}) {
  const expandedChanges: boolean[] = []
  const controller = createTitleExpansionController({
    id: 'entry-a',
    lane,
    onExpandedChange: (expanded: boolean) => expandedChanges.push(expanded),
    ...overrides,
  })
  return { controller, lane, expandedChanges }
}

test('lane activation notifies subscribers once per change and skips same-id re-activation', () => {
  const lane = createTitleExpansionLane()
  const seen: (string | null)[] = []
  const unsubscribe = lane.subscribe((activeId) => seen.push(activeId))

  lane.activate('one')
  lane.activate('one')
  lane.activate('two')
  lane.release('one')
  lane.release('two')

  assert.deepEqual(seen, ['one', 'two', null])
  assert.equal(lane.getActiveId(), null)

  unsubscribe()
  lane.activate('three')
  assert.deepEqual(seen, ['one', 'two', null])
})

test('lane release is owner-guarded so a stale owner cannot clear a newer one', () => {
  const lane = createTitleExpansionLane()
  lane.activate('one')
  lane.activate('two')
  lane.release('one')
  assert.equal(lane.getActiveId(), 'two')
})

test('open activates the lane and reports expansion once', () => {
  const { controller, lane, expandedChanges } = createRecordingController()

  controller.open()
  controller.open()

  assert.equal(lane.getActiveId(), 'entry-a')
  assert.equal(controller.isExpanded(), true)
  assert.deepEqual(expandedChanges, [true])
})

test('close collapses and releases synchronously', () => {
  const { controller, lane, expandedChanges } = createRecordingController()

  controller.open()
  controller.close()

  assert.equal(controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), null)
  assert.deepEqual(expandedChanges, [true, false])
})

test('a lane steal collapses the previous owner without touching the new owner', () => {
  const lane = createTitleExpansionLane()
  const first = createRecordingController(lane)
  const second = createTitleExpansionController({
    id: 'entry-b',
    lane,
    onExpandedChange: () => {},
  })

  first.controller.open()
  second.open()

  assert.equal(first.controller.isExpanded(), false)
  assert.equal(second.isExpanded(), true)
  assert.equal(lane.getActiveId(), 'entry-b')
  assert.deepEqual(first.expandedChanges, [true, false])
})

test('closing a stale entry leaves the lane with its new owner', () => {
  const lane = createTitleExpansionLane()
  const first = createRecordingController(lane)

  first.controller.open()
  lane.activate('entry-b')
  first.controller.close()

  assert.equal(first.controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), 'entry-b')
})

test('dispose releases an owned lane and stops reacting to the lane', () => {
  const { controller, lane, expandedChanges } = createRecordingController()

  controller.open()
  controller.hold('context-menu')
  controller.dispose()

  assert.equal(lane.getActiveId(), null)
  lane.activate('entry-b')
  assert.deepEqual(expandedChanges, [true])
})

test('dispose does not release a lane owned by someone else', () => {
  const lane = createTitleExpansionLane()
  const { controller } = createRecordingController(lane)

  controller.open()
  lane.activate('entry-b')
  controller.dispose()

  assert.equal(lane.getActiveId(), 'entry-b')
})

for (const owner of ['context-menu', 'keyboard-focus'] as const) {
  test(`a held ${owner} owner vetoes close`, () => {
    const { controller, lane, expandedChanges } = createRecordingController()

    controller.open()
    const release = controller.hold(owner)
    controller.close()

    assert.equal(controller.isExpanded(), true)
    assert.equal(lane.getActiveId(), 'entry-a')
    assert.deepEqual(expandedChanges, [true])
    release()
  })
}

test('releasing the last hold lets close proceed', () => {
  const { controller, lane } = createRecordingController()

  controller.open()
  const release = controller.hold('context-menu')
  release()
  controller.close()

  assert.equal(controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), null)
})

test('holds are refcounted per owner kind so overlapping menus keep the veto', () => {
  const { controller } = createRecordingController()

  controller.open()
  const releaseFirst = controller.hold('context-menu')
  const releaseSecond = controller.hold('context-menu')
  releaseFirst()
  controller.close()
  assert.equal(controller.isExpanded(), true)

  releaseSecond()
  controller.close()
  assert.equal(controller.isExpanded(), false)
})

test('a release function is idempotent and cannot consume a later hold', () => {
  const { controller } = createRecordingController()

  controller.open()
  const staleRelease = controller.hold('context-menu')
  staleRelease()
  const release = controller.hold('context-menu')
  staleRelease()
  controller.close()

  assert.equal(controller.isExpanded(), true)
  release()
})

test('only a context-menu hold keeps the expansion through a lane steal', () => {
  const lane = createTitleExpansionLane()
  const first = createRecordingController(lane)

  first.controller.open()
  const releaseMenu = first.controller.hold('context-menu')
  lane.activate('entry-b')
  assert.equal(first.controller.isExpanded(), true)

  releaseMenu()
  first.controller.open()
  const releaseFocus = first.controller.hold('keyboard-focus')
  lane.activate('entry-c')
  assert.equal(first.controller.isExpanded(), false)
  releaseFocus()
})

test('closeNow collapses and releases even while owners are held', () => {
  const { controller, lane } = createRecordingController()

  controller.open()
  controller.hold('context-menu')
  controller.hold('keyboard-focus')
  controller.closeNow()

  assert.equal(controller.isExpanded(), false)
  assert.equal(lane.getActiveId(), null)
})
