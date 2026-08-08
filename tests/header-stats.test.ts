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

test('HeaderStats renders compact accessible counts without visible separators', () => {
  const html = renderHeaderStats(makeStats({
    totalTabs: 3,
    activeTabs: 3,
    totalWindows: 3,
    visibleWindows: 2,
    totalDomains: 2,
    visibleDomains: 2,
    hasCards: true
  }))

  assert.match(html, /data-tabout="header-stats" class="[^"]*leading-\(--header-control-line-height\)/)
  assert.match(html, /data-tabout-part="tab-count"/)
  assert.match(html, /data-tabout-part="secondary-counts" class="[^"]*gap-2\.5[^"]*ml-0\.5[^"]*"><span class="sr-only">, <\/span>/)
  assert.match(html, /data-tabout-part="window-count" class="whitespace-nowrap"><span data-tabout-part="window-count-value">2\/3<\/span><span class="sr-only"> windows<\/span><span data-tabout-part="window-icon"/)
  assert.match(html, /data-tabout-part="window-icon" class="icon-\[lucide--app-window-mac\] ml-1 align-\[-0\.125em\]"/)
  assert.match(html, /<span class="sr-only">, <\/span><span data-tabout-part="domain-count"[^>]*>2 domains<\/span>/)
  assert.doesNotMatch(html, /·/)
})

test('HeaderStats preserves the standard gap beside its dedupe action', () => {
  const html = renderHeaderStats(makeStats({
    totalTabs: 3,
    activeTabs: 3,
    totalWindows: 1,
    visibleWindows: 1,
    dedupCount: 1
  }))

  assert.match(html, /data-tabout-part="dedupe-button"/)
  assert.match(html, /data-tabout-part="dedupe-label">Dedupe <span data-tabout-part="dedupe-count">1<\/span><\/span>/)
  assert.match(html, /data-tabout-part="dedupe-button"[^>]*leading-\(--header-control-line-height\)/)
  assert.match(html, /data-tabout-part="secondary-counts" class="inline-flex items-center gap-2\.5"/)
  assert.doesNotMatch(html, /data-tabout-part="secondary-counts" class="[^"]*ml-0\.5/)
  assert.match(html, /data-tabout-part="window-count" class="whitespace-nowrap"/)
})

test('HeaderStats renders the filtered close action without an icon gap', () => {
  const html = renderHeaderStats(makeStats({
    totalTabs: 3,
    activeTabs: 3,
    visibleTabs: 2,
    filteredCloseCount: 2,
    filtering: true
  }))

  assert.match(html, /data-tabout-part="close-filtered-button"/)
  assert.match(html, /aria-label="Close 2 filtered tabs">Close 2<\/button>/)
  assert.doesNotMatch(html, /data-tabout-part="close-filtered-button"[^>]*gap-1\.25/)
  assert.doesNotMatch(html, /<svg/)
})
