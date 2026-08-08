import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DomainCard } from '../src/components/DomainCard.js'
import { DomainCardProvider, type DomainCardContextValue } from '../src/components/DomainCardContext.js'
import { DashboardActionsProvider, HoverStateProvider } from '../src/components/DashboardInteractionContext.js'
import type { HoverUrlChangeHandler, HoverUrlSource, LayoutChangeHandler, ReorderPinnedDomainHandler, TogglePinnedDomainHandler, TogglePinnedPageChipHandler, TogglePinnedSectionHandler } from '../src/components/types.js'
import { FlatSection } from '../src/components/FlatSection.js'
import { PageChip } from '../src/components/PageChip.js'
import { PAGE_CHIP_CLOSE_ANIMATION_MS, startPageChipCloseAnimation } from '../src/components/PageChipCloseAnimation.js'
import { PathgroupSection } from '../src/components/PathgroupSection.js'
import { TabHistoryPanel } from '../src/components/TabHistoryPanel.js'
import { WebsitePathSection } from '../src/components/WebsitePathSection.js'
import type { TitleSuppressionTone } from '../src/components/title-suppression.js'
import { allocateCardSuppressionTones } from '../src/extension/title-suppression-tones.js'
import type { DashboardCardVM, DashboardChipData, DomainGroup, TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../src/extension/types'

// Hand-built card VMs skip computeDomainCardViewModel, so run them through
// the same tone allocation the compute walk applies before rendering.
function withSuppressionTones(vm: DashboardCardVM): DashboardCardVM {
  const { cardSuppressionToneScope, sections } = allocateCardSuppressionTones(vm.suppressedTitleParts ?? [], vm.sections ?? [])
  return { ...vm, cardSuppressionToneScope, sections }
}

function makeChip(overrides: Partial<DashboardChipData> = {}): DashboardChipData {
  return {
    tabUrl: 'https://openai.com/docs',
    rawUrl: 'https://openai.com/docs',
    sourceType: 'bookmark',
    leadPrefix: '',
    pathGroupLabel: '',
    displaySegments: ['OpenAI Docs'],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: 'OpenAI Docs',
    dupeCount: 1,
    faviconUrl: '',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides
  }
}

// Mirrors the old single-context override surface so the tests below keep passing the
// same fields. The ambient hover/handler fields are now routed to the split contexts.
type RenderContextOverrides = Partial<DomainCardContextValue> & {
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
  onTogglePinnedDomain?: TogglePinnedDomainHandler | null
  onReorderPinnedDomain?: ReorderPinnedDomainHandler | null
  onTogglePinnedSection?: TogglePinnedSectionHandler | null
  onTogglePinnedPageChip?: TogglePinnedPageChipHandler | null
}

function renderWithDomainCardContext(element: React.ReactElement, overrides: RenderContextOverrides = {}) {
  const value: DomainCardContextValue = {
    activeSuppressedTitle: overrides.activeSuppressedTitle ?? '',
    setActiveSuppressedTitle: overrides.setActiveSuppressedTitle ?? (() => {}),
    dedupeBadgesClosing: overrides.dedupeBadgesClosing ?? false,
    suppressionCloseTargetsByText: overrides.suppressionCloseTargetsByText ?? {},
    suppressionSuspendTargetsByText: overrides.suppressionSuspendTargetsByText ?? {}
  }
  const hoverState = {
    url: overrides.activeHoverUrl ?? '',
    urls: overrides.activeHoverUrls ?? [],
    source: overrides.activeHoverSource ?? null
  }
  const actions = {
    onHoverUrlChange: overrides.onHoverUrlChange ?? (() => {}),
    onLayoutChange: overrides.onLayoutChange ?? (() => {}),
    onTogglePinnedDomain: overrides.onTogglePinnedDomain ?? (() => {}),
    onReorderPinnedDomain: overrides.onReorderPinnedDomain ?? (() => {}),
    onTogglePinnedSection: overrides.onTogglePinnedSection ?? (() => {}),
    onTogglePinnedPageChip: overrides.onTogglePinnedPageChip ?? (() => {})
  }

  return renderToStaticMarkup(
    React.createElement(
      DashboardActionsProvider,
      { value: actions },
      React.createElement(
        HoverStateProvider,
        { value: hoverState },
        React.createElement(DomainCardProvider, { value }, element)
      )
    )
  )
}

function renderTabHistoryPanel(
  props: Record<string, unknown>,
  hover: { activeHoverUrl?: string; activeHoverUrls?: readonly string[]; activeHoverSource?: HoverUrlSource | null } = {}
): string {
  const hoverState = {
    url: hover.activeHoverUrl ?? '',
    urls: hover.activeHoverUrls ?? [],
    source: hover.activeHoverSource ?? null
  }
  const actions = {
    onHoverUrlChange: () => {},
    onLayoutChange: () => {},
    onTogglePinnedDomain: () => {},
    onReorderPinnedDomain: () => {},
    onTogglePinnedSection: () => {},
    onTogglePinnedPageChip: () => {}
  }
  return renderToStaticMarkup(
    React.createElement(
      DashboardActionsProvider,
      { value: actions },
      React.createElement(
        HoverStateProvider,
        { value: hoverState },
        React.createElement(TabHistoryPanel as React.ComponentType<any>, props)
      )
    )
  )
}

function assertInstantActionClass(className: string) {
  assert.doesNotMatch(className, /(?:^|\s)(?:transition(?:-\S+)?|duration-\S+|delay-\S+|ease-\S+)(?:\s|$)/)
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) assert.fail(`expected item at index ${index}`)
  return value
}

function historyEntryElements(html: string) {
  return Array.from(
    html.matchAll(/<div\b(?=[^>]*class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)")[^>]*>/g),
    (match) => ({ className: requiredAt(match, 1), tag: match[0] })
  )
}

function makeHistoryEntry(overrides: Partial<TabHistoryEntry> = {}): TabHistoryEntry {
  return {
    index: 0,
    tabId: 101,
    windowId: 1,
    exists: true,
    active: true,
    activeInOtherWindow: false,
    isApp: false,
    pinned: false,
    discarded: false,
    suspended: false,
    cursor: true,
    current: true,
    previousTarget: false,
    nextTarget: false,
    title: 'Example Docs',
    url: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs',
    displayUrl: 'example.com/docs',
    favIconUrl: '',
    lastActivatedAt: null,
    ...overrides
  }
}

function makeHistorySnapshot(overrides: Partial<TabHistorySnapshot> = {}): TabHistorySnapshot {
  return {
    stackSize: 1,
    maxSize: 40,
    cursorIndex: 0,
    currentIndex: 0,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: 101,
    activeWindowId: 1,
    activeWasInserted: false,
    entries: [makeHistoryEntry()],
    ...overrides
  }
}

function makeWorkingSetItem(overrides: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    key: 'https://example.com/docs',
    tabId: 101,
    windowId: 1,
    tabUrl: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs',
    title: 'Example Docs',
    displayUrl: 'example.com/docs',
    faviconUrl: '',
    dupeCount: 1,
    active: true,
    activeInOtherWindow: false,
    score: 100,
    lastActivatedAt: 0,
    ...overrides
  }
}

function makeWorkingSetSnapshot(overrides: Partial<WorkingSetSnapshot> = {}): WorkingSetSnapshot {
  return {
    defaultLimit: 8,
    expandedLimit: 16,
    items: [makeWorkingSetItem()],
    ...overrides
  }
}

test('PageChip applies bionic reading emphasis to title text only', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Example Article'],
        pathGroupLabel: 'openai/docs',
        pathSuffix: '/reference'
      })
    })
  )

  assert.match(html, /<span class="chip-title-fixation\b[^"]*\bfont-semibold\b[^"]*">Exam<\/span>ple <span class="chip-title-fixation\b[^"]*\bfont-semibold\b[^"]*">Arti<\/span>cle/)
  const pathGroupMatch = html.match(/<span class="([^"]*\bchip-pathgroup\b[^"]*)"[^>]*>[\s\S]*?<\/span>/)
  const pathMatch = html.match(/<span class="([^"]*\bchip-path\b[^"]*)"[^>]*>[\s\S]*?<\/span>/)
  assert.ok(pathGroupMatch, 'path group should render')
  assert.ok(pathMatch, 'path suffix should render')
  assert.doesNotMatch(pathGroupMatch[0], /chip-title-fixation/)
  assert.doesNotMatch(pathMatch[0], /chip-title-fixation/)
})

test('PageChip does not pre-render hidden tooltip measure nodes before hover', () => {
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  ;(globalThis as typeof globalThis & { window?: unknown }).window = {} as Window & typeof globalThis
  try {
    const html = renderWithDomainCardContext(
      React.createElement(PageChip, {
        chip: makeChip({
          displaySegments: ['Example Article with enough text to need tooltip layout later'],
          tooltip: 'Example Article with enough text to need tooltip layout later'
        })
      })
    )

    assert.doesNotMatch(html, /page-chip-tooltip-measure/)
  } finally {
    if (typeof previousWindow === 'undefined') {
      delete (globalThis as typeof globalThis & { window?: unknown }).window
    } else {
      ;(globalThis as typeof globalThis & { window?: unknown }).window = previousWindow
    }
  }
})

test('PageChip skips bionic reading when title text is a URL', () => {
  const protocolUrlHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['https://example.com/docs/reference'],
        tooltip: 'https://example.com/docs/reference'
      }),
      filter: 'example'
    })
  )
  const hostUrlHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['example.com/docs/reference'],
        tooltip: 'example.com/docs/reference'
      })
    })
  )
  const unicodeHostUrlHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['münchen.de/docs/reference'],
        tooltip: 'münchen.de/docs/reference'
      })
    })
  )

  assert.match(protocolUrlHtml, /https:\/\/<mark class="chip-filter-match\b[^"]*">example<\/mark>\.com\/docs\/reference/)
  assert.doesNotMatch(protocolUrlHtml, /chip-title-fixation/)
  assert.match(hostUrlHtml, /example\.com\/docs\/reference/)
  assert.doesNotMatch(hostUrlHtml, /chip-title-fixation/)
  assert.match(unicodeHostUrlHtml, /münchen\.de\/docs\/reference/)
  assert.doesNotMatch(unicodeHostUrlHtml, /chip-title-fixation/)
})

test('PageChip lets URL titles wrap at path boundaries instead of overflowing', () => {
  const urlChipHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['example.com/resource/contentKeys/master/landing/en-US.json'],
        tooltip: 'example.com/resource/contentKeys/master/landing/en-US.json'
      })
    })
  )
  const proseChipHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Example Article Title'],
        tooltip: 'Example Article Title'
      })
    })
  )

  // URL titles carry an overflow-wrap:break-word wrapper so a long path-only URL
  // wraps at its "/" boundaries instead of overflowing the chip on one line and
  // stranding a tiny tail ("US.json") alone on the second line under the fade mask.
  assert.match(urlChipHtml, /<span class="chip-url-title[^"]*\bwrap-break-word\b[^"]*">[^<]*example\.com\/resource/)
  // Prose titles keep the tuned break-normal + bionic path — no url-break wrapper.
  assert.doesNotMatch(proseChipHtml, /chip-url-title/)
})

test('PageChip skips bionic reading inside Jira ticket references', () => {
  const ticketOnlyHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['ICS2-308'],
        tooltip: 'ICS2-308'
      })
    })
  )
  const ticketTitleHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['CT-1569 Example Article'],
        tooltip: 'CT-1569 Example Article'
      })
    })
  )
  const filteredTicketTitleHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['CT-1569 Example Article'],
        tooltip: 'CT-1569 Example Article'
      }),
      filter: '1569'
    })
  )

  assert.match(ticketOnlyHtml, /ICS2-308/)
  assert.doesNotMatch(ticketOnlyHtml, /chip-title-fixation/)
  assert.match(ticketTitleHtml, /CT-1569 <span class="chip-title-fixation\b[^"]*">Exam<\/span>ple <span class="chip-title-fixation\b[^"]*">Arti<\/span>cle/)
  assert.doesNotMatch(ticketTitleHtml, /chip-title-fixation\b[^>]*>CT</)
  assert.doesNotMatch(ticketTitleHtml, /chip-title-fixation\b[^>]*>1569</)
  assert.match(filteredTicketTitleHtml, /CT-<mark class="chip-filter-match\b[^"]*">1569<\/mark> <span class="chip-title-fixation\b[^"]*">Exam<\/span>ple/)
  assert.doesNotMatch(filteredTicketTitleHtml, /chip-title-fixation\b[^>]*>CT</)
})

test('PageChip applies bionic reading to short function words and acronyms', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['The API and UX of New Checkout Flow'],
        tooltip: 'The API and UX of New Checkout Flow'
      })
    })
  )

  assert.match(
    html,
    /<span class="chip-title-fixation\b[^"]*">T<\/span>he <span class="chip-title-fixation\b[^"]*">A<\/span>PI <span class="chip-title-fixation\b[^"]*">a<\/span>nd <span class="chip-title-fixation\b[^"]*">U<\/span>X <span class="chip-title-fixation\b[^"]*">o<\/span>f <span class="chip-title-fixation\b[^"]*">N<\/span>ew <span class="chip-title-fixation\b[^"]*">Chec<\/span>kout <span class="chip-title-fixation\b[^"]*">Fl<\/span>ow/
  )
})

test('PageChip emphasizes one-character Latin words but keeps pure numbers plain', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['I 2026'],
        tooltip: 'I 2026'
      })
    })
  )

  assert.match(html, /<span class="chip-title-fixation\b[^"]*">I<\/span> 2026/)
  assert.equal([...html.matchAll(/chip-title-fixation/g)].length, 1)
})

test('PageChip treats accented Latin graphemes and internal apostrophes as complete words', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ["naïve nai\u0308ve café don't can’t München e-mail"],
        tooltip: "naïve nai\u0308ve café don't can’t München e-mail"
      })
    })
  )

  assert.match(
    html,
    /<span class="chip-title-fixation\b[^"]*">naï<\/span>ve <span class="chip-title-fixation\b[^"]*">naï<\/span>ve <span class="chip-title-fixation\b[^"]*">ca<\/span>fé <span class="chip-title-fixation\b[^"]*">don<\/span>&#x27;t <span class="chip-title-fixation\b[^"]*">can<\/span>’t <span class="chip-title-fixation\b[^"]*">Münc<\/span>hen <span class="chip-title-fixation\b[^"]*">e<\/span>-<span class="chip-title-fixation\b[^"]*">ma<\/span>il/
  )
})

test('PageChip leaves non-Latin scripts plain while formatting mixed Latin alphanumerics', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['中文 тест Αθήνα α\u0301 · العربية हिन्दी 2026 ٢٠٢٦ R2D2'],
        tooltip: '中文 тест Αθήνα α\u0301 · العربية हिन्दी 2026 ٢٠٢٦ R2D2'
      })
    })
  )

  assert.match(html, /中文 тест Αθήνα ά · العربية हिन्दी 2026 ٢٠٢٦ <span class="chip-title-fixation\b[^"]*">R2<\/span>D2/)
  assert.equal([...html.matchAll(/chip-title-fixation/g)].length, 1)
})

test('PageChip rounds odd fixation lengths up without capping long words', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['abcde\u200Bfghij\u200Bklmno'],
        tooltip: 'abcdefghijklmno'
      })
    })
  )

  assert.match(html, /<span class="chip-title-fixation\b[^"]*">abcde​fgh<\/span>ij​klmno/)
})

test('PageChip highlights matched filter keywords inside visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: 'openai'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Ope<\/span>nAI<\/mark> <span class="chip-title-fixation\b[^"]*">Do<\/span>cs/)
  assert.match(html, /chip-filter-match\b[^"]*bg-\[rgba\(234,179,8,0\.42\)\][^"]*text-foreground[^"]*\[font:inherit\]/)
  assert.match(html, /chip-text\b[^"]*text-\[color-mix\(in_srgb,var\(--color-tab-live\)_72%,var\(--color-muted-foreground\)\)\]/)
  assert.doesNotMatch(html, /\bpx-0\.5\b/)
  assert.doesNotMatch(html, /chip-filter-match\b[^"]*font-semibold/)
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  assert.ok(chipMatch, 'page chip should render')
  assert.match(requiredAt(chipMatch, 1), /\bclickable\b/)
  assert.match(requiredAt(chipMatch, 1), /\bcursor-default\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bcursor-pointer\b/)
})

test('PageChip preserves complete-word fixation across partial filter matches', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Example reading'],
        tooltip: 'Example reading'
      }),
      filter: 'amp adi'
    })
  )

  assert.match(
    html,
    /<span class="chip-title-fixation\b[^"]*">Ex<\/span><mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">am<\/span>p<\/mark>le <span class="chip-title-fixation\b[^"]*">re<\/span><mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">ad<\/span>i<\/mark>ng/
  )
})

test('PageChip highlights each parsed filter token in visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: 'docs openai'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Ope<\/span>nAI<\/mark> <mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Do<\/span>cs<\/mark>/)
})

test('PageChip renders the current active chip frame without the other-window label', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ activeChipFrame: true })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const frameMatch = html.match(/<span class="([^"]*\bactive-chip-frame\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(frameMatch, 'active chip frame should render')
  assert.match(requiredAt(chipMatch, 1), /current-active-chip\b/)
  assert.match(requiredAt(chipMatch, 1), /\bbg-neutral-50\b/)
  assert.match(requiredAt(chipMatch, 1), /\bring-neutral-400\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bhover:bg/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover::after/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bbefore:bg-neutral-700\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bbefore:w-1\b/)
  assert.match(requiredAt(frameMatch, 1), /current-active-chip-frame\b/)
  assert.match(html, /active-chip-frame\b/)
  assert.doesNotMatch(html, /Active in another window/)
})

test('PageChip renders current Tab Out chips with the history-entry frame treatment', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ activeChipFrame: true, isCurrentTabOut: true })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const frameMatch = html.match(/<span class="([^"]*\bactive-chip-frame\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(frameMatch, 'active chip frame should render')
  assert.match(requiredAt(chipMatch, 1), /current-tab-out-chip\b/)
  assert.match(requiredAt(chipMatch, 1), /\bbg-neutral-100\b/)
  assert.match(requiredAt(chipMatch, 1), /\bring-neutral-400\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /current-active-chip\b/)
  assert.match(requiredAt(frameMatch, 1), /active-history-entry-frame\b/)
  assert.match(requiredAt(frameMatch, 1), /current-tab-out-chip-frame\b/)
})

test('PageChip renders Chrome pinned Tab Out state as an icon hint', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ chromePinned: true })
    })
  )

  assert.match(html, /data-tabout-part="chrome-pin"/)
  assert.match(html, /chip-chrome-pin\b/)
  assert.match(html, /icon-\[lucide--pin\]/)
  assert.doesNotMatch(html, />Pinned</)
})

test('PageChip renders duplicate pages as a favicon stack and page pins as a favicon badge', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        sourceType: 'tab',
        dupeCount: 3,
        pagePinned: true,
        faviconUrl: 'https://example.com/favicon.ico'
      })
    })
  )

  assert.match(html, /3 open copies/)
  assert.match(html, /Pinned/)
  assert.match(html, /\bchip-favicon-stack\b/)
  assert.equal((html.match(/\bchip-favicon-stack-layer\b/g) || []).length, 2)
  assert.match(html, /\bchip-favicon-stack-layer\b[^"]*\bsize-4\b/)
  assert.doesNotMatch(html, /\bchip-favicon-stack-layer\b[^"]*\binset-0\b/)
  assert.match(html, /\bchip-page-pin-badge\b/)
  assert.match(html, /data-tabout-part="page-pin"/)
  assert.match(html, /icon-\[lucide--pin\]/)
  assert.doesNotMatch(html, /\bchip-dupe-badge\b/)
})

test('PageChip renders exact pin markers inside a unified same-title variant group', () => {
  const html = renderWithDomainCardContext(
    React.createElement(PageChip, {
      chip: makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        displaySegments: ['Example content item'],
        tooltip: 'Example content item',
        titleVariantChips: [
          makeChip({
            sourceType: 'tab',
            tabUrl: 'https://example.com/content/item?search_id=alpha',
            rawUrl: 'https://example.com/content/item?search_id=alpha',
            pathSuffix: '…?search_id=alpha',
            tooltip: '…?search_id=alpha',
            pagePinId: 'pin-alpha',
            pagePinned: true
          }),
          makeChip({
            sourceType: 'tab',
            tabUrl: 'https://example.com/content/item?search_id=bravo',
            rawUrl: 'https://example.com/content/item?search_id=bravo',
            pathSuffix: '…?search_id=bravo',
            tooltip: '…?search_id=bravo',
            pagePinId: 'pin-bravo',
            pagePinned: false
          })
        ]
      })
    })
  )
  const markerTags = Array.from(
    html.matchAll(/<span[^>]*class="[^"]*\bchip-title-variant-page-pin(?=\s|")[^"]*"[^>]*>/g),
    (match) => match[0]
  )

  assert.equal(markerTags.length, 1)
  assert.match(requiredAt(markerTags, 0), /data-tabout-part="variant-page-pin"/)
  assert.match(requiredAt(markerTags, 0), /data-pinned="true"/)
  assert.doesNotMatch(requiredAt(markerTags, 0), /\binvisible\b/)
  assert.match(requiredAt(markerTags, 0), /\bsize-2\.5\b/)
  assert.match(html, /\bchip-title-variant-page-pin-slot\b/)
  assert.match(html, /group-hover\/title-variant-actions:opacity-0/)
  assert.doesNotMatch(html, /\bchip-title-variant-label[^"\n]*\bflex-1\b/)
  assert.match(html, /\bchip-title-variant-label[^"\n]*\btext-left\b/)
  assert.doesNotMatch(html, /\bchip-page-pin-badge\b/)
})

test('PageChip keeps the other-window active chip style separate from the current active style', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ activeChipFrame: true, activeInOtherWindow: true })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const frameMatch = html.match(/<span class="([^"]*\bactive-chip-frame\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(frameMatch, 'active chip frame should render')
  assert.match(html, /Active in another window/)
  assert.match(requiredAt(chipMatch, 1), /\bhover:bg/)
  assert.match(requiredAt(chipMatch, 1), /hover::after/)
  assert.match(html, /--chip-interaction-bg:color-mix\(in srgb, var\(--card-bg\) 88%, var\(--color-neutral-600\) 12%\)/)
  assert.match(html, /--chip-rest-bg:color-mix\(in srgb, var\(--card-bg\) 92\.5%, var\(--color-neutral-600\) 7\.5%\)/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /current-active-chip\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bring-neutral-400\b/)
  assert.doesNotMatch(requiredAt(frameMatch, 1), /current-active-chip-frame\b/)
})

test('PageChip hover fade appears and clears without its own transition lag', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'bookmark', saved: true })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(requiredAt(chipMatch, 1), /\bhover:bg-\(--chip-interaction-bg\)/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bhover:bg-\[rgba\(82,82,82,0\.08\)\]/)
  assert.match(requiredAt(chipMatch, 1), /:has\(\.chip-actions\):hover::after\]:opacity-100/)
  assert.match(requiredAt(chipMatch, 1), /page-chip-expanded:has\(\.chip-actions\)::after\]:opacity-100/)
  assert.match(html, /chip-saved-hint[^\"]*group-\[\.page-chip-expanded\]\/page-chip:opacity-100/)
  assert.match(requiredAt(chipMatch, 1), /after:w-\(--chip-hover-fade-width\)/)
  assert.match(requiredAt(chipMatch, 1), /var\(--chip-hover-fade-bg\)_34%/)
  // Plain chips fill with the TRANSLUCENT overlay (a bordered neighbour's
  // line on the overlapped seam row must show through), while the fade stays
  // the OPAQUE mix so it can hide chip text under the action rail.
  assert.match(html, /--chip-interaction-bg:color-mix\(in srgb, var\(--color-neutral-600\) 10%, transparent\)/)
  assert.match(html, /--chip-hover-fade-bg:color-mix\(in srgb, var\(--card-bg\) 90%, var\(--color-neutral-600\) 10%\)/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bafter:transition-/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bafter:duration-/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bafter:ease-/)
  assert.match(requiredAt(chipMatch, 1), /transition-\[color\] duration-100/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /transition-\[color,box-shadow\]/)
  assert.match(html, /--chip-hover-fade-width:56px/)
})

test('PageChip keeps clickable hover background on expandable chips before expansion opens', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        sourceType: 'bookmark',
        saved: true,
        suppressedTitleParts: ['Example Workspace']
      })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)

  assert.ok(chipMatch, 'expandable page chip should render')
  assert.match(requiredAt(chipMatch, 1), /\bhover:bg-\(--chip-interaction-bg\)/)
  assert.match(requiredAt(chipMatch, 1), /page-chip-expanded\]:bg-\(--chip-interaction-bg\)/)
  assert.match(requiredAt(chipMatch, 1), /page-chip-tooltip-open\]:bg-\(--chip-interaction-bg\)/)
  assert.match(html, /--chip-interaction-bg:color-mix\(in srgb, var\(--color-neutral-600\) 10%, transparent\)/)
  assert.match(requiredAt(chipMatch, 1), /:has\(\.chip-actions\):hover::after\]:opacity-100/)

  // Hover can paint the interaction before React opens the title. Once open,
  // expansion itself owns that same paint so title details and chrome cannot
  // split when rounded-corner hit testing drops :hover.
  assert.match(requiredAt(chipMatch, 1), /page-chip-expanded:not\(:focus-visible\):not\(\[data-tabout-filter-result-selected=true\]\)\]:outline/)
})

test('PageChip renders a default favicon for live tabs without favIconUrl', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab', faviconUrl: '' })
    })
  )

  assert.match(html, /chip-favicon-frame/)
  assert.match(html, /default-favicon-image/)
  assert.match(html, /src="icons\/chrome-default-favicon-16\.png"/)
  assert.doesNotMatch(html, /<img class="chip-favicon\b/)
})

test('PageChip keeps app icon-only favicons centered in the app tile', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        sourceType: 'tab',
        iconOnly: true,
        isApp: true,
        faviconUrl: 'https://example.com/favicon.ico'
      })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const faviconFrameMatch = html.match(/<span class="([^"]*\bchip-favicon-frame\b[^"]*)"/)
  const faviconContentMatch = html.match(/<span class="([^"]*\bchip-favicon-content\b[^"]*)"/)

  assert.ok(chipMatch, 'icon-only chip should render')
  assert.ok(faviconFrameMatch, 'favicon frame should render')
  assert.ok(faviconContentMatch, 'favicon content should render')
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-icon-only\b/)
  assert.match(requiredAt(chipMatch, 1), /\bborder\b/)
  assert.match(requiredAt(faviconFrameMatch, 1), /\bsize-4\b/)
  assert.match(requiredAt(faviconFrameMatch, 1), /\bself-center\b/)
  assert.doesNotMatch(requiredAt(faviconFrameMatch, 1), /\bh-6\b|\bw-6\b|\bp-1\b|\bborder\b/)
  assert.match(requiredAt(faviconContentMatch, 1), /\bsize-4\b/)
})

test('PageChip does not invent live-tab favicons for read-only chips', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'bookmark', faviconUrl: '' })
    })
  )

  assert.doesNotMatch(html, /default-favicon-image/)
})

test('PageChip exposes save action through a context menu for unsaved live tabs', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab' })
    })
  )

  assert.doesNotMatch(html, /chip-save/)
  assert.doesNotMatch(html, /icon-\[mingcute--star-line\]/)
  assert.doesNotMatch(html, /aria-label="Save page"/)
  assert.doesNotMatch(html, /aria-pressed="false"/)
  assert.doesNotMatch(html, /<div[^>]*class="chip-actions\b/)
  assert.match(html, /--chip-hover-fade-width:0px/)
  assert.match(html, /aria-label="Close this tab"/)
})

test('PageChip renders the close action in the favicon slot', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab', faviconUrl: 'https://example.com/favicon.ico' })
    })
  )
  const faviconFrameMatch = html.match(/<span class="([^"]*\bchip-favicon-frame\b[^"]*)"/)
  const closeActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-close\b[^"]*)"/)

  assert.ok(faviconFrameMatch, 'favicon frame should render')
  assert.ok(closeActionMatch, 'close action should render')
  assert.match(html, /chip-favicon-frame[\s\S]*chip-close-favicon/)
  assert.match(requiredAt(faviconFrameMatch, 1), /group\/favicon-frame/)
  assert.match(requiredAt(closeActionMatch, 1), /\bchip-close-favicon\b/)
  assert.match(requiredAt(closeActionMatch, 1), /\babsolute\b/)
  assert.match(requiredAt(closeActionMatch, 1), /\bleft-1\/2\b/)
  assert.match(requiredAt(closeActionMatch, 1), /group-hover\/favicon-frame:pointer-events-auto/)
  assert.match(requiredAt(closeActionMatch, 1), /group-hover\/favicon-frame:opacity-100/)
  assert.doesNotMatch(requiredAt(closeActionMatch, 1), /group-hover\/page-chip:opacity-100/)
  assert.doesNotMatch(requiredAt(closeActionMatch, 1), /page-chip-context-menu-open/)
  assert.doesNotMatch(requiredAt(closeActionMatch, 1), /page-chip-tooltip-open/)
  assert.match(html, /chip-favicon-content\b[^"]*group-hover\/favicon-frame:opacity-0/)
  assert.doesNotMatch(html, /chip-favicon-content\b[^"]*group-hover\/page-chip:opacity-0/)
  assert.doesNotMatch(html, /<div[^>]*class="chip-actions\b/)

  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{closeActionLabel\}>/)
})

test('PageChip renders a favicon-slot close action without right-side actions', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'history', faviconUrl: '' })
    })
  )

  assert.match(html, /chip-favicon-frame[\s\S]*chip-close-favicon/)
  assert.match(html, /aria-label="Delete from history"/)
  assert.match(html, /--chip-hover-fade-width:0px/)
  assert.doesNotMatch(html, /<div[^>]*class="chip-actions\b/)
})

test('PageChip renders saved open tabs with remove-saved in the context menu and close in the favicon slot', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab', saved: true, savedPageKey: 'https://openai.com/docs' })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const closeActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-close\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(closeActionMatch, 'close action should render')
  assert.match(html, /\bpage-chip-saved\b/)
  assertInstantActionClass(requiredAt(closeActionMatch, 1))
  assert.doesNotMatch(html, /\bchip-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-pressed="true"/)
  assert.match(html, /aria-label="Close this tab"/)
})

test('PageChip renders saved bookmark chips as a read-only saved hint', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'bookmark', saved: true, savedPageKey: 'https://openai.com/docs' })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const savedHintMatch = html.match(/<span[^>]*class="([^"]*\bchip-saved-hint\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(savedHintMatch, 'read-only saved hint should render')
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-saved\b/)
  assert.match(html, /icon-\[mingcute--star-fill\]/)
  assert.match(requiredAt(savedHintMatch, 1), /group-hover\/page-chip:opacity-100/)
  assertInstantActionClass(requiredAt(savedHintMatch, 1))
  assert.doesNotMatch(requiredAt(savedHintMatch, 1), /(?:^|\s)pointer-events-auto(?:\s|$)/)
  assert.doesNotMatch(requiredAt(savedHintMatch, 1), /(?:^|\s)opacity-100(?:\s|$)/)
  assert.doesNotMatch(html, /\bchip-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Close this tab"/)
})

test('PageChip renders closed saved pages muted with grouped hover treatment and no close action', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'saved-page', saved: true, closedSaved: true, savedPageKey: 'https://openai.com/docs' })
    })
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-saved\b/)
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-saved-closed\b/)
  assert.match(requiredAt(chipMatch, 1), /\btext-tab-closed\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\btext-tab-live\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bbg-\(--chip-rest-bg\)/)
  assert.match(requiredAt(chipMatch, 1), /\bhover:outline\b/)
  assert.match(requiredAt(chipMatch, 1), /hover:outline-\(--chip-hover-border\)/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bopacity-75\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /shadow-\[inset_0_0_0_1px/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Close this tab"/)
  assert.match(html, /default-favicon-image/)
})

interface CloseAnimationGhostFixture {
  classList: {
    classes: string[]
    add(...names: string[]): void
  }
  style: Record<string, string>
  ariaHidden?: string
  getBoundingClientRect(): void
  setAttribute(name: string, value: string): void
  remove(): void
}

test('PageChip close animation removes the real row from flow and leaves a transform-only ghost', () => {
  const classNames = new Set<string>()
  const appendedNodes: CloseAnimationGhostFixture[] = []
  const removedNodes: Array<unknown> = []
  const style = {
    display: '',
    overflow: '',
    opacity: '',
    transformOrigin: '',
    transition: ''
  }
  let measured = 0
  let ghostMeasured = 0
  let layoutOptions: unknown = null
  let scheduledDelay = 0
  const chipEl = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classNames.add(name))
    },
    style,
    ownerDocument: {
      body: {
        appendChild: (node: CloseAnimationGhostFixture) => {
          appendedNodes.push(node)
        }
      }
    },
    cloneNode: (): CloseAnimationGhostFixture => ({
      classList: {
        classes: [] as string[],
        add(...names: string[]) {
          this.classes.push(...names)
        }
      },
      style: {} as Record<string, string>,
      getBoundingClientRect() {
        ghostMeasured += 1
      },
      setAttribute(name: string, value: string) {
        if (name === 'aria-hidden') this.ariaHidden = value
      },
      remove() {
        removedNodes.push(this)
      }
    }),
    getBoundingClientRect: () => {
      measured += 1
      return { left: 11.2, top: 22.8, width: 333.3, height: 37.4 }
    }
  }

  const started = startPageChipCloseAnimation(chipEl, (options) => {
    layoutOptions = options
  }, (handler, delay) => {
    scheduledDelay = delay
    handler()
    return 1
  })

  assert.equal(started, true)
  assert.equal(measured, 1)
  assert.equal(appendedNodes.length, 1)
  const [ghost] = appendedNodes
  assert.equal(ghostMeasured, 1)
  assert.equal(ghost?.ariaHidden, 'true')
  assert.equal(ghost?.style.position, 'fixed')
  assert.equal(ghost?.style.left, '11.2px')
  assert.equal(ghost?.style.top, '22.8px')
  assert.equal(ghost?.style.width, '333.3px')
  assert.equal(ghost?.style.height, '37.4px')
  assert.equal(ghost?.style.transformOrigin, 'top left')
  assert.match(ghost?.style.transition ?? '', new RegExp(`opacity ${PAGE_CHIP_CLOSE_ANIMATION_MS}ms`))
  assert.equal(ghost?.style.opacity, '0')
  assert.equal(ghost?.style.transform, 'scale(0.96)')
  assert.deepEqual(ghost?.classList.classes, ['page-chip-closing-ghost'])
  assert.equal(scheduledDelay, PAGE_CHIP_CLOSE_ANIMATION_MS + 80)
  assert.equal(removedNodes[0], ghost)
  assert.equal(style.display, 'none')
  assert.equal(style.opacity, '')
  assert.doesNotMatch(style.transition, /max-height|padding/)
  assert.ok(classNames.has('closing'))
  assert.deepEqual(layoutOptions, { animate: true })
})

test('PageChip leaves physical tab closures to refresh into retained resting state without exit motion', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /const chipCloseLeavesSavedPage =/)
  assert.doesNotMatch(pageChipSource, /onAfterClose: \(\{ shouldAnimateRemoval \}\)/)
  assert.match(pageChipSource, /onAfterClose: \(\) => \{\s*setPreview\(''\)/)
  assert.match(pageChipSource, /tabEnvs\.length === 0 &&\s*!chipCloseLeavesSavedPage/)
})

test('PageChip outlines matching live chips when an external row owns the match', () => {
  const chip = makeChip({
    tabUrl: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs'
  })
  const historyHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'history' } as RenderContextOverrides
  )
  const workingSetHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'working-set' } as RenderContextOverrides
  )
  const selfHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'chip' } as RenderContextOverrides
  )
  const historyMatch = historyHoverHtml.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const workingSetMatch = workingSetHoverHtml.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)

  assert.ok(historyMatch, 'history-hover page chip should render')
  assert.ok(workingSetMatch, 'working-set-hover page chip should render')
  assert.ok(selfHoverMatch, 'self-hover page chip should render')
  assert.match(requiredAt(historyMatch, 1), /\bpage-chip-hover-match\b/)
  assert.match(requiredAt(workingSetMatch, 1), /\bpage-chip-hover-match\b/)
  assert.doesNotMatch(requiredAt(selfHoverMatch, 1), /\bpage-chip-hover-match\b/)
})

test('PageChip renders same-title URL variants below one visible title', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"([^>]*)>/)
  const chipTextMatch = html.match(/<span class="([^"]*\bchip-text\b[^"]*)"/)
  const titleVariantContentMatch = html.match(/<span[^>]*class="([^"]*\bchip-title-variant-content\b[^"]*)"/)
  const titleVariantListMatch = html.match(/<span class="([^"]*\bchip-title-variant-list\b[^"]*)"/)
  const titleVariantShellMatch = html.match(/<span class="([^"]*\bchip-title-variant-shell\b[^"]*)"/)
  const titleVariantButtonMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant\b[^"]*)"/)
  const titleVariantActionsMatch = html.match(/<span class="([^"]*\bchip-title-variant-actions\b[^"]*)"/)
  const titleVariantActionOwnerMatch = html.match(/<span[^>]*data-tabout-part="variant-close-hit-owner"[^>]*class="([^"]*)"/)
  const titleVariantActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant-action\b[^"]*)"/)
  assert.ok(chipMatch, 'page chip should render')
  assert.ok(chipTextMatch, 'chip text should render')
  assert.ok(titleVariantContentMatch, 'title variant content should render')
  assert.ok(titleVariantListMatch, 'title variant list should render')
  assert.ok(titleVariantShellMatch, 'title variant shell should render')
  assert.ok(titleVariantButtonMatch, 'title variant button should render')
  assert.ok(titleVariantActionsMatch, 'title variant actions should render')
  assert.ok(titleVariantActionOwnerMatch, 'title variant action owner should render')
  assert.ok(titleVariantActionMatch, 'title variant action should render')
  assert.doesNotMatch(requiredAt(chipMatch, 2), /tabIndex|tabindex/)
  assert.match(requiredAt(chipMatch, 1), /hover:bg-\(--chip-interaction-bg\)/)
  assert.match(requiredAt(chipMatch, 1), /hover:outline-1/)
  assert.match(requiredAt(chipMatch, 1), /hover:-outline-offset-1/)
  assert.match(requiredAt(chipMatch, 1), /hover:outline-\(--chip-hover-border\)/)
  assert.match(requiredAt(chipMatch, 1), /page-chip-context-menu-open\]:outline-\(--chip-hover-border\)/)
  assert.match(requiredAt(chipMatch, 1), /page-chip-tooltip-open\]:outline-\(--chip-hover-border\)/)
  assert.match(html, /--chip-interaction-bg:color-mix\(in srgb, var\(--card-bg\) 96\.5%, var\(--color-neutral-600\) 3\.5%\)/)
  assert.match(html, /--chip-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 22%, transparent\)/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:bg-\[rgba\(82,82,82,0\.02\)\]/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:bg-\[rgba\(82,82,82,0\.05\)\]/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:bg-\[rgba\(82,82,82,0\.08\)\]/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:border/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:ring/)
  assert.match(requiredAt(chipTextMatch, 1), /\bmax-h-none\b/)
  assert.match(requiredAt(chipTextMatch, 1), /overflow-visible!/)
  assert.doesNotMatch(requiredAt(chipTextMatch, 1), /max-h-\[calc\(4lh\)\]/)
  assert.match(html, /\bchip-title-variant-list\b/)
  assert.match(html, /\bchip-title-variant-list\b[^"]*\bw-full\b/)
  assert.match(html, /\bchip-title-variant-list\b[^"]*\bflex-col\b/)
  assert.match(html, /\bchip-title-variant-list\b[^"]*\bitems-stretch\b/)
  assert.match(requiredAt(titleVariantContentMatch, 1), /\bgap-0\.5\b/)
  assert.doesNotMatch(requiredAt(titleVariantContentMatch, 1), /\bcursor-default\b/)
  assert.match(requiredAt(chipMatch, 1), /\bcursor-default\b/)
  assert.doesNotMatch(html, /data-tabout-part="default-variant-trigger"/)
  assert.doesNotMatch(requiredAt(titleVariantListMatch, 1), /\bgap-0\.5\b/)
  assert.match(requiredAt(titleVariantListMatch, 1), /\bdivide-y\b/)
  assert.match(requiredAt(titleVariantListMatch, 1), /\bdivide-neutral-500\/15\b/)
  assert.match(requiredAt(titleVariantListMatch, 1), /(?:^|\s)pr-1\.25(?:\s|$)/)
  assert.match(requiredAt(titleVariantListMatch, 1), /(?:^|\s)pb-1(?:\s|$)/)
  assert.doesNotMatch(html, /\bchip-title-variant-list\b[^"]*\bflex-wrap\b/)
  assert.match(requiredAt(titleVariantShellMatch, 1), /\bw-full\b/)
  assert.doesNotMatch(requiredAt(titleVariantShellMatch, 1), /pl-\[22px\]/)
  assert.doesNotMatch(requiredAt(titleVariantShellMatch, 1), /pr-\[22px\]/)
  assert.doesNotMatch(requiredAt(titleVariantShellMatch, 1), /pl-\[42px\]/)
  assert.doesNotMatch(requiredAt(titleVariantShellMatch, 1), /pr-\[42px\]/)
  assert.match(requiredAt(titleVariantButtonMatch, 1), /\bw-full\b/)
  assert.match(requiredAt(titleVariantActionsMatch, 1), /\btop-0\b/)
  assert.match(requiredAt(titleVariantActionsMatch, 1), /\bbottom-0\b/)
  assert.match(requiredAt(titleVariantActionsMatch, 1), /left-\[-25\.5px\]/)
  assert.doesNotMatch(requiredAt(titleVariantActionsMatch, 1), /-left-\[26px\]/)
  assert.doesNotMatch(requiredAt(titleVariantActionsMatch, 1), /\bleft-0\b/)
  assert.doesNotMatch(requiredAt(titleVariantActionsMatch, 1), /\bright-0\b/)
  assert.match(requiredAt(titleVariantActionsMatch, 1), /group\/title-variant-actions/)
  assert.match(requiredAt(titleVariantActionsMatch, 1), /\bmy-auto\b/)
  assert.match(requiredAt(titleVariantActionOwnerMatch, 1), /group\/title-variant-close-owner/)
  assert.match(requiredAt(titleVariantActionOwnerMatch, 1), /size-4\.75/)
  assert.match(requiredAt(titleVariantActionOwnerMatch, 1), /\bcursor-pointer\b/)
  assert.match(requiredAt(titleVariantActionMatch, 1), /size-4\.75/)
  assert.match(requiredAt(titleVariantActionMatch, 1), /pointer-events-none/)
  assert.match(requiredAt(titleVariantActionMatch, 1), /group-hover\/title-variant-close-owner:pointer-events-auto/)
  assert.match(requiredAt(titleVariantActionMatch, 1), /group-hover\/title-variant-close-owner:opacity-100/)
  assert.doesNotMatch(requiredAt(titleVariantActionMatch, 1), /group-hover\/title-variant-actions:/)
  assert.doesNotMatch(requiredAt(titleVariantActionMatch, 1), /group-hover\/title-variant:opacity-100/)
  assert.doesNotMatch(requiredAt(titleVariantActionMatch, 1), /\bh-5\b/)
  assert.doesNotMatch(requiredAt(titleVariantActionMatch, 1), /\bw-5\b/)
  assert.doesNotMatch(requiredAt(titleVariantActionMatch, 1), /-translate-y-1\/2/)
  assert.match(requiredAt(titleVariantButtonMatch, 1), /\bcursor-default\b/)
  assert.doesNotMatch(requiredAt(titleVariantButtonMatch, 1), /\bbg-neutral-500\/4\.5/)
  assert.match(requiredAt(titleVariantButtonMatch, 1), /\bbg-transparent\b/)
  assert.match(requiredAt(titleVariantButtonMatch, 1), /\brounded-none\b/)
  assert.doesNotMatch(requiredAt(titleVariantButtonMatch, 1), /bg-\[rgba\(115,115,115,0\.07\)\]/)
  assert.doesNotMatch(requiredAt(titleVariantButtonMatch, 1), /group-hover\/page-chip:bg-/)
  assert.doesNotMatch(requiredAt(titleVariantButtonMatch, 1), /group-hover\/page-chip:bg-\[rgba\(115,115,115,0\.05\)\]/)
  assert.doesNotMatch(requiredAt(titleVariantButtonMatch, 1), /group-hover\/page-chip:bg-\[rgba\(115,115,115,0\.1\)\]/)
  assert.match(requiredAt(titleVariantButtonMatch, 1), /hover:bg-\(--chip-target-interaction-bg\)/)
  assert.doesNotMatch(requiredAt(titleVariantButtonMatch, 1), /\bcursor-pointer\b/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /function defaultTitleVariantChip\(\) \{[\s\S]*activeChipFrame[\s\S]*!variant\.activeInOtherWindow[\s\S]*activeInOtherWindow[\s\S]*every\(isClosedSavedDashboardTab\)[\s\S]*sourceType === 'saved-page'[\s\S]*titleVariantChips\[0\]/)
  assert.match(pageChipSource, /function onVariantGroupChipClick\(e: MouseEvent<HTMLDivElement>\)[\s\S]*?titleVariantEventTargetsExactVariant\(e\.target\)[\s\S]*?activateChipTarget\(e, variant\.tabUrl, variant\.sourceType, variant, e\.currentTarget\)/)
  assert.match(pageChipSource, /function onVariantGroupChipMouseEnter\(e: MouseEvent<HTMLDivElement>\)[\s\S]*?previewDefaultTitleVariantSurface\(e\.target\)[\s\S]*?openChipExpansion\(\)/)
  assert.match(pageChipSource, /function onVariantGroupChipMouseLeave\(e: MouseEvent<HTMLDivElement>\)[\s\S]*?contextMenuOpenRef\.current[\s\S]*?setDefaultVariantSurfaceHover\(false\)[\s\S]*?setPreview\(''\)/)
  assert.match(pageChipSource, /function onTitleVariantMouseLeave\(e: MouseEvent<HTMLElement>\)[\s\S]*?closest\('\.page-chip'\)[\s\S]*?!titleVariantEventTargetsDefaultSurfaceBlocker\(e\.relatedTarget\)[\s\S]*?previewDefaultTitleVariantSurface\(e\.relatedTarget\)/)
  assert.match(pageChipSource, /function previewDefaultTitleVariant\(\) \{[\s\S]*?setPreview\(variant\.tabUrl, previewUrlsForChip\(variant\), variant\)[\s\S]*?\}/)
  assert.match(pageChipSource, /const variantGroupInteractionProps = isTitleVariantGroup[\s\S]*?onClick: onVariantGroupChipClick[\s\S]*?onMouseDown: onVariantGroupChipMouseDown[\s\S]*?onMouseEnter: onVariantGroupChipMouseEnter[\s\S]*?onMouseMove: onVariantGroupChipMouseMove[\s\S]*?onMouseLeave: onVariantGroupChipMouseLeave/)
  assert.match(pageChipSource, /className="chip-title-variant-content flex w-full min-w-0 flex-col items-start gap-0\.5">/)
  assert.doesNotMatch(pageChipSource, /onTitleVariantGroupMouseEnter|onTitleVariantGroupMouseLeave/)
  assert.doesNotMatch(pageChipSource, /onTitleVariantSurfaceClick|onTitleVariantSurfaceMouseDown|onTitleVariantSurfaceMouseEnter|onTitleVariantSurfaceMouseLeave/)
  assert.doesNotMatch(pageChipSource, /titleVariantGroupContainsRelatedTarget/)
  assert.doesNotMatch(pageChipSource, /defaultTitleVariantHoverUrl/)
  assert.doesNotMatch(pageChipSource, /chipMatchesDefaultTitleVariantHover/)
  assert.match(pageChipSource, /variantHoverMatched = hoverMatchKey\[index \+ 1\] === '1'/)
  assert.match(pageChipSource, /variantHoverMatched && 'bg-\(--chip-target-interaction-bg\) text-tab-live'/)
  assert.match(pageChipSource, /variantCurrent && 'bg-neutral-100 text-tab-live shadow-\[inset_2px_0_0_0_var\(--accent-amber\)\]'/)
  assert.match(pageChipSource, /variantActive && 'bg-neutral-600\/7\.5 text-tab-live'/)
  assert.doesNotMatch(pageChipSource, /variantCurrent && 'bg-neutral-100 shadow-\[inset_0_0_0_1px_rgba\(82,82,82,0\.42\)\]'/)
  assert.doesNotMatch(pageChipSource, /variantActive && 'bg-neutral-600\/7\.5 text-tab-live shadow-\[inset_0_0_0_1px_rgba\(115,115,115,0\.2\)\]'/)
  assert.doesNotMatch(pageChipSource, /function titleVariantSurfaceEventTargetsVariant/)
  assert.doesNotMatch(pageChipSource, /onTitleVariantSurfaceMouseMove/)
  assert.doesNotMatch(html, /\bpage-chip-tooltip(?:\s|")/)
  assert.match(html, /…\?search_id=alpha/)
  assert.match(html, /…\?search_id=bravo/)
  assert.equal((html.match(/\bchip-title-row\b/g) || []).length, 1)
})

function makeVariantGroupChip(overrides: Partial<DashboardChipData> = {}): DashboardChipData {
  return makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item',
    rawUrl: 'https://example.com/content/item',
    displaySegments: ['Commits'],
    tooltip: 'Commits',
    titleVariantChips: [
      makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/a', rawUrl: 'https://example.com/a', pathSuffix: '…/feature', tooltip: '…/feature' }),
      makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/b', rawUrl: 'https://example.com/b', pathSuffix: '…/main', tooltip: '…/main' })
    ],
    ...overrides
  })
}

function pageChipClass(html: string): string {
  const match = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  assert.ok(match, 'page chip should render')
  return requiredAt(match, 1)
}

// An inactive group chip draws its seam border as a hover/menu/tooltip
// OUTLINE (not an .active-chip-frame). The seam overlap itself is
// unconditional (see the base.css test below), so the chip only carries the
// outline utilities — no marker class.
test('PageChip gives an inactive variant-group chip the interaction outline', () => {
  const cls = pageChipClass(renderWithDomainCardContext(React.createElement(PageChip, { chip: makeVariantGroupChip() })))
  assert.match(cls, /hover:outline-1/)
})

test('PageChip drops the group outline once the variant-group chip is active', () => {
  const cls = pageChipClass(renderWithDomainCardContext(React.createElement(PageChip, { chip: makeVariantGroupChip({ activeChipFrame: true }) })))
  // Active chips use .active-chip-frame for the seam border instead.
  assert.doesNotMatch(cls, /hover:outline-1/)
})

test('PageChip gives a plain open chip the interaction outline at the quiet open color', () => {
  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip: makeChip({ sourceType: 'tab' }) }))
  const cls = pageChipClass(html)
  assert.match(cls, /hover:outline-1/)
  assert.match(cls, /hover:outline-\(--chip-hover-border\)/)
  assert.match(cls, /data-\[tabout-filter-result-selected=true\]:bg-\(--chip-interaction-bg\)/)
  assert.match(cls, /data-\[tabout-filter-result-selected=true\]:outline-\(--accent-amber\)/)
  // The interaction-fill rim: same 10% mix as the interaction fill, laid once
  // more at the edge — the darkened fill carries the open-hover emphasis.
  assert.match(html, /--chip-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 10%, transparent\)/)
})

test('PageChip gives read-only filter results the closed interaction fill without changing their outline', () => {
  for (const sourceType of ['bookmark', 'history'] as const) {
    const html = renderWithDomainCardContext(
      React.createElement(PageChip, {
        chip: makeChip({ sourceType }),
        filter: 'OpenAI'
      })
    )
    const cls = pageChipClass(html)
    assert.match(cls, /hover:bg-\(--chip-interaction-bg\)/)
    assert.match(cls, /data-\[tabout-filter-result-selected=true\]:bg-\(--chip-interaction-bg\)/)
    assert.match(cls, /data-\[tabout-filter-result-selected=true\]:outline-\(--accent-amber\)/)
    assert.match(html, /--chip-interaction-bg:color-mix\(in srgb, var\(--card-bg\) 96\.5%, var\(--color-neutral-600\) 3\.5%\)/)
    assert.match(html, /--chip-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 10%, transparent\)/)
  }
})

test('PageChip resolves the closed filter fill per target inside an active mixed folded chip', () => {
  const html = renderWithDomainCardContext(
    React.createElement(PageChip, {
      chip: makeChip({
        sourceType: 'tab',
        activeChipFrame: true,
        envs: [
          {
            prefix: 'env-alpha',
            tabUrl: 'https://env-alpha.example.test/docs',
            rawUrl: 'https://env-alpha.example.test/docs',
            sourceType: 'tab'
          },
          {
            prefix: 'env-bravo',
            tabUrl: 'https://env-bravo.example.test/docs',
            rawUrl: 'https://env-bravo.example.test/docs',
            sourceType: 'tab',
            closedSaved: true
          }
        ]
      }),
      filter: 'docs'
    })
  )
  const envButtons = Array.from(html.matchAll(/<button[^>]*>/g), (match) => match[0])
    .filter((tag) => /class="[^"]*\bchip-env\b/.test(tag))

  assert.equal(envButtons.length, 2)
  assert.doesNotMatch(requiredAt(envButtons, 0), /style="[^"]*--chip-target-interaction-bg/)
  assert.match(requiredAt(envButtons, 1), /--chip-target-interaction-bg:color-mix\(in srgb, var\(--card-bg\) 96\.5%, var\(--color-neutral-600\) 3\.5%\)/)
  assert.doesNotMatch(requiredAt(envButtons, 1), /--chip-target-interaction-bg:var\(--color-neutral-50\)/)
})

function titleVariantPillTags(html: string): string[] {
  return Array.from(html.matchAll(/<button[^>]*>/g), (match) => match[0])
    .filter((tag) => /class="chip-title-variant clickable\b/.test(tag))
}

// The default-variant hover highlight must be pure CSS keyed off a static
// data marker. The exact pill's own :hover turns off synchronously with the
// pointer, so a React-state highlight commits one painted frame later and
// flashes the rest background on every pill→title crossing. A base.css rule
// turns the group-surface highlight on in the same style recalculation instead.
test('PageChip highlights the default variant pill via static CSS marker, not React hover state', () => {
  const restHtml = renderWithDomainCardContext(React.createElement(PageChip, { chip: makeVariantGroupChip() }))
  const restPills = titleVariantPillTags(restHtml)
  assert.equal(restPills.length, 2)
  assert.match(requiredAt(restPills, 0), /data-tabout-default-variant="true"/)
  assert.doesNotMatch(requiredAt(restPills, 1), /data-tabout-default-variant/)

  const currentActiveHtml = renderWithDomainCardContext(React.createElement(PageChip, {
    chip: makeVariantGroupChip({
      titleVariantChips: [
        makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/a', rawUrl: 'https://example.com/a', pathSuffix: '…/feature', tooltip: '…/feature' }),
        makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/b', rawUrl: 'https://example.com/b', pathSuffix: '…/main', tooltip: '…/main', activeChipFrame: true })
      ]
    })
  }))
  const currentActivePills = titleVariantPillTags(currentActiveHtml)
  assert.doesNotMatch(requiredAt(currentActivePills, 0), /data-tabout-default-variant/)
  assert.match(requiredAt(currentActivePills, 1), /data-tabout-default-variant="true"/)

  const crossWindowHtml = renderWithDomainCardContext(React.createElement(PageChip, {
    chip: makeVariantGroupChip({
      titleVariantChips: [
        makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/a', rawUrl: 'https://example.com/a', pathSuffix: '…/feature', tooltip: '…/feature', activeChipFrame: true, activeInOtherWindow: true }),
        makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/b', rawUrl: 'https://example.com/b', pathSuffix: '…/main', tooltip: '…/main', activeChipFrame: true })
      ]
    })
  }))
  const crossWindowPills = titleVariantPillTags(crossWindowHtml)
  assert.doesNotMatch(requiredAt(crossWindowPills, 0), /data-tabout-default-variant/)
  assert.match(requiredAt(crossWindowPills, 1), /data-tabout-default-variant="true"/)

  const otherWindowOnlyHtml = renderWithDomainCardContext(React.createElement(PageChip, {
    chip: makeVariantGroupChip({
      titleVariantChips: [
        makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/a', rawUrl: 'https://example.com/a', pathSuffix: '…/feature', tooltip: '…/feature' }),
        makeChip({ sourceType: 'tab', tabUrl: 'https://example.com/b', rawUrl: 'https://example.com/b', pathSuffix: '…/main', tooltip: '…/main', activeChipFrame: true, activeInOtherWindow: true })
      ]
    })
  }))
  const otherWindowOnlyPills = titleVariantPillTags(otherWindowOnlyHtml)
  assert.doesNotMatch(requiredAt(otherWindowOnlyPills, 0), /data-tabout-default-variant/)
  assert.match(requiredAt(otherWindowOnlyPills, 1), /data-tabout-default-variant="true"/)

  const savedPriorityHtml = renderWithDomainCardContext(React.createElement(PageChip, {
    chip: makeVariantGroupChip({
      closedSaved: true,
      titleVariantChips: [
        makeChip({
          sourceType: 'retained-page',
          closedSaved: true,
          tabUrl: 'https://example.com/retained',
          rawUrl: 'https://example.com/retained',
          pathSuffix: '…/retained',
          tooltip: '…/retained',
          retainedPageIdentity: 'identity-retained',
          retainedPageClosureToken: 'lifetime-retained'
        }),
        makeChip({
          sourceType: 'saved-page',
          saved: true,
          closedSaved: true,
          tabUrl: 'https://example.com/saved',
          rawUrl: 'https://example.com/saved',
          pathSuffix: '…/saved',
          tooltip: '…/saved',
          savedPageKey: 'saved-page-key'
        })
      ]
    })
  }))
  const savedPriorityPills = titleVariantPillTags(savedPriorityHtml)
  assert.doesNotMatch(requiredAt(savedPriorityPills, 0), /data-tabout-default-variant/)
  assert.match(requiredAt(savedPriorityPills, 1), /data-tabout-default-variant="true"/)

  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  // Keyed off the rectangular `.chip-slot` (scoped to a group via its
  // `.chip-title-variant-list`), NOT `.page-chip` — the chip's rounded squircle
  // corners drop hit-testing through to the slot, so a `.page-chip:hover` rule
  // left the corner gutter dead. The slot is the chip's 1:1 full-bleed parent.
  const highlightRuleStart = baseCss.indexOf('.chip-slot:has(.chip-title-variant-list):hover:not(')
  assert.notEqual(highlightRuleStart, -1, 'base.css should key the default-variant highlight off the rectangular slot, not the rounded chip')
  const highlightRule = baseCss.slice(highlightRuleStart, baseCss.indexOf('}', highlightRuleStart) + 1)
  // The whole chip surface highlights the default pill, except over the
  // interactive islands that own their own click: exact pills, their action
  // rails, a close-capable favicon frame, and the audio toggle.
  assert.match(highlightRule, /\.chip-title-variant:hover,/)
  assert.match(highlightRule, /\.chip-title-variant-actions:hover,/)
  assert.match(highlightRule, /\.chip-favicon-frame:hover \.chip-close-favicon,/)
  assert.match(highlightRule, /\[data-tabout-part='audio-toggle'\]:hover/)
  assert.match(highlightRule, /\)\s*\.chip-title-variant\[data-tabout-default-variant\]/)
  assert.match(highlightRule, /background-color: #52525224;/)
  assert.match(highlightRule, /background-color: var\(\s*--chip-target-interaction-bg,\s*color-mix\(in oklab, var\(--color-neutral-600\) 14%, transparent\)\s*\);/)
  assert.match(highlightRule, /color: var\(--color-tab-live\);/)
  assert.doesNotMatch(baseCss, /\.chip-title-variant-content:hover/)

  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /data-tabout-default-variant=\{variantIsDefaultTarget \? 'true' : undefined\}/)
  assert.doesNotMatch(pageChipSource, /defaultTitleVariantHoverUrl/)
  // The variant-group click/preview handlers own the rectangular `.chip-slot`
  // (which covers the chip's rounded-corner gutter), not the rounded chip, so
  // clicking/hovering the very edge still activates the default variant.
  assert.match(pageChipSource, /data-tabout-part="slot"[\s\S]*?\{\.\.\.variantGroupInteractionProps\}/)
})

// The seam-overlap rule and the slot-marker decision are covered by the
// chip-trim decision-table suite (tests/chip-trim.test.ts); this test only
// pins that PageChip wires the module's slot output onto the slot element.
test('PageChip applies the chip-trim slot marker to full-width slots', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /chip\.iconOnly \? 'inline-flex' : `\$\{trim\.slotClasses\} flex w-full`/)
})

test('PageChip expands same-title URL variant groups in place', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /const titleVariantTitleExpansionTriggerElement = \(/)
  assert.match(pageChipSource, /const titleVariantChipTextContent = \(/)
  assert.match(pageChipSource, /shouldExpandChip \? \(\s*titleVariantTitleExpansionTriggerElement/)
  assert.match(pageChipSource, /chipExpanded && 'page-chip-expanded absolute z-30/)
  assert.match(pageChipSource, /shadow-\[0_3px_10px_rgba\(10,10,10,0\.055\)\]/)
  assert.match(pageChipSource, /transition-none!/)
  assert.match(pageChipSource, /w-\(--page-chip-expanded-width\)/)
  assert.match(pageChipSource, /const closeOnPointerMove = \(event: globalThis\.PointerEvent\) =>/)
  assert.match(pageChipSource, /chipSlotRef\.current\?\.getBoundingClientRect\(\)/)
  assert.match(pageChipSource, /window\.addEventListener\('pointermove', closeOnPointerMove, true\)/)
  // closeOnPointerMove must measure the EXPANDED chip, not the original slot —
  // the expanded chip floats wider/taller than its 1:1 slot, so testing the slot
  // rect collapsed the chip the instant the pointer reached the revealed overflow
  // (the blink-at-the-border bug). It keeps the chip open across the whole
  // expanded surface so the pointer can reach the URL, then closes at its edge.
  assert.match(pageChipSource, /closeOnPointerMove[\s\S]*?chipSlotRef\.current\?\.querySelector<HTMLElement>\('\.page-chip'\)/)
  assert.match(pageChipSource, /closeOnPointerMove[\s\S]*?insideExpandedChip/)
  assert.doesNotMatch(pageChipSource, /PAGE_CHIP_EXPANDED_POINTER_LEAVE_TOLERANCE_PX/)
  assert.match(pageChipSource, /function onChipPointerLeave[\s\S]*?matches\(':focus-visible'\)[\s\S]*?closeChipExpansion\(\)/)
  assert.doesNotMatch(pageChipSource, /backgroundColor: 'var\(--chip-hover-fade-bg\)'/)
  assert.match(pageChipSource, /width: chipExpandedWidth/)
  assert.match(pageChipSource, /Math\.max\(rect\.width, minWidth, contentMetrics\.width \+ horizontalInset\)/)
  assert.doesNotMatch(pageChipSource, /Math\.max\(minWidth, contentMetrics\.width \+ horizontalInset\)/)
  assert.match(pageChipSource, /chip-title-variant-list inline-flex max-w-full flex-col items-stretch pr-\[5px\] pb-1 align-top divide-y divide-neutral-500\/15/)
  assert.match(pageChipSource, /chip-title-variant inline-flex max-w-full min-w-0 items-center gap-1 rounded-none bg-transparent px-1\.5 py-\[3px\]/)
  assert.match(pageChipSource, /data-expanded=\{chipExpanded \? 'true' : undefined\}/)
  assert.match(pageChipSource, /chip-slot relative min-w-0/)
  assert.match(pageChipSource, /getExpandedPageChipLineHtml\(textEl\)/)
  assert.match(pageChipSource, /expansionLineNodesFromHtml/)
  assert.match(pageChipSource, /isTitleVariantGroup \? titleVariantChipTextContent/)
  assert.doesNotMatch(pageChipSource, /function titleVariantChipTooltipContentNode/)
  assert.doesNotMatch(pageChipSource, /function titleVariantTooltipContentNode/)
  assert.doesNotMatch(pageChipSource, /content=\{titleVariantTooltipContentNode\(variant, index\)\}/)
  assert.doesNotMatch(pageChipSource, /getChipTooltipAnchor/)
  assert.doesNotMatch(pageChipSource, /\bchip-title-variant-tooltip-url\b/)
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{titleVariantActionLabel\(variant\)\}>/)
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{variantLabel\}>/)
})

test('PageChip gives same-title URL variant groups a folded-style expansion trigger', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    suppressedTitleParts: ['Example Workspace'],
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const chipTextMatch = html.match(/<span class="([^"]*\bchip-text\b[^"]*)"[^>]*>/)
  const titleVariantContentMatch = html.match(/<span[^>]*class="([^"]*\bchip-title-variant-content\b[^"]*)"/)
  const titleExpansionHitAreaMatch = html.match(/<span[^>]*class="[^"]*\bchip-text-expansion-hit-area\b[^"]*"[^>]*>/)
  const titleVariantButtonMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant\b[^"]*)"[^>]*>/)

  assert.ok(chipTextMatch, 'chip text should render')
  assert.ok(titleVariantContentMatch, 'title variant content should render')
  assert.ok(titleExpansionHitAreaMatch, 'title variant title expansion trigger should render')
  assert.ok(titleVariantButtonMatch, 'title variant button should render')
  assert.doesNotMatch(chipTextMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(requiredAt(titleVariantContentMatch, 1), /\bgap-0\.5\b/)
  assert.doesNotMatch(titleExpansionHitAreaMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(titleExpansionHitAreaMatch[0], /-my-1\.25/)
  assert.match(titleExpansionHitAreaMatch[0], /py-1\.25/)
  assert.doesNotMatch(titleVariantButtonMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(html, /chip-title-variant-content[\s\S]*chip-text-expansion-hit-area[\s\S]*chip-title-row[\s\S]*chip-title-variant-list/)
})

test('PageChip keeps icon-only tooltip popups click-through while text chips expand in place', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /async function onPageChipTooltipClick\(e: MouseEvent<HTMLDivElement>\) \{[\s\S]*await onFocus\(e\)/)
  assert.match(pageChipSource, /onClick=\{onPageChipTooltipClick\}/)
  assert.match(pageChipSource, /chip\.iconOnly && chipTooltipContent \? \(/)
  assert.match(pageChipSource, /isFolded \|\| isTitleVariantGroup \? chipTextElement : chipTextExpansionTriggerElement/)
  assert.doesNotMatch(pageChipSource, /onTitleVariantTooltipClick/)
  assert.doesNotMatch(pageChipSource, /anchor=\{getChipTooltipAnchor\}/)
  assert.match(pageChipSource, /page-chip-tooltip max-w-\[calc\(100vw-16px\)\] text-\[13px\] leading-tight wrap-break-word cursor-default select-none/)
})

test('PageChip routes saved-page mutation actions through Base UI context menus', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  const contextMenuComponentSource = readFileSync(new URL('../src/components/PageChipContextMenu.tsx', import.meta.url), 'utf8')
  const contextMenuContentSource = readFileSync(new URL('../src/components/PageChipContextMenuContent.tsx', import.meta.url), 'utf8')
  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  // PageChip routes chip triggers through the extracted menu wrapper
  assert.doesNotMatch(pageChipSource, /import \{ ContextMenu, ContextMenuTrigger \} from '\.\/ui\/context-menu'/)
  assert.match(pageChipSource, /import \{ PageChipContextMenu \} from '\.\/PageChipContextMenu'/)
  assert.doesNotMatch(pageChipSource, /import \{ PageChipContextMenuContent \} from '\.\/PageChipContextMenuContent'/)

  // The extracted wrapper owns the eager Base UI trigger and visual-open lifecycle.
  assert.match(contextMenuComponentSource, /export function PageChipContextMenu\(/)
  assert.match(contextMenuComponentSource, /onOpenChange\?: \(\(open: boolean\) => void\) \| undefined/)
  assert.match(contextMenuComponentSource, /from '\.\/ui\/context-menu'/)
  assert.doesNotMatch(contextMenuComponentSource, /PageChipContextMenuLoaded|import\(/)
  assert.doesNotMatch(contextMenuComponentSource, /\blazy\b|\bSuspense\b/)
  assert.match(tabHistoryPanelSource, /data-tabout-part="focus-button"[\s\S]*aria-label=\{entryLabel\}/)

  assert.match(contextMenuComponentSource, /PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS = 80/)
  assert.match(contextMenuComponentSource, /function handleOpenChange\(nextOpen: boolean\)/)
  assert.match(contextMenuComponentSource, /const \[visualOpen, setVisualOpen\] = useState\(false\)/)
  assert.match(contextMenuComponentSource, /window\.setTimeout\(\(\) => \{[\s\S]*setVisualOpen\(false\)[\s\S]*PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS/)
  assert.match(contextMenuComponentSource, /const trigger = visualOpen/)
  assert.match(contextMenuComponentSource, /<ContextMenu onOpenChange=\{handleOpenChange\}>/)
  assert.match(contextMenuComponentSource, /<ContextMenuTrigger render=\{trigger\} \/>/)
  assert.match(contextMenuComponentSource, /page-chip-context-menu-open/)

  // The extracted content renders the live-tab, saved, retained, page-pin,
  // suspend, and copy menu items.
  assert.match(contextMenuContentSource, /className="page-chip-reload-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-duplicate-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-save-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-remove-from-tabs-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-pin-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-pin-menu-item"[\s\S]*className="page-chip-save-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-copy-title-menu-item"/)
  assert.match(contextMenuContentSource, /className="page-chip-copy-url-menu-item"/)
  assert.match(contextMenuContentSource, /SavedPageIcon saved=\{!!saved\} className="size-3\.5"/)
  assert.match(contextMenuContentSource, /icon-\[lucide--pin\]/)
  assert.match(contextMenuContentSource, /icon-\[lucide--pin-off\]/)
  assert.match(contextMenuContentSource, /icon-\[lucide--link\]/)
  assert.match(contextMenuContentSource, /icon-\[weui--refresh-filled\] size-3\.5 rotate-45/)
  assert.match(contextMenuContentSource, /icon-\[lucide--copy-plus\]/)
  assert.match(contextMenuContentSource, /<svg className="icon-\[ooui--copy-ltr\] size-3\.5" aria-hidden="true" \/>/)
  assert.match(contextMenuContentSource, /Copy page title text/)
  assert.match(contextMenuContentSource, /Copy URL/)
  assert.match(contextMenuContentSource, /Remove from Tabs/)
  assert.match(contextMenuContentSource, /onClick=\{onSavedSelect\}/)
  assert.match(contextMenuContentSource, /onClick=\{onRemoveFromTabsSelect\}/)
  assert.match(contextMenuContentSource, /onClick=\{onPagePinSelect\}/)
  assert.match(contextMenuContentSource, /onClick=\{onCopyTitle\}/)
  assert.match(contextMenuContentSource, /onClick=\{onCopyUrl\}/)
  assert.match(contextMenuContentSource, /onClick=\{onReloadSelect\}/)
  assert.match(contextMenuContentSource, /onClick=\{onDuplicateSelect\}/)

  // PageChip keeps the ref coordination and clipboard handler; the
  // interaction styling itself lives behind the chip-trim interface and is
  // covered by the decision-table suite (tests/chip-trim.test.ts).
  assert.match(pageChipSource, /page-chip-context-menu-open/)
  assert.match(pageChipSource, /page-chip-tooltip-open/)
  assert.match(pageChipSource, /contextMenuOpenRef\.current/)
  assert.match(pageChipSource, /if \(contextMenuOpenRef\.current\) return/)
  assert.match(pageChipSource, /onOpenChange=\{onChipTooltipOpenChange\}/)
  assert.match(pageChipSource, /group-\[\.page-chip-context-menu-open\]\/page-chip:opacity-100/)
  assert.match(pageChipSource, /group-\[\.page-chip-tooltip-open\]\/page-chip:opacity-100/)
  assert.doesNotMatch(pageChipSource, /import \{ Copy, X \} from 'lucide-react'/)
  assert.match(pageChipSource, /navigator\.clipboard\.writeText\(titleText\)/)
  assert.match(pageChipSource, /navigator\.clipboard\.writeText\(urlText\)/)
  assert.match(pageChipSource, /const pagePinActionLabel = chip\.pagePinned \? 'Unpin' : 'Pin'/)
  assert.match(pageChipSource, /const canTogglePagePin = !!chip\.pagePinId && typeof onTogglePinnedPageChip === 'function'/)
  assert.match(pageChipSource, /import \{ pageChipTargetActionPolicy \} from '\.\/page-chip-action-policy\.js'/)
  assert.match(pageChipSource, /pageChipTargetActionPolicy\(chip, \{ interactive: parentInteractive \}\)/)
  assert.match(pageChipSource, /pageChipTargetActionPolicy\(env\)/)
  assert.match(pageChipSource, /pageChipTargetActionPolicy\(variant\)/)
  assert.match(pageChipSource, /import \{ activateRetainedPageTarget, removeRetainedPageTarget \} from '\.\.\/extension\/retained-page-actions\.js'/)
  assert.match(pageChipSource, /if \(sourceType === 'retained-page'\) \{[\s\S]*await activateRetainedPageTarget\(target \|\| \{\}, mode\)[\s\S]*return[\s\S]*\}[\s\S]*performDashboardItemActivation/)
  assert.match(pageChipSource, /async function onRemoveRetainedPage\([\s\S]*await removeRetainedPageTarget\(target\)/)
  assert.match(pageChipSource, /const canUseCopyContextMenu = parentInteractive && \(\!!chipTitleText \|\| \!!chipUrlText\)/)
  assert.match(pageChipSource, /async function onTogglePagePin\(e: StopPropagationEvent\)/)
  assert.match(pageChipSource, /await onTogglePinnedPageChip\?\.\(chip\.pagePinId\)/)
  assert.match(pageChipSource, /onLayoutChange\?\.\(\{ animate: true \}\)/)
  assert.match(pageChipSource, /const variantPagePinActionLabel = variant\.pagePinned \? 'Unpin' : 'Pin'/)
  assert.match(pageChipSource, /const variantCanTogglePagePin = !!variant\.pagePinId && typeof onTogglePinnedPageChip === 'function'/)
  assert.match(pageChipSource, /async function onTogglePinnedTitleVariant\(e: StopPropagationEvent, variant: DashboardChipData\)/)
  assert.match(pageChipSource, /await onTogglePinnedPageChip\?\.\(variant\.pagePinId\)/)

  // PageChip wires the mutation handlers into the menus at each call site
  assert.match(pageChipSource, /envCanUseContextMenu \? \([\s\S]*<PageChipContextMenu[\s\S]*savedActionLabel=\{canToggleSavedEnv \? envSavedActionLabel : undefined\}[\s\S]*onSavedSelect=\{canToggleSavedEnv \? \(e\) => onToggleSavedEnv\(e, env\) : undefined\}[\s\S]*onReloadSelect=\{envCanUseChromeTabActions \? \(e\) => onReloadPageTarget\(e, env\) : undefined\}[\s\S]*onDuplicateSelect=\{envCanUseChromeTabActions \? \(e\) => onDuplicatePageTarget\(e, env\) : undefined\}[\s\S]*titleText=\{envTitleText\}[\s\S]*urlText=\{env\.tabUrl\}/)
  assert.match(pageChipSource, /onRemoveFromTabsSelect=\{canRemoveRetainedEnv \? \(e\) => onRemoveRetainedPage\(e, env\) : undefined\}/)
  assert.match(pageChipSource, /variantCanUseContextMenu \? \([\s\S]*<PageChipContextMenu[\s\S]*savedActionLabel=\{variantCanToggleSaved \? variantSavedActionLabel : undefined\}[\s\S]*onSavedSelect=\{variantCanToggleSaved \? \(e\) => onToggleSavedTitleVariant\(e, variant\) : undefined\}[\s\S]*onReloadSelect=\{variantCanUseChromeTabActions \? \(e\) => onReloadPageTarget\(e, variant\) : undefined\}[\s\S]*onDuplicateSelect=\{variantCanUseChromeTabActions \? \(e\) => onDuplicatePageTarget\(e, variant\) : undefined\}[\s\S]*pagePinActionLabel=\{variantCanTogglePagePin \? variantPagePinActionLabel : undefined\}[\s\S]*onPagePinSelect=\{variantCanTogglePagePin \? \(e\) => onTogglePinnedTitleVariant\(e, variant\) : undefined\}[\s\S]*titleText=\{variantTitleText\}[\s\S]*urlText=\{variant\.tabUrl\}/)
  assert.match(pageChipSource, /onRemoveFromTabsSelect=\{variantCanRemoveRetained \? \(e\) => onRemoveRetainedPage\(e, variant\) : undefined\}/)
  assert.match(pageChipSource, /canToggleSavedPage \|\| canRemoveRetained \|\| canTogglePagePin \|\| canUseChromeTabActions \|\| canShowSuspend \|\| canUseCopyContextMenu[\s\S]*<PageChipContextMenu[\s\S]*savedActionLabel=\{canToggleSavedPage \? savedActionLabel : undefined\}[\s\S]*onSavedSelect=\{canToggleSavedPage \? onToggleSavedPage : undefined\}[\s\S]*onRemoveFromTabsSelect=\{canRemoveRetained \? \(e\) => onRemoveRetainedPage\(e, chip\) : undefined\}[\s\S]*pagePinActionLabel=\{canTogglePagePin \? pagePinActionLabel : undefined\}[\s\S]*onPagePinSelect=\{canTogglePagePin \? onTogglePagePin : undefined\}[\s\S]*onReloadSelect=\{canUseChromeTabActions \? \(e\) => onReloadPageTarget\(e, chip\) : undefined\}[\s\S]*onDuplicateSelect=\{canUseChromeTabActions \? \(e\) => onDuplicatePageTarget\(e, chip\) : undefined\}[\s\S]*titleText=\{chipTitleText\}[\s\S]*urlText=\{chipUrlText\}[\s\S]*onOpenChange=\{onChipContextMenuOpenChange\}/)
  assert.match(tabHistoryPanelSource, /onReloadSelect=\{canShowSuspend \? onReloadEntry : undefined\}/)
  assert.match(tabHistoryPanelSource, /onDuplicateSelect=\{canShowSuspend \? onDuplicateEntry : undefined\}/)
})

test('PageChip outlines same-title variant groups when external hover matches a variant URL', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    {
      activeHoverUrl: 'https://example.com/content/item?search_id=bravo',
      activeHoverSource: 'history'
    } as RenderContextOverrides
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  assert.ok(chipMatch, 'page chip should render')
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-hover-match\b/)
})

test('PageChip keeps same-title URL variant saved-page actions in the context menu', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha',
        saved: true,
        savedPageKey: 'https://example.com/content/item?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const closeVariantActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant-action\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(closeVariantActionMatch, 'close title variant action should render')
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bpage-chip-saved\b/)
  assert.equal((html.match(/\bchip-title-variant-save\b/g) || []).length, 0)
  assertInstantActionClass(requiredAt(closeVariantActionMatch, 1))
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Save page"/)
  assert.equal((html.match(/\bchip-title-variant-action\b/g) || []).length, 2)
})

test('PageChip renders saved bookmark URL variants as read-only hints', () => {
  const chip = makeChip({
    sourceType: 'bookmark',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'bookmark',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha',
        saved: true,
        savedPageKey: 'https://example.com/content/item?search_id=alpha'
      }),
      makeChip({
        sourceType: 'bookmark',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const savedVariantHintMatch = html.match(/<span[^>]*class="([^"]*\bchip-title-variant-saved-hint\b[^"]*)"/)

  assert.ok(savedVariantHintMatch, 'read-only saved title variant hint should render')
  assertInstantActionClass(requiredAt(savedVariantHintMatch, 1))
  assert.equal((html.match(/\bchip-title-variant-saved-hint\b/g) || []).length, 1)
  assert.doesNotMatch(html, /\bchip-title-variant-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /\bchip-title-variant-action\b/)
})

test('PageChip keeps folded env saved-page actions in the context menu', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://env-alpha.example.test/docs',
    rawUrl: 'https://env-alpha.example.test/docs',
    displaySegments: ['Example Docs'],
    tooltip: 'env-alpha · env-bravo · Example Docs',
    envs: [
      {
        prefix: 'env-alpha',
        tabUrl: 'https://env-alpha.example.test/docs',
        rawUrl: 'https://env-alpha.example.test/docs',
        sourceType: 'tab',
        saved: true,
        savedPageKey: 'https://env-alpha.example.test/docs',
        title: 'Example Docs',
        faviconUrl: ''
      },
      {
        prefix: 'env-bravo',
        tabUrl: 'https://env-bravo.example.test/docs',
        rawUrl: 'https://env-bravo.example.test/docs',
        sourceType: 'tab',
        title: 'Example Docs',
        faviconUrl: ''
      }
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))

  assert.equal((html.match(/\bchip-env-save\b/g) || []).length, 0)
  assert.match(html, /\bchip-env-shell\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Save page"/)
  assert.doesNotMatch(html, /\bchip-save\b/)
})

test('PageChip progressively mounts oversized folded env groups in 24-target chunks', () => {
  const envs = Array.from({ length: 100 }, (_, index) => {
    const label = String(index + 1).padStart(3, '0')
    const url = `https://env-${label}.example.test/docs`
    return {
      prefix: `env-${label}`,
      tabUrl: url,
      rawUrl: url,
      sourceType: 'retained-page' as const,
      title: 'Example Docs',
      faviconUrl: '',
      retainedPageIdentity: `identity-${label}`,
      retainedPageClosureToken: `lifetime-${label}`
    }
  })
  const chip = makeChip({
    sourceType: 'retained-page',
    tabUrl: envs[0]?.tabUrl || '',
    rawUrl: envs[0]?.rawUrl || '',
    displaySegments: ['Example Docs'],
    tooltip: '100 environments · Example Docs',
    envs
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))

  assert.equal((html.match(/\bchip-env-shell\b/g) || []).length, 24)
  assert.match(html, />env-024</)
  assert.doesNotMatch(html, />env-025</)
  assert.match(html, /data-tabout-part="progressive-env-sentinel"/)
  assert.match(html, /data-tabout-progressive-remaining="76"/)
})

test('PageChip renders saved bookmark folded env pills as read-only hints', () => {
  const chip = makeChip({
    sourceType: 'bookmark',
    tabUrl: 'https://env-alpha.example.test/docs',
    rawUrl: 'https://env-alpha.example.test/docs',
    displaySegments: ['Example Docs'],
    tooltip: 'env-alpha · env-bravo · Example Docs',
    envs: [
      {
        prefix: 'env-alpha',
        tabUrl: 'https://env-alpha.example.test/docs',
        rawUrl: 'https://env-alpha.example.test/docs',
        sourceType: 'bookmark',
        saved: true,
        savedPageKey: 'https://env-alpha.example.test/docs',
        title: 'Example Docs',
        faviconUrl: ''
      },
      {
        prefix: 'env-bravo',
        tabUrl: 'https://env-bravo.example.test/docs',
        rawUrl: 'https://env-bravo.example.test/docs',
        sourceType: 'bookmark',
        title: 'Example Docs',
        faviconUrl: ''
      }
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const savedEnvHintMatch = html.match(/<span[^>]*class="([^"]*\bchip-env-saved-hint\b[^"]*)"/)

  assert.ok(savedEnvHintMatch, 'read-only saved env hint should render')
  assertInstantActionClass(requiredAt(savedEnvHintMatch, 1))
  assert.equal((html.match(/\bchip-env-saved-hint\b/g) || []).length, 1)
  assert.doesNotMatch(html, /\bchip-env-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /\bchip-save\b/)
})

test('PageChip matches working set hover against raw tab URLs', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const chip = makeChip({
    tabUrl: 'https://example.com/docs',
    rawUrl
  })
  const html = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    {
      activeHoverUrl: 'https://example.com/preview',
      activeHoverUrls: [rawUrl],
      activeHoverSource: 'working-set'
    } as RenderContextOverrides
  )
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-hover-match\b/)
})

test('Overflow expander outlines when external hover matches a hidden chip', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fhidden'
  const hiddenChip = makeChip({
    tabUrl: 'https://example.com/hidden',
    rawUrl
  })
  const visibleChip = makeChip({
    tabUrl: 'https://example.com/visible',
    rawUrl: 'https://example.com/visible'
  })
  const renderOverflow = (context: RenderContextOverrides) => renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [visibleChip],
      hiddenChips: [hiddenChip],
      hiddenCount: 1
    }),
    context
  )
  const overflowClass = (html: string) => {
    const match = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(match, 'overflow expander button should render')
    return requiredAt(match, 1)
  }
  const historyMatch = overflowClass(renderOverflow({
    activeHoverUrl: 'https://example.com/hidden',
    activeHoverSource: 'history'
  }))
  const workingSetRawMatch = overflowClass(renderOverflow({
    activeHoverUrl: 'https://example.com/preview',
    activeHoverUrls: [rawUrl],
    activeHoverSource: 'working-set'
  }))
  const chipSelfMatch = overflowClass(renderOverflow({
    activeHoverUrl: 'https://example.com/hidden',
    activeHoverSource: 'chip'
  }))

  assert.match(historyMatch, /\bpage-chip-overflow-hover-match\b/)
  assert.match(workingSetRawMatch, /\bpage-chip-overflow-hover-match\b/)
  assert.doesNotMatch(chipSelfMatch, /\bpage-chip-overflow-hover-match\b/)
})

test('TabHistoryPanel outlines matching history rows when another source owns the match', () => {
  const snapshot = makeHistorySnapshot()
  const chipHoverHtml = renderTabHistoryPanel(
    { snapshot },
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'chip' }
  )
  const workingSetHoverHtml = renderTabHistoryPanel(
    { snapshot },
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'working-set' }
  )
  const selfHoverHtml = renderTabHistoryPanel(
    { snapshot },
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'history' }
  )
  const chipHoverMatch = chipHoverHtml.match(/<div[^>]*class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)
  const workingSetHoverMatch = workingSetHoverHtml.match(/<div[^>]*class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<div[^>]*class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)

  assert.ok(chipHoverMatch, 'chip-hover history entry should render')
  assert.ok(workingSetHoverMatch, 'working-set-hover history entry should render')
  assert.ok(selfHoverMatch, 'self-hover history entry should render')
  assert.match(requiredAt(chipHoverMatch, 1), /\bhistory-entry-hover-match\b/)
  assert.match(requiredAt(workingSetHoverMatch, 1), /\bhistory-entry-hover-match\b/)
  assert.doesNotMatch(requiredAt(selfHoverMatch, 1), /\bhistory-entry-hover-match\b/)
})

test('TabHistoryPanel matches chip hover against raw tab URLs without changing the preview URL', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const snapshot = makeHistorySnapshot({
    entries: [
      {
        ...makeHistoryEntry(),
        url: 'https://example.com/docs',
        rawUrl,
        displayUrl: 'example.com/docs'
      }
    ]
  })
  const html = renderTabHistoryPanel(
    { snapshot },
    { activeHoverUrl: 'https://example.com/docs', activeHoverUrls: ['https://example.com/docs', rawUrl], activeHoverSource: 'chip' }
  )
  const entryMatch = html.match(/<div[^>]*class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)

  assert.ok(entryMatch, 'history entry should render')
  assert.match(requiredAt(entryMatch, 1), /\bhistory-entry-hover-match\b/)
})

test('TabHistoryPanel reuses shared page-target matching for suspended history rows', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const snapshot = makeHistorySnapshot({
    entries: [
      {
        ...makeHistoryEntry(),
        url: 'https://example.com/docs',
        rawUrl,
        displayUrl: 'example.com/docs'
      }
    ]
  })
  const html = renderTabHistoryPanel(
    { snapshot },
    { activeHoverUrl: rawUrl, activeHoverUrls: [rawUrl], activeHoverSource: 'chip' }
  )
  const entryMatch = html.match(/<div[^>]*class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)

  assert.ok(entryMatch, 'history entry should render')
  assert.match(requiredAt(entryMatch, 1), /\bhistory-entry-hover-match\b/)
})

test('TabHistoryPanel keeps the history entry surface on the default cursor', () => {
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot()
    })
  )
  const entryButtonMatch = html.match(/<div role="button" tabindex="0"[^>]*aria-disabled="false"[^>]*class="([^"]*\bhistory-entry-main\b[^"]*)"/)

  assert.ok(entryButtonMatch, 'history entry focus target should render')
  assert.match(requiredAt(entryButtonMatch, 1), /\bcursor-default\b/)
  assert.doesNotMatch(requiredAt(entryButtonMatch, 1), /\bcursor-pointer\b/)
})

test('TabHistoryPanel renders the close action in the favicon slot', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            favIconUrl: 'https://example.com/favicon.ico'
          }
        ]
      })
    })
  )
  const faviconFrameMatch = html.match(/<span class="([^"]*\bhistory-entry-favicon-frame\b[^"]*)"/)
  const closeActionMatch = html.match(/<button[^>]*class="([^"]*\bhistory-entry-close\b[^"]*)"/)

  assert.ok(faviconFrameMatch, 'history entry favicon frame should render')
  assert.ok(closeActionMatch, 'history entry close action should render')
  assert.match(html, /history-entry-favicon-frame[\s\S]*history-entry-close-favicon/)
  assert.match(requiredAt(faviconFrameMatch, 1), /group\/history-favicon-frame/)
  assert.match(requiredAt(closeActionMatch, 1), /\bhistory-entry-close-favicon\b/)
  assert.match(requiredAt(closeActionMatch, 1), /\babsolute\b/)
  assert.match(requiredAt(closeActionMatch, 1), /\bleft-1\/2\b/)
  assert.match(requiredAt(closeActionMatch, 1), /group-hover\/history-favicon-frame:pointer-events-auto/)
  assert.match(requiredAt(closeActionMatch, 1), /group-hover\/history-favicon-frame:opacity-100/)
  assert.doesNotMatch(requiredAt(closeActionMatch, 1), /group-hover\/history-row:opacity-100/)
  assert.match(html, /history-entry-favicon-content\b[^"]*group-hover\/history-favicon-frame:opacity-0/)

  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(tabHistoryPanelSource, /<TooltipAnchor content="Close this tab">/)
})

test('TabHistoryPanel uses PageChip-style fade truncation and in-place title expansion', () => {
  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  assert.match(tabHistoryPanelSource, /titleEl\.scrollHeight - titleEl\.clientHeight > 1/)
  assert.match(tabHistoryPanelSource, /getHistoryTitleContentWidth/)
  assert.match(tabHistoryPanelSource, /getHistoryTitleExpandedLineHtml/)
  assert.match(tabHistoryPanelSource, /historyTitleExpandedLineMarkup/)
  assert.match(tabHistoryPanelSource, /expansionLineNodesFromHtml/)
  assert.match(tabHistoryPanelSource, /expandedViewportConstrained/)
  assert.match(tabHistoryPanelSource, /visibleLineCount/)
  assert.match(tabHistoryPanelSource, /history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-\[calc\(2lh\)\]/)
  assert.match(tabHistoryPanelSource, /\[\&\.history-entry-title-truncated\]:mask-\(--title-fade-mask\)/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-title line-clamp-2/)
  assert.match(
    tabHistoryPanelSource,
    /captureVisibleLineHtml\(titleEl, metrics\.visibleLineCount, captureGeometry\)/
  )
  assert.match(tabHistoryPanelSource, /clampedTitleLineNodes\(clampedLineHtml, 'history-entry-title'\)/)
  assert.match(tabHistoryPanelSource, /key=\{titleContentKey\}[\s\S]*className="captured-title-content-root contents"/)
  const pageChipClampSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(
    pageChipClampSource,
    /getClampedPageChipLineHtml\(textEl, \{\s*lineHeight: getChipTextLineHeight\(textEl\),\s*textRect\s*\}\)/
  )
  assert.match(pageChipClampSource, /clampedTitleLineNodes\([\s\S]*chipTextClamp\.lineHtml,[\s\S]*'chip-text',[\s\S]*hasTitleSuppressionMarkers \? rebuildClampedChipMarker : undefined/)
  assert.match(tabHistoryPanelSource, /HISTORY_ENTRY_EXPANDED_VIEWPORT_MARGIN_PX = 12/)
  assert.doesNotMatch(tabHistoryPanelSource, /HISTORY_ENTRY_EXPANDED_CLOSE_DELAY_MS/)
  assert.match(tabHistoryPanelSource, /closeDelayMs: 0/)
  assert.match(tabHistoryPanelSource, /HISTORY_ENTRY_EXPANDED_WIDTH_GUARD_PX = 8/)
  assert.match(tabHistoryPanelSource, /getHistoryEntryExpansionGeometry/)
  assert.match(tabHistoryPanelSource, /getHistoryTitleExpandedTextWidth/)
  assert.match(tabHistoryPanelSource, /history-entry-title-expansion-measure/)
  assert.match(tabHistoryPanelSource, /--history-entry-expanded-width/)
  assert.match(tabHistoryPanelSource, /w-\(--history-entry-expanded-title-width\)/)
  assert.match(tabHistoryPanelSource, /const \[titleExpanded, setTitleExpandedState\] = useState\(false\)/)
  assert.match(tabHistoryPanelSource, /titleExpanded && 'history-entry-expanded-open'/)
  assert.match(tabHistoryPanelSource, /titleExpanded && 'history-entry-row-expanded-open'/)
  assert.match(tabHistoryPanelSource, /function openTitleExpansion\(\)/)
  assert.match(tabHistoryPanelSource, /function closeTitleExpansion\(\) \{[\s\S]*titleExpansionController\.close\(\{ delayed: false \}\)/)
  assert.match(tabHistoryPanelSource, /function onHistoryEntryPointerEnter\(\) \{[\s\S]*openTitleExpansion\(\)/)
  assert.match(tabHistoryPanelSource, /function onHistoryEntryPointerMove\(e: PointerEvent<HTMLDivElement>\)/)
  assert.match(tabHistoryPanelSource, /history-entry-title-expansion-hit-area/)
  assert.match(tabHistoryPanelSource, /HISTORY_ENTRY_CLICKABLE_INTERACTION_BG = 'color-mix\(in srgb, var\(--card-bg\) 90%, var\(--color-neutral-600\) 10%\)'/)
  assert.match(tabHistoryPanelSource, /HISTORY_ENTRY_NON_CLICKABLE_INTERACTION_BG = 'color-mix\(in srgb, var\(--card-bg\) 96\.5%, var\(--color-neutral-600\) 3\.5%\)'/)
  assert.match(tabHistoryPanelSource, /HISTORY_ENTRY_INTERACTION_CLASSES = 'group-hover\/history-row:bg-\(--history-entry-interaction-bg\)[\s\S]*\[\&\.history-entry-expanded-open\]:bg-\(--history-entry-interaction-bg\)/)
  assert.match(tabHistoryPanelSource, /HISTORY_ENTRY_ACTIVE_OTHER_INTERACTION_CLASSES = `bg-\(--history-entry-rest-bg\)/)
  assert.match(tabHistoryPanelSource, /history-entry-expanded-line-tail/)
  assert.match(tabHistoryPanelSource, /function getHistoryEntryExpansionGeometry\(entryEl: HTMLElement \| null, titleEl: HTMLElement \| null\)/)
  assert.match(tabHistoryPanelSource, /const expandedEntryElement = titleExpanded \? historyEntrySurface\(true\) : null/)
  assert.match(tabHistoryPanelSource, /history-entry-list pointer-events-none relative flex min-h-0[^"]*scrollbar-none[^"]*max-\[900px\]:w-auto[^"]*max-\[900px\]:mr-\[calc\(var\(--dashboard-edge-bleed\)-var\(--dashboard-scrollbar-inset\)\)\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-list pointer-events-none relative z-/)
  assert.match(tabHistoryPanelSource, /history-entry-list-content pointer-events-auto flex self-start w-65[^"]*pb-10[^"]*max-\[900px\]:pr-0[^"]*max-\[900px\]:pb-3/)
  assert.match(tabHistoryPanelSource, /history-entry-scrollbar pointer-events-none absolute top-0 right-0 bottom-0 z-20 w-\(--dashboard-scrollbar-size\) select-none max-\[900px\]:right-\[calc\(0px-var\(--dashboard-scrollbar-inset\)\)\]/)
  assert.match(tabHistoryPanelSource, /history-entry-scrollbar-track pointer-events-auto absolute top-\(--dashboard-scrollbar-padding\) right-0 bottom-\(--dashboard-scrollbar-padding\) w-\(--dashboard-scrollbar-size\)/)
  assert.match(tabHistoryPanelSource, /onPointerDown=\{onTrackPointerDown\}/)
  assert.match(tabHistoryPanelSource, /history-entry-scrollbar-thumb absolute top-0 right-0 w-\(--dashboard-scrollbar-size\) rounded-\(--dashboard-scrollbar-radius\) border-\(length:--dashboard-scrollbar-padding\) border-transparent bg-\(--dashboard-scrollbar-thumb-bg\) bg-clip-content/)
  // Grow animates border-width over the shared duration; the bar stays wide for the whole drag.
  assert.match(tabHistoryPanelSource, /\[transition:opacity_300ms_ease-out,border-width_var\(--dashboard-scrollbar-grow-duration\)_ease-out\]/)
  assert.match(tabHistoryPanelSource, /dragging && 'border-\(length:--dashboard-scrollbar-padding-hover\)'/)
  assert.doesNotMatch(tabHistoryPanelSource, /group-hover\/history-scrollbar-track:w-\(--dashboard-scrollbar-size\)/)
  assert.doesNotMatch(tabHistoryPanelSource, /transition-\[opacity,width,right\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /cursor-grab/)
  assert.doesNotMatch(tabHistoryPanelSource, /cursor-grabbing/)
  assert.match(tabHistoryPanelSource, /onPointerDown=\{onThumbPointerDown\}/)
  assert.match(tabHistoryPanelSource, /--history-entry-scrollbar-thumb-height/)
  assert.match(tabHistoryPanelSource, /className="history-entry-slot relative min-w-0 flex-auto"[\s\S]*\{historyEntrySurface\(false\)\}[\s\S]*\{expandedEntryElement\}/)
  // The expansion no longer collapses on scroll; it stays open until the pointer
  // leaves the entry's slot (or window blur / tab hidden).
  assert.doesNotMatch(tabHistoryPanelSource, /closeExpandedHistoryEntryBeforeNativeScroll/)
  assert.doesNotMatch(tabHistoryPanelSource, /closeExpandedHistoryEntryOnNativeScroll/)
  assert.doesNotMatch(tabHistoryPanelSource, /onWheelCapture=/)
  assert.doesNotMatch(tabHistoryPanelSource, /onScrollCapture=/)
  assert.doesNotMatch(tabHistoryPanelSource, /window\.addEventListener\('scroll'/)
  assert.doesNotMatch(tabHistoryPanelSource, /function getHistoryEntryLayerRoot/)
  assert.doesNotMatch(tabHistoryPanelSource, /layerElement\?: HTMLElement \| null/)
  assert.doesNotMatch(tabHistoryPanelSource, /const \[historyPanelElement, setHistoryPanelElement\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /createPortal/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-overlay/)
  assert.doesNotMatch(tabHistoryPanelSource, /onHistoryEntryWheel/)
  assert.doesNotMatch(tabHistoryPanelSource, /historyWheelGestureActive/)
  assert.doesNotMatch(tabHistoryPanelSource, /onWheel=\{/)
  assert.doesNotMatch(tabHistoryPanelSource, /scrollTop\s*=/)
  assert.match(tabHistoryPanelSource, /history-entry-expanded pointer-events-none absolute left-0 z-30/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-expanded pointer-events-auto/)
  assert.match(tabHistoryPanelSource, /data-tabout-part="history-scrollbar-input-shield"/)
  assert.match(tabHistoryPanelSource, /history-entry-scrollbar-input-shield pointer-events-auto absolute top-0 bottom-0 z-3/)
  assert.match(tabHistoryPanelSource, /scrollbarShieldLeft/)
  assert.match(tabHistoryPanelSource, /scrollbarShieldWidth/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-expanded fixed z-30/)
  assert.match(tabHistoryPanelSource, /shadow-\[0_3px_10px_rgba\(10,10,10,0\.055\)\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /\[text-wrap:balance\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /w-max/)
  assert.doesNotMatch(tabHistoryPanelSource, /TooltipAnchor/)
  assert.doesNotMatch(tabHistoryPanelSource, /getHistoryTitleTooltipAnchor/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-title-tooltip/)
  assert.match(tabHistoryPanelSource, /after:w-0/)
  assert.doesNotMatch(tabHistoryPanelSource, /after:w-14/)
})

test('TabHistoryPanel applies bionic title emphasis to short words and acronyms', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            title: 'The API and UX of Checkout Flow',
            url: 'https://example.com/checkout',
            displayUrl: 'example.com/checkout'
          }
        ]
      })
    })
  )

  assert.match(
    html,
    /history-entry-title[\s\S]*<span class="chip-title-fixation\b[^"]*">T<\/span>he <span class="chip-title-fixation\b[^"]*">A<\/span>PI <span class="chip-title-fixation\b[^"]*">a<\/span>nd <span class="chip-title-fixation\b[^"]*">U<\/span>X <span class="chip-title-fixation\b[^"]*">o<\/span>f <span class="chip-title-fixation\b[^"]*">Chec<\/span>kout <span class="chip-title-fixation\b[^"]*">Fl<\/span>ow/
  )
})

test('TabHistoryPanel omits the extras section when working-set items overlap the stack', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 101,
        currentIndex: 0,
        entries: [
          baseEntry,
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            active: false,
            cursor: false,
            current: false,
            title: 'Chrome Settings',
            url: 'chrome://settings/',
            displayUrl: 'chrome://settings/'
          }
        ]
      }),
      workingSet: makeWorkingSetSnapshot()
    })
  )

  assert.doesNotMatch(html, /history-working-set-rail/)
  assert.doesNotMatch(html, /data-low-score/)
  assert.doesNotMatch(html, /data-tabout-part="working-set-extra-list"/)
})

test('TabHistoryPanel gives highlighted history indexes stronger contrast', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 101,
        currentIndex: 0,
        entries: [
          baseEntry,
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            active: false,
            cursor: false,
            current: false,
            title: 'Older Entry',
            url: 'https://example.com/older',
            displayUrl: 'example.com/older'
          }
        ]
      })
    })
  )
  const indexMatches = Array.from(html.matchAll(/<span data-tabout-part="history-entry-marker" class="([^"]*)"/g))
  const highlighted = indexMatches.filter((match) => /\bfont-semibold\b/.test(requiredAt(match, 1)))
  const muted = indexMatches.filter((match) => !/\bfont-semibold\b/.test(requiredAt(match, 1)))

  assert.equal(indexMatches.length, 2)
  assert.equal(highlighted.length, 1)
  assert.equal(muted.length, 1)
  assert.match(requiredAt(requiredAt(highlighted, 0), 1), /\btext-tab-live\b/)
  assert.match(requiredAt(requiredAt(muted, 0), 1), /\btext-muted-foreground\b/)
})

test('TabHistoryPanel keeps FLIP keys stable when stack indexes change', () => {
  const baseEntry = makeHistoryEntry()
  function renderAtIndex(index: number) {
    return renderTabHistoryPanel({
      snapshot: makeHistorySnapshot({
        cursorIndex: index,
        currentIndex: index,
        entries: [{ ...baseEntry, index }]
      })
    })
  }
  function layoutKeys(html: string) {
    return Array.from(html.matchAll(/data-tabout-layout-key="([^"]+)"/g), (match) => requiredAt(match, 1))
  }

  assert.deepEqual(layoutKeys(renderAtIndex(0)), ['stack:1:101'])
  assert.deepEqual(layoutKeys(renderAtIndex(4)), ['stack:1:101'])

  const secondEntry = {
    ...baseEntry,
    index: 1,
    tabId: 202,
    active: false,
    cursor: false,
    current: false,
    title: 'Example Settings',
    url: 'https://example.com/settings',
    rawUrl: 'https://example.com/settings',
    displayUrl: 'example.com/settings'
  }
  const twoRows = renderTabHistoryPanel({
    snapshot: makeHistorySnapshot({
      stackSize: 2,
      entries: [baseEntry, secondEntry]
    })
  })
  assert.deepEqual(layoutKeys(twoRows), ['stack:1:101', 'stack:1:202'])
})

test('TabHistoryPanel open-ghost rows do not receive data-working-set-priority attribute', () => {
  const baseEntry = makeHistoryEntry()
  const ghostUrl = 'https://example.com/open-tab-not-in-stack'
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 101,
        currentIndex: 0,
        entries: [baseEntry]
      }),
      workingSet: makeWorkingSetSnapshot({
        items: [
          {
            key: ghostUrl,
            tabId: 999,
            windowId: 1,
            tabUrl: ghostUrl,
            rawUrl: ghostUrl,
            title: 'Open Tab Not In Stack',
            displayUrl: 'example.com/open-tab-not-in-stack',
            faviconUrl: '',
            dupeCount: 1,
            active: false,
            activeInOtherWindow: false,
            score: 90,
            lastActivatedAt: Date.now()
          }
        ]
      })
    })
  )

  assert.equal(/data-working-set-priority="true"/.test(html), false)
})

test('TabHistoryPanel renders browser utility history rows at full strength like any other row', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        stackSize: 4,
        activeTabId: 301,
        currentIndex: 0,
        entries: [
          {
            ...baseEntry,
            title: 'Chrome Settings',
            url: 'chrome://settings/',
            displayUrl: 'chrome://settings/'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 302,
            active: false,
            cursor: false,
            current: false,
            title: 'New Tab',
            url: 'chrome://newtab/',
            displayUrl: 'chrome://newtab/'
          },
          {
            ...baseEntry,
            index: 2,
            tabId: 303,
            active: false,
            cursor: false,
            current: false,
            title: 'Tab Out',
            url: 'chrome-extension://tab-out/index.html?filter=docs',
            displayUrl: 'Tab Out'
          },
          {
            ...baseEntry,
            index: 3,
            tabId: 304,
            active: false,
            cursor: false,
            current: false,
            title: 'Chrome New Tab Frame',
            url: 'chrome-search://local-ntp/local-ntp.html',
            displayUrl: 'chrome-search://local-ntp/local-ntp.html'
          }
        ]
      })
    })
  )
  assert.doesNotMatch(html, /data-low-score/)
  assert.doesNotMatch(html, /history-entry-low-score-content/)
})

test('TabHistoryPanel renders standalone app history rows at full strength like page chips', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            title: 'Standalone App',
            url: 'https://app.example.com/',
            displayUrl: 'app.example.com',
            isApp: true
          }
        ]
      })
    })
  )

  assert.doesNotMatch(html, /data-low-score/)
  assert.doesNotMatch(html, /history-entry-low-score-content/)
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('TabHistoryPanel renders non-overlapping working-set items inline without a separate section', () => {
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot(),
      workingSet: makeWorkingSetSnapshot({
        items: [
          makeWorkingSetItem(),
          {
            key: 'https://example.com/extra',
            tabId: 202,
            windowId: 1,
            tabUrl: 'https://example.com/extra',
            rawUrl: 'https://example.com/extra',
            title: 'Extra Candidate',
            displayUrl: 'example.com/extra',
            faviconUrl: '',
            dupeCount: 1,
            active: false,
            activeInOtherWindow: false,
            score: 80,
            lastActivatedAt: 0
          }
        ]
      })
    })
  )

  assert.doesNotMatch(html, /data-tabout-part="working-set-extra-list"/)
  assert.match(html, /data-working-set-extra="true"/)
  assert.match(html, /Ext<\/span>ra[\s\S]*Candi<\/span>date/)
  assert.match(html, /default-favicon-image/)
  // Open-ghost (Working Set) rows reference a live tab, so they expose the same
  // favicon-hover close affordance as stack rows.
  assert.match(html, /aria-label="Close Extra Candidate"/)
})

test('TabHistoryPanel filters history rows and working-set extras by the active filter', () => {
  const baseEntry = makeHistoryEntry()
  const snapshot = makeHistorySnapshot({
    entries: [
      baseEntry,
      {
        ...baseEntry,
        index: 1,
        tabId: 202,
        active: false,
        cursor: false,
        current: false,
        title: 'GitHub Repo',
        url: 'https://github.com/example/repo',
        displayUrl: 'github.com/example/repo'
      }
    ]
  })
  const workingSet = makeWorkingSetSnapshot({
    items: [
      makeWorkingSetItem(),
      {
        key: 'https://github.com/example/repo',
        tabId: 202,
        windowId: 1,
        tabUrl: 'https://github.com/example/repo',
        rawUrl: 'https://github.com/example/repo',
        title: 'GitHub Repo',
        displayUrl: 'github.com/example/repo',
        faviconUrl: '',
        dupeCount: 1,
        active: false,
        activeInOtherWindow: false,
        score: 90,
        lastActivatedAt: 0
      },
      {
        key: 'https://news.example.com/article',
        tabId: 303,
        windowId: 1,
        tabUrl: 'https://news.example.com/article',
        rawUrl: 'https://news.example.com/article',
        title: 'Daily News',
        displayUrl: 'news.example.com/article',
        faviconUrl: '',
        dupeCount: 1,
        active: false,
        activeInOtherWindow: false,
        score: 70,
        lastActivatedAt: 0
      }
    ]
  })

  const filteredHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      workingSet,
      filter: 'github'
    })
  )
  const filteredRows = historyEntryElements(filteredHtml)
  const filteredExtraRows = Array.from(filteredHtml.matchAll(/data-working-set-extra="true"/g))

  assert.equal(filteredRows.length, 1, 'only the matching history row should render under filter')
  assert.match(filteredHtml, /<mark[^>]*class="[^"]*chip-filter-match[^"]*"[^>]*><span class="chip-title-fixation\b[^"]*">Git<\/span>Hub<\/mark>[\s\S]*Re<\/span>po/)
  assert.doesNotMatch(filteredHtml, /Exa<\/span>mple/)
  assert.doesNotMatch(filteredHtml, /Dai<\/span>ly/)
  assert.equal(filteredExtraRows.length, 0, 'working set extras matching open history entries should not duplicate')

  const newsHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      workingSet,
      filter: 'news'
    })
  )
  const newsRows = historyEntryElements(newsHtml)

  assert.equal(newsRows.length, 1, 'no history entries match so only the extra working set row renders')
  assert.doesNotMatch(newsHtml, /data-tabout-part="working-set-extra-list"/)
  assert.match(newsHtml, /data-working-set-extra="true"/)
  assert.match(newsHtml, /Dai<\/span>ly[\s\S]*<mark[^>]*class="[^"]*chip-filter-match[^"]*"[^>]*><span class="chip-title-fixation\b[^"]*">Ne<\/span>ws<\/mark>/)
  assert.doesNotMatch(newsHtml, /<mark[^>]*chip-filter-match[^>]*>GitHub/)
  assert.doesNotMatch(newsHtml, /Exa<\/span>mple/)
})

test('TabHistoryPanel borrows current PageChip surface styling for the current entry', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 202,
        currentIndex: 1,
        entries: [
          {
            ...baseEntry,
            index: 0,
            tabId: 101,
            active: false,
            activeInOtherWindow: false,
            cursor: false,
            current: false,
            title: 'Default Entry',
            url: 'https://example.com/default',
            displayUrl: 'example.com/default'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            title: 'Current Entry',
            activeInOtherWindow: false,
            url: 'https://example.com/current',
            displayUrl: 'example.com/current'
          }
        ]
      })
    })
  )
  const entries = historyEntryElements(html)
  const currentEntry = entries.find((entry) => entry.tag.includes('data-current="true"'))?.className
  const defaultEntry = entries.find((entry) => !entry.tag.includes('data-current="true"'))?.className

  assert.ok(currentEntry, 'current history entry should render')
  assert.ok(defaultEntry, 'default history entry should render')
  assert.match(defaultEntry, /\bborder-0\b/)
  assert.match(defaultEntry, /\bbg-transparent\b/)
  assert.match(defaultEntry, /rounded-\[10px\]/)
  assert.match(defaultEntry, /group-hover\/history-row:bg-\(--history-entry-interaction-bg\)/)
  assert.match(defaultEntry, /group-hover\/history-row:after:opacity-100/)
  assert.doesNotMatch(defaultEntry, /group-hover\/history-row:border-\(--accent-amber\)/)
  assert.doesNotMatch(defaultEntry, /\bbg-tab-card\b/)
  assert.doesNotMatch(defaultEntry, /bg-\[rgba\(115,115,115,0\.04\)\]/)
  assert.match(currentEntry, /\bborder-0\b/)
  assert.doesNotMatch(currentEntry, /\bborder-transparent\b/)
  assert.match(currentEntry, /\bbg-neutral-100\b/)
  assert.match(currentEntry, /\bring-neutral-400\b/)
  assert.doesNotMatch(currentEntry, /group-hover\/history-row:border-\(--accent-amber\)/)
  assert.doesNotMatch(currentEntry, /\bgroup-hover\/history-row:bg-\(--history-entry-interaction-bg\)\b/)
  assert.doesNotMatch(currentEntry, /group-hover\/history-row:after:opacity-100/)
  assert.match(currentEntry, /shadow-\[0_1px_2px_rgba\(10,10,10,0\.07\)\]/)
  assert.doesNotMatch(currentEntry, /inset_0_0_0_1px_rgba\(82,82,82,0\.48\)/)
  assert.match(currentEntry, /\[--history-entry-fade-bg:var\(--color-neutral-100\)\]/)
  assert.match(html, /active-history-entry-frame\b[^"]*shadow-\[inset_0_0_0_1px_rgba\(82,82,82,0\.48\)\]/)

  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(tabHistoryPanelSource, /<TooltipAnchor content="Close this tab">/)
})

test('TabHistoryPanel borrows other-window PageChip surface styling for active non-current entries', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 202,
        activeWindowId: 2,
        currentIndex: 0,
        entries: [
          {
            ...baseEntry,
            index: 0,
            tabId: 101,
            active: false,
            activeInOtherWindow: false,
            title: 'Current Entry',
            url: 'https://example.com/current',
            displayUrl: 'example.com/current'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            windowId: 2,
            active: false,
            activeInOtherWindow: true,
            cursor: false,
            current: false,
            title: 'Open Elsewhere',
            url: 'https://example.com/elsewhere',
            displayUrl: 'example.com/elsewhere'
          }
        ]
      })
    })
  )
  const entries = historyEntryElements(html)
  const activeOther = entries.find(
    (entry) =>
      entry.tag.includes('data-active="true"') &&
      entry.tag.includes('data-active-in-other-window="true"') &&
      !entry.tag.includes('data-current="true"')
  )
  const activeOtherEntry = activeOther?.className

  assert.ok(activeOtherEntry, 'active non-current history entry should render')
  assert.doesNotMatch(html, />Active<\/span>/)
  assert.match(activeOtherEntry, /\bborder-0\b/)
  assert.doesNotMatch(activeOtherEntry, /\bborder-\[rgba\(115,115,115,0\.2\)\]/)
  assert.doesNotMatch(activeOtherEntry, /\bborder-transparent\b/)
  assert.match(activeOtherEntry, /\bbg-\(--history-entry-rest-bg\)/)
  assert.match(activeOtherEntry, /shadow-\[0_1px_2px_rgba\(10,10,10,0\.04\)\]/)
  assert.match(activeOtherEntry, /group-hover\/history-row:bg-\(--history-entry-interaction-bg\)/)
  assert.match(html, /--history-entry-rest-bg:color-mix\(in srgb, var\(--card-bg\) 92\.5%, var\(--color-neutral-600\) 7\.5%\)/)
  assert.match(html, /--history-entry-interaction-bg:color-mix\(in srgb, var\(--card-bg\) 84%, var\(--color-neutral-600\) 16%\)/)
  assert.ok(activeOther, 'active other-window history entry should have state data')
  assert.doesNotMatch(activeOther.tag, /data-current="true"/)
  assert.doesNotMatch(activeOtherEntry, /\bring-neutral-400\b/)
  assert.equal([...html.matchAll(/active-history-entry-frame/g)].length, 1)
})

test('TabHistoryPanel keeps previous and next history targets visually neutral', () => {
  const baseEntry = makeHistoryEntry()
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        currentIndex: 1,
        previousIndex: 0,
        nextIndex: 2,
        entries: [
          {
            ...baseEntry,
            index: 0,
            tabId: 101,
            active: false,
            cursor: false,
            current: false,
            previousTarget: true,
            title: 'Previous Entry',
            url: 'https://example.com/previous',
            displayUrl: 'example.com/previous'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            title: 'Current Entry',
            url: 'https://example.com/current',
            displayUrl: 'example.com/current'
          },
          {
            ...baseEntry,
            index: 2,
            tabId: 303,
            active: false,
            cursor: false,
            current: false,
            nextTarget: true,
            title: 'Next Entry',
            url: 'https://example.com/next',
            displayUrl: 'example.com/next'
          }
        ]
      })
    })
  )
  const entries = historyEntryElements(html)
  const previousEntry = entries.find((entry) => entry.tag.includes('data-previous-target="true"'))?.className
  const nextEntry = entries.find((entry) => entry.tag.includes('data-next-target="true"'))?.className

  assert.ok(previousEntry, 'previous target history entry should render')
  assert.ok(nextEntry, 'next target history entry should render')
  assert.doesNotMatch(previousEntry, /border-\[rgba\(22,163,74,0\.45\)\]/)
  assert.doesNotMatch(nextEntry, /border-\[rgba\(37,99,235,0\.42\)\]/)
})

test('cross-surface hover match styling is outline-only', () => {
  // Every hover-match surface highlights with the same outline utilities on
  // its own hoverMatched conditional. Outline-only keeps the four surfaces
  // visually identical — no bg or border variants.
  const OUTLINE_UTILITIES = /outline-1 outline-offset-1 outline-\(--accent-amber\)/
  const surfaces: Array<[string, RegExp]> = [
    ['../src/components/TabHistoryPanel.tsx', /hoverMatched && 'history-entry-hover-match ([^']*)'/],
    ['../src/components/PageChipOverflow.tsx', /hiddenHoverMatched && 'page-chip-overflow-hover-match ([^']*)'/],
    ['../src/components/PageChip.tsx', /hoverMatched && `\$\{CHIP_TRIM_TOKENS\.hoverMatch\} ([^`]*)`/]
  ]
  for (const [path, conditional] of surfaces) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const match = source.match(conditional)
    assert.ok(match, `${path} hover-match conditional should exist`)
    assert.match(match[0], OUTLINE_UTILITIES)
    assert.doesNotMatch(requiredAt(match, 1), /bg-|border-|shadow/)
  }
})

test('cross-surface hover does not restore chrome around a domain card', () => {
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const contentWrapper = domainCardSource.match(/'(mission-card[^']*)'/)

  assert.ok(contentWrapper, 'domain card content wrapper should render')
  assert.doesNotMatch(requiredAt(contentWrapper, 1), /\b(?:rounded|border|bg-|shadow)/)
  assert.match(domainCardSource, /isAppsCard \? 'p-1\.75' : 'p-2'/)
  assert.doesNotMatch(domainCardSource, /group-has-\[\.page-chip(?:-overflow)?[^\]]*hover-match\]\/domain-block:border-/)
})

test('PageChip highlights quoted filter phrases as one contiguous match', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: '"OpenAI Docs"'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Ope<\/span>nAI <span class="chip-title-fixation\b[^"]*">Do<\/span>cs<\/mark>/)
})

test('PageChip highlights token aliases in visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Pull Request review'],
        tooltip: 'Pull Request review'
      }),
      filter: 'pr'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Pu<\/span>ll <span class="chip-title-fixation\b[^"]*">Requ<\/span>est<\/mark> <span class="chip-title-fixation\b[^"]*">rev<\/span>iew/)
})

test('PageChip highlights parsed filter terms for history candidates', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'history' }),
      filter: 'docs openai'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Ope<\/span>nAI<\/mark> <mark class="chip-filter-match\b[^"]*"><span class="chip-title-fixation\b[^"]*">Do<\/span>cs<\/mark>/)
})

test('PageChip renders a title suppression marker when common title text is suppressed', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      })
    })
  )

  assert.match(html, /chip-title-suppression-marker\b/)
  assert.match(html, /chip-title-suppression-glyph\b/)
  assert.doesNotMatch(html, />˷<\/span>/)
  assert.match(html, /Suppressed title text: Example Workspace/)
  assert.doesNotMatch(html, /chip-title-suppression-marker[^>]* title=/)
  const chipMatch = html.match(/<div[^>]*class="[^"]*\bpage-chip\b[^"]*"[^>]*>/)
  assert.ok(chipMatch, 'page chip should render')
  assert.doesNotMatch(chipMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextMatch = html.match(/<span class="chip-text(?:\s|")[^>]*>/)
  assert.ok(chipTextMatch, 'chip text should render')
  assert.doesNotMatch(chipTextMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextExpansionHitAreaMatch = html.match(/<span class="[^"]*\bchip-text-expansion-hit-area\b[^"]*"[^>]*>/)
  assert.ok(chipTextExpansionHitAreaMatch, 'chip text expansion hit area should render')
  assert.doesNotMatch(chipTextExpansionHitAreaMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(chipTextExpansionHitAreaMatch[0], /-my-1\.25/)
  assert.match(chipTextExpansionHitAreaMatch[0], /py-1\.25/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)
  assert.ok(markerMatch, 'title suppression marker should render')
  assert.match(requiredAt(markerMatch, 1), /(?:^|\s)h-3\.5(?:\s|$)/)
  assert.match(requiredAt(markerMatch, 1), /(?:^|\s)min-w-3\.5(?:\s|$)/)
  assert.match(requiredAt(markerMatch, 1), /\bshrink-0\b/)
  assert.match(requiredAt(markerMatch, 1), /(?:^|\s)text-\[12px\](?:\s|$)/)
  assert.match(requiredAt(markerMatch, 1), /(?:^|\s)leading-3(?:\s|$)/)
  assert.match(requiredAt(markerMatch, 1), /\balign-middle\b/)
  assert.doesNotMatch(requiredAt(markerMatch, 1), /(?:^|\s)text-\[10px\](?:\s|$)/)
  assert.doesNotMatch(requiredAt(markerMatch, 1), /(?:^|\s)font-medium(?:\s|$)/)
  assert.doesNotMatch(requiredAt(markerMatch, 1), /\bfont-semibold\b/)
  assert.match(html, /chip-title-suppression-label hidden group-\[\.page-chip-expanded\]\/page-chip:inline/)
  const markerElementMatch = html.match(/<span class="[^"]*\bchip-title-suppression-marker\b[^"]*"[^>]*>/)
  assert.ok(markerElementMatch, 'title suppression marker element should render')
  assert.doesNotMatch(markerElementMatch[0], /data-slot="tooltip-trigger"/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /const shouldExpandChip = !chip\.iconOnly && \(hasExpandableContent \|\| hasTitleSuppressionMarkers \|\| hasStructuralPlaceholders\)/)
  assert.match(pageChipSource, /PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = 'chip-title-suppression-marker inline rounded-lg border-0[\s\S]*text-\[12px\][\s\S]*leading-\[inherit\][\s\S]*align-baseline/)
  assert.match(pageChipSource, /PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = [\s\S]*\[box-decoration-break:clone\]/)
  assert.match(pageChipSource, /group-\[\.page-chip-expanded\]\/page-chip:\[box-decoration-break:clone\]/)
  assert.match(pageChipSource, /chip-title-suppression-label hidden group-\[\.page-chip-expanded\]\/page-chip:inline/)
  assert.match(pageChipSource, /highlightedTextNodes\(part, highlightTerms/)
  assert.doesNotMatch(pageChipSource, /title-suppression-marker-tooltip/)
})

test('PageChip expansion preserves trailing suppression marker spacing', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /const markerSpacingClass = mode === 'chip' \? \(index === 0 \? 'ml-1' : 'ml-0\.5'\) : ''/)
  assert.match(pageChipSource, /function carriedExpandedMarkerSpacingClass\(marker: Element\)/)
  assert.match(pageChipSource, /className\.startsWith\('ml-'\) \|\| className\.startsWith\('mr-'\)/)
  assert.match(pageChipSource, /if \(carriedExpandedMarkerSpacingClass\(marker\)\) return/)
  assert.match(pageChipSource, /PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME, carriedExpandedMarkerSpacingClass\(marker\), carriedExpandedMarkerToneClass\(marker\)/)
  assert.match(pageChipSource, /chip-title-suppression-label hidden group-\[\.page-chip-expanded\]\/page-chip:inline/)
  assert.match(pageChipSource, /if \(mode === 'tooltip'\) \{[\s\S]*\{\s*' '\s*\}[\s\S]*\{marker\}/)
})

test('PageChip colors title suppression markers from token tones before hover', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace', 'JIRA']
      }),
      suppressedTitleToneByText: Object.fromEntries<TitleSuppressionTone | ''>([
        ['example workspace', 'amber'],
        ['jira', 'teal']
      ])
    })
  )
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.equal(markerClasses.length, 2)
  assert.match(requiredAt(markerClasses, 0), /title-suppression-token-tone-amber/)
  assert.match(requiredAt(markerClasses, 0), /\bbg-yellow-50\b/)
  assert.doesNotMatch(requiredAt(markerClasses, 0), /bg-\[#fff7ed\]/)
  assert.doesNotMatch(requiredAt(markerClasses, 0), /bg-\[rgba/)
  assert.doesNotMatch(requiredAt(markerClasses, 0), /\bhover:/)
  assert.doesNotMatch(requiredAt(markerClasses, 0), /\bfocus-visible:/)
  assert.match(requiredAt(markerClasses, 1), /title-suppression-token-tone-teal/)
  assert.match(requiredAt(markerClasses, 1), /\bbg-teal-50\b/)
  assert.doesNotMatch(requiredAt(markerClasses, 1), /bg-\[#f0fdfa\]/)
  assert.doesNotMatch(requiredAt(markerClasses, 1), /bg-\[rgba/)
  assert.doesNotMatch(requiredAt(markerClasses, 1), /\bhover:/)
  assert.doesNotMatch(requiredAt(markerClasses, 1), /\bfocus-visible:/)
})

test('PageChip can render a title suppression marker inline before structural placeholders', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel — ', { titleSuppression: 'Example Workspace' }, ' — ', { placeholder: true }],
        suppressedTitleParts: ['Example Workspace']
      })
    })
  )
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.equal(markerClasses.length, 1)
  assert.match(html, /<span class="chip-title-fixation\b[^"]*">Alp<\/span>ha <span class="chip-title-fixation\b[^"]*">chan<\/span>nel — [\s\S]*chip-title-suppression-marker[\s\S]*chip-title-suppression-glyph[\s\S]* — [\s\S]*chip-strip-indicator[\s\S]*>\/<\/span>/)
})

test('PageChip uses a path-style placeholder for stripped structural labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha ', { placeholder: true }, ' Beta']
      })
    })
  )

  const stripMatch = html.match(/<span class="([^"]*\bchip-strip-indicator\b[^"]*)" aria-hidden="true"><span>([^<]+)<\/span><\/span>/)
  assert.ok(stripMatch, 'structural strip indicator should render')
  assert.equal(stripMatch[2], '/')
  assert.match(requiredAt(stripMatch, 1), /\binline-flex\b/)
  assert.match(requiredAt(stripMatch, 1), /\bsize-4\b/)
  assert.match(requiredAt(stripMatch, 1), /\brounded-full\b/)
  assert.doesNotMatch(requiredAt(stripMatch, 1), /(?:^|\s)\[corner-shape:squircle\](?:\s|$)/)
  assert.doesNotMatch(html, /chip-title-suppression-marker\b/)
})

test('PageChip labels stripped path-group placeholders with the pathgroup value', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha ', { placeholder: true, label: 'openai/docs' }, ' Beta']
      })
    })
  )

  assert.match(html, /chip-strip-indicator\b[^>]*aria-label="openai\/docs"[^>]*>[\s\S]*chip-strip-indicator-glyph[\s\S]*>\/<\/span>[\s\S]*chip-strip-indicator-label/)
  const markerElementMatch = html.match(/<span class="[^"]*\bchip-strip-indicator\b[^"]*"[^>]*>/)
  assert.ok(markerElementMatch, 'strip indicator element should render')
  assert.doesNotMatch(markerElementMatch[0], /data-slot="tooltip-trigger"/)
  const chipMatch = html.match(/<div[^>]*class="[^"]*\bpage-chip\b[^"]*"[^>]*>/)
  assert.ok(chipMatch, 'page chip should render')
  assert.doesNotMatch(chipMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextMatch = html.match(/<span class="chip-text(?:\s|")[^>]*>/)
  assert.ok(chipTextMatch, 'chip text should render')
  assert.doesNotMatch(chipTextMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextExpansionHitAreaMatch = html.match(/<span class="[^"]*\bchip-text-expansion-hit-area\b[^"]*"[^>]*>/)
  assert.ok(chipTextExpansionHitAreaMatch, 'chip text expansion hit area should render')
  assert.doesNotMatch(chipTextExpansionHitAreaMatch[0], /data-slot="tooltip-trigger"/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /mode === 'tooltip' && hiddenLabel/)
  assert.match(pageChipSource, /chip-strip-indicator inline-block max-w-full/)
  assert.match(pageChipSource, /chip-strip-indicator-label hidden group-\[\.page-chip-expanded\]\/page-chip:inline/)
  assert.match(pageChipSource, /highlightedTextNodes\(hiddenLabel, highlightTerms/)
  assert.doesNotMatch(pageChipSource, /chip-strip-indicator-tooltip/)
})

test('PageChip marks chips affected by the active suppressed title text', () => {
  const defaultHtml = renderWithDomainCardContext(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      })
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )
  const tealHtml = renderWithDomainCardContext(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      }),
      suppressedTitleToneByText: Object.fromEntries<TitleSuppressionTone | ''>([
        ['example workspace', 'teal']
      ])
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )

  assert.match(defaultHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(defaultHtml, /\bbg-yellow-50\b/)
  assert.match(defaultHtml, /chip-title-suppression-marker\b[^"]*\bbg-yellow-50\b/)
  assert.match(tealHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(tealHtml, /\bbg-teal-50\b/)
  assert.match(tealHtml, /chip-title-suppression-marker\b[^"]*\bbg-teal-50\b/)
  assert.doesNotMatch(tealHtml, /\bbg-yellow-50\b/)
})

test('PageChip renders path-group pills with a slash prefix', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        pathGroupLabel: 'openai/docs'
      })
    })
  )

  assert.match(html, /chip-pathgroup\b[^>]*>\/openai\/docs<\/span>/)
})

test('PageChip renders path suffixes without a left margin utility', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        pathSuffix: '/docs/reference'
      })
    })
  )

  const pathMatch = html.match(/<span class="([^"]*\bchip-path\b[^"]*)">/)
  assert.ok(pathMatch, 'chip path suffix should render')
  assert.doesNotMatch(requiredAt(pathMatch, 1), /\bml-/)
  assert.match(html, /<span class="chip-title-fixation\b[^"]*">Ope<\/span>nAI <span class="chip-title-fixation\b[^"]*">Do<\/span>cs\s+<span class="[^"]*\bchip-path\b[^"]*">\/docs\/reference<\/span>/)
})

test('PageChip renders folded titles before env controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Deployment History'],
        suppressedTitleParts: ['| Example Retail', '- DEV1'],
        envs: [
          { prefix: 'dev1us', tabUrl: 'https://dev1us.example.com/deployments', rawUrl: 'https://dev1us.example.com/deployments' },
          { prefix: 'dev2us', tabUrl: 'https://dev2us.example.com/deployments', rawUrl: 'https://dev2us.example.com/deployments' }
        ]
      })
    })
  )

  assert.match(html, /page-chip-folded\b/)
  assert.match(html, /chip-folded-content\b/)
  assert.match(html, /chip-title-row\b[^>]*>[\s\S]*<span class="chip-title-fixation\b[^"]*">Deplo<\/span>yment <span class="chip-title-fixation\b[^"]*">Hist<\/span>ory[\s\S]*chip-env-row\b[^>]*>[\s\S]*dev1us[\s\S]*dev2us/)
  assert.equal([...html.matchAll(/chip-title-suppression-marker/g)].length, 2)
  const chipMatch = html.match(/<div[^>]*data-tabout="page-chip"[^>]*class="([^"]*)"/)
  const foldedContentMatch = html.match(/<span class="([^"]*\bchip-folded-content\b[^"]*)"/)
  assert.ok(chipMatch, 'folded page chip should render')
  assert.ok(foldedContentMatch, 'folded page chip content should render')
  assert.match(requiredAt(foldedContentMatch, 1), /\bgap-0\.5\b/)
  assert.match(requiredAt(chipMatch, 1), /\bpage-chip-folded\b/)
  assert.match(requiredAt(chipMatch, 1), /\bcursor-default\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bclickable\b/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bcursor-pointer\b/)
  assert.match(requiredAt(chipMatch, 1), /hover:bg-\(--chip-interaction-bg\)/)
  assert.match(requiredAt(chipMatch, 1), /hover:outline-1/)
  assert.match(requiredAt(chipMatch, 1), /hover:-outline-offset-1/)
  assert.match(requiredAt(chipMatch, 1), /hover:outline-\(--chip-hover-border\)/)
  assert.match(requiredAt(chipMatch, 1), /page-chip-tooltip-open\]:bg-\(--chip-interaction-bg\)/)
  assert.match(html, /--chip-interaction-bg:color-mix\(in srgb, var\(--card-bg\) 96\.5%, var\(--color-neutral-600\) 3\.5%\)/)
  assert.match(html, /--chip-hover-border:color-mix\(in srgb, var\(--color-neutral-600\) 22%, transparent\)/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:bg-\[rgba\(82,82,82,0\.05\)\]/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /page-chip-tooltip-open\]:bg-\[rgba\(82,82,82,0\.05\)\]/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:border/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /hover:ring/)
  assert.doesNotMatch(requiredAt(chipMatch, 1), /\bfocus-visible:outline/)
  assert.doesNotMatch(html, /\btabindex="0"/)
  const envRowMatch = html.match(/<span class="([^"]*\bchip-env-row\b[^"]*)">/)
  assert.ok(envRowMatch, 'folded env row should render')
  assert.doesNotMatch(requiredAt(envRowMatch, 1), /\bmr-/)
  const envButtonMatch = html.match(/<button[^>]*class="([^"]*\bchip-env\b[^"]*)"/)
  assert.ok(envButtonMatch, 'folded env button should render')
  assert.match(requiredAt(envButtonMatch, 1), /\bh-6\b/)
  assert.match(requiredAt(envButtonMatch, 1), /\bpx-2\b/)
  assert.match(requiredAt(envButtonMatch, 1), /rounded-\[7px\]/)
  assert.match(requiredAt(envButtonMatch, 1), /\bclickable\b/)
  assert.match(requiredAt(envButtonMatch, 1), /\bcursor-default\b/)
  assert.doesNotMatch(requiredAt(envButtonMatch, 1), /\bcursor-pointer\b/)
  assert.match(requiredAt(envButtonMatch, 1), /\bhover:bg/)
  assert.match(requiredAt(envButtonMatch, 1), /\bfocus-visible:outline/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /const foldedTitleExpansionTriggerElement = \(/)
  assert.match(pageChipSource, /shouldExpandChip \? \(\s*foldedTitleExpansionTriggerElement/)
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{envLabel\}>/)
  assert.doesNotMatch(pageChipSource, /function foldedChipTooltipContentNode\(\)/)
})

test('PathgroupSection renders header path-group pills with a slash prefix', () => {
  const html = renderToStaticMarkup(
    React.createElement(PathgroupSection, {
      domain: 'github.com',
      subdomainKey: '',
      websitePathKey: '',
      pathgroupKey: 'openai/docs',
      isPinned: false,
      label: 'openai/docs',
      isPR: false,
      count: 1,
      closableUrls: [],
      visibleChips: [],
      hiddenChips: [],
      hiddenCount: 0
    })
  )

  assert.match(html, /chip-pathgroup\b[^>]*>\/openai\/docs<\/span>/)
})

test('WebsitePathSection renders raw path labels and keeps suppression summary on the section rail', () => {
  const html = renderToStaticMarkup(
    React.createElement(WebsitePathSection, {
      domain: 'example.atlassian.net',
      subdomainKey: '',
      websitePathKey: '/wiki',
      isPinned: false,
      label: '/wiki',
      sectionCount: 3,
      sectionClosableUrls: [],
      hasFlat: true,
      flatVisibleChips: [
        makeChip({
          rawUrl: 'https://example.atlassian.net/wiki/home',
          tabUrl: 'https://example.atlassian.net/wiki/home',
          displaySegments: ['Wiki home'],
          suppressedTitleParts: ['- Example-Site - Confluence']
        })
      ],
      flatHiddenChips: [],
      flatHiddenCount: 0,
      suppressedTitleParts: [{ text: '- Example-Site - Confluence', count: 3, spansRenderedChildGroups: true }],
      clusters: [
        {
          key: 'wiki:KB',
          label: 'KB',
          isPR: false,
          count: 2,
          closableUrls: [],
          suppressedTitleParts: [],
          visibleChips: [
            makeChip({
              rawUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
              tabUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
              displaySegments: ['Alpha guide'],
              suppressedTitleParts: ['- Example-Site - Confluence']
            })
          ],
          hiddenChips: [],
          hiddenCount: 0,
          isPinned: false
        }
      ]
    })
  )

  assert.match(html, /website-path-section\b/)
  const websitePathLabelMatch = html.match(/<span class="([^"]*\bwebsite-path-section-label\b[^"]*)"[^>]*>\/wiki<\/span>/)
  assert.ok(websitePathLabelMatch, 'website path section label should render')
  assert.doesNotMatch(requiredAt(websitePathLabelMatch, 1), /\bchip-pathgroup\b/)
  assert.doesNotMatch(requiredAt(websitePathLabelMatch, 1), /\bbg-\[/)
  assert.doesNotMatch(requiredAt(websitePathLabelMatch, 1), /\brounded/)
  assert.doesNotMatch(requiredAt(websitePathLabelMatch, 1), /\bpx-/)
  assert.match(requiredAt(websitePathLabelMatch, 1), /\bfont-semibold\b/)
  assert.match(requiredAt(websitePathLabelMatch, 1), /\btracking-wide\b/)
  assert.match(html, /chip-pathgroup\b[^>]*>\/KB<\/span>/)
  assert.doesNotMatch(html, /Confluence space|Jira|Google Docs/)
  const summaryMatch = html.match(/<div[^>]*class="([^"]*\btitle-suppression-summary\b[^"]*)">/)
  assert.ok(summaryMatch, 'website-path suppression summary should render')
  assert.doesNotMatch(requiredAt(summaryMatch, 1), /\b(?:pl|ml|px)-/)
  assert.match(html, /Suppressed in 3 titles: - Example-Site - Confluence/)
})

test('DomainCard renders docs.google.com website path sections through WebsitePathSection', () => {
  const group: DomainGroup = {
    domain: 'google.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-google-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    sections: [
      {
        key: 'docs',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [],
        websitePathSections: [
          {
            key: '/document',
            label: '/document',
            sectionCount: 1,
            sectionClosableUrls: [],
            hasFlat: true,
            flatVisibleChips: [
              makeChip({
                rawUrl: 'https://docs.google.com/document/d/doc-alpha/edit',
                tabUrl: 'https://docs.google.com/document/d/doc-alpha/edit',
                displaySegments: ['Example Spec']
              })
            ],
            flatHiddenChips: [],
            flatHiddenCount: 0,
            suppressedTitleParts: [],
            clusters: []
          },
          {
            key: '/spreadsheets',
            label: '/spreadsheets',
            sectionCount: 1,
            sectionClosableUrls: [],
            hasFlat: true,
            flatVisibleChips: [
              makeChip({
                rawUrl: 'https://docs.google.com/spreadsheets/d/sheet-alpha/edit',
                tabUrl: 'https://docs.google.com/spreadsheets/d/sheet-alpha/edit',
                displaySegments: ['Example Budget']
              })
            ],
            flatHiddenChips: [],
            flatHiddenCount: 0,
            suppressedTitleParts: [],
            clusters: []
          }
        ]
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )

  assert.match(html, /website-path-section-label\b[^>]*>\/document<\/span>[\s\S]*<span class="chip-title-fixation\b[^"]*">Exam<\/span>ple <span class="chip-title-fixation\b[^"]*">Sp<\/span>ec/)
  assert.match(html, /website-path-section-label\b[^>]*>\/spreadsheets<\/span>[\s\S]*<span class="chip-title-fixation\b[^"]*">Exam<\/span>ple <span class="chip-title-fixation\b[^"]*">Bud<\/span>get/)
  assert.equal([...html.matchAll(/website-path-section\b/g)].length > 0, true)
})

test('Overflow expanders use one-line chip text and height metrics', () => {
  const flatHtml = renderToStaticMarkup(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips: [makeChip({ rawUrl: 'https://openai.com/hidden' })],
      hiddenCount: 1
    })
  )
  const pathgroupHtml = renderToStaticMarkup(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips: [makeChip({ rawUrl: 'https://openai.com/path-hidden' })],
      hiddenCount: 1
    })
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.match(requiredAt(overflowButtonMatch, 1), /py-\[5px\]/)
    assert.match(requiredAt(overflowButtonMatch, 1), /text-\[13px\]/)
    assert.match(requiredAt(overflowButtonMatch, 1), /\bleading-tight\b/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bafter:transition-/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bafter:duration-/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bafter:ease-/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bpy-1\.5\b/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\btext-xs\b/)

    const moreTextMatch = html.match(/<span class="([^"]*\bchip-text\b[^"]*)">\+1 more<\/span>/)
    assert.ok(moreTextMatch, 'overflow more-count text should render')
    assert.match(requiredAt(moreTextMatch, 1), /text-\[13px\]/)
  }
})

test('Collapsed overflow defers hidden Page Chip rendering until expansion', () => {
  const html = renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [makeChip({
        rawUrl: 'https://example.test/visible',
        tabUrl: 'https://example.test/visible',
        displaySegments: ['Visible page']
      })],
      hiddenChips: [makeChip({
        rawUrl: 'https://example.test/deferred',
        tabUrl: 'https://example.test/deferred',
        displaySegments: ['Deferred hidden page']
      })],
      hiddenCount: 1
    })
  )

  assert.equal([...html.matchAll(/data-tabout="page-chip"/g)].length, 1)
  assert.match(html, /page:https:\/\/example\.test\/visible/)
  assert.doesNotMatch(html, /example\.test\/deferred/)
  assert.doesNotMatch(html, /Deferred hidden page/)
  assert.match(html, /data-tabout-part="overflow-expander"/)
})

test('Overflow expanders keep the row neutral when only some hidden chips match active suppressed title text', () => {
  const hiddenChips = [
    makeChip({
      rawUrl: 'https://openai.com/hidden-workspace',
      displaySegments: ['Hidden workspace page'],
      suppressedTitleParts: ['Example Workspace']
    }),
    makeChip({
      rawUrl: 'https://openai.com/hidden-other',
      displaySegments: ['Hidden other page'],
      suppressedTitleParts: ['Other Workspace']
    })
  ]
  const suppressedTitleToneByText = Object.fromEntries<TitleSuppressionTone | ''>([
    ['example workspace', 'teal']
  ])
  const flatHtml = renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )
  const pathgroupHtml = renderWithDomainCardContext(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bbg-teal-50\b/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bring-teal-50\b/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*border[^"]*border-teal-50[^"]*bg-teal-50[\s\S]*>˷1<\/span>/)
    assert.doesNotMatch(requiredAt(overflowButtonMatch, 1), /\bbg-yellow-50\b/)
    assert.doesNotMatch(html, /hidden title suppresses/)
    assert.doesNotMatch(html, /Click to show/)
  }
})

test('Overflow expanders use full chip color when all hidden chips match active suppressed title text', () => {
  const hiddenChips = [
    makeChip({
      rawUrl: 'https://openai.com/hidden-workspace',
      displaySegments: ['Hidden workspace page'],
      suppressedTitleParts: ['Example Workspace']
    }),
    makeChip({
      rawUrl: 'https://openai.com/hidden-workspace-2',
      displaySegments: ['Hidden workspace page 2'],
      suppressedTitleParts: ['Example Workspace']
    })
  ]
  const suppressedTitleToneByText = Object.fromEntries<TitleSuppressionTone | ''>([
    ['example workspace', 'teal']
  ])
  const flatHtml = renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )
  const pathgroupHtml = renderWithDomainCardContext(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.match(requiredAt(overflowButtonMatch, 1), /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.match(requiredAt(overflowButtonMatch, 1), /\bbg-teal-50\b/)
    assert.match(requiredAt(overflowButtonMatch, 1), /\bring-1\b/)
    assert.match(requiredAt(overflowButtonMatch, 1), /\bring-inset\b/)
    assert.match(requiredAt(overflowButtonMatch, 1), /\bring-teal-50\b/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*border[^"]*border-teal-50[^"]*bg-teal-50[\s\S]*>˷2<\/span>/)
  }
})

test('DomainCard shows common suppressed title text above the chips without a summary label', () => {
  const group: DomainGroup = {
    domain: 'slack.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-slack-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [{ text: 'Example Workspace', count: 2 }],
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )

  const summaryMatch = html.match(/<div[^>]*class="([^"]*title-suppression-summary[^"]*)">/)
  assert.ok(summaryMatch, 'suppression summary row should render')
  assert.doesNotMatch(requiredAt(summaryMatch, 1), /\bpx-1\b/)
  assert.doesNotMatch(requiredAt(summaryMatch, 1), /\bpy-0\.5\b/)
  const tokenMatch = html.match(/<button[^>]*class="([^"]*title-suppression-token[^"]*)"/)
  assert.ok(tokenMatch, 'suppression token button should render')
  assert.match(requiredAt(tokenMatch, 1), /rounded-md/)
  assert.doesNotMatch(requiredAt(tokenMatch, 1), /\bcursor-(default|pointer)\b/)
  assert.doesNotMatch(requiredAt(tokenMatch, 1), /title-suppression-token-tone-/)
  assert.match(html, /Example Workspace/)
  assert.match(html, /Suppressed in 2 titles: Example Workspace/)
  const summarySource = readFileSync(new URL('../src/components/TitleSuppressionSummary.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(summarySource, /TooltipAnchor/)
  assert.doesNotMatch(summarySource, /title-suppression-tooltip/)
  assert.doesNotMatch(html, /title-suppression-summary-label\b/)
})

test('DomainCard renders the public suffix as less prominent title text', () => {
  const group: DomainGroup = {
    domain: 'example.co.uk',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-example-co-uk',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )

  assert.match(html, /<span class="domain-title-name">example<\/span>/)
  assert.match(html, /<span class="domain-title-suffix[^"]*\bfont-semibold\b[^"]*\btext-muted-foreground\b[^"]*">\.co\.uk<\/span>/)
  assert.doesNotMatch(html, /domain-title-suffix[^"]*\bopacity-/)
  assert.match(html, /<span class="mission-name[^"]*font-black[^"]*"/)
  assert.doesNotMatch(html, /domain-title-subdomain/)
})

test('DomainCard inlines a single non-port subdomain into the title', () => {
  const group: DomainGroup = {
    domain: 'example.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-example-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    singleSubdomainKey: 'docs',
    singleSubdomainIsPort: false,
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )

  assert.match(html, /<span class="domain-title-subdomain[^"]*\bfont-semibold\b[^"]*\btext-muted-foreground\b[^"]*">docs\.<\/span>/)
  assert.doesNotMatch(html, /domain-title-subdomain[^"]*\bopacity-/)
  assert.match(html, /<span class="domain-title-name">example<\/span>/)
  assert.match(html, /<span class="domain-title-suffix[^"]*">\.com<\/span>/)
  assert.doesNotMatch(html, /\bmission-subdomain\b/)
})

test('DomainCard keeps a single localhost port in the subdomain pill', () => {
  const group: DomainGroup = {
    domain: 'localhost',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-localhost',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    singleSubdomainKey: '3001',
    singleSubdomainIsPort: true,
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )

  assert.doesNotMatch(html, /domain-title-subdomain/)
  assert.match(html, /<span class="mission-name[^"]*">localhost<\/span>/)
  assert.match(html, /<span class="[^"]*\bmission-subdomain\b[^"]*before:content-\[[^"]*:[^"]*\][^"]*">3001<\/span>/)
})

test('DomainCard renders utility cards as explicitly pinnable instead of fixed', () => {
  const vm: DashboardCardVM = {
    stableId: 'domain---tab-out--',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    sections: []
  }

  const cards = [
    { domain: '__tab-out__', label: 'New tabs', stableId: 'domain---tab-out--' },
    { domain: '__standalone-apps__', label: 'Apps', stableId: 'domain---standalone-apps--' }
  ]

  for (const card of cards) {
    const html = renderToStaticMarkup(
      React.createElement(DomainCard, {
        group: { domain: card.domain, label: card.label, tabs: [] },
        vm: { ...vm, stableId: card.stableId }
      })
    )

    assert.match(html, /data-tabout-part="card-menu"/)
    assert.match(html, new RegExp(`aria-label="Actions for ${RegExp.escape(card.label)}"`))
    assert.doesNotMatch(html, /data-tabout-part="pin-indicator"/)
    assert.doesNotMatch(html, /\bdomain-fixed-indicator\b/)
    assert.doesNotMatch(html, /\bdomain-block-fixed\b/)
  }
})

test('DomainCard renders section-scoped single suppressed title text as neutral', () => {
  const group: DomainGroup = {
    domain: 'slack.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-slack-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [{ text: 'Example Workspace', count: 2 }],
    sections: [
      {
        key: 'app',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: true,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Alpha channel'],
            suppressedTitleParts: ['Example Workspace']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [{ text: 'Example Workspace', count: 2 }],
        clusters: [],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )

  assert.match(html, /subdomain-header[\s\S]*app[\s\S]*title-suppression-summary[\s\S]*Example Workspace/)
  assert.match(html, /chip-title-suppression-marker\b/)
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)
  assert.ok(tokenMatch, 'section-scoped suppression token should render')
  assert.ok(markerMatch, 'matching suppression marker should render')
  assert.doesNotMatch(requiredAt(tokenMatch, 1), /title-suppression-token-tone-/)
  assert.doesNotMatch(requiredAt(markerMatch, 1), /title-suppression-token-tone-/)
})

test('DomainCard colors section-scoped single suppressed title text when it spans rendered child groups', () => {
  const group: DomainGroup = {
    domain: 'atlassian.net',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-atlassian-net',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '3',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }],
    sections: [
      {
        key: '',
        sectionCount: 3,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Work item search'],
            suppressedTitleParts: ['- JIRA']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }],
        clusters: [
          {
            key: 'jira:CT',
            label: 'CT',
            isPR: false,
            count: 1,
            closableUrls: [],
            suppressedTitleParts: [],
            visibleChips: [
              makeChip({
                rawUrl: 'https://example.atlassian.net/browse/APP-1',
                tabUrl: 'https://example.atlassian.net/browse/APP-1',
                displaySegments: ['[APP-1] Account settings'],
                suppressedTitleParts: ['- JIRA']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.ok(tokenMatch, 'section-scoped suppression token should render')
  assert.match(requiredAt(tokenMatch, 1), /title-suppression-token-tone-amber/)
  assert.equal(markerClasses.length, 2)
  assert.match(requiredAt(markerClasses, 0), /title-suppression-token-tone-amber/)
  assert.match(requiredAt(markerClasses, 1), /title-suppression-token-tone-amber/)
})

test('DomainCard keeps cross-child single suppressed title text neutral when it is the only card meaning', () => {
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-example-test',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '4',
    suppressedTitleParts: [{ text: '| Example Retail', count: 4 }],
    allSuppressedTitleParts: [{ text: '| Example Retail', count: 4 }],
    sections: [
      {
        key: '',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: true,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Deployment History - ENV A'],
            suppressedTitleParts: ['| Example Retail']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [],
        websitePathSections: []
      },
      {
        key: 'env-a',
        sectionCount: 1,
        sectionClosableUrls: [],
        showHeader: true,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            rawUrl: 'https://env-a.example.test/order',
            tabUrl: 'https://env-a.example.test/order',
            displaySegments: ['Order Page'],
            suppressedTitleParts: ['| Example Retail']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.ok(tokenMatch, 'card-scoped suppression token should render')
  assert.doesNotMatch(requiredAt(tokenMatch, 1), /title-suppression-token-tone-/)
  assert.equal(markerClasses.length, 2)
  assert.doesNotMatch(requiredAt(markerClasses, 0), /title-suppression-token-tone-/)
  assert.doesNotMatch(requiredAt(markerClasses, 1), /title-suppression-token-tone-/)
})

test('DomainCard renders pathgroup-scoped single suppressed title text as neutral', () => {
  const group: DomainGroup = {
    domain: 'contentful.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-contentful-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [
      { text: 'JIRA', count: 2 },
      { text: 'Content — Example Website', count: 2 }
    ],
    sections: [
      {
        key: 'app',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'dev2',
            label: 'dev2',
            isPR: false,
            count: 2,
            closableUrls: [],
            suppressedTitleParts: [{ text: 'Content — Example Website', count: 2 }],
            visibleChips: [
              makeChip({
                displaySegments: ['Example Article'],
                suppressedTitleParts: ['Content — Example Website']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)

  assert.ok(tokenMatch, 'pathgroup-scoped suppression token should render')
  assert.ok(markerMatch, 'matching suppression marker should render')
  assert.doesNotMatch(requiredAt(tokenMatch, 1), /title-suppression-token-tone-/)
  assert.doesNotMatch(requiredAt(markerMatch, 1), /title-suppression-token-tone-/)
})

test('DomainCard renders pathgroup-scoped multiple suppressed titles with local tones', () => {
  const group: DomainGroup = {
    domain: 'contentful.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-contentful-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [
      { text: 'Unrelated Card Token', count: 2 },
      { text: 'JIRA', count: 2 },
      { text: 'Content — Example Website', count: 2 }
    ],
    sections: [
      {
        key: 'app',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'dev2',
            label: 'dev2',
            isPR: false,
            count: 2,
            closableUrls: [],
            suppressedTitleParts: [
              { text: 'JIRA', count: 2 },
              { text: 'Content — Example Website', count: 2 }
            ],
            visibleChips: [
              makeChip({
                displaySegments: ['Example Article'],
                suppressedTitleParts: ['JIRA', 'Content — Example Website']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => requiredAt(match, 1))
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.equal(tokenClasses.length, 2)
  assert.match(requiredAt(tokenClasses, 0), /title-suppression-token-tone-amber/)
  assert.match(requiredAt(tokenClasses, 1), /title-suppression-token-tone-teal/)
  assert.equal(markerClasses.length, 2)
  assert.match(requiredAt(markerClasses, 0), /title-suppression-token-tone-amber/)
  assert.match(requiredAt(markerClasses, 1), /title-suppression-token-tone-teal/)
})

test('DomainCard displays suppression tokens in title order while coloring higher coverage tokens first', () => {
  const group: DomainGroup = {
    domain: 'contentful.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-contentful-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '17',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [
      { text: '— Content — Example Website —', count: 6 },
      { text: '— Example Website —', count: 3 },
      { text: '— Contentful', count: 14 }
    ],
    sections: [
      {
        key: 'app',
        sectionCount: 17,
        sectionClosableUrls: [],
        showHeader: true,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'dev2',
            label: 'dev2',
            isPR: false,
            count: 8,
            closableUrls: [],
            suppressedTitleParts: [
              { text: '— Content — Example Website —', count: 6 },
              { text: '— Example Website —', count: 3 },
              { text: '— Contentful', count: 14 }
            ],
            visibleChips: [
              makeChip({
                displaySegments: ['Example Article Beta'],
                suppressedTitleParts: ['— Content — Example Website —', '— Example Website —', '— Contentful']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenMatches = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"[^>]*aria-label="Suppressed in \d+ titles: ([^"]+)"/g)]
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.deepEqual(tokenMatches.map((match) => requiredAt(match, 2)), [
    '— Content — Example Website —',
    '— Example Website —',
    '— Contentful'
  ])
  assert.match(requiredAt(requiredAt(tokenMatches, 0), 1), /title-suppression-token-tone-teal/)
  assert.match(requiredAt(requiredAt(tokenMatches, 1), 1), /title-suppression-token-tone-sky/)
  assert.match(requiredAt(requiredAt(tokenMatches, 2), 1), /title-suppression-token-tone-amber/)
  assert.equal(markerClasses.length, 3)
  assert.match(requiredAt(markerClasses, 0), /title-suppression-token-tone-teal/)
  assert.match(requiredAt(markerClasses, 1), /title-suppression-token-tone-sky/)
  assert.match(requiredAt(markerClasses, 2), /title-suppression-token-tone-amber/)
})

test('DomainCard coordinates child title suppression tones with a colored ancestor scope', () => {
  const group: DomainGroup = {
    domain: 'atlassian.net',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-atlassian-net',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '5',
    suppressedTitleParts: [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }],
    allSuppressedTitleParts: [
      { text: '- JIRA', count: 3, spansRenderedChildGroups: true },
      { text: '- Example-Site', count: 2 },
      { text: '- Confluence', count: 2 }
    ],
    sections: [
      {
        key: '',
        sectionCount: 5,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Work item search'],
            suppressedTitleParts: ['- JIRA']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'wiki:KB',
            label: 'KB',
            isPR: false,
            count: 2,
            closableUrls: [],
            suppressedTitleParts: [
              { text: '- Example-Site', count: 2 },
              { text: '- Confluence', count: 2 }
            ],
            visibleChips: [
              makeChip({
                rawUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
                tabUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
                displaySegments: ['Platform Architecture Notes'],
                suppressedTitleParts: ['- Example-Site', '- Confluence']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => requiredAt(match, 1))
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.equal(tokenClasses.length, 3)
  assert.match(requiredAt(tokenClasses, 0), /title-suppression-token-tone-amber/)
  assert.match(requiredAt(tokenClasses, 1), /title-suppression-token-tone-teal/)
  assert.match(requiredAt(tokenClasses, 2), /title-suppression-token-tone-sky/)
  assert.equal(markerClasses.length, 3)
  assert.match(requiredAt(markerClasses, 0), /title-suppression-token-tone-amber/)
  assert.match(requiredAt(markerClasses, 1), /title-suppression-token-tone-teal/)
  assert.match(requiredAt(markerClasses, 2), /title-suppression-token-tone-sky/)
})

test('DomainCard assigns subtle tones when multiple suppressed title tokens render', () => {
  const group: DomainGroup = {
    domain: 'slack.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-slack-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '4',
    suppressedTitleParts: [
      { text: 'Example Workspace', count: 2 },
      { text: 'JIRA', count: 2 },
      { text: 'Content — Example Website', count: 3 }
    ],
    sections: [
      {
        key: '',
        sectionCount: 1,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Alpha channel'],
            suppressedTitleParts: ['JIRA', 'Content — Example Website']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        clusters: [],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: withSuppressionTones(vm)
    })
  )
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => requiredAt(match, 1))

  assert.equal(tokenClasses.length, 3)
  assert.match(requiredAt(tokenClasses, 0), /title-suppression-token-tone-teal/)
  assert.match(requiredAt(tokenClasses, 1), /title-suppression-token-tone-sky/)
  assert.match(requiredAt(tokenClasses, 2), /title-suppression-token-tone-amber/)
  assert.notEqual(tokenClasses[0], tokenClasses[1])
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => requiredAt(match, 1))
  assert.equal(markerClasses.length, 2)
  assert.match(requiredAt(markerClasses, 0), /title-suppression-token-tone-sky/)
  assert.match(requiredAt(markerClasses, 1), /title-suppression-token-tone-amber/)
})

test('HistoryEntry renders open-ghost marker with data-tabout-part attribute', () => {
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot(),
      workingSet: makeWorkingSetSnapshot({
        items: [
          makeWorkingSetItem(),
          {
            key: 'https://example.com/extra',
            tabId: 202,
            windowId: 1,
            tabUrl: 'https://example.com/extra',
            rawUrl: 'https://example.com/extra',
            title: 'Extra Candidate',
            displayUrl: 'example.com/extra',
            faviconUrl: '',
            dupeCount: 1,
            active: false,
            activeInOtherWindow: false,
            score: 80,
            lastActivatedAt: 0
          }
        ]
      })
    })
  )

  assert.match(html, /data-working-set-extra="true"/)
  assert.doesNotMatch(html, /history-entry-marker-(open|closed)-ghost/)
})

test('closed-ghost rows declare a forget affordance instead of a tab-close', () => {
  // A server render intentionally keeps closed rows hidden because effects
  // have not established whether dismissal storage is known. The pure row
  // builder covers that state gate; guard the rendered action wiring here.
  const source = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  assert.match(source, /data-tabout-part=\{canForgetClosedGhost \? 'forget-button' : 'close-button'\}/)
  assert.match(source, /aria-label=\{canForgetClosedGhost \? `Remove \$\{entryLabel\} from recently closed` : `Close \$\{entryLabel\}`\}/)
  assert.match(source, /canForgetClosedGhost \? \(\s*<EyeOff/)
})

test('TabHistoryPanel highlights filter matches in history-row titles', () => {
  const html = renderTabHistoryPanel({ snapshot: makeHistorySnapshot(), filter: 'example' })
  assert.match(html, /Example Docs|<mark/) // sanity: the row title renders
  assert.match(html, /<mark[^>]*class="[^"]*chip-filter-match[^"]*"[^>]*><span class="chip-title-fixation\b[^"]*">Exam<\/span>ple<\/mark>/)
})

test('TabHistoryPanel does not highlight history-row titles when no filter is active', () => {
  const html = renderTabHistoryPanel({ snapshot: makeHistorySnapshot(), filter: '' })
  assert.doesNotMatch(html, /<mark/)
})
