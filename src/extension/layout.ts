/* ================================================================
   Masonry layout for the two missions grids

   Pinterest-style: each .domain-block is absolutely positioned in the
   shortest column on first sight, then PINNED to that column for
   subsequent re-packs. Growing one block only shifts the blocks below
   it in the same column — others hold position.

   The block is the masonry unit (not the inner .mission-card) because
   the header and content are sibling surfaces: title + pill + badges +
   actions live in .domain-header, while grouped pages live in the
   chrome-free .mission-card content wrapper. Masonry needs to measure
   both as one unit.

   The primary grid can be followed by filter-only companion grids such as
   bookmark and history matches. All are packed with the same algorithm;
   hidden and empty grids are skipped.

   Layout state is stored on each block in `dataset.masonryCol`.
   Column count changes (window resize crossing a breakpoint) reset
   all assignments. The `unpin` flag also resets, used by the filter
   when the visible block set changes.
   ================================================================ */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

const MIN_COL_WIDTH = 260
const IDEAL_COL_WIDTH = 304
const GAP = 10

type MasonryOptions = {
  minColWidth?: number
  idealColWidth?: number
  gap?: number
}
type MasonryHookOptions = {
  onAfterLayout?: ((containers: Array<HTMLElement | null>) => void) | null
  onBeforePack?: ((containers: Array<HTMLElement | null>) => unknown) | null
  onAfterPack?: ((containers: Array<HTMLElement | null>, animationState: unknown) => void) | null
}

type ContainerRefsRef = {
  current: Array<RefObject<HTMLElement | null>>
}

function isMasonryHookOptions(value: unknown): value is MasonryHookOptions {
  return !!value && typeof value === 'object' && ('onAfterLayout' in value || 'onBeforePack' in value || 'onAfterPack' in value)
}

function readCssPx(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function masonryOptionsFor(container: HTMLElement): Required<MasonryOptions> {
  const style = getComputedStyle(container)
  return {
    minColWidth: readCssPx(style, '--masonry-min-col-width', MIN_COL_WIDTH),
    idealColWidth: readCssPx(style, '--masonry-ideal-col-width', IDEAL_COL_WIDTH),
    gap: readCssPx(style, '--masonry-gap', GAP),
  }
}

export function chooseMasonryLayout(containerWidth: number, { minColWidth = MIN_COL_WIDTH, idealColWidth = IDEAL_COL_WIDTH, gap = GAP }: MasonryOptions = {}) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { colCount: 1, colWidth: 0 }
  }

  const maxColCount = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)))
  let best: { colCount: number, colWidth: number, score: number } | null = null

  for (let colCount = 1; colCount <= maxColCount; colCount++) {
    const colWidth = (containerWidth - gap * (colCount - 1)) / colCount
    if (colWidth < minColWidth && colCount > 1) continue

    const score = Math.abs(colWidth - idealColWidth)
    if (!best || score < best.score || (score === best.score && colCount > best.colCount)) {
      best = { colCount, colWidth, score }
    }
  }

  return best ? { colCount: best.colCount, colWidth: best.colWidth } : { colCount: 1, colWidth: containerWidth }
}

export function shouldAnimateMasonryResize(containerWidth: number, previousColCount?: number, options: MasonryOptions = {}): boolean {
  if (!Number.isInteger(previousColCount)) return false
  return chooseMasonryLayout(containerWidth, options).colCount !== previousColCount
}

function currentContainersFromRefs(containerRefsRef: ContainerRefsRef): Array<HTMLElement | null> {
  return containerRefsRef.current.map((ref) => ref.current)
}

function shouldAnimateAnyMasonryResize(containers: Array<HTMLElement | null>, lastColCounts: WeakMap<HTMLElement, number>) {
  return containers.some((container) => {
    if (!container || container.clientWidth === 0) return false
    const previousColCount = lastColCounts.get(container)
    return shouldAnimateMasonryResize(container.clientWidth, previousColCount, masonryOptionsFor(container))
  })
}

export function packMissionsMasonry(
  containers: HTMLElement | null | Array<HTMLElement | null>,
  {
    unpin = false,
    lastColCounts = null,
    packedCardHeights = null,
  }: {
    unpin?: boolean
    lastColCounts?: WeakMap<HTMLElement, number> | null
    packedCardHeights?: WeakMap<HTMLElement, number> | null
  } = {},
): void {
  const targets = Array.isArray(containers) ? containers : [containers]
  for (const container of targets) {
    packContainer(container, unpin, lastColCounts, packedCardHeights)
  }
}

function packContainer(
  container: HTMLElement | null,
  unpin: boolean,
  lastColCounts: WeakMap<HTMLElement, number> | null,
  packedCardHeights: WeakMap<HTMLElement, number> | null,
) {
  if (!container) return

  const containerWidth = container.clientWidth
  if (containerWidth === 0) return // section hidden — nothing to layout

  const cards = Array.from(container.querySelectorAll<HTMLElement>('.domain-block:not(.closing)')).filter((card) => getComputedStyle(card).display !== 'none')
  if (cards.length === 0) {
    container.style.height = ''
    return
  }

  // Rather than adding a new column the instant it barely fits, pick
  // the column count whose resulting card width lands closest to the
  // comfort target. That keeps resize drag feeling less jumpy: cards
  // don't collapse to the minimum width at every threshold.
  const options = masonryOptionsFor(container)
  const { colCount, colWidth } = chooseMasonryLayout(containerWidth, options)

  const prevColCount = lastColCounts?.get(container)
  if (unpin || prevColCount !== colCount) {
    cards.forEach((c) => delete c.dataset.masonryCol)
    lastColCounts?.set(container, colCount)
  }

  cards.forEach((card) => {
    card.style.position = 'absolute'
    card.style.width = `${colWidth}px`
  })

  // Width is the only write that can change card height. Read every resulting
  // height together before positioning any card so the loop below stays
  // write-only instead of forcing a layout after each left/top mutation.
  const cardHeights = cards.map((card) => card.getBoundingClientRect().height)
  cards.forEach((card, index) => packedCardHeights?.set(card, cardHeights[index] ?? 0))
  const colHeights: number[] = new Array(colCount).fill(0)
  cards.forEach((card, index) => {
    let col = 0
    const prev = Number.parseInt(card.dataset.masonryCol || '', 10)
    if (Number.isInteger(prev) && prev >= 0 && prev < colCount) {
      col = prev
    } else {
      col = 0
      for (let i = 1; i < colCount; i++) {
        if ((colHeights[i] ?? 0) < (colHeights[col] ?? 0)) col = i
      }
      card.dataset.masonryCol = String(col)
    }
    card.style.left = `${col * (colWidth + options.gap)}px`
    card.style.top = `${colHeights[col] ?? 0}px`
    colHeights[col] = (colHeights[col] ?? 0) + (cardHeights[index] ?? 0) + options.gap
  })

  container.style.height = `${Math.max(...colHeights) - options.gap}px`
  requestAnimationFrame(() => container.classList.add('is-packed'))
}

export function useMissionsMasonry(...args: unknown[]) {
  const options = isMasonryHookOptions(args.at(-1)) ? args.pop() as MasonryHookOptions : {}
  const containerRefs = args as Array<RefObject<HTMLElement | null>>
  const { onAfterLayout = null, onBeforePack = null, onAfterPack = null } = options
  const packedCardHeightsRef = useRef(new WeakMap<HTMLElement, number>())
  const lastColCountsRef = useRef(new WeakMap<HTMLElement, number>())
  const rafIdRef = useRef(0)
  const observerRef = useRef<ResizeObserver | null>(null)
  const cardResizeObserverRef = useRef<ResizeObserver | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)
  const observedContainersRef = useRef(new Set<HTMLElement>())
  const observedContainerWidthsRef = useRef(new WeakMap<HTMLElement, number>())
  const containerRefsRef = useRef(containerRefs)
  const optionsRef = useRef({ onAfterLayout, onBeforePack, onAfterPack })
  // The stable pack callbacks and the observers below read these at call time.
  // Mirroring after commit keeps render free of ref writes; this effect is
  // declared first so the observer effect and callers see the latest inputs.
  useLayoutEffect(() => {
    containerRefsRef.current = containerRefs
    optionsRef.current = { onAfterLayout, onBeforePack, onAfterPack }
  })

  const packMissionsMasonryNow = useCallback(function packMissionsMasonryNow({ unpin = false, animate = false }: { unpin?: boolean, animate?: boolean } = {}) {
    const containers = currentContainersFromRefs(containerRefsRef)
    const { onAfterLayout, onBeforePack, onAfterPack } = optionsRef.current
    const animationState = animate && onBeforePack ? onBeforePack(containers) : null
    for (const container of containers) {
      if (container) observedContainerWidthsRef.current.set(container, container.clientWidth)
    }
    packMissionsMasonry(
      containers,
      {
        unpin,
        lastColCounts: lastColCountsRef.current,
        packedCardHeights: packedCardHeightsRef.current,
      },
    )
    onAfterLayout?.(containers)
    if (animate && onAfterPack) onAfterPack(containers, animationState)
  }, [])

  const scheduleMissionsMasonry = useCallback(function scheduleMissionsMasonry({ unpin = false, animate = true }: { unpin?: boolean, animate?: boolean } = {}) {
    cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0
      packMissionsMasonryNow({ unpin, animate })
    })
  }, [packMissionsMasonryNow])

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- observers stay attached across renders by design; the unmount-only effect below disconnects all three and cancels the pending frame.
  useLayoutEffect(() => {
    const observer = observerRef.current ??= new ResizeObserver((entries) => {
      let widthChanged = false
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue
        const previousWidth = observedContainerWidthsRef.current.get(entry.target)
        const nextWidth = entry.target.clientWidth
        observedContainerWidthsRef.current.set(entry.target, nextWidth)
        if (previousWidth !== undefined && previousWidth !== nextWidth) widthChanged = true
      }
      // packContainer writes the grid height. ResizeObserver reports that
      // height change too, but masonry only needs to react when its available
      // inline width changes; repacking the height write would self-trigger.
      if (!widthChanged) return
      const containers = currentContainersFromRefs(containerRefsRef)
      scheduleMissionsMasonry({ animate: shouldAnimateAnyMasonryResize(containers, lastColCountsRef.current) })
    })
    let cardResizeObserver = cardResizeObserverRef.current
    if (!cardResizeObserver) {
      cardResizeObserver = new ResizeObserver((entries) => {
        let heightChanged = false
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue
          const nextHeight = entry.borderBoxSize[0]!.blockSize
          const packedHeight = packedCardHeightsRef.current.get(entry.target)
          if (packedHeight === undefined) {
            packedCardHeightsRef.current.set(entry.target, nextHeight)
          } else if (Math.abs(packedHeight - nextHeight) > 0.1) {
            heightChanged = true
          }
        }
        // Explicit layout changes already have a coalesced pack waiting, often
        // with the FLIP geometry needed to animate them. Otherwise a card's
        // contents changed size independently (for example after title layout
        // settles), so repack synchronously before the stale positions paint.
        if (!heightChanged || rafIdRef.current !== 0) return
        packMissionsMasonryNow()
      })
      cardResizeObserverRef.current = cardResizeObserver
    }
    // Progressive reveal appends `.domain-block` children into a grid whose box
    // doesn't change (its height is set imperatively), so the ResizeObserver
    // alone never fires for it. A childList MutationObserver re-packs on append.
    // packContainer only mutates styles/height (never childList), so this can't
    // loop; scheduleMissionsMasonry rAF-coalesces bursts of appends into one pack.
    const mutationObserver = mutationObserverRef.current ??= new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.matches('.domain-block')) cardResizeObserver.unobserve(node)
        }
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.domain-block')) cardResizeObserver.observe(node)
        }
      }
      scheduleMissionsMasonry({ animate: false })
    })
    const nextContainers = new Set<HTMLElement>()
    containerRefs.forEach((ref) => {
      const container = ref.current
      if (!container) return
      nextContainers.add(container)
    })
    const observedContainers = observedContainersRef.current
    const targetsChanged = observedContainers.size !== nextContainers.size ||
      !observedContainers.isSubsetOf(nextContainers)
    if (!targetsChanged) return

    // Most App renders do not replace a mission grid. Keep the observers
    // attached in that common case; disconnect/re-observe churn otherwise
    // delivers redundant initial ResizeObserver records for every hover or
    // selection update. Conditional grids still rebind on the first render
    // where their ref target actually changes.
    observer.disconnect()
    cardResizeObserver.disconnect()
    mutationObserver.disconnect()
    nextContainers.forEach((container) => {
      observedContainerWidthsRef.current.getOrInsertComputed(container, () => container.clientWidth)
      observer.observe(container)
      mutationObserver.observe(container, { childList: true })
      for (const card of container.querySelectorAll<HTMLElement>('.domain-block')) cardResizeObserver.observe(card)
    })
    observedContainersRef.current = nextContainers
  })

  useEffect(
    () => () => {
      cancelAnimationFrame(rafIdRef.current)
      observerRef.current?.disconnect()
      cardResizeObserverRef.current?.disconnect()
      mutationObserverRef.current?.disconnect()
      observedContainersRef.current.clear()
    },
    [],
  )

  return { packMissionsMasonryNow, scheduleMissionsMasonry }
}
