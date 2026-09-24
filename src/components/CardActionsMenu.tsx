import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/menu'

interface CardActionsMenuProps {
  displayName: string
  label?: string | undefined
  onClose?: (() => void | Promise<void>) | undefined
  pinned?: boolean | undefined
  onTogglePin?: (() => void | Promise<void>) | undefined
  suspendLabel?: string | undefined
  onSuspend?: (() => void | Promise<void>) | undefined
  closeSuspendedLabel?: string | undefined
  closeSuspendedEnabled?: boolean | undefined
  onCloseSuspended?: (() => void | Promise<void>) | undefined
  removeFromTabsLabel?: string | undefined
  onRemoveFromTabs?: (() => void | Promise<void>) | undefined
}

export function CardActionsMenu({
  displayName,
  label,
  onClose,
  pinned,
  onTogglePin,
  suspendLabel,
  onSuspend,
  closeSuspendedLabel,
  closeSuspendedEnabled = true,
  onCloseSuspended,
  removeFromTabsLabel,
  onRemoveFromTabs,
}: CardActionsMenuProps) {
  const pinLabel = pinned ? 'Unpin card' : 'Pin card'
  const hasLiveTabActions = Boolean(
    (suspendLabel && onSuspend)
    || (closeSuspendedLabel && onCloseSuspended)
    || onClose,
  )
  const hasRemoveFromTabsAction = Boolean(removeFromTabsLabel && onRemoveFromTabs)

  return (
    <Menu>
      <MenuTrigger
        data-tabout-part="card-menu"
        aria-label={`Actions for ${displayName}`}
        className="card-actions-menu-trigger z-2 grid size-5.5 shrink-0 cursor-pointer place-items-center self-start justify-self-end rounded-full border border-transparent bg-transparent p-0 text-muted-foreground opacity-0 pointer-events-none transition-[opacity,color,background,border-color] duration-200 ease-out group-hover/domain-block:pointer-events-auto group-hover/domain-block:opacity-100 hover:border-(--warm-gray) hover:bg-[rgba(82,82,82,0.06)] hover:text-foreground focus-visible:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100 data-popup-open:border-(--warm-gray) data-popup-open:bg-[rgba(82,82,82,0.08)] data-popup-open:text-foreground"
      >
        <span className="icon-[lucide--ellipsis] size-3.5" aria-hidden="true" />
      </MenuTrigger>
      <MenuContent>
        {onTogglePin && (
          <MenuItem
            data-tabout-part="pin-button"
            className="card-actions-pin-item"
            label={pinLabel}
            onClick={onTogglePin}
          >
            <span className={pinned ? 'icon-[lucide--pin-off] size-3.5' : 'icon-[lucide--pin] size-3.5'} aria-hidden="true" />
            <span className="min-w-0 flex-1">{pinLabel}</span>
          </MenuItem>
        )}
        {onTogglePin && (hasLiveTabActions || hasRemoveFromTabsAction) && <MenuSeparator />}
        {suspendLabel && onSuspend && (
          <MenuItem
            data-tabout-part="suspend-button"
            className="card-actions-suspend-item"
            label={suspendLabel}
            onClick={onSuspend}
          >
            <span className="icon-[lucide--circle-pause] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">{suspendLabel}</span>
          </MenuItem>
        )}
        {closeSuspendedLabel && onCloseSuspended && (
          <MenuItem
            data-tabout-part="close-suspended-button"
            className="card-actions-close-suspended-item"
            disabled={!closeSuspendedEnabled}
            label={closeSuspendedLabel}
            onClick={onCloseSuspended}
          >
            <span className="icon-[lucide--circle-x] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">{closeSuspendedLabel}</span>
          </MenuItem>
        )}
        {onClose && (
          <MenuItem
            data-tabout-part="close-button"
            className="card-actions-close-item"
            label={label}
            onClick={onClose}
          >
            <span className="icon-[lucide--x] size-3.5" aria-hidden="true" />
            {label && <span className="min-w-0 flex-1">{label}</span>}
          </MenuItem>
        )}
        {hasLiveTabActions && hasRemoveFromTabsAction && <MenuSeparator />}
        {removeFromTabsLabel && onRemoveFromTabs && (
          <MenuItem
            data-tabout-part="remove-from-tabs-button"
            className="card-actions-remove-from-tabs-item"
            variant="destructive"
            label={removeFromTabsLabel}
            onClick={onRemoveFromTabs}
          >
            <span className="icon-[lucide--list-x] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">{removeFromTabsLabel}</span>
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  )
}
