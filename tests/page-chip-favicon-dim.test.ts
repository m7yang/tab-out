import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageChip } from '../src/components/PageChip.js'
import type { DashboardChipData } from '../src/extension/types'
import { sameTitlePageChipPlan } from './helpers/same-title-page-chip-plan.js'

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
    ...overrides,
  }
}

function presentationsForTargets(targets: DashboardChipData[]) {
  return sameTitlePageChipPlan(targets)
}

function renderChip(overrides: Partial<DashboardChipData> = {}, filter = ''): string {
  return renderToStaticMarkup(React.createElement(PageChip, { chip: makeChip(overrides), filter }))
}

function pageChipClass(html: string): string {
  const className = html.match(/data-tabout="page-chip"[^>]*class="([^"]+)"/)?.[1]
  assert.ok(className)
  return className
}

function chipTextClass(html: string): string {
  const className = html.match(/class="([^"]*\bchip-text\b[^"]*)"/)?.[1]
  assert.ok(className)
  return className
}

test('a live tab chip keeps its favicon at full strength', () => {
  const html = renderChip()
  assert.match(html, /chip-favicon /)
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
  assert.doesNotMatch(html, /data-loading=/)
  assert.doesNotMatch(html, /aria-busy=/)
})

test('a loading live tab chip replaces its favicon with a loading indicator', () => {
  const html = renderChip({ loading: true })
  assert.match(html, /data-tabout-part="loading-indicator"/)
  assert.match(html, /style="color:#0b57d0"/)
  assert.doesNotMatch(html, /chip-favicon /)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /aria-label="Example Page · Loading"/)
})

test('loading title-variant and folded chips expose one busy semantic group', () => {
  const titleVariantChip = {
    sameTitlePageChipPlan: presentationsForTargets([
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', loading: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' }),
    ]),
  }
  const foldedChip = {
    envs: [
      { prefix: 'env-alpha', tabUrl: 'https://env-alpha.site.example/page', rawUrl: 'https://env-alpha.site.example/page' },
      { prefix: 'env-beta', tabUrl: 'https://env-beta.site.example/page', rawUrl: 'https://env-beta.site.example/page' },
    ],
  }
  const loadingHtml = [
    renderChip({ ...titleVariantChip, loading: true }),
    renderChip({ ...foldedChip, loading: true }),
  ]
  const completeHtml = [renderChip(titleVariantChip), renderChip(foldedChip)]

  for (const html of loadingHtml) {
    assert.match(html, /data-tabout="page-chip"/)
    assert.match(html, /data-loading="true"/)
    assert.match(html, /role="group"/)
    assert.match(html, /aria-busy="true"/)
    assert.match(html, /aria-label="[^"]*Loading[^"]*"/)
  }
  for (const html of completeHtml) {
    assert.match(html, /role="group"/)
    assert.doesNotMatch(html, /data-loading=/)
    assert.doesNotMatch(html, /aria-busy=/)
    assert.doesNotMatch(html, /aria-label="[^"]*Loading[^"]*"/)
  }
})

test('a suspended tab chip dims its favicon', () => {
  const html = renderChip({ suspended: true })
  assert.match(html, /chip-favicon-dimmed/)
  assert.doesNotMatch(html, /saturate-/)
})

test('a closed saved page chip dims its favicon', () => {
  const html = renderChip({ sourceType: 'saved-page', saved: true, closedSaved: true })
  assert.match(html, /chip-favicon-dimmed/)
  assert.match(html, /saturate-60/)
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
    retainedPageClosureToken: 'lifetime-example',
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
    retainedPageClosureToken: 'lifetime-example',
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
        sourceType: 'tab',
      },
      {
        prefix: 'env-beta',
        tabUrl: 'https://closed.site.example/page',
        rawUrl: 'https://closed.site.example/page',
        sourceType: 'retained-page',
        closedSaved: true,
        retainedPageIdentity: 'identity-closed',
        retainedPageClosureToken: 'lifetime-closed',
      },
    ],
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
    sameTitlePageChipPlan: presentationsForTargets([
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', suspended: true, activeChipFrame: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' }),
    ]),
  })
  assert.match(html, /chip-title-variant clickable[^"]*text-tab-live/)
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
  assert.match(html, /chip-variant-label-dimmed[^"]*text-neutral-600/)
  assert.doesNotMatch(html, /chip-variant-label-dimmed[^"]*opacity-/)
})

test('a filtered mixed group keeps a live shared title while dimming its closed variant label', () => {
  const html = renderChip({
    sameTitlePageChipPlan: presentationsForTargets([
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', sourceType: 'saved-page', saved: true, closedSaved: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' }),
    ]),
  }, 'Example')
  const className = pageChipClass(html)

  assert.match(className, /\btext-tab-live\b/)
  assert.doesNotMatch(className, /\btext-tab-closed\b/)
  assert.match(chipTextClass(html), /--color-tab-live/)
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
})

test('an all-closed title-variant group dims its shared title like a closed page chip', () => {
  const html = renderChip({
    sourceType: 'saved-page',
    saved: true,
    closedSaved: true,
    sameTitlePageChipPlan: presentationsForTargets([
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', sourceType: 'saved-page', saved: true, closedSaved: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b', sourceType: 'saved-page', saved: true, closedSaved: true }),
    ]),
  })
  const className = pageChipClass(html)

  assert.match(className, /\btext-tab-closed\b/)
  assert.doesNotMatch(className, /\btext-tab-live\b/)
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 2)
})

test('all-closed group titles keep their closed tone while filtering', () => {
  const allClosedGroups: Partial<DashboardChipData>[] = [
    {
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true,
      sameTitlePageChipPlan: presentationsForTargets([
        makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', sourceType: 'saved-page', saved: true, closedSaved: true }),
        makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b', sourceType: 'saved-page', saved: true, closedSaved: true }),
      ]),
    },
    {
      sourceType: 'saved-page',
      saved: true,
      closedSaved: true,
      envs: [
        { prefix: 'env-alpha', tabUrl: 'https://env-alpha.site.example/page', rawUrl: 'https://env-alpha.site.example/page', sourceType: 'saved-page', saved: true, closedSaved: true },
        { prefix: 'env-beta', tabUrl: 'https://env-beta.site.example/page', rawUrl: 'https://env-beta.site.example/page', sourceType: 'saved-page', saved: true, closedSaved: true },
      ],
    },
  ]

  for (const group of allClosedGroups) {
    const html = renderChip(group, 'Example')
    const className = pageChipClass(html)

    assert.match(className, /\btext-tab-closed\b/)
    assert.doesNotMatch(className, /\btext-tab-live\b/)
    assert.doesNotMatch(chipTextClass(html), /--color-tab-live/)
  }
})

test('a retained variant row dims its label without a duplicate badge', () => {
  const html = renderChip({
    sameTitlePageChipPlan: presentationsForTargets([
      makeChip({
        tabUrl: 'https://site.example/a',
        rawUrl: 'https://site.example/a',
        pathSuffix: '/a',
        sourceType: 'retained-page',
        dupeCount: 3,
        retainedPageIdentity: 'identity-a',
        retainedPageClosureToken: 'lifetime-a',
      }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' }),
    ]),
  })

  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
  assert.doesNotMatch(html, /chip-title-variant-dupe|open copies|Closed saved page/)
})
