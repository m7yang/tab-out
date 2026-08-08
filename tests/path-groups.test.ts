import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePathGroup } from '../src/extension/path-groups.js'

test('path-group resolution accepts a pre-parsed URL without changing semantics', () => {
  const url = 'https://example.atlassian.net/browse/APP-123'

  assert.deepEqual(resolvePathGroup(new URL(url)), resolvePathGroup(url))
})
