import type { WorkingSetItem } from './types'
import { focusExistingTabTargetResult, type ExistingTabFocusResult } from './tab-focus.js'

export async function focusWorkingSetItemResult(item: Pick<WorkingSetItem, 'tabId' | 'windowId' | 'tabUrl' | 'rawUrl'>): Promise<ExistingTabFocusResult> {
  return focusExistingTabTargetResult({
    tabId: item.tabId,
    windowId: item.windowId,
    url: item.tabUrl,
    rawUrl: item.rawUrl,
  })
}
