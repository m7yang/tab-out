import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import process from 'node:process'

import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Effect, FileSystem, Option, Schema } from 'effect'
import * as HttpPlatform from 'effect/unstable/http/HttpPlatform'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'

// Dev-only static server for manually debugging the dashboard UI in a plain
// browser. Serves the repo root so tests/fixtures/dashboard-resize.html (which
// mocks chrome.* with fake tabs) can load the built extension/dist/app.js.
// The extension itself ships no server — this is purely a local debugging aid.
// See docs/debugging-the-dashboard.md.

const ROOT = resolve('.')
const DEFAULT_PORT = 8765
const HOST = '127.0.0.1'
const DASHBOARD_FIXTURE = resolve(ROOT, 'tests/fixtures/dashboard-resize.html')
const GENERATED_INDEX = resolve(ROOT, 'extension/index.html')
const APP_ROOT_START = '<!-- TAB_OUT_APP_ROOT_START -->'
const APP_ROOT_END = '<!-- TAB_OUT_APP_ROOT_END -->'
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml'
}

export class DebugServerError extends Schema.TaggedErrorClass<DebugServerError>()(
  'DebugServerError',
  {
    port: Schema.Int,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `debug server on port ${this.port}: ${detail}`
  }
}

export type DashboardDebugServerOptions = {
  readonly port: number
  readonly awaitShutdown: Effect.Effect<void>
  readonly onListening?: ((port: number) => void) | undefined
}

function markedAppRoot(source: string): string {
  const start = source.indexOf(APP_ROOT_START)
  const end = source.indexOf(APP_ROOT_END, start)
  if (start < 0 || end < 0) throw new Error('Dashboard page is missing generated app-root markers')
  return source.slice(start, end + APP_ROOT_END.length)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const resolveRequestTarget = Option.liftThrowable((requestUrl: string) => {
  const url = new URL(requestUrl, `http://${HOST}`)
  return resolve(ROOT, `.${decodeURIComponent(url.pathname)}`)
})

function makeRequestHandler(
  fileSystem: FileSystem.FileSystem,
  httpPlatform: HttpPlatform.HttpPlatform['Service']
) {
  return Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const targetOption = resolveRequestTarget(request.url)
    if (Option.isNone(targetOption)) {
      return HttpServerResponse.text('Not found', { status: 404 })
    }

    const target = targetOption.value
    if (target !== ROOT && !target.startsWith(`${ROOT}${sep}`)) {
      return HttpServerResponse.text('Not found', { status: 404 })
    }
    const info = yield* fileSystem.stat(target).pipe(Effect.option)
    if (Option.isNone(info) || info.value.type !== 'File') {
      return HttpServerResponse.text('Not found', { status: 404 })
    }

    if (target === DASHBOARD_FIXTURE) {
      return yield* Effect.all([
        fileSystem.readFileString(DASHBOARD_FIXTURE),
        fileSystem.readFileString(GENERATED_INDEX)
      ] as const, { concurrency: 'unbounded' }).pipe(
        Effect.flatMap(([fixture, generatedIndex]) => Effect.try(() => {
          const fixtureStart = fixture.indexOf(APP_ROOT_START)
          const fixtureEnd = fixture.indexOf(APP_ROOT_END, fixtureStart)
          if (fixtureStart < 0 || fixtureEnd < 0) {
            throw new Error('Dashboard fixture is missing app-root markers')
          }
          const body = fixture.slice(0, fixtureStart) + markedAppRoot(generatedIndex) +
            fixture.slice(fixtureEnd + APP_ROOT_END.length)
          return HttpServerResponse.html(body)
        })),
        Effect.catch((error) => Effect.succeed(HttpServerResponse.text(errorMessage(error), { status: 500 })))
      )
    }

    return yield* HttpServerResponse.file(target, {
      contentType: CONTENT_TYPES[extname(target)] || 'application/octet-stream'
    }).pipe(
      Effect.provideService(HttpPlatform.HttpPlatform, httpPlatform),
      Effect.catch((error) => Effect.succeed(HttpServerResponse.text(errorMessage(error), { status: 500 })))
    )
  })
}

const runDashboardDebugServerScoped = Effect.fn('debugServer.run')(function*(
  options: DashboardDebugServerOptions
) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    return yield* Effect.fail(DebugServerError.make({
      port: options.port,
      cause: new RangeError(`Invalid debug server port: ${options.port}`)
    }))
  }

  const fileSystem = yield* FileSystem.FileSystem
  const httpPlatform = yield* HttpPlatform.HttpPlatform
  const server = yield* NodeHttpServer.make(createServer, {
    host: HOST,
    port: options.port,
    gracefulShutdownTimeout: '2 seconds'
  }).pipe(
    Effect.mapError((cause) => DebugServerError.make({ port: options.port, cause }))
  )
  yield* server.serve(makeRequestHandler(fileSystem, httpPlatform))
  const boundPort = server.address._tag === 'TcpAddress' ? server.address.port : options.port
  yield* Effect.sync(() => options.onListening?.(boundPort))
  yield* options.awaitShutdown
})

export function runDashboardDebugServer(
  options: DashboardDebugServerOptions
): Effect.Effect<void, DebugServerError> {
  return runDashboardDebugServerScoped(options).pipe(
    Effect.scoped,
    Effect.provide(NodeHttpServer.layerHttpServices)
  )
}

function debugServerProgram(): Effect.Effect<number> {
  const port = Number(process.env.PORT) || DEFAULT_PORT
  return runDashboardDebugServer({
    port,
    awaitShutdown: Effect.never,
    onListening: (boundServerPort) => {
      process.stdout.write(`Tab Out debug server  http://${HOST}:${boundServerPort}\n`)
      process.stdout.write(
        `Dashboard fixture      http://${HOST}:${boundServerPort}/tests/fixtures/dashboard-resize.html\n`
      )
    }
  }).pipe(
    Effect.as(0),
    Effect.catchTag('DebugServerError', (error) => Effect.sync(() => {
      console.error(`Tab Out debug server failed on port ${error.port}: ${errorMessage(error.cause)}`)
      return 1
    }))
  )
}

if (import.meta.main) {
  debugServerProgram().pipe(
    Effect.tap((exitCode) => Effect.sync(() => {
      process.exitCode = exitCode
    })),
    NodeRuntime.runMain
  )
}
