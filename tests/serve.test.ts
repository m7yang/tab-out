import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import { Deferred, Effect, Result } from 'effect'

import {
  DebugServerError,
  runDashboardDebugServer
} from '../scripts/serve.js'

function serverPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP port')
  return address.port
}

function listenOnAvailablePort(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => undefined)
}

test('debug server serves the dashboard fixture and closes with its scope', async () => {
  const shutdown = Deferred.makeUnsafe<void>()
  const listening = Promise.withResolvers<number>()
  const running = Effect.runPromise(runDashboardDebugServer({
    port: 0,
    awaitShutdown: Deferred.await(shutdown),
    onListening: listening.resolve
  }))
  const port = await listening.promise
  const url = `http://127.0.0.1:${port}/tests/fixtures/dashboard-resize.html`

  try {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /data-tabout="dashboard-shell"/)

    const staticResponse = await fetch(`http://127.0.0.1:${port}/extension/manifest.json`)
    assert.equal(staticResponse.status, 200)
    assert.equal(staticResponse.headers.get('content-type'), 'application/json')
    assert.equal((await staticResponse.json()).manifest_version, 3)

    const missingResponse = await fetch(`http://127.0.0.1:${port}/missing`)
    assert.equal(missingResponse.status, 404)
    assert.equal(await missingResponse.text(), 'Not found')
  } finally {
    Effect.runSync(Deferred.succeed(shutdown, undefined))
    await running
  }

  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }))
})

test('debug server reports a typed port-binding failure', async () => {
  await using blockingServer = createServer()
  await listenOnAvailablePort(blockingServer)
  const port = serverPort(blockingServer)

  const result = await Effect.runPromise(Effect.result(runDashboardDebugServer({
    port,
    awaitShutdown: Effect.never
  })))
  assert.equal(Result.isFailure(result), true)
  if (Result.isSuccess(result)) throw new Error('occupied port unexpectedly started a second server')
  assert.ok(result.failure instanceof DebugServerError)
  assert.equal(result.failure.port, port)
})
