import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createClosureToken,
  createRetainedPageIdentity,
  isRetainedPageCaptureEligible,
  retainedPageEffectiveUrl
} from '../src/extension/retained-page-identity.js'

const RUNTIME_ID = 'tab-out-id'

test('retained identity reuses surface-qualified canonical dedupe identity while preserving the exact effective URL', async () => {
  const first = await createRetainedPageIdentity({
    surfaceKind: 'normal-tab',
    url: 'https://example.atlassian.net/browse/ABC-123?sourceType=mail&focusedCommentId=100#comment-100'
  })
  const second = await createRetainedPageIdentity({
    surfaceKind: 'normal-tab',
    url: 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'
  })

  assert.ok(first)
  assert.ok(second)
  assert.equal(first.canonicalKey, 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100')
  assert.equal(first.identityDigest, second.identityDigest)
  assert.equal(
    first.url,
    'https://example.atlassian.net/browse/ABC-123?sourceType=mail&focusedCommentId=100#comment-100'
  )
  assert.equal(second.url, 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100')
})

test('retained identity unwraps suspended pages before canonicalization and keeps app identity separate', async () => {
  const exactUrl = 'https://example.test/docs?panel=notes#comment-7'
  const suspendedUrl = `chrome-extension://suspender-id/suspended.html#ttl=Docs&uri=${encodeURIComponent(exactUrl)}`
  const normal = await createRetainedPageIdentity({
    surfaceKind: 'normal-tab',
    url: suspendedUrl
  })
  const app = await createRetainedPageIdentity({
    surfaceKind: 'app',
    url: suspendedUrl
  })

  assert.ok(normal)
  assert.ok(app)
  assert.equal(retainedPageEffectiveUrl({ url: suspendedUrl }), exactUrl)
  assert.equal(normal.url, exactUrl)
  assert.equal(normal.canonicalKey, exactUrl)
  assert.notEqual(normal.identityDigest, app.identityDigest)
})

test('identity digest is a stable SHA-256 encoding with an explicit identity version', async () => {
  const identity = await createRetainedPageIdentity({
    surfaceKind: 'normal-tab',
    url: 'https://example.test/docs'
  })

  assert.ok(identity)
  assert.equal(identity.identityVersion, 1)
  assert.equal(
    identity.identityDigest,
    'acbf701da33d4758693781f27bb360f7fc73364f9f3ac88d248f448f5d5ff3b4'
  )
})

test('capture eligibility includes privileged and app page targets without promising activation', async () => {
  for (const candidate of [
    { surfaceKind: 'normal-tab' as const, url: 'chrome://settings/privacy' },
    { surfaceKind: 'normal-tab' as const, url: 'chrome://restart/' },
    { surfaceKind: 'normal-tab' as const, url: 'chrome-extension://other-extension-id/options.html' },
    { surfaceKind: 'normal-tab' as const, url: 'chrome-untrusted://example-surface/content' },
    { surfaceKind: 'normal-tab' as const, url: 'devtools://devtools/bundled/inspector.html' },
    { surfaceKind: 'app' as const, url: 'https://app.example.test/workspace' },
    { surfaceKind: 'normal-tab' as const, url: 'file:///tmp/example.html' }
  ]) {
    assert.equal(isRetainedPageCaptureEligible(candidate, { runtimeId: RUNTIME_ID }), true, candidate.url)
    assert.ok(await createRetainedPageIdentity(candidate, { runtimeId: RUNTIME_ID }), candidate.url)
  }
})

test('capture eligibility excludes Tab Out, blank/new-tab, and ephemeral non-page targets', async () => {
  for (const url of [
    'chrome-extension://tab-out-id/index.html',
    'chrome-extension://tab-out-id/index.html?filter=docs#results',
    'chrome-extension://tab-out-id/other-surface.html',
    'chrome://newtab/',
    'chrome://new-tab-page/',
    'chrome-search://local-ntp/local-ntp.html',
    'chrome-untrusted://new-tab-page/one-google-bar',
    'about:blank',
    'about:srcdoc',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'blob:https://example.test/session-only'
  ]) {
    const candidate = { surfaceKind: 'normal-tab' as const, url }
    assert.equal(isRetainedPageCaptureEligible(candidate, { runtimeId: RUNTIME_ID }), false, url)
    assert.equal(await createRetainedPageIdentity(candidate, { runtimeId: RUNTIME_ID }), null, url)
  }
})

test('closure tokens contain 128 random bits and support deterministic injection', () => {
  const token = createClosureToken((bytes) => {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index
  })

  assert.equal(token, '000102030405060708090a0b0c0d0e0f')
  assert.match(createClosureToken(), /^[a-f0-9]{32}$/)
})
