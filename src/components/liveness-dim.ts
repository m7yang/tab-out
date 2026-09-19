/* ================================================================
   Liveness dimming — shared class strings for the "not awake" look.

   Favicon strength encodes liveness across the dashboard: full opacity
   means an awake open tab is one click away; suspended and closed
   targets dim. Page chips and history rows share the same treatment
   so the signal reads identically everywhere. Suspended tabs keep
   their source colors; closed pages also lose some saturation to
   distinguish a page that must reopen from one that can wake.

   Same-title URL rows and folded environment targets have no individual
   favicon, so their labels carry the liveness signal instead. A fixed neutral-600 color keeps suspended and closed labels
   distinct even when the row itself becomes current or hovered.
   ================================================================ */

const FAVICON_DIM_CLASS_NAME = 'chip-favicon-dimmed opacity-45'

export function faviconLivenessClassName({ closed, suspended }: { closed: boolean, suspended: boolean }): string {
  if (closed) return `${FAVICON_DIM_CLASS_NAME} saturate-60`
  return suspended ? FAVICON_DIM_CLASS_NAME : ''
}

export const VARIANT_LABEL_DIM_CLASS_NAME = 'chip-variant-label-dimmed text-neutral-600'
