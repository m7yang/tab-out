#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <LuaSkin/LuaSkin.h>
#import <ScriptingBridge/ScriptingBridge.h>
#import <dlfcn.h>

// Exercise the shipped Lua boundary, replacing only macOS/ScriptingBridge I/O.
// In particular, enumeration yields positional references just as ScriptingBridge
// does; reading a window ID does not make that reference stable across reordering.
static const pid_t testPID = 43250;
static NSArray<NSDictionary *> *testWindows;
static CGWindowID testFocusedWindow;
static NSInteger testEnumerationError;
static NSInteger testReadError;
static BOOL testWrongWindowID;
static BOOL testMissingWindowBounds;
static BOOL testChangedBrowserURL;
static BOOL testReorderAfterNativeSnapshot;
static AXError testAXReadError;
static CFAbsoluteTime testClock;
static NSTimeInterval testAXReadDelay;
static NSTimeInterval testAXWindowIDDelay;
static NSMapTable<id, NSNumber *> *testAXTimeouts;
static NSUInteger testMutations;
static NSUInteger testScriptingReads;
static BOOL testReorderAfterProperties;
static BOOL testMalformedProperties;
static NSTimeInterval testPropertiesDelay;

@class TestElementArray;
@interface TestScriptingObject : NSObject
@property(nonatomic) NSUInteger index;
@property(nonatomic, strong) NSNumber *identifier;
@property(nonatomic) AEKeyword property;
- (id)get;
- (TestScriptingObject *)propertyWithCode:(AEKeyword)code;
- (TestScriptingObject *)propertyWithClass:(Class)cls code:(AEKeyword)code;
- (TestElementArray *)elementArrayWithCode:(DescType)code;
- (instancetype)initWithProperties:(NSDictionary *)properties;
- (void)setTo:(id)value;
- (id)sendEvent:(AEEventClass)eventClass id:(AEEventID)eventID parameters:(DescType)code, ...;
@end

@interface TestElementArray : NSMutableArray
- (TestScriptingObject *)objectWithID:(id)identifier;
- (NSArray *)arrayByApplyingSelector:(SEL)selector;
@end

@interface TestScriptingApplication : NSObject
@property(nonatomic, strong) id<SBApplicationDelegate> delegate;
@property(nonatomic) long timeout;
@property(nonatomic, readonly) BOOL running;
+ (instancetype)applicationWithProcessIdentifier:(pid_t)pid;
- (Class)classForScriptingClass:(NSString *)name;
- (TestElementArray *)elementArrayWithCode:(DescType)code;
@end

static TestScriptingApplication *testApplication;

@implementation TestScriptingApplication
+ (instancetype)applicationWithProcessIdentifier:(pid_t)pid {
  return pid == testPID ? testApplication : nil;
}
- (BOOL)running { return YES; }
- (Class)classForScriptingClass:(NSString *)name {
  (void)name;
  return TestScriptingObject.class;
}
- (TestElementArray *)elementArrayWithCode:(DescType)code {
  (void)code;
  return [TestElementArray new];
}
@end

static void reportTestScriptingError(NSInteger code) {
  AppleEvent event = { typeNull, NULL };
  [testApplication.delegate eventDidFail:&event
    withError:[NSError errorWithDomain:NSOSStatusErrorDomain code:code userInfo:nil]];
}

@implementation TestElementArray
- (NSArray *)arrayByApplyingSelector:(SEL)selector {
  if (![NSStringFromSelector(selector) isEqualToString:@"properties"]) {
    [NSException raise:NSInvalidArgumentException format:@"unexpected batch selector"];
  }
  testScriptingReads += 1;
  testClock += testPropertiesDelay;
  if (testEnumerationError) {
    reportTestScriptingError(testEnumerationError);
    return nil;
  }
  if (testMalformedProperties) return @[@"invalid"];
  NSMutableArray *properties = [NSMutableArray array];
  for (NSDictionary *window in testWindows) {
    NSMutableDictionary *record = [@{ @"id": [window[@"browserID"] stringValue] } mutableCopy];
    if (!testMissingWindowBounds) record[@"bounds"] = window[@"bounds"];
    [properties addObject:record];
  }
  if (testReorderAfterProperties) testWindows = [[testWindows reverseObjectEnumerator] allObjects];
  return properties;
}
- (NSUInteger)count {
  if (testEnumerationError) {
    reportTestScriptingError(testEnumerationError);
    return 0;
  }
  return testWindows.count;
}
- (id)objectAtIndex:(NSUInteger)index {
  TestScriptingObject *object = [TestScriptingObject new];
  object.index = index;
  return object;
}
- (TestScriptingObject *)objectWithID:(id)identifier {
  TestScriptingObject *object = [TestScriptingObject new];
  object.identifier = identifier;
  return object;
}
@end

@implementation TestScriptingObject
- (id)get {
  testScriptingReads += 1;
  if (testReadError) {
    reportTestScriptingError(testReadError);
    return nil;
  }
  NSDictionary *window = nil;
  if (self.identifier) {
    for (NSDictionary *candidate in testWindows) {
      if ([candidate[@"browserID"] isEqual:self.identifier]) window = candidate;
    }
  } else if (self.index < testWindows.count) {
    window = testWindows[self.index];
  }
  if (!window) {
    reportTestScriptingError(errAENoSuchObject);
    return nil;
  }
  switch (self.property) {
    case 'ID  ': return testWrongWindowID ? @999 : window[@"browserID"];
    case 'pbnd': return testMissingWindowBounds ? nil : window[@"bounds"];
    case 'URL ': return testChangedBrowserURL ? @"https://example.test/changed" : window[@"url"];
    default: return nil;
  }
}
- (TestScriptingObject *)propertyWithCode:(AEKeyword)code {
  TestScriptingObject *property = [TestScriptingObject new];
  property.index = self.index;
  property.identifier = self.identifier;
  property.property = code;
  return property;
}
- (TestScriptingObject *)propertyWithClass:(Class)cls code:(AEKeyword)code {
  (void)cls;
  return [self propertyWithCode:code];
}
- (TestElementArray *)elementArrayWithCode:(DescType)code {
  (void)code;
  return [TestElementArray new];
}
- (instancetype)initWithProperties:(NSDictionary *)properties {
  (void)properties;
  return [self init];
}
- (void)setTo:(id)value { (void)value; testMutations += 1; }
- (id)sendEvent:(AEEventClass)eventClass id:(AEEventID)eventID parameters:(DescType)code, ... {
  (void)eventClass; (void)eventID; (void)code;
  testMutations += 1;
  return nil;
}
@end

@interface TestRunningApplication : NSObject
+ (instancetype)runningApplicationWithProcessIdentifier:(pid_t)pid;
@property(nonatomic, readonly) BOOL terminated;
@property(nonatomic, readonly) NSString *bundleIdentifier;
@property(nonatomic, readonly) pid_t processIdentifier;
@end
@implementation TestRunningApplication
+ (instancetype)runningApplicationWithProcessIdentifier:(pid_t)pid {
  return pid == testPID ? [self new] : nil;
}
- (BOOL)terminated { return NO; }
- (NSString *)bundleIdentifier { return @"com.google.Chrome"; }
- (pid_t)processIdentifier { return testPID; }
@end

@interface TestWorkspace : NSObject
+ (instancetype)sharedWorkspace;
@property(nonatomic, readonly) TestRunningApplication *frontmostApplication;
@end
@implementation TestWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (TestRunningApplication *)frontmostApplication {
  return [TestRunningApplication runningApplicationWithProcessIdentifier:testPID];
}
@end

static BOOL testAXTrusted(void) { return YES; }
static CFAbsoluteTime testNow(void) { return testClock; }
static AXUIElementRef testAXApplication(pid_t pid) {
  if (pid != testPID) return NULL;
  return (AXUIElementRef)CFRetain((__bridge CFTypeRef)@{ @"application": @YES });
}
static AXError testAXSetTimeout(AXUIElementRef element, float timeout) {
  [testAXTimeouts setObject:@(timeout) forKey:(__bridge id)element];
  return kAXErrorSuccess;
}
static AXError testAXAttribute(AXUIElementRef element, CFStringRef attribute, CFTypeRef *value) {
  NSNumber *timeout = [testAXTimeouts objectForKey:(__bridge id)element];
  if (timeout && testAXReadDelay > timeout.doubleValue) {
    testClock += timeout.doubleValue;
    *value = NULL;
    return kAXErrorCannotComplete;
  }
  testClock += testAXReadDelay;
  if (testAXReadError) {
    *value = NULL;
    return testAXReadError;
  }
  NSDictionary *record = (__bridge NSDictionary *)element;
  NSString *key = (__bridge NSString *)attribute;
  id result = nil;
  if ([key isEqualToString:(__bridge NSString *)kAXWindowsAttribute]) {
    result = testWindows;
  } else if ([key isEqualToString:(__bridge NSString *)kAXFocusedWindowAttribute]) {
    for (NSDictionary *window in testWindows) {
      if ([window[@"nativeID"] unsignedIntValue] == testFocusedWindow) result = [window mutableCopy];
    }
  } else if ([key isEqualToString:(__bridge NSString *)kAXRoleAttribute]) {
    result = (__bridge NSString *)kAXWindowRole;
  } else if ([key isEqualToString:(__bridge NSString *)kAXSubroleAttribute]) {
    result = (__bridge NSString *)kAXStandardWindowSubrole;
  } else if ([key isEqualToString:(__bridge NSString *)kAXMinimizedAttribute]) {
    result = @NO;
  } else if ([key isEqualToString:(__bridge NSString *)kAXDocumentAttribute]) {
    result = record[@"url"];
  } else if ([key isEqualToString:(__bridge NSString *)kAXPositionAttribute]) {
    CGPoint point = [record[@"bounds"] rectValue].origin;
    *value = AXValueCreate(kAXValueCGPointType, &point);
    return kAXErrorSuccess;
  } else if ([key isEqualToString:(__bridge NSString *)kAXSizeAttribute]) {
    CGSize size = [record[@"bounds"] rectValue].size;
    *value = AXValueCreate(kAXValueCGSizeType, &size);
    return kAXErrorSuccess;
  }
  *value = result ? CFRetain((__bridge CFTypeRef)result) : NULL;
  return result ? kAXErrorSuccess : kAXErrorNoValue;
}
static AXError testAXActions(AXUIElementRef element, CFArrayRef *actions) {
  (void)element;
  *actions = (CFArrayRef)CFRetain((__bridge CFTypeRef)@[(__bridge NSString *)kAXRaiseAction]);
  return kAXErrorSuccess;
}
static AXError testAXWindowID(AXUIElementRef element, CGWindowID *windowID) {
  NSNumber *timeout = [testAXTimeouts objectForKey:(__bridge id)element];
  if (timeout && testAXWindowIDDelay > timeout.doubleValue) {
    testClock += timeout.doubleValue;
    return kAXErrorCannotComplete;
  }
  testClock += testAXWindowIDDelay;
  *windowID = [((__bridge NSDictionary *)element)[@"nativeID"] unsignedIntValue];
  return kAXErrorSuccess;
}
static CFArrayRef testWindowInfo(CGWindowListOption options, CGWindowID relativeWindow) {
  (void)options; (void)relativeWindow;
  NSMutableArray *windows = [NSMutableArray array];
  for (NSDictionary *window in testWindows) {
    [windows addObject:@{
      (__bridge NSString *)kCGWindowNumber: window[@"nativeID"],
      (__bridge NSString *)kCGWindowOwnerPID: @(testPID),
      (__bridge NSString *)kCGWindowLayer: @0,
      (__bridge NSString *)kCGWindowIsOnscreen: @YES,
      (__bridge NSString *)kCGWindowOwnerName: @"Google Chrome",
    }];
  }
  if (testReorderAfterNativeSnapshot) {
    testWindows = @[testWindows[1], testWindows[0]];
    testReorderAfterNativeSnapshot = NO;
  }
  return (CFArrayRef)CFBridgingRetain(windows);
}
static int testMainConnection(void) { return 1; }
static CGError testSetFrontProcess(ProcessSerialNumber *psn, uint32_t windowID, uint32_t options) {
  (void)psn; (void)windowID; (void)options;
  testMutations += 1;
  return kCGErrorFailure;
}
static CGError testPostEvent(ProcessSerialNumber *psn, uint8_t *event) {
  (void)psn; (void)event;
  testMutations += 1;
  return kCGErrorFailure;
}
static void *testSymbol(void *handle, const char *name) {
  (void)handle;
  if (!strcmp(name, "_AXUIElementGetWindow")) return (void *)testAXWindowID;
  if (!strcmp(name, "SLSMainConnectionID")) return (void *)testMainConnection;
  if (!strcmp(name, "_SLPSSetFrontProcessWithOptions")) return (void *)testSetFrontProcess;
  if (!strcmp(name, "SLPSPostEventRecordTo")) return (void *)testPostEvent;
  return NULL;
}

#define SBApplication TestScriptingApplication
#define SBElementArray TestElementArray
#define SBObject TestScriptingObject
#define NSRunningApplication TestRunningApplication
#define NSWorkspace TestWorkspace
#define AXIsProcessTrusted testAXTrusted
#define AXUIElementCreateApplication testAXApplication
#define AXUIElementCopyAttributeValue testAXAttribute
#define AXUIElementCopyActionNames testAXActions
#define AXUIElementSetMessagingTimeout testAXSetTimeout
#define CGWindowListCopyWindowInfo testWindowInfo
#define CFAbsoluteTimeGetCurrent testNow
#define dlsym testSymbol
#include "../TabOut.spoon/native/tab_out_private_focus.m"

static NSUInteger testFailures;
static void check(BOOL condition, const char *message) {
  if (!condition) {
    fprintf(stderr, "FAIL: %s\n", message);
    testFailures += 1;
  }
}

static void resetFixture(void) {
  testWindows = @[
    @{ @"browserID": @101, @"nativeID": @201,
       @"bounds": [NSValue valueWithRect:NSMakeRect(0, 0, 800, 600)],
       @"url": @"https://example.test/first" },
    @{ @"browserID": @102, @"nativeID": @202,
       @"bounds": [NSValue valueWithRect:NSMakeRect(800, 0, 800, 600)],
       @"url": @"https://example.test/second" },
  ];
  testApplication = [TestScriptingApplication new];
  testFocusedWindow = 201;
  testClock = 100;
  testAXReadDelay = 0;
  testAXWindowIDDelay = 0;
  testAXTimeouts = [NSMapTable
    mapTableWithKeyOptions:NSPointerFunctionsStrongMemory | NSPointerFunctionsObjectPointerPersonality
    valueOptions:NSPointerFunctionsStrongMemory
  ];
  testEnumerationError = 0;
  testReadError = 0;
  testWrongWindowID = NO;
  testMissingWindowBounds = NO;
  testChangedBrowserURL = NO;
  testReorderAfterNativeSnapshot = NO;
  testAXReadError = kAXErrorSuccess;
  testMutations = 0;
  testScriptingReads = 0;
  testReorderAfterProperties = NO;
  testMalformedProperties = NO;
  testPropertiesDelay = 0;
}

static void beginCall(lua_State *L, const char *method) {
  lua_settop(L, 0);
  lua_getglobal(L, "chrome");
  lua_getfield(L, -1, method);
  lua_remove(L, -2);
}
static void finishCall(lua_State *L, int arguments) {
  if (lua_pcall(L, arguments, LUA_MULTRET, 0) != LUA_OK) {
    fprintf(stderr, "Lua error: %s\n", lua_tostring(L, -1));
    exit(2);
  }
}
static NSString *inventoryAuthority(lua_State *L) {
  beginCall(L, "inventory");
  lua_pushinteger(L, testPID);
  finishCall(L, 1);
  check(lua_istable(L, 1), "valid native inventory succeeds");
  check(lua_isstring(L, 2), "valid inventory returns route authority");
  const char *token = lua_tostring(L, 2);
  return token ? [NSString stringWithUTF8String:token] : @"";
}
static void pushExactTarget(lua_State *L, NSString *token, lua_Integer nativeID, lua_Integer browserID) {
  lua_pushinteger(L, testPID);
  lua_pushinteger(L, nativeID);
  lua_pushinteger(L, browserID);
  lua_pushstring(L, token.UTF8String);
}
static void checkFocusFailure(
  lua_State *L,
  NSString *token,
  BOOL retryable,
  NSString *expectedError,
  const char *message
) {
  beginCall(L, "focus");
  pushExactTarget(L, token, 201, 101);
  finishCall(L, 4);
  check(lua_isnil(L, 1) && lua_istable(L, 3), "focus failure returns structured details");
  NSString *error = lua_isstring(L, 2) ? @(lua_tostring(L, 2)) : @"";
  check([error containsString:expectedError], "focus fails for the simulated cause");
  if (lua_istable(L, 3)) {
    lua_getfield(L, 3, "authorityChanged");
    check(lua_toboolean(L, -1) == retryable, message);
    lua_getfield(L, 3, "mutationStarted");
    check(!lua_toboolean(L, -1), "rejected focus did not begin a mutation");
  }
  check(testMutations == 0, "rejected focus made no native mutations");
}

int main(void) {
  @autoreleasepool {
    lua_State *L = luaL_newstate();
    luaopen_tab_out_private_focus(L);
    lua_setglobal(L, "chrome");

    resetFixture();
    NSString *token = inventoryAuthority(L);
    check(testScriptingReads == testWindows.count + 1,
      "inventory batches window metadata into one scripting read");
    testWindows = @[testWindows[1], testWindows[0]];
    testFocusedWindow = 202;
    beginCall(L, "validate");
    pushExactTarget(L, token, 202, 102);
    finishCall(L, 4);
    check(lua_toboolean(L, 1), "cached browser identity survives window reordering");

    resetFixture();
    testReorderAfterProperties = YES;
    inventoryAuthority(L);
    lua_geti(L, 1, 201);
    check(lua_tointeger(L, -1) == 101, "batch metadata stays attached to the first window ID after reorder");
    lua_geti(L, 1, 202);
    check(lua_tointeger(L, -1) == 102, "batch metadata stays attached to the second window ID after reorder");

    resetFixture();
    testMalformedProperties = YES;
    beginCall(L, "inventory");
    lua_pushinteger(L, testPID);
    finishCall(L, 1);
    check(lua_isnil(L, 1), "malformed batch is not a successful empty inventory");

    resetFixture();
    testPropertiesDelay = 0.6;
    beginCall(L, "inventory");
    lua_pushinteger(L, testPID);
    lua_pushnumber(L, 0.5);
    finishCall(L, 2);
    check(lua_isnil(L, 1), "expired batch cannot establish route authority");
    check(testScriptingReads == 1, "expired batch starts no per-window reads");

    resetFixture();
    NSMutableDictionary *duplicateWindow = [testWindows[1] mutableCopy];
    duplicateWindow[@"bounds"] = testWindows[0][@"bounds"];
    duplicateWindow[@"url"] = testWindows[0][@"url"];
    testWindows = @[testWindows[0], duplicateWindow];
    for (NSUInteger index = 0; index < 2; ++index) {
      inventoryAuthority(L);
      lua_geti(L, 1, 201);
      check(lua_tointeger(L, -1) == 101, "stable duplicate windows preserve the first exact pair");
      lua_geti(L, 1, 202);
      check(lua_tointeger(L, -1) == 102, "stable duplicate windows preserve the second exact pair");
      testWindows = @[testWindows[1], testWindows[0]];
    }
    testReorderAfterNativeSnapshot = YES;
    beginCall(L, "inventory");
    lua_pushinteger(L, testPID);
    finishCall(L, 1);
    check(lua_isnil(L, 1), "reordered duplicate windows cannot establish route authority");
    check(testMutations == 0, "ambiguous duplicate windows remain untouched");

    resetFixture();
    testWindows = @[];
    inventoryAuthority(L);
    lua_pushnil(L);
    check(lua_next(L, 1) == 0, "a successful empty inventory remains available for creation");

    for (NSNumber *errorCode in @[@(errAEEventNotPermitted), @(errAETimeout)]) {
      resetFixture();
      testEnumerationError = errorCode.integerValue;
      beginCall(L, "inventory");
      lua_pushinteger(L, testPID);
      finishCall(L, 1);
      check(lua_isnil(L, 1), "enumeration failure is not a successful empty inventory");
      NSString *message = lua_isstring(L, 2) ? @(lua_tostring(L, 2)) : @"";
      check([message containsString:errorCode.stringValue], "enumeration failure preserves the error code");

      resetFixture();
      token = inventoryAuthority(L);
      testReadError = errorCode.integerValue;
      checkFocusFailure(
        L, token, NO, errorCode.stringValue,
        "scripting failure does not authorize a route retry"
      );
    }

    resetFixture();
    token = inventoryAuthority(L);
    testAXReadDelay = 0.1;
    CFAbsoluteTime validationStartedAt = testClock;
    beginCall(L, "validate");
    pushExactTarget(L, token, 201, 101);
    lua_pushnumber(L, 0.5);
    finishCall(L, 5);
    check(lua_isnil(L, 1), "expired exact-window validation cannot succeed");
    check(testClock - validationStartedAt <= 0.500001, "Accessibility reads share the validation deadline");

    resetFixture();
    testAXReadDelay = 0.05;
    testAXWindowIDDelay = 0.3;
    CFAbsoluteTime inventoryStartedAt = testClock;
    beginCall(L, "inventory");
    lua_pushinteger(L, testPID);
    lua_pushnumber(L, 0.5);
    finishCall(L, 2);
    check(lua_isnil(L, 1), "expired window-ID lookup cannot establish route authority");
    check(testClock - inventoryStartedAt <= 0.500001, "inventory window-ID lookups share the deadline");

    resetFixture();
    token = inventoryAuthority(L);
    testAXWindowIDDelay = 0.3;
    validationStartedAt = testClock;
    beginCall(L, "validate");
    pushExactTarget(L, token, 201, 101);
    lua_pushnumber(L, 0.5);
    finishCall(L, 5);
    check(lua_isnil(L, 1), "expired focused-window lookup cannot validate the target");
    check(testClock - validationStartedAt <= 0.500001, "focused-window ID lookups share the deadline");

    resetFixture();
    token = inventoryAuthority(L);
    testAXReadDelay = 2;
    checkFocusFailure(
      L, token, NO, @"deadline expired",
      "expired scripting deadline does not authorize a route retry"
    );

    resetFixture();
    token = inventoryAuthority(L);
    testAXReadError = kAXErrorCannotComplete;
    checkFocusFailure(
      L, token, NO, @"could not read Chrome windows (AX error",
      "an Accessibility read failure does not authorize a route retry"
    );

    resetFixture();
    token = inventoryAuthority(L);
    testMissingWindowBounds = YES;
    checkFocusFailure(
      L, token, NO, @"the exact Chrome window identity could not be read",
      "an incomplete window read does not prove an identity change"
    );

    resetFixture();
    token = inventoryAuthority(L);
    testWrongWindowID = YES;
    checkFocusFailure(
      L, token, YES, @"window identities no longer match",
      "an actual browser identity change remains retryable"
    );

    resetFixture();
    token = inventoryAuthority(L);
    testChangedBrowserURL = YES;
    checkFocusFailure(
      L, token, YES, @"window identities no longer match",
      "a complete mismatched window fingerprint remains retryable"
    );

    lua_close(L);
    if (testFailures) return 1;
    puts("native Chrome authority regression: ok");
    return 0;
  }
}
