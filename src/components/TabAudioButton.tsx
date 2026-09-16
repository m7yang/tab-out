import type { MouseEvent, PointerEvent } from 'react'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { TabAudioState } from '../extension/types'

interface TabAudioButtonProps {
  state: Exclude<TabAudioState, null>
  onToggle: () => void
  className?: string
}

/**
 * TabAudioButton — Chrome-style speaker/mute toggle. Renders the volume icon
 * when a tab is playing and the muted icon when muted; clicking toggles mute.
 * Stops propagation so it never triggers the surrounding chip/row activation.
 */
export function TabAudioButton({ state, onToggle, className }: TabAudioButtonProps) {
  const muted = state === 'muted'
  const label = muted ? 'Unmute tab' : 'Mute tab'

  function toggleMute(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.stopPropagation()
    onToggle()
  }

  function stopPress(e: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
  }

  return (
    <TooltipAnchor content={label}>
      <button
        type="button"
        data-tabout-part="audio-toggle"
        aria-label={label}
        aria-pressed={muted ? 'true' : 'false'}
        onClick={toggleMute}
        onPointerDown={stopPress}
        onMouseDown={stopPress}
        className={cn(
          'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 outline-none title-interaction:hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)',
          muted ? 'text-muted-foreground' : 'text-foreground',
          className,
        )}
      >
        <span
          className={cn('size-3.5', muted ? 'icon-[lucide--volume-x]' : 'icon-[lucide--volume-2]')}
          aria-hidden="true"
        />
      </button>
    </TooltipAnchor>
  )
}
