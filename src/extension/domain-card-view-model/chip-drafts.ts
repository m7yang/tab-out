/* ================================================================
   Same-title chip drafts — the symbol-keyed draft a rendered group
   of same-title URL variants travels as until the final compile.

   The view-model assembly attaches the exact variant chips under
   SAME_TITLE_PAGE_CHIP_DRAFT while sections are built, ordered, and
   scoped; compileDashboardChipDrafts then resolves each draft into
   one public chip with a compiled same-title plan (falling back to
   the loose variants when the plan compiler declines).
   ================================================================ */

import { compileSameTitlePageChip } from '../same-title-page-chip-plan.js'
import type { DashboardChipData, DashboardSectionVM } from '../types'

export const SAME_TITLE_PAGE_CHIP_DRAFT = Symbol('same-title-page-chip-draft')
export type DashboardChipDraft = DashboardChipData & {
  [SAME_TITLE_PAGE_CHIP_DRAFT]: DashboardChipData[]
}

function isDashboardChipDraft(chip: DashboardChipData): chip is DashboardChipDraft {
  return SAME_TITLE_PAGE_CHIP_DRAFT in chip
}

export function sameTitlePageChipDraftTargets(chip: DashboardChipData): DashboardChipData[] | null {
  return isDashboardChipDraft(chip) ? chip[SAME_TITLE_PAGE_CHIP_DRAFT] : null
}

function compileDashboardChipDraft(chip: DashboardChipData): DashboardChipData[] {
  if (!isDashboardChipDraft(chip)) return [chip]
  const { [SAME_TITLE_PAGE_CHIP_DRAFT]: targets, ...publicChip } = chip
  const compiled = compileSameTitlePageChip(targets)
  if (!compiled.ok) return targets
  return [{
    ...publicChip,
    sameTitlePageChipPlan: compiled.plan,
  }]
}

export function compileDashboardChipDrafts(sections: readonly DashboardSectionVM[]): DashboardSectionVM[] {
  return sections.map((section) => ({
    ...section,
    flatVisibleChips: section.flatVisibleChips.flatMap(compileDashboardChipDraft),
    flatHiddenChips: section.flatHiddenChips.flatMap(compileDashboardChipDraft),
    clusters: section.clusters.map((cluster) => ({
      ...cluster,
      visibleChips: cluster.visibleChips.flatMap(compileDashboardChipDraft),
      hiddenChips: cluster.hiddenChips.flatMap(compileDashboardChipDraft),
    })),
    websitePathSections: (section.websitePathSections ?? []).map((websitePathSection) => ({
      ...websitePathSection,
      flatVisibleChips: websitePathSection.flatVisibleChips.flatMap(compileDashboardChipDraft),
      flatHiddenChips: websitePathSection.flatHiddenChips.flatMap(compileDashboardChipDraft),
      clusters: websitePathSection.clusters.map((cluster) => ({
        ...cluster,
        visibleChips: cluster.visibleChips.flatMap(compileDashboardChipDraft),
        hiddenChips: cluster.hiddenChips.flatMap(compileDashboardChipDraft),
      })),
    })),
  }))
}
