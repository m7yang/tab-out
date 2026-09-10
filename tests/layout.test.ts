import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { chooseMasonryLayout, shouldAnimateMasonryResize } from '../src/extension/layout.js'

test('chooseMasonryLayout delays a new column until the width is near the comfort target', () => {
  const beforeThreshold = chooseMasonryLayout(1340)
  const afterThreshold = chooseMasonryLayout(1390)

  assert.equal(beforeThreshold.colCount, 4)
  assert.equal(afterThreshold.colCount, 5)
  assert.equal(beforeThreshold.colWidth, 327.5)
  assert.equal(afterThreshold.colWidth, 270)
})

test('chooseMasonryLayout supports wider desktop comfort targets', () => {
  const beforeThreshold = chooseMasonryLayout(1390, {
    minColWidth: 280,
    idealColWidth: 340,
  })
  const afterThreshold = chooseMasonryLayout(1550, {
    minColWidth: 280,
    idealColWidth: 340,
  })

  assert.equal(beforeThreshold.colCount, 4)
  assert.equal(afterThreshold.colCount, 5)
  assert.equal(beforeThreshold.colWidth, 340)
  assert.equal(afterThreshold.colWidth, 302)
})

test('chooseMasonryLayout never chooses a column count narrower than the minimum width', () => {
  const layout = chooseMasonryLayout(1060)

  assert.equal(layout.colCount, 3)
  assert.ok(layout.colWidth >= 260)
})

test('chooseMasonryLayout keeps a single narrow column when the container is too small', () => {
  const layout = chooseMasonryLayout(220)

  assert.deepEqual(layout, {
    colCount: 1,
    colWidth: 220,
  })
})

test('shouldAnimateMasonryResize only changes when the column count changes', () => {
  assert.equal(shouldAnimateMasonryResize(1360, 4), false)
  assert.equal(shouldAnimateMasonryResize(1390, 4), true)
  assert.equal(shouldAnimateMasonryResize(1390, undefined), false)
})

test('masonry card motion uses transform instead of layout-property transitions', () => {
  const css = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const moveAnimationSource = readFileSync(new URL('../src/extension/move-animation.ts', import.meta.url), 'utf8')

  assert.match(moveAnimationSource, /transform \$\{config\.duration\}ms var\(--ease-swift\)/)
  assert.doesNotMatch(domainCardSource, /layout-moving[^'"]*\[transition:/)
  assert.doesNotMatch(domainCardSource, /\b(?:top|left|width)_0\.\d+s/)
  assert.doesNotMatch(css, /\.missions\.is-packed \.domain-block\s*\{[^}]*transition:[^}]*\b(top|left|width)\b/s)
})

test('card move animation preserves previous rect starts while allowing temporary history-pane bleed', () => {
  const animationSource = readFileSync(new URL('../src/extension/card-move-animation.ts', import.meta.url), 'utf8')
  const moveAnimationSource = readFileSync(new URL('../src/extension/move-animation.ts', import.meta.url), 'utf8')
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')

  assert.match(moveAnimationSource, /const dx = previousPosition\.left - next\.left/)
  assert.match(moveAnimationSource, /const dy = previousPosition\.top - next\.top/)
  assert.doesNotMatch(animationSource, /constrainCardMoveStart/)
  assert.match(animationSource, /CARD_MOVE_BLEED_CLASS = 'card-motion-bleed'/)
  assert.match(animationSource, /scrollRegion\.classList\.add\(CARD_MOVE_BLEED_CLASS\)/)
  assert.match(animationSource, /scrollRegion\.classList\.remove\(CARD_MOVE_BLEED_CLASS\)/)
  assert.match(animationSource, /export type CardMoveAnimationOptions = \{[\s\S]*allowBleed\?: boolean[\s\S]*\}/)
  assert.match(animationSource, /if \(allowBleed\) enableCardMoveBleed\(containers\)/)
  assert.match(baseCss, /\.dashboard-shell\.has-history \.dashboard-main > \.scroll-region\.card-motion-bleed\s*\{/)
  assert.match(baseCss, /--dashboard-card-motion-left-bleed:\s*calc\(260px \+ var\(--dashboard-history-edge-gutter\) \+ 16px\)/)
  assert.match(baseCss, /margin-left:\s*calc\(0px - var\(--dashboard-card-motion-left-bleed\) - var\(--dashboard-card-shadow-bleed\)\)/)
  assert.match(baseCss, /padding-left:\s*calc\(var\(--dashboard-card-motion-left-bleed\) \+ var\(--dashboard-card-shadow-bleed\)\)/)
})

test('Dashboard View source transitions keep one primed card-move refresh', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')

  const choreographySource = readFileSync(new URL('../src/extension/card-move-choreography.ts', import.meta.url), 'utf8')

  assert.match(appSource, /getCardMoves\(\)\.runSourceSwitchMove/)
  assert.match(appSource, /subscribeBeforeApply\(getCardMoves\(\)\.onBeforeStoreApply\)/)
  assert.match(choreographySource, /const previousRects = prepareDomainCardMoveAnimation\(containers\(\)\)/)
  assert.match(choreographySource, /pendingSourceSwitch = \{ rects: previousRects, requestId \}/)
  assert.match(choreographySource, /pending\?\.requestId !== event\.requestId/)
  assert.match(choreographySource, /stagedCardRects = pending\.rects/)
  assert.match(intakeSource, /emitBeforeApply\(\{ reason: 'source-switch', requestId \}\)/)
  assert.doesNotMatch(appSource, /\[source,\s*pinnedDomains,\s*pinsLoaded\]/)
})

test('pin-driven dashboard refresh cancels its pending animation frame', () => {
  const source = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')
  const callbackIndex = source.indexOf('notifyBeforePinnedRefresh()')
  const effectStart = source.lastIndexOf('useEffect(() => {', callbackIndex)
  const effectEnd = source.indexOf('}, [initialDashboardIncludesPinnedDomains, pinnedDomains, localStateLoaded])', callbackIndex)
  const effectSource = source.slice(effectStart, effectEnd)

  assert.ok(callbackIndex > -1 && effectStart > -1 && effectEnd > callbackIndex)
  assert.match(effectSource, /const frame = requestAnimationFrame/)
  assert.match(effectSource, /return \(\) => cancelAnimationFrame\(frame\)/)
})

test('no-op pinned domain drag targets use a muted placement state', () => {
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')

  assert.match(domainCardSource, /data-tabout-reorder-noop/)
  assert.match(domainCardSource, /previousPinnedDomainBlock\(targetBlock\) === sourceBlock/)
  assert.match(domainCardSource, /nextPinnedDomainBlock\(targetBlock\) === sourceBlock/)
  assert.match(domainCardSource, /data-\[tabout-reorder-target=true\]:before:h-0\.5/)
  assert.doesNotMatch(domainCardSource, /data-\[tabout-reorder-target=true\]:before:h-px/)
  assert.doesNotMatch(domainCardSource, /data-\[tabout-reorder-target=true\]:before:h-\[3px\]/)
  // The muted placement indicator rides on the domain block; the cardless
  // content wrapper should not regain a frame for a no-op target.
  assert.match(domainCardSource, /data-\[tabout-reorder-noop=true\]:before:bg-\[color-mix\(in_srgb,var\(--accent-amber\)_36%,var\(--warm-gray\)\)\]/)
  assert.doesNotMatch(domainCardSource, /group-data-\[tabout-reorder-noop=true\]\/domain-block:border-/)
})

test('working set is merged into the history panel instead of rendering a top strip', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const historyWorkingSet = source === 'tabs' \? workingSet : null/)
  assert.match(source, /workingSet=\{historyWorkingSet\}/)
  assert.match(source, /workingSet=\{historyPanelWorkingSet\}/)
  assert.doesNotMatch(source, /<WorkingSetPanel\b/)
  assert.doesNotMatch(source, /workingSetLayoutRectsRef|primeWorkingSetLayoutChange|animateWorkingSetLayoutChange/)
})

test('activation history uses hydrated Working Set targets while startup ordering stays frozen', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const visibleWorkingSet = dynamicContentVisible \? effectiveStartupPriorityWorkingSet \?\? workingSet : null/)
  assert.match(source, /const historyPanelWorkingSet = dynamicContentVisible \? workingSet : null/)
  assert.match(source, /workingSet: visibleWorkingSet/)
  assert.match(source, /workingSet=\{historyPanelWorkingSet\}/)
})

test('activation history panel stays visually empty when there are no rows', () => {
  const source = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /No activation history yet/)
})

test('source snapshot arrivals cross a page-side transition mirror', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const mirrorSource = readFileSync(new URL('../src/hooks/useDashboardIntakeSnapshot.ts', import.meta.url), 'utf8')

  assert.match(appSource, /const appDashboard = useDashboardIntakeSnapshot\(\)/)
  assert.doesNotMatch(appSource, /const appDashboard = useSyncExternalStore\(/)
  assert.match(mirrorSource, /appDashboardStore\.subscribeBeforeApply/)
  assert.match(mirrorSource, /event\.reason === 'source-switch'/)
  assert.match(mirrorSource, /nextSnapshot\.sourceAppliedRequestId === transitioningSourceRequestId/)
  assert.match(mirrorSource, /startTransition\(\(\) => setSnapshot\(nextSnapshot\)\)/)
})

test('app bootstrap admits one complete live startup frame after the generated shell', () => {
  const appEntrySource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
  const appStartupSource = readFileSync(new URL('../src/app-startup.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const localStateSource = readFileSync(new URL('../src/hooks/useDashboardLocalState.ts', import.meta.url), 'utf8')
  const refreshSource = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')
  const startupFrameSource = readFileSync(new URL('../src/extension/startup-frame.ts', import.meta.url), 'utf8')
  const startupControllerSource = readFileSync(new URL('../src/extension/startup-frame-controller.ts', import.meta.url), 'utf8')
  const renderSource = readFileSync(new URL('../src/extension/render.ts', import.meta.url), 'utf8')
  const startupSnapshotSource = readFileSync(new URL('../src/extension/startup-snapshot.ts', import.meta.url), 'utf8')
  const startupOrderDebugSource = readFileSync(new URL('../src/components/startup-order-debug.ts', import.meta.url), 'utf8')
  const startupOrderDebugTypesSource = readFileSync(new URL('../src/components/startup-order-debug-types.ts', import.meta.url), 'utf8')
  const startupOrderDebugHeavySource = readFileSync(new URL('../src/components/startup-order-debug-heavy.ts', import.meta.url), 'utf8')
  const startupOrderDebugHookSource = readFileSync(new URL('../src/components/use-startup-order-debug.ts', import.meta.url), 'utf8')
  const viewModelSource = readFileSync(new URL('../src/hooks/useDashboardViewModels.ts', import.meta.url), 'utf8')

  assert.match(appEntrySource, /setAppStartupFilterIntent\([\s\S]*readFilterFocusPendingInput\(filterInputFromSearch\(window\.location\.search\)\)/)
  assert.ok(appEntrySource.indexOf('setAppStartupFilterIntent(') < appEntrySource.indexOf('attachApp()'))
  assert.ok(appEntrySource.indexOf('attachApp()') < appEntrySource.indexOf('startupAdmissionController.start()'))
  assert.match(appEntrySource, /createStartupAdmissionController<AppStartupFrame, unknown>/)
  assert.match(appEntrySource, /appRuntime\.runCallback\(captureAppStartupFrameEffect\(\)/)
  assert.match(appEntrySource, /startupAdmissionController\.materialChanged\(\)/)
  assert.doesNotMatch(appEntrySource, /publishAppStartupLoading|publishAppStartupFailure|Loading…/)
  assert.match(appEntrySource, /applyAppStartup\(state\.value\)/)
  assert.match(appEntrySource, /const appRuntime = getAppRuntime\(\)/)
  assert.match(appEntrySource, /appRuntime\.dispose\(\)/)
  assert.doesNotMatch(appEntrySource, /Effect\.runPromise\(/)
  assert.doesNotMatch(appEntrySource, /loadCachedDashboardStartup|addCurrentTabOutPageToStartupSnapshot/)
  assert.doesNotMatch(appStartupSource, /phase: '(?:loading|failed)'/)
  assert.match(appStartupSource, /phase: 'ready'/)
  assert.doesNotMatch(appEntrySource, /mountApp\(/)
  assert.doesNotMatch(appEntrySource, /requestDashboardRefresh\(\{ startupSnapshot: true/)
  assert.doesNotMatch(appSource, /startupRefreshRequestedRef|live-startup-refresh-requested/)
  assert.match(appSource, /useStartupOrderDebug\(\{/)
  assert.match(startupOrderDebugHookSource, /firstDashboardLayoutRecordedRef/)
  assert.match(appSource, /const \[dashboardContentVisible, setDashboardContentVisible\] = useState\(false\)/)
  assert.match(appSource, /requestAnimationFrame\(\(\) => setDashboardContentVisible\(true\)\)/)
  assert.match(appSource, /const dynamicContentVisible = dashboardContentVisible && startupReady && dashboardViewRoutingReady/)
  assert.match(appSource, /const visibleDashboard = dynamicContentVisible \? dashboard : null/)
  assert.match(appSource, /waitForInitialState: !startupReady/)
  assert.match(appSource, /startupState\?\.phase !== 'ready'/)
  assert.doesNotMatch(appSource, /data-tabout="dashboard-startup-status"|Loading…|Couldn’t load dashboard|data-tabout-part="retry-button"/)
  assert.doesNotMatch(startupControllerSource, /\bretry\(\): void|\n\s*retry\(\)/)
  assert.match(appSource, /startupPriorityWorkingSet/)
  assert.doesNotMatch(appSource, /setStartupPriorityWorkingSet|appliedStartupPriorityRef/)
  assert.doesNotMatch(appSource, /type: 'startup',[\s\S]*historyRange: startupState\.historyRange/)
  assert.match(intakeSource, /startupPriorityWorkingSet/)
  assert.match(appSource, /dashboard: visibleDashboard/)
  assert.match(appSource, /workingSet: visibleWorkingSet/)
  assert.match(appSource, /freezeTabsChipOrder: dynamicContentVisible && !!effectiveStartupPriorityWorkingSet/)
  assert.match(startupOrderDebugHookSource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'first-dashboard-layout'/)
  assert.match(appSource, /enabled: dynamicContentVisible/)
  assert.match(localStateSource, /initialState/)
  assert.doesNotMatch(localStateSource, /if \(state\.loaded\) return/)
  assert.match(localStateSource, /const localMutationVersionRef = useRef\(0\)/)
  assert.match(localStateSource, /const mutationVersion = localMutationVersionRef\.current/)
  assert.match(localStateSource, /if \(cancelled \|\| mutationVersion !== localMutationVersionRef\.current\) return/)
  assert.match(localStateSource, /if \(!ok && currentState\.loaded\) return/)
  assert.match(localStateSource, /if \(ok\) \{[\s\S]*domainPinWriter\.replacePersisted/)
  assert.doesNotMatch(refreshSource, /saveCachedDashboardStartupSnapshot/)
  assert.doesNotMatch(refreshSource, /Compatibility shims|export \{ createLatestRefreshRunner/)
  assert.doesNotMatch(intakeSource, /saveCachedDashboardStartupSnapshot/)
  assert.doesNotMatch(refreshSource, /localState\?: DashboardLocalState \| null/)
  assert.doesNotMatch(intakeSource, /localState\?: DashboardLocalState \| null/)
  assert.match(intakeSource, /export function createLatestRefreshRunner/)
  assert.match(intakeSource, /export function requestDashboardRefresh/)
  assert.match(intakeSource, /if \(requestRevision !== revision\) continue/)
  assert.match(intakeSource, /const refreshRunner = createLatestRefreshRunner/)
  assert.match(intakeSource, /await refreshRunner\.requestEffect/)
  assert.match(intakeSource, /animatedRefreshPending/)
  assert.match(intakeSource, /buildTabsDashboardStartupSnapshotEffect\(/)
  assert.match(viewModelSource, /useLayoutEffect\(\(\) => \{[\s\S]*rememberMissionOrder\(\{[\s\S]*previousOrder: previousOrderRef\.current/)
  assert.match(startupFrameSource, /captureAppStartupFrameEffect = Effect\.fn/)
  assert.match(startupFrameSource, /loadDashboardLocalStateResultEffect\(\)/)
  assert.match(startupFrameSource, /loadHistoryRangePreferenceResultEffect\(\)/)
  assert.match(startupFrameSource, /loadClosedGhostDismissalsResultEffect\(\)/)
  assert.match(startupFrameSource, /fetchDashboardStartupSnapshotEffect/)
  assert.match(startupFrameSource, /closedGhostDismissals: dismissalsResult\.value/)
  assert.match(startupFrameSource, /dashboardStartupPreviousOrder/)
  assert.match(startupFrameSource, /rebaseDashboardStartupWorkingSetPriority/)
  assert.doesNotMatch(startupControllerSource, /STARTUP_ADMISSION_QUIET_MS|quietMs|loadingVisible/)
  assert.match(startupControllerSource, /STARTUP_ADMISSION_TIMEOUT_MS = 5_000/)
  assert.match(startupControllerSource, /attempt\.deadlineAt - capturedAt/)
  assert.match(startupSnapshotSource, /export type DashboardStartupSeed =/)
  assert.doesNotMatch(startupSnapshotSource, /CachedDashboardStartup|startupViewModel/)
  assert.match(startupSnapshotSource, /DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS/)
  assert.match(renderSource, /export const buildDashboardDataFromTabsEffect = Effect\.fn/)
  assert.match(renderSource, /getAppRuntime\(\)\.runPromise\(/)
  assert.doesNotMatch(renderSource, /export async function buildDashboardDataFromTabs/)
  assert.match(startupSnapshotSource, /export const buildTabsDashboardStartupSnapshotEffect = Effect\.fn/)
  assert.doesNotMatch(startupSnapshotSource, /export async function buildTabsDashboardStartupSnapshot/)
  assert.match(startupOrderDebugTypesSource, /timings: StartupTiming\[\]/)
  assert.match(startupOrderDebugSource, /export function recordStartupTiming/)
  assert.match(startupOrderDebugSource, /durationMs/)
  assert.match(startupOrderDebugSource, /import\('\.\/startup-order-debug-heavy'\)/)
  assert.match(startupOrderDebugHeavySource, /STARTUP_ORDER_DEBUG_DURATION_MS = 3000/)
  assert.match(startupOrderDebugHeavySource, /debugWindow\.__tabOutSaveStartupOrderDebug\?\.\(\)/)
  assert.match(startupOrderDebugHeavySource, /function debugHistoryRows/)
  assert.match(startupOrderDebugHeavySource, /historyRows: debugHistoryRows\(\)/)
  assert.match(appSource, /freezeTabsChipOrder: dynamicContentVisible && !!effectiveStartupPriorityWorkingSet/)
  assert.match(viewModelSource, /freezeTabsChipOrder && source === 'tabs'/)
})

test('service worker maintains the startup snapshot on browser startup and tab events', () => {
  const backgroundSource = readFileSync(new URL('../src/extension/background.ts', import.meta.url), 'utf8')
  const serviceSource = readFileSync(new URL('../src/extension/background/startup-snapshot-service.ts', import.meta.url), 'utf8')
  const appEntrySource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
  const pageRefreshSource = readFileSync(new URL('../src/extension/dashboard-page-refresh.ts', import.meta.url), 'utf8')

  assert.match(backgroundSource, /const startupSnapshotService = backgroundRuntime\.runSync\(StartupSnapshot\)/)
  assert.match(backgroundSource, /onStartup\.addListener/)
  assert.match(backgroundSource, /startupSnapshotService\.refreshNow\(\)/)
  assert.match(backgroundSource, /startupSnapshotService\.scheduleRefresh\(\)/)
  assert.match(backgroundSource, /chromeApi\.alarms\.onAlarm\.addListener/)
  assert.match(backgroundSource, /startupSnapshotService\.promoteDurableCheckpoint\(\)/)
  assert.match(backgroundSource, /onMoved\.addListener\(scheduleStartupSnapshotRefresh\)/)
  assert.match(backgroundSource, /changeInfo\.favIconUrl !== undefined/)
  assert.match(backgroundSource, /changeInfo\.status !== undefined/)
  assert.match(backgroundSource, /chromeApi\.tabGroups\.onUpdated/)
  assert.match(serviceSource, /const computeStartupSeed = Effect\.fn/)
  assert.match(serviceSource, /yield\* saveDashboardStartupSeedEffect/)
  assert.match(serviceSource, /scheduleDurableCheckpoint/)
  assert.match(serviceSource, /yield\* loadDashboardStartupSeedResultEffect\(\)/)
  assert.match(serviceSource, /seedOpenTabsTitleHistory\(/)
  assert.match(serviceSource, /invalidateTitleRetention/)
  assert.doesNotMatch(serviceSource, /buildTabsDashboardStartupSnapshotEffect|saveCachedDashboardStartupSnapshotEffect/)
  assert.match(appEntrySource, /captureAppStartupFrameEffect\(\)/)
  assert.match(appEntrySource, /dashboardTabUpdateRefreshOptions\(changeInfo, tab\)/)
  assert.match(pageRefreshSource, /'status'/)
  assert.match(pageRefreshSource, /changeInfo\[key\] !== undefined/)
})

test('recently closed rows and dismissals stay behind startup readiness', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const appEntrySource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
  const historyPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  const startupFrameSource = readFileSync(new URL('../src/extension/startup-frame.ts', import.meta.url), 'utf8')
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')
  const closedTabsLifecycle = intakeSource.match(/const runClosedTabUpdates = [\s\S]*?\n\n  function startClosedTabUpdates/)
  const closedTabsStarter = intakeSource.match(/function startClosedTabUpdates\(\): \(\) => void \{[\s\S]*?\n  \}/)

  assert.doesNotMatch(appSource, /startClosedTabUpdates/)
  assert.match(appEntrySource, /stopClosedTabUpdates \?\?= appDashboardStore\.startClosedTabUpdates\(\)/)
  assert.match(appSource, /dismissedClosedGhosts=\{startupReady \? startupState\.closedGhostDismissals : null\}/)
  assert.doesNotMatch(historyPanelSource, /loadClosedGhostDismissalsResult/)
  assert.match(startupFrameSource, /loadClosedGhostDismissalsResultEffect\(\)/)
  assert.ok(closedTabsLifecycle)
  assert.ok(closedTabsStarter)
  assert.match(closedTabsLifecycle[0], /FiberHandle\.makeRuntime/)
  assert.match(closedTabsLifecycle[0], /Effect\.acquireRelease/)
  assert.match(closedTabsLifecycle[0], /subscribeToClosedTabChanges/)
  assert.doesNotMatch(closedTabsLifecycle[0], /void refreshClosedTabs\(\)\n\s*const unsubscribe/)
  assert.match(closedTabsStarter[0], /getAppRuntime\(\)\.runCallback\(Effect\.scoped\(runClosedTabUpdates\(\)\)\)/)
})

test('Dashboard View indicator keeps transform-based transition', () => {
  const source = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')

  assert.match(source, /transform-\[translateX\(var\(--active-tab-left\)\)_translateY\(-50%\)\]/)
  assert.match(source, /transition-\[width,transform\] duration-200 ease-swift/)
  assert.doesNotMatch(source, /source-switch-indicator[^"]*-translate-y-1\/2/)
})

test('masonry batches card height reads before position writes', () => {
  const source = readFileSync(new URL('../src/extension/layout.ts', import.meta.url), 'utf8')
  const heightRead = source.indexOf('const cardHeights = cards.map')
  const positionWrite = source.indexOf('card.style.left =')

  assert.ok(heightRead > 0)
  assert.ok(positionWrite > heightRead)
  assert.doesNotMatch(source.slice(positionWrite), /getBoundingClientRect\(\)\.height/)
})
