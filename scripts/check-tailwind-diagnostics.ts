#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Console,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Queue,
  Ref,
  Schema,
  Stream
} from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import {
  isUnknownRecord,
  parseJsonRpcMessage,
  requireConfigurationParams,
  requirePublishedDiagnosticsParams,
  type Diagnostic,
  type JsonRpcMessage
} from './tailwind-language-server-protocol.ts'

class TailwindDiagnosticsError extends Schema.TaggedErrorClass<TailwindDiagnosticsError>()(
  'TailwindDiagnosticsError',
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

type PendingRequest = Deferred.Deferred<unknown, TailwindDiagnosticsError>

type LanguageServerState = {
  diagnosticsByUri: Map<string, readonly Diagnostic[]>
  publishedUris: Set<string>
  pendingRequests: Map<number, PendingRequest>
  nextRequestId: number
  outputBuffer: Buffer
  lastDiagnosticsAt: number
}

const workspaceRoot = process.cwd()
const workspaceUri = pathToFileURL(`${workspaceRoot}${path.sep}`).href
const serverPackagePath = fileURLToPath(import.meta.resolve('@tailwindcss/language-server/package.json'))
const serverScript = path.join(path.dirname(serverPackagePath), 'bin', 'tailwindcss-language-server')
const supportedExtensions = new Set(['.css', '.html', '.js', '.jsx', '.ts', '.tsx'])

const tailwindSettings = {
  validate: true,
  hovers: false,
  suggestions: false,
  codeActions: true,
  classAttributes: ['class', 'className', 'ngClass', 'toastOptions', 'positionerClassName'],
  classFunctions: ['cn', 'clsx'],
  files: {
    exclude: ['**/.git/**', '**/node_modules/**']
  },
  lint: {
    invalidScreen: 'error',
    invalidVariant: 'error',
    deprecatedAtRule: 'warning',
    invalidTailwindDirective: 'error',
    invalidApply: 'error',
    invalidConfigPath: 'error',
    cssConflict: 'warning',
    recommendedVariantOrder: 'warning',
    usedBlocklistedClass: 'warning',
    suggestCanonicalClasses: 'warning'
  },
  experimental: {
    configFile: 'src/styles/app.css',
    classRegex: [
      ['add\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['cva\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['clsx\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['cn\\(([^)]*)\\)', '["\'`]([^"\'`]*).*?["\'`]'],
      ['cx\\(([^)]*)\\)', '(?:\'|"|`)([^\']*)(?:\'|"|`)'],
      'twc\\.[^`]+`([^`]*)`',
      'twc\\(.*?\\).*?`([^`]*)`',
      ['twc\\.[^`]+\\(([^)]*)\\)', '(?:\'|"|`)([^\']*)(?:\'|"|`)'],
      ['twc\\(.*?\\).*?\\(([^)]*)\\)', '(?:\'|"|`)([^\']*)(?:\'|"|`)']
    ]
  }
}

function diagnosticsError(operation: string, cause: unknown): TailwindDiagnosticsError {
  return TailwindDiagnosticsError.make({ operation, cause })
}

const sourceFiles = Effect.fn('tailwindDiagnostics.sourceFiles')(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = yield* spawner.string(ChildProcess.make(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'extension/base.css'],
    { cwd: workspaceRoot }
  )).pipe(
    Effect.mapError((cause) => diagnosticsError('list source files', cause))
  )

  return [...new Set(output.split('\n'))]
    .filter((file) => file.length > 0)
    .filter((file) => supportedExtensions.has(path.extname(file)))
    .sort()
})

function languageIdFor(file: string): string {
  if (file === 'src/styles/app.css') return 'tailwindcss'

  switch (path.extname(file)) {
    case '.css':
      return 'css'
    case '.html':
      return 'html'
    case '.js':
      return 'javascript'
    case '.jsx':
      return 'javascriptreact'
    case '.ts':
      return 'typescript'
    case '.tsx':
      return 'typescriptreact'
    default:
      throw new Error(`Unsupported source file: ${file}`)
  }
}

function send(input: Queue.Queue<Uint8Array>, message: unknown): Effect.Effect<void, TailwindDiagnosticsError> {
  return Effect.try({
    try: () => {
      const body = JSON.stringify(message)
      return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    },
    catch: (cause) => diagnosticsError('encode JSON-RPC message', cause)
  }).pipe(
    Effect.flatMap((chunk) => Queue.offer(input, chunk)),
    Effect.asVoid
  )
}

function respond(
  input: Queue.Queue<Uint8Array>,
  id: number | string,
  result: unknown
): Effect.Effect<void, TailwindDiagnosticsError> {
  return send(input, { jsonrpc: '2.0', id, result })
}

function request(
  state: LanguageServerState,
  input: Queue.Queue<Uint8Array>,
  method: string,
  params: unknown
): Effect.Effect<unknown, TailwindDiagnosticsError> {
  return Effect.gen(function*() {
    const id = state.nextRequestId++
    const pending = yield* Deferred.make<unknown, TailwindDiagnosticsError>()
    state.pendingRequests.set(id, pending)
    yield* send(input, { jsonrpc: '2.0', id, method, params })
    return yield* Deferred.await(pending).pipe(
      Effect.ensuring(Effect.sync(() => state.pendingRequests.delete(id)))
    )
  })
}

function notify(
  input: Queue.Queue<Uint8Array>,
  method: string,
  params?: unknown
): Effect.Effect<void, TailwindDiagnosticsError> {
  return send(input, { jsonrpc: '2.0', method, params })
}

function configurationFor(section: string | undefined): unknown {
  if (section === 'tailwindCSS') return tailwindSettings
  if (section?.startsWith('tailwindCSS.')) {
    let value: unknown = tailwindSettings
    for (const key of section.slice('tailwindCSS.'.length).split('.')) {
      if (!isUnknownRecord(value)) return undefined
      value = value[key]
    }
    return value
  }
  if (section === 'editor') return { tabSize: 2 }
  return null
}

function handleServerRequest(
  input: Queue.Queue<Uint8Array>,
  message: JsonRpcMessage
): Effect.Effect<void, TailwindDiagnosticsError> {
  if (message.id === undefined || !message.method) return Effect.void
  const messageId = message.id

  if (message.method === 'workspace/configuration') {
    return Effect.try({
      try: () => requireConfigurationParams(message.params),
      catch: (cause) => diagnosticsError('validate workspace configuration request', cause)
    }).pipe(
      Effect.flatMap(({ items }) => respond(
        input,
        messageId,
        items.map((item) => configurationFor(item.section))
      ))
    )
  }

  switch (message.method) {
    case 'workspace/workspaceFolders':
      return respond(input, messageId, [{ uri: workspaceUri, name: path.basename(workspaceRoot) }])
    case 'workspace/applyEdit':
      return respond(input, messageId, { applied: false })
    default:
      return respond(input, messageId, null)
  }
}

function handleMessage(
  state: LanguageServerState,
  input: Queue.Queue<Uint8Array>,
  message: JsonRpcMessage
): Effect.Effect<void, TailwindDiagnosticsError> {
  if (message.method && message.id !== undefined) {
    return handleServerRequest(input, message)
  }

  if (typeof message.id === 'number') {
    const pending = state.pendingRequests.get(message.id)
    if (!pending) return Effect.void
    state.pendingRequests.delete(message.id)
    return message.error
      ? Deferred.fail(pending, diagnosticsError(`JSON-RPC request ${message.id}`, new Error(message.error.message))).pipe(
        Effect.asVoid
      )
      : Deferred.succeed(pending, message.result).pipe(Effect.asVoid)
  }

  if (message.method === 'textDocument/publishDiagnostics') {
    return Effect.try({
      try: () => requirePublishedDiagnosticsParams(message.params),
      catch: (cause) => diagnosticsError('validate published diagnostics', cause)
    }).pipe(
      Effect.tap(({ uri, diagnostics }) => Effect.sync(() => {
        state.diagnosticsByUri.set(uri, diagnostics)
        state.publishedUris.add(uri)
        state.lastDiagnosticsAt = Date.now()
      })),
      Effect.asVoid
    )
  }

  return Effect.void
}

function parseServerOutput(state: LanguageServerState, chunk: Uint8Array): JsonRpcMessage[] {
  state.outputBuffer = Buffer.concat([state.outputBuffer, Buffer.from(chunk)])
  const messages: JsonRpcMessage[] = []

  while (true) {
    const headerEnd = state.outputBuffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return messages

    const header = state.outputBuffer.subarray(0, headerEnd).toString('utf8')
    const contentLengthMatch = header.match(/Content-Length: (\d+)/i)
    if (!contentLengthMatch) throw new Error(`Invalid language-server header: ${header}`)

    const contentLength = Number(contentLengthMatch[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (state.outputBuffer.length < bodyEnd) return messages

    const body = state.outputBuffer.subarray(bodyStart, bodyEnd).toString('utf8')
    state.outputBuffer = state.outputBuffer.subarray(bodyEnd)
    messages.push(parseJsonRpcMessage(body))
  }
}

const waitForDiagnostics = Effect.fn('tailwindDiagnostics.waitForDiagnostics')(function*(
  state: LanguageServerState,
  expectedUris: readonly string[]
) {
  const timeoutAt = Date.now() + 30_000
  const expectedUriSet = new Set(expectedUris)

  while (Date.now() < timeoutAt) {
    const allPublished = expectedUriSet.isSubsetOf(state.publishedUris)
    const settled = allPublished && Date.now() - state.lastDiagnosticsAt >= 500
    if (settled) return
    yield* Effect.sleep('100 millis')
  }

  const missingCount = expectedUriSet.difference(state.publishedUris).size
  return yield* Effect.fail(diagnosticsError(
    'wait for diagnostics',
    new Error(
      `Timed out waiting for Tailwind diagnostics (${state.publishedUris.size}/${expectedUris.length} documents; missing ${missingCount})`
    )
  ))
})

function severityName(severity: number | undefined): string {
  if (severity === undefined) return 'unknown'
  return ['unknown', 'error', 'warning', 'information', 'hint'][severity] ?? 'unknown'
}

function relativeFileForUri(uri: string): string {
  return path.relative(workspaceRoot, fileURLToPath(uri))
}

const runTailwindDiagnostics = Effect.fn('tailwindDiagnostics.run')(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const files = yield* sourceFiles()
  const documents = yield* Effect.forEach(files, (file) => {
    const absolutePath = path.join(workspaceRoot, file)
    return fileSystem.readFileString(absolutePath).pipe(
      Effect.mapError((cause) => diagnosticsError(`read ${file}`, cause)),
      Effect.map((text) => ({
        file,
        uri: pathToFileURL(absolutePath).href,
        languageId: languageIdFor(file),
        text
      }))
    )
  }, { concurrency: 'unbounded' })

  const state: LanguageServerState = {
    diagnosticsByUri: new Map(),
    publishedUris: new Set(),
    pendingRequests: new Map(),
    nextRequestId: 1,
    outputBuffer: Buffer.alloc(0),
    lastDiagnosticsAt: 0
  }
  const serverInput = yield* Queue.unbounded<Uint8Array>()
  const serverErrors = yield* Ref.make('')
  const server = yield* ChildProcess.make(process.execPath, [serverScript, '--stdio'], {
    cwd: workspaceRoot,
    env: process.env,
    stdin: {
      stream: Stream.fromQueue(serverInput),
      endOnDone: true
    },
    stdout: 'pipe',
    stderr: 'pipe'
  }).pipe(
    Effect.mapError((cause) => diagnosticsError('start Tailwind language server', cause))
  )

  const stdoutFiber = yield* server.stdout.pipe(
    Stream.runForEach((chunk) => Effect.try({
      try: () => parseServerOutput(state, chunk),
      catch: (cause) => diagnosticsError('parse Tailwind language-server output', cause)
    }).pipe(
      Effect.flatMap((messages) => Effect.forEach(
        messages,
        (message) => handleMessage(state, serverInput, message),
        { discard: true }
      ))
    )),
    Effect.forkScoped
  )
  yield* server.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(serverErrors, (current) => current + chunk)),
    Effect.catchCause((cause) => Ref.update(serverErrors, (current) => `${current}${String(cause)}`)),
    Effect.forkScoped
  )

  const gracefulShutdown = request(state, serverInput, 'shutdown', null).pipe(
    Effect.andThen(notify(serverInput, 'exit')),
    Effect.andThen(server.exitCode),
    Effect.asVoid,
    Effect.timeoutOrElse({
      duration: '2 seconds',
      orElse: () => server.kill()
    }),
    Effect.ignoreCause
  )
  yield* Effect.addFinalizer(() => gracefulShutdown)

  const protocol = Effect.gen(function*() {
    yield* request(state, serverInput, 'initialize', {
      processId: process.pid,
      clientInfo: { name: 'tab-out-tailwind-check' },
      rootPath: workspaceRoot,
      rootUri: workspaceUri,
      workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspaceRoot) }],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: false }
        },
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true
          }
        },
        window: { workDoneProgress: true }
      },
      initializationOptions: {}
    })

    yield* notify(serverInput, 'initialized', {})
    yield* notify(serverInput, 'workspace/didChangeConfiguration', {
      settings: { tailwindCSS: tailwindSettings }
    })

    yield* Effect.forEach(documents, (document) => notify(serverInput, 'textDocument/didOpen', {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: 1,
        text: document.text
      }
    }), { discard: true })

    yield* waitForDiagnostics(state, documents.map((document) => document.uri))
  })
  const unexpectedServerExit = Fiber.join(stdoutFiber).pipe(
    Effect.flatMap(() => Effect.fail(diagnosticsError(
      'read Tailwind language-server output',
      new Error('Tailwind language server closed stdout before diagnostics completed')
    )))
  )
  yield* protocol.pipe(
    Effect.raceFirst(unexpectedServerExit),
    Effect.tapError(() => Ref.get(serverErrors).pipe(
      Effect.flatMap((errors) => errors.trim() ? Console.error(errors.trim()) : Effect.void)
    ))
  )

  const diagnostics = [...state.diagnosticsByUri]
    .flatMap(([uri, entries]) => entries.map((diagnostic) => ({ uri, ...diagnostic })))
    .sort((left, right) => {
      const fileOrder = relativeFileForUri(left.uri).localeCompare(relativeFileForUri(right.uri))
      if (fileOrder !== 0) return fileOrder
      if (left.range.start.line !== right.range.start.line) return left.range.start.line - right.range.start.line
      return left.range.start.character - right.range.start.character
    })

  for (const diagnostic of diagnostics) {
    const file = relativeFileForUri(diagnostic.uri)
    const line = diagnostic.range.start.line + 1
    const column = diagnostic.range.start.character + 1
    const code = diagnostic.code ? ` ${diagnostic.code}` : ''
    yield* Console.error(
      `${file}:${line}:${column} ${severityName(diagnostic.severity)}${code}: ${diagnostic.message}`
    )
  }

  if (diagnostics.length > 0) {
    yield* Console.error(`\nTailwind diagnostics: ${diagnostics.length} across ${documents.length} documents.`)
    const errors = yield* Ref.get(serverErrors)
    if (errors.trim()) yield* Console.error(errors.trim())
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  } else {
    yield* Console.log(`Tailwind diagnostics: 0 across ${documents.length} documents.`)
  }
})

runTailwindDiagnostics().pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
