import assert from 'node:assert/strict'
import test from 'node:test'

import { dashboardChipFor, makeDashboardTab } from './helpers/domain-card-view-model.js'

test('a live tab chip is not suspended', () => {
  const chip = dashboardChipFor([makeDashboardTab({ id: 1, url: 'https://example.com/a' })], 'https://example.com/a')
  assert.ok(chip)
  assert.ok(!chip.suspended)
})

test('a suspended tab chip is suspended', () => {
  const chip = dashboardChipFor([makeDashboardTab({ id: 1, url: 'https://example.com/a', suspended: true })], 'https://example.com/a')
  assert.ok(chip)
  assert.equal(chip.suspended, true)
})

test('a dupe stack with one live copy is not suspended', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://example.com/a', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://example.com/a', windowId: 2 }),
    ],
    'https://example.com/a',
  )
  assert.ok(chip)
  assert.equal(chip.dupeCount, 2)
  assert.ok(!chip.suspended)
})

test('a dupe stack of only suspended copies is suspended', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://example.com/a', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://example.com/a', windowId: 2, suspended: true }),
    ],
    'https://example.com/a',
  )
  assert.ok(chip)
  assert.equal(chip.dupeCount, 2)
  assert.equal(chip.suspended, true)
})

test('a closed saved page chip is not suspended', () => {
  const chip = dashboardChipFor(
    [makeDashboardTab({ id: 'saved:1', url: 'https://example.com/a', windowId: 0, sourceType: 'saved-page', saved: true, closedSaved: true })],
    'https://example.com/a',
  )
  assert.ok(chip)
  assert.ok(!chip.suspended)
})

test('a title-variant group with a live variant is not suspended', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://example.com/a', title: 'Same Title', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://example.com/b', title: 'Same Title' }),
    ],
    'https://example.com/a',
  )
  assert.ok(chip)
  assert.ok(chip.sameTitlePageChipPlan)
  assert.ok(!chip.suspended)
})

test('a title-variant group of suspended variants is suspended', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://example.com/a', title: 'Same Title', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://example.com/b', title: 'Same Title', suspended: true }),
    ],
    'https://example.com/a',
  )
  assert.ok(chip)
  assert.ok(chip.sameTitlePageChipPlan)
  assert.equal(chip.suspended, true)
})

test('a folded env chip with a live env is not suspended', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://dev.example.com/app', title: 'Example App', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://qa.example.com/app', title: 'Example App' }),
    ],
    'https://dev.example.com/app',
  )
  assert.ok(chip)
  assert.equal(chip.envs?.length, 2)
  assert.ok(!chip.suspended)
})

test('a folded env chip of suspended envs is suspended', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://dev.example.com/app', title: 'Example App', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://qa.example.com/app', title: 'Example App', suspended: true }),
    ],
    'https://dev.example.com/app',
  )
  assert.ok(chip)
  assert.equal(chip.envs?.length, 2)
  assert.equal(chip.suspended, true)
})

test('a folded env chip stays awake when a suspended environment representative has an awake duplicate', () => {
  const chip = dashboardChipFor(
    [
      makeDashboardTab({ id: 1, url: 'https://dev.example.com/app', title: 'Example App', suspended: true }),
      makeDashboardTab({ id: 2, url: 'https://dev.example.com/app', title: 'Example App', windowId: 2 }),
      makeDashboardTab({ id: 3, url: 'https://qa.example.com/app', title: 'Example App', suspended: true }),
    ],
    'https://dev.example.com/app',
  )
  assert.ok(chip)
  assert.equal(chip.envs?.length, 2)
  assert.equal(chip.suspended, false)
})
