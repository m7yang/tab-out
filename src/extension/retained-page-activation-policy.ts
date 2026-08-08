const NON_NAVIGABLE_PROTOCOLS = new Set([
  'chrome-untrusted:',
  'devtools:',
  'javascript:'
])

// Chromium's internal destructive/debug destinations are not pages Tab Out
// should ever invoke. Keep this list host-specific so ordinary WebUI surfaces
// such as chrome://settings and chrome://crashes remain valid targets.
const DESTRUCTIVE_CHROME_HOSTS = new Set([
  'badcastcrash',
  'browser-crash-test',
  'crash',
  'crashdump',
  'delayed-hang',
  'delayeduithreadhang',
  'gpuclean',
  'gpucrash',
  'gpuhang',
  'hang',
  'inducebrowserdcheckforrealz',
  'inducebrowsercrashforrealz',
  'kill',
  'memory-exhaust',
  'memory-pressure-critical',
  'memory-pressure-moderate',
  'quit',
  'quit-with-apps',
  'restart',
  'shorthang',
  'uithreadhang'
])

/**
 * Activation eligibility is narrower than capture eligibility. A retained
 * record may remain useful metadata even when Chrome categorically rejects or
 * would destructively interpret a fresh navigation to its exact URL.
 */
export function isRetainedPageActivationEligible(url: string): boolean {
  const parsed = URL.parse(url)
  if (!parsed || NON_NAVIGABLE_PROTOCOLS.has(parsed.protocol)) return false
  return parsed.protocol !== 'chrome:' || !DESTRUCTIVE_CHROME_HOSTS.has(parsed.hostname)
}
