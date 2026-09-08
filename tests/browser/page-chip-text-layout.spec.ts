import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { build } from 'vite'

/**
 * Drives the page-chip-text-layout session directly on fixture DOM — no React
 * mount — so clamp capture, packed-width revalidation, expansion geometry,
 * variant packing, re-attachment, and font invalidation are verified against
 * the engine's own interface in a real layout engine.
 */

import type { ChipTextLayoutSession, ChipTextLayoutSnapshot } from '../../src/components/page-chip-text-layout/index.js'

type FixtureWindow = typeof window & {
  __chipTextLayout: {
    createChipTextLayoutSession: () => ChipTextLayoutSession
    validatePageChipTextLayoutsAfterMasonry: (containers: Array<HTMLElement | null>) => void
  }
  __fixtureSession: ChipTextLayoutSession
}

const repoRoot = resolve(import.meta.dirname, '..', '..')
let bundlePath: string | null = null

async function buildSessionBundle(): Promise<string> {
  if (bundlePath) return bundlePath
  const outDir = mkdtempSync(join(tmpdir(), 'chip-text-layout-fixture-'))
  const entry = join(outDir, 'entry.ts')
  const indexPath = resolve(repoRoot, 'src/components/page-chip-text-layout/index.ts')
  writeFileSync(entry, [
    `import * as chipTextLayout from '${indexPath}'`,
    ';(globalThis as unknown as { __chipTextLayout: unknown }).__chipTextLayout = chipTextLayout',
    '',
  ].join('\n'))
  await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: [{ find: '@', replacement: resolve(repoRoot, 'src') }] },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      emptyOutDir: false,
      lib: { entry, fileName: () => 'session-fixture.js', formats: ['iife'], name: 'ChipTextLayoutFixture' },
      minify: false,
      outDir,
      sourcemap: false,
    },
  })
  bundlePath = join(outDir, 'session-fixture.js')
  return bundlePath
}

const LONG_TITLE = 'Quarterly planning review for the shared design system tokens and the long tail of documentation updates'

type ChipFixtureOptions = {
  cardWidth?: string
  stageMarginTop?: string
  title?: string
  variantLabel?: string | null
}

async function mountChipFixture(page: Page, options: ChipFixtureOptions = {}) {
  await page.evaluate(({ cardWidth, stageMarginTop, title, variantLabel }) => {
    const stage = document.querySelector<HTMLElement>('#stage')
    if (!stage) throw new Error('missing stage')
    stage.style.marginTop = stageMarginTop
    stage.innerHTML = ''

    const missions = document.createElement('div')
    missions.className = 'missions is-packed'
    const card = document.createElement('div')
    card.className = 'domain-block'
    card.style.width = cardWidth
    const chip = document.createElement('div')
    chip.className = 'page-chip'
    chip.style.display = 'block'
    const text = document.createElement('span')
    text.className = 'chip-text'
    text.style.display = 'block'
    text.style.overflow = 'hidden'
    text.style.lineHeight = '16px'
    text.style.fontSize = '13px'
    text.style.maxHeight = '32px'
    text.append(document.createTextNode(title))

    if (variantLabel !== null) {
      const list = document.createElement('span')
      list.className = 'chip-title-variant-list'
      const shell = document.createElement('span')
      shell.className = 'chip-title-variant-shell'
      const button = document.createElement('span')
      button.className = 'chip-title-variant'
      const label = document.createElement('span')
      label.className = 'chip-title-variant-label'
      label.style.display = 'inline-block'
      label.style.maxWidth = '40px'
      label.style.overflow = 'hidden'
      label.style.whiteSpace = 'nowrap'
      label.textContent = variantLabel
      button.append(label)
      shell.append(button)
      list.append(shell)
      text.append(list)
    }

    chip.append(text)
    card.append(chip)
    missions.append(card)
    stage.append(missions)

    const fixtureWindow = window as unknown as FixtureWindow & { __fixtureSession?: ChipTextLayoutSession }
    fixtureWindow.__fixtureSession?.dispose()
    const session = fixtureWindow.__chipTextLayout.createChipTextLayoutSession()
    fixtureWindow.__fixtureSession = session
    session.syncText(text)
    session.setContent('fixture-key', true)
    session.onCommit()
    session.observeText()
  }, {
    cardWidth: options.cardWidth ?? '320px',
    stageMarginTop: options.stageMarginTop ?? '0px',
    title: options.title ?? LONG_TITLE,
    variantLabel: options.variantLabel ?? null,
  })
}

function readSnapshot(page: Page): Promise<ChipTextLayoutSnapshot> {
  return page.evaluate(() => (window as unknown as FixtureWindow).__fixtureSession.snapshot())
}

test.beforeEach(async ({ page }) => {
  const bundle = await buildSessionBundle()
  await page.goto('/tests/fixtures/page-chip-text-layout.html')
  await page.addScriptTag({ path: bundle })
})

test('a truncated title captures a multi-line clamp and applies the fade', async ({ page }) => {
  await mountChipFixture(page)
  const snapshot = await readSnapshot(page)

  expect(snapshot.layout.metrics.isTruncated).toBe(true)
  expect(snapshot.layout.metrics.hasExpandableContent).toBe(true)
  expect(snapshot.layout.clamp).not.toBeNull()
  expect(snapshot.layout.clamp?.key).toBe('fixture-key')
  expect(snapshot.layout.clamp?.lineHtml.length).toBe(2)
  expect(snapshot.layout.clamp?.width).toBeGreaterThan(0)

  const domState = await page.evaluate(() => {
    const text = document.querySelector<HTMLElement>('.chip-text')
    return {
      fadeEnd: text?.style.getPropertyValue('--title-fade-end') ?? '',
      truncatedClass: !!text?.classList.contains('chip-text-truncated'),
    }
  })
  expect(domState.truncatedClass).toBe(true)
  expect(domState.fadeEnd).toBe(`${snapshot.layout.clamp?.width}px`)
})

test('a short title captures no clamp and stays unexpandable', async ({ page }) => {
  await mountChipFixture(page, { title: 'Short title' })
  const snapshot = await readSnapshot(page)

  expect(snapshot.layout.metrics.isTruncated).toBe(false)
  expect(snapshot.layout.metrics.hasExpandableContent).toBe(false)
  expect(snapshot.layout.clamp).toBeNull()
})

test('masonry revalidation skips unchanged card widths and re-measures real changes', async ({ page }) => {
  await mountChipFixture(page)
  const initial = await readSnapshot(page)
  expect(initial.layout.clamp).not.toBeNull()

  const unchanged = await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow
    const before = fixtureWindow.__fixtureSession.snapshot()
    fixtureWindow.__chipTextLayout.validatePageChipTextLayoutsAfterMasonry([
      document.querySelector<HTMLElement>('#stage'),
    ])
    return { changed: fixtureWindow.__fixtureSession.snapshot() !== before }
  })
  expect(unchanged.changed).toBe(false)

  const remeasured = await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow
    const card = document.querySelector<HTMLElement>('.domain-block')
    if (!card) throw new Error('missing card')
    card.style.width = '240px'
    fixtureWindow.__chipTextLayout.validatePageChipTextLayoutsAfterMasonry([
      document.querySelector<HTMLElement>('#stage'),
    ])
    return fixtureWindow.__fixtureSession.snapshot()
  })
  expect(remeasured.layout.clamp).not.toBeNull()
  expect(remeasured.layout.clamp?.width).toBeLessThan(initial.layout.clamp?.width ?? 0)
  expect(remeasured.layout.metrics.width).toBeLessThan(initial.layout.metrics.width)
})

test('expansion measurement composes width within the viewport budget and opens downward with room below', async ({ page }) => {
  await mountChipFixture(page)
  const geometry = await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow
    fixtureWindow.__fixtureSession.measureExpansion(document.querySelector<HTMLElement>('#stage'))
    return fixtureWindow.__fixtureSession.snapshot()
  })

  expect(geometry.expansionGeometry.y).toBe('down')
  expect(geometry.expansionGeometry.lineHtml.length).toBe(2)
  expect(geometry.expansionGeometry.width).toBeGreaterThanOrEqual(geometry.layout.metrics.width)
  expect(geometry.expansionGeometry.width).toBeLessThanOrEqual(geometry.expansionGeometry.maxWidth)
  expect(geometry.slotSize.width).toBeGreaterThan(0)
  expect(geometry.slotSize.height).toBeGreaterThan(0)
})

test('expansion opens upward when below is the tighter side', async ({ page }) => {
  await mountChipFixture(page, { stageMarginTop: 'calc(100vh - 44px)' })
  const geometry = await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow
    fixtureWindow.__fixtureSession.measureExpansion(document.querySelector<HTMLElement>('#stage'))
    return fixtureWindow.__fixtureSession.snapshot()
  })

  expect(geometry.expansionGeometry.y).toBe('up')
})

test('an overflowing variant label marks its truncation key without box truncation', async ({ page }) => {
  await mountChipFixture(page, {
    title: 'Short',
    variantLabel: 'a-very-long-variant-label-that-cannot-fit-in-forty-pixels',
  })
  const snapshot = await readSnapshot(page)

  expect(snapshot.layout.metrics.titleVariantLabelTruncationKey).toBe('1')
  expect(snapshot.layout.metrics.hasExpandableContent).toBe(true)
})

test('re-attaching to a remounted text element follows the new element', async ({ page }) => {
  await mountChipFixture(page)
  const reattachedWidth = await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow
    const chip = document.querySelector<HTMLElement>('.page-chip')
    const oldText = document.querySelector<HTMLElement>('.chip-text')
    if (!chip || !oldText) throw new Error('missing chip fixture')

    const replacement = oldText.cloneNode(true) as HTMLElement
    oldText.remove()
    chip.append(replacement)
    fixtureWindow.__fixtureSession.syncText(replacement)
    fixtureWindow.__fixtureSession.onCommit()
    fixtureWindow.__fixtureSession.observeText()
    return fixtureWindow.__fixtureSession.snapshot().layout.metrics.width
  })
  expect(reattachedWidth).toBeGreaterThan(0)

  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.domain-block')
    if (!card) throw new Error('missing card')
    card.style.width = '240px'
  })
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as FixtureWindow).__fixtureSession.snapshot().layout.metrics.width
  ))).toBeLessThan(reattachedWidth)
})

test('font settlement invalidates the clamp until the next commit recaptures it', async ({ page }) => {
  await mountChipFixture(page)
  const before = await readSnapshot(page)
  expect(before.layout.clamp).not.toBeNull()

  const invalidated = await page.evaluate(async () => {
    const fixtureWindow = window as unknown as FixtureWindow
    document.fonts.dispatchEvent(new Event('loadingdone'))
    await new Promise((resolveTick) => setTimeout(resolveTick, 0))
    return fixtureWindow.__fixtureSession.snapshot()
  })
  expect(invalidated.layout.clamp).toBeNull()
  expect(invalidated.layout.metrics.isTruncated).toBe(true)

  const recaptured = await page.evaluate(() => {
    const fixtureWindow = window as unknown as FixtureWindow
    fixtureWindow.__fixtureSession.onCommit()
    return fixtureWindow.__fixtureSession.snapshot()
  })
  expect(recaptured.layout.clamp).not.toBeNull()
  expect(recaptured.layout.clamp?.lineHtml.length).toBe(2)
})
