local function currentDirectory()
  local source = debug.getinfo(1, "S").source
  return source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
end

local modulePath = currentDirectory() .. "/../../TabOut.spoon/init.lua"

local function runShortcut(kind, options)
  options = options or {}
  local targetHasChromeWindow = options.targetHasChromeWindow ~= false
  local otherHasChromeWindow = options.otherHasChromeWindow ~= false
  local chromeIsRunning = options.chromeIsRunning ~= false
  local cacheTargetProfile = options.cacheTargetProfile ~= false
  local targetProfileDirectory = options.targetProfileDirectory or "Profile 3"
  local targetSpaceType = options.targetSpaceType or "user"
  local targetHasInactiveSpaceChromeWindow = options.targetHasInactiveSpaceChromeWindow == true
  local targetDisplayPosition = options.targetDisplayPosition or 2
  local privateFocusAvailable = options.privateFocusAvailable ~= false
  local clock = 0
  local addressBarFocused = false
  local addressBarInputEmpty = false
  local browserInventoryReadCount = 0
  local fullCorrelationCount = 0
  local createdBrowserIdentityCheckedBeforeFinalization = false
  local createdBootstrapTokenCheckedBeforeFinalization = false
  local closeGestureCallback
  local closeGestureConsumed = false
  local readingCloseGesture = false
  local closeGestureElapsed = 0
  local closeTabReads = 0
  local recoveryAppReads = 0
  local closeMouseUpConsumed = false
  local chromeLaunchArguments
  local chromeLaunchCount = 0
  local chromeApplicationHidden = false
  local createdBrowserWindowId = 4004
  local createdMatchCallCount = 0
  local createdMatchLastFinishedAt
  local createdMatchesSpaced = true
  local createdMatchMaximumElapsed = 0
  local createdMatchStartedAt
  local createdBootstrapReplaced = false
  local createdTabCount = options.createdTabCount or 1
  local createdNewPageFinalizedAfterPrivateFocus = false
  local createdNewPageNavigationPending = false
  local createdNewPageNavigationReadCount = 0
  local createdPlacementToken = "hs-1800000000000-1"
  local createdTokenObservedBeforeFinalization = false
  local createdWindowNativeTabCloseAllowed = false
  local createdWindowClosed = false
  local createdWindowMoved = false
  local createdWindowPublished = false
  local createdWindowSpaceId
  local destinationFocusAttemptCount = 0
  local destinationIdentityRevalidationReadCount = 0
  local filterInputFocused = false
  local nativeBridgeRequest
  local extensionFocusRequested = false
  local privateFocusCount = 0
  local privateFocusAttemptCount = 0
  local profileInventoryRequestCount = 0
  local configuredProcessLookupCount = 0
  local unrelatedPrivateFocusAttempted = false
  local missingOnScreenMetadataAllowed
  local createdChromeWindow
  local remoteDestinationFocusCount = 0
  local remoteTopHidden = false
  local remoteTopApplication
  local failureAlert
  local failureLog
  local focusedWindow
  local frontmostApplication
  local navigationAfterPrivateFocus = false
  local otherChromeReceivedFocus = false
  local otherChromeRaised = false
  local originalWindow
  local openedFilter = false
  local openedNewPage = false
  local pendingTimers = {}
  local pendingWaits = {}
  local spaceSwitchCount = 0
  local targetActiveSpace = 11
  local shieldUsed = false
  local shieldFrame
  local shieldSnapshotRect
  local shieldVisible = false
  local shieldVisibleAtPrivateFocus = false
  local windowCreatedCallback
  local windowDestroyedCallback
  local targetBrowserWindowId = 1001
  local inactiveSpaceBrowserWindowId = 1002
  local isolatedPrivateOperationAttempted = false
  local isolatedWindowMutated = false
  local otherBrowserWindowId = 2002
  local targetDocumentUrl = "https://example.test/target"
  local inactiveSpaceDocumentUrl = "https://example.test/inactive"
  local otherDocumentUrl = "https://example.test/remote"
  local createdDocumentUrl = "chrome-extension://" .. string.rep("a", 32)
    .. "/index.html?"
    .. (kind == "filter" and "focusFilter=1&" or "")
    .. "tabOutPlacement=" .. createdPlacementToken
  local createdAxDocumentUrl = options.createdAxClearsFocusFilter and kind == "filter"
    and "chrome-extension://" .. string.rep("a", 32)
      .. "/index.html?tabOutPlacement=" .. createdPlacementToken
    or createdDocumentUrl
  local createdAxDocumentReadCount = 0
  local unrelatedBrowserWindowId = 5005
  local unrelatedDocumentUrl = "https://example.test/unrelated"
  local unrelatedNewChromeWindow
  local nonBootstrapTabOverwritten = false

  local function finishCreatedNewPageNavigation()
    createdNewPageNavigationPending = false
    createdDocumentUrl = "chrome://newtab/"
    createdAxDocumentUrl = createdDocumentUrl
  end

  local function addressBarValue()
    if createdChromeWindow and createdNewPageNavigationPending then
      createdNewPageNavigationReadCount = createdNewPageNavigationReadCount + 1
      if options.changeFocusDuringCreatedNewPageNavigation
        and createdNewPageNavigationReadCount == 1
      then
        focusedWindow = originalWindow
        frontmostApplication = remoteTopApplication
      end
      if createdNewPageNavigationReadCount > (options.createdNewPageNavigationDelayReads or 0) then
        finishCreatedNewPageNavigation()
      end
    end
    if createdChromeWindow then
      return createdDocumentUrl == "chrome://newtab/" and "" or createdDocumentUrl
    end
    return openedNewPage and "" or targetDocumentUrl
  end

  local function noOp() end
  local function returnSelf(self) return self end
  local function newWatcher() return { start = returnSelf, stop = noOp } end

  local function newScreen(uuid, x, canSnapshot)
    local screen = {}
    function screen:frame() return { h = 870, w = 1380, x = x, y = 30 } end
    function screen:fullFrame() return { h = 900, w = 1440, x = x, y = 0 } end
    function screen:absoluteToLocal(frame)
      local fullFrame = self:fullFrame()
      return {
        h = frame.h,
        w = frame.w,
        x = frame.x - fullFrame.x,
        y = frame.y - fullFrame.y,
      }
    end
    function screen:getUUID() return uuid end
    if canSnapshot then
      function screen:snapshot(rect)
        shieldSnapshotRect = rect
        return { name = uuid .. "-snapshot" }
      end
    end
    return screen
  end

  local targetScreen = newScreen("target-screen", (targetDisplayPosition - 1) * 1440, true)
  local otherScreen = newScreen("other-screen", targetDisplayPosition == 1 and 1440 or 0)
  local thirdScreen = newScreen("third-screen", targetDisplayPosition == 3 and 1440 or 2880)

  local chromeApplication = {
    kind = function() return 1 end,
    bundleID = function()
      return "com.google.Chrome"
    end,
    getMenuItems = function(_, callback)
      callback({
        {
          AXMenuItemMarkChar = "check",
          AXTitle = targetProfileDirectory == "Profile 8" and "Alternate Profile" or "Target Profile",
        },
      })
    end,
    isHidden = function()
      return chromeApplicationHidden
    end,
    pid = function()
      return 43250
    end,
  }
  local isolatedChromeApplication = {
    kind = function() return 1 end,
    bundleID = function()
      return "com.google.Chrome"
    end,
    isHidden = function()
      return false
    end,
    pid = function()
      return 54321
    end,
  }

  local function newChromeWindow(
    id,
    screen,
    isOtherWindow,
    initiallyMinimized,
    owningApplication
  )
    owningApplication = owningApplication or chromeApplication
    local currentFrame = screen:frame()
    local minimized = initiallyMinimized == true
    local window = {
      application = function()
        return owningApplication
      end,
      focus = function(self)
        if isOtherWindow then
          otherChromeReceivedFocus = true
          otherChromeRaised = true
        end
        focusedWindow = self
        return true
      end,
      frame = function()
        return currentFrame
      end,
      id = function()
        return id
      end,
      isMinimized = function()
        return minimized
      end,
      isStandard = function()
        return true
      end,
      raise = function(self)
        if isOtherWindow then
          otherChromeRaised = true
        end
        focusedWindow = self
        return true
      end,
      screen = function()
        return screen
      end,
      setFrame = function(_, frame)
        if id == 404 then createdWindowMoved = true end
        if id == 606 then isolatedWindowMutated = true end
        currentFrame = frame
      end,
      setMinimized = function(_, value)
        minimized = value == true
      end,
    }
    return window
  end

  local targetChromeWindow = newChromeWindow(101, targetScreen)
  local inactiveSpaceChromeWindow = newChromeWindow(102, targetScreen)
  local otherChromeWindow = newChromeWindow(202, otherScreen, true)
  local isolatedChromeWindow = newChromeWindow(
    606,
    targetScreen,
    false,
    false,
    isolatedChromeApplication
  )
  isolatedChromeApplication.allWindows = function()
    return options.isolatedChromeWindow and { isolatedChromeWindow } or {}
  end
  remoteTopApplication = {
    kind = function() return 1 end,
    pid = function() return 65432 end,
    bundleID = function()
      return "com.example.Editor"
    end,
    isHidden = function()
      return remoteTopHidden
    end,
  }
  local function newNonChromeWindow(id, screen, onFocus, onRaise)
    local window = {
      application = function() return remoteTopApplication end,
      id = function() return id end,
      isMinimized = function() return false end,
      isStandard = function() return true end,
      screen = function() return screen end,
    }
    function window:focus()
      onFocus(self)
      return true
    end
    if onRaise then
      function window:raise()
        onRaise(self)
        return true
      end
    end
    return window
  end

  local remoteTopWindow = newNonChromeWindow(303, otherScreen, function(window)
      otherChromeRaised = false
      frontmostApplication = remoteTopApplication
      focusedWindow = window
      if options.invalidateCloseRecoveryAfterFocus then
        remoteTopHidden = true
      end
    end, function() otherChromeRaised = false end)
  frontmostApplication = remoteTopApplication
  originalWindow = newNonChromeWindow(304, targetScreen, function(window)
      frontmostApplication = remoteTopApplication
      focusedWindow = window
    end)
  focusedWindow = targetHasChromeWindow and cacheTargetProfile and targetChromeWindow
    or (not targetHasChromeWindow and otherHasChromeWindow and chromeIsRunning and otherChromeWindow)
    or originalWindow

  local obstructionApplication = {
    pid = function() return 65433 end,
    kind = function() return options.closeRecoveryObstruction == "accessory" and 0 or 1 end,
    isHidden = function() return false end,
  }
  local recoveryObstruction = newNonChromeWindow(707,
    options.closeRecoveryObstruction == "remote" and targetScreen or otherScreen, noOp)
  recoveryObstruction.application = function() return obstructionApplication end

  local function currentConfiguredChromeWindows()
    local windows = {}
    if not chromeIsRunning then
      return windows
    end
    if createdChromeWindow and createdWindowPublished then
      table.insert(windows, createdChromeWindow)
    end
    if unrelatedNewChromeWindow then
      table.insert(windows, unrelatedNewChromeWindow)
    end
    if targetHasChromeWindow then
      table.insert(windows, targetChromeWindow)
    end
    if targetHasInactiveSpaceChromeWindow then
      table.insert(windows, inactiveSpaceChromeWindow)
    end
    if otherHasChromeWindow then
      table.insert(windows, otherChromeWindow)
    end
    return windows
  end

  local function currentChromeWindows()
    local windows = {}
    if options.isolatedChromeWindow then
      table.insert(windows, isolatedChromeWindow)
    end
    for _, window in ipairs(currentConfiguredChromeWindows()) do
      table.insert(windows, window)
    end
    return windows
  end

  local function currentOrderedWindows()
    local windows = {}
    local seen = {}
    local function append(window)
      local windowId = window and window:id() or nil
      if windowId and not seen[windowId] then
        seen[windowId] = true
        table.insert(windows, window)
      end
    end

    if readingCloseGesture and options.closeRecoveryObstruction then
      append(recoveryObstruction)
    end
    append(focusedWindow)
    if createdChromeWindow and createdWindowPublished and not createdChromeWindow:isMinimized() then
      append(createdChromeWindow)
    end
    append(unrelatedNewChromeWindow)
    if options.isolatedChromeWindow then
      append(isolatedChromeWindow)
    end
    append(originalWindow)
    if targetHasChromeWindow then
      append(targetChromeWindow)
    end
    if not chromeIsRunning or not otherHasChromeWindow then
      append(remoteTopWindow)
    elseif otherChromeRaised then
      append(otherChromeWindow)
      append(remoteTopWindow)
    else
      append(remoteTopWindow)
      append(otherChromeWindow)
    end
    return windows
  end

  chromeApplication.allWindows = function()
    return currentConfiguredChromeWindows()
  end

  local fakeAxElements = {}
  local function newAxElement(attributes, setAttribute)
    local element = {}
    fakeAxElements[element] = true
    local timeoutSeconds
    function element:setTimeout(timeout)
      timeoutSeconds = timeout > 0 and timeout or nil
      return self
    end
    function element:attributeValue(attribute)
      if readingCloseGesture and attributes.AXSubrole == "AXTabButton" then
        closeTabReads = closeTabReads + 1
      end
      if readingCloseGesture or openedFilter or openedNewPage then
        local delay = readingCloseGesture and (options.closeAccessibilityReadDelaySeconds or 0)
          or (options.destinationAccessibilityReadDelaySeconds or 0)
        clock = clock + math.min(delay, timeoutSeconds or delay)
        if timeoutSeconds and delay > timeoutSeconds then
          return nil
        end
      end
      if readingCloseGesture and options.closeAccessibilityReadFails
        and attributes.AXRole == "AXTextField" and attribute == "AXChildren"
      then
        return nil, "Accessibility read failed"
      end
      local value = attributes[attribute]
      return type(value) == "function" and value() or value
    end
    function element:setAttributeValue(attribute, value)
      return setAttribute and setAttribute(attribute, value) or false
    end
    function element:isValid()
      return true
    end
    return element
  end

  local axRoot
  local createdAxRoot
  local function createdWindowElementIsValid()
    return createdChromeWindow ~= nil
  end
  local function destinationControl(roleDescription, focused, onFocus, value)
    return newAxElement({
      AXChildren = {},
      AXDescription = roleDescription,
      AXFocused = focused,
      AXRole = "AXTextField",
      AXValue = value,
      AXWindow = function() return createdChromeWindow and createdAxRoot or axRoot end,
    }, function(attribute, value)
      if attribute == "AXFocused" and value == true then
        destinationFocusAttemptCount = destinationFocusAttemptCount + 1
        if destinationFocusAttemptCount <= (options.destinationFocusRejectedAttempts or 0) then
          return false
        end
        onFocus()
        return true
      end
      return false
    end)
  end

  local addressBar = destinationControl("Address and search bar", function()
    return addressBarFocused
      or (createdChromeWindow ~= nil and privateFocusCount > 0 and kind == "newPage")
  end, function()
    addressBarFocused = true
    addressBarInputEmpty = addressBarValue() == ""
  end, addressBarValue)
  local filterInput = destinationControl("Filter tabs, bookmarks, history…", function()
    return filterInputFocused
      or (createdChromeWindow ~= nil and privateFocusCount > 0 and kind == "filter")
  end, function()
    filterInputFocused = true
  end)
  local closeButton = newAxElement({
    AXFrame = function()
      return { h = 16, w = 16, x = targetScreen:frame().x + 12, y = 46 }
    end,
    AXRole = "AXButton",
  })
  local tabAttributes = { AXChildren = {}, AXRole = "AXRadioButton", AXSubrole = "AXTabButton" }
  local tabButton = newAxElement(tabAttributes)
  local secondTabButton = createdTabCount >= 2 and newAxElement(tabAttributes) or nil
  local thirdTabButton = createdTabCount >= 3 and newAxElement(tabAttributes) or nil
  local function chromeChildren()
    local children = { filterInput, addressBar, tabButton }
    if secondTabButton then table.insert(children, secondTabButton) end
    if thirdTabButton then table.insert(children, thirdTabButton) end
    return children
  end
  axRoot = newAxElement({
    AXChildren = chromeChildren,
    AXCloseButton = closeButton,
    AXDocument = targetDocumentUrl,
    AXRole = "AXWindow",
  })
  createdAxRoot = newAxElement({
    AXChildren = chromeChildren,
    AXCloseButton = closeButton,
    AXDocument = function()
      createdAxDocumentReadCount = createdAxDocumentReadCount + 1
      if options.createdWindowAxDocumentUnavailable then
        return nil
      end
      if createdAxDocumentReadCount <= (options.createdWindowAxDocumentUnavailableReads or 0) then
        return nil
      end
      return createdAxDocumentUrl
    end,
    AXRole = "AXWindow",
  })
  createdAxRoot.isValid = createdWindowElementIsValid
  local remoteAxRoot = newAxElement({
    AXChildren = {},
    AXDocument = otherDocumentUrl,
    AXRole = "AXWindow",
  })
  local unrelatedAxRoot = newAxElement({
    AXChildren = {},
    AXDocument = function()
      if options.emitBoundsOnlyNativeWindowAfterBridge then
        return nil
      end
      return options.emitMatchingNativeOnlyWindowAfterBridge
        and createdDocumentUrl
        or unrelatedDocumentUrl
    end,
    AXRole = "AXWindow",
  })
  local remoteDestinationControl = newAxElement({
    AXDescription = kind == "filter" and "Filter tabs, bookmarks, history…" or "Address and search bar",
    AXFocused = true,
    AXRole = "AXTextField",
    AXWindow = remoteAxRoot,
  }, function(attribute, value)
    if attribute == "AXFocused" and value == true then
      remoteDestinationFocusCount = remoteDestinationFocusCount + 1
      return true
    end
    return false
  end)
  local chromeAxElement = newAxElement({
    AXFocusedUIElement = function()
      if privateFocusCount == 0 or not createdChromeWindow then
        return nil
      end
      return options.focusedDestinationOwnerMismatch and remoteDestinationControl
        or (kind == "filter" and filterInput or addressBar)
    end,
  })

  local function schedule(queue, timer)
    timer.stopped = false
    function timer:stop()
      self.stopped = true
    end
    table.insert(queue, timer)
    return timer
  end

  local function recoveryApplicationElement(pid)
    recoveryAppReads = recoveryAppReads + 1
    if options.closeRecoveryObstruction == "unreadable" then
      return newAxElement({})
    end
    local elements = {}
    for _, window in ipairs(currentOrderedWindows()) do
      if window:application():pid() == pid then
        local element = newAxElement({ AXSubrole = window == recoveryObstruction
          and options.closeRecoveryObstruction == "nonstandard" and "AXDialog" or "AXStandardWindow" })
        element.asHSWindow = function() return window end
        table.insert(elements, element)
      end
    end
    return newAxElement({ AXWindows = elements })
  end

  local fakeHs = {
    accessibilityState = function()
      return true
    end,
    alert = {
      show = function(message)
        failureAlert = message
      end,
    },
    application = {
      runningApplications = function()
        return { chromeApplication, isolatedChromeApplication, remoteTopApplication, obstructionApplication }
      end,
      applicationForPID = function(processId)
        if processId == 43250 and chromeIsRunning then
          return chromeApplication
        end
        if processId == 54321 and options.isolatedChromeWindow then
          return isolatedChromeApplication
        end
        if processId == 65432 then return remoteTopApplication end
        if processId == 65433 then return obstructionApplication end
        return nil
      end,
      frontmostApplication = function()
        return frontmostApplication
      end,
      get = function(bundleId)
        if bundleId == "com.google.Chrome" and chromeIsRunning then
          return chromeApplication
        end
        return nil
      end,
      pathForBundleID = function(bundleId)
        if bundleId == "com.google.Chrome" then
          return "/Applications/Google Chrome.app"
        end
        return nil
      end,
    },
    autoLaunch = function() return true end,
    canvas = {
      new = function(frame)
        shieldUsed = true
        shieldFrame = frame
        return { bringToFront = returnSelf, canvasMouseEvents = returnSelf,
          delete = function() shieldVisible = false end,
          show = function(self) shieldVisible = true return self end }
      end,
    },
    axuielement = {
      applicationElementForPID = function(pid)
        clock = clock + (options.closeApplicationConstructorDelaySeconds or 0)
        return recoveryApplicationElement(pid)
      end,
      applicationElement = function(application)
        if application == chromeApplication then return chromeAxElement end
        return recoveryApplicationElement(application:pid())
      end,
      windowElement = function(window)
        if window == otherChromeWindow then
          return remoteAxRoot
        end
        if window == createdChromeWindow then
          return createdAxRoot
        end
        if window == unrelatedNewChromeWindow then
          return unrelatedAxRoot
        end
        return axRoot
      end,
    },
    eventtap = {
      event = {
        types = {
          keyDown = "keyDown",
          leftMouseDown = "leftMouseDown",
          leftMouseUp = "leftMouseUp",
        },
      },
      leftClick = function()
        frontmostApplication = chromeApplication
        local targetWindow = createdChromeWindow or targetChromeWindow
        targetWindow:focus()
      end,
      new = function(_, callback)
        closeGestureCallback = callback
        return newWatcher()
      end,
    },
    hotkey = {
      bind = function() return {} end,
    },
    fs = {
      attributes = function()
        return { ino = 1, modification = 1800000000, size = 100 }
      end,
    },
    http = {
      urlParts = _G.hs.http.urlParts,
    },
    json = {
      read = function(path)
        if path:match("/Local State$") then
          return {
            profile = {
              info_cache = {
                ["Profile 3"] = { name = "Target Profile" },
                ["Profile 8"] = { name = "Alternate Profile" },
              },
            },
          }
        end

        if path:match("/Secure Preferences$") then
          local isConfiguredProfile = path:find(
            "/Profile 3/Secure Preferences",
            1,
            true
          ) ~= nil
          local exposesTabOut = isConfiguredProfile
            or options.duplicateProfileExtension == true
          return {
            extensions = {
              settings = exposesTabOut and {
                [string.rep("a", 32)] = {
                  commands = {
                    ["open-filter-tab"] = {},
                    ["open-new-tab"] = {},
                  },
                },
              } or {},
            },
          }
        end

        return nil
      end,
    },
    keycodes = {
      map = { w = 13 },
    },
    logger = {
      new = function()
        return setmetatable({
          ef = function(formatString, ...)
            failureLog = string.format(formatString, ...)
          end,
        }, { __index = function() return noOp end })
      end,
    },
    mouse = {
      getCurrentScreen = function()
        return targetScreen
      end,
    },
    osascript = {
      applescript = function(script)
        if script:find("TAB_OUT_PROFILE_WINDOW_INVENTORY", 1, true) then
          browserInventoryReadCount = browserInventoryReadCount + 1
          local descriptors = {}
          if targetHasChromeWindow then
            local frame = targetChromeWindow:frame()
            table.insert(descriptors, {
              targetBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              targetDocumentUrl,
            })
          end
          if targetHasInactiveSpaceChromeWindow then
            local frame = inactiveSpaceChromeWindow:frame()
            table.insert(descriptors, {
              inactiveSpaceBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              inactiveSpaceDocumentUrl,
            })
          end
          if otherHasChromeWindow and chromeIsRunning then
            local frame = otherChromeWindow:frame()
            table.insert(descriptors, {
              otherBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              otherDocumentUrl,
            })
          end
          if createdChromeWindow then
            local frame = createdChromeWindow:frame()
            table.insert(descriptors, {
              createdBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              createdDocumentUrl,
            })
          end
          if unrelatedNewChromeWindow
            and not options.emitMatchingNativeOnlyWindowAfterBridge
            and not options.emitBoundsOnlyNativeWindowAfterBridge
          then
            local frame = unrelatedNewChromeWindow:frame()
            table.insert(descriptors, {
              unrelatedBrowserWindowId,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              unrelatedDocumentUrl,
            })
          end
          if options.ambiguousProfileWindowIdentity then
            local frame = targetChromeWindow:frame()
            table.insert(descriptors, {
              3003,
              { frame.x, frame.y, frame.x + frame.w, frame.y + frame.h },
              targetDocumentUrl,
            })
          end
          return true, descriptors
        end

        local focusesFilter = script:find("focusFilter=1", 1, true) ~= nil
        local focusesWindow = script:find("focusWindow=1", 1, true) ~= nil
        local opensNewPage = script:find("chrome://newtab/", 1, true) ~= nil
        local replacesCreatedBootstrap = script:find(
          'set URL of bootstrapTab to "chrome://newtab/"',
          1,
          true
        ) ~= nil
        navigationAfterPrivateFocus = privateFocusCount > 0 and focusedWindow == targetChromeWindow
        openedFilter = focusesFilter
        openedNewPage = opensNewPage
        if replacesCreatedBootstrap and createdChromeWindow then
          createdBrowserIdentityCheckedBeforeFinalization = script:find(
            "set candidateWindow to window id " .. createdBrowserWindowId,
            1,
            true
          ) ~= nil and script:find(
            'if (id of front window as text) is not "' .. createdBrowserWindowId .. '"',
            1,
            true
          ) ~= nil
          createdBootstrapTokenCheckedBeforeFinalization = script:find(
            "set bootstrapTab to active tab of candidateWindow",
            1,
            true
          ) ~= nil and script:find(
            'if (URL of bootstrapTab) is not "' .. createdDocumentUrl .. '"',
            1,
            true
          ) ~= nil
          if not createdBrowserIdentityCheckedBeforeFinalization then
            return false, nil, { OSAScriptErrorNumberKey = -2700 }
          end
          if options.createdFinalizationBrowserIdentityMismatch then
            return false, nil, { OSAScriptErrorNumberKey = -2700 }
          end
          if options.createdFinalizationTabChanged
            and createdBootstrapTokenCheckedBeforeFinalization
          then
            return false, nil, { OSAScriptErrorNumberKey = -2700 }
          elseif options.createdFinalizationTabChanged then
            nonBootstrapTabOverwritten = true
          end
          createdBootstrapReplaced = true
          createdNewPageFinalizedAfterPrivateFocus = privateFocusCount > 0
            and focusedWindow == createdChromeWindow
          createdTokenObservedBeforeFinalization = createdAxDocumentReadCount > 0
          createdNewPageNavigationPending = true
          if (options.createdNewPageNavigationDelayReads or 0) == 0 then
            finishCreatedNewPageNavigation()
          end
        end
        if focusesWindow then
          extensionFocusRequested = true
          if focusesFilter then
            openedFilter = true
          else
            openedNewPage = true
          end
          local requestedWindow = createdChromeWindow or targetChromeWindow
          requestedWindow:focus()
        end
        if script:match("%f[%a]activate%f[%A]") then
          otherChromeRaised = true
        end
        return true
      end,
    },
    screen = {
      find = function(frame)
        for _, screen in ipairs({ targetScreen, otherScreen, thirdScreen }) do
          if screen:frame().x == frame.x then return screen end
        end
        return nil
      end,
      allScreens = function()
        if options.screenCount == 1 then
          return { targetScreen }
        elseif options.screenCount == 3 then
          return { otherScreen, thirdScreen, targetScreen }
        end
        return { targetScreen, otherScreen }
      end,
      mainScreen = function()
        return targetScreen
      end,
      watcher = {
        new = newWatcher,
      },
    },
    screenRecordingState = function()
      return options.screenRecordingAvailable ~= false
    end,
    settings = {
      get = function()
        if options.rememberedTargetSpace then
          return { ["target-screen"] = 12 }
        end
        return nil
      end,
      set = function() end,
    },
    spaces = {
      activeSpaceOnScreen = function(screen)
        return screen == targetScreen and targetActiveSpace or 22
      end,
      gotoSpace = function(spaceId)
        targetActiveSpace = spaceId
        spaceSwitchCount = spaceSwitchCount + 1
        return true
      end,
      spaceType = function(spaceId)
        if spaceId == 11 and targetSpaceType == "fullscreen" then
          return "fullscreen"
        end
        return "user"
      end,
      spacesForScreen = function(screen)
        if screen ~= targetScreen then
          return { 22 }
        end
        return targetSpaceType == "fullscreen" and { 12, 11 } or { 11 }
      end,
      watcher = {
        new = newWatcher,
      },
      windowSpaces = function(window)
        if type(window) == "number" then
          for _, candidate in ipairs(currentOrderedWindows()) do
            if candidate:id() == window then window = candidate; break end
          end
        end
        if window == inactiveSpaceChromeWindow then
          return { 33 }
        end
        if window == targetChromeWindow then
          return { 11 }
        end
        if window == createdChromeWindow then
          return { createdWindowSpaceId or targetActiveSpace }
        end
        if window == unrelatedNewChromeWindow then
          return { createdWindowSpaceId or targetActiveSpace }
        end
        if window == originalWindow and targetSpaceType == "fullscreen" then
          return { 11 }
        end
        return window == originalWindow and { targetActiveSpace } or { 22 }
      end,
    },
    timer = {
      doEvery = function(delay, callback)
        return schedule(pendingTimers, {
          callback = callback,
          due = clock + delay,
          interval = delay,
          repeating = true,
        })
      end,
      doAfter = function(delay, callback)
        return schedule(pendingTimers, {
          callback = callback,
          due = clock + delay,
        })
      end,
      secondsSinceEpoch = function()
        return 1800000000 + clock
      end,
      waitUntil = function(predicate, action)
        return schedule(pendingWaits, {
          action = action,
          predicate = predicate,
        })
      end,
    },
    task = {
      new = function(_, callback, arguments)
        chromeLaunchArguments = arguments
        return {
          start = function()
            chromeLaunchCount = chromeLaunchCount + 1
            chromeIsRunning = true
            callback(0, "", "")
            return true
          end,
          terminate = function() end,
        }
      end,
    },
    window = {
      filter = {
        new = function()
          return {
            getWindows = function()
              return currentChromeWindows()
            end,
            subscribe = function(_, event, callback, immediate)
              if event == "windowCreated" then
                windowCreatedCallback = callback
              elseif event == "windowDestroyed" then
                windowDestroyedCallback = callback
              elseif event == "windowFocused" then
                if immediate and (focusedWindow == otherChromeWindow or focusedWindow == targetChromeWindow) then
                  callback(focusedWindow)
                end
              end
            end,
          }
        end,
        windowCreated = "windowCreated",
        windowDestroyed = "windowDestroyed",
        windowFocused = "windowFocused",
      },
      focusedWindow = function()
        return focusedWindow
      end,
      get = function(windowId)
        if createdChromeWindow
          and createdChromeWindow:id() == windowId
          and not options.createdWindowOnInactiveSpace
        then
          return createdChromeWindow
        end
        if unrelatedNewChromeWindow and unrelatedNewChromeWindow:id() == windowId then
          return unrelatedNewChromeWindow
        end
        for _, window in ipairs({
          targetChromeWindow,
          inactiveSpaceChromeWindow,
          otherChromeWindow,
          isolatedChromeWindow,
          remoteTopWindow,
          originalWindow,
        }) do
          if window and window:id() == windowId then
            return window
          end
        end
        return nil
      end,
      orderedWindows = function()
        error("must not enumerate every application's windows")
      end,
      list = function(allWindows)
        local records = {}
        if options.includeSystemSurface and allWindows then
          local frame = otherScreen:frame()
          table.insert(records, {
            kCGWindowBounds = { X = frame.x, Y = frame.y, Width = frame.w, Height = frame.h },
            kCGWindowIsOnscreen = true,
            kCGWindowLayer = 25,
            kCGWindowNumber = 909,
            kCGWindowOwnerPID = 99999,
          })
        end
        for _, window in ipairs(currentOrderedWindows()) do
          local frame = window:screen():frame()
          local layer = window == recoveryObstruction and (options.closeRecoveryObstructionLayer or 0)
            or ((window == remoteTopWindow or window == originalWindow) and (options.recoveryWindowLayer or 0))
            or 0
          if allWindows or layer < 20 then
            table.insert(records, {
              kCGWindowBounds = { X = frame.x, Y = frame.y, Width = frame.w, Height = frame.h },
              kCGWindowIsOnscreen = true,
              kCGWindowLayer = layer,
              kCGWindowNumber = window:id(),
              kCGWindowOwnerPID = window:application():pid(),
            })
          end
        end
        return records
      end,
      _orderedwinids = function()
        local ids = {}
        for _, window in ipairs(currentOrderedWindows()) do
          table.insert(ids, window:id())
        end
        return ids
      end,
    },
  }

  local function runPendingTimers()
    while true do
      local waitFired = false
      for index = #pendingWaits, 1, -1 do
        local wait = pendingWaits[index]
        if wait.stopped then
          table.remove(pendingWaits, index)
        elseif wait.predicate() then
          wait.stopped = true
          table.remove(pendingWaits, index)
          wait.action(wait)
          waitFired = true
        end
      end

      local nextIndex
      local nextTimer
      for index, timer in ipairs(pendingTimers) do
        if not timer.stopped and (not nextTimer or timer.due < nextTimer.due) then
          nextIndex = index
          nextTimer = timer
        end
      end

      if not nextTimer and not waitFired then
        break
      end
      if nextTimer then
        table.remove(pendingTimers, nextIndex)
        clock = math.max(clock, nextTimer.due)
        nextTimer.callback()
        if nextTimer.repeating and not nextTimer.stopped then
          nextTimer.due = clock + nextTimer.interval
          table.insert(pendingTimers, nextTimer)
        end
      end
    end
  end

  local environment = setmetatable({
    hs = fakeHs,
    type = function(value)
      return fakeAxElements[value] and "userdata" or _G.type(value)
    end,
  }, { __index = _G })
  local chunk, loadError = loadfile(modulePath, "t", environment)
  assert(chunk, loadError)
  local tabOut = chunk()

  local function browserWindowIdentityFor(window)
    if window == targetChromeWindow then
      return targetBrowserWindowId
    end
    if window == inactiveSpaceChromeWindow then
      return inactiveSpaceBrowserWindowId
    end
    if window == otherChromeWindow then
      return otherBrowserWindowId
    end
    if window == createdChromeWindow then
      return createdBrowserWindowId
    end
    if window == unrelatedNewChromeWindow then
      return unrelatedBrowserWindowId
    end
    return nil
  end

  local authoritySerial = 0
  local function issueAuthority()
    authoritySerial = authoritySerial + 1
    return "authority-" .. authoritySerial
  end

  local privateFocus = {
    capability = function()
      if not privateFocusAvailable then
        return nil, "private focus capability unavailable"
      end
      return true
    end,
    configuredProcess = function()
      configuredProcessLookupCount = configuredProcessLookupCount + 1
      if not chromeIsRunning then
        return nil, "The configured Chrome user-data process lock is unavailable"
      end
      if options.firstProfileInventoryProcessUnavailable
        and configuredProcessLookupCount == 1
      then
        return 99999
      end
      return options.configuredProcessId or 43250
    end,
    closeCreated = function(pid, windowId, browserWindowId, extensionId, creationToken)
      fullCorrelationCount = fullCorrelationCount + 1
      isolatedPrivateOperationAttempted = isolatedPrivateOperationAttempted
        or pid == 54321
        or windowId == isolatedChromeWindow:id()
      if pid ~= 43250
        or not createdChromeWindow
        or windowId ~= createdChromeWindow:id()
        or browserWindowId ~= createdBrowserWindowId
        or extensionId ~= string.rep("a", 32)
        or creationToken ~= createdPlacementToken
        or not createdDocumentUrl:find("tabOutPlacement=" .. creationToken, 1, true)
        or createdTabCount ~= 1
      then
        return nil, "The created Chrome window identity changed"
      end
      return createdChromeWindow:close()
    end,
    focus = function(
      pid,
      windowId,
      browserWindowId,
      authorityToken,
      allowCreatedWindowWithoutOnScreenMetadata
    )
      isolatedPrivateOperationAttempted = isolatedPrivateOperationAttempted
        or pid == 54321
        or windowId == isolatedChromeWindow:id()
      privateFocusAttemptCount = privateFocusAttemptCount + 1
      unrelatedPrivateFocusAttempted = unrelatedPrivateFocusAttempted
        or (unrelatedNewChromeWindow ~= nil and windowId == unrelatedNewChromeWindow:id())
      local targetWindow = createdChromeWindow or targetChromeWindow
      if options.firstPrivateFocusAuthorityChangedBeforeMutation
        and privateFocusAttemptCount == 1
      then
        return nil, "The exact Chrome window identity changed", {
          authorityChanged = true,
          mutationStarted = false,
        }
      end
      if pid ~= 43250
        or type(authorityToken) ~= "string"
        or windowId ~= targetWindow:id()
        or browserWindowId ~= browserWindowIdentityFor(targetWindow)
      then
        return nil, "unknown Chrome window"
      end
      privateFocusCount = privateFocusCount + 1
      missingOnScreenMetadataAllowed = allowCreatedWindowWithoutOnScreenMetadata == true
      shieldVisibleAtPrivateFocus = shieldVisible
      if targetWindow == createdChromeWindow
        and options.createdWindowOmitsOnScreenMetadata == true
        and allowCreatedWindowWithoutOnScreenMetadata ~= true
      then
        return nil, "window-id is not a normal window owned by that Chrome pid"
      end
      if targetWindow == createdChromeWindow and options.createdWindowReportsOffscreen == true then
        return nil, "window-id is not a normal window owned by that Chrome pid"
      end
      if options.privateFocusSucceeds == false then
        return nil, "mock private focus failure"
      end
      if targetWindow == createdChromeWindow and targetWindow:isMinimized() then
        targetWindow:setMinimized(false)
      end
      frontmostApplication = chromeApplication
      focusedWindow = targetWindow
      return true
    end,
    inventory = function(pid, timeoutSeconds)
      browserInventoryReadCount = browserInventoryReadCount + 1
      fullCorrelationCount = fullCorrelationCount + 1
      if pid ~= 43250 or not chromeIsRunning then
        return nil, "The configured Chrome instance is unavailable"
      end
      if options.privateInventoryError then
        return nil, options.privateInventoryError
      end
      local result = {}
      for _, window in ipairs(currentChromeWindows()) do
        local browserWindowId = browserWindowIdentityFor(window)
        if browserWindowId then
          result[window:id()] = browserWindowId
        end
      end
      return result, issueAuthority()
    end,
    matchCreated = function(
      pid,
      browserWindowId,
      extensionId,
      creationToken,
      timeoutSeconds
    )
      fullCorrelationCount = fullCorrelationCount + 1
      if createdMatchLastFinishedAt then
        createdMatchesSpaced = createdMatchesSpaced and clock - createdMatchLastFinishedAt >= 0.199
      end
      createdMatchCallCount = createdMatchCallCount + 1
      local requestedDelay = options.createdMatchDelaySeconds or 0
      if requestedDelay > 0 then
        clock = clock + math.min(requestedDelay, timeoutSeconds or 5, 5)
        createdMatchMaximumElapsed = math.max(
          createdMatchMaximumElapsed,
          clock - (createdMatchStartedAt or clock)
        )
      end
      createdMatchLastFinishedAt = clock
      if pid ~= 43250
        or browserWindowId ~= createdBrowserWindowId
        or extensionId ~= string.rep("a", 32)
        or creationToken ~= createdPlacementToken
      then
        return nil, "The created Chrome window identity changed"
      end
      if options.createdWindowNeverMatches
        or not chromeIsRunning
        or not createdChromeWindow
        or not createdWindowPublished
      then
        return nil, "The created window token is not yet available"
      end
      local documentUrl = createdAxRoot:attributeValue("AXDocument")
      local expectedOrigin = "chrome-extension://" .. extensionId .. "/index.html?"
      if type(documentUrl) ~= "string"
        or not documentUrl:find(expectedOrigin, 1, true)
        or not documentUrl:find("tabOutPlacement=" .. creationToken, 1, true)
      then
        return nil, "The created window token is not yet available"
      end
      return createdChromeWindow:id(), issueAuthority()
    end,
    navigate = function(
      pid,
      windowId,
      browserWindowId,
      authorityToken,
      operation,
      destinationUrl,
      expectedUrl
    )
      isolatedPrivateOperationAttempted = isolatedPrivateOperationAttempted
        or pid == 54321
        or windowId == isolatedChromeWindow:id()
      local targetWindow = createdChromeWindow or targetChromeWindow
      if pid ~= 43250
        or type(authorityToken) ~= "string"
        or not targetWindow
        or windowId ~= targetWindow:id()
        or browserWindowId ~= browserWindowIdentityFor(targetWindow)
        or focusedWindow ~= targetWindow
        or frontmostApplication ~= chromeApplication
      then
        return nil, "The exact Chrome window identity changed"
      end

      navigationAfterPrivateFocus = privateFocusCount > 0
      if operation == "open-tab" then
        if destinationUrl:find("focusFilter=1", 1, true) then
          openedFilter = true
        elseif destinationUrl == "chrome://newtab/" then
          openedNewPage = true
        else
          return nil, "The requested Chrome destination is invalid"
        end
        return true
      end

      if operation ~= "replace-active-tab" or targetWindow ~= createdChromeWindow then
        return nil, "The requested Chrome operation is invalid"
      end
      createdBrowserIdentityCheckedBeforeFinalization = true
      createdBootstrapTokenCheckedBeforeFinalization = type(expectedUrl) == "string"
      createdTokenObservedBeforeFinalization = createdAxDocumentReadCount > 0
      if options.createdFinalizationBrowserIdentityMismatch then
        return nil, "The exact Chrome window identity changed"
      end
      if options.createdFinalizationTabChanged then
        createdDocumentUrl = "https://example.test/changed"
      end
      if expectedUrl ~= createdDocumentUrl then
        return nil, "The created new-page bootstrap changed"
      end
      if options.createdFinalizationActiveTabSwitchRace then
        createdTabCount = 2
        return nil, "The created bootstrap tab changed"
      end
      createdBootstrapReplaced = true
      createdNewPageFinalizedAfterPrivateFocus = privateFocusCount > 0
      createdNewPageNavigationPending = true
      openedNewPage = true
      if (options.createdNewPageNavigationDelayReads or 0) == 0 then
        finishCreatedNewPageNavigation()
      end
      return true
    end,
    release = function()
      return true
    end,
    validate = function(pid, windowId, browserWindowId, authorityToken, timeoutSeconds)
      destinationIdentityRevalidationReadCount = destinationIdentityRevalidationReadCount + 1
      local delay = options.destinationIdentityRevalidationDelaySeconds or 0
      clock = clock + math.min(delay, timeoutSeconds or delay)
      local targetWindow = createdChromeWindow or targetChromeWindow
      if destinationIdentityRevalidationReadCount
        <= (options.destinationIdentityMismatchReads or 0)
      then
        return nil, "The exact Chrome window identity changed"
      end
      if pid ~= 43250
        or type(authorityToken) ~= "string"
        or not targetWindow
        or windowId ~= targetWindow:id()
        or browserWindowId ~= browserWindowIdentityFor(targetWindow)
        or focusedWindow ~= targetWindow
        or frontmostApplication ~= chromeApplication
      then
        return nil, "The exact Chrome window identity changed"
      end
      return true
    end,
  }
  local nativeBridge = {
    isReady = function()
      return options.nativeBridgeStarts ~= false
    end,
    listProfileWindows = function(_, _, callback)
      profileInventoryRequestCount = profileInventoryRequestCount + 1
      if options.nativeBridgeStarts == false then
        return false, "native bridge unavailable"
      end
      if options.profileWindowInventoryVersionMismatch then
        callback(nil, "The native bridge protocol version does not match")
        return true
      end
      if options.profileWindowInventoryUnavailable then
        callback(nil, "profile-window inventory unavailable")
        return true
      end
      if not chromeIsRunning then
        callback(nil, "The native bridge is not connected")
        return true
      end

      local windowIds = {}
      if targetHasChromeWindow and targetProfileDirectory == "Profile 3" then
        table.insert(windowIds, targetBrowserWindowId)
      end
      if otherHasChromeWindow and chromeIsRunning then
        table.insert(windowIds, otherBrowserWindowId)
      end
      callback({
        browserProcessId = options.nativeBridgeBrowserProcessId or 43250,
        windowIds = windowIds,
      })
      return true
    end,
    createWindow = function(_, createOptions, callback)
      if options.nativeBridgeStarts == false then
        return false, "native bridge unavailable"
      end

      if options.duplicateProfileExtensionDuringCreation then
        options.duplicateProfileExtension = true
      end
      nativeBridgeRequest = createOptions
      createdMatchStartedAt = clock
      if createOptions.operation == "filter" then
        openedFilter = true
      else
        openedNewPage = true
      end
      createdWindowSpaceId = targetActiveSpace
      createdChromeWindow = newChromeWindow(
        404,
        targetScreen,
        false,
        options.createdWindowStartsMinimized == true
      )
      createdWindowPublished = not options.deferCreatedWindowPublication
        and not options.createdWindowNeverPublishedToAccessibility
      if options.emitUnrelatedCreatedWindowAfterBridge
        or options.emitMatchingNativeOnlyWindowAfterBridge
        or options.emitBoundsOnlyNativeWindowAfterBridge
      then
        unrelatedNewChromeWindow = newChromeWindow(405, targetScreen, false, false)
      end
      if options.hideChromeAfterCreatedWindow then
        chromeApplicationHidden = true
      end
      if options.changeTargetSpaceAfterCreatedWindow then
        targetActiveSpace = 12
      end
      if options.quitChromeAfterCreatedWindow then
        chromeIsRunning = false
      end
      function createdChromeWindow:close()
        local closingWindow = self
        if focusedWindow == closingWindow and targetHasChromeWindow then
          frontmostApplication = chromeApplication
          targetChromeWindow:focus()
        elseif focusedWindow == closingWindow and otherHasChromeWindow then
          frontmostApplication = chromeApplication
          otherChromeWindow:focus()
        end
        createdChromeWindow = nil
        createdWindowPublished = false
        createdWindowClosed = true
        if windowDestroyedCallback and not options.suppressWindowDestroyedCallback then
          windowDestroyedCallback(closingWindow)
        end
        return true
      end
      if not options.deferCreatedWindowPublication and windowCreatedCallback then
        windowCreatedCallback(createdChromeWindow)
      end
      callback(true, nil, {
        browserProcessId = options.returnWrongCreatedBrowserProcessId and 54321 or 43250,
        browserWindowId = options.returnWrongCreatedBrowserWindowId and 9999
          or createdBrowserWindowId,
        creationToken = createdPlacementToken,
      })
      if options.emitBaselineWindowAfterBridge and windowCreatedCallback then
        windowCreatedCallback(inactiveSpaceChromeWindow)
      end
      if unrelatedNewChromeWindow and windowCreatedCallback then
        windowCreatedCallback(unrelatedNewChromeWindow)
      end
      if options.deferCreatedWindowPublication
        and not options.createdWindowNeverPublishedToAccessibility
      then
        createdWindowPublished = true
        if windowCreatedCallback then
          windowCreatedCallback(createdChromeWindow)
        end
      end
      return true
    end,
    status = function()
      return {
        connected = nativeBridgeRequest ~= nil and options.nativeBridgeStarts ~= false,
        hostInstalled = options.nativeBridgeStarts ~= false,
        version = 6,
      }
    end,
  }

  tabOut:start({
    chromeProfileDirectory = "Profile 3",
    nativeBridge = nativeBridge,
    privateFocus = privateFocus,
    shortcuts = {
      filter = { key = "k", modifiers = { "cmd", "shift" } },
      newPage = { key = "space", modifiers = { "cmd", "shift" } },
    },
  })

  runPendingTimers()
  if options.sourceWindowIsIsolatedChrome then
    focusedWindow = isolatedChromeWindow
    frontmostApplication = isolatedChromeApplication
  else
    focusedWindow = options.sourceWindowOnRemote and remoteTopWindow or originalWindow
    frontmostApplication = remoteTopApplication
  end
  otherChromeReceivedFocus = false
  otherChromeRaised = false

  if kind == "filter" then
    tabOut.openFilter()
  else
    tabOut.openNewPage()
  end

  runPendingTimers()

  if options.closeCreatedWindowAfterShortcut and createdChromeWindow then
    local closeGesture = options.closeCreatedWindowAfterShortcut == true
        and "mouse"
      or options.closeCreatedWindowAfterShortcut
    local closeFrame = closeButton:attributeValue("AXFrame")
    local event = {
      getFlags = function()
        if closeGesture == "windowShortcut" then
          return { cmd = true, shift = true }
        elseif closeGesture == "tabShortcut" then
          return { cmd = true }
        end
        return {}
      end,
      getKeyCode = function()
        return closeGesture == "mouse" and -1 or 13
      end,
      getType = function()
        return closeGesture == "mouse" and "leftMouseDown" or "keyDown"
      end,
      location = function()
        return {
          x = closeFrame.x + closeFrame.w / 2,
          y = closeFrame.y + closeFrame.h / 2,
        }
      end,
    }
    readingCloseGesture = true
    local closeStartedAt = clock
    closeGestureConsumed = closeGestureCallback and closeGestureCallback(event) == true or false
    closeGestureElapsed = clock - closeStartedAt
    readingCloseGesture = false
    if closeGesture == "mouse" and closeGestureConsumed then
      closeMouseUpConsumed = closeGestureCallback({
        getType = function()
          return "leftMouseUp"
        end,
      }) == true
    end
    if not closeGestureConsumed and createdChromeWindow then
      if closeGesture == "tabShortcut" and createdTabCount >= 2 then
        createdWindowNativeTabCloseAllowed = true
      else
        createdChromeWindow:close()
      end
    end
    runPendingTimers()
  end

  local diagnostics = tabOut.status()

  return {
    addressBarFocused = addressBarFocused,
    addressBarInputEmpty = addressBarInputEmpty,
    closeGestureConsumed = closeGestureConsumed,
    closeScanWithinDeadline = closeGestureElapsed <= 0.051,
    closeTabReads = closeTabReads,
    recoveryAppReads = recoveryAppReads,
    closeMouseUpConsumed = closeMouseUpConsumed,
    createdWindow = createdChromeWindow ~= nil,
    createdBootstrapReplaced = createdBootstrapReplaced,
    createdBootstrapTokenCheckedBeforeFinalization = createdBootstrapTokenCheckedBeforeFinalization,
    createdBrowserIdentityCheckedBeforeFinalization = createdBrowserIdentityCheckedBeforeFinalization,
    createdNewPageFinalizedAfterPrivateFocus = createdNewPageFinalizedAfterPrivateFocus,
    createdTokenObservedBeforeFinalization = createdTokenObservedBeforeFinalization,
    createdWindowClosed = createdWindowClosed,
    createdWindowMoved = createdWindowMoved,
    createdWindowNativeTabCloseAllowed = createdWindowNativeTabCloseAllowed,
    completionWithinDestinationDeadline = clock <= 6.2,
    completionWithinCreatedDeadline = createdMatchMaximumElapsed <= 12.2,
    createdMatchCallCount = createdMatchCallCount,
    createdMatchesSpaced = createdMatchesSpaced,
    createExpectedBrowserProcessId = nativeBridgeRequest
      and nativeBridgeRequest.expectedBrowserProcessId
      or nil,
    destinationFocusAttemptCount = destinationFocusAttemptCount,
    destinationIdentityRevalidationReadCount = destinationIdentityRevalidationReadCount,
    extensionFocusRequested = extensionFocusRequested,
    chromeLaunched = chromeLaunchCount > 0,
    chromeLaunchUsedConfiguredProfile = chromeLaunchArguments
      and chromeLaunchArguments[1] == "-n"
      and chromeLaunchArguments[2] == "-g"
      and chromeLaunchArguments[3] == "-b"
      and chromeLaunchArguments[4] == "com.google.Chrome"
      and chromeLaunchArguments[5] == "--args"
      and type(chromeLaunchArguments[6]) == "string"
      and chromeLaunchArguments[6]:find("^%-%-user%-data%-dir=") ~= nil
      and chromeLaunchArguments[7] == "--profile-directory=Profile 3"
      and chromeLaunchArguments[8] == "--no-startup-window",
    failed = failureAlert ~= nil,
    failureLog = failureLog,
    filterInputFocused = filterInputFocused,
    fullCorrelationCount = fullCorrelationCount,
    isolatedPrivateOperationAttempted = isolatedPrivateOperationAttempted,
    isolatedWindowMutated = isolatedWindowMutated,
    bridgeUsed = nativeBridgeRequest ~= nil,
    browserInventoryReadCount = browserInventoryReadCount,
    nativeBridgeInstalled = diagnostics.nativeBridgeInstalled,
    nativeBridgeReady = diagnostics.nativeBridgeReady,
    navigationAfterPrivateFocus = navigationAfterPrivateFocus,
    nonBootstrapTabOverwritten = nonBootstrapTabOverwritten,
    openedFilter = openedFilter,
    openedNewPage = openedNewPage,
    otherChromeReceivedFocus = otherChromeReceivedFocus,
    otherChromeRaised = otherChromeRaised,
    remoteDestinationFocusCount = remoteDestinationFocusCount,
    remoteTopFocused = focusedWindow == remoteTopWindow,
    originalWindowFocused = focusedWindow == originalWindow,
    privateFocusUsed = privateFocusCount > 0,
    privateFocusAttemptCount = privateFocusAttemptCount,
    profileInventoryRequestCount = profileInventoryRequestCount,
    unrelatedPrivateFocusAttempted = unrelatedPrivateFocusAttempted,
    missingOnScreenMetadataAllowed = missingOnScreenMetadataAllowed,
    spaceSwitchCount = spaceSwitchCount,
    shieldUsed = shieldUsed,
    shieldFrameHeight = shieldFrame and shieldFrame.h or nil,
    shieldFrameLeft = shieldFrame and shieldFrame.x or nil,
    shieldFrameTop = shieldFrame and shieldFrame.y or nil,
    shieldFrameWidth = shieldFrame and shieldFrame.w or nil,
    shieldSnapshotHeight = shieldSnapshotRect and shieldSnapshotRect.h or nil,
    shieldSnapshotLeft = shieldSnapshotRect and shieldSnapshotRect.x or nil,
    shieldSnapshotTop = shieldSnapshotRect and shieldSnapshotRect.y or nil,
    shieldSnapshotWidth = shieldSnapshotRect and shieldSnapshotRect.w or nil,
    shieldVisibleAtPrivateFocus = shieldVisibleAtPrivateFocus,
    targetFocused = focusedWindow == (createdChromeWindow or targetChromeWindow),
    targetAppActive = frontmostApplication == chromeApplication,
    targetBoundsLeft = nativeBridgeRequest and nativeBridgeRequest.targetBounds.left or nil,
  }
end

return { runShortcut = runShortcut }
