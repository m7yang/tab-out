import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeClosedGhostDismissals } from '../src/extension/closed-ghost-dismissals.js'
import { normalizePinnedDomains } from '../src/extension/domain-pins.js'
import { normalizePinnedPageChips } from '../src/extension/page-chip-pins.js'
import { parseSavedPagesStoreValue } from '../src/extension/saved-pages-storage.js'
import { normalizePinnedSections } from '../src/extension/section-pins.js'
import { parseDashboardStartupSeedBoundary } from '../src/extension/startup-snapshot-schema.js'
import { normalizeWorkingSetActivity } from '../src/extension/working-set.js'
import {
  buildCompleteRepresentativeLocalProfileV1,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS,
  COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_STABLE_KEYS
} from './helpers/complete-local-storage-profile.js'
import { CLOSED_GHOST_DISMISSAL_STORAGE_KEY } from '../src/extension/closed-ghost-dismissals.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { HISTORY_RANGE_STORAGE_KEY } from '../src/extension/history-range-storage.js'
import { PAGE_CHIP_PIN_STORAGE_KEY } from '../src/extension/page-chip-pins.js'
import { SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY } from '../src/extension/section-pins.js'
import { DASHBOARD_STARTUP_SEED_CACHE_KEY } from '../src/extension/startup-snapshot.js'
import {
  createSuspendTargetStore,
  SUSPEND_TARGET_STORAGE_KEY
} from '../src/extension/suspension.js'
import { WORKING_SET_ACTIVITY_KEY } from '../src/extension/background/working-set-service.js'
import {
  canonicalizeGlobalHistory
} from '../src/extension/background/tab-history-state.js'
import { TAB_HISTORY_STORAGE_KEY } from '../src/extension/background/tab-history-service.js'

const now = 1_800_000_000_000

test('complete representative local profile v1 is deterministic and covers every named steady-state key', () => {
  const first = buildCompleteRepresentativeLocalProfileV1(now)
  const second = buildCompleteRepresentativeLocalProfileV1(now)

  assert.deepEqual(first, second)
  assert.deepEqual(
    Object.keys(first).toSorted(),
    [...COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS].toSorted()
  )
  assert.deepEqual(
    [
      ...COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS,
      ...COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_STABLE_KEYS
    ].toSorted(),
    [...COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_KEYS].toSorted()
  )
  assert.deepEqual(
    [...COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_LIVE_MUTABLE_KEYS].toSorted(),
    [DASHBOARD_STARTUP_SEED_CACHE_KEY, TAB_HISTORY_STORAGE_KEY].toSorted()
  )
})

test('complete representative local profile v1 round-trips through current normalizers', async () => {
  const profile = buildCompleteRepresentativeLocalProfileV1(now)
  const savedPages = parseSavedPagesStoreValue(profile[SAVED_PAGES_STORAGE_KEY])
  assert.equal(savedPages.ok, true)
  assert.equal(
    Object.keys(savedPages.value.pages).length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.savedPages
  )
  assert.equal(
    normalizePinnedDomains(profile[DOMAIN_PIN_STORAGE_KEY]).length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.pinnedDomains
  )
  assert.equal(
    normalizePinnedSections(profile[SECTION_PIN_STORAGE_KEY]).length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.pinnedSections
  )
  assert.equal(
    normalizePinnedPageChips(profile[PAGE_CHIP_PIN_STORAGE_KEY]).length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.pinnedPageChips
  )
  assert.equal(
    normalizeClosedGhostDismissals(
      profile[CLOSED_GHOST_DISMISSAL_STORAGE_KEY],
      now
    ).size,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.closedGhostDismissals
  )
  assert.equal(
    Object.keys(
      normalizeWorkingSetActivity(profile[WORKING_SET_ACTIVITY_KEY], now).records
    ).length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.workingSetRecords
  )

  const startupSeed = parseDashboardStartupSeedBoundary(
    profile[DASHBOARD_STARTUP_SEED_CACHE_KEY]
  )
  assert.equal(
    startupSeed?.cardOrder.length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.startupCardOrder
  )
  assert.equal(
    startupSeed?.workingSetPriority.keys.length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.startupWorkingSetPriority
  )

  const storedHistory = profile[TAB_HISTORY_STORAGE_KEY] as Parameters<
    typeof canonicalizeGlobalHistory
  >[0]
  const canonicalHistory = canonicalizeGlobalHistory(storedHistory)
  assert.equal(canonicalHistory.changed, false)
  assert.equal(
    canonicalHistory.history.stack.length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.globalHistoryEntries
  )
  assert.equal(
    canonicalHistory.history.pending.length,
    COMPLETE_REPRESENTATIVE_LOCAL_PROFILE_COUNTS.globalHistoryPendingEntries
  )

  assert.equal(profile[HISTORY_RANGE_STORAGE_KEY], 'all')
  const suspendTarget = await createSuspendTargetStore({
    now: () => now,
    read: async () => profile[SUSPEND_TARGET_STORAGE_KEY],
    runExclusive: (task) => task(),
    write: async () => undefined
  }).get()
  assert.equal(suspendTarget?.id, 'a'.repeat(32))
  assert.equal(suspendTarget?.template.length, 2_048)
})
