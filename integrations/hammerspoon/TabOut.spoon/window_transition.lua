local M = {}

local CLOSE_TAB_SCAN_TIMEOUT_SECONDS = 0.05
local CLOSE_WINDOW_ORDER_TIMEOUT_SECONDS = 0.05
local CREATED_WINDOW_CLOSE_FOCUS_TIMEOUT_SECONDS = 0.5
local CREATED_WINDOW_CLOSE_MONITOR_INTERVAL_SECONDS = 0.1
local CREATED_WINDOW_LIVENESS_TIMEOUT_SECONDS = 0.05
local CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS = 0.005
local DESTINATION_CONTROL_TIMEOUT_SECONDS = 6
local NEW_TAB_URL = "chrome://newtab/"
local TARGET_FOCUS_TIMEOUT_SECONDS = 2
local WINDOW_FOCUS_RETRY_INTERVAL_SECONDS = 0.05

local function noOp() end

local function loggerOrNoOp(logger)
  return {
    df = logger and logger.df or noOp,
    ef = logger and logger.ef or noOp,
    wf = logger and logger.wf or noOp,
  }
end

local function containsValue(values, expected)
  for _, value in ipairs(values or {}) do
    if value == expected then
      return true
    end
  end
  return false
end

function M.new(options)
  assert(type(options) == "table", "Window transition options must be a table")
  assert(type(options.catalog) == "table", "catalog is required")
  assert(type(options.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(options.configuredProfileDirectory) == "string", "configuredProfileDirectory is required")
  assert(type(options.currentRequest) == "function", "currentRequest is required")
  assert(type(options.fail) == "function", "fail is required")
  assert(type(options.finish) == "function", "finish is required")
  assert(type(options.hs) == "table", "hs is required")
  assert(type(options.later) == "function", "later is required")

  local catalog = options.catalog
  local chromeBundleId = options.chromeBundleId
  local configuredProfileDirectory = options.configuredProfileDirectory
  local currentRequest = options.currentRequest
  local fail = options.fail
  local finish = options.finish
  local hs = options.hs
  local later = options.later
  local log = loggerOrNoOp(options.log)
  local privateFocus = options.privateFocus
  local privateFocusError = options.privateFocusError
  local closeGestureTap
  local createdWindowCloseRecovery = {}
  local suppressCloseMouseUp = false
  local transitionShield
  local transition = {}

  local function screenUuid(screen)
    return screen and screen:getUUID() or nil
  end

  local function releaseTransitionShield()
    local shield = transitionShield
    transitionShield = nil
    if shield then
      pcall(function()
        shield:delete()
      end)
    end
  end

  local function captureTransitionShield(screen)
    releaseTransitionShield()
    if type(hs.screenRecordingState) == "function" and not hs.screenRecordingState() then
      return false, "Hammerspoon does not have Screen Recording permission"
    end

    local shield
    local captured, captureError = xpcall(function()
      local frame = screen and screen:frame() or nil
      local snapshotFrame = screen and frame and screen:absoluteToLocal(frame) or nil
      local image = screen and snapshotFrame and screen:snapshot(snapshotFrame) or nil
      if not frame or not image then
        error("the target display snapshot is unavailable")
      end

      shield = hs.canvas.new(frame)
      if not shield then
        error("the transition shield could not be created")
      end
      shield[1] = {
        frame = { x = 0, y = 0, w = frame.w, h = frame.h },
        image = image,
        imageScaling = "scaleProportionally",
        type = "image",
      }
      shield:canvasMouseEvents(false, false, false, false)
      shield:bringToFront(false):show()
    end, debug.traceback)

    if not captured then
      if shield then
        pcall(function()
          shield:delete()
        end)
      end
      return false, captureError
    end

    transitionShield = shield
    return true
  end


  local function prepareAccessibilityElement(element, deadline)
    if not element then
      return false
    end
    if not deadline then
      return true
    end
    local remaining = deadline - hs.timer.secondsSinceEpoch()
    return remaining > 0 and element:setTimeout(remaining) ~= nil
  end

  local function readAccessibilityAttribute(element, attribute, deadline)
    if not prepareAccessibilityElement(element, deadline) then
      return nil, "Accessibility read could not be prepared"
    end
    local value, readError = element:attributeValue(attribute)
    if deadline then
      element:setTimeout(0)
      if hs.timer.secondsSinceEpoch() >= deadline then
        return nil, "Accessibility deadline expired"
      end
    end
    return value, readError
  end

  local function isDestinationControl(kind, element, role, deadline)
    if type(element) ~= "userdata" then
      return false
    end
    role = role or readAccessibilityAttribute(element, "AXRole", deadline)
    if role ~= "AXTextField" then
      return false
    end

    local description = readAccessibilityAttribute(element, "AXDescription", deadline)
    if kind == "filter" then
      return type(description) == "string" and description:match("^Filter ") ~= nil
    end
    return description == "Address and search bar"
  end

  local function focusedDestinationControl(kind, root, application, deadline)
    local applicationElement = hs.axuielement.applicationElement(application)
    local control = readAccessibilityAttribute(applicationElement, "AXFocusedUIElement", deadline)
    if not isDestinationControl(kind, control, nil, deadline)
      or readAccessibilityAttribute(control, "AXFocused", deadline) ~= true
      or readAccessibilityAttribute(control, "AXWindow", deadline) ~= root
    then
      return nil
    end

    return control
  end

  local function walkAccessibility(root, maxDepth, skipWebAreas, visit, deadline)
    local visited = {}
    local function walk(element, depth)
      if type(element) ~= "userdata"
        or visited[element]
        or depth > maxDepth
        or (deadline and hs.timer.secondsSinceEpoch() >= deadline)
      then
        return nil
      end

      visited[element] = true
      local role = readAccessibilityAttribute(element, "AXRole", deadline)
      if skipWebAreas and role == "AXWebArea" then
        return nil
      end
      local result, skipChildren = visit(element, role)
      if result ~= nil then
        return result
      end
      if not skipChildren then
        for _, child in ipairs(readAccessibilityAttribute(element, "AXChildren", deadline) or {}) do
          local found = walk(child, depth + 1)
          if found then
            return found
          end
        end
      end
      return nil
    end
    return root and walk(root, 0) or nil
  end

  local function findDestinationControl(kind, root, deadline)
    return walkAccessibility(root, kind == "filter" and 30 or 20, kind ~= "filter", function(element, role)
      if isDestinationControl(kind, element, role, deadline) then
        return element
      end
      return nil
    end, deadline)
  end

  local function destinationControl(kind, window, deadline)
    local root = window and hs.axuielement.windowElement(window) or nil
    if not root then
      return nil
    end

    local focusedControl = focusedDestinationControl(kind, root, window:application(), deadline)
    if focusedControl then
      return focusedControl
    end

    return findDestinationControl(kind, root, deadline)
  end

  local function topStandardWindowOnScreen(screen, excludedWindowId, knownWindow)
    local expectedScreenUuid = screenUuid(screen)
    local activeSpace = screen and hs.spaces.activeSpaceOnScreen(screen) or nil
    if not expectedScreenUuid or not activeSpace then
      return nil
    end

    local deadline = hs.timer.secondsSinceEpoch() + CLOSE_WINDOW_ORDER_TIMEOUT_SECONDS
    local applicationWindows = {}
    local eligibleApplications = {}
    -- Running-application metadata does not query Accessibility. Restrict the
    -- snapshot to the same visible ordinary apps as orderedWindows, excluding
    -- WindowServer and other system-owned surfaces that have no application.
    for _, application in ipairs(hs.application.runningApplications()) do
      if application:kind() > 0 and not application:isHidden() then
        eligibleApplications[application:pid()] = application
      end
    end
    -- WindowServer supplies geometry and z-order without AX calls to every app.
    -- Only a possible obstruction ahead of the already-validated recovery window
    -- needs Accessibility inspection. An unreadable obstruction fails closed.
    for _, record in ipairs(hs.window.list(true) or {}) do
      if hs.timer.secondsSinceEpoch() >= deadline then
        return nil
      end
      local id = record.kCGWindowNumber
      local bounds = record.kCGWindowBounds
      if id and id ~= excludedWindowId
        and record.kCGWindowIsOnscreen and bounds
        and screenUuid(hs.screen.find({
          x = bounds.X, y = bounds.Y, w = bounds.Width, h = bounds.Height,
        })) == expectedScreenUuid
      then
        local pid = record.kCGWindowOwnerPID
        local owner = eligibleApplications[pid]
        if owner then
          local spaces = hs.spaces.windowSpaces(id)
          if not spaces or hs.timer.secondsSinceEpoch() >= deadline then
            return nil
          end
          if containsValue(spaces, activeSpace) then
            if id == knownWindow:id() then
              return knownWindow
            end
            local windows = applicationWindows[pid]
            if not windows then
              -- The PID-based AX constructor reads AXRole before a timeout can be
              -- set. Wrapping hs.application's existing element avoids that read.
              local application = hs.axuielement.applicationElement(owner)
              windows = readAccessibilityAttribute(application, "AXWindows", deadline)
              if type(windows) ~= "table" then
                return nil
              end
              applicationWindows[pid] = windows
            end
            local matched = false
            for _, element in ipairs(windows) do
              if not prepareAccessibilityElement(element, deadline) then
                return nil
              end
              local window = element:asHSWindow()
              local candidateId = window and window:id() or nil
              element:setTimeout(0)
              if hs.timer.secondsSinceEpoch() >= deadline then
                return nil
              end
              if candidateId == id then
                matched = true
                local subrole = readAccessibilityAttribute(element, "AXSubrole", deadline)
                if not subrole then
                  return nil
                end
                if subrole == "AXStandardWindow" then
                  return window
                end
                break
              end
            end
            if not matched then
              return nil
            end
          end
        end
      end
    end
    return nil
  end

  -- hs.window.get enumerates every application's windows (tens of
  -- milliseconds) and omits windows on inactive Spaces, so recovery keeps the
  -- exact window objects captured at registration instead.
  local function createdWindowIsOpen(recovery)
    return recovery.createdElement:isValid() ~= false
  end

  local function recoveryWindow(recovery, requireTop, excludedWindowId)
    local window = recovery and recovery.window or nil
    local application = window and window:application() or nil
    local screen = window and window:screen() or nil
    if not window
      or window:id() ~= recovery.windowId
      or not window:isStandard()
      or window:isMinimized()
      or not application
      or application:isHidden()
      or application:bundleID() ~= recovery.bundleId
      or application:bundleID() == chromeBundleId
      or screenUuid(screen) ~= recovery.screenUuid
    then
      return nil
    end

    local activeSpace = hs.spaces.activeSpaceOnScreen(screen)
    local spaces = hs.spaces.windowSpaces(window)
    if not activeSpace or not spaces or not containsValue(spaces, activeSpace) then
      return nil
    end

    if requireTop then
      local topWindow = topStandardWindowOnScreen(screen, excludedWindowId, window)
      if not topWindow or topWindow:id() ~= window:id() then
        return nil
      end
    end
    return window
  end

  local function createdWindowCloseButtonFrame(window)
    local root = window and hs.axuielement.windowElement(window) or nil
    local closeButton = root and root:attributeValue("AXCloseButton") or nil
    local frame = closeButton and closeButton:attributeValue("AXFrame") or nil
    if not frame
      or type(frame.x) ~= "number"
      or type(frame.y) ~= "number"
      or type(frame.w) ~= "number"
      or type(frame.h) ~= "number"
      or frame.w <= 0
      or frame.h <= 0
    then
      return nil
    end
    return frame
  end

  local function chromeTabCount(window)
    local root = window and hs.axuielement.windowElement(window) or nil
    if not root then
      return nil
    end
    local deadline = hs.timer.secondsSinceEpoch() + CLOSE_TAB_SCAN_TIMEOUT_SECONDS
    local count = 0
    local visited = {}
    local function scan(element, depth)
      if type(element) ~= "userdata" or depth > 20
        or hs.timer.secondsSinceEpoch() >= deadline
      then
        return false
      end
      if visited[element] then
        return true
      end
      visited[element] = true
      local role = readAccessibilityAttribute(element, "AXRole", deadline)
      if not role then
        return false
      end
      if role == "AXWebArea" then
        return true
      end
      if role == "AXRadioButton" then
        local subrole = readAccessibilityAttribute(element, "AXSubrole", deadline)
        if not subrole then
          return false
        end
        if subrole == "AXTabButton" then
          count = count + 1
          return true
        end
      end
      local children, readError = readAccessibilityAttribute(element, "AXChildren", deadline)
      if readError or hs.timer.secondsSinceEpoch() >= deadline then
        return false
      end
      for _, child in ipairs(children or {}) do
        if not scan(child, depth + 1) then
          return false
        end
        -- Two tabs already prove Chrome must own this Command-W.
        if count >= 2 then
          return true
        end
      end
      return true
    end
    local complete = scan(root, 0)
    return complete and hs.timer.secondsSinceEpoch() < deadline and count > 0 and count or nil
  end

  local function pointIsInsideFrame(point, frame)
    return point
      and point.x >= frame.x
      and point.x <= frame.x + frame.w
      and point.y >= frame.y
      and point.y <= frame.y + frame.h
  end

  local function finishCreatedWindowClose(windowId, attempt)
    attempt = attempt or 0
    local recovery = createdWindowCloseRecovery[windowId]
    if not recovery or not createdWindowIsOpen(recovery) then
      return
    end
    local targetWindow = recovery.createdWindow
    local restoreWindow = recoveryWindow(recovery, false)
    if not restoreWindow then
      recovery.closing = false
      log.wf("Prior non-Chrome window became unavailable before closing created Chrome window %d", windowId)
      targetWindow:close()
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    if focusedWindow and focusedWindow:id() == restoreWindow:id() then
      if targetWindow:close() == false then
        recovery.closing = false
        log.wf("Could not close created Chrome window %d after restoring prior focus", windowId)
      end
      return
    end

    if attempt * CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS
      >= CREATED_WINDOW_CLOSE_FOCUS_TIMEOUT_SECONDS
    then
      recovery.closing = false
      log.wf("Timed out restoring prior focus before closing created Chrome window %d", windowId)
      targetWindow:close()
      return
    end

    later(CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS, function()
      finishCreatedWindowClose(windowId, attempt + 1)
    end, false)
  end

  local function beginCreatedWindowClose(window, recovery)
    if recovery.closing then
      return true
    end

    local excludedWindowId = recovery.screenUuid == recovery.targetScreenUuid and window:id() or nil
    local restoreWindow = recoveryWindow(recovery, true, excludedWindowId)
    if not restoreWindow then
      return false
    end

    recovery.closing = true
    if restoreWindow:focus() == false then
      recovery.closing = false
      return false
    end
    later(CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS, function()
      finishCreatedWindowClose(window:id(), 0)
    end, false)
    return true
  end

  local function focusedCreatedWindowCloseRecovery()
    local window = hs.window.focusedWindow()
    local windowId = window and window:id() or nil
    local application = window and window:application() or nil
    local recovery = windowId and createdWindowCloseRecovery[windowId] or nil
    if not recovery
      or not application
      or application:bundleID() ~= chromeBundleId
      or screenUuid(window:screen()) ~= recovery.targetScreenUuid
    then
      return nil, nil
    end
    return window, recovery
  end

  local function closeShortcutFlags(event)
    if event:getKeyCode() ~= hs.keycodes.map.w then
      return nil
    end
    local flags = event:getFlags()
    if not flags.cmd or flags.alt or flags.ctrl then
      return nil
    end
    return flags
  end

  local function handleCreatedWindowCloseGesture(event)
    local eventType = event:getType()
    if eventType == hs.eventtap.event.types.leftMouseUp and suppressCloseMouseUp then
      suppressCloseMouseUp = false
      return true
    end
    if next(createdWindowCloseRecovery) == nil then
      return false
    end

    -- Classify the event before any Accessibility lookup; this tap sees every
    -- keystroke and click while a created window has recovery state.
    local closeFlags
    if eventType == hs.eventtap.event.types.keyDown then
      closeFlags = closeShortcutFlags(event)
      if not closeFlags then
        return false
      end
    elseif eventType ~= hs.eventtap.event.types.leftMouseDown then
      return false
    end

    local window, recovery = focusedCreatedWindowCloseRecovery()
    if not window then
      return false
    end

    if closeFlags then
      if closeFlags.shift or chromeTabCount(window) == 1 then
        return beginCreatedWindowClose(window, recovery)
      end
      return false
    end
    local closeButtonFrame = createdWindowCloseButtonFrame(window)
    if not closeButtonFrame or not pointIsInsideFrame(event:location(), closeButtonFrame) then
      return false
    end

    local intercepted = beginCreatedWindowClose(window, recovery)
    if intercepted then
      suppressCloseMouseUp = true
    end
    return intercepted
  end


  local function openTabOutTabInExactWindow(
    kind,
    window,
    browserProcessId,
    browserWindowId,
    authorityToken
  )
    local url = NEW_TAB_URL
    local urlError
    if kind == "filter" then
      url, urlError = catalog:filterFocusUrl()
    end
    if not url then
      return false, urlError
    end

    local nativeWindowId = window and window:id() or nil
    if not nativeWindowId then
      return false, "The exact Chrome window identity is unavailable"
    end
    local called, opened, navigationError = pcall(
      privateFocus.navigate,
      browserProcessId,
      nativeWindowId,
      browserWindowId,
      authorityToken,
      "open-tab",
      url
    )
    if not called then
      return false, opened
    end
    return opened == true, navigationError
  end

  local function pollUntil(timeout, timeoutMessage, probe, onReady, onFailure, deadline)
    deadline = deadline or (hs.timer.secondsSinceEpoch() + timeout)
    local remaining = deadline - hs.timer.secondsSinceEpoch()
    if remaining <= 0 then
      onFailure(timeoutMessage)
      return
    end

    local ready, value, errorMessage = probe(deadline)
    remaining = deadline - hs.timer.secondsSinceEpoch()
    if remaining <= 0 then
      onFailure(timeoutMessage)
      return
    end
    if ready then
      onReady(value)
      return
    end
    if errorMessage then
      onFailure(errorMessage)
      return
    end
    later(math.min(WINDOW_FOCUS_RETRY_INTERVAL_SECONDS, remaining), function()
      pollUntil(timeout, timeoutMessage, probe, onReady, onFailure, deadline)
    end, true)
  end

  local function activeTargetWindowError(window, expectedWindowId)
    local windowId = window and window:id() or nil
    local application = window and window:application() or nil
    local processId = application and application:pid() or nil
    if not windowId
      or windowId ~= expectedWindowId
      or not application
      or application:bundleID() ~= chromeBundleId
    then
      return "The Chrome window is no longer available"
    end

    local request = currentRequest()
    local windowScreen = window:screen()
    local windowSpaces = hs.spaces.windowSpaces(window)
    local frontmostApplication = hs.application.frontmostApplication()
    local focusedWindow = hs.window.focusedWindow()
    if not request
      or type(request.browserProcessId) ~= "number"
      or processId ~= request.browserProcessId
      or not window:isStandard()
      or window:isMinimized()
      or application:isHidden()
      or not frontmostApplication
      or frontmostApplication:bundleID() ~= chromeBundleId
      or frontmostApplication:pid() ~= request.browserProcessId
      or not focusedWindow
      or focusedWindow:id() ~= expectedWindowId
      or screenUuid(windowScreen) ~= request.screenUuid
      or hs.spaces.activeSpaceOnScreen(windowScreen) ~= request.targetSpaceId
      or not windowSpaces
      or not containsValue(windowSpaces, request.targetSpaceId)
      or catalog:profileFor(expectedWindowId) ~= configuredProfileDirectory
    then
      return "The exact Chrome window is no longer keyboard-active on the target Desktop"
    end
    return nil
  end

  local function waitForTargetWindowFocus(window, browserProcessId, onFocused, onFailure)
    local expectedWindowId = window and window:id() or nil
    pollUntil(TARGET_FOCUS_TIMEOUT_SECONDS, "Timed out waiting for Chrome to activate the requested window", function()
      local application = hs.application.frontmostApplication()
      local focusedWindow = hs.window.focusedWindow()
      return application
        and application:bundleID() == chromeBundleId
        and application:pid() == browserProcessId
        and focusedWindow
        and focusedWindow:id() == expectedWindowId
        and focusedWindow:application()
        and focusedWindow:application():pid() == browserProcessId
    end, onFocused, onFailure)
  end

  local function focusDestinationControl(
    kind,
    window,
    browserProcessId,
    browserWindowId,
    authorityToken,
    deadline
  )
    local expectedWindowId = window and window:id() or nil
    local targetError = activeTargetWindowError(window, expectedWindowId)
    if targetError then
      return false, nil, targetError
    end

    local control = destinationControl(kind, window, deadline)
    if not control then
      return false
    end
    if kind == "newPage" and readAccessibilityAttribute(control, "AXValue", deadline) ~= "" then
      return false
    end

    local remainingSeconds = deadline - hs.timer.secondsSinceEpoch()
    if remainingSeconds <= 0 then
      return false
    end
    local called, valid = pcall(
      privateFocus.validate,
      browserProcessId,
      expectedWindowId,
      browserWindowId,
      authorityToken,
      remainingSeconds
    )
    if not called then
      return false, nil, tostring(valid)
    end
    if valid ~= true or hs.timer.secondsSinceEpoch() >= deadline then
      return false
    end

    if not prepareAccessibilityElement(control, deadline) then
      return false
    end
    local focused = control:setAttributeValue("AXFocused", true)
    control:setTimeout(0)
    if not focused or readAccessibilityAttribute(control, "AXFocused", deadline) ~= true then
      return false
    end
    if kind == "newPage" and readAccessibilityAttribute(control, "AXValue", deadline) ~= "" then
      return false, nil, "Chrome's address bar is not empty"
    end

    return true, control
  end

  local function waitForDestinationControlFocus(
    kind,
    window,
    browserProcessId,
    browserWindowId,
    authorityToken
  )
    pollUntil(
      DESTINATION_CONTROL_TIMEOUT_SECONDS,
      "Timed out waiting for the Tab Out destination control to accept keyboard focus",
      function(deadline)
        return focusDestinationControl(
          kind,
          window,
          browserProcessId,
          browserWindowId,
          authorityToken,
          deadline
        )
      end,
      function()
        log.df("Privately focused exact Chrome window %d", window:id())
        finish()
      end,
      function(controlError)
        fail("The Tab Out destination did not become ready", controlError)
      end
    )
  end

  local function focusWindowPrivately(
    window,
    browserProcessId,
    browserWindowId,
    authorityToken,
    allowCreatedWindowWithoutOnScreenMetadata
  )
    local windowId = window and window:id() or nil
    local application = window and window:application() or nil
    local processId = application and application:pid() or nil
    local windowScreen = window and window:screen() or nil
    local request = currentRequest()
    if not windowId
      or not window:isStandard()
      or window:isMinimized()
      or not application
      or application:bundleID() ~= chromeBundleId
      or application:isHidden()
      or type(processId) ~= "number"
      or processId ~= browserProcessId
      or type(browserWindowId) ~= "number"
    then
      return false, "The exact Chrome window identity is unavailable"
    end

    local windowSpaces = hs.spaces.windowSpaces(window)
    if not request
      or request.browserProcessId ~= browserProcessId
      or screenUuid(windowScreen) ~= request.screenUuid
      or hs.spaces.activeSpaceOnScreen(windowScreen) ~= request.targetSpaceId
      or not windowSpaces
      or not containsValue(windowSpaces, request.targetSpaceId)
      or catalog:profileFor(windowId) ~= configuredProfileDirectory
    then
      return false, "The Chrome window no longer matches the target display, Desktop, and profile"
    end

    if not privateFocus then
      return false, privateFocusError or "The private focus helper is unavailable"
    end

    local called, focused, focusError, focusDetails = pcall(
      privateFocus.focus,
      browserProcessId,
      windowId,
      browserWindowId,
      authorityToken,
      allowCreatedWindowWithoutOnScreenMetadata == true
    )
    if not called then
      return false, focused, nil
    end
    if not focused then
      return false,
        focusError or "The private focus helper rejected the target window",
        focusDetails
    end

    return true
  end

  local function privatelyActivateWindow(
    window,
    browserProcessId,
    browserWindowId,
    authorityToken,
    onActivated,
    allowCreatedWindowWithoutOnScreenMetadata,
    onPreMutationAuthorityChanged
  )
    local focused, focusError, focusDetails = focusWindowPrivately(
      window,
      browserProcessId,
      browserWindowId,
      authorityToken,
      allowCreatedWindowWithoutOnScreenMetadata
    )
    if not focused then
      if type(focusDetails) == "table"
        and focusDetails.authorityChanged == true
        and focusDetails.mutationStarted == false
        and type(onPreMutationAuthorityChanged) == "function"
      then
        onPreMutationAuthorityChanged(focusError, focusDetails)
        return false
      end
      fail("The Tab Out window could not be focused privately", focusError)
      return false
    end

    local request = currentRequest()
    if request then
      request.mutationStarted = true
    end

    waitForTargetWindowFocus(window, browserProcessId, onActivated, function(activationError)
      fail("The Tab Out window did not become keyboard-active", activationError)
    end)
    return true
  end

  local function replaceCreatedNewPageBootstrap(
    window,
    browserProcessId,
    browserWindowId,
    authorityToken,
    creationToken
  )
    if type(browserWindowId) ~= "number"
      or browserWindowId <= 0
      or browserWindowId % 1 ~= 0
    then
      return false, "The created browser window identity is unavailable"
    end
    if type(creationToken) ~= "string"
      or creationToken:match("^hs%-%d+%-%d+$") == nil
    then
      return false, "The created window token is unavailable"
    end

    local expectedBootstrapUrl, bootstrapError = catalog:createdBootstrapUrl(
      creationToken,
      false
    )
    if not expectedBootstrapUrl then
      return false, bootstrapError
    end

    local nativeWindowId = window and window:id() or nil
    if not nativeWindowId then
      return false, "The created native window identity is unavailable"
    end
    local called, replaced, navigationError = pcall(
      privateFocus.navigate,
      browserProcessId,
      nativeWindowId,
      browserWindowId,
      authorityToken,
      "replace-active-tab",
      NEW_TAB_URL,
      expectedBootstrapUrl
    )
    if not called then
      return false, replaced
    end
    return replaced == true, navigationError
  end

  -- Native Placement Bridge windows already contain their destination and are
  -- created inactive at final target bounds. The target-work-area snapshot stays
  -- above the inactive window until private activation and destination focus
  -- complete, so the created window is first exposed in its final frontmost state.
  function transition:activateCreated(
    kind,
    window,
    browserProcessId,
    browserWindowId,
    authorityToken,
    creationToken
  )
    privatelyActivateWindow(window, browserProcessId, browserWindowId, authorityToken, function()
      if kind == "newPage" then
        local replaced, replaceError = replaceCreatedNewPageBootstrap(
          window,
          browserProcessId,
          browserWindowId,
          authorityToken,
          creationToken
        )
        if not replaced then
          fail("The Tab Out new page could not be prepared", replaceError)
          return
        end
      end
      waitForDestinationControlFocus(
        kind,
        window,
        browserProcessId,
        browserWindowId,
        authorityToken
      )
    end, true)
  end

  function transition:activateExisting(
    kind,
    window,
    browserProcessId,
    browserWindowId,
    authorityToken,
    onPreMutationAuthorityChanged
  )
    return privatelyActivateWindow(window, browserProcessId, browserWindowId, authorityToken, function()
      local opened, openError = openTabOutTabInExactWindow(
        kind,
        window,
        browserProcessId,
        browserWindowId,
        authorityToken
      )
      if not opened then
        fail("Chrome could not open the Tab Out page", openError)
        return
      end

      log.df("Opened the %s destination in the privately selected Chrome window", kind)
      waitForDestinationControlFocus(
        kind,
        window,
        browserProcessId,
        browserWindowId,
        authorityToken
      )
    end, false, onPreMutationAuthorityChanged)
  end

  local function clearCreatedWindowCloseRecovery(windowId, expectedRecovery)
    local recovery = createdWindowCloseRecovery[windowId]
    if not recovery or (expectedRecovery and recovery ~= expectedRecovery) then
      return nil
    end

    createdWindowCloseRecovery[windowId] = nil
    if recovery.monitor then
      recovery.monitor:stop()
      recovery.monitor = nil
    end
    return recovery
  end

  local function repairCreatedWindowCloseFallback(recovery, closedWindowId, deadline)
    local restoreWindow = recoveryWindow(recovery, false)
    if not restoreWindow then
      return
    end

    local focusedWindow = hs.window.focusedWindow()
    local frontmostApplication = hs.application.frontmostApplication()
    local focusedApplication = focusedWindow and focusedWindow:application() or nil
    if focusedWindow and focusedWindow:id() == restoreWindow:id() then
      return
    end

    if frontmostApplication
      and frontmostApplication:bundleID() == chromeBundleId
      and focusedApplication
      and focusedApplication:bundleID() == chromeBundleId
      and focusedWindow:id() ~= closedWindowId
    then
      restoreWindow:focus()
      return
    end

    if frontmostApplication
      and frontmostApplication:bundleID() ~= chromeBundleId
    then
      return
    end

    deadline = deadline
      or (hs.timer.secondsSinceEpoch() + CREATED_WINDOW_CLOSE_FOCUS_TIMEOUT_SECONDS)
    if hs.timer.secondsSinceEpoch() >= deadline then
      return
    end
    later(CREATED_WINDOW_CLOSE_RETRY_INTERVAL_SECONDS, function()
      repairCreatedWindowCloseFallback(recovery, closedWindowId, deadline)
    end, false)
  end

  local function monitorCreatedWindowClose(windowId, recovery)
    recovery.monitor = hs.timer.waitUntil(function()
      return createdWindowCloseRecovery[windowId] ~= recovery
        or not createdWindowIsOpen(recovery)
    end, function()
      if createdWindowCloseRecovery[windowId] ~= recovery then
        return
      end
      recovery.monitor = nil
      createdWindowCloseRecovery[windowId] = nil
      repairCreatedWindowCloseFallback(recovery, windowId)
    end, CREATED_WINDOW_CLOSE_MONITOR_INTERVAL_SECONDS)
  end

  local function registerCreatedWindowCloseRecovery(request, window)
    local windowId = window and window:id() or nil
    local createdElement = windowId and hs.axuielement.windowElement(window) or nil
    if not createdElement
      or not request.focusedWindow
      or not request.focusedWindowId
      or not request.focusedWindowBundleId
      or not request.focusedWindowScreenUuid
      or request.focusedWindowBundleId == chromeBundleId
    then
      return
    end

    local recovery = {
      bundleId = request.focusedWindowBundleId,
      closing = false,
      createdElement = createdElement:setTimeout(CREATED_WINDOW_LIVENESS_TIMEOUT_SECONDS) or createdElement,
      createdWindow = window,
      screenUuid = request.focusedWindowScreenUuid,
      targetScreenUuid = request.screenUuid,
      window = request.focusedWindow,
      windowId = request.focusedWindowId,
    }
    local excludedWindowId = recovery.screenUuid == recovery.targetScreenUuid and windowId or nil
    if recoveryWindow(recovery, true, excludedWindowId) then
      createdWindowCloseRecovery[windowId] = recovery
      monitorCreatedWindowClose(windowId, recovery)
    end
  end


  function transition:captureShield(screen) return captureTransitionShield(screen) end
  function transition:releaseShield() releaseTransitionShield() end
  function transition:registerCreatedWindow(request, window) registerCreatedWindowCloseRecovery(request, window) end

  function transition:handleWindowDestroyed(window)
    local id = window and window:id() or nil
    if not id then
      return
    end

    local recovery = clearCreatedWindowCloseRecovery(id)
    if recovery then
      repairCreatedWindowCloseFallback(recovery, id)
    end
  end

  function transition:start()
    closeGestureTap = hs.eventtap.new({
      hs.eventtap.event.types.keyDown,
      hs.eventtap.event.types.leftMouseDown,
      hs.eventtap.event.types.leftMouseUp,
    }, function(event)
      local ok, intercepted = xpcall(function()
        return handleCreatedWindowCloseGesture(event)
      end, debug.traceback)
      if not ok then
        log.ef("Created-window close handling failed: %s", intercepted)
        return false
      end
      return intercepted == true
    end):start()
    return transition
  end

  return transition
end

return M
