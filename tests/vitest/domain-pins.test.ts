import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Schema } from 'effect'

import {
  applyPinnedDomainMutation,
  isPinnableDomain,
  movePinnedDomainInList,
  normalizePinnedDomains,
  reorderPinnedDomainInList,
} from '../../src/extension/domain-pins.js'

const naturalNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const pinnedDomainIds = (minimumLength: number) =>
  Schema.UniqueArray(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })))
    .check(Schema.isLengthBetween(minimumLength, 20))

const pinnedDomains = (ids: ReadonlyArray<number>) => ids.map((id) => `domain-${id}.test`)

it('normalizePinnedDomains preserves order, removes invalid entries, and allows pinnable utility cards', () => {
  assert.deepEqual(
    normalizePinnedDomains(['example.com', '__private__', 'example.com', '__tab-out__', null, '__standalone-apps__']),
    ['example.com', '__tab-out__', '__standalone-apps__'],
  )
})

it.prop(
  'normalizePinnedDomains satisfies its invariants for arbitrary stored values',
  [Schema.UndefinedOr(Schema.Json)],
  ([storedValue]) => {
    const normalized = normalizePinnedDomains(storedValue)
    const expected = Array.isArray(storedValue)
      ? storedValue.filter(
          (candidate, index) => isPinnableDomain(candidate) && storedValue.indexOf(candidate) === index,
        )
      : []

    assert.deepEqual(normalized, expected)
    assert.deepEqual(normalizePinnedDomains(normalized), normalized)
    assert.equal(new Set(normalized).size, normalized.length)
  },
)

it('applyPinnedDomainMutation removes existing domains and appends new domains', () => {
  assert.deepEqual(applyPinnedDomainMutation(['example.com', 'docs.example'], { type: 'set-pinned', domain: 'example.com', pinned: false }), ['docs.example'])
  assert.deepEqual(applyPinnedDomainMutation(['example.com'], { type: 'set-pinned', domain: 'docs.example', pinned: true }), ['example.com', 'docs.example'])
})

it.prop(
  'applyPinnedDomainMutation changes only the selected generated domain',
  [pinnedDomainIds(0), naturalNumber, Schema.Boolean],
  ([ids, seed, selectExisting]) => {
    const domains = pinnedDomains(ids)
    const domain = selectExisting && domains.length > 0
      ? domains[seed % domains.length]
      : `extra-${seed}.test`
    assert.ok(domain)
    const expected = domains.includes(domain)
      ? domains.filter((candidate) => candidate !== domain)
      : [...domains, domain]

    assert.deepEqual(applyPinnedDomainMutation(domains, {
      type: 'set-pinned',
      domain,
      pinned: !domains.includes(domain),
    }), expected)
  },
)

it('reorderPinnedDomainInList moves a pinned domain before or after another pinned domain', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test', 'delta.test']

  assert.deepEqual(
    reorderPinnedDomainInList(domains, 'delta.test', 'bravo.test', 'before'),
    ['alpha.test', 'delta.test', 'bravo.test', 'charlie.test'],
  )
  assert.deepEqual(
    reorderPinnedDomainInList(domains, 'alpha.test', 'charlie.test', 'after'),
    ['bravo.test', 'charlie.test', 'alpha.test', 'delta.test'],
  )
})

it('reorderPinnedDomainInList ignores unknown, invalid, and same-domain targets', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test']

  assert.deepEqual(reorderPinnedDomainInList(domains, 'missing.test', 'bravo.test', 'before'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'alpha.test', 'missing.test', 'before'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'alpha.test', 'alpha.test', 'after'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, '__private__', 'bravo.test', 'before'), domains)
})

it('reorderPinnedDomainInList preserves order for adjacent equivalent placements', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test']

  assert.deepEqual(reorderPinnedDomainInList(domains, 'alpha.test', 'bravo.test', 'before'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'bravo.test', 'alpha.test', 'after'), domains)
  assert.deepEqual(reorderPinnedDomainInList(domains, 'bravo.test', 'charlie.test', 'before'), domains)
})

it.prop(
  'reorderPinnedDomainInList preserves generated membership and requested adjacency',
  [
    pinnedDomainIds(2),
    naturalNumber,
    naturalNumber,
    Schema.Literals(['before', 'after']),
  ],
  ([ids, domainSeed, targetSeed, position]) => {
    const domains = pinnedDomains(ids)
    const domainIndex = domainSeed % domains.length
    const targetCandidateIndex = targetSeed % (domains.length - 1)
    const targetIndex = targetCandidateIndex >= domainIndex
      ? targetCandidateIndex + 1
      : targetCandidateIndex
    const domain = domains[domainIndex]
    const targetDomain = domains[targetIndex]
    assert.ok(domain)
    assert.ok(targetDomain)
    const reordered = reorderPinnedDomainInList(domains, domain, targetDomain, position)

    assert.deepEqual(reordered.toSorted(), domains.toSorted())
    assert.equal(new Set(reordered).size, domains.length)
    assert.equal(
      reordered.indexOf(domain),
      reordered.indexOf(targetDomain) + (position === 'before' ? -1 : 1),
    )
  },
)

it('movePinnedDomainInList moves adjacent to the previous or next pinned domain', () => {
  const domains = ['alpha.test', 'bravo.test', 'charlie.test']

  assert.deepEqual(movePinnedDomainInList(domains, 'bravo.test', 'previous'), ['bravo.test', 'alpha.test', 'charlie.test'])
  assert.deepEqual(movePinnedDomainInList(domains, 'bravo.test', 'next'), ['alpha.test', 'charlie.test', 'bravo.test'])
})

it('movePinnedDomainInList ignores edge and unknown domains', () => {
  const domains = ['alpha.test', 'bravo.test']

  assert.deepEqual(movePinnedDomainInList(domains, 'alpha.test', 'previous'), domains)
  assert.deepEqual(movePinnedDomainInList(domains, 'bravo.test', 'next'), domains)
  assert.deepEqual(movePinnedDomainInList(domains, 'missing.test', 'next'), domains)
})

it.prop(
  'moving an interior generated domain and reversing the move restores the list',
  [pinnedDomainIds(3), naturalNumber],
  ([ids, seed]) => {
    const domains = pinnedDomains(ids)
    const domain = domains[1 + (seed % (domains.length - 2))]

    assert.deepEqual(
      movePinnedDomainInList(
        movePinnedDomainInList(domains, domain, 'previous'),
        domain,
        'next',
      ),
      domains,
    )
    assert.deepEqual(
      movePinnedDomainInList(
        movePinnedDomainInList(domains, domain, 'next'),
        domain,
        'previous',
      ),
      domains,
    )
  },
)
