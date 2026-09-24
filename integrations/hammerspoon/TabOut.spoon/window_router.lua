local M = {}

local CHROME_LAUNCH_TIMEOUT_SECONDS = 20
local CHROME_LAUNCH_RETRY_INTERVAL_SECONDS = 0.2
local CHROME_OPEN_EXECUTABLE = "/usr/bin/open"
local LAST_USER_SPACES_KEY = "tabOut.lastUserSpaces.v1"
local NEW_WINDOW_POLL_INTERVAL_SECONDS = 0.05
local NEW_WINDOW_TIMEOUT_SECONDS = 12
local PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS = 3

local function noOp() end

local function loggerOrNoOp(logger)
  return {
    df = logger and logger.df or noOp,
    wf = logger and logger.wf or noOp,
  }
end

function M.new(options)
  assert(type(options) == "table", "Window router options must be a table")
  assert(type(options.catalog) == "table", "catalog is required")
  assert(type(options.chromeWindows) == "function", "chromeWindows is required")
  assert(type(options.config) == "table", "config is required")
  assert(type(options.hs) == "table", "hs is required")
  assert(type(options.later) == "function", "later is required")
  assert(type(options.reportFailure) == "function", "reportFailure is required")
  assert(type(options.stopTimer) == "function", "stopTimer is required")
  assert(type(options.trackTimer) == "function", "trackTimer is required")
  assert(type(options.transition) == "function", "transition is required")

  local catalog = options.catalog
  local busy = false
  local chromeLaunchTask
  local chromeWindows = options.chromeWindows
  local config = options.config
  local currentRequest
  local fail
  local hs = options.hs
  local lastUserSpaceByScreen = hs.settings.get(LAST_USER_SPACES_KEY)
  if type(lastUserSpaceByScreen) ~= "table" then
    lastUserSpaceByScreen = {}
  end
  local later = options.later
  local log = loggerOrNoOp(options.log)
  local nativeBridge = options.nativeBridge
  local nativeBridgeError = options.nativeBridgeError
  local pendingNativePlacement
  local privateFocus = options.privateFocus
  local privateFocusError = options.privateFocusError
  local profileTransferDraining = false
  local queue = {}
  local stopTimer = options.stopTimer
  local trackTimer = options.trackTimer
  local transition = options.transition
  local router = {}

  local function isBusy()
    return busy
  end

  local function isCurrent(request)
    return currentRequest == request
  end

  local function screenUuid(screen)
    return screen and screen:getUUID() or nil
  end

  local function screenForUuid(uuid)
    if not uuid then
      return nil
    end

    for _, screen in ipairs(hs.screen.allScreens()) do
      if screen:getUUID() == uuid then
        return screen
      end
    end

    return nil
  end


  local function containsValue(values, expected)
    for _, value in ipairs(values or {}) do
      if value == expected then
        return true
      end
    end

    return false
  end

  local function captureTargetContext()
    local screen = hs.mouse.getCurrentScreen()
    local focusedWindow = hs.window.focusedWindow()
    local focusedApplication = focusedWindow and focusedWindow:application() or nil
    local focusedScreen = focusedWindow and focusedWindow:screen() or nil
    screen = screen or (focusedWindow and focusedWindow:screen()) or hs.screen.mainScreen()

    if not screen then
      return nil, "No target display is available"
    end

    local spaceId, spaceError = hs.spaces.activeSpaceOnScreen(screen)
    if not spaceId then
      return nil, spaceError or "The active Space could not be determined"
    end

    local spaceType, typeError = hs.spaces.spaceType(spaceId)
    if not spaceType then
      return nil, typeError or "The active Space type could not be determined"
    end

    local uuid = screenUuid(screen)
    if not uuid then
      return nil, "The target display has no stable identifier"
    end

    if spaceType == "user" and lastUserSpaceByScreen[uuid] ~= spaceId then
      lastUserSpaceByScreen[uuid] = spaceId
      hs.settings.set(LAST_USER_SPACES_KEY, lastUserSpaceByScreen)
    end

    return {
      capturedSpaceId = spaceId,
      capturedSpaceType = spaceType,
      fallbackUserSpaceId = spaceType == "fullscreen" and lastUserSpaceByScreen[uuid] or nil,
      focusedWindow = focusedWindow,
      focusedWindowBundleId = focusedApplication and focusedApplication:bundleID() or nil,
      focusedWindowId = focusedWindow and focusedWindow:id() or nil,
      focusedWindowScreenUuid = screenUuid(focusedScreen),
      screenUuid = uuid,
    }
  end

  local function refreshLastUserSpaces()
    local changed = false

    for _, screen in ipairs(hs.screen.allScreens()) do
      local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
      if activeSpace and hs.spaces.spaceType(activeSpace) == "user" then
        local uuid = screenUuid(screen)
        if uuid and lastUserSpaceByScreen[uuid] ~= activeSpace then
          lastUserSpaceByScreen[uuid] = activeSpace
          changed = true
        end
      end
    end

    if changed then
      hs.settings.set(LAST_USER_SPACES_KEY, lastUserSpaceByScreen)
    end
  end

  local function spaceBelongsToScreen(spaceId, screen)
    local spaces = hs.spaces.spacesForScreen(screen)
    return spaces and containsValue(spaces, spaceId) or false
  end

  local function regularSpaceForScreen(request, screen)
    local remembered = request.fallbackUserSpaceId
    if remembered
      and spaceBelongsToScreen(remembered, screen)
      and hs.spaces.spaceType(remembered) == "user"
    then
      return remembered
    end

    for _, spaceId in ipairs(hs.spaces.spacesForScreen(screen) or {}) do
      if hs.spaces.spaceType(spaceId) == "user" then
        return spaceId
      end
    end
    return nil
  end

  local function waitForSpace(request, screen, targetSpace, attempt)
    local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
    if activeSpace == targetSpace then
      request.targetSpaceId = targetSpace
      refreshLastUserSpaces()
      request.continueOnTargetSpace(screen)
      return
    end

    if attempt >= 50 then
      fail("Could not switch to the target Desktop", "Timed out waiting for the Space change")
      return
    end

    later(0.1, function()
      waitForSpace(request, screen, targetSpace, attempt + 1)
    end, true)
  end

  local function ensureTargetUserSpace(request, callback)
    local screen = screenForUuid(request.screenUuid)
    if not screen then
      fail("The target display is no longer connected")
      return
    end

    local targetSpace
    if request.capturedSpaceType == "user" then
      targetSpace = request.capturedSpaceId
    elseif request.capturedSpaceType == "fullscreen" then
      targetSpace = regularSpaceForScreen(request, screen)
    end

    if not targetSpace then
      fail("No previously used regular Desktop is known for this display")
      return
    end

    if not spaceBelongsToScreen(targetSpace, screen) or hs.spaces.spaceType(targetSpace) ~= "user" then
      fail("The target regular Desktop is no longer available")
      return
    end

    request.continueOnTargetSpace = callback
    local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
    if activeSpace == targetSpace then
      request.targetSpaceId = targetSpace
      callback(screen)
      return
    end

    local switched, switchError = hs.spaces.gotoSpace(targetSpace)
    if not switched then
      fail("Could not switch from the full-screen Space", switchError)
      return
    end

    waitForSpace(request, screen, targetSpace, 0)
  end

  local function chromeApplication(browserProcessId)
    if type(browserProcessId) ~= "number" then
      return nil
    end
    return hs.application.applicationForPID(browserProcessId)
  end

  local function trackedChromeWindows()
    local tracked = chromeWindows()
    return tracked or {}
  end

  local function isChromeWindow(window, browserProcessId)
    if not window or not window:id() or not window:isStandard() or window:isMinimized() then
      return false
    end

    local application = window:application()
    return application
      and application:bundleID() == config.chromeBundleId
      and (browserProcessId == nil or application:pid() == browserProcessId)
      and not application:isHidden()
  end

  local function screenHasChromeWindowOnSpace(screen, spaceId, browserProcessId)
    local targetScreenUuid = screenUuid(screen)
    for _, window in ipairs(trackedChromeWindows()) do
      if isChromeWindow(window, browserProcessId)
        and screenUuid(window:screen()) == targetScreenUuid
      then
        local spaces = hs.spaces.windowSpaces(window)
        if spaces and containsValue(spaces, spaceId) then
          return true
        end
      end
    end
    return false
  end

  -- hs.window.orderedWindows() queries every application through
  -- Accessibility, so an unresponsive app can stall the shortcut. Order the
  -- tracked Chrome windows by the same on-screen window-server z-order instead.
  local function orderedTrackedChromeWindows()
    if type(hs.window._orderedwinids) ~= "function" then
      return hs.window.orderedWindows()
    end
    local trackedById = {}
    for _, window in ipairs(trackedChromeWindows()) do
      local id = window and window:id() or nil
      if id then
        trackedById[id] = window
      end
    end
    local ordered = {}
    for _, id in ipairs(hs.window._orderedwinids()) do
      if trackedById[id] then
        table.insert(ordered, trackedById[id])
      end
    end
    return ordered
  end

  local function eligibleChromeWindows(screen, spaceId, browserProcessId)
    local candidates = {}
    if not screenHasChromeWindowOnSpace(screen, spaceId, browserProcessId) then
      return candidates
    end

    local targetScreenUuid = screenUuid(screen)

    for _, window in ipairs(orderedTrackedChromeWindows()) do
      if isChromeWindow(window, browserProcessId)
        and screenUuid(window:screen()) == targetScreenUuid
      then
        local spaces = hs.spaces.windowSpaces(window)
        if spaces and containsValue(spaces, spaceId) then
          table.insert(candidates, window)
        end
      end
    end

    return candidates
  end

  local function roundedCoordinate(value)
    return math.floor(value + 0.5)
  end

  local function acceptNativePlacementWindow(pending, window)
    if pending.windowFound then
      return
    end

    pending.windowFound = true
    stopTimer(pending.timeout)
    stopTimer(pending.poll)
    if pendingNativePlacement == pending then
      pendingNativePlacement = nil
    end

    local request = pending.request
    request.authorityToken = pending.authorityToken
    request.createdIdentity = {
      browserProcessId = pending.browserProcessId,
      browserWindowId = pending.browserWindowId,
      creationToken = pending.creationToken,
      nativeWindowId = window:id(),
    }
    transition():registerCreatedWindow(request, window)
    log.df("Tab Out created the %s window directly on the target Desktop", request.kind)
    transition():activateCreated(
      request.kind,
      window,
      pending.browserProcessId,
      pending.browserWindowId,
      pending.authorityToken,
      pending.creationToken
    )
  end

  local function failNativePlacementTimeout(pending)
    if pendingNativePlacement ~= pending or pending.windowFound then
      return
    end

    pendingNativePlacement = nil
    stopTimer(pending.timeout)
    stopTimer(pending.poll)
    fail(
      "Timed out waiting for Tab Out's directly placed Chrome window",
      pending.identityError or "Check the native bridge status and reload the Tab Out extension"
    )
  end

  local function screenBoundsForBridge(targetScreen)
    local frame = targetScreen and targetScreen:fullFrame() or nil
    if not frame
      or type(frame.x) ~= "number"
      or type(frame.y) ~= "number"
      or type(frame.w) ~= "number"
      or type(frame.h) ~= "number"
      or frame.w <= 0
      or frame.h <= 0
    then
      return nil, "The pointer display bounds are unavailable"
    end

    return {
      height = roundedCoordinate(frame.h),
      left = roundedCoordinate(frame.x),
      top = roundedCoordinate(frame.y),
      width = roundedCoordinate(frame.w),
    }
  end

  local function expectNativePlacementWindow(request)
    local pending = {
      baselineWindowIds = {},
      authorityToken = nil,
      browserProcessId = request.browserProcessId,
      browserWindowId = nil,
      bridgeAccepted = false,
      creationToken = nil,
      deadline = hs.timer.secondsSinceEpoch() + NEW_WINDOW_TIMEOUT_SECONDS,
      identityError = nil,
      poll = nil,
      request = request,
      timeout = nil,
      windowFound = false,
    }
    local application = chromeApplication(request.browserProcessId)
    for _, window in ipairs(application and application:allWindows() or {}) do
      local windowId = window:id()
      if windowId then
        pending.baselineWindowIds[windowId] = true
      end
    end
    pendingNativePlacement = pending
    pending.timeout = later(NEW_WINDOW_TIMEOUT_SECONDS, function()
      failNativePlacementTimeout(pending)
    end, true)
    return pending
  end

  local function pendingNativePlacementCandidates(pending)
    local request = pending.request
    local targetScreen = screenForUuid(request.screenUuid)
    if not targetScreen
      or hs.spaces.activeSpaceOnScreen(targetScreen) ~= request.targetSpaceId
    then
      return {}
    end

    local candidates = {}
    local application = chromeApplication(pending.browserProcessId)
    for _, window in ipairs(application and application:allWindows() or {}) do
      local windowId = window and window:id() or nil
      if windowId
        and not pending.baselineWindowIds[windowId]
        and isChromeWindow(window, pending.browserProcessId)
        and screenUuid(window:screen()) == request.screenUuid
      then
        local windowSpaces = hs.spaces.windowSpaces(window)
        if windowSpaces and containsValue(windowSpaces, request.targetSpaceId) then
          table.insert(candidates, window)
        end
      end
    end
    return candidates
  end

  local function tryMatchNativePlacementWindow(pending)
    if pendingNativePlacement ~= pending
      or pending.windowFound
      or not pending.bridgeAccepted
      or not pending.browserWindowId
      or not pending.creationToken
    then
      return
    end

    if not chromeApplication(pending.browserProcessId) then
      fail(
        "Tab Out could not verify its created Chrome window",
        "The configured Chrome instance is no longer running"
      )
      return
    end

    local remainingSeconds = pending.deadline - hs.timer.secondsSinceEpoch()
    if remainingSeconds <= 0 then
      failNativePlacementTimeout(pending)
      return
    end

    -- A match needs a new native window on the target Desktop; until one
    -- appears, skip the full process-targeted Chrome inventory on each tick.
    local candidates = pendingNativePlacementCandidates(pending)
    if #candidates == 0 then
      pending.identityError = "The created native Chrome window is not yet available on the target Desktop"
      return
    end

    local window, identityError, fatal, authorityToken = catalog:matchCreatedBrowserWindow(
      pending.browserProcessId,
      pending.browserWindowId,
      pending.creationToken,
      candidates,
      remainingSeconds
    )
    pending.identityError = identityError
    if hs.timer.secondsSinceEpoch() >= pending.deadline then
      catalog:releaseAuthority(authorityToken)
      failNativePlacementTimeout(pending)
      return
    end
    if fatal then
      fail("Tab Out could not verify its created Chrome window", identityError)
      return
    end
    if window then
      pending.authorityToken = authorityToken
      acceptNativePlacementWindow(pending, window)
    end
  end

  local function startNativePlacementPoll(pending)
    local poll
    poll = hs.timer.doEvery(NEW_WINDOW_POLL_INTERVAL_SECONDS, function()
      local ok, pollError = xpcall(function()
        if pendingNativePlacement ~= pending or pending.windowFound then
          stopTimer(poll)
          return
        end

        if not pending.bridgeAccepted then
          return
        end

        tryMatchNativePlacementWindow(pending)
      end, debug.traceback)

      if not ok and isBusy() then
        fail("Automation failed", pollError)
      end
    end)
    pending.poll = poll
    trackTimer(poll)
  end

  local function requestInactiveTargetProfileWindow(request, targetScreen)
    local extensionId, extensionError = catalog:extensionId()
    if not extensionId then
      fail("Tab Out's Native Placement Bridge is unavailable", extensionError)
      return
    end

    if not nativeBridge then
      fail(
        "Tab Out's Native Placement Bridge is unavailable",
        nativeBridgeError or "The native bridge client is not configured"
      )
      return
    end

    local targetBounds, targetBoundsError = screenBoundsForBridge(targetScreen)
    if not targetBounds then
      fail("Tab Out cannot address the target display", targetBoundsError)
      return
    end

    local shieldCaptured, shieldError = transition():captureShield(targetScreen)
    if not shieldCaptured then
      log.wf("Could not shield the new-window transition: %s", shieldError or "unknown error")
    end

    local pending = expectNativePlacementWindow(request)
    startNativePlacementPoll(pending)
    request.mutationStarted = true
    local started, startError = nativeBridge:createWindow({
      expectedBrowserProcessId = request.browserProcessId,
      operation = request.kind,
      targetBounds = targetBounds,
      timeoutSeconds = NEW_WINDOW_TIMEOUT_SECONDS,
    }, function(accepted, bridgeError, identity)
      local ok, callbackError = xpcall(function()
        if pendingNativePlacement ~= pending or pending.windowFound then
          return
        end
        if bridgeError or accepted ~= true then
          pendingNativePlacement = nil
          stopTimer(pending.timeout)
          fail(
            "Tab Out's Native Placement Bridge rejected the request",
            bridgeError or "The extension returned no reason"
          )
          return
        end
        if type(identity) ~= "table"
          or identity.browserProcessId ~= request.browserProcessId
        then
          pendingNativePlacement = nil
          stopTimer(pending.timeout)
          fail(
            "Tab Out's configured Chrome identity changed during window creation",
            "The created window was left untouched because its process authority could not be revalidated"
          )
          return
        end
        pending.browserProcessId = identity.browserProcessId
        pending.browserWindowId = identity.browserWindowId
        pending.creationToken = identity.creationToken
        pending.bridgeAccepted = true
        tryMatchNativePlacementWindow(pending)
      end, debug.traceback)

      if not ok and isBusy() then
        fail("Automation failed", callbackError)
      end
    end)

    if not started then
      pendingNativePlacement = nil
      stopTimer(pending.timeout)
      fail("Tab Out's Native Placement Bridge could not start", startError)
      return
    end
  end

  local continueWithConfiguredInventory
  local requestConfiguredInventory

  local function isIntegrationMismatch(errorMessage)
    local normalized = type(errorMessage) == "string" and errorMessage:lower() or ""
    return normalized:find("protocol", 1, true) ~= nil
      or normalized:find("version", 1, true) ~= nil
  end

  local function isConfiguredInstanceUnavailable(errorMessage)
    local normalized = type(errorMessage) == "string" and errorMessage:lower() or ""
    return normalized:find("native bridge is not connected", 1, true) ~= nil
      or normalized:find("chrome disconnected from the native bridge", 1, true) ~= nil
      or normalized:find("chrome is no longer connected", 1, true) ~= nil
  end

  local function waitForColdChromeBridge(request, targetScreen, startedAt)
    if not isCurrent(request) then
      return
    end

    if hs.timer.secondsSinceEpoch() - startedAt >= CHROME_LAUNCH_TIMEOUT_SECONDS then
      fail(
        "The configured Chrome instance did not become ready",
        "The background launch did not establish fresh Native Placement Bridge authority"
      )
      return
    end

    local completed = false
    local function retry(inventoryError)
      if completed then
        return
      end
      completed = true
      if isIntegrationMismatch(inventoryError) then
        fail(
          "Tab Out's macOS integration versions do not match",
          "Reinstall the integration, reload the extension, and reload Hammerspoon"
        )
        return
      end
      if inventoryError then
        log.df("Waiting for configured Chrome authority: %s", inventoryError)
      end
      later(CHROME_LAUNCH_RETRY_INTERVAL_SECONDS, function()
        waitForColdChromeBridge(request, targetScreen, startedAt)
      end, true)
    end

    local expectedProcessId, processError = catalog:configuredProcessId()
    if not expectedProcessId then
      retry(processError)
      return
    end

    local started, startError = nativeBridge:listProfileWindows({
      timeoutSeconds = PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS,
    }, function(inventory, inventoryError)
      if not isCurrent(request) then
        return
      end
      if inventory then
        if inventory.browserProcessId ~= expectedProcessId then
          retry("The native bridge belongs to a different Chrome user-data process")
          return
        end
        completed = true
        continueWithConfiguredInventory(
          request,
          targetScreen,
          inventory,
          expectedProcessId
        )
        return
      end
      retry(inventoryError)
    end)

    if not started then
      retry(startError)
    end
  end

  local function launchChromeForNativePlacement(request, targetScreen)
    local extensionId, extensionError = catalog:extensionId()
    if not extensionId then
      fail("Tab Out's Chrome profile is unavailable", extensionError)
      return
    end
    if not nativeBridge or type(nativeBridge.listProfileWindows) ~= "function" then
      fail(
        "Tab Out's Native Placement Bridge is unavailable",
        nativeBridgeError or "The native bridge client cannot verify a cold Chrome launch"
      )
      return
    end

    local startedAt = hs.timer.secondsSinceEpoch()
    local arguments = {
      "-n",
      "-g",
      "-b",
      config.chromeBundleId,
      "--args",
      "--user-data-dir=" .. config.chromeUserDataDirectory,
      "--profile-directory=" .. config.chromeProfileDirectory,
      "--no-startup-window",
    }
    local task
    task = hs.task.new(CHROME_OPEN_EXECUTABLE, function(exitCode, _, standardError)
      if chromeLaunchTask == task then
        chromeLaunchTask = nil
      end
      if not isCurrent(request) then
        return
      end
      if exitCode ~= 0 then
        fail(
          "Google Chrome could not be launched in the background",
          standardError ~= "" and standardError or "The macOS application launcher failed"
        )
        return
      end
      waitForColdChromeBridge(request, targetScreen, startedAt)
    end, arguments)

    if not task then
      fail("Google Chrome could not be launched in the background")
      return
    end
    chromeLaunchTask = task
    if not task:start() then
      chromeLaunchTask = nil
      fail("Google Chrome could not be launched in the background")
    end
  end

  local function releaseRequestAuthority(request)
    if request and request.authorityToken then
      catalog:releaseAuthority(request.authorityToken)
      request.authorityToken = nil
    end
  end

  local function retryConfiguredAuthority(
    request,
    targetScreen,
    authorityError,
    authorityDetails
  )
    if type(authorityDetails) ~= "table"
      or authorityDetails.authorityChanged ~= true
      or authorityDetails.mutationStarted ~= false
    then
      return false
    end
    request.authorityRetryCount = (request.authorityRetryCount or 0) + 1
    if request.authorityRetryCount > 1
      or request.mutationStarted
      or not isCurrent(request)
    then
      return false
    end

    releaseRequestAuthority(request)
    log.df("Retrying configured Chrome authority before mutation: %s", authorityError or "identity changed")
    later(0, function()
      requestConfiguredInventory(request, targetScreen, false)
    end, true)
    return true
  end

  local function tryCandidate(request, targetScreen, resolvedWindows, index)
    local resolved = resolvedWindows[index]
    if not resolved then
      releaseRequestAuthority(request)
      if request.routeOnRegularSpace then
        local routeOnRegularSpace = request.routeOnRegularSpace
        request.routeOnRegularSpace = nil
        routeOnRegularSpace()
        return
      end
      requestInactiveTargetProfileWindow(request, targetScreen)
      return
    end

    transition():activateExisting(
      request.kind,
      resolved.window,
      request.browserProcessId,
      resolved.browserWindowId,
      request.authorityToken,
      function(authorityError, authorityDetails)
        if not retryConfiguredAuthority(
          request,
          targetScreen,
          authorityError,
          authorityDetails
        ) then
          fail("Tab Out's configured Chrome identity changed", authorityError)
        end
      end
    )
  end

  requestConfiguredInventory = function(request, targetScreen, mayLaunch)
    if not nativeBridge or type(nativeBridge.listProfileWindows) ~= "function" then
      fail(
        "Tab Out's Native Placement Bridge is unavailable",
        nativeBridgeError or "The native bridge client cannot establish configured-instance authority"
      )
      return
    end
    local expectedProcessId, processError = catalog:configuredProcessId()
    if not expectedProcessId then
      if mayLaunch then
        launchChromeForNativePlacement(request, targetScreen)
      else
        fail("The configured Chrome instance is unavailable", processError)
      end
      return
    end

    local completed = false
    local started, startError = nativeBridge:listProfileWindows({
      timeoutSeconds = PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS,
    }, function(inventory, inventoryError)
      if completed or not isCurrent(request) then
        return
      end
      completed = true
      if inventory then
        if inventory.browserProcessId ~= expectedProcessId then
          local authorityDetails = {
            authorityChanged = true,
            mutationStarted = false,
          }
          local authorityError = "The native bridge belongs to a different Chrome user-data process"
          if retryConfiguredAuthority(
            request,
            targetScreen,
            authorityError,
            authorityDetails
          ) then
            return
          end
          fail("Tab Out's configured Chrome identity changed", authorityError)
          return
        end
        continueWithConfiguredInventory(
          request,
          targetScreen,
          inventory,
          expectedProcessId
        )
        return
      end
      if isIntegrationMismatch(inventoryError) then
        fail(
          "Tab Out's macOS integration versions do not match",
          "Reinstall the integration, reload the extension, and reload Hammerspoon"
        )
        return
      end
      if mayLaunch and isConfiguredInstanceUnavailable(inventoryError) then
        launchChromeForNativePlacement(request, targetScreen)
        return
      end
      fail(
        "The configured Chrome instance is unavailable",
        inventoryError or "Fresh process authority could not be established"
      )
    end)

    if not started then
      if isIntegrationMismatch(startError) then
        fail(
          "Tab Out's macOS integration versions do not match",
          "Reinstall the integration, reload the extension, and reload Hammerspoon"
        )
      else
        fail("Tab Out's Native Placement Bridge could not start", startError)
      end
    end
  end

  continueWithConfiguredInventory = function(
    request,
    targetScreen,
    inventory,
    expectedProcessId
  )
    if type(inventory) ~= "table"
      or type(inventory.browserProcessId) ~= "number"
      or type(inventory.windowIds) ~= "table"
      or inventory.browserProcessId ~= expectedProcessId
    then
      fail(
        "Tab Out could not establish configured Chrome authority",
        "The Native Placement Bridge returned an invalid configured-instance inventory"
      )
      return
    end

    request.browserProcessId = inventory.browserProcessId
    request.profileWindowIds = inventory.windowIds
    local application = chromeApplication(request.browserProcessId)
    local resolvedWindows
    local resolutionError
    local resolutionDetails
    local authorityToken
    if application and application:bundleID() == config.chromeBundleId then
      local candidates = eligibleChromeWindows(
        targetScreen,
        request.targetSpaceId,
        request.browserProcessId
      )
      resolvedWindows, resolutionError, authorityToken, resolutionDetails = catalog:resolveProfileWindows(
        request.browserProcessId,
        request.profileWindowIds,
        candidates,
        PROFILE_WINDOW_INVENTORY_TIMEOUT_SECONDS
      )
    else
      resolutionError = "The authorized Chrome process is no longer running"
    end

    if not resolvedWindows then
      if retryConfiguredAuthority(
        request,
        targetScreen,
        resolutionError,
        resolutionDetails
      ) then
        return
      end
      fail("Tab Out's configured Chrome identity changed", resolutionError)
      return
    end
    releaseRequestAuthority(request)
    request.authorityToken = authorityToken
    tryCandidate(request, targetScreen, resolvedWindows, 1)
  end

  local function routeOnTargetSpace(request, targetScreen)
    requestConfiguredInventory(request, targetScreen, true)
  end

  local function processRequest(request)
    if request.capturedSpaceType == "fullscreen" then
      local screen = screenForUuid(request.screenUuid)
      if not screen then
        fail("The target display is no longer connected")
        return
      end

      request.targetSpaceId = request.capturedSpaceId
      request.routeOnRegularSpace = function()
        ensureTargetUserSpace(request, function(targetScreen)
          routeOnTargetSpace(request, targetScreen)
        end)
      end
      routeOnTargetSpace(request, screen)
      return
    end

    ensureTargetUserSpace(request, function(targetScreen)
      routeOnTargetSpace(request, targetScreen)
    end)
  end

  local function prepareRoutingRequest(kind)
    if not privateFocus then
      return nil, "The private Chrome focus helper is unavailable", privateFocusError
    end

    local context, contextError = captureTargetContext()
    if not context then
      return nil, "The target display or Desktop could not be determined", contextError
    end

    context.kind = kind
    return context
  end


  local function cleanupCreatedWindow(request)
    local identity = request and request.createdIdentity or nil
    if not identity or not privateFocus or type(privateFocus.closeCreated) ~= "function" then
      return
    end
    local extensionId, extensionError = catalog:extensionId()
    if not extensionId then
      log.wf("Could not verify created-window cleanup: %s", extensionError or "extension identity unavailable")
      return
    end

    local called, closed, closeError = pcall(
      privateFocus.closeCreated,
      identity.browserProcessId,
      identity.nativeWindowId,
      identity.browserWindowId,
      extensionId,
      identity.creationToken
    )
    if called and closed then
      request.createdIdentity = nil
      log.df("Closed the still-tokenized Tab Out window after a failed route")
      return
    end
    log.wf(
      "Left the created Chrome window untouched after Safe Abort: %s",
      called and (closeError or "exact cleanup identity was unavailable") or tostring(closed)
    )
  end

  local function cleanup()
    if pendingNativePlacement then
      stopTimer(pendingNativePlacement.timeout)
      stopTimer(pendingNativePlacement.poll)
    end
    transition():releaseShield()
    releaseRequestAuthority(currentRequest)
    pendingNativePlacement = nil
  end

  local function drain()
    if busy or #queue == 0 then
      return
    end

    currentRequest = table.remove(queue, 1)
    busy = true
    local ok, err = xpcall(function()
      processRequest(currentRequest)
    end, debug.traceback)
    if not ok then
      fail("Automation failed", err)
    end
  end

  fail = function(message, detail)
    if not busy then
      return false
    end

    cleanupCreatedWindow(currentRequest)
    transition():releaseShield()
    options.reportFailure(message, detail, screenForUuid(currentRequest.screenUuid))
    router:finish()
    return true
  end

  function router:current() return currentRequest end

  function router:enqueue(kind)
    if profileTransferDraining then
      options.reportFailure("The Chrome profile transfer is in progress")
      return false
    end
    local request, message, detail = prepareRoutingRequest(kind)
    if not request then
      options.reportFailure(message, detail)
      return false
    end

    table.insert(queue, request)
    drain()
    return true
  end

  function router:fail(message, detail) return fail(message, detail) end

  function router:finish()
    if not busy then
      return false
    end

    cleanup()
    busy = false
    currentRequest = nil
    later(0.08, drain, false)
    return true
  end

  function router:handleChromeWindowCreated()
    local pending = pendingNativePlacement
    if pending then
      tryMatchNativePlacementWindow(pending)
    end
  end

  function router:isBusy() return busy end

  function router:beginProfileTransferDrain()
    if profileTransferDraining or busy or #queue > 0 then
      return false
    end
    profileTransferDraining = true
    return true
  end

  function router:cancelProfileTransferDrain()
    profileTransferDraining = false
  end

  function router:queueDepth() return #queue end

  function router:refreshSpaces() refreshLastUserSpaces() end

  return router
end

return M
