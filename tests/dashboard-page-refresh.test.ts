import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'

import {
  createDashboardPageRefreshScheduler,
  dashboardTabUpdateRefreshOptions
} from '../src/extension/dashboard-page-refresh.js'

test('dashboard tab load updates do not invalidate their own Startup Frame', () => {
  const runtimeId = 'tab-out-runtime'
  const dashboardUrl = `chrome-extension://${runtimeId}/index.html`

  assert.equal(dashboardTabUpdateRefreshOptions(
    { status: 'complete' },
    { url: dashboardUrl },
    runtimeId
  ), null)
  assert.equal(dashboardTabUpdateRefreshOptions(
    { title: 'New Tab' },
    { url: 'chrome://newtab/' },
    runtimeId
  ), null)
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { title: 'Example Article' },
    { url: 'https://example.test/article' },
    runtimeId
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { url: 'https://example.test/next' },
    { url: 'https://example.test/next' },
    runtimeId
  ), { animateCards: true })
})

test('hidden dashboard event bursts do no refresh work and catch up once when visible', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  let visible = false
  const refreshes: Array<{ animateCards?: boolean }> = []

  try {
    const scheduler = createDashboardPageRefreshScheduler({
      isVisible: () => visible,
      refresh: (options) => { refreshes.push(options) }
    })

    scheduler.schedule()
    scheduler.schedule({ animateCards: true })
    scheduler.schedule()
    assert.equal(clock.countTimers(), 0)

    await clock.tickAsync(10_000)
    assert.deepEqual(refreshes, [])

    visible = true
    scheduler.visibilityChanged()
    assert.deepEqual(refreshes, [{ animateCards: true }])

    await clock.tickAsync(10_000)
    assert.equal(refreshes.length, 1)
  } finally {
    clock.uninstall()
  }
})

test('a scheduled visible refresh becomes one pending catch-up if the page hides', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  let visible = true
  const refreshes: Array<{ animateCards?: boolean }> = []

  try {
    const scheduler = createDashboardPageRefreshScheduler({
      isVisible: () => visible,
      refresh: (options) => { refreshes.push(options) }
    })

    scheduler.schedule({ animateCards: true })
    visible = false
    scheduler.visibilityChanged()
    await clock.tickAsync(1000)
    assert.deepEqual(refreshes, [])

    visible = true
    scheduler.visibilityChanged()
    assert.deepEqual(refreshes, [{ animateCards: true }])
  } finally {
    clock.uninstall()
  }
})
