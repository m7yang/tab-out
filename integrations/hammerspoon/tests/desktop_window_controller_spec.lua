local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local function assertArray(actual, expected, message)
  assertEqual(#actual, #expected, message .. " length")
  for index, value in ipairs(expected) do
    assertEqual(actual[index], value, message .. " item " .. index)
  end
end

local source = debug.getinfo(1, "S").source
local directory = source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
local controllerChunk, loadError = loadfile(
  directory .. "/../TabOut.spoon/desktop_window_controller.lua"
)
assert(controllerChunk, loadError)
local DesktopWindowController = controllerChunk()

local CONFIGURED_PROCESS_ID = 43250
local chromeApplication = {
  bundleID = function() return "com.google.Chrome" end,
  isHidden = function() return false end,
  pid = function() return CONFIGURED_PROCESS_ID end,
}
local isolatedChromeApplication = {
  bundleID = function() return "com.google.Chrome" end,
  isHidden = function() return false end,
  pid = function() return 54321 end,
}
local screen = {
  getUUID = function() return "display-alpha" end,
}

local function window(nativeId, owner)
  owner = owner or chromeApplication
  return {
    application = function() return owner end,
    id = function() return nativeId end,
    isMinimized = function() return false end,
    isStandard = function() return true end,
    screen = function() return screen end,
  }
end

local destinationWindow = window(501)
local sourceWindow = window(502)
local isolatedWindow = window(503, isolatedChromeApplication)
local orderedWindows = { isolatedWindow, sourceWindow, destinationWindow }
local spacesByWindowId = {
  [501] = { 91 },
  [502] = { 91 },
  [503] = { 91 },
}
local writes = {}
local socketCallback
local fakeSocket = {
  connect = function(self, path, callback)
    assertEqual(path, "/tmp/tab-out-controller-test.sock", "controller socket path")
    callback()
    return true
  end,
  connected = function() return true end,
  disconnect = function() end,
  read = function() return true end,
  write = function(self, payload)
    table.insert(writes, hs.json.decode(payload))
  end,
}
local fakeHs = {
  application = {
    applicationForPID = function(pid)
      if pid ~= CONFIGURED_PROCESS_ID then return nil end
      return { allWindows = function() return { destinationWindow, sourceWindow } end }
    end,
  },
  json = hs.json,
  socket = {
    new = function(callback)
      socketCallback = callback
      return fakeSocket
    end,
  },
  spaces = {
    activeSpaceOnScreen = function() return 91 end,
    spaceType = function(spaceId)
      return spaceId == 91 and "user" or "fullscreen"
    end,
    windowSpaces = function(candidate)
      return spacesByWindowId[candidate:id()]
    end,
  },
  timer = {
    secondsSinceEpoch = function() return 1800000000 end,
  },
  window = {
    orderedWindows = function() error("must not enumerate every application") end,
    _orderedwinids = function()
      local ids = {}
      for _, candidate in ipairs(orderedWindows) do
        table.insert(ids, candidate:id())
      end
      return ids
    end,
  },
}
local catalogCandidates
local catalogProcessId
local catalog = {
  browserWindowIdsFor = function(_, processId, candidates)
    catalogProcessId = processId
    catalogCandidates = candidates
    return {
      [501] = 101,
      [502] = 102,
    }
  end,
}
local timers = {}
local profileTransferDraining = false
local controller = DesktopWindowController.new({
  beginProfileTransferDrain = function()
    if profileTransferDraining then
      return false
    end
    profileTransferDraining = true
    return true
  end,
  cancelProfileTransferDrain = function()
    profileTransferDraining = false
  end,
  catalog = catalog,
  chromeBundleId = "com.google.Chrome",
  chromeWindows = function()
    return { isolatedWindow, destinationWindow }
  end,
  hs = fakeHs,
  later = function(delay, callback)
    local timer = { callback = callback, delay = delay, stopped = false }
    table.insert(timers, timer)
    return timer
  end,
  socketPath = "/tmp/tab-out-controller-test.sock",
  stopTimer = function(timer)
    timer.stopped = true
  end,
})

controller:start()
assertEqual(writes[1].type, "controller-register", "controller registers")
assertEqual(writes[1].version, 7, "controller protocol version")
assertArray(
  writes[1].capabilities,
  { "merge-desktop", "profile-transfer-drain" },
  "controller capabilities"
)

socketCallback(hs.json.encode({
  version = 7,
  type = "response",
  requestId = writes[1].requestId,
  status = "accepted",
  capabilities = { "merge-desktop" },
}) .. "\n")
assertEqual(controller:status().connected, true, "controller accepts registration")

socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-alpha",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
}) .. "\n")
local selection = writes[2]
assertEqual(selection.status, "accepted", "desktop selection is accepted")
assertArray(selection.windowIds, { 102, 101 }, "desktop windows use native front-to-back order")
assertArray(
  { catalogCandidates[1]:id(), catalogCandidates[2]:id() },
  { 501, 502 },
  "catalog includes a Chrome window missed by the watcher"
)
assertEqual(#catalogCandidates, 2, "isolated same-bundle windows never reach the catalog")
assertEqual(catalogProcessId, CONFIGURED_PROCESS_ID, "catalog receives process authority")
local encodedSelection = hs.json.encode(selection)
assert(not encodedSelection:find("url", 1, true), "controller response must not contain URLs")
assert(not encodedSelection:find("title", 1, true), "controller response must not contain titles")

socketCallback(hs.json.encode({
  version = 7,
  type = "revalidate-desktop-windows",
  requestId = "revalidate-alpha",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
  selectionToken = "selection-alpha",
}) .. "\n")
assertEqual(writes[3].status, "accepted", "unchanged desktop selection revalidates")
assertArray(writes[3].windowIds, { 102, 101 }, "revalidated window order")

socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-beta",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
}) .. "\n")
orderedWindows = { destinationWindow, sourceWindow }
socketCallback(hs.json.encode({
  version = 7,
  type = "revalidate-desktop-windows",
  requestId = "revalidate-beta",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
  selectionToken = "selection-beta",
}) .. "\n")
assertEqual(writes[5].status, "rejected", "changed native order is rejected")
assert(
  writes[5].reason:find("topology changed", 1, true),
  "changed native order should identify the topology failure"
)

orderedWindows = { destinationWindow }
socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-gamma",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
}) .. "\n")
assertEqual(writes[6].status, "accepted", "off-screen source windows are excluded")
assertArray(writes[6].windowIds, { 101 }, "only on-screen profile windows are selected")

socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-private-field",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
  title = "Example private field",
}) .. "\n")
assertEqual(writes[7].status, "rejected", "private request fields are rejected")
assert(
  writes[7].reason:find("unsupported fields", 1, true),
  "private request fields should identify the protocol failure"
)
assert(
  not hs.json.encode(writes[7]):find("Example private field", 1, true),
  "private request fields must not be echoed"
)

local oversizedWindowIds = {}
for index = 1, 513 do
  table.insert(oversizedWindowIds, index)
end
socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-oversized",
  expiresAtMs = 1800000005000,
  browserProcessId = CONFIGURED_PROCESS_ID,
  destinationWindowId = 101,
  profileWindowIds = oversizedWindowIds,
}) .. "\n")
assertEqual(writes[8].status, "rejected", "oversized profile inventories are rejected")
assert(
  writes[8].reason:find("inventory is invalid", 1, true),
  "oversized profile inventories should identify the inventory failure"
)

socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-missing-process",
  expiresAtMs = 1800000005000,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
}) .. "\n")
assertEqual(writes[9].status, "rejected", "missing process authority is rejected")

socketCallback(hs.json.encode({
  version = 7,
  type = "resolve-desktop-windows",
  requestId = "selection-isolated-process",
  expiresAtMs = 1800000005000,
  browserProcessId = 54321,
  destinationWindowId = 101,
  profileWindowIds = { 101, 102 },
}) .. "\n")
assertEqual(writes[10].status, "rejected", "a different same-bundle process cannot be selected")

socketCallback(hs.json.encode({
  version = 7,
  type = "profile-transfer-prepare",
  requestId = "profile-transfer-alpha",
}) .. "\n")
assertEqual(writes[11].status, "accepted", "idle profile transfer begins draining")
assertEqual(writes[11].type, "profile-transfer-response", "profile transfer uses a distinct response type")
assertEqual(profileTransferDraining, true, "profile transfer gates new shortcut work")

socketCallback(hs.json.encode({
  version = 7,
  type = "profile-transfer-prepare",
  requestId = "profile-transfer-beta",
}) .. "\n")
assertEqual(writes[12].status, "rejected", "a second profile transfer is busy")
assertEqual(writes[12].type, "profile-transfer-response", "busy transfer stays out of control replies")

socketCallback(hs.json.encode({
  version = 7,
  type = "profile-transfer-cancel",
  requestId = "profile-transfer-alpha",
}) .. "\n")
assertEqual(writes[13].status, "accepted", "profile transfer cancellation is acknowledged")
assertEqual(writes[13].type, "profile-transfer-response", "transfer cancellation stays distinct")
assertEqual(profileTransferDraining, false, "profile transfer cancellation releases shortcut work")

controller:stop()
assertEqual(controller:status().connected, false, "controller stop disconnects")
assertEqual(timers[1].stopped, true, "controller stop clears its monitor")

local capabilityCallbacks = {}
local capabilitySockets = {}
local capabilityTimers = {}
local capabilityWrites = {}
local capabilityHs = {}
for key, value in pairs(fakeHs) do
  capabilityHs[key] = value
end
capabilityHs.socket = {
  new = function(callback)
    local socketIndex = #capabilitySockets + 1
    local candidate = {
      disconnected = false,
      connect = function(self, path, connectCallback)
        assertEqual(path, "/tmp/tab-out-controller-test.sock", "capability socket path")
        connectCallback()
        return true
      end,
      connected = function(self) return not self.disconnected end,
      disconnect = function(self) self.disconnected = true end,
      read = function() return true end,
      write = function(self, payload)
        table.insert(capabilityWrites, hs.json.decode(payload))
      end,
    }
    capabilityCallbacks[socketIndex] = callback
    capabilitySockets[socketIndex] = candidate
    return candidate
  end,
}
local capabilityController = DesktopWindowController.new({
  beginProfileTransferDrain = function() return true end,
  cancelProfileTransferDrain = function() end,
  catalog = catalog,
  chromeBundleId = "com.google.Chrome",
  chromeWindows = function()
    return { isolatedWindow, destinationWindow, sourceWindow }
  end,
  hs = capabilityHs,
  later = function(delay, callback)
    local timer = { callback = callback, delay = delay, stopped = false }
    table.insert(capabilityTimers, timer)
    return timer
  end,
  socketPath = "/tmp/tab-out-controller-test.sock",
  stopTimer = function(timer)
    timer.stopped = true
  end,
})

capabilityController:start()
capabilityCallbacks[1](hs.json.encode({
  version = 7,
  type = "response",
  requestId = capabilityWrites[1].requestId,
  status = "accepted",
  capabilities = {},
}) .. "\n")
assertEqual(
  capabilityController:status().connected,
  false,
  "registration without merge capability is rejected"
)
assertEqual(capabilityTimers[2].delay, 0.25, "capability rejection schedules fast reconnect")

capabilityTimers[2].callback()
assertEqual(#capabilitySockets, 2, "capability rejection reconnects")
capabilityCallbacks[1]("")
assertEqual(
  capabilitySockets[2].disconnected,
  false,
  "a stale socket callback cannot disconnect the replacement socket"
)
capabilityCallbacks[2](hs.json.encode({
  version = 7,
  type = "response",
  requestId = capabilityWrites[2].requestId,
  status = "accepted",
  capabilities = { "merge-desktop" },
}) .. "\n")
assertEqual(capabilityController:status().connected, true, "replacement socket can register")
capabilityController:stop()

return "desktop window controller regression: ok"
