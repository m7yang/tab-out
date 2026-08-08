import { Effect, Schema } from 'effect'

import {
  RETAINED_PAGE_LIFETIME_MS,
  type RetainedPageLedger
} from '../retained-pages-ledger.js'

export const RETAINED_PAGES_EXPIRY_ALARM = 'tab-out:retained-pages-earliest-expiry'

export interface RetainedPagesExpiryAlarmApi {
  create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => Promise<void>
  clear: (name: string) => Promise<boolean>
}

class RetainedPagesExpiryAlarmError extends Schema.TaggedErrorClass<RetainedPagesExpiryAlarmError>()(
  'RetainedPagesExpiryAlarmError',
  {
    operation: Schema.Literals(['create', 'clear']),
    cause: Schema.Defect()
  }
) {}

/**
 * Finds the next visible-page expiry. Removal Boundaries are invisible ledger
 * maintenance and do not keep the page-expiry wake alive on their own.
 */
export function earliestRetainedPageExpiry(ledger: RetainedPageLedger): number | null {
  let earliest: number | null = null
  for (const page of Object.values(ledger.pages)) {
    const expiry = page.closedAt + RETAINED_PAGE_LIFETIME_MS
    if (!Number.isFinite(expiry)) continue
    if (earliest === null || expiry < earliest) earliest = expiry
  }
  return earliest
}

/**
 * Replaces Chrome's one named expiry alarm with the current earliest expiry,
 * or clears it once no visible Retained Page remains. The alarm wake handler
 * owns pruning; this scheduling seam never mutates the ledger.
 */
export const scheduleRetainedPagesExpiryAlarm = Effect.fn(
  'RetainedPages.scheduleExpiryAlarm'
)(function*(
  alarms: RetainedPagesExpiryAlarmApi,
  ledger: RetainedPageLedger
) {
  const when = earliestRetainedPageExpiry(ledger)
  if (when === null) {
    yield* Effect.tryPromise({
      try: () => alarms.clear(RETAINED_PAGES_EXPIRY_ALARM),
      catch: (cause) => RetainedPagesExpiryAlarmError.make({ operation: 'clear', cause })
    })
    return
  }

  yield* Effect.tryPromise({
    try: () => alarms.create(RETAINED_PAGES_EXPIRY_ALARM, { when }),
    catch: (cause) => RetainedPagesExpiryAlarmError.make({ operation: 'create', cause })
  })
})
