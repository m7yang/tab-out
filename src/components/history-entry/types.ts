import type { ReactNode } from 'react'
import type { ClosedTabEntry } from '../../extension/closed-tabs.js'
import type { RetainedPageSurfaceMatch, TabHistoryEntry, WorkingSetItem } from '../../extension/types'
import type { HoverUrlChangeHandler, SnapshotChangeHandler, TabsChangeHandler } from '../types'

export type HistoryEntryKind = 'stack' | 'open-ghost' | 'closed-ghost'

export interface HistoryEntryProps {
  entry: TabHistoryEntry
  kind: HistoryEntryKind
  layoutKey: string
  indexLabel: ReactNode
  workingSetItem?: WorkingSetItem | null | undefined
  closedTab?: ClosedTabEntry | null | undefined
  savedKeys?: ReadonlySet<string> | undefined
  retainedPageSurfaceMatches?: readonly RetainedPageSurfaceMatch[] | undefined
  highlightTerms?: readonly string[] | undefined
  onSnapshotChange?: SnapshotChangeHandler | undefined
  onHistoryLayoutSettled?: (() => void) | undefined
  onHoverUrlChange?: HoverUrlChangeHandler | undefined
  onTabsChange?: TabsChangeHandler | undefined
  onForgetClosedGhost?: ((closed: ClosedTabEntry) => void) | undefined
}
