import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Console, Effect, FileSystem, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'

import {
  CHROME_PLATFORMS,
  assessChromeSupport,
  chromeSupportPolicy,
  createBumpedChromeSupportPolicy,
  isChromeStableVersions,
  parseLatestStableVersion,
  type ChromePlatform,
  type ChromeStableVersions,
  type ChromeSupportPolicy
} from '../src/extension/chrome-support.js'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const POLICY_FILE = join(REPO_ROOT, 'chrome-support.json')
const MANIFEST_FILE = join(REPO_ROOT, 'extension/manifest.json')
const VERSION_HISTORY_BASE_URL = 'https://versionhistory.googleapis.com/v1/chrome/platforms'
const VERSION_HISTORY_TIMEOUT_MS = 5_000
const require = createRequire(import.meta.url)

type ChromeSupportCommand = 'check' | 'bump' | 'release-check'

class ChromeSupportCliError extends Schema.TaggedErrorClass<ChromeSupportCliError>()(
  'ChromeSupportCliError',
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `${this.operation}: ${detail}`
  }
}

const generatedManifestSchema = Schema.Struct({
  minimum_chrome_version: Schema.String
})

const playwrightBrowsersMetadataSchema = Schema.Struct({
  browsers: Schema.Array(Schema.Unknown)
})

const defaultPlaywrightChromiumSchema = Schema.Struct({
  name: Schema.Literals(['chromium']),
  installByDefault: Schema.Literals([true]),
  browserVersion: Schema.optionalKey(Schema.Unknown)
})

const isGeneratedManifest = Schema.is(generatedManifestSchema)
const isPlaywrightBrowsersMetadata = Schema.is(playwrightBrowsersMetadataSchema)
const isDefaultPlaywrightChromium = Schema.is(defaultPlaywrightChromiumSchema)

function errorMessage(error: unknown): string {
  if (error instanceof ChromeSupportCliError) return errorMessage(error.cause)
  return error instanceof Error ? error.message : String(error)
}

function chromeSupportError(operation: string, cause: unknown): ChromeSupportCliError {
  return ChromeSupportCliError.make({ operation, cause })
}

export function assertGeneratedManifestMatchesPolicy(
  value: unknown,
  policy: ChromeSupportPolicy
): void {
  const expected = String(policy.minimumMajor)
  if (!isGeneratedManifest(value) || value.minimum_chrome_version !== expected) {
    throw new Error(
      `extension/manifest.json must set minimum_chrome_version to ${expected}; run pnpm build`
    )
  }
}

export function assertBrowserTestFloorMatchesPolicy(
  browserVersion: unknown,
  policy: ChromeSupportPolicy
): void {
  const match = typeof browserVersion === 'string'
    ? /^(\d+)\./.exec(browserVersion)
    : null
  const browserMajor = match?.[1] ? Number.parseInt(match[1], 10) : null
  if (browserMajor !== policy.minimumMajor) {
    throw new Error(
      `Playwright must bundle Chromium ${policy.minimumMajor}.x for minimum-version tests; ` +
      `found ${String(browserVersion)}. Update @playwright/test to a matching release.`
    )
  }
}

export function parsePlaywrightChromiumVersion(value: unknown): unknown {
  if (!isPlaywrightBrowsersMetadata(value)) return null
  const chromium = value.browsers.find(isDefaultPlaywrightChromium)
  return chromium ? chromium.browserVersion : null
}

const playwrightChromiumVersion = Effect.fn('chromeSupport.playwrightChromiumVersion')(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const browsersFile = yield* Effect.try({
    try: () => {
      const playwrightTestPackage = require.resolve('@playwright/test/package.json')
      const playwrightRequire = createRequire(playwrightTestPackage)
      const playwrightPackage = playwrightRequire.resolve('playwright/package.json')
      const playwrightCoreRequire = createRequire(playwrightPackage)
      const playwrightCorePackage = playwrightCoreRequire.resolve('playwright-core/package.json')
      return join(dirname(playwrightCorePackage), 'browsers.json')
    },
    catch: (cause) => chromeSupportError('resolve Playwright Chromium metadata', cause)
  })
  const source = yield* fileSystem.readFileString(browsersFile).pipe(
    Effect.mapError((cause) => chromeSupportError('read Playwright Chromium metadata', cause))
  )
  const metadata = yield* Effect.try({
    try: (): unknown => JSON.parse(source),
    catch: (cause) => chromeSupportError('parse Playwright Chromium metadata', cause)
  })
  return parsePlaywrightChromiumVersion(metadata)
})

export function chromeVersionHistoryUrl(platform: ChromePlatform): string {
  return `${VERSION_HISTORY_BASE_URL}/${platform}/channels/stable/versions?` +
    'page_size=1&order_by=version%20desc'
}

const fetchVersionHistory = Effect.fn('chromeSupport.fetchVersionHistory')(function*(platform: ChromePlatform) {
  return yield* HttpClient.get(chromeVersionHistoryUrl(platform), {
    headers: { accept: 'application/json' }
  }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout(VERSION_HISTORY_TIMEOUT_MS),
    Effect.mapError((cause) => chromeSupportError(`fetch Chrome Stable for ${platform}`, cause))
  )
})

const observeChromeStable = Effect.fn('chromeSupport.observeChromeStable')(function*() {
  const entries = yield* Effect.forEach(CHROME_PLATFORMS, (platform) => fetchVersionHistory(platform).pipe(
    Effect.flatMap((value) => Effect.try({
      try: (): readonly [ChromePlatform, string] => [
        platform,
        parseLatestStableVersion(value, platform)
      ],
      catch: (cause) => chromeSupportError(`parse Chrome Stable for ${platform}`, cause)
    }))
  ), { concurrency: 'unbounded' })
  const versions = Object.fromEntries(entries)
  if (!isChromeStableVersions(versions)) {
    return yield* Effect.fail(chromeSupportError(
      'observe Chrome Stable',
      new TypeError('Chrome Stable observation is missing a supported platform')
    ))
  }
  return versions
})

function formatStableVersions(versions: ChromeStableVersions): string {
  return CHROME_PLATFORMS.map((platform) => `${platform}=${versions[platform]}`).join(', ')
}

const readJsonFile = Effect.fn('chromeSupport.readJsonFile')(function*(filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const source = yield* fileSystem.readFileString(filePath).pipe(
    Effect.mapError((cause) => chromeSupportError(`read ${filePath}`, cause))
  )
  return yield* Effect.try({
    try: (): unknown => JSON.parse(source),
    catch: (cause) => chromeSupportError(`parse ${filePath}`, cause)
  })
})

const assertManifestIsCurrent = Effect.fn('chromeSupport.assertManifestIsCurrent')(function*() {
  const manifest = yield* readJsonFile(MANIFEST_FILE)
  yield* Effect.try({
    try: () => assertGeneratedManifestMatchesPolicy(manifest, chromeSupportPolicy),
    catch: (cause) => chromeSupportError('validate generated manifest', cause)
  })
})

const observeAndReport = Effect.fn('chromeSupport.observeAndReport')(function*() {
  const stableVersions = yield* observeChromeStable()
  yield* Console.log(`Chrome Stable: ${formatStableVersions(stableVersions)}`)
  return {
    stableVersions,
    assessment: assessChromeSupport(chromeSupportPolicy, stableVersions)
  }
})

const runCheck = Effect.fn('chromeSupport.check')(function*() {
  yield* assertManifestIsCurrent()
  const browserVersion = yield* playwrightChromiumVersion()
  yield* Effect.try({
    try: () => assertBrowserTestFloorMatchesPolicy(browserVersion, chromeSupportPolicy),
    catch: (cause) => chromeSupportError('validate browser test floor', cause)
  })
  yield* Console.log(`Chrome support is internally consistent at Chrome ${chromeSupportPolicy.minimumMajor}.`)
})

const runReleaseCheck = Effect.fn('chromeSupport.releaseCheck')(function*() {
  yield* assertManifestIsCurrent()
  const { assessment } = yield* observeAndReport()
  if (assessment.status === 'unsupported') {
    return yield* Effect.fail(chromeSupportError(
      'release check',
      new Error(
        `Chrome ${assessment.committedMinimumMajor} is above the safe cross-platform floor ` +
        `${assessment.desiredMinimumMajor}; review the policy instead of lowering it automatically.`
      )
    ))
  }
  if (assessment.status === 'behind') {
    return yield* Effect.fail(chromeSupportError(
      'release check',
      new Error(
        `Chrome support is stale: expected ${assessment.desiredMinimumMajor}, ` +
        `found ${assessment.committedMinimumMajor}. Run pnpm chrome-support:bump.`
      )
    ))
  }
  yield* Console.log(`Chrome ${assessment.committedMinimumMajor} remains the latest-two support floor.`)
})

const runBump = Effect.fn('chromeSupport.bump')(function*() {
  yield* assertManifestIsCurrent()
  const { stableVersions, assessment } = yield* observeAndReport()
  if (assessment.status === 'unsupported') {
    return yield* Effect.fail(chromeSupportError(
      'bump support floor',
      new Error(
        `Chrome ${assessment.committedMinimumMajor} is above the safe cross-platform floor ` +
        `${assessment.desiredMinimumMajor}; review the policy instead of lowering it automatically.`
      )
    ))
  }
  if (assessment.status === 'current') {
    yield* Console.log(`Chrome ${assessment.committedMinimumMajor} remains the latest-two support floor.`)
    return
  }

  const bumpedPolicy = yield* Effect.try({
    try: () => createBumpedChromeSupportPolicy(
      chromeSupportPolicy,
      stableVersions,
      new Date()
    ),
    catch: (cause) => chromeSupportError('create bumped Chrome support policy', cause)
  })
  if (!bumpedPolicy) return
  const fileSystem = yield* FileSystem.FileSystem
  yield* fileSystem.writeFileString(POLICY_FILE, `${JSON.stringify(bumpedPolicy, null, 2)}\n`).pipe(
    Effect.mapError((cause) => chromeSupportError('write chrome-support.json', cause))
  )
  yield* Console.log(
    `Updated chrome-support.json from Chrome ${assessment.committedMinimumMajor} to ` +
    `${assessment.desiredMinimumMajor}. Review the generated diff before committing.`
  )
})

function parseCommand(value: string | undefined): ChromeSupportCommand | null {
  return value === 'check' || value === 'bump' || value === 'release-check' ? value : null
}

function chromeSupportProgram(argv: readonly string[]) {
  const command = argv.length === 1 ? parseCommand(argv[0]) : null
  if (!command) {
    return Console.error('Usage: chrome-support.ts <check|bump|release-check>').pipe(
      Effect.as(2)
    )
  }

  const program = command === 'check'
    ? runCheck()
    : command === 'bump'
      ? runBump()
      : runReleaseCheck()
  return program.pipe(
    Effect.as(0),
    Effect.catch((error) => Console.error(
      `Chrome support check failed: ${errorMessage(error)}`
    ).pipe(Effect.as(1)))
  )
}

function provideChromeSupportNodeServices<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | HttpClient.HttpClient>) {
  return effect.pipe(
    Effect.provide(NodeHttpClient.layerUndici),
    Effect.provide(NodeServices.layer)
  )
}

if (import.meta.main) {
  provideChromeSupportNodeServices(chromeSupportProgram(process.argv.slice(2))).pipe(
    Effect.tap((exitCode) => Effect.sync(() => {
      process.exitCode = exitCode
    })),
    NodeRuntime.runMain
  )
}
