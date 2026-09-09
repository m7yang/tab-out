import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { installPageToastPresenter } from '../src/components/toast/index.js'
import { installToastPresenter, showToast } from '../src/extension/toast.js'

test('showToast is a quiet no-op outside a document context', async () => {
  const originalError = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  const uninstall = installPageToastPresenter()

  try {
    showToast('Background action complete')
    await setImmediate()
    assert.deepEqual(errors, [])
  } finally {
    uninstall()
    console.error = originalError
  }
})

test('showToast is a quiet no-op with a partial worker-style document shim', async () => {
  const originalDocument = globalThis.document
  const originalError = console.error
  const errors: unknown[][] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {},
  })
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  const uninstall = installPageToastPresenter()

  try {
    showToast('Background action complete')
    await setImmediate()
    assert.deepEqual(errors, [])
  } finally {
    uninstall()
    console.error = originalError
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    })
  }
})

test('showToast dispatches through the installed page presenter until it is removed', () => {
  const presented: Array<{ title: string, timeout: number | undefined }> = []
  const uninstall = installToastPresenter((title, _action, options) => {
    presented.push({ title, timeout: options?.timeout })
  })

  showToast('First notice', null, { timeout: 0 })
  uninstall()
  showToast('Ignored after uninstall')

  assert.deepEqual(presented, [{ title: 'First notice', timeout: 0 }])
})
