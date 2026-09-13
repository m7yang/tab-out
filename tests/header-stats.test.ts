import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { HeaderStats } from '../src/components/HeaderStats.js'
import type { DashboardStats } from '../src/extension/types'

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    totalTabs: 0,
    activeTabs: 0,
    visibleTabs: 0,
    totalWindows: 0,
    visibleWindows: 0,
    totalDomains: 0,
    visibleDomains: 0,
    dedupCount: 0,
    filteredCloseCount: 0,
    hasCards: false,
    filtering: false,
    ...overrides,
  }
}

function renderHeaderStats(stats: DashboardStats): string {
  return renderToStaticMarkup(
    React.createElement(HeaderStats, {
      ...stats,
      onCloseFiltered: () => {},
    }),
  )
}

test('HeaderStats shows the active count when some tabs are suspended', () => {
  const html = renderHeaderStats(makeStats({ totalTabs: 200, activeTabs: 30 }))

  assert.match(html, />30<span class="font-normal text-muted-foreground"> of 200 tabs active<\/span>/)
})

test('HeaderStats hides the active count when no tabs are suspended', () => {
  const html = renderHeaderStats(makeStats({ totalTabs: 200, activeTabs: 200 }))

  assert.match(html, /200 tabs/)
  assert.doesNotMatch(html, /active/)
})

test('HeaderStats renders accessible counts and text-only actions', () => {
  const html = renderHeaderStats(makeStats({
    totalTabs: 3,
    activeTabs: 3,
    visibleTabs: 2,
    totalWindows: 3,
    visibleWindows: 2,
    totalDomains: 2,
    visibleDomains: 2,
    dedupCount: 1,
    filteredCloseCount: 2,
    hasCards: true,
    filtering: true,
  }))

  assert.match(html, />2\/3 tabs<\/span>/)
  assert.match(html, />2\/3<\/span><span class="sr-only"> windows<\/span>/)
  assert.match(html, />2 domains<\/span>/)
  assert.doesNotMatch(html, /data-tabout-part="dedupe-button"|Dedupe/)
  assert.match(html, /aria-label="Close 2 matching open tabs"/)
  assert.match(html, />Close 2 open tabs<\/button>/)
  assert.doesNotMatch(html, /·|<svg/)
})
