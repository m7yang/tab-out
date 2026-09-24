import { useEffect, useRef } from 'react'
import { attachCapsuleBorder } from './capsule-border'
import { cn } from '@/lib/utils'
import { closeExactTabTargets, suspendExactTabTargets } from '../extension/tab-actions'
import { pointerIsOverElement, startPointerPositionTracking } from './pointer-position'
import { titleSuppressionKey, titleSuppressionTokenToneClass } from './title-suppression'
import { useDomainCardContext } from './DomainCardContext'
import { TitleSuppressionTokenContextMenu } from './TitleSuppressionTokenContextMenu'
import type { DashboardTitleSuppression } from './types'

interface TitleSuppressionSummaryProps {
  suppressedTitleParts: DashboardTitleSuppression[]
  activeSuppressedTitle: string
  setActiveSuppressedTitle: (text: string) => void
  useSuppressionTokenTones: boolean
  suppressedTitleToneIndexByText: Readonly<Record<string, number>>
  className?: string
}

export function TitleSuppressionSummary({
  suppressedTitleParts,
  activeSuppressedTitle,
  setActiveSuppressedTitle,
  useSuppressionTokenTones,
  suppressedTitleToneIndexByText,
  className,
}: TitleSuppressionSummaryProps) {
  const { suppressionCloseTargetsByText, suppressionSuspendTargetsByText } = useDomainCardContext()
  // Synchronous flag for which token's context menu is open. Base UI's context menu
  // opens a full-screen backdrop that steals the pointer/focus, firing the token's
  // mouseLeave/blur right after onOpenChange sets the highlight. A ref (not state)
  // lets those handlers see "my menu is open" the same tick and skip clearing it.
  const openMenuTextRef = useRef('')
  const tokenButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => { startPointerPositionTracking() }, [])
  if (suppressedTitleParts.length === 0) return null

  return (
    <div className={cn('title-suppression-summary flex flex-wrap items-center gap-1 text-xs leading-4 text-muted-foreground', className)}>
      {suppressedTitleParts.map((part, index) => {
        const label = `Suppressed in ${part.count} title${part.count !== 1 ? 's' : ''}: ${part.text}`
        const active = activeSuppressedTitle === part.text
        const allocatedToneIndex = suppressedTitleToneIndexByText[titleSuppressionKey(part.text)]
        const toneIndex = typeof allocatedToneIndex === 'number' ? allocatedToneIndex : index
        const closeTargets = suppressionCloseTargetsByText[titleSuppressionKey(part.text)] ?? []
        const suspendTargets = suppressionSuspendTargetsByText[titleSuppressionKey(part.text)] ?? []
        const tokenButton = (
          <button
            key={part.text}
            ref={(el) => {
              if (!el) return
              const map = tokenButtonsRef.current
              map.set(part.text, el)
              const detach = attachCapsuleBorder(el)
              return () => {
                map.delete(part.text)
                detach?.()
              }
            }}
            type="button"
            className={cn(
              'title-suppression-token inline-flex h-5 items-center gap-1 border border-transparent bg-neutral-100 px-1.5 py-0 text-xs leading-none font-medium text-muted-foreground transition-[background,border-color,color,box-shadow] duration-150 hover:border-yellow-200 hover:bg-yellow-50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-yellow-400',
              titleSuppressionTokenToneClass(toneIndex, useSuppressionTokenTones, active),
            )}
            aria-label={label}
            onMouseEnter={() => setActiveSuppressedTitle(part.text)}
            onMouseLeave={() => { if (openMenuTextRef.current !== part.text) setActiveSuppressedTitle('') }}
            // Only keyboard focus highlights — not the mouse-modality focus Base UI
            // restores to this button when its context menu closes (that would re-show
            // the highlight after the user clicked away).
            onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setActiveSuppressedTitle(part.text) }}
            onBlur={() => { if (openMenuTextRef.current !== part.text) setActiveSuppressedTitle('') }}
          >
            <span className="title-suppression-token-text max-w-45 overflow-hidden text-ellipsis whitespace-nowrap">{part.text}</span>
            {part.count > 1 && <span className="title-suppression-token-count tabular-nums">{part.count}</span>}
          </button>
        )

        if (closeTargets.length === 0 && suspendTargets.length === 0) return tokenButton

        return (
          <TitleSuppressionTokenContextMenu
            key={part.text}
            closableCount={closeTargets.length}
            suspendableCount={suspendTargets.length}
            onOpenChange={(open) => {
              openMenuTextRef.current = open ? part.text : ''
              if (open) {
                setActiveSuppressedTitle(part.text)
              } else {
                // On close Base UI restores focus to the token and may re-expose it under
                // the pointer. Set the final highlight in one step — kept only if the
                // pointer is genuinely over the token — so a closing click on the token
                // doesn't clear-then-rehighlight (a visible flash).
                setActiveSuppressedTitle(pointerIsOverElement(tokenButtonsRef.current.get(part.text)) ? part.text : '')
              }
            }}
            onSuspend={suspendTargets.length > 0 ? async (event) => {
              event.stopPropagation()
              await suspendExactTabTargets({ targets: suspendTargets })
            } : undefined}
            onClose={async (event) => {
              event.stopPropagation()
              await closeExactTabTargets({ targets: closeTargets })
            }}
          >
            {tokenButton}
          </TitleSuppressionTokenContextMenu>
        )
      })}
    </div>
  )
}
