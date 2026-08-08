import { Effect, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { requestDashboardRefresh } from './dashboard-intake.js'
import { retainedPageActivationDisposition } from './retained-page-actions.js'
import {
  SAVED_PAGE_ACTIVATE_MESSAGE,
  parseSavedPageActivationResponse,
  type SavedPageActivateMessage
} from './runtime-messages.js'
import type { ChipActivationMode } from './tab-activation.js'
import { showToast } from './toast.js'
import type { DashboardChipData } from './types.js'

export type SavedPageActivationTarget = Pick<DashboardChipData, 'isApp' | 'tabUrl'>

type SavedPageActivationDependencies = {
  sendMessage: (message: SavedPageActivateMessage) => Promise<unknown>
  refresh: typeof requestDashboardRefresh
  notify: typeof showToast
}

class SavedPageActivationMessageError extends Schema.TaggedErrorClass<SavedPageActivationMessageError>()(
  'SavedPageActivationMessageError',
  { cause: Schema.Defect() }
) {}

class SavedPageActivationRefreshError extends Schema.TaggedErrorClass<SavedPageActivationRefreshError>()(
  'SavedPageActivationRefreshError',
  { cause: Schema.Defect() }
) {}

/**
 * Route closed Saved Pages through the worker's guarded exact-URL recovery.
 * Unlike retained activation, success never consumes the Saved Page record.
 */
export function createSavedPageActivation({
  sendMessage,
  refresh,
  notify
}: SavedPageActivationDependencies) {
  const runActivateSavedPageTarget = Effect.fn(
    'savedPageActivation.activateSavedPageTarget'
  )(function*(target: SavedPageActivationTarget, mode: ChipActivationMode) {
    if (!target.tabUrl) {
      notify('Could not open page')
      return false
    }

    const responseResult = yield* Effect.result(Effect.tryPromise({
      try: () => sendMessage({
        type: SAVED_PAGE_ACTIVATE_MESSAGE,
        url: target.tabUrl,
        surfaceKind: target.isApp ? 'app' : 'normal-tab',
        disposition: retainedPageActivationDisposition(mode)
      }),
      catch: (cause) => SavedPageActivationMessageError.make({ cause })
    }))
    const response = Result.isSuccess(responseResult)
      ? parseSavedPageActivationResponse(responseResult.success)
      : null

    if (response?.outcome !== 'activated') {
      notify('Could not open page')
      return false
    }

    const refreshResult = yield* Effect.result(Effect.tryPromise({
      try: () => refresh({ animateCards: true }),
      catch: (cause) => SavedPageActivationRefreshError.make({ cause })
    }))
    if (Result.isFailure(refreshResult)) {
      notify("Page opened, but Tabs couldn't be updated.")
    }
    return true
  })

  function activateSavedPageTarget(
    target: SavedPageActivationTarget,
    mode: ChipActivationMode
  ): Promise<boolean> {
    return getAppRuntime().runPromise(runActivateSavedPageTarget(target, mode))
  }

  return { activateSavedPageTarget }
}

const savedPageActivation = createSavedPageActivation({
  sendMessage: async (message) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('Extension runtime is unavailable')
    }
    return chrome.runtime.sendMessage(message)
  },
  refresh: requestDashboardRefresh,
  notify: showToast
})

export const { activateSavedPageTarget } = savedPageActivation
