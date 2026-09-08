import { cn } from '@/lib/utils'
import { expansionLineMarkup, fragmentHtml, unwrapClampedTitleLines, type ExpansionLineClasses } from '../title-expansion'
import { carriedExpandedMarkerSpacingClass, carriedExpandedMarkerToneClass } from './policy.js'

export const PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = 'chip-title-suppression-marker inline rounded-lg border-0 bg-[rgba(115,115,115,0.08)] px-1 text-[12px] leading-[inherit] font-medium whitespace-nowrap text-muted-foreground align-baseline [corner-shape:squircle] [box-decoration-break:clone]'
export const PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME = 'chip-strip-indicator inline-block max-w-full rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground align-baseline [corner-shape:squircle]'
// Expanded chips reveal the full path suffix, so the cloned/measured copy must
// wrap (and break long, space-free query strings) instead of staying on the
// single nowrap line it uses while collapsed — otherwise it overflows the chip.
const PAGE_CHIP_EXPANDED_PATH_CLASS_NAME = 'chip-path font-normal text-muted-foreground inline-block max-w-full whitespace-normal wrap-break-word'

const PAGE_CHIP_EXPANSION_LINE_CLASSES: ExpansionLineClasses = {
  wrapper: 'page-chip-expanded-lines block min-w-0 max-w-full',
  line: 'page-chip-expanded-line block min-w-0 max-w-full whitespace-nowrap',
  constrainedLine: 'page-chip-expanded-line page-chip-expanded-line-constrained block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word',
  tailLine: 'page-chip-expanded-line page-chip-expanded-line-tail block min-w-0 max-w-full whitespace-normal break-normal wrap-break-word',
}

export function chipExpansionLineMarkup(lineHtml: readonly string[], viewportConstrained = false) {
  return expansionLineMarkup(lineHtml, PAGE_CHIP_EXPANSION_LINE_CLASSES, viewportConstrained)
}

function ensureLeadingExpandedMarkerSpace(document: Document, marker: Element) {
  if (carriedExpandedMarkerSpacingClass(Array.from(marker.classList))) return
  const previous = marker.previousSibling
  if (previous?.textContent && /\s$/.test(previous.textContent)) return
  marker.before(document.createTextNode(' '))
}

export function hydrateClonedExpandedChipFragment(document: Document, fragment: DocumentFragment) {
  for (const content of fragment.querySelectorAll('.chip-title-variant-content')) {
    content.className = 'chip-title-variant-content inline-flex max-w-full min-w-0 flex-col items-start gap-0.5 align-top'
  }

  for (const list of fragment.querySelectorAll('.chip-title-variant-list')) {
    list.className = 'chip-title-variant-list inline-flex max-w-full flex-col items-stretch pr-[5px] pb-1 align-top divide-y divide-neutral-500/15'
  }

  for (const shell of fragment.querySelectorAll('.chip-title-variant-shell')) {
    shell.className = 'chip-title-variant-shell inline-flex max-w-full min-w-0 items-center'
  }

  for (const variant of fragment.querySelectorAll('.chip-title-variant')) {
    variant.className = 'chip-title-variant inline-flex max-w-full min-w-0 items-center gap-1 rounded-none bg-transparent px-1.5 py-[3px] [font-size:inherit] leading-tight font-normal text-neutral-600'
  }

  for (const marker of fragment.querySelectorAll('.chip-title-suppression-marker')) {
    const label = marker.getAttribute('aria-label') || ''
    const hiddenTitleText = label.replace(/^Suppressed title text:\s*/, '').trim()
    if (!hiddenTitleText) continue

    ensureLeadingExpandedMarkerSpace(document, marker)
    const markerClasses = Array.from(marker.classList)
    marker.className = cn(PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME, carriedExpandedMarkerSpacingClass(markerClasses), carriedExpandedMarkerToneClass(markerClasses))
    marker.replaceChildren(document.createTextNode(hiddenTitleText))
  }

  for (const marker of fragment.querySelectorAll('.chip-strip-indicator')) {
    if (!marker.textContent?.trim()) {
      marker.remove()
      continue
    }

    const label = marker.getAttribute('aria-label') || ''
    if (!label) continue

    marker.className = PAGE_CHIP_TOOLTIP_STRUCTURAL_MARKER_CLASS_NAME
    marker.replaceChildren(document.createTextNode(label))
  }

  for (const path of fragment.querySelectorAll('.chip-path')) {
    path.className = PAGE_CHIP_EXPANDED_PATH_CLASS_NAME
  }
}

export function expandedChipFragmentHtml(document: Document, fragment: DocumentFragment) {
  unwrapClampedTitleLines(fragment)
  hydrateClonedExpandedChipFragment(document, fragment)
  return fragmentHtml(document, fragment)
}

// Clamped rows keep the raw captured markup: markers stay as-is so the
// clamped-row renderer can rebuild them as live React nodes, instead of the
// expansion pipeline's hydrated text-label presentation.
export function clampedChipFragmentHtml(document: Document, fragment: DocumentFragment) {
  unwrapClampedTitleLines(fragment)
  return fragmentHtml(document, fragment)
}

export type ChipLineFragmentSerializer = (document: Document, fragment: DocumentFragment) => string
