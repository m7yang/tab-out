#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <LuaSkin/LuaSkin.h>
#import <ScriptingBridge/ScriptingBridge.h>
#import <dlfcn.h>
#import <limits.h>
#import <math.h>
#import <string.h>

static const uint32_t kCPSUserGenerated = 0x200;
static const DescType kChromeWindowClass = 'cwin';
static const DescType kChromeTabClass = 'CrTb';
static const AEKeyword kChromeIdentifierProperty = 'ID  ';
static const AEKeyword kChromeBoundsProperty = 'pbnd';
static const AEKeyword kChromeActiveTabProperty = 'acTa';
static const AEKeyword kChromeActiveTabIndexProperty = 'acTI';
static const AEKeyword kChromeUrlProperty = 'URL ';
static const NSTimeInterval kAuthorityLifetimeSeconds = 15;
static const NSUInteger kMaximumAuthorities = 32;
static const NSTimeInterval kMaximumScriptingTimeoutSeconds = 5;

enum {
  kKeyWindowEventRecordBytes = 0x100,
  kEventRecordSizeOffset = 0x04,
  kEventRecordPhaseOffset = 0x08,
  kEventRecordSentinelOffset = 0x20,
  kEventRecordSentinelBytes = 0x10,
  kEventRecordWindowMarkerOffset = 0x3a,
  kEventRecordWindowIDOffset = 0x3c,
};

static const uint8_t kEncodedEventRecordSize = 0xf8;
static const uint8_t kWindowEventMarker = 0x10;
static const uint8_t kWindowEventBeginPhase = 0x01;
static const uint8_t kWindowEventEndPhase = 0x02;

typedef AXError (*AXElementWindowIDFunction)(AXUIElementRef, CGWindowID *);
typedef int (*MainConnectionIDFunction)(void);
typedef CGError (*SetFrontProcessFunction)(ProcessSerialNumber *, uint32_t, uint32_t);
typedef CGError (*PostEventRecordFunction)(ProcessSerialNumber *, uint8_t *);

typedef struct {
  void *applicationServices;
  void *skyLight;
  AXElementWindowIDFunction getWindowID;
  SetFrontProcessFunction setFrontProcess;
  PostEventRecordFunction postEventRecord;
} PrivateFocusSymbols;

@interface TabOutScriptingDelegate : NSObject <SBApplicationDelegate>
@property(nonatomic, strong) NSError *lastError;
@end

@implementation TabOutScriptingDelegate

- (id)eventDidFail:(const AppleEvent *)event withError:(NSError *)error {
  (void)event;
  self.lastError = error;
  return nil;
}

@end

static int pushFailure(lua_State *L, NSString *message) {
  lua_pushnil(L);
  lua_pushstring(L, message.UTF8String);
  return 2;
}

static int pushMutationFailure(
  lua_State *L,
  NSString *message,
  BOOL mutationStarted,
  BOOL authorityChanged
) {
  lua_pushnil(L);
  lua_pushstring(L, message.UTF8String);
  lua_newtable(L);
  lua_pushboolean(L, mutationStarted);
  lua_setfield(L, -2, "mutationStarted");
  lua_pushboolean(L, authorityChanged);
  lua_setfield(L, -2, "authorityChanged");
  return 3;
}

static NSString *baseCapabilityError(void) {
  if (!AXIsProcessTrusted()) return @"Hammerspoon does not have Accessibility permission";
  return nil;
}

static void prepareKeyWindowEventRecord(uint8_t *eventRecord, CGWindowID windowID) {
  memset(eventRecord, 0, kKeyWindowEventRecordBytes);
  eventRecord[kEventRecordSizeOffset] = kEncodedEventRecordSize;
  eventRecord[kEventRecordWindowMarkerOffset] = kWindowEventMarker;
  memcpy(eventRecord + kEventRecordWindowIDOffset, &windowID, sizeof(windowID));
  memset(eventRecord + kEventRecordSentinelOffset, 0xff, kEventRecordSentinelBytes);
}

static void closePrivateSymbols(PrivateFocusSymbols *symbols) {
  if (symbols->skyLight) dlclose(symbols->skyLight);
  if (symbols->applicationServices) dlclose(symbols->applicationServices);
  memset(symbols, 0, sizeof(*symbols));
}

static NSString *loadPrivateSymbols(PrivateFocusSymbols *symbols) {
  memset(symbols, 0, sizeof(*symbols));
  symbols->applicationServices = dlopen(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    RTLD_NOW | RTLD_LOCAL
  );
  symbols->skyLight = dlopen(
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    RTLD_NOW | RTLD_LOCAL
  );
  symbols->getWindowID = symbols->applicationServices
    ? (AXElementWindowIDFunction)dlsym(symbols->applicationServices, "_AXUIElementGetWindow")
    : NULL;
  MainConnectionIDFunction mainConnectionID = symbols->skyLight
    ? (MainConnectionIDFunction)dlsym(symbols->skyLight, "SLSMainConnectionID")
    : NULL;
  symbols->setFrontProcess = symbols->skyLight
    ? (SetFrontProcessFunction)dlsym(symbols->skyLight, "_SLPSSetFrontProcessWithOptions")
    : NULL;
  symbols->postEventRecord = symbols->skyLight
    ? (PostEventRecordFunction)dlsym(symbols->skyLight, "SLPSPostEventRecordTo")
    : NULL;

  if (!symbols->applicationServices
    || !symbols->skyLight
    || !symbols->getWindowID
    || !mainConnectionID
    || !symbols->setFrontProcess
    || !symbols->postEventRecord
  ) {
    closePrivateSymbols(symbols);
    return @"required private focus symbols are unavailable";
  }
  if (mainConnectionID() <= 0) {
    closePrivateSymbols(symbols);
    return @"the private WindowServer connection is unavailable";
  }
  return nil;
}

static NSDictionary *windowInfo(CGWindowID windowID) {
  CFArrayRef rawWindows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowID);
  NSArray *windows = CFBridgingRelease(rawWindows);
  for (NSDictionary *candidate in windows) {
    NSNumber *candidateID = candidate[(__bridge NSString *)kCGWindowNumber];
    if (candidateID.unsignedIntValue == windowID) return candidate;
  }
  return nil;
}

static NSRunningApplication *validatedChromeApplication(pid_t pid, NSString **errorMessage) {
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!application || application.terminated || ![application.bundleIdentifier isEqualToString:@"com.google.Chrome"]) {
    *errorMessage = @"pid is not the running Google Chrome application";
    return nil;
  }
  return application;
}

static NSNumber *configuredChromeProcessID(
  NSString *userDataDirectory,
  NSString **errorMessage
) {
  if (userDataDirectory.length == 0) {
    *errorMessage = @"the configured Chrome user-data directory is invalid";
    return nil;
  }

  NSString *lockPath = [userDataDirectory stringByAppendingPathComponent:@"SingletonLock"];
  NSString *target = [NSFileManager.defaultManager
    destinationOfSymbolicLinkAtPath:lockPath
    error:NULL
  ];
  if (!target) {
    *errorMessage = @"the configured Chrome user-data process lock is unavailable";
    return nil;
  }

  NSArray<NSString *> *targetParts = [target componentsSeparatedByString:@"-"];
  NSString *processIDText = targetParts.count > 1 ? targetParts.lastObject : nil;
  NSScanner *scanner = [NSScanner scannerWithString:processIDText ?: @""];
  scanner.charactersToBeSkipped = nil;
  long long processID = 0;
  if (![scanner scanLongLong:&processID]
    || !scanner.isAtEnd
    || processID <= 1
    || processID > INT_MAX
  ) {
    *errorMessage = @"the configured Chrome user-data process lock is invalid";
    return nil;
  }

  NSString *validationError = nil;
  if (!validatedChromeApplication((pid_t)processID, &validationError)) {
    *errorMessage = validationError ?: @"the configured Chrome process is unavailable";
    return nil;
  }
  return @(processID);
}

static int configuredProcess(lua_State *L) {
  @autoreleasepool {
    const char *userDataDirectoryBytes = luaL_checkstring(L, 1);
    NSString *userDataDirectory = [NSString stringWithUTF8String:userDataDirectoryBytes];
    NSString *processError = nil;
    NSNumber *processID = configuredChromeProcessID(userDataDirectory, &processError);
    if (!processID) return pushFailure(L, processError);

    lua_pushinteger(L, (lua_Integer)processID.longLongValue);
    return 1;
  }
}

static NSString *scriptingFailure(
  TabOutScriptingDelegate *delegate,
  NSString *fallback
) {
  return delegate.lastError
    ? [NSString stringWithFormat:@"%@ (error %ld)", fallback, (long)delegate.lastError.code]
    : fallback;
}

static CFAbsoluteTime scriptingDeadline(
  lua_State *L,
  int index,
  NSTimeInterval defaultTimeoutSeconds
) {
  lua_Number requested = luaL_optnumber(L, index, defaultTimeoutSeconds);
  NSTimeInterval timeout = isfinite(requested) && requested > 0
    ? MIN((NSTimeInterval)requested, kMaximumScriptingTimeoutSeconds)
    : defaultTimeoutSeconds;
  return CFAbsoluteTimeGetCurrent() + timeout;
}

static NSString *deadlineError(CFAbsoluteTime deadline) {
  return CFAbsoluteTimeGetCurrent() >= deadline
    ? @"Chrome's process-targeted deadline expired"
    : nil;
}

static BOOL prepareScriptingEvent(
  SBApplication *application,
  TabOutScriptingDelegate *delegate,
  CFAbsoluteTime deadline,
  NSString **errorMessage
) {
  NSTimeInterval remaining = deadline - CFAbsoluteTimeGetCurrent();
  if (remaining <= 0) {
    *errorMessage = deadlineError(deadline);
    return NO;
  }
  application.timeout = MAX(1, (NSInteger)ceil(MIN(
    remaining,
    kMaximumScriptingTimeoutSeconds
  ) * 60));
  delegate.lastError = nil;
  return YES;
}

static id copyScriptingProperty(
  SBApplication *application,
  TabOutScriptingDelegate *delegate,
  SBObject *object,
  AEKeyword property,
  CFAbsoluteTime deadline,
  NSString *fallback,
  NSString **errorMessage
) {
  if (!prepareScriptingEvent(application, delegate, deadline, errorMessage)) return nil;
  id value = [[object propertyWithCode:property] get];
  if (deadlineError(deadline)) {
    *errorMessage = deadlineError(deadline);
    return nil;
  }
  if (delegate.lastError) {
    *errorMessage = scriptingFailure(delegate, fallback);
    return nil;
  }
  return value;
}

static NSNumber *positiveBrowserWindowID(id value) {
  if (![value respondsToSelector:@selector(longLongValue)]) return nil;
  long long identifier = [value longLongValue];
  if (identifier <= 0) return nil;
  return @(identifier);
}

static SBObject *verifiedSoleActiveTab(
  SBApplication *application,
  TabOutScriptingDelegate *delegate,
  SBObject *window,
  Class tabClass,
  CFAbsoluteTime deadline,
  NSString **documentURL,
  NSString **errorMessage
) {
  SBElementArray *tabs = [window elementArrayWithCode:kChromeTabClass];
  if (!tabs) {
    *errorMessage = @"Chrome's exact target tabs are unavailable";
    return nil;
  }
  if (!prepareScriptingEvent(application, delegate, deadline, errorMessage)) return nil;
  NSUInteger tabCount = tabs.count;
  if (delegate.lastError) {
    *errorMessage = scriptingFailure(delegate, @"Chrome's exact tab count read failed");
    return nil;
  }
  if (tabCount != 1) {
    *errorMessage = @"the exact Chrome window no longer contains one tab";
    return nil;
  }

  SBObject *activeTab = [window propertyWithClass:tabClass code:kChromeActiveTabProperty];
  NSString *readError = nil;
  NSNumber *activeTabID = positiveBrowserWindowID(copyScriptingProperty(
    application,
    delegate,
    activeTab,
    kChromeIdentifierProperty,
    deadline,
    @"Chrome's exact active-tab identity read failed",
    &readError
  ));
  if (readError) {
    *errorMessage = readError;
    return nil;
  }
  SBObject *exactTab = activeTabID ? [tabs objectWithID:activeTabID] : nil;
  NSNumber *exactTabID = positiveBrowserWindowID(copyScriptingProperty(
    application,
    delegate,
    exactTab,
    kChromeIdentifierProperty,
    deadline,
    @"Chrome's exact tab identity read failed",
    &readError
  ));
  if (readError) {
    *errorMessage = readError;
    return nil;
  }
  id exactURL = copyScriptingProperty(
    application,
    delegate,
    exactTab,
    kChromeUrlProperty,
    deadline,
    @"Chrome's exact tab document read failed",
    &readError
  );
  if (readError) {
    *errorMessage = readError;
    return nil;
  }

  SBObject *currentActiveTab = [window propertyWithClass:tabClass code:kChromeActiveTabProperty];
  NSNumber *currentActiveTabID = positiveBrowserWindowID(copyScriptingProperty(
    application,
    delegate,
    currentActiveTab,
    kChromeIdentifierProperty,
    deadline,
    @"Chrome's active-tab revalidation failed",
    &readError
  ));
  if (readError) {
    *errorMessage = readError;
    return nil;
  }
  if (!prepareScriptingEvent(application, delegate, deadline, errorMessage)) return nil;
  NSUInteger currentTabCount = tabs.count;
  if (delegate.lastError) {
    *errorMessage = scriptingFailure(delegate, @"Chrome's exact tab-count revalidation failed");
    return nil;
  }
  if (currentTabCount != 1
    || !activeTabID
    || ![exactTabID isEqualToNumber:activeTabID]
    || ![currentActiveTabID isEqualToNumber:activeTabID]
    || ![exactURL isKindOfClass:[NSString class]]
  ) {
    *errorMessage = @"the exact Chrome tab changed before mutation";
    return nil;
  }

  if (documentURL) *documentURL = exactURL;
  return exactTab;
}

static double roundedCoordinate(double value) {
  return floor(value + 0.5);
}

static NSString *windowFingerprint(NSRect bounds, NSString *documentURL) {
  if (!isfinite(bounds.origin.x)
    || !isfinite(bounds.origin.y)
    || !isfinite(bounds.size.width)
    || !isfinite(bounds.size.height)
    || bounds.size.width <= 0
    || bounds.size.height <= 0
    || documentURL.length == 0
  ) {
    return nil;
  }

  return [NSString stringWithFormat:
    @"%.0f\n%.0f\n%.0f\n%.0f\n%@",
    roundedCoordinate(bounds.origin.x),
    roundedCoordinate(bounds.origin.y),
    roundedCoordinate(NSMaxX(bounds)),
    roundedCoordinate(NSMaxY(bounds)),
    documentURL
  ];
}

static BOOL documentCarriesCreationToken(
  NSString *documentURL,
  NSString *extensionID,
  NSString *creationToken
) {
  NSURLComponents *components = [NSURLComponents componentsWithString:documentURL];
  if (!components
    || ![components.scheme isEqualToString:@"chrome-extension"]
    || ![components.host isEqualToString:extensionID]
    || ![components.path isEqualToString:@"/index.html"]
  ) {
    return NO;
  }

  NSInteger matchingItems = 0;
  for (NSURLQueryItem *item in components.queryItems ?: @[]) {
    if ([item.name isEqualToString:@"tabOutPlacement"]) {
      matchingItems += 1;
      if (![item.value isEqualToString:creationToken]) return NO;
    }
  }
  return matchingItems == 1;
}

static AXError prepareAccessibilityEvent(AXUIElementRef element, CFAbsoluteTime deadline) {
  NSTimeInterval remaining = deadline - CFAbsoluteTimeGetCurrent();
  if (remaining <= 0) return kAXErrorCannotComplete;
  // This timeout belongs only to this element, never the system-wide default.
  return AXUIElementSetMessagingTimeout(element, (float)remaining);
}

static AXError copyAccessibilityAttribute(
  AXUIElementRef element,
  CFStringRef attribute,
  CFAbsoluteTime deadline,
  CFTypeRef *value
) {
  *value = NULL;
  AXError preparationError = prepareAccessibilityEvent(element, deadline);
  if (preparationError != kAXErrorSuccess) return preparationError;
  AXError copyError = AXUIElementCopyAttributeValue(element, attribute, value);
  if (deadlineError(deadline)) {
    if (*value) CFRelease(*value);
    *value = NULL;
    return kAXErrorCannotComplete;
  }
  return copyError;
}

static NSString *copyStringAttribute(
  AXUIElementRef element,
  CFStringRef attribute,
  CFAbsoluteTime deadline
) {
  CFTypeRef rawValue = NULL;
  AXError copyError = copyAccessibilityAttribute(element, attribute, deadline, &rawValue);
  if (copyError != kAXErrorSuccess || !rawValue || CFGetTypeID(rawValue) != CFStringGetTypeID()) {
    if (rawValue) CFRelease(rawValue);
    return nil;
  }
  NSString *value = [(__bridge NSString *)rawValue copy];
  CFRelease(rawValue);
  return value;
}

static BOOL copyBooleanAttribute(
  AXUIElementRef element,
  CFStringRef attribute,
  CFAbsoluteTime deadline,
  BOOL *value
) {
  CFTypeRef rawValue = NULL;
  AXError copyError = copyAccessibilityAttribute(element, attribute, deadline, &rawValue);
  if (copyError != kAXErrorSuccess || !rawValue || CFGetTypeID(rawValue) != CFBooleanGetTypeID()) {
    if (rawValue) CFRelease(rawValue);
    return NO;
  }
  *value = CFBooleanGetValue(rawValue);
  CFRelease(rawValue);
  return YES;
}

static BOOL copyWindowFrame(AXUIElementRef window, CFAbsoluteTime deadline, NSRect *frame) {
  CFTypeRef rawPosition = NULL;
  CFTypeRef rawSize = NULL;
  AXError positionError = copyAccessibilityAttribute(window, kAXPositionAttribute, deadline, &rawPosition);
  AXError sizeError = copyAccessibilityAttribute(window, kAXSizeAttribute, deadline, &rawSize);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  BOOL valid = positionError == kAXErrorSuccess
    && rawPosition
    && CFGetTypeID(rawPosition) == AXValueGetTypeID()
    && AXValueGetType(rawPosition) == kAXValueCGPointType
    && AXValueGetValue(rawPosition, kAXValueCGPointType, &position)
    && sizeError == kAXErrorSuccess
    && rawSize
    && CFGetTypeID(rawSize) == AXValueGetTypeID()
    && AXValueGetType(rawSize) == kAXValueCGSizeType
    && AXValueGetValue(rawSize, kAXValueCGSizeType, &size);
  if (rawPosition) CFRelease(rawPosition);
  if (rawSize) CFRelease(rawSize);
  if (!valid) return NO;
  *frame = NSMakeRect(position.x, position.y, size.width, size.height);
  return YES;
}

static NSDictionary<NSNumber *, NSNumber *> *frontOrderByWindowID(pid_t pid) {
  CFArrayRef rawWindows = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly,
    kCGNullWindowID
  );
  NSArray *windows = CFBridgingRelease(rawWindows);
  NSMutableDictionary<NSNumber *, NSNumber *> *orderByWindowID = [NSMutableDictionary dictionary];
  NSInteger order = 0;
  for (NSDictionary *candidate in windows) {
    NSNumber *ownerPID = candidate[(__bridge NSString *)kCGWindowOwnerPID];
    NSNumber *layer = candidate[(__bridge NSString *)kCGWindowLayer];
    NSNumber *windowID = candidate[(__bridge NSString *)kCGWindowNumber];
    if (ownerPID.intValue == pid && layer.intValue == 0 && windowID.unsignedIntValue > 0) {
      orderByWindowID[windowID] = @(order);
      order += 1;
    }
  }
  return orderByWindowID;
}

static NSArray<NSDictionary *> *copyNativeWindowRecords(
  pid_t pid,
  AXElementWindowIDFunction getWindowID,
  CFAbsoluteTime deadline,
  NSString **errorMessage
) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) {
    *errorMessage = @"could not create the Chrome accessibility element";
    return nil;
  }

  CFTypeRef rawWindows = NULL;
  AXError copyError = copyAccessibilityAttribute(application, kAXWindowsAttribute, deadline, &rawWindows);
  CFRelease(application);
  if (copyError != kAXErrorSuccess || !rawWindows || CFGetTypeID(rawWindows) != CFArrayGetTypeID()) {
    if (rawWindows) CFRelease(rawWindows);
    *errorMessage = deadlineError(deadline)
      ?: [NSString stringWithFormat:@"could not read Chrome windows (AX error %d)", copyError];
    return nil;
  }

  NSDictionary<NSNumber *, NSNumber *> *frontOrder = frontOrderByWindowID(pid);
  NSMutableArray<NSDictionary *> *records = [NSMutableArray array];
  CFArrayRef windows = rawWindows;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    AXUIElementRef candidate = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    NSString *role = copyStringAttribute(candidate, kAXRoleAttribute, deadline);
    NSString *subrole = copyStringAttribute(candidate, kAXSubroleAttribute, deadline);
    BOOL minimized = NO;
    BOOL hasMinimized = copyBooleanAttribute(candidate, kAXMinimizedAttribute, deadline, &minimized);
    if (![role isEqualToString:(__bridge NSString *)kAXWindowRole]
      || ![subrole isEqualToString:(__bridge NSString *)kAXStandardWindowSubrole]
      || !hasMinimized
      || minimized
    ) {
      continue;
    }

    CGWindowID windowID = 0;
    NSRect bounds = NSZeroRect;
    NSString *documentURL = copyStringAttribute(candidate, kAXDocumentAttribute, deadline);
    if (documentURL.length == 0
      || prepareAccessibilityEvent(candidate, deadline) != kAXErrorSuccess
      || getWindowID(candidate, &windowID) != kAXErrorSuccess
      || windowID == 0
      || !copyWindowFrame(candidate, deadline, &bounds)
    ) {
      continue;
    }
    NSString *fingerprint = windowFingerprint(bounds, documentURL);
    if (!fingerprint) continue;
    NSNumber *identifier = @(windowID);
    [records addObject:@{
      @"fingerprint": fingerprint,
      @"nativeWindowId": identifier,
      @"order": frontOrder[identifier] ?: @(NSIntegerMax),
    }];
  }
  CFRelease(windows);
  if (deadlineError(deadline)) {
    *errorMessage = deadlineError(deadline);
    return nil;
  }
  return records;
}

static NSDictionary *copyCorrelatedChromeInventory(
  pid_t pid,
  CFAbsoluteTime deadline,
  NSString **errorMessage
) {
  if (!AXIsProcessTrusted()) {
    *errorMessage = @"Hammerspoon does not have Accessibility permission";
    return nil;
  }
  if (!validatedChromeApplication(pid, errorMessage)) return nil;

  PrivateFocusSymbols symbols;
  NSString *symbolsError = loadPrivateSymbols(&symbols);
  if (symbolsError) {
    *errorMessage = symbolsError;
    return nil;
  }
  NSArray<NSDictionary *> *nativeRecords = copyNativeWindowRecords(
    pid,
    symbols.getWindowID,
    deadline,
    errorMessage
  );
  closePrivateSymbols(&symbols);
  if (!nativeRecords) return nil;

  TabOutScriptingDelegate *delegate = [[TabOutScriptingDelegate alloc] init];
  SBApplication *application = [SBApplication applicationWithProcessIdentifier:pid];
  if (!application || !application.running) {
    *errorMessage = @"could not create the exact Chrome scripting application";
    return nil;
  }
  application.delegate = delegate;
  Class tabClass = [application classForScriptingClass:@"tab"];
  SBElementArray *windows = [application elementArrayWithCode:kChromeWindowClass];
  if (!tabClass || !windows) {
    *errorMessage = @"Chrome's process-targeted scripting interface is unavailable";
    return nil;
  }

  NSMutableArray<NSDictionary *> *browserRecords = [NSMutableArray array];
  @try {
    if (!prepareScriptingEvent(application, delegate, deadline, errorMessage)) return nil;
    // One event returns each ID and bounds in the same record. Separate positional
    // batches can mix windows if focus reorders them between reads (even if the
    // order changes back before a final ID check).
    id properties = [windows arrayByApplyingSelector:@selector(properties)];
    if (deadlineError(deadline) || delegate.lastError) {
      *errorMessage = deadlineError(deadline)
        ?: scriptingFailure(delegate, @"Chrome's process-targeted window enumeration failed");
      return nil;
    }
    if (![properties isKindOfClass:[NSArray class]]) {
      *errorMessage = @"Chrome's process-targeted window properties are unavailable";
      return nil;
    }
    for (id record in properties) {
      if (![record isKindOfClass:[NSDictionary class]]) {
        *errorMessage = @"Chrome's process-targeted window properties are malformed";
        return nil;
      }
      NSNumber *browserWindowID = positiveBrowserWindowID(record[@"id"]);
      id boundsValue = record[@"bounds"];
      if (!browserWindowID || ![boundsValue isKindOfClass:[NSValue class]]) continue;
      // Active documents and retained references still target the exact window ID.
      SBObject *window = [windows objectWithID:browserWindowID];
      NSString *readError = nil;
      SBObject *activeTab = [window propertyWithClass:tabClass code:kChromeActiveTabProperty];
      id documentValue = copyScriptingProperty(
        application,
        delegate,
        activeTab,
        kChromeUrlProperty,
        deadline,
        @"Chrome's process-targeted active-tab read failed",
        &readError
      );
      if (readError) {
        *errorMessage = readError;
        return nil;
      }
      if (![documentValue isKindOfClass:[NSString class]]) {
        continue;
      }
      NSString *fingerprint = windowFingerprint(
        [(NSValue *)boundsValue rectValue],
        (NSString *)documentValue
      );
      if (fingerprint) {
        [browserRecords addObject:@{
          @"browserWindowId": browserWindowID,
          @"documentUrl": documentValue,
          @"fingerprint": fingerprint,
          @"window": window,
        }];
      }
    }
    if (delegate.lastError) {
      *errorMessage = scriptingFailure(delegate, @"Chrome's process-targeted window enumeration failed");
      return nil;
    }
  } @catch (NSException *exception) {
    *errorMessage = [NSString stringWithFormat:
      @"Chrome's process-targeted inventory failed (%@)",
      exception.name
    ];
    return nil;
  }
  NSMutableDictionary<NSString *, NSMutableArray<NSDictionary *> *> *browserGroups = [NSMutableDictionary dictionary];
  for (NSDictionary *record in browserRecords) {
    NSString *fingerprint = record[@"fingerprint"];
    NSMutableArray *group = browserGroups[fingerprint];
    if (!group) {
      group = [NSMutableArray array];
      browserGroups[fingerprint] = group;
    }
    [group addObject:record];
  }
  NSMutableDictionary<NSString *, NSMutableArray<NSDictionary *> *> *nativeGroups = [NSMutableDictionary dictionary];
  for (NSDictionary *record in nativeRecords) {
    NSString *fingerprint = record[@"fingerprint"];
    NSMutableArray *group = nativeGroups[fingerprint];
    if (!group) {
      group = [NSMutableArray array];
      nativeGroups[fingerprint] = group;
    }
    [group addObject:record];
  }

  NSMutableDictionary<NSNumber *, NSNumber *> *nativeByBrowser = [NSMutableDictionary dictionary];
  NSMutableDictionary<NSNumber *, SBObject *> *windowByBrowser = [NSMutableDictionary dictionary];
  NSMutableDictionary<NSNumber *, NSString *> *documentByBrowser = [NSMutableDictionary dictionary];
  NSDictionary<NSNumber *, NSNumber *> *currentFrontOrder = nil;
  for (NSString *fingerprint in browserGroups) {
    NSArray<NSDictionary *> *browserGroup = browserGroups[fingerprint];
    NSArray<NSDictionary *> *nativeGroup = [nativeGroups[fingerprint] sortedArrayUsingComparator:
      ^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        return [left[@"order"] compare:right[@"order"]];
      }
    ];
    if (browserGroup.count == 0 || browserGroup.count != nativeGroup.count) continue;
    if (browserGroup.count > 1) {
      BOOL completeOrder = YES;
      for (NSDictionary *record in nativeGroup) {
        if ([record[@"order"] integerValue] == NSIntegerMax) {
          completeOrder = NO;
          break;
        }
      }
      if (!completeOrder) continue;

      // Equal fingerprints cannot expose a swapped pair during later validation.
      if (!currentFrontOrder) currentFrontOrder = frontOrderByWindowID(pid);
      NSInteger previousOrder = -1;
      for (NSDictionary *record in nativeGroup) {
        NSNumber *currentOrder = currentFrontOrder[record[@"nativeWindowId"]];
        if (!currentOrder || currentOrder.integerValue <= previousOrder) {
          *errorMessage = @"Chrome's duplicate-window order changed during correlation";
          return nil;
        }
        previousOrder = currentOrder.integerValue;
      }
    }

    for (NSUInteger index = 0; index < browserGroup.count; ++index) {
      NSDictionary *browserRecord = browserGroup[index];
      NSDictionary *nativeRecord = nativeGroup[index];
      NSNumber *browserWindowID = browserRecord[@"browserWindowId"];
      NSNumber *nativeWindowID = nativeRecord[@"nativeWindowId"];
      if (nativeByBrowser[browserWindowID] || [nativeByBrowser.allValues containsObject:nativeWindowID]) {
        continue;
      }
      nativeByBrowser[browserWindowID] = nativeWindowID;
      windowByBrowser[browserWindowID] = browserRecord[@"window"];
      documentByBrowser[browserWindowID] = browserRecord[@"documentUrl"];
    }
  }

  if (deadlineError(deadline)) {
    *errorMessage = deadlineError(deadline);
    return nil;
  }
  return @{
    @"application": application,
    @"delegate": delegate,
    @"documentByBrowser": documentByBrowser,
    @"nativeByBrowser": nativeByBrowser,
    @"tabClass": tabClass,
    @"windowByBrowser": windowByBrowser,
  };
}

static NSMutableDictionary<NSString *, NSDictionary *> *authorityStore(void) {
  static NSMutableDictionary<NSString *, NSDictionary *> *store;
  if (!store) store = [NSMutableDictionary dictionary];
  return store;
}

static void pruneAuthorities(void) {
  NSMutableDictionary<NSString *, NSDictionary *> *store = authorityStore();
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  for (NSString *token in store.allKeys) {
    if ([store[token][@"expiresAt"] doubleValue] <= now) [store removeObjectForKey:token];
  }
  while (store.count >= kMaximumAuthorities) {
    NSString *oldestToken = nil;
    NSNumber *oldestExpiry = nil;
    for (NSString *token in store) {
      NSNumber *expiry = store[token][@"expiresAt"];
      if (!oldestExpiry || [expiry compare:oldestExpiry] == NSOrderedAscending) {
        oldestExpiry = expiry;
        oldestToken = token;
      }
    }
    if (!oldestToken) break;
    [store removeObjectForKey:oldestToken];
  }
}

static NSString *storeAuthority(pid_t pid, NSDictionary *inventory) {
  pruneAuthorities();
  NSString *token = NSUUID.UUID.UUIDString;
  authorityStore()[token] = @{
    @"expiresAt": @(CFAbsoluteTimeGetCurrent() + kAuthorityLifetimeSeconds),
    @"inventory": inventory,
    @"pid": @(pid),
  };
  return token;
}

static NSDictionary *inventoryForAuthority(
  NSString *token,
  pid_t pid,
  NSString **errorMessage
) {
  pruneAuthorities();
  NSDictionary *record = authorityStore()[token];
  if (!record || [record[@"pid"] intValue] != pid) {
    *errorMessage = @"the exact Chrome route authority changed before mutation";
    return nil;
  }
  if (!validatedChromeApplication(pid, errorMessage)) {
    [authorityStore() removeObjectForKey:token];
    return nil;
  }
  NSDictionary *inventory = record[@"inventory"];
  if (!inventory) {
    [authorityStore() removeObjectForKey:token];
    *errorMessage = @"the exact Chrome route authority is unavailable";
    return nil;
  }
  return inventory;
}

static NSString *authorityTokenAtIndex(lua_State *L, int index) {
  const char *bytes = luaL_checkstring(L, index);
  NSString *token = [NSString stringWithUTF8String:bytes];
  return token.length > 0 && token.length <= 128 ? token : nil;
}

static NSString *correlationError(
  NSDictionary *inventory,
  long long browserWindowID,
  CGWindowID nativeWindowID
) {
  NSNumber *mappedWindowID = inventory[@"nativeByBrowser"][@(browserWindowID)];
  if (!mappedWindowID || mappedWindowID.unsignedIntValue != nativeWindowID) {
    return @"the browser and native Chrome window identities no longer match";
  }
  return nil;
}

static NSString *focusedWindowError(
  pid_t pid,
  CGWindowID nativeWindowID,
  AXElementWindowIDFunction getWindowID,
  CFAbsoluteTime deadline
) {
  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!frontmost || frontmost.processIdentifier != pid) {
    return @"the configured Chrome process is no longer frontmost";
  }

  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) return @"could not create the Chrome accessibility element";
  CFTypeRef rawFocusedWindow = NULL;
  AXError copyError = copyAccessibilityAttribute(
    application,
    kAXFocusedWindowAttribute,
    deadline,
    &rawFocusedWindow
  );
  CFRelease(application);
  if (copyError != kAXErrorSuccess || !rawFocusedWindow) {
    if (rawFocusedWindow) CFRelease(rawFocusedWindow);
    return deadlineError(deadline) ?: @"the exact Chrome window is no longer focused";
  }
  CGWindowID focusedWindowID = 0;
  AXError identifierError = prepareAccessibilityEvent((AXUIElementRef)rawFocusedWindow, deadline);
  if (identifierError == kAXErrorSuccess) {
    identifierError = getWindowID((AXUIElementRef)rawFocusedWindow, &focusedWindowID);
  }
  CFRelease(rawFocusedWindow);
  if (deadlineError(deadline)) return deadlineError(deadline);
  if (identifierError != kAXErrorSuccess || focusedWindowID != nativeWindowID) {
    return @"the exact Chrome window is no longer focused";
  }
  return nil;
}

static AXUIElementRef copyWindowElement(
  pid_t pid,
  CGWindowID targetWindowID,
  AXElementWindowIDFunction getWindowID,
  CFAbsoluteTime deadline,
  BOOL *wasMinimized,
  NSString **errorMessage
) {
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  if (!application) {
    *errorMessage = @"could not create the Chrome accessibility element";
    return NULL;
  }

  CFTypeRef rawWindows = NULL;
  AXError copyError = copyAccessibilityAttribute(application, kAXWindowsAttribute, deadline, &rawWindows);
  CFRelease(application);
  if (copyError != kAXErrorSuccess || !rawWindows || CFGetTypeID(rawWindows) != CFArrayGetTypeID()) {
    if (rawWindows) CFRelease(rawWindows);
    *errorMessage = deadlineError(deadline)
      ?: [NSString stringWithFormat:@"could not read Chrome windows (AX error %d)", copyError];
    return NULL;
  }

  CFArrayRef windows = rawWindows;
  AXUIElementRef result = NULL;
  for (CFIndex index = 0; index < CFArrayGetCount(windows); ++index) {
    AXUIElementRef candidate = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
    CGWindowID candidateID = 0;
    if (prepareAccessibilityEvent(candidate, deadline) == kAXErrorSuccess
      && getWindowID(candidate, &candidateID) == kAXErrorSuccess
      && candidateID == targetWindowID
    ) {
      result = (AXUIElementRef)CFRetain(candidate);
      break;
    }
  }
  CFRelease(windows);

  if (!result) {
    *errorMessage = deadlineError(deadline) ?: @"the exact Chrome accessibility window was not found";
    return NULL;
  }

  CFTypeRef role = NULL;
  CFTypeRef subrole = NULL;
  CFTypeRef minimized = NULL;
  AXError roleError = copyAccessibilityAttribute(result, kAXRoleAttribute, deadline, &role);
  AXError subroleError = copyAccessibilityAttribute(result, kAXSubroleAttribute, deadline, &subrole);
  AXError minimizedError = copyAccessibilityAttribute(result, kAXMinimizedAttribute, deadline, &minimized);
  BOOL minimizedValue = minimizedError == kAXErrorSuccess
    && minimized
    && CFGetTypeID(minimized) == CFBooleanGetTypeID()
    && CFBooleanGetValue(minimized);
  BOOL valid = roleError == kAXErrorSuccess
    && role
    && CFEqual(role, kAXWindowRole)
    && subroleError == kAXErrorSuccess
    && subrole
    && CFEqual(subrole, kAXStandardWindowSubrole)
    && minimizedError == kAXErrorSuccess
    && minimized
    && CFGetTypeID(minimized) == CFBooleanGetTypeID();

  if (role) CFRelease(role);
  if (subrole) CFRelease(subrole);
  if (minimized) CFRelease(minimized);

  if (!valid) {
    CFRelease(result);
    *errorMessage = deadlineError(deadline) ?: @"the target is not a standard Chrome window";
    return NULL;
  }

  *wasMinimized = minimizedValue;

  CFArrayRef actions = NULL;
  AXError actionsError = prepareAccessibilityEvent(result, deadline);
  if (actionsError == kAXErrorSuccess) actionsError = AXUIElementCopyActionNames(result, &actions);
  BOOL canRaise = actionsError == kAXErrorSuccess
    && !deadlineError(deadline)
    && actions
    && CFArrayContainsValue(actions, CFRangeMake(0, CFArrayGetCount(actions)), kAXRaiseAction);
  if (actions) CFRelease(actions);
  if (!canRaise) {
    CFRelease(result);
    *errorMessage = deadlineError(deadline) ?: @"the target Chrome window does not support AXRaise";
    return NULL;
  }

  return result;
}

static NSString *validateCachedCorrelation(
  NSDictionary *inventory,
  long long browserWindowIDValue,
  CGWindowID nativeWindowID,
  AXUIElementRef nativeWindow,
  CFAbsoluteTime deadline,
  BOOL *authorityChanged
) {
  if (authorityChanged) *authorityChanged = NO;
  NSString *identityError = correlationError(
    inventory,
    browserWindowIDValue,
    nativeWindowID
  );
  if (identityError) {
    if (authorityChanged) *authorityChanged = YES;
    return identityError;
  }

  NSNumber *browserWindowID = @(browserWindowIDValue);
  SBApplication *application = inventory[@"application"];
  TabOutScriptingDelegate *delegate = inventory[@"delegate"];
  Class tabClass = inventory[@"tabClass"];
  SBObject *browserWindow = inventory[@"windowByBrowser"][browserWindowID];
  if (!application || !delegate || !tabClass || !browserWindow || !nativeWindow) {
    return @"the exact Chrome route authority is unavailable";
  }

  NSString *readError = nil;
  NSNumber *currentBrowserWindowID = positiveBrowserWindowID(copyScriptingProperty(
    application,
    delegate,
    browserWindow,
    kChromeIdentifierProperty,
    deadline,
    @"Chrome's exact window identity read failed",
    &readError
  ));
  if (readError) return readError;
  id boundsValue = copyScriptingProperty(
    application,
    delegate,
    browserWindow,
    kChromeBoundsProperty,
    deadline,
    @"Chrome's exact window bounds read failed",
    &readError
  );
  if (readError) return readError;
  SBObject *activeTab = [browserWindow propertyWithClass:tabClass code:kChromeActiveTabProperty];
  id documentValue = copyScriptingProperty(
    application,
    delegate,
    activeTab,
    kChromeUrlProperty,
    deadline,
    @"Chrome's exact active-tab read failed",
    &readError
  );
  if (readError) return readError;

  NSRect nativeBounds = NSZeroRect;
  NSString *nativeDocument = copyStringAttribute(nativeWindow, kAXDocumentAttribute, deadline);
  NSString *browserFingerprint = [boundsValue isKindOfClass:[NSValue class]]
    && [documentValue isKindOfClass:[NSString class]]
    ? windowFingerprint([(NSValue *)boundsValue rectValue], (NSString *)documentValue)
    : nil;
  NSString *nativeFingerprint = copyWindowFrame(nativeWindow, deadline, &nativeBounds)
    ? windowFingerprint(nativeBounds, nativeDocument)
    : nil;
  if (deadlineError(deadline)) return deadlineError(deadline);
  if (!currentBrowserWindowID || !browserFingerprint || !nativeFingerprint) {
    return @"the exact Chrome window identity could not be read";
  }
  if (currentBrowserWindowID.longLongValue != browserWindowIDValue
    || ![browserFingerprint isEqualToString:nativeFingerprint]
  ) {
    if (authorityChanged) *authorityChanged = YES;
    return @"the browser and native Chrome window identities no longer match";
  }
  return nil;
}

static int checkCapability(lua_State *L) {
  @autoreleasepool {
    NSString *error = baseCapabilityError();
    if (error) return pushFailure(L, error);

    PrivateFocusSymbols symbols;
    error = loadPrivateSymbols(&symbols);
    if (error) return pushFailure(L, error);
    closePrivateSymbols(&symbols);

    lua_pushboolean(L, true);
    return 1;
  }
}

static int focusExactWindow(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    lua_Integer luaWindowID = luaL_checkinteger(L, 2);
    lua_Integer luaBrowserWindowID = luaL_checkinteger(L, 3);
    NSString *authorityToken = authorityTokenAtIndex(L, 4);
    BOOL allowCreatedWindowWithoutOnScreenMetadata = lua_toboolean(L, 5);
    if (luaPID <= 1
      || luaPID > INT_MAX
      || luaWindowID <= 0
      || (uint64_t)luaWindowID > UINT32_MAX
      || luaBrowserWindowID <= 0
      || !authorityToken
    ) {
      return pushMutationFailure(
        L,
        @"pid, native-window-id, browser-window-id, and authority must be valid",
        NO,
        YES
      );
    }

    NSString *capabilityError = baseCapabilityError();
    if (capabilityError) return pushMutationFailure(L, capabilityError, NO, NO);

    pid_t pid = (pid_t)luaPID;
    CGWindowID windowID = (CGWindowID)luaWindowID;
    long long browserWindowID = (long long)luaBrowserWindowID;
    NSString *identityError = nil;
    NSDictionary *inventory = inventoryForAuthority(authorityToken, pid, &identityError);
    if (!inventory) return pushMutationFailure(L, identityError, NO, YES);
    CFAbsoluteTime deadline = scriptingDeadline(
      L,
      6,
      kMaximumScriptingTimeoutSeconds
    );

    PrivateFocusSymbols symbols;
    NSString *symbolsError = loadPrivateSymbols(&symbols);
    if (symbolsError) return pushMutationFailure(L, symbolsError, NO, NO);

    NSString *accessibilityError = nil;
    BOOL wasMinimized = NO;
    AXUIElementRef targetWindow = copyWindowElement(
      pid,
      windowID,
      symbols.getWindowID,
      deadline,
      &wasMinimized,
      &accessibilityError
    );
    if (!targetWindow) {
      closePrivateSymbols(&symbols);
      return pushMutationFailure(L, accessibilityError, NO, NO);
    }

    BOOL authorityChanged = NO;
    identityError = validateCachedCorrelation(
      inventory,
      browserWindowID,
      windowID,
      targetWindow,
      deadline,
      &authorityChanged
    );
    if (identityError) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushMutationFailure(L, identityError, NO, authorityChanged);
    }

    NSDictionary *info = windowInfo(windowID);
    NSNumber *ownerPID = info[(__bridge NSString *)kCGWindowOwnerPID];
    NSNumber *layer = info[(__bridge NSString *)kCGWindowLayer];
    NSNumber *onScreen = info[(__bridge NSString *)kCGWindowIsOnscreen];
    NSString *ownerName = info[(__bridge NSString *)kCGWindowOwnerName];
    BOOL validWindowInfo = info
      && ownerPID.intValue == pid
      && layer.intValue == 0
      && [ownerName isEqualToString:@"Google Chrome"]
      // Chrome can publish a newly created focused:false window without this
      // optional key until the exact-window foreground call materializes it.
      && (onScreen.boolValue
        || wasMinimized
        || (allowCreatedWindowWithoutOnScreenMetadata && !onScreen));
    if ((info && !validWindowInfo) || (!info && !wasMinimized)) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushMutationFailure(
        L,
        @"window-id is not a normal window owned by that Chrome pid",
        NO,
        YES
      );
    }

    ProcessSerialNumber psn = {0, 0};
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    OSStatus psnError = GetProcessForPID(pid, &psn);
#pragma clang diagnostic pop
    if (psnError != noErr) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushMutationFailure(
        L,
        [NSString stringWithFormat:@"could not resolve Chrome's process serial number (%d)", psnError],
        NO,
        YES
      );
    }

    if (deadlineError(deadline)) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushMutationFailure(L, deadlineError(deadline), NO, NO);
    }
    CGError frontError = symbols.setFrontProcess(&psn, windowID, kCPSUserGenerated);
    if (frontError != kCGErrorSuccess) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushMutationFailure(
        L,
        [NSString stringWithFormat:@"exact-window foreground call failed (%d)", frontError],
        YES,
        NO
      );
    }

    uint8_t eventRecord[kKeyWindowEventRecordBytes];
    prepareKeyWindowEventRecord(eventRecord, windowID);
    eventRecord[kEventRecordPhaseOffset] = kWindowEventBeginPhase;
    CGError firstEventError = symbols.postEventRecord(&psn, eventRecord);
    eventRecord[kEventRecordPhaseOffset] = kWindowEventEndPhase;
    CGError secondEventError = symbols.postEventRecord(&psn, eventRecord);
    if (firstEventError != kCGErrorSuccess || secondEventError != kCGErrorSuccess) {
      CFRelease(targetWindow);
      closePrivateSymbols(&symbols);
      return pushMutationFailure(
        L,
        [NSString stringWithFormat:@"exact-window key events failed (%d, %d)", firstEventError, secondEventError],
        YES,
        NO
      );
    }

    if (wasMinimized) {
      AXError unminimizeError = AXUIElementSetAttributeValue(
        targetWindow,
        kAXMinimizedAttribute,
        kCFBooleanFalse
      );
      if (unminimizeError != kAXErrorSuccess) {
        CFRelease(targetWindow);
        closePrivateSymbols(&symbols);
        return pushMutationFailure(
          L,
          [NSString stringWithFormat:@"target-window reveal failed (AX error %d)", unminimizeError],
          YES,
          NO
        );
      }
    }

    AXError raiseError = AXUIElementPerformAction(targetWindow, kAXRaiseAction);
    if (raiseError != kAXErrorSuccess && wasMinimized) {
      AXUIElementSetAttributeValue(targetWindow, kAXMinimizedAttribute, kCFBooleanTrue);
    }
    CFRelease(targetWindow);
    closePrivateSymbols(&symbols);
    if (raiseError != kAXErrorSuccess) {
      return pushMutationFailure(
        L,
        [NSString stringWithFormat:@"target-window raise failed (AX error %d)", raiseError],
        YES,
        NO
      );
    }

    lua_pushboolean(L, true);
    return 1;
  }
}

static int inventoryExactProcess(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    if (luaPID <= 1 || luaPID > INT_MAX) {
      return pushFailure(L, @"pid must be a positive integer in range");
    }

    NSString *inventoryError = nil;
    NSDictionary *inventory = nil;
    CFAbsoluteTime deadline = scriptingDeadline(
      L,
      2,
      kMaximumScriptingTimeoutSeconds
    );
    @try {
      inventory = copyCorrelatedChromeInventory(
        (pid_t)luaPID,
        deadline,
        &inventoryError
      );
    } @catch (NSException *exception) {
      inventoryError = [NSString stringWithFormat:
        @"Chrome's process-targeted inventory failed (%@)",
        exception.name
      ];
    }
    if (!inventory) return pushFailure(L, inventoryError);

    NSDictionary<NSNumber *, NSNumber *> *nativeByBrowser = inventory[@"nativeByBrowser"];
    lua_newtable(L);
    for (NSNumber *browserWindowID in nativeByBrowser) {
      NSNumber *nativeWindowID = nativeByBrowser[browserWindowID];
      lua_pushinteger(L, (lua_Integer)nativeWindowID.unsignedIntValue);
      lua_pushinteger(L, (lua_Integer)browserWindowID.longLongValue);
      lua_settable(L, -3);
    }
    NSString *authorityToken = storeAuthority((pid_t)luaPID, inventory);
    lua_pushstring(L, authorityToken.UTF8String);
    return 2;
  }
}

static int matchCreatedWindow(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    lua_Integer luaBrowserWindowID = luaL_checkinteger(L, 2);
    const char *extensionIDBytes = luaL_checkstring(L, 3);
    const char *creationTokenBytes = luaL_checkstring(L, 4);
    if (luaPID <= 1 || luaPID > INT_MAX || luaBrowserWindowID <= 0) {
      return pushFailure(L, @"pid and browser-window-id must be positive integers in range");
    }
    NSString *extensionID = [NSString stringWithUTF8String:extensionIDBytes];
    NSString *creationToken = [NSString stringWithUTF8String:creationTokenBytes];
    if (extensionID.length != 32 || creationToken.length == 0) {
      return pushFailure(L, @"the expected created-window identity is invalid");
    }

    NSString *inventoryError = nil;
    NSDictionary *inventory = nil;
    CFAbsoluteTime deadline = scriptingDeadline(
      L,
      5,
      kMaximumScriptingTimeoutSeconds
    );
    @try {
      inventory = copyCorrelatedChromeInventory(
        (pid_t)luaPID,
        deadline,
        &inventoryError
      );
    } @catch (NSException *exception) {
      inventoryError = [NSString stringWithFormat:
        @"Chrome's process-targeted inventory failed (%@)",
        exception.name
      ];
    }
    if (!inventory) return pushFailure(L, inventoryError);

    NSNumber *browserWindowID = @((long long)luaBrowserWindowID);
    NSString *documentURL = inventory[@"documentByBrowser"][browserWindowID];
    NSNumber *nativeWindowID = inventory[@"nativeByBrowser"][browserWindowID];
    if (!nativeWindowID
      || !documentCarriesCreationToken(documentURL, extensionID, creationToken)
    ) {
      return pushFailure(L, @"the created browser window token is not available on the authorized Chrome process");
    }
    lua_pushinteger(L, (lua_Integer)nativeWindowID.unsignedIntValue);
    NSString *authorityToken = storeAuthority((pid_t)luaPID, inventory);
    lua_pushstring(L, authorityToken.UTF8String);
    return 2;
  }
}

static int navigateExactWindow(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    lua_Integer luaNativeWindowID = luaL_checkinteger(L, 2);
    lua_Integer luaBrowserWindowID = luaL_checkinteger(L, 3);
    NSString *authorityToken = authorityTokenAtIndex(L, 4);
    const char *operationBytes = luaL_checkstring(L, 5);
    const char *destinationURLBytes = luaL_checkstring(L, 6);
    if (luaPID <= 1
      || luaPID > INT_MAX
      || luaNativeWindowID <= 0
      || (uint64_t)luaNativeWindowID > UINT32_MAX
      || luaBrowserWindowID <= 0
      || !authorityToken
    ) {
      return pushFailure(
        L,
        @"pid, native-window-id, browser-window-id, and authority must be valid"
      );
    }
    NSString *operation = [NSString stringWithUTF8String:operationBytes];
    NSString *destinationURL = [NSString stringWithUTF8String:destinationURLBytes];
    BOOL replacesActiveTab = [operation isEqualToString:@"replace-active-tab"];
    if (![operation isEqualToString:@"open-tab"] && !replacesActiveTab) {
      return pushFailure(L, @"the exact Chrome navigation operation is unsupported");
    }
    if (destinationURL.length == 0) {
      return pushFailure(L, @"the exact Chrome navigation destination is invalid");
    }
    NSString *expectedURL = nil;
    if (replacesActiveTab) {
      const char *expectedURLBytes = luaL_checkstring(L, 7);
      expectedURL = [NSString stringWithUTF8String:expectedURLBytes];
      if (expectedURL.length == 0) {
        return pushFailure(L, @"the expected active-tab document is invalid");
      }
    }

    pid_t pid = (pid_t)luaPID;
    CGWindowID nativeWindowID = (CGWindowID)luaNativeWindowID;
    long long browserWindowIDValue = (long long)luaBrowserWindowID;
    NSString *navigationError = nil;
    NSDictionary *inventory = inventoryForAuthority(
      authorityToken,
      pid,
      &navigationError
    );
    if (!inventory) return pushFailure(L, navigationError);
    CFAbsoluteTime deadline = scriptingDeadline(
      L,
      8,
      kMaximumScriptingTimeoutSeconds
    );

    PrivateFocusSymbols symbols;
    navigationError = loadPrivateSymbols(&symbols);
    if (navigationError) return pushFailure(L, navigationError);
    BOOL wasMinimized = NO;
    AXUIElementRef nativeWindow = copyWindowElement(
      pid,
      nativeWindowID,
      symbols.getWindowID,
      deadline,
      &wasMinimized,
      &navigationError
    );
    if (!nativeWindow) {
      closePrivateSymbols(&symbols);
      return pushFailure(L, navigationError);
    }
    navigationError = validateCachedCorrelation(
      inventory,
      browserWindowIDValue,
      nativeWindowID,
      nativeWindow,
      deadline,
      NULL
    );
    CFRelease(nativeWindow);
    if (navigationError) {
      closePrivateSymbols(&symbols);
      return pushFailure(L, navigationError);
    }
    navigationError = focusedWindowError(pid, nativeWindowID, symbols.getWindowID, deadline);
    closePrivateSymbols(&symbols);
    if (navigationError) return pushFailure(L, navigationError);

    NSNumber *browserWindowID = @(browserWindowIDValue);
    SBApplication *application = inventory[@"application"];
    TabOutScriptingDelegate *delegate = inventory[@"delegate"];
    Class tabClass = inventory[@"tabClass"];
    SBObject *window = inventory[@"windowByBrowser"][browserWindowID];
    if (!application || !delegate || !tabClass || !window) {
      return pushFailure(L, @"the exact Chrome scripting target is unavailable");
    }

    delegate.lastError = nil;
    @try {
      if (replacesActiveTab) {
        NSString *verifiedURL = nil;
        SBObject *exactTab = verifiedSoleActiveTab(
          application,
          delegate,
          window,
          tabClass,
          deadline,
          &verifiedURL,
          &navigationError
        );
        if (!exactTab) return pushFailure(L, navigationError);
        if (![verifiedURL isEqualToString:expectedURL]) {
          return pushFailure(L, @"the created bootstrap tab changed before exact finalization");
        }
        if (!prepareScriptingEvent(application, delegate, deadline, &navigationError)) {
          return pushFailure(L, navigationError);
        }
        [[exactTab propertyWithCode:kChromeUrlProperty] setTo:destinationURL];
      } else {
        SBElementArray *tabs = [window elementArrayWithCode:kChromeTabClass];
        SBObject *newTab = [[tabClass alloc] initWithProperties:@{ @"URL": destinationURL }];
        if (!tabs || !newTab) {
          return pushFailure(L, @"Chrome could not construct the exact target tab");
        }
        if (!prepareScriptingEvent(application, delegate, deadline, &navigationError)) {
          return pushFailure(L, navigationError);
        }
        [tabs addObject:newTab];
        if (delegate.lastError) {
          return pushFailure(
            L,
            scriptingFailure(delegate, @"Chrome's exact target-tab creation failed")
          );
        }
        if (!prepareScriptingEvent(application, delegate, deadline, &navigationError)) {
          return pushFailure(L, navigationError);
        }
        [[window propertyWithCode:kChromeActiveTabIndexProperty] setTo:@(tabs.count)];
      }
    } @catch (NSException *exception) {
      return pushFailure(L, [NSString stringWithFormat:
        @"Chrome's process-targeted navigation failed (%@)",
        exception.name
      ]);
    }
    if (delegate.lastError) {
      return pushFailure(L, scriptingFailure(delegate, @"Chrome's process-targeted navigation failed"));
    }

    lua_pushboolean(L, true);
    return 1;
  }
}

static int validateExactWindow(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    lua_Integer luaNativeWindowID = luaL_checkinteger(L, 2);
    lua_Integer luaBrowserWindowID = luaL_checkinteger(L, 3);
    NSString *authorityToken = authorityTokenAtIndex(L, 4);
    if (luaPID <= 1
      || luaPID > INT_MAX
      || luaNativeWindowID <= 0
      || (uint64_t)luaNativeWindowID > UINT32_MAX
      || luaBrowserWindowID <= 0
      || !authorityToken
    ) {
      return pushFailure(
        L,
        @"pid, native-window-id, browser-window-id, and authority must be valid"
      );
    }

    pid_t pid = (pid_t)luaPID;
    CGWindowID nativeWindowID = (CGWindowID)luaNativeWindowID;
    long long browserWindowID = (long long)luaBrowserWindowID;
    NSString *identityError = nil;
    NSDictionary *inventory = inventoryForAuthority(
      authorityToken,
      pid,
      &identityError
    );
    if (!inventory) return pushFailure(L, identityError);
    CFAbsoluteTime deadline = scriptingDeadline(L, 5, 1);

    PrivateFocusSymbols symbols;
    identityError = loadPrivateSymbols(&symbols);
    if (identityError) return pushFailure(L, identityError);
    BOOL wasMinimized = NO;
    AXUIElementRef nativeWindow = copyWindowElement(
      pid,
      nativeWindowID,
      symbols.getWindowID,
      deadline,
      &wasMinimized,
      &identityError
    );
    if (!nativeWindow) {
      closePrivateSymbols(&symbols);
      return pushFailure(L, identityError);
    }
    identityError = validateCachedCorrelation(
      inventory,
      browserWindowID,
      nativeWindowID,
      nativeWindow,
      deadline,
      NULL
    );
    CFRelease(nativeWindow);
    if (!identityError) {
      identityError = focusedWindowError(pid, nativeWindowID, symbols.getWindowID, deadline);
    }
    closePrivateSymbols(&symbols);
    if (identityError) return pushFailure(L, identityError);

    lua_pushboolean(L, true);
    return 1;
  }
}

static int releaseAuthority(lua_State *L) {
  @autoreleasepool {
    NSString *authorityToken = authorityTokenAtIndex(L, 1);
    if (!authorityToken) return pushFailure(L, @"the exact Chrome route authority is invalid");
    [authorityStore() removeObjectForKey:authorityToken];
    lua_pushboolean(L, true);
    return 1;
  }
}

static int closeCreatedWindow(lua_State *L) {
  @autoreleasepool {
    lua_Integer luaPID = luaL_checkinteger(L, 1);
    lua_Integer luaNativeWindowID = luaL_checkinteger(L, 2);
    lua_Integer luaBrowserWindowID = luaL_checkinteger(L, 3);
    const char *extensionIDBytes = luaL_checkstring(L, 4);
    const char *creationTokenBytes = luaL_checkstring(L, 5);
    if (luaPID <= 1
      || luaPID > INT_MAX
      || luaNativeWindowID <= 0
      || (uint64_t)luaNativeWindowID > UINT32_MAX
      || luaBrowserWindowID <= 0
    ) {
      return pushFailure(L, @"pid, native-window-id, and browser-window-id must be positive integers in range");
    }
    NSString *extensionID = [NSString stringWithUTF8String:extensionIDBytes];
    NSString *creationToken = [NSString stringWithUTF8String:creationTokenBytes];
    if (extensionID.length != 32 || creationToken.length == 0) {
      return pushFailure(L, @"the expected created-window identity is invalid");
    }

    pid_t pid = (pid_t)luaPID;
    CGWindowID nativeWindowID = (CGWindowID)luaNativeWindowID;
    long long browserWindowIDValue = (long long)luaBrowserWindowID;
    NSString *closeError = nil;
    NSDictionary *inventory = nil;
    CFAbsoluteTime deadline = scriptingDeadline(
      L,
      6,
      kMaximumScriptingTimeoutSeconds
    );
    @try {
      inventory = copyCorrelatedChromeInventory(pid, deadline, &closeError);
    } @catch (NSException *exception) {
      closeError = [NSString stringWithFormat:
        @"Chrome's exact cleanup inventory failed (%@)",
        exception.name
      ];
    }
    if (!inventory) return pushFailure(L, closeError);
    closeError = correlationError(inventory, browserWindowIDValue, nativeWindowID);
    if (closeError) return pushFailure(L, closeError);

    NSNumber *browserWindowID = @(browserWindowIDValue);
    SBApplication *application = inventory[@"application"];
    SBObject *window = inventory[@"windowByBrowser"][browserWindowID];
    TabOutScriptingDelegate *delegate = inventory[@"delegate"];
    Class tabClass = inventory[@"tabClass"];
    if (!window
      || !delegate
      || !application
      || !tabClass
    ) {
      return pushFailure(L, @"the created window changed before exact cleanup");
    }

    delegate.lastError = nil;
    @try {
      NSString *verifiedURL = nil;
      SBObject *exactTab = verifiedSoleActiveTab(
        application,
        delegate,
        window,
        tabClass,
        deadline,
        &verifiedURL,
        &closeError
      );
      if (!exactTab) return pushFailure(L, closeError);
      if (!documentCarriesCreationToken(verifiedURL, extensionID, creationToken)) {
        return pushFailure(L, @"the created window changed before exact cleanup");
      }

      if (!prepareScriptingEvent(application, delegate, deadline, &closeError)) {
        return pushFailure(L, closeError);
      }
      [exactTab sendEvent:kAECoreSuite id:kAEClose parameters:0];
    } @catch (NSException *exception) {
      return pushFailure(L, [NSString stringWithFormat:
        @"Chrome's exact created-window cleanup failed (%@)",
        exception.name
      ]);
    }
    if (delegate.lastError) {
      return pushFailure(L, scriptingFailure(delegate, @"Chrome's exact created-window cleanup failed"));
    }

    lua_pushboolean(L, true);
    return 1;
  }
}

static const luaL_Reg moduleFunctions[] = {
  {"capability", checkCapability},
  {"closeCreated", closeCreatedWindow},
  {"configuredProcess", configuredProcess},
  {"focus", focusExactWindow},
  {"inventory", inventoryExactProcess},
  {"matchCreated", matchCreatedWindow},
  {"navigate", navigateExactWindow},
  {"release", releaseAuthority},
  {"validate", validateExactWindow},
  {NULL, NULL},
};

__attribute__((visibility("default")))
int luaopen_tab_out_private_focus(lua_State *L) {
  luaL_newlib(L, moduleFunctions);
  return 1;
}
