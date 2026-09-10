import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  domainReorderCardFeedback,
  endDomainReorder,
  getDomainReorderFeedback,
  setDomainReorderTarget,
  startDomainReorder,
  type DomainReorderFeedback,
} from '../src/components/domain-reorder-feedback.js'

const IDLE: DomainReorderFeedback = { sourceDomain: null, target: null }

afterEach(() => {
  endDomainReorder()
})

test('a card at rest paints nothing while no drag is active', () => {
  const card = domainReorderCardFeedback(IDLE, 'alpha.example')

  assert.deepEqual(card, { isSource: false, targetPlacement: null, targetKeepsOrder: false })
})

test('the dragged card is the source and every other card stays idle until targeted', () => {
  const state: DomainReorderFeedback = { sourceDomain: 'alpha.example', target: null }

  assert.equal(domainReorderCardFeedback(state, 'alpha.example').isSource, true)
  assert.deepEqual(domainReorderCardFeedback(state, 'beta.example'), domainReorderCardFeedback(IDLE, 'beta.example'))
})

test('the hovered card paints its placement and mutes when the drop keeps the order', () => {
  const move: DomainReorderFeedback = {
    sourceDomain: 'alpha.example',
    target: { domain: 'gamma.example', placement: 'after', keepsOrder: false },
  }
  const noop: DomainReorderFeedback = {
    sourceDomain: 'alpha.example',
    target: { domain: 'beta.example', placement: 'before', keepsOrder: true },
  }

  assert.deepEqual(domainReorderCardFeedback(move, 'gamma.example'), { isSource: false, targetPlacement: 'after', targetKeepsOrder: false })
  assert.deepEqual(domainReorderCardFeedback(noop, 'beta.example'), { isSource: false, targetPlacement: 'before', targetKeepsOrder: true })
  assert.deepEqual(domainReorderCardFeedback(move, 'beta.example'), domainReorderCardFeedback(IDLE, 'beta.example'))
})

test('unchanged card feedback keeps referential identity across store snapshots', () => {
  const first: DomainReorderFeedback = {
    sourceDomain: 'alpha.example',
    target: { domain: 'beta.example', placement: 'before', keepsOrder: false },
  }
  const second: DomainReorderFeedback = {
    sourceDomain: 'alpha.example',
    target: { domain: 'gamma.example', placement: 'after', keepsOrder: true },
  }

  assert.equal(domainReorderCardFeedback(first, 'alpha.example'), domainReorderCardFeedback(second, 'alpha.example'))
  assert.equal(domainReorderCardFeedback(first, 'delta.example'), domainReorderCardFeedback(second, 'delta.example'))
  assert.notEqual(domainReorderCardFeedback(first, 'beta.example'), domainReorderCardFeedback(second, 'beta.example'))
})

test('a drag publishes start, target changes, and end as immutable snapshots', () => {
  const seen: DomainReorderFeedback[] = []
  startDomainReorder('alpha.example')
  seen.push(getDomainReorderFeedback())
  setDomainReorderTarget({ domain: 'beta.example', placement: 'before', keepsOrder: true })
  seen.push(getDomainReorderFeedback())
  setDomainReorderTarget({ domain: 'beta.example', placement: 'before', keepsOrder: true })
  const repeated = getDomainReorderFeedback()
  setDomainReorderTarget(null)
  seen.push(getDomainReorderFeedback())
  endDomainReorder()
  seen.push(getDomainReorderFeedback())

  assert.deepEqual(seen, [
    { sourceDomain: 'alpha.example', target: null },
    { sourceDomain: 'alpha.example', target: { domain: 'beta.example', placement: 'before', keepsOrder: true } },
    { sourceDomain: 'alpha.example', target: null },
    IDLE,
  ])
  assert.equal(repeated, seen[1], 'an identical target must not publish a new snapshot')
  assert.notEqual(seen[0], seen[1])
})
