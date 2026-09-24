local M = {}

local MAXIMUM_WINDOW_IDS = 512

local function noOp() end

local function loggerOrNoOp(logger)
  return logger or {
    df = noOp,
    wf = noOp,
  }
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

local function validProcessId(value)
  return positiveInteger(value) and value > 1 and value <= 2147483647
end

local function windowId(windowOrId)
  if type(windowOrId) == "number" then
    return windowOrId
  end
  return windowOrId and windowOrId:id() or nil
end

local function creationTokenIsValid(value)
  return type(value) == "string"
    and #value > 0
    and #value <= 128
    and value:match("^[A-Za-z0-9._:%-]+$") ~= nil
end

local function profileDirectoryIsValid(value)
  return type(value) == "string"
    and #value > 0
    and value ~= "."
    and value ~= ".."
    and value:find("/", 1, true) == nil
    and value:find("\\", 1, true) == nil
    and value:find("\0", 1, true) == nil
end

local function preMutationAuthorityChange()
  return {
    authorityChanged = true,
    mutationStarted = false,
  }
end

local function tabOutExtensionId(settings)
  local matchedId
  for candidateId, extension in pairs(settings or {}) do
    local commands = type(extension) == "table" and extension.commands or nil
    if type(commands) == "table"
      and type(commands["open-filter-tab"]) == "table"
      and type(commands["open-new-tab"]) == "table"
      and type(candidateId) == "string"
      and #candidateId == 32
      and candidateId:match("^[a-p]+$")
    then
      if matchedId then
        return nil, "Multiple Tab Out extension installations were found in one Chrome profile"
      end
      matchedId = candidateId
    end
  end
  return matchedId
end

local function profileWindowSet(profileWindowIds)
  if type(profileWindowIds) ~= "table" or #profileWindowIds > MAXIMUM_WINDOW_IDS then
    return nil, "The configured-profile window inventory is invalid"
  end
  local profileWindows = {}
  for _, browserWindowId in ipairs(profileWindowIds) do
    if not positiveInteger(browserWindowId) or profileWindows[browserWindowId] then
      return nil, "The configured-profile window inventory is invalid"
    end
    profileWindows[browserWindowId] = true
  end
  return profileWindows
end

function M.new(options)
  assert(type(options) == "table", "Chrome catalog options must be a table")
  assert(type(options.chromeBundleId) == "string", "chromeBundleId is required")
  assert(type(options.chromeUserDataDirectory) == "string", "chromeUserDataDirectory is required")
  assert(type(options.configuredProfileDirectory) == "string", "configuredProfileDirectory is required")
  assert(type(options.hs) == "table", "hs is required")
  assert(type(options.privateChrome) == "table", "privateChrome is required")
  assert(
    type(options.privateChrome.configuredProcess) == "function",
    "privateChrome configured-process lookup is required"
  )
  assert(type(options.privateChrome.inventory) == "function", "privateChrome inventory is required")
  assert(type(options.privateChrome.matchCreated) == "function", "privateChrome created-window matching is required")
  assert(type(options.privateChrome.release) == "function", "privateChrome authority release is required")

  local chromeBundleId = options.chromeBundleId
  local chromeUserDataDirectory = options.chromeUserDataDirectory
  local configuredProfileDirectory = options.configuredProfileDirectory
  local hs = options.hs
  local log = loggerOrNoOp(options.log)
  local privateChrome = options.privateChrome
  local extensionId
  local profileByWindow = {}
  local settingsCache
  local catalog = {}

  local function configuredProcessWindow(window, browserProcessId)
    local id = windowId(window)
    local application = id and window:application() or nil
    return id
      and application
      and application:bundleID() == chromeBundleId
      and application:pid() == browserProcessId
  end

  local function releaseAuthority(authorityToken)
    if type(authorityToken) == "string" and authorityToken ~= "" then
      pcall(privateChrome.release, authorityToken)
    end
  end

  local function extensionSettings(profileDirectory)
    if not profileDirectoryIsValid(profileDirectory) then
      return nil, "Chrome returned an invalid profile directory"
    end
    -- Parsing Secure Preferences costs tens of milliseconds and runs on every
    -- route and created-window poll. Chrome replaces the file on each write, so
    -- an unchanged inode, size, and mtime identify an unchanged parse.
    local path = chromeUserDataDirectory .. "/" .. profileDirectory .. "/Secure Preferences"
    local stat = hs.fs.attributes(path)
    local identity = stat and string.format("%s:%s:%s", stat.ino, stat.size, stat.modification) or nil
    if identity and settingsCache and settingsCache.path == path and settingsCache.identity == identity then
      return settingsCache.settings
    end
    local preferences = hs.json.read(path)
    local settings = preferences and preferences.extensions and preferences.extensions.settings or nil
    if type(settings) ~= "table" then
      settingsCache = nil
      return nil, "Chrome's extension settings could not be read"
    end
    settingsCache = identity and { identity = identity, path = path, settings = settings } or nil
    return settings
  end

  local function validateConfiguredProfileOwner()
    local settings, settingsError = extensionSettings(configuredProfileDirectory)
    if not settings then
      return nil, settingsError
    end
    local discoveredId, discoveryError = tabOutExtensionId(settings)
    if discoveryError then
      return nil, discoveryError
    end
    if not discoveredId then
      return nil, "The Tab Out extension could not be identified"
    end
    if extensionId and discoveredId ~= extensionId then
      return nil, "The Configured Profile's Tab Out extension identity changed"
    end
    extensionId = discoveredId
    return discoveredId
  end

  local function configuredProcessId()
    local called, processIdOrError, processError = pcall(
      privateChrome.configuredProcess,
      chromeUserDataDirectory
    )
    if not called then
      return nil, tostring(processIdOrError)
    end
    if not validProcessId(processIdOrError) then
      return nil, processError or "The configured Chrome user-data process is unavailable"
    end
    return processIdOrError
  end

  local function validateConfiguredProcess(browserProcessId)
    local expectedProcessId, processError = configuredProcessId()
    if not expectedProcessId then
      return nil, processError, preMutationAuthorityChange()
    end
    if expectedProcessId ~= browserProcessId then
      return nil,
        "The native bridge belongs to a different Chrome user-data process",
        preMutationAuthorityChange()
    end
    return true
  end

  local function processInventory(browserProcessId, timeoutSeconds)
    if not validProcessId(browserProcessId) then
      return nil, "The configured Chrome process identity is invalid"
    end
    local processMatches, processError, processDetails = validateConfiguredProcess(browserProcessId)
    if not processMatches then
      return nil, processError, nil, processDetails
    end
    local expectedExtensionId, extensionError = validateConfiguredProfileOwner()
    if not expectedExtensionId then
      return nil, extensionError
    end
    local called, browserIdByNativeWindowId, authorityTokenOrError = pcall(
      privateChrome.inventory,
      browserProcessId,
      timeoutSeconds
    )
    if not called then
      return nil, tostring(browserIdByNativeWindowId)
    end
    if type(browserIdByNativeWindowId) ~= "table" then
      return nil, authorityTokenOrError
        or "The configured Chrome process inventory is unavailable"
    end
    if type(authorityTokenOrError) ~= "string" or authorityTokenOrError == "" then
      return nil, "The configured Chrome process authority is unavailable"
    end
    for nativeWindowId, browserWindowId in pairs(browserIdByNativeWindowId) do
      if not positiveInteger(nativeWindowId) or not positiveInteger(browserWindowId) then
        releaseAuthority(authorityTokenOrError)
        return nil, "The configured Chrome process returned an invalid window identity"
      end
    end
    return browserIdByNativeWindowId, nil, authorityTokenOrError
  end

  function catalog:profileFor(windowOrId)
    local id = windowId(windowOrId)
    return id and profileByWindow[id] or nil
  end

  function catalog:forget(windowOrId)
    local id = windowId(windowOrId)
    if id then
      profileByWindow[id] = nil
    end
  end

  function catalog:releaseAuthority(authorityToken)
    releaseAuthority(authorityToken)
  end

  function catalog:configuredProcessId()
    return configuredProcessId()
  end

  function catalog:extensionId()
    if extensionId then
      return extensionId
    end
    return validateConfiguredProfileOwner()
  end

  function catalog:filterFocusUrl()
    local id, extensionError = self:extensionId()
    if not id then
      return nil, extensionError
    end
    return "chrome-extension://" .. id .. "/index.html?focusFilter=1"
  end

  function catalog:createdBootstrapUrl(creationToken, focusFilter)
    if not creationTokenIsValid(creationToken) then
      return nil, "The created window token is invalid"
    end
    local id, extensionError = self:extensionId()
    if not id then
      return nil, extensionError
    end
    return "chrome-extension://"
      .. id
      .. "/index.html?"
      .. (focusFilter and "focusFilter=1&" or "")
      .. "tabOutPlacement="
      .. creationToken
  end

  function catalog:resolveProfileWindows(
    browserProcessId,
    profileWindowIds,
    candidates,
    timeoutSeconds
  )
    local profileWindows, profileError = profileWindowSet(profileWindowIds)
    if not profileWindows then
      return nil, profileError
    end
    local browserIdByNativeWindowId, inventoryError, authorityToken, inventoryDetails = processInventory(
      browserProcessId,
      timeoutSeconds
    )
    if not browserIdByNativeWindowId then
      return nil, inventoryError, nil, inventoryDetails
    end

    local resolved = {}
    for _, window in ipairs(candidates or {}) do
      local id = windowId(window)
      local browserWindowId = id and browserIdByNativeWindowId[id] or nil
      if configuredProcessWindow(window, browserProcessId)
        and profileWindows[browserWindowId]
      then
        profileByWindow[id] = configuredProfileDirectory
        table.insert(resolved, {
          authorityToken = authorityToken,
          browserWindowId = browserWindowId,
          window = window,
        })
      end
    end
    return resolved, nil, authorityToken
  end

  function catalog:browserWindowIdsFor(browserProcessId, candidates)
    local browserIdByNativeWindowId, inventoryError, authorityToken = processInventory(
      browserProcessId
    )
    if not browserIdByNativeWindowId then
      return nil, inventoryError
    end

    local result = {}
    for _, window in ipairs(candidates or {}) do
      local id = windowId(window)
      local browserWindowId = id and browserIdByNativeWindowId[id] or nil
      if configuredProcessWindow(window, browserProcessId) and browserWindowId then
        result[id] = browserWindowId
      end
    end
    releaseAuthority(authorityToken)
    return result
  end

  function catalog:matchCreatedBrowserWindow(
    browserProcessId,
    browserWindowId,
    creationToken,
    candidates,
    timeoutSeconds
  )
    if not validProcessId(browserProcessId) then
      return nil, "The configured Chrome process identity is invalid", true
    end
    if not positiveInteger(browserWindowId) then
      return nil, "The created browser window identity is invalid", true
    end
    if not creationTokenIsValid(creationToken) then
      return nil, "The created window token is invalid", true
    end
    if not finiteNumber(timeoutSeconds) or timeoutSeconds <= 0 then
      return nil, "The created-window correlation deadline expired", true
    end
    local processMatches, processError = validateConfiguredProcess(browserProcessId)
    if not processMatches then
      return nil, processError, true
    end
    local expectedExtensionId, extensionError = validateConfiguredProfileOwner()
    if not expectedExtensionId then
      return nil, extensionError, true
    end

    local called, nativeWindowId, authorityTokenOrError = pcall(
      privateChrome.matchCreated,
      browserProcessId,
      browserWindowId,
      expectedExtensionId,
      creationToken,
      timeoutSeconds
    )
    if not called then
      return nil, tostring(nativeWindowId), true
    end
    if not positiveInteger(nativeWindowId) then
      return nil, authorityTokenOrError
        or "The created window token is not yet available to macOS"
    end
    if type(authorityTokenOrError) ~= "string" or authorityTokenOrError == "" then
      return nil, "The created exact-window authority is unavailable", true
    end

    local matchedWindow
    for _, window in ipairs(candidates or {}) do
      if windowId(window) == nativeWindowId
        and configuredProcessWindow(window, browserProcessId)
      then
        if matchedWindow then
          releaseAuthority(authorityTokenOrError)
          return nil, "Multiple native Chrome windows have the created identity", true
        end
        matchedWindow = window
      end
    end
    if not matchedWindow then
      releaseAuthority(authorityTokenOrError)
      return nil, "The created native Chrome window is not yet available on the target Desktop"
    end

    profileByWindow[nativeWindowId] = configuredProfileDirectory
    log.df(
      "Correlated configured Chrome process %d browser window %d to native window %d",
      browserProcessId,
      browserWindowId,
      nativeWindowId
    )
    return matchedWindow, nil, nil, authorityTokenOrError
  end

  function catalog:status()
    local currentExtensionId = validateConfiguredProfileOwner()
    local localState = hs.json.read(chromeUserDataDirectory .. "/Local State")
    local profiles = localState and localState.profile and localState.profile.info_cache or nil
    local targetWindows = 0
    for _, profileDirectory in pairs(profileByWindow) do
      if profileDirectory == configuredProfileDirectory then
        targetWindows = targetWindows + 1
      end
    end
    return {
      cachedOtherProfileWindows = 0,
      cachedTargetProfileWindows = targetWindows,
      extensionReady = currentExtensionId ~= nil,
      profileMetadataReady = extensionSettings(configuredProfileDirectory) ~= nil
        and type(profiles) == "table",
    }
  end

  return catalog
end

return M
