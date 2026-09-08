export type PageChipTextLayoutMeasurementJob = {
  read: () => () => void
}

const pageChipTextLayoutValidationCallbacks = new WeakMap<
  HTMLElement,
  () => PageChipTextLayoutMeasurementJob | null
>()

export function registerPageChipTextLayoutValidation(
  textEl: HTMLElement,
  validate: () => PageChipTextLayoutMeasurementJob | null,
) {
  pageChipTextLayoutValidationCallbacks.set(textEl, validate)
  return () => {
    if (pageChipTextLayoutValidationCallbacks.get(textEl) === validate) {
      pageChipTextLayoutValidationCallbacks.delete(textEl)
    }
  }
}

export function validatePageChipTextLayoutsAfterMasonry(containers: Array<HTMLElement | null>) {
  const jobs: PageChipTextLayoutMeasurementJob[] = []
  for (const container of containers) {
    if (!container) continue
    for (const textEl of container.querySelectorAll<HTMLElement>('.chip-text')) {
      const job = pageChipTextLayoutValidationCallbacks.get(textEl)?.()
      if (job) jobs.push(job)
    }
  }

  // Masonry assigns every card's final width before reaching this callback.
  // Read every affected title at those widths first, then apply truncation
  // classes and captured-line state together so one chip's write cannot force
  // layout for every chip that follows it.
  const applyJobs = jobs.map((job) => job.read())
  for (const apply of applyJobs) apply()
}
