local function assertEqual(actual, expected, message)
  if actual ~= expected then
    error(string.format("%s (expected %s, got %s)", message, tostring(expected), tostring(actual)), 2)
  end
end

local source = debug.getinfo(1, "S").source
local directory = source:sub(1, 1) == "@" and source:sub(2):match("^(.*)/[^/]+$") or "."
local chromeCatalogChunk, chromeCatalogLoadError = loadfile(
  directory .. "/../TabOut.spoon/chrome_catalog.lua"
)
assert(chromeCatalogChunk, chromeCatalogLoadError)
local ChromeCatalog = chromeCatalogChunk()

local catalogOptions = {
  chromeBundleId = "com.google.Chrome",
  chromeUserDataDirectory = "/tmp/chrome-catalog-test",
  configuredProfileDirectory = "Profile 3",
  hs = {},
  privateChrome = {
    configuredProcess = function() return 43250 end,
    inventory = function() return {}, "authority" end,
    matchCreated = function() return nil end,
    release = function() return true end,
  },
}
assertEqual(type(ChromeCatalog.new(catalogOptions)), "table", "catalog accepts a fake hs adapter")

local platformOnlyAccepted, platformOnlyError = pcall(ChromeCatalog.new, {
  chromeBundleId = "com.google.Chrome",
  chromeUserDataDirectory = "/tmp/chrome-catalog-test",
  configuredProfileDirectory = "Profile 3",
  platform = {},
  privateChrome = {
    configuredProcess = function() return 43250 end,
    inventory = function() return {}, "authority" end,
    matchCreated = function() return nil end,
    release = function() return true end,
  },
})
assertEqual(platformOnlyAccepted, false, "catalog rejects the removed platform injection seam")
assert(
  tostring(platformOnlyError):find("hs is required", 1, true),
  "catalog should require the hs adapter"
)

local fakeRuntimeChunk, loadError = loadfile(directory .. "/support/fake_hammerspoon.lua")
assert(fakeRuntimeChunk, loadError)
local runShortcut = fakeRuntimeChunk().runShortcut

local scenarios = {
  {
    "reuse target profile for filter", "filter", nil,
    { createdWindow = false, extensionFocusRequested = false, failed = false,
      filterInputFocused = true, navigationAfterPrivateFocus = true, openedFilter = true,
      fullCorrelationCount = 1,
      missingOnScreenMetadataAllowed = false, otherChromeRaised = false,
      privateFocusUsed = true, targetAppActive = true, targetFocused = true },
  },
  {
    "retry a transient configured destination focus refusal", "filter",
    { destinationFocusRejectedAttempts = 1 },
    { destinationFocusAttemptCount = 2, failed = false, filterInputFocused = true,
      openedFilter = true, privateFocusUsed = true, targetFocused = true },
  },
  {
    "wait through transient post-navigation identity mismatch", "filter",
    { destinationIdentityMismatchReads = 1 },
    { destinationIdentityRevalidationReadCount = 2, failed = false,
      filterInputFocused = true, openedFilter = true, privateFocusUsed = true,
      targetFocused = true },
  },
  {
    "safe-abort a persistent post-navigation identity mismatch", "filter",
    { destinationIdentityMismatchReads = 999 },
    { destinationFocusAttemptCount = 0, failed = true,
      filterInputFocused = false, openedFilter = true, privateFocusUsed = true,
      targetFocused = true },
  },
  {
    "reuse target profile for new page", "newPage", nil,
    { addressBarFocused = true, createdWindow = false, extensionFocusRequested = false,
      failed = false, missingOnScreenMetadataAllowed = false,
      navigationAfterPrivateFocus = true, openedNewPage = true,
      otherChromeRaised = false, privateFocusUsed = true, targetFocused = true },
  },
  {
    "route filter away from a same-bundle isolated Chrome process", "filter",
    { isolatedChromeWindow = true, sourceWindowIsIsolatedChrome = true },
    { createdWindow = false, failed = false, filterInputFocused = true,
      isolatedPrivateOperationAttempted = false, isolatedWindowMutated = false,
      openedFilter = true, privateFocusUsed = true, targetAppActive = true,
      targetFocused = true },
  },
  {
    "route new page away from a same-bundle isolated Chrome process", "newPage",
    { isolatedChromeWindow = true, sourceWindowIsIsolatedChrome = true },
    { addressBarFocused = true, createdWindow = false, failed = false,
      isolatedPrivateOperationAttempted = false, isolatedWindowMutated = false,
      openedNewPage = true, privateFocusUsed = true, targetAppActive = true,
      targetFocused = true },
  },
  {
    "retry one stale configured-instance authority before mutation", "filter",
    { firstProfileInventoryProcessUnavailable = true },
    { createdWindow = false, failed = false, filterInputFocused = true,
      openedFilter = true, privateFocusAttemptCount = 1,
      profileInventoryRequestCount = 2, targetFocused = true },
  },
  {
    "retry stale exact-window authority rejected before private mutation", "filter",
    { firstPrivateFocusAuthorityChangedBeforeMutation = true },
    { failed = false, filterInputFocused = true, openedFilter = true,
      privateFocusAttemptCount = 2, profileInventoryRequestCount = 2,
      targetFocused = true },
  },
  {
    "do not retry a generic configured-process inventory failure", "filter",
    { privateInventoryError = "Hammerspoon does not have Automation permission" },
    { browserInventoryReadCount = 1, failed = true, privateFocusAttemptCount = 0,
      profileInventoryRequestCount = 1 },
  },
  {
    "reject a native host from another Chrome user-data process", "filter",
    { isolatedChromeWindow = true, nativeBridgeBrowserProcessId = 54321,
      sourceWindowIsIsolatedChrome = true },
    { failed = true, isolatedPrivateOperationAttempted = false,
      profileInventoryRequestCount = 2, privateFocusAttemptCount = 0 },
  },
  {
    "keep the paired profile when Tab Out loads in another profile", "filter",
    { duplicateProfileExtension = true },
    { createdWindow = false, failed = false, filterInputFocused = true,
      openedFilter = true, privateFocusAttemptCount = 1,
      profileInventoryRequestCount = 1, targetFocused = true },
  },
  {
    "bound destination identity retries by wall-clock time", "filter",
    { destinationIdentityMismatchReads = 999,
      destinationIdentityRevalidationDelaySeconds = 2 },
    { completionWithinDestinationDeadline = true, failed = true,
      filterInputFocused = false, openedFilter = true },
  },
  {
    "reject successful destination validation at its deadline", "filter",
    { destinationIdentityMismatchReads = 2,
      destinationIdentityRevalidationDelaySeconds = 2 },
    { failed = true, filterInputFocused = false, openedFilter = true },
  },
  {
    "reject successful new-page validation at its deadline", "newPage",
    { destinationIdentityMismatchReads = 2,
      destinationIdentityRevalidationDelaySeconds = 2 },
    { failed = true, addressBarFocused = false, openedNewPage = true },
  },
  {
    "bound destination Accessibility traversal by the shared deadline", "filter",
    { destinationAccessibilityReadDelaySeconds = 2 },
    { completionWithinDestinationDeadline = true, failed = true,
      filterInputFocused = false, openedFilter = true },
  },
  {
    "create filter window on empty target", "filter", { targetHasChromeWindow = false },
    { bridgeUsed = true, createdWindow = true, createdWindowMoved = false,
      createExpectedBrowserProcessId = 43250,
      extensionFocusRequested = false, failed = false, filterInputFocused = true,
      nativeBridgeReady = true, openedFilter = true, otherChromeReceivedFocus = false,
      otherChromeRaised = false, privateFocusUsed = true, shieldUsed = true,
      shieldVisibleAtPrivateFocus = true, targetBoundsLeft = 1440, targetFocused = true },
  },
  {
    "finish filter creation when another profile loads Tab Out", "filter",
    { duplicateProfileExtensionDuringCreation = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true,
      privateFocusUsed = true },
  },
  {
    "finish new-page creation when another profile loads Tab Out", "newPage",
    { duplicateProfileExtensionDuringCreation = true, targetHasChromeWindow = false },
    { addressBarFocused = true, createdBootstrapReplaced = true,
      createdWindow = true, failed = false, privateFocusUsed = true },
  },
  {
    "give creation matching a quiet interval after an unavailable token", "filter",
    { targetHasChromeWindow = false, createdWindowAxDocumentUnavailableReads = 3,
      createdMatchDelaySeconds = 0.067 },
    { createdMatchesSpaced = true, failed = false, filterInputFocused = true },
  },
  {
    "shield only the usable target frame during creation", "filter",
    { targetHasChromeWindow = false },
    { createdWindow = true, failed = false, shieldFrameHeight = 870,
      shieldFrameLeft = 1440, shieldFrameTop = 30, shieldFrameWidth = 1380,
      shieldSnapshotHeight = 870, shieldSnapshotLeft = 0,
      shieldSnapshotTop = 30, shieldSnapshotWidth = 1380 },
  },
  {
    "activate offscreen bridge-created filter window on empty target", "filter",
    { createdWindowOmitsOnScreenMetadata = true, targetHasChromeWindow = false },
    { bridgeUsed = true, createdWindow = true, failed = false, filterInputFocused = true,
      missingOnScreenMetadataAllowed = true, openedFilter = true,
      otherChromeReceivedFocus = false, otherChromeRaised = false,
      shieldVisibleAtPrivateFocus = true, targetFocused = true },
  },
  {
    "activate offscreen bridge-created new-page window on empty target", "newPage",
    { createdWindowOmitsOnScreenMetadata = true, targetHasChromeWindow = false },
    { addressBarFocused = true, bridgeUsed = true, createdWindow = true, failed = false,
      missingOnScreenMetadataAllowed = true, openedNewPage = true, targetFocused = true },
  },
  {
    "wait for bridge-created new-page token to reach AX", "newPage",
    { createdWindowAxDocumentUnavailableReads = 1, targetHasChromeWindow = false },
    { addressBarFocused = true, createdWindow = true, failed = false,
      privateFocusUsed = true, targetFocused = true },
  },
  {
    "safe-abort when bridge-created token never reaches AX", "newPage",
    { createdWindowAxDocumentUnavailable = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = true, privateFocusAttemptCount = 0,
      privateFocusUsed = false, targetFocused = false },
  },
  {
    "bound created-window correlation by one wall-clock deadline", "filter",
    { createdMatchDelaySeconds = 5, createdWindowNeverMatches = true,
      targetHasChromeWindow = false },
    { completionWithinCreatedDeadline = true, createdMatchCallCount = 3,
      failed = true, privateFocusAttemptCount = 0 },
  },
  {
    "wait through cross-snapshot race for exact created token", "filter",
    { createdAxClearsFocusFilter = true, deferCreatedWindowPublication = true,
      emitBoundsOnlyNativeWindowAfterBridge = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true,
      privateFocusAttemptCount = 1, privateFocusUsed = true,
      targetFocused = true, unrelatedPrivateFocusAttempted = false },
  },
  {
    "skip created-window correlation until a native candidate appears", "filter",
    { createdWindowNeverPublishedToAccessibility = true, targetHasChromeWindow = false },
    { createdMatchCallCount = 0, createdWindow = true, failed = true, privateFocusUsed = false },
  },
  {
    "safe-abort sole bounds-only native window while created token stays AX-pending", "filter",
    { createdWindowNeverPublishedToAccessibility = true,
      emitBoundsOnlyNativeWindowAfterBridge = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = true, privateFocusAttemptCount = 0,
      privateFocusUsed = false, targetFocused = false,
      unrelatedPrivateFocusAttempted = false },
  },
  {
    "ignore unrelated new Chrome window while matching bridge identity", "filter",
    { deferCreatedWindowPublication = true, emitUnrelatedCreatedWindowAfterBridge = true,
      targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true,
      privateFocusUsed = true, targetFocused = true },
  },
  {
    "ignore baseline Chrome event while matching bridge identity", "newPage",
    { deferCreatedWindowPublication = true, emitBaselineWindowAfterBridge = true,
      targetHasChromeWindow = false, targetHasInactiveSpaceChromeWindow = true },
    { addressBarFocused = true, createdWindow = true, failed = false,
      privateFocusUsed = true, targetFocused = true },
  },
  {
    "safe-abort when bridge-created browser identity is unknown", "filter",
    { returnWrongCreatedBrowserWindowId = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = true, privateFocusUsed = false, targetFocused = false },
  },
  {
    "leave a created window untouched when process authority changes", "filter",
    { returnWrongCreatedBrowserProcessId = true, targetHasChromeWindow = false },
    { createdWindow = true, createdWindowClosed = false, failed = true,
      privateFocusUsed = false, targetFocused = false },
  },
  {
    "ignore duplicate-looking native metadata outside the exact created identity", "filter",
    { emitMatchingNativeOnlyWindowAfterBridge = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, privateFocusUsed = true, targetFocused = true },
  },
  {
    "safe-abort bridge-created window after Chrome hides", "filter",
    { hideChromeAfterCreatedWindow = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = true, privateFocusUsed = false, targetFocused = false },
  },
  {
    "safe-abort without inventory when Chrome quits during correlation", "filter",
    { quitChromeAfterCreatedWindow = true, targetHasChromeWindow = false },
    { browserInventoryReadCount = 1, createdWindow = true, failed = true,
      privateFocusUsed = false, targetFocused = false },
  },
  {
    "safe-abort bridge-created window after target Space changes", "newPage",
    { changeTargetSpaceAfterCreatedWindow = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = true, privateFocusUsed = false, targetFocused = false },
  },
  {
    "safe-abort minimized bridge-created window", "filter",
    { createdWindowStartsMinimized = true, targetHasChromeWindow = false },
    { createdWindow = true, failed = true, privateFocusUsed = false, targetFocused = false },
  },
  {
    "safe-abort bridge-created window reported offscreen", "filter",
    { createdWindowReportsOffscreen = true, targetHasChromeWindow = false },
    { createdWindow = false, createdWindowClosed = true, failed = true,
      missingOnScreenMetadataAllowed = true, privateFocusUsed = true, targetFocused = false },
  },
  {
    "create new-page window on empty target", "newPage", { targetHasChromeWindow = false },
    { addressBarFocused = true, addressBarInputEmpty = true,
      bridgeUsed = true, createdBootstrapReplaced = true, createdWindow = true,
      createdBrowserIdentityCheckedBeforeFinalization = true,
      createdBootstrapTokenCheckedBeforeFinalization = true,
      createdWindowMoved = false, extensionFocusRequested = false, failed = false,
      createdNewPageFinalizedAfterPrivateFocus = true,
      createdTokenObservedBeforeFinalization = true,
      openedNewPage = true, otherChromeReceivedFocus = false, otherChromeRaised = false,
      privateFocusUsed = true, shieldUsed = true, shieldVisibleAtPrivateFocus = true,
      targetBoundsLeft = 1440, targetFocused = true },
  },
  {
    "create filter window when every display is Chrome-empty", "filter",
    { otherHasChromeWindow = false, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true, openedFilter = true },
  },
  {
    "wait for created new-page navigation before focusing the empty address bar", "newPage",
    { createdNewPageNavigationDelayReads = 2, targetHasChromeWindow = false },
    { addressBarFocused = true, addressBarInputEmpty = true,
      createdBootstrapReplaced = true, failed = false,
      privateFocusUsed = true, targetFocused = true },
  },
  {
    "safe-abort created new-page finalization after browser focus changes", "newPage",
    { createdFinalizationBrowserIdentityMismatch = true, targetHasChromeWindow = false },
    { addressBarFocused = false, createdBootstrapReplaced = false,
      createdBrowserIdentityCheckedBeforeFinalization = true,
      createdWindow = false, createdWindowClosed = true, failed = true,
      failureLog = "The Tab Out new page could not be prepared: The exact Chrome window identity changed",
      privateFocusUsed = true },
  },
  {
    "safe-abort created new-page finalization after its bootstrap tab changes", "newPage",
    { createdFinalizationTabChanged = true, targetHasChromeWindow = false },
    { addressBarFocused = false, createdBootstrapReplaced = false,
      createdBootstrapTokenCheckedBeforeFinalization = true,
      createdWindow = true, createdWindowClosed = false, failed = true,
      nonBootstrapTabOverwritten = false, privateFocusUsed = true },
  },
  {
    "never overwrite a tab switched in during new-page finalization", "newPage",
    { createdFinalizationActiveTabSwitchRace = true, targetHasChromeWindow = false },
    { addressBarFocused = false, createdBootstrapReplaced = false,
      createdWindow = true, createdWindowClosed = false, failed = true,
      nonBootstrapTabOverwritten = false, privateFocusUsed = true },
  },
  {
    "safe-abort when focus changes during created new-page navigation", "newPage",
    { changeFocusDuringCreatedNewPageNavigation = true,
      createdNewPageNavigationDelayReads = 2, targetHasChromeWindow = false },
    { addressBarFocused = false, createdBootstrapReplaced = true,
      failed = true, originalWindowFocused = true, targetFocused = false },
  },
  {
    "create new-page window when every display is Chrome-empty", "newPage",
    { otherHasChromeWindow = false, targetHasChromeWindow = false },
    { addressBarFocused = true, createdWindow = true, failed = false, openedNewPage = true },
  },
  {
    "create filter window on one display", "filter",
    { otherHasChromeWindow = false, screenCount = 1, targetDisplayPosition = 1, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, targetBoundsLeft = 0 },
  },
  {
    "create new-page window on one display", "newPage",
    { otherHasChromeWindow = false, screenCount = 1, targetDisplayPosition = 1, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, targetBoundsLeft = 0 },
  },
  {
    "cold-launch configured Chrome beside an isolated process for new page", "newPage",
    { chromeIsRunning = false, isolatedChromeWindow = true,
      otherHasChromeWindow = false, sourceWindowIsIsolatedChrome = true,
      targetHasChromeWindow = false },
    { bridgeUsed = true, chromeLaunched = true,
      chromeLaunchUsedConfiguredProfile = true, createdWindow = true, failed = false,
      isolatedPrivateOperationAttempted = false, isolatedWindowMutated = false,
      openedNewPage = true, targetFocused = true },
  },
  {
    "cold-launch configured Chrome beside an isolated process for filter", "filter",
    { chromeIsRunning = false, isolatedChromeWindow = true,
      otherHasChromeWindow = false, sourceWindowIsIsolatedChrome = true,
      targetHasChromeWindow = false },
    { bridgeUsed = true, chromeLaunched = true,
      chromeLaunchUsedConfiguredProfile = true, createdWindow = true, failed = false,
      isolatedPrivateOperationAttempted = false, isolatedWindowMutated = false,
      openedFilter = true, targetFocused = true },
  },
  {
    "discover uncached target profile for filter", "filter", { cacheTargetProfile = false },
    { bridgeUsed = false, createdWindow = false, failed = false, filterInputFocused = true,
      openedFilter = true, otherChromeReceivedFocus = false, otherChromeRaised = false, targetFocused = true },
  },
  {
    "discover uncached target profile for new page", "newPage", { cacheTargetProfile = false },
    { bridgeUsed = false, createdWindow = false, failed = false, openedNewPage = true,
      otherChromeReceivedFocus = false, targetFocused = true },
  },
  {
    "reuse exact configured identity despite ambiguous window metadata", "filter",
    { ambiguousProfileWindowIdentity = true, cacheTargetProfile = false },
    { bridgeUsed = false, createdWindow = false, failed = false,
      openedFilter = true, targetFocused = true },
  },
  {
    "create beside another profile", "filter", { targetProfileDirectory = "Profile 8" },
    { createdWindow = true, failed = false, openedFilter = true,
      otherChromeReceivedFocus = false, targetFocused = true },
  },
  {
    "ignore Chrome on an inactive target Space", "filter",
    { targetHasChromeWindow = false, targetHasInactiveSpaceChromeWindow = true },
    { createdWindow = true, failed = false, openedFilter = true },
  },
  {
    "route to a third display", "filter",
    { screenCount = 3, targetDisplayPosition = 3, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, targetBoundsLeft = 2880 },
  },
  {
    "safe-abort without private focus", "filter", { privateFocusAvailable = false },
    { createdWindow = false, failed = true, openedFilter = false, privateFocusUsed = false },
  },
  {
    "safe-abort without native bridge", "filter",
    { nativeBridgeStarts = false, targetHasChromeWindow = false },
    { bridgeUsed = false, createdWindow = false, failed = true,
      nativeBridgeInstalled = false, nativeBridgeReady = false },
  },
  {
    "safe-abort mixed macOS integration versions", "filter",
    { profileWindowInventoryVersionMismatch = true },
    { chromeLaunched = false, createdWindow = false, failed = true,
      privateFocusUsed = false, profileInventoryRequestCount = 1 },
  },
  {
    "do not cold-launch after a connected inventory rejection", "filter",
    { profileWindowInventoryUnavailable = true },
    { chromeLaunched = false, createdWindow = false, failed = true,
      privateFocusUsed = false, profileInventoryRequestCount = 1 },
  },
  {
    "continue without transition shield", "filter",
    { screenRecordingAvailable = false, targetHasChromeWindow = false },
    { createdWindow = true, failed = false, filterInputFocused = true, shieldUsed = false },
  },
  {
    "report failed exact focus", "filter",
    { privateFocusSucceeds = false, targetHasChromeWindow = false },
    { createdWindow = false, createdWindowClosed = true, failed = true, targetFocused = false },
  },
  {
    "leave a multi-tab created window untouched during failed-route cleanup", "filter",
    { createdTabCount = 2, privateFocusSucceeds = false, targetHasChromeWindow = false },
    { createdWindow = true, createdWindowClosed = false, failed = true },
  },
  {
    "reject a destination owned by another window", "filter",
    { focusedDestinationOwnerMismatch = true, targetHasChromeWindow = false },
    { failed = false, filterInputFocused = true, remoteDestinationFocusCount = 0, targetFocused = true },
  },
  {
    "close created filter window by mouse", "filter",
    { closeCreatedWindowAfterShortcut = true, sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, closeMouseUpConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "close created new-page window", "newPage",
    { closeCreatedWindowAfterShortcut = "windowShortcut", sourceWindowOnRemote = true,
      targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "close created window's last tab", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", sourceWindowOnRemote = true,
      targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "leave a slow last-tab scan to Chrome", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", closeAccessibilityReadDelaySeconds = 0.02,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, closeScanWithinDeadline = true },
  },
  {
    "never infer one tab from an incomplete accessibility scan", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", closeAccessibilityReadFails = true,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false },
  },
  {
    "leave multi-tab close to Chrome", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", createdTabCount = 2,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, createdWindow = true, createdWindowClosed = false,
      createdWindowNativeTabCloseAllowed = true, otherChromeReceivedFocus = false },
  },
  {
    "stop scanning after the second tab", "filter",
    { closeCreatedWindowAfterShortcut = "tabShortcut", createdTabCount = 3,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, closeTabReads = 4, createdWindowNativeTabCloseAllowed = true },
  },
  {
    "do not restore through a newly appeared standard window", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "standard",
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, recoveryAppReads = 1 },
  },
  {
    "do not restore through an always-on-top standard window", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "standard",
      closeRecoveryObstructionLayer = 3, sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, recoveryAppReads = 1 },
  },
  {
    "include standard obstructions above the Dock level", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "standard",
      closeRecoveryObstructionLayer = 25, sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, recoveryAppReads = 1 },
  },
  {
    "retain an always-on-top recovery target", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", recoveryWindowLayer = 3,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, remoteTopFocused = true },
  },
  {
    "avoid the implicit unbounded application-role read", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "standard",
      closeApplicationConstructorDelaySeconds = 0.5,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, closeScanWithinDeadline = true, recoveryAppReads = 1 },
  },
  {
    "ignore a verified nonstandard obstruction on a floating layer", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "nonstandard",
      closeRecoveryObstructionLayer = 3,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, recoveryAppReads = 1 },
  },
  {
    "exclude accessory-app surfaces without Accessibility reads", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "accessory",
      closeRecoveryObstructionLayer = 25, sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, recoveryAppReads = 0 },
  },
  {
    "exclude WindowServer surfaces with no running application", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", includeSystemSurface = true,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, recoveryAppReads = 0 },
  },
  {
    "do not infer clear recovery order from an unreadable application", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "unreadable",
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, recoveryAppReads = 1 },
  },
  {
    "bound inspection of a slow potential obstruction", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "standard",
      closeAccessibilityReadDelaySeconds = 0.1,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = false, closeScanWithinDeadline = true },
  },
  {
    "skip Accessibility inspection on another display", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", closeRecoveryObstruction = "remote",
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, recoveryAppReads = 0 },
  },
  {
    "finish an intercepted close after recovery invalidates", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", invalidateCloseRecoveryAfterFocus = true,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true },
  },
  {
    "restore same-display source after close", "filter",
    { cacheTargetProfile = false, closeCreatedWindowAfterShortcut = "windowShortcut",
      targetProfileDirectory = "Profile 8" },
    { closeGestureConsumed = true, createdWindowClosed = true,
      originalWindowFocused = true, otherChromeReceivedFocus = false },
  },
  {
    "keep close recovery while hs.window lookup omits the created window", "filter",
    { closeCreatedWindowAfterShortcut = "windowShortcut", createdWindowOnInactiveSpace = true,
      sourceWindowOnRemote = true, targetHasChromeWindow = false },
    { closeGestureConsumed = true, createdWindowClosed = true,
      otherChromeReceivedFocus = false, remoteTopFocused = true },
  },
  {
    "repair an unhandled close", "filter",
    { closeCreatedWindowAfterShortcut = "unhandled", targetHasChromeWindow = false },
    { closeGestureConsumed = false, originalWindowFocused = true, otherChromeReceivedFocus = true },
  },
  {
    "repair close without destruction event", "filter",
    { closeCreatedWindowAfterShortcut = "unhandled", suppressWindowDestroyedCallback = true,
      targetHasChromeWindow = false },
    { originalWindowFocused = true, otherChromeReceivedFocus = true },
  },
  {
    "reuse Chrome in fullscreen", "filter", { targetSpaceType = "fullscreen" },
    { createdWindow = false, failed = false, openedFilter = true, spaceSwitchCount = 0 },
  },
  {
    "fall back from fullscreen for creation", "newPage",
    { otherHasChromeWindow = false, targetHasChromeWindow = false, targetSpaceType = "fullscreen" },
    { createdWindow = true, failed = false, openedNewPage = true, spaceSwitchCount = 1 },
  },
}

for _, scenario in ipairs(scenarios) do
  local name, kind, options, expected = table.unpack(scenario)
  local result = runShortcut(kind, options)
  for field, value in pairs(expected) do
    assertEqual(result[field], value, name .. ": " .. field)
  end
end

return "cross-display focus regression: ok"
