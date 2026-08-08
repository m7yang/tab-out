import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanTitleWithRemovedSuffix } from '../src/extension/titles.js'

test('title cleanup handles hostnames that match Object prototype properties', () => {
  for (const hostname of ['constructor', '__proto__']) {
    assert.deepEqual(
      cleanTitleWithRemovedSuffix('Example page - Other label', hostname),
      { title: 'Example page - Other label', removedSuffix: '' }
    )
  }
})

test('title cleanup preserves a separator-free title exactly', () => {
  assert.deepEqual(
    cleanTitleWithRemovedSuffix('A title without structural separators', 'alpha.example.test'),
    {
      title: 'A title without structural separators',
      removedSuffix: ''
    }
  )
})
