/* ================================================================
   Title Suppression rendering tables — tone → class lookups only.
   Tone ALLOCATION (the CONTEXT.md palette rules) lives with the
   view-model in src/extension/title-suppression-tones.ts; tokens
   arrive here already carrying their tone.
   ================================================================ */

import { cn } from '@/lib/utils'
import { titleSuppressionToneForIndex } from '../extension/title-suppression-tones.js'
import type { TitleSuppressionTone } from '../extension/title-suppression-tones.js'
import type { DashboardChipData } from './types'

export {
  emptyTitleSuppressionToneScope,
  titleSuppressionKey,
  titleSuppressionToneForText,
} from '../extension/title-suppression-tones.js'
export type { TitleSuppressionTone, TitleSuppressionToneScope } from '../extension/title-suppression-tones.js'

export const TITLE_SUPPRESSION_MARKER_SYMBOL = '˷'

const TITLE_SUPPRESSION_TOKEN_TONES: Record<TitleSuppressionTone, { base: string, marker: string, active: string }> = {
  amber: {
    base: 'title-suppression-token-tone-amber [--capsule-border-color:var(--color-yellow-50)] [--capsule-fill:var(--color-yellow-50)] text-muted-foreground hover:[--capsule-border-color:var(--color-yellow-100)] hover:[--capsule-fill:var(--color-yellow-50)] hover:text-foreground focus-visible:outline-yellow-200',
    marker: 'title-suppression-token-tone-amber [--capsule-border-color:var(--color-yellow-50)] [--capsule-fill:var(--color-yellow-50)] text-muted-foreground',
    active: '[--capsule-border-color:var(--color-yellow-100)] [--capsule-fill:var(--color-yellow-50)] text-foreground ring-1 ring-inset ring-yellow-50',
  },
  teal: {
    base: 'title-suppression-token-tone-teal [--capsule-border-color:var(--color-teal-50)] [--capsule-fill:var(--color-teal-50)] text-muted-foreground hover:[--capsule-border-color:var(--color-teal-100)] hover:[--capsule-fill:var(--color-teal-50)] hover:text-foreground focus-visible:outline-teal-200',
    marker: 'title-suppression-token-tone-teal [--capsule-border-color:var(--color-teal-50)] [--capsule-fill:var(--color-teal-50)] text-muted-foreground',
    active: '[--capsule-border-color:var(--color-teal-100)] [--capsule-fill:var(--color-teal-50)] text-foreground ring-1 ring-inset ring-teal-50',
  },
  sky: {
    base: 'title-suppression-token-tone-sky [--capsule-border-color:var(--color-sky-50)] [--capsule-fill:var(--color-sky-50)] text-muted-foreground hover:[--capsule-border-color:var(--color-sky-100)] hover:[--capsule-fill:var(--color-sky-50)] hover:text-foreground focus-visible:outline-sky-200',
    marker: 'title-suppression-token-tone-sky [--capsule-border-color:var(--color-sky-50)] [--capsule-fill:var(--color-sky-50)] text-muted-foreground',
    active: '[--capsule-border-color:var(--color-sky-100)] [--capsule-fill:var(--color-sky-50)] text-foreground ring-1 ring-inset ring-sky-50',
  },
  rose: {
    base: 'title-suppression-token-tone-rose [--capsule-border-color:var(--color-rose-50)] [--capsule-fill:var(--color-rose-50)] text-muted-foreground hover:[--capsule-border-color:var(--color-rose-100)] hover:[--capsule-fill:var(--color-rose-50)] hover:text-foreground focus-visible:outline-rose-200',
    marker: 'title-suppression-token-tone-rose [--capsule-border-color:var(--color-rose-50)] [--capsule-fill:var(--color-rose-50)] text-muted-foreground',
    active: '[--capsule-border-color:var(--color-rose-100)] [--capsule-fill:var(--color-rose-50)] text-foreground ring-1 ring-inset ring-rose-50',
  },
}

const TITLE_SUPPRESSION_HIGHLIGHT_TONES: Record<TitleSuppressionTone, { chip: string, badge: string }> = {
  amber: {
    chip: 'bg-yellow-50 ring-1 ring-inset ring-yellow-50',
    badge: 'border-yellow-50 bg-yellow-50',
  },
  teal: {
    chip: 'bg-teal-50 ring-1 ring-inset ring-teal-50',
    badge: 'border-teal-50 bg-teal-50',
  },
  sky: {
    chip: 'bg-sky-50 ring-1 ring-inset ring-sky-50',
    badge: 'border-sky-50 bg-sky-50',
  },
  rose: {
    chip: 'bg-rose-50 ring-1 ring-inset ring-rose-50',
    badge: 'border-rose-50 bg-rose-50',
  },
}

export function titleSuppressionTokenToneClass(index: number, enabled: boolean, active: boolean) {
  if (!enabled) {
    return active ? '[--capsule-border-color:var(--color-yellow-100)] [--capsule-fill:var(--color-yellow-50)] text-foreground ring-1 ring-inset ring-yellow-50' : ''
  }
  const tone = TITLE_SUPPRESSION_TOKEN_TONES[titleSuppressionToneForIndex(index)]
  return cn(tone.base, active && tone.active)
}

export function titleSuppressionChipHighlightClass(tone: TitleSuppressionTone | '') {
  return tone ? TITLE_SUPPRESSION_HIGHLIGHT_TONES[tone].chip : 'bg-yellow-50 ring-1 ring-inset ring-yellow-50'
}

export function titleSuppressionOverflowHighlightClass(tone: TitleSuppressionTone | '') {
  return cn(TITLE_SUPPRESSION_TOKEN_TONES[tone || 'amber'].active, 'text-foreground')
}

export function titleSuppressionBadgeClass(tone: TitleSuppressionTone | '') {
  return tone ? TITLE_SUPPRESSION_HIGHLIGHT_TONES[tone].badge : 'border-yellow-50 bg-yellow-50'
}

export function titleSuppressionMarkerClass(tone: TitleSuppressionTone | '', active = false) {
  if (tone) return cn(TITLE_SUPPRESSION_TOKEN_TONES[tone].marker, active && TITLE_SUPPRESSION_TOKEN_TONES[tone].active)
  return active ? '[--capsule-border-color:var(--color-yellow-100)] [--capsule-fill:var(--color-yellow-50)] text-foreground ring-1 ring-inset ring-yellow-50' : ''
}

export function countHiddenSuppressedTitleMatches(hiddenChips: DashboardChipData[], activeSuppressedTitle: string): number {
  const activeKey = activeSuppressedTitle.trim().toLowerCase()
  if (!activeKey) return 0

  return hiddenChips.filter((chip) => {
    const suppressedTitleParts = chip.suppressedTitleParts || []
    return suppressedTitleParts.some((part) => part.toLowerCase() === activeKey)
  }).length
}

export function titleSuppressionCloseLabel(count: number): string {
  return `Close ${count} tab${count === 1 ? '' : 's'}`
}

export function titleSuppressionSuspendLabel(count: number): string {
  return `Suspend ${count} tab${count === 1 ? '' : 's'}`
}
