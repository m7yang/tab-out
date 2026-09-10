// Page functions for the page-chip context-menu smoke scenario. Each runs in
// the page realm through evaluateInPage: only page globals plus the params
// argument are in scope, so nothing here may close over module values.

type FocusUpdate = { kind: 'tab' | 'window', args: unknown[] }

type SmokeWindow = Window & {
  __tabOutSmokeSavedStore: Record<string, unknown>
  __tabOutSmokeSavedSets: Array<Record<string, unknown>>
  __tabOutSmokeCopiedText: string | null
  __tabOutSmokeFocusUpdates: FocusUpdate[]
  __tabOutSmokeOriginalTabsUpdate: typeof chrome.tabs.update
  __tabOutSmokeOriginalWindowsUpdate: typeof chrome.windows.update
}

type MutableChromeApi = {
  update: (...args: unknown[]) => Promise<unknown>
}

type MutableStorageArea = {
  get: () => Promise<unknown>
  set: (next: Record<string, unknown>) => Promise<void>
}

export type PageChipTarget = { label: string, x: number, y: number }

export function installSmokeChromeStubs(): void {
  const smokeWindow = window as unknown as SmokeWindow
  document.querySelector('.scroll-region')?.scrollTo(0, 0)
  smokeWindow.__tabOutSmokeSavedStore = {}
  smokeWindow.__tabOutSmokeSavedSets = []
  smokeWindow.__tabOutSmokeCopiedText = null
  smokeWindow.__tabOutSmokeFocusUpdates = []
  smokeWindow.__tabOutSmokeOriginalTabsUpdate = chrome.tabs.update
  smokeWindow.__tabOutSmokeOriginalWindowsUpdate = chrome.windows.update
  const storage = chrome.storage.local as unknown as MutableStorageArea
  storage.get = async () => smokeWindow.__tabOutSmokeSavedStore
  storage.set = async (next) => {
    smokeWindow.__tabOutSmokeSavedStore = { ...smokeWindow.__tabOutSmokeSavedStore, ...next }
    smokeWindow.__tabOutSmokeSavedSets.push(next)
  }
  const tabs = chrome.tabs as unknown as MutableChromeApi
  const windows = chrome.windows as unknown as MutableChromeApi
  const originalTabsUpdate = smokeWindow.__tabOutSmokeOriginalTabsUpdate as unknown as MutableChromeApi['update']
  const originalWindowsUpdate = smokeWindow.__tabOutSmokeOriginalWindowsUpdate as unknown as MutableChromeApi['update']
  tabs.update = async (...args) => {
    smokeWindow.__tabOutSmokeFocusUpdates.push({ kind: 'tab', args })
    return originalTabsUpdate(...args)
  }
  windows.update = async (...args) => {
    smokeWindow.__tabOutSmokeFocusUpdates.push({ kind: 'window', args })
    return originalWindowsUpdate(...args)
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        smokeWindow.__tabOutSmokeCopiedText = text
      },
    },
  })
}

export function findPageChipTarget(params: { label: string, xOffset: number }): Promise<PageChipTarget | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes(params.label))
      const rect = chip?.getBoundingClientRect()
      if (rect && rect.width > 120 && rect.height > 8) {
        resolve({
          label: params.label,
          x: Math.round(rect.left + Math.min(params.xOffset, rect.width - 8)),
          y: Math.round(rect.top + rect.height / 2),
        })
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function findPageChipFaviconTarget(params: { label: string }): Promise<PageChipTarget | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const poll = () => {
      const chip = Array.from(document.querySelectorAll('.page-chip'))
        .find((candidate) => candidate.textContent?.includes(params.label))
      const faviconFrame = chip?.querySelector('.chip-favicon-frame')
      const rect = faviconFrame?.getBoundingClientRect()
      if (rect && rect.width > 4 && rect.height > 4) {
        resolve({
          label: params.label,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        })
      } else if (Date.now() - start > 5000) {
        resolve(null)
      } else {
        setTimeout(poll, 50)
      }
    }
    poll()
  })
}

export function readContextMenuState() {
  const visibleMenus = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="context-menu-content"]'))
    .filter((menu) => !menu.hidden && menu.getClientRects().length > 0 && window.getComputedStyle(menu).visibility !== 'hidden')
  const menuStates = visibleMenus.map((menu) => {
    const menuRect = menu.getBoundingClientRect()
    const directChildren = Array.from(menu.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.slot)
    return {
      sequence: directChildren.map((child) => (
        child.dataset.slot === 'context-menu-separator'
          ? 'separator'
          : child.textContent?.trim() || ''
      )),
      separatorInsets: directChildren
        .filter((child) => child.dataset.slot === 'context-menu-separator')
        .map((separator) => {
          const rect = separator.getBoundingClientRect()
          return {
            left: rect.left - menuRect.left,
            right: menuRect.right - rect.right,
          }
        }),
    }
  })
  return {
    visibleMenuCount: visibleMenus.length,
    itemTexts: visibleMenus.flatMap((menu) => (
      Array.from(menu.querySelectorAll('[data-slot="context-menu-item"]'))
        .map((item) => item.textContent?.trim() || '')
    )),
    sequence: menuStates.flatMap((state) => state.sequence),
    separatorInsets: menuStates.flatMap((state) => state.separatorInsets),
    backdropCount: document.querySelectorAll('[data-slot="context-menu-backdrop"]:not([hidden])').length,
  }
}

export function readPageChipVisualState(params: { label: string }) {
  const chip = Array.from(document.querySelectorAll('.page-chip'))
    .find((candidate) => candidate.textContent?.includes(params.label))
  if (!(chip instanceof HTMLElement)) return null
  const styles = window.getComputedStyle(chip)
  const readPart = (part: Element | null) => {
    if (!(part instanceof HTMLElement)) return null
    const partStyles = window.getComputedStyle(part)
    return {
      opacity: partStyles.opacity,
      pointerEvents: partStyles.pointerEvents,
    }
  }
  const expandedFill = chip.querySelector('.page-chip-expanded-fill')
  return {
    backgroundColor: styles.backgroundColor,
    className: chip.className,
    contextMenuOpen: chip.classList.contains('page-chip-context-menu-open'),
    expanded: chip.classList.contains('page-chip-expanded'),
    tooltipOpen: chip.classList.contains('page-chip-tooltip-open'),
    transitionProperty: styles.transitionProperty,
    width: Math.round(chip.getBoundingClientRect().width),
    closeButton: readPart(chip.querySelector('.chip-close-favicon')),
    duplicateStack: readPart(chip.querySelector('.chip-favicon-stack')),
    expandedFill: expandedFill instanceof HTMLElement
      ? {
          backgroundColor: window.getComputedStyle(expandedFill).backgroundColor,
          opacity: window.getComputedStyle(expandedFill).opacity,
        }
      : null,
    faviconContent: readPart(chip.querySelector('.chip-favicon-content')),
    hover: chip.matches(':hover'),
    urlPreview: document.querySelector('.url-preview span')?.textContent || '',
  }
}

export function findContextMenuItem(params: { label: string }) {
  const item = Array.from(document.querySelectorAll('[data-slot="context-menu-item"]'))
    .find((candidate) => candidate.textContent?.trim() === params.label)
  if (!item) return null
  const rect = item.getBoundingClientRect()
  return {
    text: item.textContent?.trim() || '',
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  }
}

export function countVisibleTooltips(): number {
  return Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).filter((tooltip) => {
    const rect = tooltip.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && !tooltip.hasAttribute('data-ending-style')
  }).length
}

// Mounts a synthetic tooltip surface under the open menu's backdrop so a click
// there proves the backdrop shields tooltips from focusing pages.
export function installTooltipShield(): { x: number, y: number } {
  document.querySelector('[data-smoke-tooltip-shield]')?.remove()
  const syntheticTooltip = document.createElement('div')
  syntheticTooltip.dataset.slot = 'tooltip-content'
  syntheticTooltip.dataset.smokeTooltipShield = 'true'
  syntheticTooltip.textContent = 'Synthetic tooltip shield target'
  syntheticTooltip.style.cssText = [
    'position:fixed',
    'left:24px',
    'top:24px',
    'width:220px',
    'height:32px',
    'z-index:50',
    'pointer-events:auto',
    'background:canvas',
    'color:canvastext',
  ].join(';')
  syntheticTooltip.addEventListener('click', () => {
    void chrome.tabs.update(1, { active: true })
  })
  document.body.append(syntheticTooltip)
  const rect = syntheticTooltip.getBoundingClientRect()
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  }
}

export function readTooltipShieldTarget(params: { point: { x: number, y: number } }) {
  const smokeWindow = window as unknown as SmokeWindow
  smokeWindow.__tabOutSmokeFocusUpdates = []
  const target = document.elementFromPoint(params.point.x, params.point.y)
  const owner = target?.closest('[data-slot]')
  return {
    point: params.point,
    topSlot: owner?.getAttribute('data-slot') || '',
    topText: owner?.textContent?.trim() || '',
    menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])'),
    tooltipOpen: !!document.querySelector('[data-slot="tooltip-content"]:not([hidden])'),
  }
}

export function restoreFocusUpdateStubs() {
  const smokeWindow = window as unknown as SmokeWindow
  const focusUpdates = smokeWindow.__tabOutSmokeFocusUpdates || []
  chrome.tabs.update = smokeWindow.__tabOutSmokeOriginalTabsUpdate
  chrome.windows.update = smokeWindow.__tabOutSmokeOriginalWindowsUpdate
  document.querySelector('[data-smoke-tooltip-shield]')?.remove()
  return {
    focusUpdateCount: focusUpdates.length,
    menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])'),
  }
}

export function readCopyResult() {
  const smokeWindow = window as unknown as SmokeWindow
  return {
    copiedText: smokeWindow.__tabOutSmokeCopiedText,
    menuOpen: !!document.querySelector('[data-slot="context-menu-content"]'),
  }
}

export function readSaveResult(params: { itemText: string }) {
  const smokeWindow = window as unknown as SmokeWindow
  const store = smokeWindow.__tabOutSmokeSavedStore?.tabOutSavedPagesV1 as { pages?: Record<string, unknown> } | undefined
  const pageKeys = store?.pages ? Object.keys(store.pages) : []
  return {
    itemText: params.itemText,
    menuOpen: !!document.querySelector('[data-slot="context-menu-content"]'),
    pageKeys,
    setCount: smokeWindow.__tabOutSmokeSavedSets?.length || 0,
  }
}

export function findSourceSwitchButton(params: { label: string }) {
  const button = Array.from(document.querySelectorAll('.source-switch-option'))
    .find((candidate) => candidate.textContent?.trim() === params.label)
  const activeBefore = document.querySelector('.source-switch-option[data-active]')?.textContent?.trim() || ''
  if (!button) return null
  const rect = button.getBoundingClientRect()
  return {
    activeBefore,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  }
}

export function readOutsideClickResult(params: { activeBefore: string }) {
  return {
    activeBefore: params.activeBefore,
    activeAfter: document.querySelector('.source-switch-option[data-active]')?.textContent?.trim() || '',
    menuOpen: !!document.querySelector('[data-slot="context-menu-content"]:not([hidden])'),
  }
}

// Floating UI marks a trigger press as inside its tree and clears the mark on
// a zero-delay timer; an outside press that arrives before that timer runs is
// ignored. Yielding one macrotask after a menu opens lets a dismissal issued
// immediately afterwards be honored, which only automation is fast enough to
// need.
export function settleMenuOpen(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
