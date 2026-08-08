import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePageChipFocusRecoveryCard } from '../src/components/PageChipFocusRecovery.js'

function card(domain: string, isConnected = true): HTMLElement {
  return {
    dataset: { taboutDomain: domain },
    isConnected
  } as unknown as HTMLElement
}

function missionGrid(cards: HTMLElement[]): HTMLElement {
  return {
    querySelectorAll: () => cards
  } as unknown as HTMLElement
}

function ownerDocument(grids: Record<string, HTMLElement>): Document {
  return {
    getElementById: (id: string) => grids[id] ?? null
  } as unknown as Document
}

test('focus recovery does not substitute a same-domain card from another mission grid', () => {
  const removedMatchedCard = card('example.test', false)
  const unrelatedOtherTabsCard = card('example.test')
  const document = ownerDocument({
    openTabsMissions: missionGrid([]),
    openTabsMissionsUnmatched: missionGrid([unrelatedOtherTabsCard])
  })

  assert.equal(resolvePageChipFocusRecoveryCard(
    document,
    removedMatchedCard,
    'openTabsMissions',
    'example.test'
  ), null)
})

test('focus recovery can resolve a replacement card inside the captured mission grid', () => {
  const removedCard = card('example.test', false)
  const replacementCard = card('example.test')
  const document = ownerDocument({
    openTabsMissions: missionGrid([replacementCard])
  })

  assert.equal(resolvePageChipFocusRecoveryCard(
    document,
    removedCard,
    'openTabsMissions',
    'example.test'
  ), replacementCard)
})
