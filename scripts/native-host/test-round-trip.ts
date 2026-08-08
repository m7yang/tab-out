import { once } from 'node:events'
import { createServer, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Cause,
  Clock,
  Console,
  Effect,
  Fiber,
  FileSystem,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream
} from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

class NativeHostTestError extends Schema.TaggedErrorClass<NativeHostTestError>()(
  'NativeHostTestError',
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

class NativeSocketPending extends Schema.TaggedErrorClass<NativeSocketPending>()(
  'NativeSocketPending',
  { socketPath: Schema.String }
) {}

const NativeRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('status'),
  requestId: Schema.String,
  expiresAtMs: Schema.Number
})

const AcceptedResponse = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('response'),
  requestId: Schema.Literal('integration-round-trip'),
  status: Schema.Literal('accepted')
})

type RunningNativeHost = {
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  readonly input: Queue.Queue<Uint8Array, Cause.Done<void>>
  readonly stdoutFiber: Fiber.Fiber<void, NativeHostTestError>
  readonly stderrFiber: Fiber.Fiber<void, NativeHostTestError>
  readonly stderr: Ref.Ref<string>
}

function nativeHostTestError(operation: string, cause: unknown): NativeHostTestError {
  return NativeHostTestError.make({ operation, cause })
}

function check(
  condition: boolean,
  operation: string,
  message: string
): Effect.Effect<void, NativeHostTestError> {
  return condition
    ? Effect.void
    : Effect.fail(nativeHostTestError(operation, new Error(message)))
}

function collectText<E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<string, E, R> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(() => '', (output, chunk) => output + chunk)
  )
}

function encodeNativeMessage(message: unknown): Effect.Effect<Uint8Array, NativeHostTestError> {
  return Effect.try({
    try: () => {
      const body = Buffer.from(JSON.stringify(message))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32LE(body.length)
      return Buffer.concat([prefix, body])
    },
    catch: (cause) => nativeHostTestError('encode native messaging response', cause)
  })
}

function makeNativeRequestResponder(input: Queue.Queue<Uint8Array, Cause.Done<void>>) {
  let nativeBuffer = Buffer.alloc(0)
  const decodeRequest = Schema.decodeUnknownEffect(
    Schema.fromJsonString(NativeRequest),
    { onExcessProperty: 'error' }
  )

  return Effect.fn('nativeHostTest.respondToNativeRequest')(function*(chunk: Uint8Array) {
    nativeBuffer = Buffer.concat([nativeBuffer, chunk])

    while (nativeBuffer.length >= 4) {
      const messageLength = nativeBuffer.readUInt32LE(0)
      if (messageLength > 64 * 1024) {
        return yield* Effect.fail(nativeHostTestError(
          'decode native messaging request',
          new Error(`native message length ${messageLength} exceeds the protocol limit`)
        ))
      }
      if (nativeBuffer.length < messageLength + 4) return

      const body = nativeBuffer.subarray(4, messageLength + 4)
      nativeBuffer = nativeBuffer.subarray(messageLength + 4)
      const request = yield* decodeRequest(body.toString('utf8')).pipe(
        Effect.mapError((cause) => nativeHostTestError('decode native messaging request', cause))
      )
      const response = yield* encodeNativeMessage({
        version: 1,
        type: 'response',
        requestId: request.requestId,
        status: 'accepted'
      })
      yield* Queue.offer(input, response)
    }
  })
}

const startNativeHost = Effect.fn('nativeHostTest.startNativeHost')(function*(
  hostPath: string,
  socketPath: string,
  respondToRequests: boolean
) {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
  const stderr = yield* Ref.make('')
  const handle = yield* ChildProcess.make(
    hostPath,
    ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
    {
      env: { TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH: socketPath },
      extendEnv: true,
      stdin: {
        stream: Stream.fromQueue(input),
        endOnDone: true
      },
      stdout: respondToRequests ? 'pipe' : 'ignore',
      stderr: 'pipe'
    }
  ).pipe(
    Effect.mapError((cause) => nativeHostTestError('start native host', cause))
  )

  const stdoutFiber = yield* (respondToRequests
    ? handle.stdout.pipe(
        Stream.mapError((cause) => nativeHostTestError('read native host stdout', cause)),
        Stream.runForEach(makeNativeRequestResponder(input))
      )
    : Effect.void
  ).pipe(Effect.forkScoped)
  const stderrFiber = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.mapError((cause) => nativeHostTestError('read native host stderr', cause)),
    Stream.runForEach((chunk) => Ref.update(stderr, (current) => current + chunk)),
    Effect.forkScoped
  )

  yield* Effect.addFinalizer(() => Queue.end(input).pipe(
    Effect.andThen(handle.exitCode),
    Effect.asVoid,
    Effect.timeoutOrElse({
      duration: '2 seconds',
      orElse: () => handle.kill()
    }),
    Effect.ignoreCause
  ))

  return { handle, input, stdoutFiber, stderrFiber, stderr } satisfies RunningNativeHost
})

const finishNativeHost = Effect.fn('nativeHostTest.finishNativeHost')(function*(
  host: RunningNativeHost
) {
  yield* Queue.end(host.input)
  const exitCode = yield* host.handle.exitCode.pipe(
    Effect.mapError((cause) => nativeHostTestError('wait for native host', cause)),
    Effect.timeoutOrElse({
      duration: '2 seconds',
      orElse: () => host.handle.kill().pipe(
        Effect.mapError((cause) => nativeHostTestError('stop native host', cause)),
        Effect.andThen(host.handle.exitCode),
        Effect.mapError((cause) => nativeHostTestError('wait for stopped native host', cause))
      )
    })
  )
  yield* Fiber.join(host.stdoutFiber)
  yield* Fiber.join(host.stderrFiber)
  const stderr = yield* Ref.get(host.stderr)
  return { exitCode, stderr }
})

const waitForSocket = Effect.fn('nativeHostTest.waitForSocket')(function*(
  host: RunningNativeHost,
  socketPath: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const probe = fileSystem.access(socketPath).pipe(
    Effect.mapError(() => NativeSocketPending.make({ socketPath })),
    Effect.catchTag('NativeSocketPending', (pending) => Effect.gen(function*() {
      const isRunning = yield* host.handle.isRunning.pipe(
        Effect.mapError((cause) => nativeHostTestError('inspect native host', cause))
      )
      if (isRunning) return yield* Effect.fail(pending)

      const exitCode = yield* host.handle.exitCode.pipe(
        Effect.mapError((cause) => nativeHostTestError('wait for early native host exit', cause))
      )
      const stderr = yield* Ref.get(host.stderr)
      return yield* Effect.fail(nativeHostTestError(
        'wait for native host socket',
        new Error(`native host exited with code ${exitCode}: ${stderr}`)
      ))
    }))
  )

  yield* probe.pipe(
    Effect.retry({
      schedule: Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 199 })),
      while: (error) => error._tag === 'NativeSocketPending'
    }),
    Effect.catchTag('NativeSocketPending', () => Ref.get(host.stderr).pipe(
      Effect.flatMap((stderr) => Effect.fail(nativeHostTestError(
        'wait for native host socket',
        new Error(`native host did not create ${socketPath} within 10 seconds: ${stderr}`)
      )))
    ))
  )
})

const runClient = Effect.fn('nativeHostTest.runClient')(function*(
  hostPath: string,
  request: string,
  socketPath?: string
) {
  const handle = yield* ChildProcess.make(hostPath, ['--request', request], {
    env: socketPath === undefined ? {} : { TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH: socketPath },
    extendEnv: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('start native host client', cause))
  )

  const [stdout, stderr, exitCode] = yield* Effect.all([
    collectText(handle.stdout),
    collectText(handle.stderr),
    handle.exitCode
  ] as const, { concurrency: 'unbounded' }).pipe(
    Effect.mapError((cause) => nativeHostTestError('run native host client', cause))
  )

  return { stdout, stderr, exitCode }
})

function disposeServer(server: Server): Effect.Effect<void> {
  if (!server.listening) return Effect.void
  return Effect.tryPromise({
    try: () => server[Symbol.asyncDispose](),
    catch: (cause) => nativeHostTestError('close replacement socket server', cause)
  }).pipe(Effect.orDie)
}

function listenOnUnixSocket(socketPath: string) {
  return Effect.gen(function*() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer()),
      disposeServer
    )
    yield* Effect.tryPromise({
      try: (signal) => {
        server.listen(socketPath)
        return once(server, 'listening', { signal })
      },
      catch: (cause) => nativeHostTestError('start replacement socket server', cause)
    })
    return server
  })
}

const testRoundTrip = Effect.fn('nativeHostTest.roundTrip')(function*(hostPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: 'tab-out-native-bridge-'
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('create round-trip directory', cause))
  )
  const socketPath = join(temporaryDirectory, 'bridge.sock')
  const host = yield* startNativeHost(hostPath, socketPath, true)
  yield* waitForSocket(host, socketPath)

  const currentTime = yield* Clock.currentTimeMillis
  const request = JSON.stringify({
    version: 1,
    type: 'status',
    requestId: 'integration-round-trip',
    expiresAtMs: currentTime + 5_000
  })
  const client = yield* runClient(hostPath, request, socketPath)
  yield* check(
    client.exitCode === ChildProcessSpawner.ExitCode(0),
    'run round-trip client',
    client.stderr || `client exited with code ${client.exitCode}`
  )
  yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AcceptedResponse),
    { onExcessProperty: 'error' }
  )(client.stdout).pipe(
    Effect.mapError((cause) => nativeHostTestError('validate round-trip response', cause))
  )

  const result = yield* finishNativeHost(host)
  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(0),
    'stop round-trip native host',
    `native host exited with code ${result.exitCode}`
  )
  yield* check(result.stderr === '', 'inspect round-trip native host', result.stderr)
})

const testSocketHandoff = Effect.fn('nativeHostTest.socketHandoff')(function*(hostPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: 'tab-out-native-bridge-handoff-'
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('create handoff directory', cause))
  )
  const socketPath = join(temporaryDirectory, 'bridge.sock')
  const host = yield* startNativeHost(hostPath, socketPath, false)
  yield* waitForSocket(host, socketPath)
  yield* fileSystem.remove(socketPath).pipe(
    Effect.mapError((cause) => nativeHostTestError('unlink native host socket for handoff', cause))
  )
  yield* listenOnUnixSocket(socketPath)

  const result = yield* finishNativeHost(host)
  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(0),
    'stop handoff native host',
    `native host exited with code ${result.exitCode}`
  )
  yield* check(result.stderr === '', 'inspect handoff native host', result.stderr)
  yield* fileSystem.access(socketPath).pipe(
    Effect.mapError((cause) => nativeHostTestError(
      'verify replacement socket after native host shutdown',
      cause
    ))
  )
})

const testDeadlineOverflow = Effect.fn('nativeHostTest.deadlineOverflow')(function*(hostPath: string) {
  const result = yield* runClient(hostPath, JSON.stringify({
    version: 1,
    type: 'status',
    requestId: 'deadline-overflow',
    expiresAtMs: 1e100
  }))

  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(1),
    'validate overflowing deadline exit code',
    result.stderr || `client exited with code ${result.exitCode}`
  )
  yield* check(
    /deadline is too far in the future/.test(result.stderr),
    'validate overflowing deadline error',
    result.stderr
  )
})

const runNativeHostTests = Effect.fn('nativeHostTest.run')(function*() {
  const hostArgument = process.argv[2]
  if (!hostArgument) {
    return yield* Effect.fail(nativeHostTestError(
      'resolve native host',
      new Error('native host path is required')
    ))
  }
  const hostPath = resolve(hostArgument)

  yield* testRoundTrip(hostPath)
  yield* testSocketHandoff(hostPath)
  yield* testDeadlineOverflow(hostPath)
  yield* Console.log('native bridge round trip: ok')
})

runNativeHostTests().pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
