import * as React from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { mergeRefs } from 'foxact/merge-refs'
import { attachCapsuleBorder } from '../capsule-border'

import { cn } from '@/lib/utils'
import {
  destructiveMenuItemClassName,
  menuItemClassName,
  menuPopupClassName,
  menuSeparatorClassName,
} from './menu-styles'
import type { MenuItemVariant } from './menu-styles'

const Menu = MenuPrimitive.Root
const MenuTrigger = MenuPrimitive.Trigger

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI menu primitive family is intentionally colocated in one file.
function MenuContent({
  align = 'end',
  alignOffset = 0,
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  // No Backdrop here (unlike ui/context-menu): Base UI's Menu dismisses on outside
  // press natively — a backdrop is only needed to swallow the right-click event.
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-70"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(menuPopupClassName, className)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI menu primitive family is intentionally colocated in one file.
function MenuItem({
  className,
  ref,
  children,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & { variant?: MenuItemVariant }) {
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- ref identity preserves the capsule observer and its cleanup across rerenders.
  const itemRef = React.useMemo(() => mergeRefs<HTMLDivElement>((element) => {
    if (typeof ref === 'function') return ref(element)
    // Keep object refs cleared when the merged React 19 cleanup runs.
    if (ref) ref.current = element
  }, attachCapsuleBorder), [ref])

  return (
    <MenuPrimitive.Item
      ref={itemRef}
      data-slot="menu-item"
      data-variant={variant}
      className={cn(
        menuItemClassName,
        variant === 'destructive' && destructiveMenuItemClassName,
        className,
      )}
      {...props}
    >
      {children}
    </MenuPrimitive.Item>
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- Base UI menu primitive family is intentionally colocated in one file.
function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn(menuSeparatorClassName, className)}
      {...props}
    />
  )
}

export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger }
