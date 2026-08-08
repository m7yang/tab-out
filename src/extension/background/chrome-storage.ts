export async function readChromeStorageValue(
  storage: chrome.storage.StorageArea,
  key: string
): Promise<unknown> {
  const stored = await storage.get(key)
  return stored[key]
}

export async function writeChromeStorageValue(
  storage: chrome.storage.StorageArea,
  key: string,
  value: unknown
): Promise<void> {
  await storage.set({ [key]: value })
}

export async function removeChromeStorageValue(
  storage: chrome.storage.StorageArea,
  key: string
): Promise<void> {
  await storage.remove(key)
}
