export type ObservedElementSize = {
  height: number
  width: number
}

export type SizeChangeObserver = {
  disconnect: () => void
  observe: (target: HTMLElement, initialSize?: ObservedElementSize) => void
  unobserve: (target: HTMLElement) => void
}

function elementBorderBoxSize(target: HTMLElement): ObservedElementSize {
  const rect = target.getBoundingClientRect()
  return { height: rect.height, width: rect.width }
}

function entryBorderBoxSize(entry: ResizeObserverEntry): ObservedElementSize {
  const borderBoxSize = entry.borderBoxSize[0]
  if (!borderBoxSize) throw new Error('ResizeObserver entry missing border-box size')
  return {
    height: borderBoxSize.blockSize,
    width: borderBoxSize.inlineSize
  }
}

function elementSizeEqual(left: ObservedElementSize, right: ObservedElementSize) {
  return (
    Math.abs(left.height - right.height) < 0.1 &&
    Math.abs(left.width - right.width) < 0.1
  )
}

/**
 * ResizeObserver delivers every newly observed element once even when its box
 * has not changed. Title surfaces have already measured that resting box
 * before their passive observer registration, so seed it here and forward only
 * genuine later size changes.
 */
export function createSizeChangeObserver(onSizeChange: (target: HTMLElement) => void): SizeChangeObserver {
  let observedSizes = new WeakMap<HTMLElement, ObservedElementSize>()
  let observedTargets = new WeakSet<HTMLElement>()
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target
      if (!(target instanceof HTMLElement) || !observedTargets.has(target)) continue

      const previousSize = observedSizes.get(target)
      const nextSize = entryBorderBoxSize(entry)
      observedSizes.set(target, nextSize)
      if (previousSize && elementSizeEqual(previousSize, nextSize)) continue
      onSizeChange(target)
    }
  })

  return {
    disconnect() {
      observer.disconnect()
      observedSizes = new WeakMap()
      observedTargets = new WeakSet()
    },
    observe(target, initialSize) {
      observedTargets.add(target)
      observedSizes.set(target, initialSize ?? elementBorderBoxSize(target))
      observer.observe(target, { box: 'border-box' })
    },
    unobserve(target) {
      observer.unobserve(target)
      observedSizes.delete(target)
      observedTargets.delete(target)
    }
  }
}
