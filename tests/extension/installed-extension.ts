import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
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

interface IsolatedExtensionFiles {
  readonly artifactDirectory: string
  readonly profileDirectory: string
  readonly temporaryDirectory: string
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

async function listFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(path))
      continue
    }
    if (entry.isFile()) files.push(path)
  }

  return files
}

async function findInstrumentationMarker(
  artifactDirectory: string
): Promise<readonly string[]> {
  const bundleDirectory = join(artifactDirectory, 'dist')
  const bundleFiles = (await listFiles(bundleDirectory))
    .filter((path) => extname(path) === '.js')
  const matches: string[] = []

  for (const bundleFile of bundleFiles) {
    const content = await readFile(bundleFile, 'utf8')
    if (content.includes(RETENTION_TEST_INSTRUMENTATION_MARKER)) {
      matches.push(relative(artifactDirectory, bundleFile))
    }
  }

  return matches.sort()
}

async function createIsolatedExtensionFiles(): Promise<IsolatedExtensionFiles> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tab-out-extension-smoke-'))
  const artifactDirectory = join(temporaryDirectory, 'extension')
  const profileDirectory = join(temporaryDirectory, 'profile')

  try {
    await cp(builtExtensionDirectory, artifactDirectory, {
      errorOnExist: true,
      force: false,
      recursive: true
    })
    await mkdir(profileDirectory)
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true })
    throw error
  }

  return {
    artifactDirectory,
    profileDirectory,
    temporaryDirectory
  }
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
    const isolatedFiles = await createIsolatedExtensionFiles()
    const markerMatches = await findInstrumentationMarker(
      isolatedFiles.artifactDirectory
    )
    const errors = new RuntimeErrorCollector()
    let context: BrowserContext | undefined

    try {
      context = await chromium.launchPersistentContext(isolatedFiles.profileDirectory, {
        args: [
          `--disable-extensions-except=${isolatedFiles.artifactDirectory}`,
          `--load-extension=${isolatedFiles.artifactDirectory}`
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
        artifactDirectory: isolatedFiles.artifactDirectory,
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
          // Preserve the test result while still removing the disposable profile below.
        }
      }
      await rm(isolatedFiles.temporaryDirectory, { force: true, recursive: true })
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
