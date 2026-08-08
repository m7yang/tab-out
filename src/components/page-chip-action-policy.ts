import { isReadOnlyDashboardSourceType } from '../extension/dashboard-source.js'
import type { DashboardTab } from '../extension/types.js'

type PageChipActionTarget = {
  closedSaved?: DashboardTab['closedSaved']
  isApp?: DashboardTab['isApp']
  saved?: DashboardTab['saved']
  sourceType?: DashboardTab['sourceType']
}

type PageChipActionPolicyOptions = {
  interactive?: boolean
}

export type PageChipTargetActionPolicy = {
  canClose: boolean
  canRemoveRetained: boolean
  canToggleSaved: boolean
  canUseChromeTabActions: boolean
  showSavedHint: boolean
}

export function pageChipTargetActionPolicy(
  target: PageChipActionTarget,
  { interactive = true }: PageChipActionPolicyOptions = {}
): PageChipTargetActionPolicy {
  const closedSaved = target.sourceType === 'saved-page' ||
    target.sourceType === 'retained-page' ||
    !!target.closedSaved
  const canToggleSaved = interactive
    && (
      target.sourceType === 'tab' ||
      target.sourceType === 'saved-page' ||
      target.sourceType === 'retained-page'
    )

  return {
    canClose: interactive
      && !closedSaved
      && (!isReadOnlyDashboardSourceType(target.sourceType) || target.sourceType === 'history'),
    canRemoveRetained: interactive && target.sourceType === 'retained-page',
    canToggleSaved,
    canUseChromeTabActions: interactive && target.sourceType === 'tab' && !closedSaved,
    showSavedHint: interactive && !!target.saved && !canToggleSaved
  }
}
