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
    ...overrides
  }
}

function renderHeaderStats(stats: DashboardStats): string {
  return renderToStaticMarkup(
    React.createElement(HeaderStats, {
      ...stats,
      onDedupAll: () => {},
      onCloseFiltered: () => {}
    })
  )
}

test('HeaderStats shows the active count when some tabs are suspended', () => {
  const html = renderHeaderStats(makeStats({ totalTabs: 200, activeTabs: 30 }))

  assert.match(html, /200 tabs/)
  assert.match(html, /\(30 active\)/)
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
    filtering: true
  }))

  assert.match(html, />2\/3 tabs<\/span>/)
  assert.match(html, />2\/3<\/span><span class="sr-only"> windows<\/span>/)
  assert.match(html, />2 domains<\/span>/)
  assert.match(html, /data-tabout-part="dedupe-button"/)
  assert.match(html, />Dedupe <span data-tabout-part="dedupe-count">1<\/span>/)
  assert.match(html, /aria-label="Close 2 filtered tabs">Close 2<\/button>/)
  assert.doesNotMatch(html, /·|<svg/)
})
