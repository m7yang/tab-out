import {
  emptyOpenSurfaceInventory,
  observeOpenSurface,
  removeOpenSurface,
  seedOpenSurfaceInventory,
  type OpenSurfaceInventory,
  type OpenSurfaceInventoryEntry,
  type OpenSurfaceInventoryOptions,
  type OpenSurfaceObservation
} from './open-surface-inventory.js'

export type OpenSurfaceReconciliationMode =
  | 'first-install'
  | 'browser-startup'
  | 'worker-resume'
  | 'extension-reload'

export interface ReconcileOpenSurfacesInput {
  mode: OpenSurfaceReconciliationMode
  session: OpenSurfaceInventory | null
  durable: OpenSurfaceInventory | null
  current: readonly OpenSurfaceObservation[]
  options?: OpenSurfaceInventoryOptions
}

export interface ReconcileOpenSurfacesResult {
  inventory: OpenSurfaceInventory
  inferredClosures: readonly OpenSurfaceInventoryEntry[]
}

async function reconcileAgainstCurrent(
  basis: OpenSurfaceInventory,
  current: readonly OpenSurfaceObservation[],
  options: OpenSurfaceInventoryOptions
): Promise<ReconcileOpenSurfacesResult> {
  const liveTabIds = new Set(current.map((observation) => observation.tabId))
  const inferredClosures: OpenSurfaceInventoryEntry[] = []
  let inventory = basis

  for (const entry of Object.values(basis.entries)) {
    if (liveTabIds.has(entry.tabId)) continue
    inferredClosures.push(entry)
    inventory = removeOpenSurface(inventory, entry.tabId).inventory
  }
  for (const observation of current) {
    inventory = (await observeOpenSurface(inventory, observation, options)).inventory
  }

  return { inventory, inferredClosures }
}

export async function reconcileOpenSurfaces(
  input: ReconcileOpenSurfacesInput
): Promise<ReconcileOpenSurfacesResult> {
  const options = input.options || {}
  if (input.mode === 'first-install') {
    return {
      inventory: await seedOpenSurfaceInventory(input.current, options),
      inferredClosures: []
    }
  }
  if (input.mode === 'browser-startup') {
    return {
      inventory: await seedOpenSurfaceInventory(input.current, options),
      inferredClosures: Object.values(input.durable?.entries || {})
    }
  }

  const basis = input.mode === 'worker-resume'
    ? input.session || emptyOpenSurfaceInventory()
    : input.session || input.durable || emptyOpenSurfaceInventory()
  return reconcileAgainstCurrent(basis, input.current, options)
}
