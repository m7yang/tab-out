import type { StartupOrderDebugCapture, StartupOrderVmSampleOptions } from './startup-order-debug'

const STARTUP_ORDER_DEBUG_FILTER_KEY = 'tab-out:debug-startup-order-filter'
const STARTUP_ORDER_DEBUG_DURATION_MS = 3000
const STARTUP_ORDER_DEBUG_STEP_MS = 100

type StartupOrderDebugWindow = Window & {
  __tabOutStartupOrderDebug?: StartupOrderDebugCapture
  __tabOutCopyStartupOrderDebug?: () => Promise<string>
  __tabOutSaveStartupOrderDebug?: () => void
}

const initializedCaptures = new WeakSet<StartupOrderDebugCapture>()
let startupOrderDebugFilterRe: RegExp | null = null

function textFromElement(el: Element | null): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim()
}

// Optional case-insensitive RegExp source from localStorage (e.g. a domain or title
// fragment) that focuses the capture on specific cards. Unset or invalid captures every card.
function readStartupOrderDebugFilter(): RegExp | null {
  try {
    const raw = localStorage.getItem(STARTUP_ORDER_DEBUG_FILTER_KEY)
    return raw ? new RegExp(raw, 'i') : null
  } catch {
    return null
  }
}

function matchesDebugTarget(value: unknown): boolean {
  return !startupOrderDebugFilterRe || startupOrderDebugFilterRe.test(JSON.stringify(value))
}

function rectSnapshot(rect?: DOMRectReadOnly) {
  if (!rect) return null
  return {
    bottom: Math.round(rect.bottom),
    height: Math.round(rect.height),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    x: Math.round(rect.x),
    y: Math.round(rect.y)
  }
}

function debugChips(root: Element, blockedSelector = '') {
  const chips = []
  const chipEls = root.querySelectorAll<HTMLElement>('.page-chip')
  for (const [index, chip] of chipEls.entries()) {
    if (blockedSelector && chip.closest(blockedSelector)) continue
    chips.push({
      index,
      text: textFromElement(chip).slice(0, 180),
      top: Math.round(chip.getBoundingClientRect().top)
    })
  }
  return chips
}

function debugPathgroups(root: Element) {
  const pathgroups = []
  const pathgroupEls = root.querySelectorAll<HTMLElement>(':scope > .pathgroup-section')
  for (const [index, pathgroup] of pathgroupEls.entries()) {
    pathgroups.push({
      index,
      label: textFromElement(pathgroup.querySelector('.chip-pathgroup')),
      count: textFromElement(pathgroup.querySelector('.pathgroup-header-count')),
      top: Math.round(pathgroup.getBoundingClientRect().top),
      chips: debugChips(pathgroup)
    })
  }
  return pathgroups
}

function debugWebsitePaths(root: Element) {
  const websitePaths = []
  const websitePathEls = root.querySelectorAll<HTMLElement>(':scope > .website-path-section')
  for (const [index, websitePath] of websitePathEls.entries()) {
    websitePaths.push({
      index,
      label: textFromElement(websitePath.querySelector('.website-path-section-label')),
      count: textFromElement(websitePath.querySelector('.website-path-section-header-count')),
      top: Math.round(websitePath.getBoundingClientRect().top),
      chips: debugChips(websitePath, '.pathgroup-section'),
      pathgroups: debugPathgroups(websitePath)
    })
  }
  return websitePaths
}

function debugDomCards() {
  const cards = []
  const cardEls = document.querySelectorAll<HTMLElement>('[data-tabout="domain-card"]')
  for (const [index, card] of cardEls.entries()) {
    const sections = []
    const sectionEls = card.querySelectorAll<HTMLElement>(':scope .subdomain-section')
    for (const [sectionIndex, section] of sectionEls.entries()) {
      sections.push({
        index: sectionIndex,
        label: textFromElement(section.querySelector('.subdomain-header-name')),
        count: textFromElement(section.querySelector('.subdomain-header-count')),
        top: Math.round(section.getBoundingClientRect().top),
        chips: debugChips(section, '.website-path-section, .pathgroup-section'),
        websitePaths: debugWebsitePaths(section),
        pathgroups: debugPathgroups(section)
      })
    }
    const entry = {
      index,
      domain: card.dataset.taboutDomain || '',
      title: textFromElement(card.querySelector('.domain-title, .domain-header-flow')).slice(0, 180),
      top: Math.round(card.getBoundingClientRect().top),
      sections
    }
    if (matchesDebugTarget(entry)) cards.push(entry)
  }
  return cards
}

function debugHistoryRows() {
  const rows = []
  const rowEls = document.querySelectorAll<HTMLElement>('[data-tabout="activation-history-entry"]')
  for (const [index, row] of rowEls.entries()) {
    const rect = row.getBoundingClientRect()
    rows.push({
      index,
      text: textFromElement(row).slice(0, 180),
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      workingSetExtra: row.dataset.workingSetExtra === 'true'
    })
  }
  return rows
}

function debugChipVm(
  chip: {
    title?: string
    tabUrl?: string
    rawUrl?: string
    sourceType?: string
    pagePinned?: boolean
    pathSuffix?: string
    titleVariantChips?: Array<{ title?: string; tabUrl?: string; rawUrl?: string; sourceType?: string; pagePinned?: boolean; pathSuffix?: string }>
  },
  index: number
) {
  return {
    index,
    text: (chip.title || '').slice(0, 180),
    url: chip.tabUrl || '',
    rawUrl: chip.rawUrl || '',
    sourceType: chip.sourceType || '',
    pagePinned: !!chip.pagePinned,
    pathSuffix: chip.pathSuffix || '',
    variants: (chip.titleVariantChips || []).map((variant, variantIndex) => ({
      index: variantIndex,
      text: (variant.title || '').slice(0, 180),
      url: variant.tabUrl || '',
      rawUrl: variant.rawUrl || '',
      sourceType: variant.sourceType || '',
      pagePinned: !!variant.pagePinned,
      pathSuffix: variant.pathSuffix || ''
    }))
  }
}

function debugVmCards(cards: StartupOrderVmSampleOptions['matchedCards']) {
  const debugCards = []
  for (const [index, { group, vm }] of cards.entries()) {
    const sections = []
    for (const [sectionIndex, section] of (vm.sections || []).entries()) {
      const websitePaths = []
      for (const [websitePathIndex, websitePath] of section.websitePathSections.entries()) {
        const pathgroups = []
        for (const [clusterIndex, cluster] of websitePath.clusters.entries()) {
          pathgroups.push({
            index: clusterIndex,
            key: cluster.key,
            label: cluster.label,
            count: cluster.count,
            chips: cluster.visibleChips.map(debugChipVm),
            hiddenChips: cluster.hiddenChips.map(debugChipVm)
          })
        }
        websitePaths.push({
          index: websitePathIndex,
          key: websitePath.key,
          label: websitePath.label,
          count: websitePath.sectionCount,
          chips: websitePath.flatVisibleChips.map(debugChipVm),
          hiddenChips: websitePath.flatHiddenChips.map(debugChipVm),
          pathgroups
        })
      }
      const pathgroups = []
      for (const [clusterIndex, cluster] of section.clusters.entries()) {
        pathgroups.push({
          index: clusterIndex,
          key: cluster.key,
          label: cluster.label,
          count: cluster.count,
          chips: cluster.visibleChips.map(debugChipVm),
          hiddenChips: cluster.hiddenChips.map(debugChipVm)
        })
      }
      sections.push({
        index: sectionIndex,
        key: section.key,
        count: section.sectionCount,
        chips: section.flatVisibleChips.map(debugChipVm),
        hiddenChips: section.flatHiddenChips.map(debugChipVm),
        websitePaths,
        pathgroups
      })
    }
    const entry = {
      index,
      domain: group.domain,
      title: (vm.displayName || group.label || group.domain).slice(0, 180),
      sections
    }
    if (matchesDebugTarget(entry)) debugCards.push(entry)
  }
  return debugCards
}

export function initializeStartupOrderDebug(capture: StartupOrderDebugCapture): void {
  if (initializedCaptures.has(capture)) return
  initializedCaptures.add(capture)
  startupOrderDebugFilterRe = readStartupOrderDebugFilter()

  const debugWindow = window as StartupOrderDebugWindow
  debugWindow.__tabOutCopyStartupOrderDebug = async () => {
    const json = JSON.stringify(capture, null, 2)
    try {
      await navigator.clipboard.writeText(json)
      console.log('Copied Tab Out startup order debug JSON to clipboard.')
    } catch {
      console.log(json)
    }
    return json
  }
  debugWindow.__tabOutSaveStartupOrderDebug = () => {
    const blob = new Blob([JSON.stringify(capture, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `tab-out-startup-order-${Date.now()}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const layoutShift = entry as PerformanceEntry & {
        hadRecentInput?: boolean
        sources?: Array<{ node?: Element; previousRect?: DOMRectReadOnly; currentRect?: DOMRectReadOnly }>
        value?: number
      }
      if (layoutShift.hadRecentInput) continue
      capture.shifts.push({
        t: Math.round(entry.startTime),
        value: layoutShift.value,
        sources: (layoutShift.sources || []).map((source) => ({
          node: source.node ? textFromElement(source.node).slice(0, 180) : '',
          previous: rectSnapshot(source.previousRect),
          current: rectSnapshot(source.currentRect)
        }))
      })
    }
  }).observe({ type: 'layout-shift', buffered: true })

  window.setTimeout(() => {
    debugWindow.__tabOutSaveStartupOrderDebug?.()
  }, STARTUP_ORDER_DEBUG_DURATION_MS + 100)
}

export function recordStartupOrderDebugVmSample(capture: StartupOrderDebugCapture, options: StartupOrderVmSampleOptions): void {
  capture.samples.push({
    kind: 'vm',
    t: Math.round(performance.now()),
    source: options.source,
    filter: options.filter,
    ready: options.isReady,
    tabCount: options.dashboard?.realTabs.length ?? 0,
    workingSetCount: options.workingSet?.items.length ?? 0,
    cards: debugVmCards(options.matchedCards)
  })
}

export function startStartupOrderDebugDomSampling(capture: StartupOrderDebugCapture): () => void {
  const startedAt = performance.now()
  function sampleDom() {
    capture.samples.push({
      kind: 'dom',
      t: Math.round(performance.now()),
      cards: debugDomCards(),
      historyRows: debugHistoryRows()
    })
  }
  sampleDom()
  const intervalId = window.setInterval(() => {
    sampleDom()
    if (performance.now() - startedAt >= STARTUP_ORDER_DEBUG_DURATION_MS) window.clearInterval(intervalId)
  }, STARTUP_ORDER_DEBUG_STEP_MS)
  return () => window.clearInterval(intervalId)
}
