// Shared paint values; each Page Chip context still owns its interaction rules.
export const PAGE_CHIP_PAINT = {
  currentBg: 'var(--color-neutral-100)',
  openInteractionBg: 'color-mix(in srgb, var(--card-bg) 90%, var(--color-neutral-600) 10%)',
  // In-flow rows overlap by 1px. Translucency preserves the neighbour's frame;
  // expanded surfaces and action fades need the opaque equivalent above.
  openInteractionOverlayBg: 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)',
  quietInteractionBg: 'color-mix(in srgb, var(--card-bg) 96.5%, var(--color-neutral-600) 3.5%)',
  openHoverBorder: 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)',
  quietHoverBorder: 'color-mix(in srgb, var(--color-neutral-600) 22%, transparent)',
  activeOtherRestBg: 'color-mix(in srgb, var(--card-bg) 92.5%, var(--color-neutral-600) 7.5%)',
  activeOtherInteractionBg: 'color-mix(in srgb, var(--card-bg) 88%, var(--color-neutral-600) 12%)',
}

export const PAGE_CHIP_CURRENT_CLASSES = 'bg-neutral-100 text-tab-live shadow-[0_1px_2px_rgba(10,10,10,0.07)] ring-1 ring-inset ring-neutral-400'
