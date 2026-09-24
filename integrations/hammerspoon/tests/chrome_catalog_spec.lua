local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local source = debug.getinfo(1, "S").source
local directory = source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
local catalogChunk, loadError = loadfile(directory .. "/../TabOut.spoon/chrome_catalog.lua")
assert(catalogChunk, loadError)
local ChromeCatalog = catalogChunk()

local CONFIGURED_PROCESS_ID = 43250
local ISOLATED_PROCESS_ID = 54321
local EXTENSION_ID = string.rep("a", 32)
local inventory = {
  [201] = 101,
  [202] = 102,
}
local createdNativeWindowId = 204
local configuredProcessId = CONFIGURED_PROCESS_ID
local duplicateProfileInstall = false
local localStateAvailable = true
local inventoryFailure
local matchCreatedTimeout
local matchCreatedError
local authoritySerial = 0
local securePreferencesReads = 0
local securePreferencesRevision = 1

local function issueAuthority()
  authoritySerial = authoritySerial + 1
  return "authority-" .. authoritySerial
end

local function application(processId)
  return {
    bundleID = function() return "com.google.Chrome" end,
    pid = function() return processId end,
  }
end

local function nativeWindow(id, processId)
  local owner = application(processId)
  return {
    application = function() return owner end,
    id = function() return id end,
  }
end

local privateChrome = {
  configuredProcess = function(userDataDirectory)
    assertEqual(
      userDataDirectory,
      "/tmp/tab-out-chrome-catalog-test",
      "configured process lookup uses the selected Chrome data directory"
    )
    return configuredProcessId
  end,
  inventory = function(processId)
    assertEqual(processId, CONFIGURED_PROCESS_ID, "inventory uses configured process authority")
    if inventoryFailure then
      return nil, inventoryFailure
    end
    return inventory, issueAuthority()
  end,
  matchCreated = function(
    processId,
    browserWindowId,
    extensionId,
    creationToken,
    timeoutSeconds
  )
    assertEqual(processId, CONFIGURED_PROCESS_ID, "created match uses configured process authority")
    assertEqual(browserWindowId, 104, "created match uses bridge browser identity")
    assertEqual(extensionId, EXTENSION_ID, "created match uses configured extension identity")
    assertEqual(creationToken, "hs-100-1", "created match uses the bridge token")
    matchCreatedTimeout = timeoutSeconds
    if not createdNativeWindowId then
      return nil, matchCreatedError
    end
    return createdNativeWindowId, issueAuthority()
  end,
  release = function() return true end,
}

local fakeHs = {
  fs = {
    attributes = function()
      return { ino = securePreferencesRevision, modification = 1800000000, size = 100 }
    end,
  },
  json = {
    read = function(path)
      if path:match("/Local State$") then
        if not localStateAvailable then
          return nil
        end
        return {
          profile = {
            info_cache = {
              ["Profile 1"] = { name = "Configured" },
              ["Profile 8"] = { name = "Alternate" },
            },
          },
        }
      end
      local isConfiguredProfile = path:find(
        "/Profile 1/Secure Preferences",
        1,
        true
      ) ~= nil
      local isAlternateProfile = path:find(
        "/Profile 8/Secure Preferences",
        1,
        true
      ) ~= nil
      assert(isConfiguredProfile or isAlternateProfile, "catalog reads a known profile")
      securePreferencesReads = securePreferencesReads + 1
      return {
        extensions = {
          settings = (isConfiguredProfile or duplicateProfileInstall) and {
            [EXTENSION_ID] = {
              commands = {
                ["open-filter-tab"] = {},
                ["open-new-tab"] = {},
              },
            },
          } or {},
        },
      }
    end,
  },
}

local catalog = ChromeCatalog.new({
  chromeBundleId = "com.google.Chrome",
  chromeUserDataDirectory = "/tmp/tab-out-chrome-catalog-test",
  configuredProfileDirectory = "Profile 1",
  hs = fakeHs,
  privateChrome = privateChrome,
})

local configuredFront = nativeWindow(201, CONFIGURED_PROCESS_ID)
local configuredBack = nativeWindow(202, CONFIGURED_PROCESS_ID)
local isolatedSameBundle = nativeWindow(301, ISOLATED_PROCESS_ID)

local resolved, resolveError = catalog:resolveProfileWindows(
  CONFIGURED_PROCESS_ID,
  { 101 },
  { isolatedSameBundle, configuredBack, configuredFront }
)
assert(resolved, resolveError)
assertEqual(#resolved, 1, "only configured-profile windows in the authorized process resolve")
assertEqual(resolved[1].window, configuredFront, "the configured window resolves")
assertEqual(resolved[1].browserWindowId, 101, "the configured browser identity resolves")
assertEqual(catalog:profileFor(201), "Profile 1", "resolved profile identity is cached")
assertEqual(catalog:profileFor(301), nil, "isolated Chrome is never learned as configured")

localStateAvailable = false
local missingMetadataStatus = catalog:status()
assertEqual(
  missingMetadataStatus.profileMetadataReady,
  false,
  "readiness requires the current Local State profile inventory"
)
assertEqual(
  missingMetadataStatus.extensionReady,
  true,
  "the configured profile's extension identity remains independently verifiable"
)
localStateAvailable = true
local restoredMetadataStatus = catalog:status()
assertEqual(restoredMetadataStatus.profileMetadataReady, true, "restored profile metadata becomes ready")
assertEqual(restoredMetadataStatus.extensionReady, true, "restored configured-profile metadata becomes ready")

inventory[301] = 103
local mapped, mappingError = catalog:browserWindowIdsFor(
  CONFIGURED_PROCESS_ID,
  { isolatedSameBundle, configuredFront, configuredBack }
)
assert(mapped, mappingError)
assertEqual(mapped[201], 101, "configured native identity maps")
assertEqual(mapped[202], 102, "second configured native identity maps")
assertEqual(mapped[301], nil, "same-bundle isolated process is excluded even from a bad inventory")
inventory[301] = nil

local createdWindow = nativeWindow(204, CONFIGURED_PROCESS_ID)
local matched, matchError, terminal = catalog:matchCreatedBrowserWindow(
  CONFIGURED_PROCESS_ID,
  104,
  "hs-100-1",
  { isolatedSameBundle, createdWindow },
  1.25
)
assert(matched, matchError)
assertEqual(matched, createdWindow, "created token resolves only the authorized native window")
assertEqual(terminal, nil, "successful created matching is not terminal")
assertEqual(matchCreatedTimeout, 1.25, "created matching forwards the route's remaining time")

createdNativeWindowId = nil
matchCreatedError = "The created window token is not yet available"
local pending, pendingError, pendingTerminal = catalog:matchCreatedBrowserWindow(
  CONFIGURED_PROCESS_ID,
  104,
  "hs-100-1",
  { createdWindow },
  0.75
)
assertEqual(pending, nil, "pending created identity remains unavailable")
assertEqual(pendingError, matchCreatedError, "pending created identity preserves a generic error")
assertEqual(pendingTerminal, nil, "pending created identity remains retryable")

configuredProcessId = ISOLATED_PROCESS_ID
local wrongProcessWindows, wrongProcessError, _, wrongProcessDetails = catalog:resolveProfileWindows(
  CONFIGURED_PROCESS_ID,
  { 101 },
  { configuredFront }
)
assertEqual(wrongProcessWindows, nil, "another user-data process cannot supply profile windows")
assert(
  wrongProcessError:find("different Chrome user%-data process") ~= nil,
  "wrong native host ownership is identified"
)
assertEqual(wrongProcessDetails.authorityChanged, true, "process mismatch is classified explicitly")
assertEqual(wrongProcessDetails.mutationStarted, false, "process mismatch remains pre-mutation")
configuredProcessId = CONFIGURED_PROCESS_ID

inventoryFailure = "Hammerspoon does not have Automation permission"
local failedInventory, failedInventoryError, _, failedInventoryDetails = catalog:resolveProfileWindows(
  CONFIGURED_PROCESS_ID,
  { 101 },
  { configuredFront }
)
assertEqual(failedInventory, nil, "generic process inventory failure is rejected")
assertEqual(failedInventoryError, inventoryFailure, "generic process inventory error is preserved")
assertEqual(failedInventoryDetails, nil, "generic process inventory failure is not retryable")
inventoryFailure = nil

duplicateProfileInstall = true
createdNativeWindowId = 204
local duplicateCreatedWindow, duplicateCreationError, duplicateCreationTerminal = catalog:matchCreatedBrowserWindow(
  CONFIGURED_PROCESS_ID,
  104,
  "hs-100-1",
  { createdWindow },
  0.75
)
assertEqual(duplicateCreatedWindow, createdWindow, "the paired profile keeps created-window ownership")
assertEqual(duplicateCreationError, nil, "another loaded profile does not invalidate paired ownership")
assertEqual(duplicateCreationTerminal, nil, "paired created-window ownership remains usable")
assertEqual(
  catalog:status().extensionReady,
  true,
  "readiness keeps the paired profile ready when another profile loads the extension"
)
local duplicateWindows, duplicateError = catalog:resolveProfileWindows(
  CONFIGURED_PROCESS_ID,
  { 101 },
  { configuredFront }
)
assert(duplicateWindows, duplicateError)
assertEqual(#duplicateWindows, 1, "the paired profile inventory remains authoritative")
assertEqual(duplicateWindows[1].window, configuredFront, "the paired window still resolves")
duplicateProfileInstall = false
assertEqual(catalog:status().extensionReady, true, "readiness stays available with one loaded profile")

local readsBeforeRepeat = securePreferencesReads
catalog:resolveProfileWindows(CONFIGURED_PROCESS_ID, { 101 }, { configuredFront })
catalog:resolveProfileWindows(CONFIGURED_PROCESS_ID, { 101 }, { configuredFront })
assertEqual(
  securePreferencesReads,
  readsBeforeRepeat,
  "an unchanged Secure Preferences file is not parsed again"
)
securePreferencesRevision = securePreferencesRevision + 1
catalog:resolveProfileWindows(CONFIGURED_PROCESS_ID, { 101 }, { configuredFront })
assertEqual(
  securePreferencesReads,
  readsBeforeRepeat + 1,
  "a replaced Secure Preferences file is parsed again"
)

inventory = { [201] = "invalid" }
local invalidMapping, invalidError = catalog:browserWindowIdsFor(
  CONFIGURED_PROCESS_ID,
  { configuredFront }
)
assertEqual(invalidMapping, nil, "invalid native inventory is rejected")
assert(invalidError:find("invalid window identity", 1, true), "invalid inventory error is concise")

local invalidProcessMapping, invalidProcessError = catalog:browserWindowIdsFor(1, {
  configuredFront,
})
assertEqual(invalidProcessMapping, nil, "invalid configured process authority is rejected")
assert(
  invalidProcessError:find("process identity is invalid", 1, true),
  "invalid process authority is identified"
)

return true
