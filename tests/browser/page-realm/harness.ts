import assert from 'node:assert/strict'
import type { CDPSession, Page } from '@playwright/test'

type CdpSession = {
  send(method: string, params?: Record<string, any>): Promise<any>
}

// One dashboard page under test: Playwright drives evaluation, CDP drives
// trusted input and viewport emulation.
export type DashboardHarness = {
  readonly page: Page
  readonly session: CdpSession
}

const NAVIGATION_RETRY_WINDOW_MS = 10_000
const NAVIGATION_RETRY_DELAY_MS = 100
const NAVIGATION_ERROR_PATTERN = /Execution context was destroyed|Cannot find context|Inspected target navigated/
const DEFAULT_CONDITION_TIMEOUT_MS = 2000

export function wait(delay: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, delay))
}

export async function createDashboardHarness(page: Page): Promise<DashboardHarness> {
  const cdp = await page.context().newCDPSession(page)
  return {
    page,
    session: {
      send(method, params = {}) {
        return cdp.send(method as Parameters<CDPSession['send']>[0], params as never)
      },
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Startup-heavy scenarios can navigate while a probe is in flight; retry only
// the errors that describe a lost execution context.
async function withNavigationRetry<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + NAVIGATION_RETRY_WINDOW_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (!NAVIGATION_ERROR_PATTERN.test(errorMessage(error))) throw error
      await wait(NAVIGATION_RETRY_DELAY_MS)
    }
  }
  throw lastError
}

// Raw CDP evaluation of source text. Reserved for callers that must inject
// code as text; prefer typed page functions everywhere else.
export function evaluateExpression(harness: DashboardHarness, params: Record<string, unknown>): Promise<any> {
  return withNavigationRetry(() => harness.session.send('Runtime.evaluate', params))
}

type BrowserConditionOptions<Args extends readonly unknown[]> = {
  args?: Args
  timeoutMs?: number
}

// Predicates run in the page realm; pass Node-side values through args instead of closures.
export async function waitForBrowserCondition<Args extends readonly unknown[] = []>(
  harness: DashboardHarness,
  condition: (...args: Args) => boolean,
  description: string,
  options: BrowserConditionOptions<Args> = {},
): Promise<void> {
  const args = options.args ?? ([] as unknown as Args)
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONDITION_TIMEOUT_MS
  // Frame-accurate polling has to run inside the page, so the predicate is
  // injected as source text here and nowhere else.
  const matched = await evaluateExpression(harness, {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const condition = (${condition.toString()})
      const args = ${JSON.stringify(args)}
      const start = Date.now()
      const wait = () => {
        try {
          if (condition(...args)) {
            resolve(true)
            return
          }
        } catch {}
        if (Date.now() - start > ${JSON.stringify(timeoutMs)}) {
          resolve(false)
        } else {
          requestAnimationFrame(wait)
        }
      }
      wait()
    })`,
  }).then((result: any) => result.result.value)

  assert.equal(matched, true, description)
}
