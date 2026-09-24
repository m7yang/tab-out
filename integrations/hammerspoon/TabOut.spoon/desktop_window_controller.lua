local M = {}

local CONTROL_VERSION = 7
local MAXIMUM_PROCESS_ID = 2147483647
local MERGE_DESKTOP_CAPABILITY = "merge-desktop"
local PROFILE_TRANSFER_DRAIN_CAPABILITY = "profile-transfer-drain"
local MAXIMUM_WINDOW_IDS = 512
local RECONNECT_DELAYS_SECONDS = { 0.25, 1, 5, 30 }
local SELECTION_LIFETIME_MS = 10 * 60 * 1000

local function noOp() end

local function loggerOrNoOp(logger)
  return logger or {
    df = noOp,
    ef = noOp,
    i = noOp,
    w = noOp,
    wf = noOp,
  }
end

local function trim(value)
  if type(value) ~= "string" then
    return ""
  end
  return value:match("^%s*(.-)%s*$")
end

local function finiteNumber(value)
  return type(value) == "number"
    and value == value
    and value ~= math.huge
    and value ~= -math.huge
end

local function positiveInteger(value)
  return finiteNumber(value) and value > 0 and value % 1 == 0
end

local function validRequestId(value)
  return type(value) == "string"
    and #value > 0
    and #value <= 128
    and value:match("^[A-Za-z0-9._:%-]+$") ~= nil
end

local function sameArray(left, right)
  if #left ~= #right then
    return false
  end
  for index, value in ipairs(left) do
    if right[index] ~= value then
      return false
    end
  end
  return true
end

local function containsValue(values, expected)
  if type(values) ~= "table" then
    return false
  end
  for _, value in ipairs(values) do
    if value == expected then
      return true
    end
  end
  return false
end

local function hasOnlyKeys(value, allowedKeys)
  for key in pairs(value or {}) do
    if not allowedKeys[key] then
      return false
    end
  end
  return true
end

function M.new(options)
  assert(type(options) == "table", "desktop window controller options are required")
  assert(type(options.catalog) == "table", "desktop window controller catalog is required")
  assert(
    type(options.beginProfileTransferDrain) == "function",
    "desktop window controller transfer-drain start is required"
  )
  assert(
    type(options.cancelProfileTransferDrain) == "function",
    "desktop window controller transfer-drain cancellation is required"
  )
  assert(type(options.chromeBundleId) == "string", "desktop window controller Chrome bundle ID is required")
  assert(type(options.chromeWindows) == "function", "desktop window controller window source is required")
  assert(type(options.hs) == "table", "desktop window controller Hammerspoon API is required")
  assert(type(options.later) == "function", "desktop window controller timer factory is required")
  assert(type(options.socketPath) == "string", "desktop window controller socket path is required")
  assert(type(options.stopTimer) == "function", "desktop window controller timer cleanup is required")

  local catalog = options.catalog
  local beginProfileTransferDrain = options.beginProfileTransferDrain
  local cancelProfileTransferDrain = options.cancelProfileTransferDrain
  local chromeBundleId = options.chromeBundleId
  local chromeWindows = options.chromeWindows
  local hs = options.hs
  local later = options.later
  local log = loggerOrNoOp(options.log)
  local socketPath = options.socketPath
  local stopTimer = options.stopTimer
  local connected = false
  local connecting = false
  local controller = {}
  local monitorTimer
  local nextRegistrationId = 0
  local reconnectAttempt = 1
  local reconnectTimer
  local registrationRequestId
  local selections = {}
  local socket
  local started = false

  local function nowMs()
    return math.floor(hs.timer.secondsSinceEpoch() * 1000)
  end

  local function response(requestId, status, reason, fields)
    local value = {
      version = CONTROL_VERSION,
      type = "response",
      requestId = requestId,
      status = status,
    }
    if reason and reason ~= "" then
      value.reason = reason
    end
    for key, field in pairs(fields or {}) do
      value[key] = field
    end
    return value
  end

  local function profileTransferResponse(requestId, status, reason)
    local value = response(requestId, status, reason)
    value.type = "profile-transfer-response"
    return value
  end

  local function screenUuid(screen)
    return screen and screen:getUUID() or nil
  end

  local function isChromeWindow(window, browserProcessId)
    if not window or not window:id() or not window:isStandard() or window:isMinimized() then
      return false
    end
    local application = window:application()
    return application
      and application:bundleID() == chromeBundleId
      and application:pid() == browserProcessId
      and not application:isHidden()
  end

  local function profileWindowSet(profileWindowIds)
    if type(profileWindowIds) ~= "table" or #profileWindowIds > MAXIMUM_WINDOW_IDS then
      return nil, "The configured-profile window inventory is invalid"
    end
    local profileWindows = {}
    for _, windowId in ipairs(profileWindowIds) do
      if not positiveInteger(windowId) or profileWindows[windowId] then
        return nil, "The configured-profile window inventory is invalid"
      end
      profileWindows[windowId] = true
    end
    return profileWindows
  end

  local function resolveDesktopWindows(
    browserProcessId,
    destinationWindowId,
    profileWindowIds
  )
    if not positiveInteger(browserProcessId) or browserProcessId > MAXIMUM_PROCESS_ID then
      return nil, "The configured Chrome instance identity is invalid"
    end
    if not positiveInteger(destinationWindowId) then
      return nil, "The destination browser window is invalid"
    end
    local profileWindows, profileError = profileWindowSet(profileWindowIds)
    if not profileWindows then
      return nil, profileError
    end
    if not profileWindows[destinationWindowId] then
      return nil, "The destination is not owned by the configured Chrome profile"
    end

    local tracked = {}
    local trackedById = {}
    for _, window in ipairs(chromeWindows() or {}) do
      local id = window and window:id() or nil
      if isChromeWindow(window, browserProcessId) and id and not trackedById[id] then
        trackedById[id] = window
        table.insert(tracked, window)
      end
    end
    -- Refresh only the authorized process so windows missed by the watcher still
    -- participate. WindowServer supplies order without querying unrelated apps.
    local application = hs.application.applicationForPID(browserProcessId)
    if not application or type(hs.window._orderedwinids) ~= "function" then
      return nil, "The configured Chrome window order is unavailable"
    end
    for _, window in ipairs(application:allWindows() or {}) do
      local id = window and window:id() or nil
      if isChromeWindow(window, browserProcessId) and id and not trackedById[id] then
        trackedById[id] = window
        table.insert(tracked, window)
      end
    end
    local orderedTracked = {}
    local orderedTrackedIds = {}
    for _, id in ipairs(hs.window._orderedwinids()) do
      if trackedById[id] and not orderedTrackedIds[id] then
        orderedTrackedIds[id] = true
        table.insert(orderedTracked, trackedById[id])
      end
    end
    if #orderedTracked == 0 then
      return nil, "No visible standard Chrome windows are available"
    end

    local browserIdByNativeId, mappingError = catalog:browserWindowIdsFor(
      browserProcessId,
      tracked
    )
    if not browserIdByNativeId then
      return nil, mappingError
    end

    local destinationWindow
    for nativeId, browserWindowId in pairs(browserIdByNativeId) do
      if browserWindowId == destinationWindowId then
        if destinationWindow then
          return nil, "The destination browser window maps to multiple native windows"
        end
        destinationWindow = trackedById[nativeId]
      end
    end
    if not destinationWindow then
      return nil, "The destination browser window could not be mapped to macOS"
    end

    local destinationScreen = destinationWindow:screen()
    local destinationScreenUuid = screenUuid(destinationScreen)
    local destinationSpaces = hs.spaces.windowSpaces(destinationWindow)
    if not destinationScreenUuid
      or type(destinationSpaces) ~= "table"
      or #destinationSpaces ~= 1
    then
      return nil, "The destination must belong to exactly one macOS Desktop"
    end
    local destinationSpaceId = destinationSpaces[1]
    if hs.spaces.spaceType(destinationSpaceId) ~= "user" then
      return nil, "The destination is not on a regular macOS Desktop"
    end
    if hs.spaces.activeSpaceOnScreen(destinationScreen) ~= destinationSpaceId then
      return nil, "The destination Desktop is no longer active on its display"
    end

    local orderedWindowIds = {}
    local orderedWindowIdSet = {}
    for _, window in ipairs(orderedTracked) do
      if isChromeWindow(window, browserProcessId)
        and screenUuid(window:screen()) == destinationScreenUuid
      then
        local spaces = hs.spaces.windowSpaces(window)
        if type(spaces) == "table"
          and #spaces == 1
          and spaces[1] == destinationSpaceId
        then
          local browserWindowId = browserIdByNativeId[window:id()]
          if not browserWindowId then
            return nil, "A Chrome window on the destination Desktop could not be mapped safely"
          end
          if profileWindows[browserWindowId] then
            if orderedWindowIdSet[browserWindowId] then
              return nil, "Chrome returned an ambiguous native window order"
            end
            orderedWindowIdSet[browserWindowId] = true
            table.insert(orderedWindowIds, browserWindowId)
          end
        end
      end
    end

    if not containsValue(orderedWindowIds, destinationWindowId) then
      return nil, "The destination browser window is not visible on its Desktop"
    end
    return {
      browserProcessId = browserProcessId,
      destinationWindowId = destinationWindowId,
      screenUuid = destinationScreenUuid,
      spaceId = destinationSpaceId,
      windowIds = orderedWindowIds,
    }
  end

  local function pruneSelections(atMs)
    for token, selection in pairs(selections) do
      if atMs - selection.createdAtMs > SELECTION_LIFETIME_MS then
        selections[token] = nil
      end
    end
  end

  local function validateRequest(message)
    if type(message) ~= "table"
      or message.version ~= CONTROL_VERSION
      or not validRequestId(message.requestId)
      or not finiteNumber(message.expiresAtMs)
      or message.expiresAtMs < nowMs()
    then
      return nil, "The native control request is invalid"
    end
    if message.type ~= "resolve-desktop-windows"
      and message.type ~= "revalidate-desktop-windows"
    then
      return nil, "The native control request type is unsupported"
    end
    local allowedKeys = {
      version = true,
      type = true,
      requestId = true,
      expiresAtMs = true,
      browserProcessId = true,
      destinationWindowId = true,
      profileWindowIds = true,
    }
    if message.type == "revalidate-desktop-windows" then
      allowedKeys.selectionToken = true
    end
    if not hasOnlyKeys(message, allowedKeys) then
      return nil, "The native control request contains unsupported fields"
    end
    if message.type == "revalidate-desktop-windows"
      and not validRequestId(message.selectionToken)
    then
      return nil, "The native control selection token is invalid"
    end
    return message
  end

  local function handleRequest(message)
    if type(message) == "table"
      and (message.type == "profile-transfer-prepare" or message.type == "profile-transfer-cancel")
    then
      local requestId = validRequestId(message.requestId) and message.requestId or "invalid"
      if message.version ~= CONTROL_VERSION
        or requestId == "invalid"
        or not hasOnlyKeys(message, {
          version = true,
          type = true,
          requestId = true,
        })
      then
        return profileTransferResponse(
          requestId,
          "rejected",
          "The profile-transfer drain request is invalid"
        )
      end
      if message.type == "profile-transfer-cancel" then
        cancelProfileTransferDrain()
        return profileTransferResponse(requestId, "accepted")
      end
      if not beginProfileTransferDrain() then
        return profileTransferResponse(
          requestId,
          "rejected",
          "A Tab Out macOS action is already in progress"
        )
      end
      return profileTransferResponse(requestId, "accepted")
    end

    local request, requestError = validateRequest(message)
    local requestId = type(message) == "table" and message.requestId or "invalid"
    if not request then
      return response(validRequestId(requestId) and requestId or "invalid", "rejected", requestError)
    end

    local atMs = nowMs()
    pruneSelections(atMs)
    local selection, selectionError = resolveDesktopWindows(
      request.browserProcessId,
      request.destinationWindowId,
      request.profileWindowIds
    )
    if not selection then
      return response(request.requestId, "rejected", selectionError)
    end

    if request.type == "resolve-desktop-windows" then
      selections[request.requestId] = {
        browserProcessId = selection.browserProcessId,
        createdAtMs = atMs,
        destinationWindowId = selection.destinationWindowId,
        screenUuid = selection.screenUuid,
        spaceId = selection.spaceId,
        windowIds = selection.windowIds,
      }
      return response(request.requestId, "accepted", nil, {
        windowIds = selection.windowIds,
      })
    end

    local previous = selections[request.selectionToken]
    selections[request.selectionToken] = nil
    if not previous then
      return response(request.requestId, "rejected", "The desktop selection expired or was replaced")
    end
    if previous.browserProcessId ~= selection.browserProcessId
      or previous.destinationWindowId ~= selection.destinationWindowId
      or previous.screenUuid ~= selection.screenUuid
      or previous.spaceId ~= selection.spaceId
      or not sameArray(previous.windowIds, selection.windowIds)
    then
      return response(request.requestId, "rejected", "The desktop window topology changed")
    end
    return response(request.requestId, "accepted", nil, {
      windowIds = selection.windowIds,
    })
  end

  local function encode(value)
    local ok, encoded = pcall(hs.json.encode, value)
    if not ok or type(encoded) ~= "string" then
      return nil, tostring(encoded)
    end
    return encoded
  end

  local scheduleReconnect
  local connect

  local function clearSocket()
    cancelProfileTransferDrain()
    connected = false
    connecting = false
    registrationRequestId = nil
    local current = socket
    socket = nil
    if current then
      pcall(current.disconnect, current)
    end
  end

  local function send(value)
    if not socket or not socket:connected() then
      return false
    end
    local encoded, encodeError = encode(value)
    if not encoded then
      log.ef("Could not encode native controller message: %s", encodeError)
      return false
    end
    local ok = pcall(socket.write, socket, encoded .. "\n")
    return ok
  end

  local function readNext()
    if not socket or not socket:connected() then
      clearSocket()
      scheduleReconnect()
      return
    end
    local ok, result = pcall(socket.read, socket, "\n")
    if not ok or not result then
      clearSocket()
      scheduleReconnect()
    end
  end

  local function onSocketData(data)
    if type(data) ~= "string" or trim(data) == "" then
      clearSocket()
      scheduleReconnect()
      return
    end
    local decoded, message = pcall(hs.json.decode, trim(data))
    if not decoded or type(message) ~= "table" then
      log.w("The native controller received invalid JSON")
      clearSocket()
      scheduleReconnect()
      return
    end

    if registrationRequestId then
      local validRegistrationResponse = message.version == CONTROL_VERSION
        and message.type == "response"
        and message.requestId == registrationRequestId
        and hasOnlyKeys(message, {
          version = true,
          type = true,
          requestId = true,
          status = true,
          reason = true,
          capabilities = true,
        })
      if not validRegistrationResponse
        or message.status ~= "accepted"
        or message.reason ~= nil
        or not containsValue(message.capabilities, MERGE_DESKTOP_CAPABILITY)
      then
        log.wf("The native controller registration was rejected: %s", message.reason or "unknown error")
        clearSocket()
        scheduleReconnect()
        return
      end
      registrationRequestId = nil
      connected = true
      reconnectAttempt = 1
      log.i("Tab Out desktop-window controller is connected")
      readNext()
      return
    end

    local reply = handleRequest(message)
    if not send(reply) then
      clearSocket()
      scheduleReconnect()
      return
    end
    readNext()
  end

  scheduleReconnect = function()
    if not started or reconnectTimer then
      return
    end
    local delayIndex = math.min(reconnectAttempt, #RECONNECT_DELAYS_SECONDS)
    local delay = RECONNECT_DELAYS_SECONDS[delayIndex] or RECONNECT_DELAYS_SECONDS[#RECONNECT_DELAYS_SECONDS]
    reconnectAttempt = reconnectAttempt + 1
    reconnectTimer = later(delay, function()
      reconnectTimer = nil
      connect()
    end, false)
  end

  connect = function()
    if not started or connected or connecting or socket then
      return
    end
    connecting = true
    local candidate
    candidate = hs.socket.new(function(data)
      if socket ~= candidate then
        return
      end
      onSocketData(data)
    end)
    if not candidate then
      connecting = false
      scheduleReconnect()
      return
    end
    socket = candidate
    local ok, result = pcall(candidate.connect, candidate, socketPath, function()
      if socket ~= candidate then
        return
      end
      connecting = false
      nextRegistrationId = nextRegistrationId + 1
      registrationRequestId = string.format("controller-%d-%d", nowMs(), nextRegistrationId)
      if not send({
        version = CONTROL_VERSION,
        type = "controller-register",
        requestId = registrationRequestId,
        expiresAtMs = nowMs() + 5000,
        capabilities = {
          MERGE_DESKTOP_CAPABILITY,
          PROFILE_TRANSFER_DRAIN_CAPABILITY,
        },
      }) then
        clearSocket()
        scheduleReconnect()
        return
      end
      readNext()
    end)
    if not ok or not result then
      clearSocket()
      scheduleReconnect()
    end
  end

  local function scheduleMonitor()
    if not started or monitorTimer then
      return
    end
    monitorTimer = later(5, function()
      monitorTimer = nil
      if socket and not socket:connected() then
        clearSocket()
      end
      if not socket then
        connect()
      end
      scheduleMonitor()
    end, false)
  end

  function controller:start()
    if started then
      return self
    end
    started = true
    connect()
    scheduleMonitor()
    return self
  end

  function controller:stop()
    started = false
    if reconnectTimer then
      stopTimer(reconnectTimer)
      reconnectTimer = nil
    end
    if monitorTimer then
      stopTimer(monitorTimer)
      monitorTimer = nil
    end
    clearSocket()
    selections = {}
    return self
  end

  function controller:status()
    return {
      capabilities = {
        MERGE_DESKTOP_CAPABILITY,
        PROFILE_TRANSFER_DRAIN_CAPABILITY,
      },
      connected = connected,
      connecting = connecting,
      socketPath = socketPath,
      version = CONTROL_VERSION,
    }
  end

  return controller
end

return M
