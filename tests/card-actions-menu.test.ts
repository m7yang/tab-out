import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CardActionsMenu } from '../src/components/CardActionsMenu.js'
import { DomainCard } from '../src/components/DomainCard.js'
import type { DashboardCardVM, DomainGroup } from '../src/extension/types'

function menuItemOpeningTag(source: string, part: string) {
  const partIndex = source.indexOf(`data-tabout-part="${part}"`)
  assert.notEqual(partIndex, -1, `expected ${part} menu item`)
  const tagStart = source.lastIndexOf('<MenuItem', partIndex)
  const tagEnd = source.indexOf('>', partIndex)
  assert.notEqual(tagStart, -1, `expected ${part} MenuItem start`)
  assert.notEqual(tagEnd, -1, `expected ${part} MenuItem end`)
  return source.slice(tagStart, tagEnd + 1)
}

test('CardActionsMenu renders a kebab trigger and hides the close item until opened', () => {
  const html = renderToStaticMarkup(
    React.createElement(CardActionsMenu, {
      displayName: 'google.com',
      label: 'Close all 5 tabs',
      onClose: () => {},
    }),
  )

  // Trigger is present in the at-rest markup.
  assert.match(html, /<button[^>]*data-tabout-part="card-menu"/)
  assert.match(html, /aria-label="Actions for google\.com"/)
  assert.match(html, /aria-haspopup="menu"/)
  assert.match(html, /icon-\[lucide--ellipsis-vertical\]/)

  // The closed menu's item is NOT in the at-rest markup (it lives in the unopened portal).
  assert.doesNotMatch(html, /Close all 5 tabs/)
  assert.doesNotMatch(html, /data-tabout-part="close-button"/)
})

function makeClosableCardVM(overrides: Partial<DashboardCardVM> = {}): DashboardCardVM {
  return {
    stableId: 'domain-google-com',
    isHidden: false,
    filtering: false,
    tabCountLabel: '5',
    closableCount: 5,
    closableCountLabel: 'Close all 5 tabs',
    suspendableCount: 5,
    suspendableCountLabel: 'Suspend all 5 tabs',
    closableSuspendedCount: 2,
    closableSuspendedCountLabel: 'Close all 2 suspended tabs',
    suppressedTitleParts: [],
    sections: [],
    ...overrides,
  }
}

test('DomainCard renders the kebab actions menu (not the old close button) when closable', () => {
  const group: DomainGroup = { domain: 'google.com', tabs: [] }
  const html = renderToStaticMarkup(React.createElement(DomainCard, { group, vm: makeClosableCardVM() }))

  assert.match(html, /data-tabout-part="card-menu"/)
  assert.match(html, /aria-label="Actions for google\.com"/)
  // The old dual-mode close button is gone from the at-rest header.
  assert.doesNotMatch(html, /card-close-btn/)
  assert.doesNotMatch(html, /data-tabout-part="close-button"/)
})

test('DomainCard keeps the actions menu in the first header row flow', () => {
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const menuSource = readFileSync(new URL('../src/components/CardActionsMenu.tsx', import.meta.url), 'utf8')
  const triggerClass = menuSource.match(/card-actions-menu-trigger[^"]*/)?.[0] ?? ''
  const group: DomainGroup = { domain: 'google.com', tabs: [] }
  const html = renderToStaticMarkup(React.createElement(DomainCard, { group, vm: makeClosableCardVM() }))
  const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? ''

  assert.match(domainCardSource, /domain-header min-w-0/)
  assert.match(header, /<header class="domain-header min-w-0 px-2/)
  assert.match(domainCardSource, /grid-cols-\[minmax\(0,1fr\)_auto\]/)
  assert.match(domainCardSource, /domain-header-flow flex min-w-0 flex-row flex-wrap/)
  assert.ok(domainCardSource.indexOf('domain-header-flow') < domainCardSource.indexOf('<CardActionsMenu'))
  assert.match(header, /<div class="domain-header-flow[\s\S]*<\/div><button[\s\S]*data-tabout-part="card-menu"/)
  assert.doesNotMatch(triggerClass, /\babsolute\b/)
  assert.doesNotMatch(triggerClass, /\b(?:top-0|right-0)\b/)
  assert.match(triggerClass, /\bshrink-0\b/)
  assert.match(triggerClass, /\bjustify-self-end\b/)
})

test('CardActionsMenu separates pinning, orders live-tab actions narrowly to broadly, then removes retained pages', () => {
  const source = readFileSync(new URL('../src/components/CardActionsMenu.tsx', import.meta.url), 'utf8')
  const pinIndex = source.indexOf('data-tabout-part="pin-button"')
  const firstSeparatorIndex = source.indexOf('<MenuSeparator')
  const suspendIndex = source.indexOf('data-tabout-part="suspend-button"')
  const closeSuspendedIndex = source.indexOf('data-tabout-part="close-suspended-button"')
  const closeAllIndex = source.indexOf('data-tabout-part="close-button"')
  const secondSeparatorIndex = source.indexOf('<MenuSeparator', firstSeparatorIndex + 1)
  const removeFromTabsIndex = source.indexOf('data-tabout-part="remove-from-tabs-button"')

  assert.ok(pinIndex < firstSeparatorIndex)
  assert.ok(firstSeparatorIndex < suspendIndex)
  assert.ok(suspendIndex < closeSuspendedIndex)
  assert.ok(closeSuspendedIndex < closeAllIndex)
  assert.ok(closeAllIndex < secondSeparatorIndex)
  assert.ok(secondSeparatorIndex < removeFromTabsIndex)
  assert.match(source, /onTogglePin && \(hasLiveTabActions \|\| hasRemoveFromTabsAction\)/)
  assert.match(source, /hasLiveTabActions && hasRemoveFromTabsAction/)
  assert.match(source, /pinned \? 'icon-\[lucide--pin-off\]/)
  assert.match(source, /: 'icon-\[lucide--pin\]/)
  assert.match(source, /icon-\[lucide--circle-x\]/)
  assert.match(source, /icon-\[lucide--list-x\]/)
  assert.match(source, /disabled=\{!closeSuspendedEnabled\}/)
})

test('CardActionsMenu reserves destructive styling for retained-page removal', () => {
  const source = readFileSync(new URL('../src/components/CardActionsMenu.tsx', import.meta.url), 'utf8')
  const closeSuspendedItem = menuItemOpeningTag(source, 'close-suspended-button')
  const closeItem = menuItemOpeningTag(source, 'close-button')
  const removeFromTabsItem = menuItemOpeningTag(source, 'remove-from-tabs-button')

  assert.doesNotMatch(closeSuspendedItem, /variant="destructive"/)
  assert.doesNotMatch(closeItem, /variant="destructive"/)
  assert.match(removeFromTabsItem, /variant="destructive"/)
  assert.doesNotMatch(closeSuspendedItem, /status-abandoned|text-destructive/)
  assert.doesNotMatch(closeItem, /status-abandoned|text-destructive/)
})

test('menu primitives share one persistent destructive variant', () => {
  const menuSource = readFileSync(new URL('../src/components/ui/menu.tsx', import.meta.url), 'utf8')
  const contextMenuSource = readFileSync(new URL('../src/components/ui/context-menu.tsx', import.meta.url), 'utf8')
  const menuStylesSource = readFileSync(new URL('../src/components/ui/menu-styles.ts', import.meta.url), 'utf8')

  assert.match(menuStylesSource, /export type MenuItemVariant = 'default' \| 'destructive'/)
  assert.match(menuStylesSource, /destructiveMenuItemClassName\s*=\s*\n?\s*'[^']*text-destructive/)
  assert.match(menuStylesSource, /destructiveMenuItemClassName\s*=\s*\n?\s*'[^']*data-highlighted:bg-destructive\/10/)
  assert.match(menuStylesSource, /destructiveMenuItemClassName\s*=\s*\n?\s*'[^']*data-highlighted:text-destructive/)

  for (const primitiveSource of [menuSource, contextMenuSource]) {
    assert.match(primitiveSource, /variant = 'default'/)
    assert.match(primitiveSource, /variant\?: MenuItemVariant/)
    assert.match(primitiveSource, /data-variant=\{variant\}/)
    assert.match(primitiveSource, /variant === 'destructive' && destructiveMenuItemClassName/)
  }
})

test('DomainCard keeps close suspended visible and disables it at zero', () => {
  const source = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')

  assert.match(source, /closeSuspendedLabel=\{showBulkActions \? closeSuspendedLabel : undefined\}/)
  assert.match(source, /onCloseSuspended=\{showBulkActions \? onCloseSuspendedDomain : undefined\}/)
  assert.match(source, /closeSuspendedEnabled=\{showBulkActions && closableSuspendedCount > 0\}/)
})

test('DomainCard keeps a pin-only actions menu when there is nothing closable', () => {
  const group: DomainGroup = { domain: 'google.com', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, { group, vm: makeClosableCardVM({ closableCount: 0 }) }),
  )

  assert.match(html, /data-tabout-part="card-menu"/)
  assert.doesNotMatch(html, /data-tabout-part="pin-indicator"/)
})

test('DomainCard renders no actions menu when the card is neither mutable nor pinnable', () => {
  const group: DomainGroup = { domain: '__private__', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, { group, vm: makeClosableCardVM({ closableCount: 0 }) }),
  )

  assert.doesNotMatch(html, /data-tabout-part="card-menu"/)
})

test('DomainCard gives a retained-only non-pinnable card a batch-removal menu', () => {
  const group: DomainGroup = { domain: '__private__', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: makeClosableCardVM({
        closableCount: 0,
        retainedPageRemovalTargets: [{
          retainedPageIdentity: 'identity-example',
          retainedPageClosureToken: 'lifetime-example',
        }],
        retainedPageRemovalLabel: 'Remove from Tabs',
      }),
    }),
  )

  assert.match(html, /data-tabout-part="card-menu"/)
  assert.match(html, /aria-label="Actions for __private__"/)
})

test('DomainCard gives the standalone-apps card a pin-only actions menu', () => {
  const group: DomainGroup = { domain: '__standalone-apps__', tabs: [] }
  const html = renderToStaticMarkup(React.createElement(DomainCard, { group, vm: makeClosableCardVM() }))

  assert.match(html, /data-tabout-part="card-menu"/)
  assert.match(html, /<header class="domain-header min-w-0 px-2 grid/)
})

test('DomainCard replaces saved badge copy with the saved-page menu icon', () => {
  const group: DomainGroup = { domain: 'example.com', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: makeClosableCardVM({ tabCountLabel: '9 +5 saved' }),
    }),
  )

  assert.match(html, /tab-count-badge-saved/)
  assert.match(html, /tab-count-badge-plus mx-1/)
  assert.match(html, /tab-count-badge-saved-count[^>]*>5<\/span>/)
  assert.match(html, /icon-\[mingcute--star-fill\]/)
  assert.match(html, /ml-px size-3 opacity-50/)
  assert.match(html, /<span class="sr-only"> saved<\/span>/)
})

test('DomainCard shows only the saved count and icon when there are no open tabs', () => {
  const group: DomainGroup = { domain: 'example.com', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: makeClosableCardVM({ tabCountLabel: '0 +5 saved' }),
    }),
  )
  const badgeHtml = html.match(/<span class="open-tabs-badge[^"]*">[\s\S]*?<span class="sr-only"> saved<\/span><\/span><\/span>/)?.[0] ?? ''

  assert.match(badgeHtml, /tab-count-badge-saved-count[^>]*>5<\/span>/)
  assert.match(badgeHtml, /icon-\[mingcute--star-fill\]/)
  assert.doesNotMatch(badgeHtml, /tab-count-badge-plus/)
  assert.doesNotMatch(badgeHtml, />0<\//)
})

test('DomainCard formats a filtered saved-only count as a fraction with its saved icon', () => {
  const group: DomainGroup = { domain: 'example.com', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: makeClosableCardVM({ tabCountLabel: '2/4 saved' }),
    }),
  )
  const badgeHtml = html.match(/<span class="open-tabs-badge[^"]*">[\s\S]*?<span class="sr-only"> saved<\/span><\/span><\/span>/)?.[0] ?? ''

  assert.match(badgeHtml, /tab-count-badge-filtered/)
  assert.match(badgeHtml, /tab-count-badge-current[^>]*>2<\/span>/)
  assert.match(badgeHtml, /tab-count-badge-total[^>]*>\/4<\/span>/)
  assert.match(badgeHtml, /icon-\[mingcute--star-fill\]/)
  assert.doesNotMatch(badgeHtml, /tab-count-badge-plus/)
  assert.doesNotMatch(badgeHtml, />0<\//)
})

test('DomainCard formats a filtered saved count as a fraction alongside open tabs', () => {
  const group: DomainGroup = { domain: 'example.com', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm: makeClosableCardVM({ tabCountLabel: '2/10 +2/4 saved' }),
    }),
  )
  const badgeHtml = html.match(/<span class="open-tabs-badge[^"]*">[\s\S]*?<span class="sr-only"> saved<\/span><\/span><\/span>/)?.[0] ?? ''
  const savedBadgeHtml = badgeHtml.slice(badgeHtml.indexOf('tab-count-badge-saved-count'))

  assert.match(badgeHtml, /tab-count-badge-current[^>]*>2<\/span>/)
  assert.match(badgeHtml, /tab-count-badge-total[^>]*>\/10<\/span>/)
  assert.match(savedBadgeHtml, /tab-count-badge-current[^>]*>2<\/span>/)
  assert.match(savedBadgeHtml, /tab-count-badge-total[^>]*>\/4<\/span>/)
  assert.match(savedBadgeHtml, /icon-\[mingcute--star-fill\]/)
  assert.match(badgeHtml, /tab-count-badge-plus/)
})

test('DomainCard shows a header pin marker only after the card is pinned', () => {
  const unpinnedHtml = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group: { domain: 'example.com', tabs: [] },
      vm: makeClosableCardVM(),
    }),
  )
  const pinnedHtml = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group: { domain: 'example.com', tabs: [], pinned: true },
      vm: makeClosableCardVM(),
    }),
  )

  assert.doesNotMatch(unpinnedHtml, /data-tabout-part="pin-indicator"/)
  assert.match(pinnedHtml, /data-tabout-part="pin-indicator"/)
  assert.match(pinnedHtml, /<span class="sr-only">Pinned example\.com<\/span>/)
})
