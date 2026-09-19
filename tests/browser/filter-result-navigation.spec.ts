import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { build } from 'vite'
import type { createFilterResultNavigationSession } from '../../src/components/filter-result-navigation/session.js'
import type { createFilterResultNavigationDom } from '../../src/components/filter-result-navigation/dom.js'

declare global {
  interface Window {
    __filterNavigation: {
      createFilterResultNavigationSession: typeof createFilterResultNavigationSession
      createFilterResultNavigationDom: typeof createFilterResultNavigationDom
    }
  }
}

let bundlePath: string

test.beforeAll(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'filter-navigation-fixture-'))
  const root = resolve(import.meta.dirname, '../../src/components/filter-result-navigation')
  const entry = join(outDir, 'entry.ts')
  writeFileSync(entry, `
    import { createFilterResultNavigationSession } from '${root}/session.ts'
    import { createFilterResultNavigationDom } from '${root}/dom.ts'
    globalThis.__filterNavigation = { createFilterResultNavigationSession, createFilterResultNavigationDom }
  `)
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      emptyOutDir: false,
      lib: { entry, fileName: () => 'navigation.js', formats: ['iife'], name: 'FilterNavigationFixture' },
      outDir,
      minify: false,
    },
  })
  bundlePath = join(outDir, 'navigation.js')
})

test.beforeEach(async ({ page }) => {
  await page.setContent(`
    <input aria-label="Filter dashboard">
    <div id="results" style="height:100px;overflow:auto">
      <button id="alpha">Alpha</button>
      <div style="height:300px"></div>
      <button id="bravo">Bravo</button>
    </div>
  `)
  await page.addScriptTag({ path: bundlePath })
})

test('the session follows remounted DOM targets, scrolls navigation and releases selection on disposal', async ({ page }) => {
  const result = await page.evaluate(() => {
    const input = document.querySelector('input')
    const original = document.getElementById('alpha')
    const results = document.getElementById('results')
    if (!input || !original || !results) throw new Error('Missing navigation fixture')
    const { createFilterResultNavigationSession, createFilterResultNavigationDom } = window.__filterNavigation
    const dom = createFilterResultNavigationDom()
    dom.attach(input)
    const session = createFilterResultNavigationSession(dom)
    const candidates = ['alpha', 'bravo'].map((key) => ({ key, identity: key, domId: key }))
    const commit = () => session.commit({
      dashboardView: 'all-tabs', source: 'tabs', sourceSelection: 'tabs', filter: 'reference',
      filterResultCandidates: candidates, filterResultSearchSettled: true,
    })
    input.focus()
    commit()
    session.handleKeyDown({ key: 'ArrowDown', preventDefault() {} })
    const firstSelection = input.getAttribute('aria-activedescendant')
    const replacement = document.createElement('button')
    replacement.id = 'alpha'
    replacement.textContent = 'Alpha remounted'
    original.replaceWith(replacement)
    commit()
    const transferred = replacement.getAttribute('data-tabout-filter-result-selected')
    const oldMarker = original.hasAttribute('data-tabout-filter-result-selected')
    session.handleKeyDown({ key: 'ArrowDown', preventDefault() {} })
    const nextSelection = input.getAttribute('aria-activedescendant')
    const scrolled = results.scrollTop > 0
    const inputFocused = document.activeElement === input
    session.dispose()
    return {
      firstSelection, transferred, oldMarker, nextSelection, scrolled, inputFocused,
      clearedInput: !input.hasAttribute('aria-activedescendant'),
      remainingMarkers: document.querySelectorAll('[data-tabout-filter-result-selected]').length,
    }
  })
  expect(result).toEqual({
    firstSelection: 'alpha', transferred: 'true', oldMarker: false, nextSelection: 'bravo',
    scrolled: true, inputFocused: true, clearedInput: true, remainingMarkers: 0,
  })
})

test('pending Enter skips hidden DOM targets and forwards one bubbling modifier click', async ({ page }) => {
  const result = await page.evaluate(() => {
    const input = document.querySelector('input')
    const results = document.getElementById('results')
    const alpha = document.getElementById('alpha')
    const bravo = document.getElementById('bravo')
    if (!input || !results || !alpha || !bravo) throw new Error('Missing navigation fixture')
    alpha.hidden = true
    bravo.hidden = true
    const clicks: Array<{ target: string | undefined, metaKey: boolean, shiftKey: boolean, preventedFirst: boolean }> = []
    let prevented = false
    results.addEventListener('click', (event) => {
      clicks.push({
        target: event.target instanceof HTMLElement ? event.target.id : undefined,
        metaKey: event.metaKey, shiftKey: event.shiftKey, preventedFirst: prevented,
      })
    })
    const { createFilterResultNavigationSession, createFilterResultNavigationDom } = window.__filterNavigation
    const dom = createFilterResultNavigationDom()
    dom.attach(input)
    const session = createFilterResultNavigationSession(dom)
    const commit = () => session.commit({
      dashboardView: 'all-tabs', source: 'tabs', sourceSelection: 'tabs', filter: 'reference',
      filterResultCandidates: ['alpha', 'bravo'].map((key) => ({ key, identity: key, domId: key })),
      filterResultSearchSettled: false,
    })
    input.focus()
    commit()
    session.handleKeyDown({ key: 'Enter', metaKey: true, shiftKey: true, preventDefault() { prevented = true } })
    const clicksBeforeMount = clicks.length
    bravo.hidden = false
    commit()
    commit()
    session.dispose()
    return { clicksBeforeMount, clicks, inputFocused: document.activeElement === input }
  })
  expect(result).toEqual({
    clicksBeforeMount: 0,
    clicks: [{ target: 'bravo', metaKey: true, shiftKey: true, preventedFirst: true }],
    inputFocused: true,
  })
})
