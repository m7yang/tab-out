import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageChip } from '../src/components/PageChip.js'
import type { DashboardChipData } from '../src/extension/types'

function makeChip(overrides: Partial<DashboardChipData> = {}): DashboardChipData {
  return {
    tabUrl: 'https://site.example/page',
    rawUrl: 'https://site.example/page',
    sourceType: 'tab',
    leadPrefix: '',
    pathGroupLabel: '',
    displaySegments: ['Example Page'],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: 'Example Page',
    dupeCount: 1,
    faviconUrl: 'https://site.example/icon.png',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides
  }
}

function renderChip(overrides: Partial<DashboardChipData> = {}): string {
  return renderToStaticMarkup(React.createElement(PageChip, { chip: makeChip(overrides) }))
}

test('a live tab chip keeps its favicon at full strength', () => {
  const html = renderChip()
  assert.match(html, /chip-favicon /)
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a loading live tab chip replaces its favicon with a loading indicator', () => {
  const html = renderChip({ loading: true })
  assert.match(html, /data-tabout-part="loading-indicator"/)
  assert.match(html, /style="color:#0b57d0"/)
  assert.doesNotMatch(html, /chip-favicon /)
  assert.match(html, /aria-label="Example Page · Loading"/)
})

test('a suspended tab chip dims its favicon', () => {
  const html = renderChip({ suspended: true })
  assert.match(html, /chip-favicon-dimmed/)
})

test('a closed saved page chip dims its favicon', () => {
  const html = renderChip({ sourceType: 'saved-page', saved: true, closedSaved: true })
  assert.match(html, /chip-favicon-dimmed/)
})

test('a closed saved page chip dims its default favicon too', () => {
  const html = renderChip({ sourceType: 'saved-page', saved: true, closedSaved: true, faviconUrl: '' })
  assert.match(html, /default-favicon-image[^"]*chip-favicon-dimmed|chip-favicon-dimmed[^"]*default-favicon-image/)
})

test('a retained page uses the same closed favicon treatment without saved wording', () => {
  const html = renderChip({
    sourceType: 'retained-page',
    dupeCount: 4,
    retainedPageIdentity: 'identity-example',
    retainedPageClosureToken: 'lifetime-example'
  })

  assert.match(html, /chip-favicon-dimmed/)
  assert.doesNotMatch(html, /Closed saved page|Saved page|open copies/)
  assert.doesNotMatch(html, /chip-favicon-stack-layer|chip-title-variant-dupe/)
})

test('a faviconless retained page uses the dimmed closed-page default favicon', () => {
  const html = renderChip({
    sourceType: 'retained-page',
    faviconUrl: '',
    retainedPageIdentity: 'identity-example',
    retainedPageClosureToken: 'lifetime-example'
  })

  assert.match(html, /default-favicon-image[^"]*chip-favicon-dimmed|chip-favicon-dimmed[^"]*default-favicon-image/)
})

test('folded targets distinguish opening a closed page from focusing a live tab', () => {
  const html = renderChip({
    envs: [
      {
        prefix: 'env-alpha',
        tabUrl: 'https://live.site.example/page',
        rawUrl: 'https://live.site.example/page',
        sourceType: 'tab'
      },
      {
        prefix: 'env-beta',
        tabUrl: 'https://closed.site.example/page',
        rawUrl: 'https://closed.site.example/page',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-closed',
        retainedPageClosureToken: 'lifetime-closed'
      }
    ]
  })

  assert.match(html, /aria-label="Focus env-alpha tab"/)
  assert.match(html, /aria-label="Open env-beta closed page"/)
  assert.doesNotMatch(html, /aria-label="Focus env-beta tab"/)
})

test('a bookmark chip keeps its favicon at full strength', () => {
  const html = renderChip({ sourceType: 'bookmark' })
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a history chip keeps its favicon at full strength', () => {
  const html = renderChip({ sourceType: 'history' })
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a suspended current variant keeps a distinct full-opacity label color while a live variant does not', () => {
  const html = renderChip({
    titleVariantChips: [
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', suspended: true, activeChipFrame: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' })
    ]
  })
  assert.match(html, /chip-title-variant clickable[^"]*text-neutral-600/)
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
  assert.match(html, /chip-variant-label-dimmed[^"]*text-neutral-500/)
  assert.doesNotMatch(html, /chip-variant-label-dimmed[^"]*opacity-/)
})

test('a closed-saved variant row dims its label', () => {
  const html = renderChip({
    titleVariantChips: [
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', sourceType: 'saved-page', saved: true, closedSaved: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' })
    ]
  })
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
})

test('a retained variant row dims its label without a duplicate badge', () => {
  const html = renderChip({
    titleVariantChips: [
      makeChip({
        tabUrl: 'https://site.example/a',
        rawUrl: 'https://site.example/a',
        pathSuffix: '/a',
        sourceType: 'retained-page',
        dupeCount: 3,
        retainedPageIdentity: 'identity-a',
        retainedPageClosureToken: 'lifetime-a'
      }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' })
    ]
  })

  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
  assert.doesNotMatch(html, /chip-title-variant-dupe|open copies|Closed saved page/)
})
