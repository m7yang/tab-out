import { omitUndefined } from '../lib/omit-undefined.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { filterResultCandidateForTarget } from './filter-result-navigation.js'
import {
  groupCloseActionLabel,
  pageChipCloseLeavesSavedPage,
  pageChipTargetActionPolicy,
  pageChipTargetClosable,
} from './page-chip-target-policy.js'
import { pageTargetMatchesHover, pageTargetMatchUrls } from './page-target.js'
import { buildUrlVariantPresentationGroups } from './url-variant-presentation.js'
import type {
  DashboardChipData,
  DashboardChipEnv,
  SameTitlePageChipOrderEntry,
  SameTitlePageChipPlan,
  SameTitlePageChipRemovalView,
  SameTitlePageChipRowId,
  SameTitlePageChipRowView,
  SameTitlePageChipView,
} from './types.js'

type SameTitlePageChipCompileFailure = {
  ok: false
  reason: 'fewer-than-two-targets' | 'missing-exact-url' | 'single-exact-url'
}

export type SameTitlePageChipCompileResult =
  | { ok: true, plan: SameTitlePageChipPlan }
  | SameTitlePageChipCompileFailure

type CompiledRemovalPlan = SameTitlePageChipRemovalView & {
  leavesSavedPage: boolean
  targetIndexes: readonly number[]
}

type CompiledRow = {
  id: SameTitlePageChipRowId
  previewMatchUrls: readonly string[]
  removal: CompiledRemovalPlan | null
  targetIndexes: readonly number[]
}

type CompiledPlan = SameTitlePageChipPlan & {
  compiled: {
    groupRemoval: CompiledRemovalPlan | null
    rows: readonly CompiledRow[]
    targets: readonly DashboardChipData[]
  }
}

type SameTitlePageChipAction =
  | 'close'
  | 'duplicate'
  | 'reload'
  | 'remove-retained'
  | 'toggle-pin'
  | 'toggle-saved'

export type SameTitlePageChipIntent =
  | { kind: 'activate', rowId?: SameTitlePageChipRowId }
  | { kind: 'action', action: SameTitlePageChipAction, rowId?: SameTitlePageChipRowId }
  | { kind: 'debug-targets' }
  | { kind: 'hover-match', matchUrls: readonly string[], url: string }
  | { kind: 'preview', rowId?: SameTitlePageChipRowId }

export type SameTitlePageChipRemovalDecision = {
  historyUrls: readonly string[]
  kind: 'remove'
  leavesSavedPage: boolean
  tabClose:
    | null
    | { kind: 'single', target: DashboardChipData }
    | { envs: readonly DashboardChipEnv[], kind: 'many', representativeUrl: string }
}

type SameTitlePageChipDebugTarget = {
  label: string
  rowId: SameTitlePageChipRowId
  target: DashboardChipData
}

export type SameTitlePageChipDecision =
  | { kind: 'activate', target: DashboardChipData }
  | { action: Exclude<SameTitlePageChipAction, 'close' | 'toggle-pin'>, kind: 'target-action', target: DashboardChipData }
  | { exactTargets: readonly SameTitlePageChipDebugTarget[], kind: 'debug-targets' }
  | { kind: 'hover-match', rowMatches: readonly boolean[] }
  | { kind: 'preview', matchUrls: readonly string[], tabId?: number, url: string }
  | SameTitlePageChipRemovalDecision
  | { kind: 'toggle-pin', pagePinId: string }
  | { kind: 'unavailable', reason: 'stale-row' | 'unsupported-action' }

function removalPlan(
  targets: readonly DashboardChipData[],
  targetIndexes: readonly number[],
): CompiledRemovalPlan | null {
  const closableTargetIndexes = targetIndexes.filter((targetIndex) => {
    const target = targets[targetIndex]
    return target ? pageChipTargetClosable(target) : false
  })
  if (closableTargetIndexes.length === 0) return null
  const historyCount = closableTargetIndexes.filter((targetIndex) => (
    targets[targetIndex]?.sourceType === 'history'
  )).length
  const tabCount = closableTargetIndexes.length - historyCount
  return {
    historyCount,
    label: groupCloseActionLabel({ historyCount, tabCount }),
    leavesSavedPage: closableTargetIndexes.some((targetIndex) => {
      const target = targets[targetIndex]
      return target ? pageChipCloseLeavesSavedPage(target) : false
    }),
    tabCount,
    targetIndexes: closableTargetIndexes,
  }
}

function defaultTarget(targets: readonly DashboardChipData[]): DashboardChipData | undefined {
  return targets.find((target) => !!target.activeChipFrame && !target.activeInOtherWindow)
    || targets.find((target) => !!target.activeInOtherWindow)
    || (targets.every(isClosedSavedDashboardTab)
      ? targets.find((target) => target.sourceType === 'saved-page')
      : undefined)
    || targets[0]
}

function orderSource(sourceType: DashboardChipData['sourceType']): string {
  return sourceType === 'saved-page' || sourceType === 'retained-page'
    ? 'tab'
    : sourceType || 'tab'
}

function orderEntry(target: DashboardChipData): SameTitlePageChipOrderEntry {
  const source = orderSource(target.sourceType)
  return {
    key: `${source}:url:${target.tabUrl}`,
    alternateKey: target.rawUrl && target.rawUrl !== target.tabUrl
      ? `${source}:url:${target.rawUrl}`
      : null,
  }
}

function titleText(target: DashboardChipData): string {
  return (target.title || target.tooltip || target.tabUrl).trim()
}

function rowAriaLabel(
  representative: DashboardChipData,
  label: string,
  targets: readonly DashboardChipData[],
): string {
  const targetCount = targets.length
  const targetCountLabel = targetCount > 1
    ? targets.every((target) => target.sourceType === 'history')
      ? `${targetCount} history entries`
      : `${targetCount} exact targets`
    : ''
  const duplicateCount = representative.sourceType === 'retained-page'
    ? 1
    : representative.dupeCount || 1
  const closedSaved = isClosedSavedDashboardTab(representative)
  return [
    [representative.leadPrefix, representative.title, label].filter(Boolean).join(' · '),
    targetCountLabel,
    targetCount === 1 && representative.pagePinned ? 'Pinned' : '',
    duplicateCount > 1 ? `${duplicateCount} open copies` : '',
    representative.activeInOtherWindow ? 'Active in another window' : '',
    representative.saved ? (closedSaved ? 'Closed saved page' : 'Saved page') : '',
  ].filter(Boolean).join(' · ')
}

function isCompiledPlan(plan: SameTitlePageChipPlan): plan is CompiledPlan {
  return 'compiled' in plan
}

function compiledPlan(plan: SameTitlePageChipPlan): CompiledPlan | null {
  return isCompiledPlan(plan) ? plan : null
}

function compiledRowForIntent(
  plan: CompiledPlan,
  rowId: SameTitlePageChipRowId | undefined,
): CompiledRow | undefined {
  const targetRowId = rowId ?? plan.view.defaultRowId
  return plan.compiled.rows.find((row) => row.id === targetRowId)
}

function targetsAtIndexes(
  targets: readonly DashboardChipData[],
  targetIndexes: readonly number[],
): DashboardChipData[] {
  return targetIndexes.flatMap((targetIndex) => targets[targetIndex] ?? [])
}

function removalDecision(
  targets: readonly DashboardChipData[],
  removal: CompiledRemovalPlan,
  representative: DashboardChipData,
  exactSingleTab: boolean,
): SameTitlePageChipRemovalDecision {
  const removalTargets = removal.targetIndexes.flatMap((targetIndex) => targets[targetIndex] ?? [])
  const historyUrls: string[] = []
  const tabTargets: DashboardChipData[] = []
  for (const target of removalTargets) {
    if (target.sourceType === 'history') historyUrls.push(target.tabUrl)
    else tabTargets.push(target)
  }
  const tabClose = tabTargets.length === 0
    ? null
    : exactSingleTab && tabTargets.length === 1
      ? { kind: 'single' as const, target: tabTargets[0] ?? representative }
      : {
          kind: 'many' as const,
          representativeUrl: representative.tabUrl,
          envs: tabTargets.map((target) => ({
            prefix: '',
            tabUrl: target.tabUrl,
            rawUrl: target.rawUrl,
          })),
        }
  return {
    historyUrls,
    kind: 'remove',
    leavesSavedPage: removal.leavesSavedPage,
    tabClose,
  }
}

export function compileSameTitlePageChip(
  targets: readonly DashboardChipData[],
): SameTitlePageChipCompileResult {
  if (targets.length < 2) return { ok: false, reason: 'fewer-than-two-targets' }
  if (targets.some((target) => !target.tabUrl)) return { ok: false, reason: 'missing-exact-url' }
  if (new Set(targets.map((target) => target.tabUrl)).size < 2) {
    return { ok: false, reason: 'single-exact-url' }
  }

  const presentationGroups = buildUrlVariantPresentationGroups(
    targets.map((target) => target.tabUrl),
    { collapseOpaqueValues: targets.every((target) => target.sourceType === 'history') },
  )
  const selectedDefaultTarget = defaultTarget(targets)
  if (!selectedDefaultTarget) return { ok: false, reason: 'fewer-than-two-targets' }

  const compiledRows = presentationGroups.flatMap((presentation, rowIndex): CompiledRow[] => {
    const targetIndexes = presentation.targetIndexes.filter((targetIndex) => targets[targetIndex] !== undefined)
    const rowTargets = targetsAtIndexes(targets, targetIndexes)
    const representative = rowTargets[0]
    if (!representative) return []
    const filterCandidate = filterResultCandidateForTarget(representative)
    return [{
      id: `${filterCandidate.key}:${rowIndex}`,
      previewMatchUrls: Array.from(new Set(rowTargets.flatMap(pageTargetMatchUrls))),
      removal: removalPlan(targets, targetIndexes),
      targetIndexes,
    }]
  })
  if (compiledRows.length === 0) return { ok: false, reason: 'fewer-than-two-targets' }

  const defaultRow = compiledRows.find((row) => row.targetIndexes.some((targetIndex) => (
    targets[targetIndex] === selectedDefaultTarget
  ))) ?? compiledRows[0]
  if (!defaultRow) return { ok: false, reason: 'fewer-than-two-targets' }

  const rows = compiledRows.map((row, rowIndex): SameTitlePageChipRowView => {
    const rowTargets = targetsAtIndexes(targets, row.targetIndexes)
    const presentation = presentationGroups[rowIndex]
    const representative = rowTargets[0] ?? selectedDefaultTarget
    const label = presentation?.label ?? representative.variantLabel ?? '/'
    const singleTarget = rowTargets.length === 1
    const actionPolicy = pageChipTargetActionPolicy(representative)
    const close = row.removal
      ? {
          destructive: representative.sourceType === 'history',
          label: `${row.removal.label}: ${label}`,
        }
      : null
    const duplicateCount = representative.sourceType === 'retained-page'
      ? 1
      : representative.dupeCount || 1
    return omitUndefined({
      active: rowTargets.some((target) => !!(target.activeChipFrame || target.activeInOtherWindow)),
      actions: {
        close,
        chromeTabActions: singleTarget && actionPolicy.canUseChromeTabActions,
        pin: singleTarget && !!representative.pagePinId
          ? { label: representative.pagePinned ? 'Unpin' : 'Pin' }
          : null,
        removeRetained: singleTarget && actionPolicy.canRemoveRetained,
        saved: singleTarget && actionPolicy.canToggleSaved
          ? { label: representative.saved ? 'Remove saved page' : 'Save page' }
          : null,
        showSavedHint: singleTarget && actionPolicy.showSavedHint,
      },
      ariaLabel: rowAriaLabel(representative, label, rowTargets),
      copyTitle: titleText(representative),
      copyUrl: representative.tabUrl,
      current: rowTargets.some((target) => !!target.activeChipFrame && !target.activeInOtherWindow),
      dimmed: rowTargets.every((target) => !!target.suspended || isClosedSavedDashboardTab(target)),
      duplicateCount,
      exactTargetCount: rowTargets.length,
      filterCandidate: filterResultCandidateForTarget(representative),
      id: row.id,
      label,
      layoutKey: representative.pagePinId || representative.rawUrl,
      pagePinned: singleTarget && !!representative.pagePinned,
      removalKey: `page:${representative.rawUrl}`,
      retainedPageClosureToken: representative.retainedPageClosureToken,
      retainedPageIdentity: representative.retainedPageIdentity,
      saved: !!representative.saved,
      sourceType: representative.sourceType,
    })
  })
  const allTargetIndexes = targets.map((_, targetIndex) => targetIndex)
  const groupRemoval = removalPlan(targets, allTargetIndexes)
  const chromeGroupId = selectedDefaultTarget.chromeGroupId
  const view: SameTitlePageChipView = {
    chromeGroupId: chromeGroupId != null && chromeGroupId !== -1 &&
      targets.every((target) => target.isGrouped && target.chromeGroupId === chromeGroupId)
      ? chromeGroupId
      : null,
    defaultRowId: defaultRow.id,
    groupRemoval: groupRemoval
      ? {
          historyCount: groupRemoval.historyCount,
          label: groupRemoval.label,
          tabCount: groupRemoval.tabCount,
        }
      : null,
    orderEntries: targets.map(orderEntry),
    rows,
    summaryLabel: `${targets.length} URL variants: ${rows.map((row) => (
      row.exactTargetCount > 1 ? `${row.label} (${row.exactTargetCount})` : row.label
    )).join(' · ')}`,
  }
  const plan: CompiledPlan = {
    compiled: {
      groupRemoval,
      rows: compiledRows,
      targets,
    },
    view,
  }
  return { ok: true, plan }
}

export function resolveSameTitlePageChip(
  plan: SameTitlePageChipPlan,
  intent: SameTitlePageChipIntent,
): SameTitlePageChipDecision {
  const resolvedPlan = compiledPlan(plan)
  if (!resolvedPlan) return { kind: 'unavailable', reason: 'unsupported-action' }

  if (intent.kind === 'debug-targets') {
    return {
      exactTargets: resolvedPlan.compiled.rows.flatMap((row) => {
        const viewRow = resolvedPlan.view.rows.find((candidate) => candidate.id === row.id)
        return targetsAtIndexes(resolvedPlan.compiled.targets, row.targetIndexes).map((target) => ({
          label: viewRow?.label ?? '',
          rowId: row.id,
          target,
        }))
      }),
      kind: 'debug-targets',
    }
  }

  if (intent.kind === 'hover-match') {
    return {
      kind: 'hover-match',
      rowMatches: resolvedPlan.compiled.rows.map((row) => (
        targetsAtIndexes(resolvedPlan.compiled.targets, row.targetIndexes).some((target) => (
          pageTargetMatchesHover(target, intent.url, intent.matchUrls)
        ))
      )),
    }
  }

  const row = compiledRowForIntent(resolvedPlan, intent.rowId)
  if (!row) return { kind: 'unavailable', reason: 'stale-row' }
  const rowTargets = targetsAtIndexes(resolvedPlan.compiled.targets, row.targetIndexes)
  const representative = rowTargets[0]
  if (!representative) return { kind: 'unavailable', reason: 'stale-row' }

  if (intent.kind === 'activate') return { kind: 'activate', target: representative }
  if (intent.kind === 'preview') {
    const tabId = typeof representative.tabId === 'number'
      ? representative.tabId
      : undefined
    return omitUndefined({
      kind: 'preview',
      matchUrls: row.previewMatchUrls,
      tabId,
      url: representative.tabUrl,
    })
  }

  if (intent.action === 'close') {
    const removal = intent.rowId === undefined
      ? resolvedPlan.compiled.groupRemoval
      : row.removal
    if (!removal) return { kind: 'unavailable', reason: 'unsupported-action' }
    return removalDecision(
      resolvedPlan.compiled.targets,
      removal,
      representative,
      intent.rowId !== undefined && rowTargets.length === 1 && removal.historyCount === 0,
    )
  }
  if (intent.rowId === undefined || rowTargets.length !== 1) {
    return { kind: 'unavailable', reason: 'unsupported-action' }
  }
  if (intent.action === 'toggle-pin') {
    return representative.pagePinId
      ? { kind: 'toggle-pin', pagePinId: representative.pagePinId }
      : { kind: 'unavailable', reason: 'unsupported-action' }
  }

  const policy = pageChipTargetActionPolicy(representative)
  const supported = intent.action === 'toggle-saved'
    ? policy.canToggleSaved
    : intent.action === 'remove-retained'
      ? policy.canRemoveRetained
      : policy.canUseChromeTabActions
  return supported
    ? { action: intent.action, kind: 'target-action', target: representative }
    : { kind: 'unavailable', reason: 'unsupported-action' }
}
