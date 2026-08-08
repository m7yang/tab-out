import { isPinnableDomain } from '../extension/domain-pins.js'
import { splitDomainForDisplay } from '../extension/domains.js'
import { closeDomainTabs, closeSuspendedDomainTabs, dedupeTabs, suspendDomainTabs } from '../extension/tab-actions'
import { DomainCardProvider } from './DomainCardContext'
import { useDashboardActions } from './DashboardInteractionContext'
import { SubdomainSection } from './SubdomainSection'
import { CardActionsMenu } from './CardActionsMenu'
import { SavedPageIcon } from './SavedPageIcon'
import { TitleSuppressionSummary } from './TitleSuppressionSummary'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import { domainCardCloseRemovesAllItems } from './domain-card-close-policy.js'
import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { emptyTitleSuppressionToneScope } from './title-suppression'
import type { DashboardCardVM, DomainGroup } from './types'

interface DomainCardProps {
  group: DomainGroup
  vm: DashboardCardVM
  filter?: string
  highlightTerms?: readonly string[]
}

const DOMAIN_REORDER_DRAG_THRESHOLD_PX = 4
const DOMAIN_CARD_SELECTOR = '[data-tabout="domain-card"][data-tabout-domain]'
const PINNED_DOMAIN_CARD_SELECTOR = `${DOMAIN_CARD_SELECTOR}[data-tabout-domain-pinned="true"]`

type DomainReorderPlacement = 'before' | 'after'

function clearReorderTarget(block: HTMLElement | null) {
  if (!block) return
  block.removeAttribute('data-tabout-reorder-target')
  block.removeAttribute('data-tabout-reorder-placement')
  block.removeAttribute('data-tabout-reorder-noop')
}

function domainBlockFromNode(node: Element | null): HTMLElement | null {
  return node?.closest<HTMLElement>(DOMAIN_CARD_SELECTOR) ?? null
}

function reorderPlacementForPoint(block: HTMLElement, y: number): DomainReorderPlacement {
  const rect = block.getBoundingClientRect()
  return y < rect.top + rect.height / 2 ? 'before' : 'after'
}

function pinnedDomainBlockAtPoint(container: Element, sourceBlock: HTMLElement, x: number, y: number): HTMLElement | null {
  const block = domainBlockFromNode(document.elementFromPoint(x, y))
  if (!block || block === sourceBlock || block.closest('.missions') !== container) return null
  return block.matches(PINNED_DOMAIN_CARD_SELECTOR) ? block : null
}

function previousPinnedDomainBlock(block: HTMLElement): HTMLElement | null {
  let previous = block.previousElementSibling
  while (previous) {
    if (previous instanceof HTMLElement && previous.matches(PINNED_DOMAIN_CARD_SELECTOR)) return previous
    previous = previous.previousElementSibling
  }
  return null
}

function nextPinnedDomainBlock(block: HTMLElement): HTMLElement | null {
  let next = block.nextElementSibling
  while (next) {
    if (next instanceof HTMLElement && next.matches(PINNED_DOMAIN_CARD_SELECTOR)) return next
    next = next.nextElementSibling
  }
  return null
}

function reorderKeepsPinnedDomainOrder(sourceBlock: HTMLElement, targetBlock: HTMLElement, placement: DomainReorderPlacement): boolean {
  return placement === 'before'
    ? previousPinnedDomainBlock(targetBlock) === sourceBlock
    : nextPinnedDomainBlock(targetBlock) === sourceBlock
}

function TabBadgeCount({ count }: { count: string }) {
  const slashIndex = count.indexOf('/')

  return slashIndex > 0 ? (
    <span className="inline-flex items-center gap-0">
      <span className="tab-count-badge-current font-bold text-(--accent-amber)">{count.slice(0, slashIndex)}</span>
      <span className="tab-count-badge-total font-medium text-muted-foreground">{count.slice(slashIndex)}</span>
    </span>
  ) : count
}

function TabBadge({
  label,
  accessibleLabel
}: {
  label?: string | number | undefined
  accessibleLabel?: string | undefined
}) {
  const labelText = String(label ?? '')
  const savedMatch = labelText.match(/^(.*?) \+(\d+(?:\/\d+)?) saved$/)
  const savedOnlyMatch = labelText.match(/^(\d+(?:\/\d+)?) saved$/)
  const openCountText = savedMatch?.[1] ?? (savedOnlyMatch ? '' : labelText)
  const savedCount = savedMatch?.[2] ?? savedOnlyMatch?.[1] ?? ''
  const openCountIsFiltered = openCountText.includes('/')
  const savedCountIsFiltered = savedCount.includes('/')
  const isFiltered = openCountIsFiltered || savedCountIsFiltered
  const savedOnly = !!savedOnlyMatch || openCountText === '0' && savedCount !== ''

  return (
    <span
      aria-label={accessibleLabel}
      className={cn(
        'open-tabs-badge tab-count-badge inline-flex h-5.5 box-border items-center rounded-md bg-[rgba(82,82,82,0.08)] px-2 py-0 text-[12px] font-medium tabular-nums text-(--accent-amber) [corner-shape:squircle]',
        isFiltered && 'tab-count-badge-filtered'
      )}
    >
      {!savedOnly && (
        <TabBadgeCount count={openCountText} />
      )}
      {savedCount ? (
        <span className={cn('tab-count-badge-saved inline-flex items-center', isFiltered && 'text-muted-foreground')}>
          {!savedOnly && <span className="tab-count-badge-plus mx-1">+</span>}
          <span className="tab-count-badge-saved-count"><TabBadgeCount count={savedCount} /></span>
          <SavedPageIcon saved className="ml-px size-3 opacity-50" />
          <span className="sr-only"> saved</span>
        </span>
      ) : null}
    </span>
  )
}

function DedupButton({ count, closing = false, onClick }: { count: number; closing?: boolean; onClick: () => void | Promise<void> }) {
  const label = `Dedupe ${count}`
  return (
    <button
      type="button"
      data-tabout-part="dedupe-button"
      className={cn(
        'action-btn inline-flex h-5.5 box-border cursor-pointer items-center gap-1.25 rounded-[10px] border border-(--warm-gray) bg-tab-card px-3 py-0 font-sans text-[12px] font-medium tabular-nums text-muted-foreground transition-[color,border-color] duration-200 [corner-shape:squircle] hover:border-foreground hover:text-foreground [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-swift',
        closing && 'closing'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function PinnedDomainIndicator({ displayName }: { displayName: string }) {
  const title = `Pinned ${displayName}`
  return (
    <span
      data-tabout-part="pin-indicator"
      className="domain-pin-indicator inline-flex size-5.5 min-w-5.5 items-center justify-center text-foreground opacity-70"
    >
      <span className="icon-[lucide--pin] size-3.25" aria-hidden="true" />
      <span className="sr-only">{title}</span>
    </span>
  )
}

function ReorderPinnedDomainButton({
  displayName,
  onKeyDown,
  onPointerDown
}: {
  displayName: string
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void | Promise<void>
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void
}) {
  return (
    <TooltipAnchor content={`Drag to reorder ${displayName}`}>
      <button
        type="button"
        data-tabout-part="reorder-handle"
        className="domain-reorder-handle inline-flex size-5.5 min-w-5.5 cursor-grab touch-none items-center justify-center rounded-lg border border-transparent bg-transparent p-0 text-muted-foreground opacity-[0.45] transition-[opacity,color,background,border-color] duration-200 ease-out [corner-shape:squircle] hover:border-(--warm-gray) hover:bg-[rgba(82,82,82,0.06)] hover:text-foreground hover:opacity-100 active:cursor-grabbing focus-visible:border-(--warm-gray) focus-visible:bg-[rgba(82,82,82,0.06)] focus-visible:text-foreground focus-visible:opacity-100"
        aria-label={`Reorder pinned card ${displayName}`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <span className="icon-[lucide--grip-vertical] size-3.5" aria-hidden="true" />
      </button>
    </TooltipAnchor>
  )
}

function DomainTitle({ displayName, subdomainKey = '' }: { displayName: string; subdomainKey?: string }) {
  const { name, suffix } = splitDomainForDisplay(displayName)
  if (!suffix && !subdomainKey) return displayName

  return (
    <>
      {subdomainKey && <span className="domain-title-subdomain font-semibold text-muted-foreground">{subdomainKey}.</span>}
      <span className="domain-title-name">{suffix ? name : displayName}</span>
      {suffix && <span className="domain-title-suffix font-semibold text-muted-foreground">{suffix}</span>}
    </>
  )
}

export function DomainCard({ group, vm, filter = '', highlightTerms }: DomainCardProps) {
  const { onReorderPinnedDomain, onTogglePinnedDomain, onTogglePinnedSection } = useDashboardActions()
  const [activeSuppressedTitle, setActiveSuppressedTitle] = useState('')
  const [dedupeBadgesClosing, setDedupeBadgesClosing] = useState(false)
  const blockRef = useRef<HTMLDivElement>(null)
  const cardContext = {
    activeSuppressedTitle,
    highlightTerms: highlightTerms ?? null,
    setActiveSuppressedTitle,
    dedupeBadgesClosing,
    suppressionCloseTargetsByText: vm.suppressionCloseTargetsByText ?? {},
    suppressionSuspendTargetsByText: vm.suppressionSuspendTargetsByText ?? {}
  }
  if (vm.isHidden) return null
  const hideCardClose = group.domain === '__standalone-apps__'
  const isAppsCard = group.domain === '__standalone-apps__'
  const canPin = isPinnableDomain(group.domain) && typeof onTogglePinnedDomain === 'function'
  const displayName = vm.displayName || group.label || group.domain
  const closableExtras = vm.closableExtras ?? 0
  const closableCount = vm.closableCount ?? 0
  const suspendableCount = vm.suspendableCount ?? 0
  const closableSuspendedCount = vm.closableSuspendedCount ?? Math.max(0, closableCount - suspendableCount)
  const closeSuspendedLabel = vm.closableSuspendedCountLabel ?? (
    closableCount === (vm.tabCount ?? closableCount)
      ? `Close all ${closableSuspendedCount} suspended tab${closableSuspendedCount === 1 ? '' : 's'}`
      : `Close ${closableSuspendedCount} suspended ungrouped tab${closableSuspendedCount === 1 ? '' : 's'}`
  )
  const sections = vm.sections ?? []
  const highlightFilter = vm.displayMode !== 'unmatched' ? filter : ''
  const suppressedTitleParts = vm.suppressedTitleParts ?? []
  const inlineSubdomainKey = vm.singleSubdomainKey && !vm.singleSubdomainIsPort ? vm.singleSubdomainKey : ''
  const showBulkActions = !hideCardClose && closableCount > 0
  const showCardMenu = canPin || showBulkActions
  // Tone allocation happens in computeDomainCardViewModel's walk; each
  // section/cluster arrives carrying its scope and merged tone map.
  const cardSuppressionToneScope = vm.cardSuppressionToneScope ?? emptyTitleSuppressionToneScope()

  async function onCloseDomain() {
    const block = blockRef.current

    await closeDomainTabs({
      group,
      filter,
      displayName,
      onAfterClose: async ({ snapshot }) => {
        if (block && domainCardCloseRemovesAllItems({
          closableCount,
          filter,
          group,
          removedCount: snapshot.length
        })) {
          block.classList.add('closing')
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    })
  }

  async function onSuspendDomain() {
    await suspendDomainTabs({
      group,
      filter
    })
  }

  async function onCloseSuspendedDomain() {
    const block = blockRef.current

    await closeSuspendedDomainTabs({
      group,
      filter,
      displayName,
      onAfterClose: async ({ snapshot }) => {
        if (block && domainCardCloseRemovesAllItems({
          closableCount: closableSuspendedCount,
          filter,
          group,
          removedCount: snapshot.length
        })) {
          block.classList.add('closing')
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    })
  }

  async function onDedup() {
    const urls = vm.closableDupeUrls || []

    await dedupeTabs({
      urls,
      preservePinnedTabOut: group.domain === '__tab-out__',
      onAfterClose: async ({ snapshot }) => {
        if (snapshot.length === 0) return
        setDedupeBadgesClosing(true)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }).finally(() => {
      setDedupeBadgesClosing(false)
    })
  }

  async function onTogglePin() {
    await onTogglePinnedDomain?.(group.domain)
  }

  function onReorderPinnedDomainKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!group.pinned) return
    const direction = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
      ? 'previous'
      : e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 'next'
        : null
    if (!direction) return
    e.preventDefault()
    e.stopPropagation()
    void onReorderPinnedDomain?.(group.domain, { direction })
  }

  function onReorderPinnedDomainPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (!group.pinned || e.button !== 0) return
    const sourceBlock = blockRef.current
    const container = sourceBlock?.closest('.missions')
    if (!sourceBlock || !container) return
    const dragSourceBlock = sourceBlock
    const dragContainer = container

    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let lastTarget: HTMLElement | null = null
    let lastPlacement: DomainReorderPlacement | null = null
    const controller = new AbortController()

    function setReorderTarget(nextTarget: HTMLElement | null, nextPlacement: DomainReorderPlacement | null) {
      if (lastTarget && lastTarget !== nextTarget) clearReorderTarget(lastTarget)
      if (!nextTarget || !nextPlacement) {
        clearReorderTarget(lastTarget)
        lastTarget = null
        lastPlacement = null
        return
      }

      nextTarget.setAttribute('data-tabout-reorder-target', 'true')
      nextTarget.setAttribute('data-tabout-reorder-placement', nextPlacement)
      if (reorderKeepsPinnedDomainOrder(dragSourceBlock, nextTarget, nextPlacement)) {
        nextTarget.setAttribute('data-tabout-reorder-noop', 'true')
      } else {
        nextTarget.removeAttribute('data-tabout-reorder-noop')
      }
      lastTarget = nextTarget
      lastPlacement = nextPlacement
    }

    function clearDragState() {
      controller.abort()
      dragSourceBlock.removeAttribute('data-tabout-reorder-source')
      document.body.removeAttribute('data-tabout-domain-reorder-active')
      clearReorderTarget(lastTarget)
      lastTarget = null
      lastPlacement = null
    }

    function updateReorderTarget(event: globalThis.PointerEvent) {
      const nextTarget = pinnedDomainBlockAtPoint(dragContainer, dragSourceBlock, event.clientX, event.clientY)
      if (!nextTarget) {
        setReorderTarget(null, null)
        return
      }
      setReorderTarget(nextTarget, reorderPlacementForPoint(nextTarget, event.clientY))
    }

    function onPointerMove(event: globalThis.PointerEvent) {
      if (!dragging) {
        const moved = Math.hypot(event.clientX - startX, event.clientY - startY)
        if (moved < DOMAIN_REORDER_DRAG_THRESHOLD_PX) return
        dragging = true
        dragSourceBlock.setAttribute('data-tabout-reorder-source', 'true')
        document.body.setAttribute('data-tabout-domain-reorder-active', 'true')
      }

      event.preventDefault()
      updateReorderTarget(event)
    }

    function onPointerUp(event: globalThis.PointerEvent) {
      if (dragging && lastTarget && lastPlacement) {
        event.preventDefault()
        const targetDomain = lastTarget.dataset.taboutDomain
        if (targetDomain) void onReorderPinnedDomain?.(group.domain, { targetDomain, position: lastPlacement })
      }
      clearDragState()
    }

    function onPointerCancel() {
      clearDragState()
    }

    window.addEventListener('pointermove', onPointerMove, { capture: true, signal: controller.signal })
    window.addEventListener('pointerup', onPointerUp, { capture: true, signal: controller.signal })
    window.addEventListener('pointercancel', onPointerCancel, { capture: true, signal: controller.signal })
    window.addEventListener('blur', onPointerCancel, { signal: controller.signal })
  }

  return (
    <DomainCardProvider value={cardContext}>
      <div
        ref={blockRef}
        data-tabout="domain-card"
        data-tabout-domain={group.domain}
        data-tabout-domain-pinned={group.pinned ? 'true' : undefined}
        className={cn(
          'domain-block group/domain-block relative flex flex-col gap-1 data-[tabout-reorder-source=true]:opacity-65 [.missions.is-packed_&.layout-moving]:z-3 [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-200 [&.closing]:ease-swift [&.closing]:transform-[scale(0.96)] motion-reduce:[&.closing]:transform-none',
          // The pinned-domain drag controller drives reorder feedback through
          // data attributes on this block (imperative dataset writes, not
          // React state); the indicator bar and its noop/placement variants
          // react to them below.
          "data-[tabout-reorder-target=true]:before:pointer-events-none data-[tabout-reorder-target=true]:before:absolute data-[tabout-reorder-target=true]:before:inset-x-0 data-[tabout-reorder-target=true]:before:z-5 data-[tabout-reorder-target=true]:before:h-0.5 data-[tabout-reorder-target=true]:before:rounded-full data-[tabout-reorder-target=true]:before:content-[''] [&[data-tabout-reorder-target=true]:not([data-tabout-reorder-noop=true])]:before:bg-(--accent-amber) [&[data-tabout-reorder-target=true]:not([data-tabout-reorder-noop=true])]:before:shadow-[0_1px_2px_rgba(10,10,10,0.1)] data-[tabout-reorder-noop=true]:before:bg-[color-mix(in_srgb,var(--accent-amber)_36%,var(--warm-gray))] data-[tabout-reorder-noop=true]:before:shadow-[0_1px_1px_rgba(10,10,10,0.05)] data-[tabout-reorder-placement=before]:before:-top-1.5 data-[tabout-reorder-placement=after]:before:-bottom-1.5",
          vm.displayMode === 'unmatched' && 'card-unmatched opacity-[0.45] transition-opacity duration-200 ease-[ease] hover:opacity-100 focus-within:opacity-100',
          isAppsCard && 'domain-block-apps',
          group.pinned && 'domain-block-pinned'
        )}
        data-domain-id={vm.stableId}
      >
        <header
          className={cn(
            'domain-header min-w-0',
            isAppsCard ? 'px-1.75' : 'px-2',
            showCardMenu && 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1'
          )}
        >
          <div className="domain-header-flow flex min-w-0 flex-row flex-wrap items-center justify-start gap-x-2.5 gap-y-1">
            <span className="mission-name min-w-0 flex-[0_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[15px] leading-5.5 font-black tracking-[0.1px] text-foreground">
              <DomainTitle displayName={displayName} subdomainKey={inlineSubdomainKey} />
            </span>
            {group.pinned && (
              <ReorderPinnedDomainButton
                displayName={displayName}
                onKeyDown={onReorderPinnedDomainKeyDown}
                onPointerDown={onReorderPinnedDomainPointerDown}
              />
            )}
            {canPin && group.pinned && <PinnedDomainIndicator displayName={displayName} />}
            {vm.singleSubdomainKey && !inlineSubdomainKey && (
              <span
                className={cn(
                  'mission-subdomain inline-flex h-5.5 box-border items-center rounded-md bg-[rgba(82,82,82,0.04)] px-2 py-0 text-[12px] font-medium text-muted-foreground [corner-shape:squircle]',
                  vm.singleSubdomainIsPort
                    ? "before:font-normal before:opacity-45 before:content-[':']"
                    : "after:ml-px after:font-normal after:opacity-45 after:content-['.']"
                )}
              >
                {vm.singleSubdomainKey}
              </span>
            )}
            <TabBadge label={vm.tabCountLabel} accessibleLabel={vm.tabCountTitle} />
            {closableExtras > 0 && <DedupButton count={closableExtras} closing={dedupeBadgesClosing} onClick={onDedup} />}
          </div>
          {showCardMenu && (
            <CardActionsMenu
              displayName={displayName}
              pinned={!!group.pinned}
              onTogglePin={canPin ? onTogglePin : undefined}
              label={showBulkActions ? vm.closableCountLabel : undefined}
              onClose={showBulkActions ? onCloseDomain : undefined}
              suspendLabel={showBulkActions && suspendableCount > 0 ? vm.suspendableCountLabel : undefined}
              onSuspend={showBulkActions && suspendableCount > 0 ? onSuspendDomain : undefined}
              closeSuspendedLabel={showBulkActions ? closeSuspendedLabel : undefined}
              closeSuspendedEnabled={showBulkActions && closableSuspendedCount > 0}
              onCloseSuspended={showBulkActions ? onCloseSuspendedDomain : undefined}
            />
          )}
        </header>
        <div
          className={cn(
            'mission-card relative flex flex-col gap-2 overflow-visible',
            isAppsCard ? 'p-1.75' : 'p-2'
          )}
        >
          <TitleSuppressionSummary
            suppressedTitleParts={suppressedTitleParts}
            activeSuppressedTitle={activeSuppressedTitle}
            setActiveSuppressedTitle={setActiveSuppressedTitle}
            useSuppressionTokenTones={cardSuppressionToneScope.useSuppressionTokenTones}
            suppressedTitleToneIndexByText={cardSuppressionToneScope.suppressedTitleToneIndexByText}
          />
          <div className="mission-pages flex flex-col gap-0">
            {sections.map((section, index) => {
              const sectionToneScope = section.titleSuppressionToneScope ?? emptyTitleSuppressionToneScope()
              return (
                <SubdomainSection
                  key={section.key || '__root__'}
                  domain={group.domain}
                  subdomainKey={section.key}
                  isPinned={section.isPinned}
                  isShared={section.isShared}
                  onTogglePinnedSection={onTogglePinnedSection}
                  position={index === 0 ? 'first' : 'later'}
                  headerType={!section.showHeader ? 'hidden' : section.isPort ? 'port' : 'subdomain'}
                  sectionCount={section.sectionCount}
                  sectionClosableUrls={section.sectionClosableUrls}
                  flatSection={section.hasFlat ? {
                    visibleChips: section.flatVisibleChips,
                    hiddenChips: section.flatHiddenChips,
                    hiddenCount: section.flatHiddenCount
                  } : null}
                  suppressedTitleParts={section.suppressedTitleParts ?? []}
                  websitePathSections={section.websitePathSections}
                  clusters={section.clusters}
                  filter={highlightFilter}
                  useSuppressionTokenTones={sectionToneScope.useSuppressionTokenTones}
                  suppressedTitleToneIndexByText={sectionToneScope.suppressedTitleToneIndexByText}
                  suppressedTitleToneByText={section.suppressedTitleToneByText}
                />
              )
            })}
          </div>
        </div>
      </div>
    </DomainCardProvider>
  )
}
