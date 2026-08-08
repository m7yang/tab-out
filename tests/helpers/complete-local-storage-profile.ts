import { CLOSED_GHOST_DISMISSAL_STORAGE_KEY } from '../../src/extension/closed-ghost-dismissals.js'
import { domainCardId } from '../../src/extension/domain-card-id.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../../src/extension/domain-pins.js'
import { HISTORY_RANGE_STORAGE_KEY } from '../../src/extension/history-range-storage.js'
import {
  PAGE_CHIP_PIN_STORAGE_KEY,
  pageChipPinId,
  pageChipPinKeyForUrl,
  pageChipPinScopeId
} from '../../src/extension/page-chip-pins.js'
import { SAVED_PAGES_STORAGE_KEY, savedPageKeyForUrl } from '../../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY, pathgroupPinId } from '../../src/extension/section-pins.js'
import {
  DASHBOARD_STARTUP_SEED_CACHE_KEY
} from '../../src/extension/startup-snapshot.js'
import { SUSPEND_TARGET_STORAGE_KEY } from '../../src/extension/suspension.js'
import { pageIdentityForWorkingSet } from '../../src/extension/working-set.js'
import { TAB_HISTORY_STORAGE_KEY } from '../../src/extension/background/tab-history-service.js'
import { WORKING_SET_ACTIVITY_KEY } from '../../src/extension/background/working-set-service.js'

export const COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_VERSION =
  'complete-representative-local-v1'

export const COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS = {
  closedGhostDismissals: 500,
  globalHistoryEntries: 40,
  globalHistoryPendingEntries: 8,
  pinnedDomains: 500,
  pinnedPageChips: 1_000,
  pinnedSections: 1_000,
  savedPages: 500,
  startupCardOrder: 500,
  startupWorkingSetPriority: 500,
  workingSetEventsPerRecord: 20,
  workingSetRecords: 500
} as const

export const COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS = [
  CLOSED_GHOST_DISMISSAL_STORAGE_KEY,
  DASHBOARD_STARTUP_SEED_CACHE_KEY,
  DOMAIN_PIN_STORAGE_KEY,
  HISTORY_RANGE_STORAGE_KEY,
  PAGE_CHIP_PIN_STORAGE_KEY,
  SAVED_PAGES_STORAGE_KEY,
  SECTION_PIN_STORAGE_KEY,
  SUSPEND_TARGET_STORAGE_KEY,
  TAB_HISTORY_STORAGE_KEY,
  WORKING_SET_ACTIVITY_KEY
] as const

// Retained-state changes intentionally rebuild the warm Startup Seed, and its
// five-minute durable checkpoint may replace the seeded local value while a
// long benchmark is running. The benchmark controller's real navigations also
// update global Tab History. Every other fixture key must remain byte-for-byte
// stable after the benchmark seed barrier.
export const COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS = [
  DASHBOARD_STARTUP_SEED_CACHE_KEY,
  TAB_HISTORY_STORAGE_KEY
] as const

const liveMutableProfileKeySet = new Set<string>(
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS
)

export const COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_STABLE_KEYS =
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS.filter(
    (key) => !liveMutableProfileKeySet.has(key)
  )

function exactLengthUrl(prefix: string, length: number): string {
  if (prefix.length > length) {
    throw new Error(`Fixture URL prefix exceeds requested length ${length}`)
  }
  return `${prefix}${'x'.repeat(length - prefix.length)}`
}

function fixedTitle(prefix: string, length: number): string {
  if (prefix.length > length) {
    throw new Error(`Fixture title prefix exceeds requested length ${length}`)
  }
  return `${prefix}${'t'.repeat(length - prefix.length)}`
}

function indexedLabel(index: number, width = 4): string {
  return String(index).padStart(width, '0')
}

function savedPagesFixture(now: number): Record<string, unknown> {
  const pages: Record<string, unknown> = {}
  for (
    let index = 0;
    index < COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.savedPages;
    index += 1
  ) {
    const label = indexedLabel(index)
    const url = exactLengthUrl(
      `https://saved-${label}.example.test/page?fixture=`,
      256
    )
    const surfaceKind = index < 450 ? 'normal-tab' : 'app'
    const key = savedPageKeyForUrl(url, surfaceKind)
    pages[key] = {
      key,
      surfaceKind,
      url,
      title: fixedTitle(`Saved ${label} `, 80),
      favIconUrl: exactLengthUrl(
        `https://assets.example.test/saved-${label}?fixture=`,
        256
      ),
      savedAt: now - index,
      updatedAt: now - index,
      lastSeenOpenAt: now - index
    }
  }
  return { version: 2, pages }
}

function workingSetFixture(now: number): Record<string, unknown> {
  const records: Record<string, unknown> = {}
  for (
    let index = 0;
    index < COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.workingSetRecords;
    index += 1
  ) {
    const label = indexedLabel(index)
    const url = exactLengthUrl(
      `https://working-${label}.example.test/page?fixture=`,
      256
    )
    const key = pageIdentityForWorkingSet(url)
    const events = Array.from({
      length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.workingSetEventsPerRecord
    }, (_, eventIndex) => ({
      kind: eventIndex % 2 === 0 ? 'activation' : 'navigation',
      at: now - index - eventIndex
    }))
    records[key] = {
      key,
      url,
      title: fixedTitle(`Working ${label} `, 80),
      domain: `working-${label}.example.test`,
      lastSeenAt: now - index,
      lastActivatedAt: now - index,
      lastNavigatedAt: now - index - 1,
      events
    }
  }
  return { version: 1, records }
}

function globalHistoryFixture(now: number): Record<string, unknown> {
  const historyEntry = (index: number) => ({
    windowId: Math.floor(index / 12) + 1,
    tabId: index + 1,
    url: exactLengthUrl(
      `https://history-${indexedLabel(index)}.example.test/page?fixture=`,
      2_048
    )
  })
  return {
    version: 2,
    stack: Array.from(
      { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.globalHistoryEntries },
      (_, index) => historyEntry(index)
    ),
    index: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.globalHistoryEntries - 1,
    pending: Array.from(
      { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.globalHistoryPendingEntries },
      (_, index) => ({
        ...historyEntry(
          COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.globalHistoryEntries + index
        ),
        createdAt: now - index
      })
    )
  }
}

function dashboardStartupSeedFixture(now: number): Record<string, unknown> {
  return {
    schemaVersion: 2,
    savedAt: now,
    captureStartedAt: now,
    cardOrder: Array.from(
      { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.startupCardOrder },
      (_, index) => domainCardId(`startup-${indexedLabel(index)}.example.test`)
    ),
    workingSetPriority: {
      epoch: now,
      keys: Array.from(
        {
          length:
            COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.startupWorkingSetPriority
        },
        (_, index) => exactLengthUrl(
          `https://priority-${indexedLabel(index)}.example.test/page?fixture=`,
          256
        )
      )
    }
  }
}

function pinnedDomainsFixture(): string[] {
  return Array.from(
    { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.pinnedDomains },
    (_, index) => `pinned-${indexedLabel(index)}.example.test`
  )
}

function pinnedSectionsFixture(): string[] {
  return Array.from(
    { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.pinnedSections },
    (_, index) => pathgroupPinId(
      `section-${indexedLabel(index)}.example.test`,
      'www',
      'docs',
      `group-${indexedLabel(index)}`
    )
  )
}

function pinnedPageChipsFixture(): string[] {
  return Array.from(
    { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.pinnedPageChips },
    (_, index) => {
      const label = indexedLabel(index)
      const domain = `chip-${label}.example.test`
      const url = exactLengthUrl(
        `https://${domain}/page?fixture=`,
        256
      )
      return pageChipPinId(
        'tabs',
        pageChipPinScopeId(domain, 'www', 'docs', `group-${label}`),
        pageChipPinKeyForUrl(url)
      )
    }
  )
}

function closedGhostDismissalsFixture(now: number): Record<string, number> {
  return Object.fromEntries(Array.from(
    { length: COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.closedGhostDismissals },
    (_, index) => [
      exactLengthUrl(
        `https://dismissed-${indexedLabel(index)}.example.test/page?fixture=`,
        256
      ),
      now - index
    ]
  ))
}

function suspendTargetFixture(now: number): Record<string, unknown> {
  const id = 'a'.repeat(32)
  const prefix = `chrome-extension://${id}/suspended.html#ttl=Example&uri=`
  return {
    id,
    template: exactLengthUrl(prefix, 2_048),
    observedAt: now
  }
}

export function buildCompleteRepresentativeLocalProfileV1(
  now = Date.now()
): Record<string, unknown> {
  return {
    [CLOSED_GHOST_DISMISSAL_STORAGE_KEY]: closedGhostDismissalsFixture(now),
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: dashboardStartupSeedFixture(now),
    [DOMAIN_PIN_STORAGE_KEY]: pinnedDomainsFixture(),
    [HISTORY_RANGE_STORAGE_KEY]: 'all',
    [PAGE_CHIP_PIN_STORAGE_KEY]: pinnedPageChipsFixture(),
    [SAVED_PAGES_STORAGE_KEY]: savedPagesFixture(now),
    [SECTION_PIN_STORAGE_KEY]: pinnedSectionsFixture(),
    [SUSPEND_TARGET_STORAGE_KEY]: suspendTargetFixture(now),
    [TAB_HISTORY_STORAGE_KEY]: globalHistoryFixture(now),
    [WORKING_SET_ACTIVITY_KEY]: workingSetFixture(now)
  }
}
