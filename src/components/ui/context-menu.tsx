import * as React from 'react'
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { mergeRefs } from 'foxact/merge-refs'
import { attachMenuItemBorder } from '../capsule-border'

import { cn } from '@/lib/utils'
import {
  destructiveMenuItemClassName,
  menuItemClassName,
  menuPopupClassName,
  menuSeparatorClassName,
} from './menu-styles'
import type { MenuItemVariant } from './menu-styles'
import { clearActiveContextMenu, setActiveContextMenu } from './context-menu-registry'

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

function stopBackdropEvent(event: React.SyntheticEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function ContextMenu({
  onOpenChange,
  ...props
}: ContextMenuPrimitive.Root.Props) {
  const id = React.useId()
  const actionsRef = React.useRef<ContextMenuPrimitive.Root.Actions | null>(null)

  function handleOpenChange(open: boolean, eventDetails: ContextMenuPrimitive.Root.ChangeEventDetails) {
    if (open) {
      setActiveContextMenu({
        id,
        close: () => actionsRef.current?.close(),
      })
    } else {
      clearActiveContextMenu(id)
    }
    onOpenChange?.(open, eventDetails)
  }

  React.useEffect(() => () => clearActiveContextMenu(id), [id])

  return (
    <ContextMenuPrimitive.Root
      {...props}
      actionsRef={actionsRef}
      onOpenChange={handleOpenChange}
    />
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- shadcn context-menu primitive family is intentionally colocated in one file.
function ContextMenuContent({
  align = 'start',
  alignOffset = 0,
  className,
  children,
  side,
  sideOffset = 4,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<
    ContextMenuPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset'
  >) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Backdrop
        data-slot="context-menu-backdrop"
        className="fixed inset-0 z-60 cursor-default bg-transparent"
        onPointerDown={stopBackdropEvent}
        onPointerUp={stopBackdropEvent}
        onClick={stopBackdropEvent}
        onContextMenu={stopBackdropEvent}
      />
      <ContextMenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-70"
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            menuPopupClassName,
            className,
          )}
          {...props}
        >
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- shadcn context-menu primitive family is intentionally colocated in one file.
function ContextMenuItem({
  className,
  ref,
  children,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.Item.Props & { variant?: MenuItemVariant }) {
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- ref identity preserves the capsule observer and its cleanup across rerenders.
  const itemRef = React.useMemo(() => mergeRefs<HTMLDivElement>((element) => {
    if (typeof ref === 'function') return ref(element)
    // Keep object refs cleared when the merged React 19 cleanup runs.
    if (ref) ref.current = element
  }, attachMenuItemBorder), [ref])

  return (
    <ContextMenuPrimitive.Item
      ref={itemRef}
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        menuItemClassName,
        variant === 'destructive' && destructiveMenuItemClassName,
        className,
      )}
      {...props}
    >
      {children}
    </ContextMenuPrimitive.Item>
  )
}

// react-doctor-disable-next-line react-doctor/no-multi-comp -- shadcn context-menu primitive family is intentionally colocated in one file.
function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(menuSeparatorClassName, className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
}
