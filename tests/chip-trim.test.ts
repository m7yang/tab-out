import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { chipTrim, CHIP_TRIM_TOKENS, type ChipTrimFacts } from '../src/components/chip-trim/index.js'

/* The Chip Trim decision table, tested as a table: facts in, paint out.
   These tests cross the module's interface — never the source text. */

function facts(overrides: Partial<ChipTrimFacts> = {}): ChipTrimFacts {
  return {
    activeChipFrame: false,
    activeInOtherWindow: false,
    isCurrentTabOut: false,
    closedSavedPage: false,
    readOnlyFilterResult: false,
    folded: false,
    titleVariantGroup: false,
    iconOnly: false,
    isApp: false,
    expanded: null,
    ...overrides,
  }
}

const OUTLINE_TRIO = /hover:not-focus-visible:not-data-\[tabout-filter-result-selected=true\]:outline-1.*-outline-offset-1.*outline-\(--chip-hover-border\)/
const EXPANDED_OUTLINE_TRIO = /\[&\.page-chip-expanded:not\(:focus-visible\):not\(\[data-tabout-filter-result-selected=true\]\)\]:outline-1.*\[&\.page-chip-expanded:not\(:focus-visible\):not\(\[data-tabout-filter-result-selected=true\]\)\]:-outline-offset-1.*\[&\.page-chip-expanded:not\(:focus-visible\):not\(\[data-tabout-filter-result-selected=true\]\)\]:outline-\(--chip-hover-border\)/
const OPAQUE_CLICKABLE = 'color-mix(in srgb, var(--card-bg) 90%, var(--color-neutral-600) 10%)'
const TRANSLUCENT_CLICKABLE = 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)'
const GROUP_BG = 'color-mix(in srgb, var(--card-bg) 96.5%, var(--color-neutral-600) 3.5%)'
const ACTIVE_OTHER_BG = 'color-mix(in srgb, var(--card-bg) 88%, var(--color-neutral-600) 12%)'
const ACTIVE_OTHER_REST = 'color-mix(in srgb, var(--card-bg) 92.5%, var(--color-neutral-600) 7.5%)'
const GROUP_LINE = 'color-mix(in srgb, var(--color-neutral-600) 22%, transparent)'
const CLICKABLE_LINE = 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)'

test('chip-trim: plain chips get the translucent fill, the quiet hover line, and no resting trim', () => {
  const trim = chipTrim(facts())
  assert.match(trim.chipClasses, /hover:bg-\(--chip-interaction-bg\)/)
  assert.match(trim.chipClasses, /\[&\.page-chip-expanded\]:bg-\(--chip-interaction-bg\)/)
  assert.match(trim.chipClasses, /\[&\.page-chip-expanded:has\(\.chip-actions\)::after\]:opacity-100/)
  assert.match(trim.chipClasses, /\[&\.page-chip-context-menu-open\]:bg-\(--chip-interaction-bg\)/)
  assert.match(trim.chipClasses, /\[&\.page-chip-tooltip-open\]:bg-\(--chip-interaction-bg\)/)
  // Open plain chips answer hover with the group kinds' 1px line at the
  // quiet interaction-fill color — the same 10% mix as their interaction fill,
  // laid once more at the edge (the darkened fill carries the emphasis).
  assert.match(trim.chipClasses, OUTLINE_TRIO)
  assert.match(trim.chipClasses, EXPANDED_OUTLINE_TRIO)
  assert.equal(trim.styleVars.hoverBorder, CLICKABLE_LINE)
  assert.doesNotMatch(trim.chipClasses, /ring-/)
  assert.equal(trim.frame, null)
  assert.equal(trim.expandedFill, null)
  assert.equal(trim.iconChipClasses, '')
  assert.match(trim.slotClasses, new RegExp(`\\b${RegExp.escape(CHIP_TRIM_TOKENS.slotRow)}\\b`))
  assert.equal(trim.styleVars.interactionBg, TRANSLUCENT_CLICKABLE)
  assert.equal(trim.styleVars.closedInteractionBg, GROUP_BG)
  assert.equal(trim.styleVars.fadeBg, OPAQUE_CLICKABLE)
  assert.equal(trim.styleVars.restBg, 'transparent')
})

test('chip-trim: saved-closed chips carry the marker and the interaction outline', () => {
  const trim = chipTrim(facts({ closedSavedPage: true }))
  assert.match(trim.chipClasses, new RegExp(`\\b${RegExp.escape(CHIP_TRIM_TOKENS.savedClosed)}\\b`))
  assert.match(trim.chipClasses, /text-tab-closed/)
  assert.match(trim.chipClasses, OUTLINE_TRIO)
  assert.equal(trim.frame, null)
  assert.equal(trim.styleVars.hoverBorder, GROUP_LINE)
  assert.equal(trim.styleVars.interactionBg, GROUP_BG)
  assert.equal(trim.styleVars.fadeBg, GROUP_BG)
})

test('chip-trim: read-only filter results use the closed fill without changing the outline treatment', () => {
  const trim = chipTrim(facts({ readOnlyFilterResult: true }))
  assert.match(trim.chipClasses, /hover:bg-\(--chip-interaction-bg\)/)
  assert.match(trim.chipClasses, OUTLINE_TRIO)
  assert.doesNotMatch(trim.chipClasses, /text-tab-closed/)
  assert.doesNotMatch(trim.chipClasses, new RegExp(`\\b${RegExp.escape(CHIP_TRIM_TOKENS.savedClosed)}\\b`))
  assert.equal(trim.styleVars.interactionBg, GROUP_BG)
  assert.equal(trim.styleVars.fadeBg, GROUP_BG)
  assert.equal(trim.styleVars.hoverBorder, CLICKABLE_LINE)
})

test('chip-trim: variant-group and folded chips get the group outline', () => {
  for (const kind of [{ titleVariantGroup: true }, { folded: true }]) {
    const trim = chipTrim(facts(kind))
    assert.match(trim.chipClasses, OUTLINE_TRIO)
    assert.doesNotMatch(trim.chipClasses, /text-tab-closed/)
    assert.doesNotMatch(trim.chipClasses, new RegExp(`\\b${RegExp.escape(CHIP_TRIM_TOKENS.savedClosed)}\\b`))
    assert.equal(trim.frame, null)
    assert.equal(trim.styleVars.hoverBorder, GROUP_LINE)
    assert.equal(trim.styleVars.interactionBg, GROUP_BG)
  }
})

test('chip-trim: all-closed group kinds use the closed title tone with the group outline', () => {
  for (const kind of [{ titleVariantGroup: true }, { folded: true }]) {
    const trim = chipTrim(facts({ ...kind, closedSavedPage: true }))
    assert.match(trim.chipClasses, /text-tab-closed/)
    assert.match(trim.chipClasses, OUTLINE_TRIO)
    assert.doesNotMatch(trim.chipClasses, new RegExp(`\\b${RegExp.escape(CHIP_TRIM_TOKENS.savedClosed)}\\b`))
    assert.equal(trim.frame, null)
    assert.equal(trim.styleVars.hoverBorder, GROUP_LINE)
    assert.equal(trim.styleVars.interactionBg, GROUP_BG)
  }
})

test('chip-trim: the open hover line repeats the quiet interaction-fill tone; icon and framed kinds opt out', () => {
  // Two line weights by where the hover signal lives: group/saved kinds
  // barely darken their fill, so they hover the stronger 22% line; open
  // plain chips darken to the 10% fill, so their line repeats that tone
  // laid once more at the edge — a quiet rim (owner-tuned from 32%).
  // Icon-only chips keep fill-only feedback (their always-on ring sits
  // OUTSIDE via outline-offset-1 — the trio's inset offset would yank it
  // inward on hover), and framed kinds strengthen their inset frame
  // instead of drawing an outline.
  assert.equal(chipTrim(facts()).styleVars.hoverBorder, CLICKABLE_LINE)
  for (const kind of [{ closedSavedPage: true }, { folded: true }, { titleVariantGroup: true }]) {
    assert.equal(chipTrim(facts(kind)).styleVars.hoverBorder, GROUP_LINE)
  }
  assert.doesNotMatch(chipTrim(facts({ iconOnly: true })).chipClasses, OUTLINE_TRIO)
  assert.doesNotMatch(chipTrim(facts({ activeChipFrame: true })).chipClasses, /outline/)
  assert.doesNotMatch(chipTrim(facts({ activeChipFrame: true, activeInOtherWindow: true })).chipClasses, /outline/)
})

test('chip-trim: an active frame suppresses the group outline', () => {
  const trim = chipTrim(facts({ titleVariantGroup: true, activeChipFrame: true, activeInOtherWindow: true }))
  assert.doesNotMatch(trim.chipClasses, /outline/)
  assert.ok(trim.frame, 'active variant groups draw the frame instead')
  assert.match(trim.frame.classes, /rgba\(115,115,115,0\.2\)/)
  assert.equal(trim.styleVars.interactionBg, ACTIVE_OTHER_BG)
})

test('chip-trim: the three frame flavours resolve by precedence', () => {
  const activeOther = chipTrim(facts({ activeChipFrame: true, activeInOtherWindow: true }))
  assert.match(activeOther.chipClasses, /bg-\(--chip-rest-bg\)/)
  assert.doesNotMatch(activeOther.chipClasses, /current-active-chip|current-tab-out-chip/)
  assert.ok(activeOther.frame)
  assert.match(activeOther.frame.classes, /rgba\(115,115,115,0\.2\)/)
  assert.equal(activeOther.styleVars.restBg, ACTIVE_OTHER_REST)

  const currentActive = chipTrim(facts({ activeChipFrame: true }))
  assert.match(currentActive.chipClasses, /current-active-chip .*ring-1 ring-inset ring-neutral-400/)
  assert.ok(currentActive.frame)
  assert.match(currentActive.frame.classes, /current-active-chip-frame/)
  assert.equal(currentActive.styleVars.interactionBg, 'var(--color-neutral-50)')

  const currentTabOut = chipTrim(facts({ activeChipFrame: true, isCurrentTabOut: true }))
  assert.match(currentTabOut.chipClasses, /current-tab-out-chip /)
  assert.ok(currentTabOut.frame)
  assert.match(currentTabOut.frame.classes, /current-tab-out-chip-frame/)
  assert.equal(currentTabOut.styleVars.interactionBg, 'var(--color-neutral-100)')
  assert.equal(currentTabOut.styleVars.restBg, 'transparent')

  // activeInOtherWindow outranks isCurrentTabOut — the tab is not current here.
  const otherWindowTabOut = chipTrim(facts({ activeChipFrame: true, activeInOtherWindow: true, isCurrentTabOut: true }))
  assert.doesNotMatch(otherWindowTabOut.chipClasses, /current-tab-out-chip /)
})

test('chip-trim: a kind with no trim at rest gains none at rest in any state', () => {
  // The owner's rule, amended 2026-07-15: plain chips still draw NOTHING at
  // rest — no frame, and no unconditioned outline/ring/border utility in any
  // expansion state. Interaction feedback now pairs the fill with the 1px
  // hover line, so every outline utility must stay behind an interaction
  // variant (hover / expansion / context-menu-open / tooltip-open).
  const expansions: ChipTrimFacts['expanded'][] = [
    null,
    { grewTaller: false, y: 'down' },
    { grewTaller: true, y: 'down' },
    { grewTaller: false, y: 'up' },
    { grewTaller: true, y: 'up' },
  ]
  for (const expanded of expansions) {
    const trim = chipTrim(facts({ expanded }))
    for (const token of trim.chipClasses.split(/\s+/)) {
      assert.doesNotMatch(token, /^(outline|ring|border)(-|$)/, `resting trim leaked: ${token}`)
    }
    assert.equal(trim.frame, null)
  }
})

test('chip-trim: the expanded fill spares flush edges and extends grown edges', () => {
  const inPlaceDown = chipTrim(facts({ expanded: { grewTaller: false, y: 'down' } })).expandedFill
  assert.ok(inPlaceDown)
  assert.equal(inPlaceDown.top, '1px')
  assert.equal(inPlaceDown.bottom, '1px')
  assert.equal(inPlaceDown.background, OPAQUE_CLICKABLE)
  assert.ok(inPlaceDown.classes.includes('opacity-0'))
  assert.ok(inPlaceDown.classes.includes('group-hover/page-chip:opacity-100'))
  assert.ok(inPlaceDown.classes.includes('group-focus-visible/page-chip:opacity-100'))
  assert.ok(inPlaceDown.classes.includes('group-[.page-chip-expanded]/page-chip:opacity-100'))
  assert.ok(inPlaceDown.classes.includes('group-[.page-chip-context-menu-open]/page-chip:opacity-100'))
  assert.ok(inPlaceDown.classes.includes('group-[.page-chip-tooltip-open]/page-chip:opacity-100'))

  const grownDown = chipTrim(facts({ expanded: { grewTaller: true, y: 'down' } })).expandedFill
  assert.ok(grownDown)
  assert.equal(grownDown.top, '1px')
  assert.equal(grownDown.bottom, '0px')

  const grownUp = chipTrim(facts({ expanded: { grewTaller: true, y: 'up' } })).expandedFill
  assert.ok(grownUp)
  assert.equal(grownUp.top, '0px')
  assert.equal(grownUp.bottom, '1px')

  const inPlaceUp = chipTrim(facts({ expanded: { grewTaller: false, y: 'up' } })).expandedFill
  assert.ok(inPlaceUp)
  assert.equal(inPlaceUp.top, '1px')
  assert.equal(inPlaceUp.bottom, '1px')
})

test('chip-trim: only expanded plain full-width chips get the fill layer', () => {
  const expanded: ChipTrimFacts['expanded'] = { grewTaller: false, y: 'down' }
  assert.equal(chipTrim(facts({ expanded, closedSavedPage: true })).expandedFill, null)
  assert.equal(chipTrim(facts({ expanded, titleVariantGroup: true })).expandedFill, null)
  assert.equal(chipTrim(facts({ expanded, activeChipFrame: true })).expandedFill, null)
  assert.equal(chipTrim(facts({ expanded, iconOnly: true })).expandedFill, null)
})

test('chip-trim: the fade fill is never the translucent overlay', () => {
  // The fade exists to hide chip text under the action rail; a translucent
  // fade would let the text show through.
  const kinds: Partial<ChipTrimFacts>[] = [
    {},
    { closedSavedPage: true },
    { folded: true },
    { titleVariantGroup: true },
    { activeChipFrame: true },
    { activeChipFrame: true, activeInOtherWindow: true },
    { activeChipFrame: true, isCurrentTabOut: true },
    { iconOnly: true },
  ]
  for (const kind of kinds) {
    assert.notEqual(chipTrim(facts(kind)).styleVars.fadeBg, TRANSLUCENT_CLICKABLE)
  }
})

test('chip-trim: full-width slots carry the seam overlap and interaction lift', () => {
  const slot = chipTrim(facts()).slotClasses
  // Unconditional adjacent-sibling overlap: trim capability is app state,
  // so the -1px must never key off trim markers or hover state.
  assert.match(slot, /\[\.chip-slot-row\+&\]:-mt-px/)
  assert.match(slot, new RegExp(`\\b${RegExp.escape(CHIP_TRIM_TOKENS.slotRow)}\\b`))
  // The interacting slot lifts above neighbours so its strengthened frame
  // paints on top at the shared seam — for hover, expansion, menu, and tooltip.
  assert.match(slot, /has-\[\.page-chip:hover:not\(\[data-title-collapsed\]\)\]:z-4/)
  assert.match(slot, /has-\[\.page-chip-expanded\]:z-4/)
  assert.match(slot, /has-\[\.page-chip-context-menu-open\]:z-4/)
  assert.match(slot, /has-\[\.page-chip-tooltip-open\]:z-4/)
  // Identical for every full-width kind — seam participation is not
  // kind-dependent.
  assert.equal(chipTrim(facts({ closedSavedPage: true })).slotClasses, slot)
  assert.equal(chipTrim(facts({ activeChipFrame: true })).slotClasses, slot)
})

test('chip-trim: framed chips strengthen their line on interaction', () => {
  const frame = chipTrim(facts({ activeChipFrame: true, activeInOtherWindow: true })).frame
  assert.ok(frame)
  assert.match(frame.classes, /group-hover\/page-chip:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
  assert.match(frame.classes, /group-\[\.page-chip-expanded\]\/page-chip:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
  assert.match(frame.classes, /group-\[\.page-chip-context-menu-open\]\/page-chip:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
  assert.match(frame.classes, /group-\[\.page-chip-tooltip-open\]\/page-chip:shadow-\[inset_0_0_0_1px_rgba\(38,38,38,0\.55\)\]/)
})

test('chip-trim: icon-only slots never join vertical seam runs', () => {
  const icon = chipTrim(facts({ iconOnly: true }))
  assert.equal(icon.slotClasses, '')
  assert.equal(icon.frame, null, 'icon chips draw their trim on the chip itself, not a frame span')
  assert.match(icon.iconChipClasses, /\[outline:1px_solid_rgba\(115,115,115,0\.18\)\]/)

  const app = chipTrim(facts({ iconOnly: true, isApp: true }))
  assert.match(app.iconChipClasses, /border-\[rgba\(115,115,115,0\.32\)\]/)
  assert.doesNotMatch(app.iconChipClasses, /\[outline:1px_solid_rgba\(115,115,115,0\.18\)\]/)

  const active = chipTrim(facts({ iconOnly: true, activeChipFrame: true }))
  assert.match(active.iconChipClasses, /\[outline:1px_solid_rgba\(82,82,82,0\.32\)\]/)
  assert.match(active.iconChipClasses, /bg-\(--chip-rest-bg\)/)
})

/* The module is single-language: the seam rules ride in the emitted class
   strings as arbitrary variants that compile to plain CSS selectors, so
   interaction chrome still swaps inside one style recalculation. The only
   trim classes applied outside chipTrim() output are the hover-match styles
   (React-state-driven, owned by PageChip): the full-width outline layer
   and icon-only slot lift, which the interacting-slot z-4 outranks. */
test('chip-trim: PageChip owns the hover-match overlay with the shared outline utilities', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /hoverMatched && CHIP_TRIM_TOKENS\.hoverMatch/)
  assert.match(pageChipSource, /page-chip-hover-match-outline[^"]*z-3[^"]*outline-1 outline-offset-1 outline-\(--accent-amber\)/)
  assert.match(pageChipSource, /hoverMatched && chip\.iconOnly && 'z-3'/)
})
