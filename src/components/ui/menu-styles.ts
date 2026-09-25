// Shared visual tokens for the popover-style menus so the click dropdown (`ui/menu`)
// and the right-click context menu (`ui/context-menu`) can't drift apart.
export const menuPopupClassName =
  'relative isolate z-70 min-w-40 rounded-[28.2px] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none [corner-shape:squircle]'

export const menuItemClassName =
  'relative flex min-h-6 min-w-36 cursor-default items-center gap-1.5 rounded-full px-2 py-1 text-[13px] leading-tight text-foreground outline-none select-none [corner-shape:round] data-menu-multiline:rounded-[21px] data-menu-multiline:[corner-shape:squircle] [--capsule-fill:transparent] bg-(--capsule-fill) data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:[--capsule-fill:var(--color-accent)] data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0'

export type MenuItemVariant = 'default' | 'destructive'

export const destructiveMenuItemClassName =
  'text-destructive data-disabled:[--capsule-fill:transparent]! data-disabled:text-muted-foreground! data-highlighted:[--capsule-fill:color-mix(in_oklab,var(--color-destructive)_10%,transparent)] data-highlighted:text-destructive'

export const menuSeparatorClassName =
  'pointer-events-none mx-1 my-1 h-px bg-border'
