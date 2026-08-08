import { ContextMenuContent, ContextMenuItem } from './ui/context-menu'
import { SavedPageIcon } from './SavedPageIcon'

type StopPropagationEvent = {
  stopPropagation: () => void
}

export type PageChipContextMenuContentProps = {
  savedActionLabel?: string | undefined
  saved?: boolean | undefined
  titleText: string
  onSavedSelect?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
  onRemoveFromTabsSelect?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
  pagePinActionLabel?: string | undefined
  pagePinned?: boolean | undefined
  onPagePinSelect?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
  onCopyTitle: (event: StopPropagationEvent) => void | Promise<void>
  urlText: string
  onCopyUrl: (event: StopPropagationEvent) => void | Promise<void>
  onReloadSelect?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
  onDuplicateSelect?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
  suspendEnabled?: boolean | undefined
  onSuspendSelect?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
}

export function PageChipContextMenuContent({
  savedActionLabel,
  saved,
  titleText,
  onSavedSelect,
  onRemoveFromTabsSelect,
  pagePinActionLabel,
  pagePinned,
  onPagePinSelect,
  onCopyTitle,
  urlText,
  onCopyUrl,
  onReloadSelect,
  onDuplicateSelect,
  suspendEnabled,
  onSuspendSelect
}: PageChipContextMenuContentProps) {
  return (
    <ContextMenuContent>
      {onReloadSelect && (
        <ContextMenuItem
          className="page-chip-reload-menu-item"
          label="Reload"
          onClick={onReloadSelect}
        >
          <span className="icon-[weui--refresh-filled] size-3.5 rotate-45" aria-hidden="true" />
          <span className="min-w-0 flex-1">Reload</span>
        </ContextMenuItem>
      )}
      {onDuplicateSelect && (
        <ContextMenuItem
          className="page-chip-duplicate-menu-item"
          label="Duplicate"
          onClick={onDuplicateSelect}
        >
          <span className="icon-[lucide--copy-plus] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">Duplicate</span>
        </ContextMenuItem>
      )}
      {pagePinActionLabel && onPagePinSelect && (
        <ContextMenuItem
          className="page-chip-pin-menu-item"
          label={pagePinActionLabel}
          onClick={onPagePinSelect}
        >
          <span className={pagePinned ? 'icon-[lucide--pin-off] size-3.5' : 'icon-[lucide--pin] size-3.5'} aria-hidden="true" />
          <span className="min-w-0 flex-1">{pagePinActionLabel}</span>
        </ContextMenuItem>
      )}
      {savedActionLabel && onSavedSelect && (
        <ContextMenuItem
          className="page-chip-save-menu-item"
          label={savedActionLabel}
          onClick={onSavedSelect}
        >
          <SavedPageIcon saved={!!saved} className="size-3.5" />
          <span className="min-w-0 flex-1">{savedActionLabel}</span>
        </ContextMenuItem>
      )}
      {onRemoveFromTabsSelect && (
        <ContextMenuItem
          className="page-chip-remove-from-tabs-menu-item"
          label="Remove from Tabs"
          onClick={onRemoveFromTabsSelect}
        >
          <span className="icon-[lucide--list-x] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">Remove from Tabs</span>
        </ContextMenuItem>
      )}
      {onSuspendSelect && (
        <ContextMenuItem
          className="page-chip-suspend-menu-item"
          disabled={!suspendEnabled}
          label="Suspend"
          onClick={onSuspendSelect}
        >
          <span className="icon-[lucide--circle-pause] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">Suspend</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem
        className="page-chip-copy-title-menu-item"
        disabled={!titleText}
        label="Copy page title text"
        onClick={onCopyTitle}
      >
        <svg className="icon-[ooui--copy-ltr] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Copy page title text</span>
      </ContextMenuItem>
      <ContextMenuItem
        className="page-chip-copy-url-menu-item"
        disabled={!urlText}
        label="Copy URL"
        onClick={onCopyUrl}
      >
        <span className="icon-[lucide--link] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Copy URL</span>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
