/* ================================================================
   Group page-chip close targets — pure helpers that decide which
   URLs a "close all" on a group chip should act on, and how the
   close action is labelled.

   Pure and dependency-light (like tab-activation.ts) so it is
   unit-testable without React, the DOM, or a real chrome.tabs.
   ================================================================ */

import type { DashboardChipData, DashboardChipEnv } from '../extension/types'
import { isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'

export type CloseTargetVariant = {
  sourceType?: DashboardChipData['sourceType']
  saved?: boolean
  closedSaved?: boolean
  tabUrl: string
  rawUrl: string
}
export type CloseTargetSavedState = Pick<DashboardChipData | DashboardChipEnv, 'sourceType' | 'saved' | 'closedSaved'>

export interface VariantCloseTargets {
  historyUrls: string[]
  tabEnvs: DashboardChipEnv[]
}

type TabCloseCompletion = {
  ok: boolean
  shouldAnimateRemoval: boolean
}

type HistoryDeleteCompletion = {
  deletedCount: number
}

/**
 * variantClosable(v) — mirrors PageChip's per-variant `variantCanClose`:
 * saved pages and closed-saved tabs can't be closed, and read-only sources
 * can't either UNLESS they are history (which is "closable" via delete).
 */
export function variantClosable(v: CloseTargetVariant): boolean {
  const closedSaved = v.sourceType === 'saved-page' || !!v.closedSaved
  const isHistory = v.sourceType === 'history'
  return !closedSaved && (!isReadOnlyDashboardSourceType(v.sourceType) || isHistory)
}

export function closeTargetLeavesSavedPage(v: CloseTargetSavedState): boolean {
  return !!v.saved && (v.sourceType ?? 'tab') === 'tab' && !v.closedSaved
}

/**
 * partitionVariantCloseTargets(variants) — keep only the closable variants,
 * then split them: history entries (deleted via deleteHistoryUrls) vs. open
 * tabs (closed via closeChipTarget's folded `envs` path).
 */
export function partitionVariantCloseTargets(variants: readonly CloseTargetVariant[]): VariantCloseTargets {
  const closable = variants.filter(variantClosable)
  const historyUrls = closable
    .filter((v) => v.sourceType === 'history')
    .map((v) => v.tabUrl)
    .filter(Boolean)
  const tabEnvs = closable
    .filter((v) => v.sourceType !== 'history')
    .map((v) => ({ prefix: '', tabUrl: v.tabUrl, rawUrl: v.rawUrl }))
  return { historyUrls, tabEnvs }
}

export function foldedTabCloseTargets(
  envs: readonly DashboardChipEnv[]
): DashboardChipEnv[] {
  return envs.filter((env) => variantClosable(env))
}

export function historyDeleteFullyRemoved(
  requestedCount: number,
  result: HistoryDeleteCompletion | null
): boolean {
  return requestedCount === 0 || result?.deletedCount === requestedCount
}

export function titleVariantGroupRemovalConfirmed({
  requestedTabCount,
  tabResult,
  requestedHistoryCount,
  historyResult
}: {
  requestedTabCount: number
  tabResult: TabCloseCompletion | null
  requestedHistoryCount: number
  historyResult: HistoryDeleteCompletion | null
}): boolean {
  const tabsRemoved = requestedTabCount === 0 || !!tabResult?.ok && tabResult.shouldAnimateRemoval
  return tabsRemoved && historyDeleteFullyRemoved(requestedHistoryCount, historyResult)
}

/**
 * groupCloseActionLabel({ count, allHistory }) — count-aware aria-label.
 * count === 1 reproduces the single-chip wording exactly (no regression).
 */
export function groupCloseActionLabel({ count, allHistory }: { count: number; allHistory: boolean }): string {
  if (allHistory) return count > 1 ? `Delete ${count} from history` : 'Delete from history'
  return count > 1 ? `Close ${count} tabs` : 'Close this tab'
}
