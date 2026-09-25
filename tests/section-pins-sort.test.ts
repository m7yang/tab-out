import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDomainGroups, computeDomainCardViewModel } from '../src/extension/render.js'
import { pathgroupPinId, subdomainPinId, websitePathPinId } from '../src/extension/section-pins.js'
import type { DashboardTab } from '../src/extension/types'

// render.ts transitively reads chrome.runtime.getURL; this shim mirrors the
// setup in render-pipeline.test.ts so the view-model layer can run under the
// node test harness.
;(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    getURL(path: string) {
      return `chrome-extension://tab-out${path}`
    },
  },
}

function makeTab(overrides: Partial<DashboardTab> & { url: string, id: number }): DashboardTab {
  return {
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    title: overrides.title || '',
    favIconUrl: overrides.favIconUrl || '',
    windowId: overrides.windowId || 1,
    active: overrides.active || false,
    pinned: overrides.pinned || false,
    groupId: overrides.groupId ?? -1,
    isTabOut: false,
    isApp: overrides.isApp || false,
    ...overrides,
  }
}

function groupFor(domain: string, tabs: DashboardTab[]) {
  const group = buildDomainGroups(tabs).find((g) => g.domain === domain)
  assert.ok(group, `expected a domain group for ${domain}`)
  return group
}

test('computeDomainCardViewModel floats a pinned subdomain section to the top of its card', () => {
  // Three google.com subdomains. Each subdomain uses unique pathnames so the
  // cross-env fold (which would prepend a __shared__ section) doesn't fire,
  // and the per-subdomain paths don't accumulate into generic website-path
  // buckets either. Default order is alphabetical: docs, drive, mail.
  const tabs = [
    makeTab({ id: 1, url: 'https://docs.google.com/doc1' }),
    makeTab({ id: 2, url: 'https://docs.google.com/doc2' }),
    makeTab({ id: 3, url: 'https://drive.google.com/file1' }),
    makeTab({ id: 4, url: 'https://drive.google.com/file2' }),
    makeTab({ id: 5, url: 'https://mail.google.com/inbox' }),
    makeTab({ id: 6, url: 'https://mail.google.com/sent' }),
  ]
  const group = groupFor('google.com', tabs)

  const baseline = computeDomainCardViewModel(group)
  assert.deepEqual(baseline.sections?.map((s) => s.key), ['docs', 'drive', 'mail'])

  const pinnedSections = new Set([subdomainPinId('google.com', 'mail')])
  const vm = computeDomainCardViewModel(group, { pinnedSections })
  assert.deepEqual(vm.sections?.map((s) => s.key), ['mail', 'docs', 'drive'])
  assert.deepEqual(vm.sections?.map((s) => s.isPinned), [true, false, false])
})

test('computeDomainCardViewModel floats a pinned website-path section to the top within its subdomain', () => {
  // docs.google.com tabs across /document and /spreadsheets — the built-in
  // website-path rule splits them into two website-path sections. Default
  // bucket order is alphabetical: /document, /spreadsheets. Pinning the
  // /spreadsheets section should float it first.
  const tabs = [
    makeTab({ id: 1, url: 'https://docs.google.com/document/d/aaa/edit' }),
    makeTab({ id: 2, url: 'https://docs.google.com/document/d/bbb/edit' }),
    makeTab({ id: 3, url: 'https://docs.google.com/spreadsheets/d/ccc/edit' }),
    makeTab({ id: 4, url: 'https://docs.google.com/spreadsheets/d/ddd/edit' }),
  ]
  const group = groupFor('google.com', tabs)

  const baseline = computeDomainCardViewModel(group)
  const baselineSection = baseline.sections?.find((s) => s.key === 'docs')
  assert.ok(baselineSection)
  assert.deepEqual(
    baselineSection.websitePathSections.map((wps) => wps.key),
    ['/document', '/spreadsheets'],
  )

  const pinnedSections = new Set([
    websitePathPinId('google.com', 'docs', '/spreadsheets'),
  ])
  const vm = computeDomainCardViewModel(group, { pinnedSections })
  const section = vm.sections?.find((s) => s.key === 'docs')
  assert.ok(section)
  assert.deepEqual(
    section.websitePathSections.map((wps) => wps.key),
    ['/spreadsheets', '/document'],
  )
  assert.deepEqual(
    section.websitePathSections.map((wps) => wps.isPinned),
    [true, false],
  )
})

test('computeDomainCardViewModel floats a pinned pathgroup cluster to the top within its parent', () => {
  // Both repository clusters stay under the visible /acme owner section.
  // Default order is alphabetical: acme/one, acme/two.
  const tabs = [
    makeTab({ id: 1, url: 'https://github.com/acme/one' }),
    makeTab({ id: 2, url: 'https://github.com/acme/one/issues' }),
    makeTab({ id: 3, url: 'https://github.com/acme/two' }),
    makeTab({ id: 4, url: 'https://github.com/acme/two/wiki' }),
  ]
  const group = groupFor('github.com', tabs)

  const baseline = computeDomainCardViewModel(group)
  const baselineSection = baseline.sections?.find((s) => s.key === '')?.websitePathSections[0]
  assert.ok(baselineSection)
  assert.deepEqual(baselineSection.clusters.map((c) => c.key), ['acme/one', 'acme/two'])

  const pinnedSections = new Set([
    pathgroupPinId('github.com', '', '/acme', 'acme/two'),
  ])
  const vm = computeDomainCardViewModel(group, { pinnedSections })
  const section = vm.sections?.find((s) => s.key === '')?.websitePathSections[0]
  assert.ok(section)
  assert.deepEqual(section.clusters.map((c) => c.key), ['acme/two', 'acme/one'])
  assert.deepEqual(section.clusters.map((c) => c.isPinned), [true, false])
})

test('computeDomainCardViewModel leaves order unchanged when pinnedSections is empty or omitted', () => {
  const tabs = [
    makeTab({ id: 1, url: 'https://docs.google.com/doc1' }),
    makeTab({ id: 2, url: 'https://docs.google.com/doc2' }),
    makeTab({ id: 3, url: 'https://mail.google.com/inbox' }),
    makeTab({ id: 4, url: 'https://mail.google.com/sent' }),
  ]
  const group = groupFor('google.com', tabs)

  const omitted = computeDomainCardViewModel(group)
  const empty = computeDomainCardViewModel(group, { pinnedSections: new Set() })

  assert.deepEqual(omitted.sections?.map((s) => s.key), ['docs', 'mail'])
  assert.deepEqual(empty.sections?.map((s) => s.key), ['docs', 'mail'])
  assert.deepEqual(empty.sections?.map((s) => s.isPinned), [false, false])
})
