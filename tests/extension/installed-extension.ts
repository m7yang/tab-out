import { cp, glob, mkdir, mkdtempDisposable, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  chromium,
  test as base
} from '@playwright/test'
import type {
  BrowserContext,
  ConsoleMessage,
  Page,
  Worker
} from '@playwright/test'

export const RETENTION_TEST_INSTRUMENTATION_MARKER =
  '__TAB_OUT_RETENTION_TEST_INSTRUMENTATION__'

type RuntimeErrorSource = 'page' | 'page-console' | 'worker-console'

interface RuntimeErrorObservation {
  readonly source: RuntimeErrorSource
  readonly message: string
  readonly url: string
}

export interface InstalledExtension {
  readonly artifactDirectory: string
  readonly context: BrowserContext
  readonly extensionId: string
  readonly markerMatches: readonly string[]
  readonly runtimeErrors: () => readonly RuntimeErrorObservation[]
  readonly serviceWorker: Worker
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const builtExtensionDirectory = join(repositoryRoot, 'extension')

async function findInstrumentationMarker(
  artifactDirectory: string
): Promise<readonly string[]> {
  const matches: string[] = []

  for await (const bundleFile of glob('dist/**/*.js', { cwd: artifactDirectory })) {
    const content = await readFile(join(artifactDirectory, bundleFile), 'utf8')
    if (content.includes(RETENTION_TEST_INSTRUMENTATION_MARKER)) {
      matches.push(bundleFile)
    }
  }

  return matches.sort()
}

function isTabOutServiceWorker(worker: Worker): boolean {
  const url = new URL(worker.url())
  return url.protocol === 'chrome-extension:' && url.pathname === '/dist/background.js'
}

class RuntimeErrorCollector {
  readonly #observations = new Map<string, RuntimeErrorObservation>()
  readonly #pages = new WeakSet<Page>()
  readonly #workers = new WeakSet<Worker>()

  attach(context: BrowserContext): void {
    context.on('console', (message) => {
      if (message.type() !== 'error' || message.page() === null) return
      this.#recordConsole('page-console', message)
    })
    context.on('weberror', (webError) => {
      const location = webError.location()
      this.#record({
        source: 'page',
        message: webError.error().message,
        url: location.url
      })
    })
    context.on('page', (page) => this.#attachPage(page))
    context.on('serviceworker', (worker) => this.#attachWorker(worker))

    for (const page of context.pages()) this.#attachPage(page)
    for (const worker of context.serviceWorkers()) this.#attachWorker(worker)
  }

  snapshot(): readonly RuntimeErrorObservation[] {
    return [...this.#observations.values()]
  }

  #attachPage(page: Page): void {
    if (this.#pages.has(page)) return
    this.#pages.add(page)
    page.on('pageerror', (error) => {
      this.#record({
        source: 'page',
        message: error.message,
        url: page.url()
      })
    })
  }

  #attachWorker(worker: Worker): void {
    if (this.#workers.has(worker)) return
    this.#workers.add(worker)
    worker.on('console', (message) => {
      if (message.type() !== 'error') return
      this.#recordConsole('worker-console', message)
    })
  }

  #recordConsole(source: RuntimeErrorSource, message: ConsoleMessage): void {
    this.#record({
      source,
      message: message.text(),
      url: message.location().url
    })
  }

  #record(observation: RuntimeErrorObservation): void {
    const key = `${observation.source}\u0000${observation.url}\u0000${observation.message}`
    this.#observations.set(key, observation)
  }
}

type InstalledExtensionWorkerFixtures = {
  installedExtension: InstalledExtension
}

export const test = base.extend<object, InstalledExtensionWorkerFixtures>({
  installedExtension: [async ({}, use) => {
    await using temporaryDirectory = await mkdtempDisposable(
      join(tmpdir(), 'tab-out-extension-smoke-')
    )
    const artifactDirectory = join(temporaryDirectory.path, 'extension')
    const profileDirectory = join(temporaryDirectory.path, 'profile')
    await cp(builtExtensionDirectory, artifactDirectory, {
      errorOnExist: true,
      force: false,
      recursive: true
    })
    await mkdir(profileDirectory)
    const markerMatches = await findInstrumentationMarker(artifactDirectory)
    const errors = new RuntimeErrorCollector()
    let context: BrowserContext | undefined

    try {
      context = await chromium.launchPersistentContext(profileDirectory, {
        args: [
          `--disable-extensions-except=${artifactDirectory}`,
          `--load-extension=${artifactDirectory}`
        ],
        channel: 'chromium',
        headless: true
      })
      errors.attach(context)

      const serviceWorker = context.serviceWorkers().find(isTabOutServiceWorker)
        ?? await context.waitForEvent('serviceworker', {
          predicate: isTabOutServiceWorker,
          timeout: 15_000
        })
      const extensionId = new URL(serviceWorker.url()).hostname

      await use({
        artifactDirectory,
        context,
        extensionId,
        markerMatches,
        runtimeErrors: () => errors.snapshot(),
        serviceWorker
      })
    } finally {
      if (context !== undefined) {
        try {
          await context.close()
        } catch {
          // Preserve the test result; the disposable directory still removes the profile.
        }
      }
    }

    const observedErrors = errors.snapshot()
    if (observedErrors.length > 0) {
      throw new Error(
        `Installed extension emitted runtime errors:\n${JSON.stringify(observedErrors, null, 2)}`
      )
    }
  }, { scope: 'worker', timeout: 45_000 }]
})

export { expect } from '@playwright/test'
