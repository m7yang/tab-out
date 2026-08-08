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
    idealColWidth: 340
  })
  const afterThreshold = chooseMasonryLayout(1550, {
    minColWidth: 280,
    idealColWidth: 340
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
    colWidth: 220
  })
})

test('shouldAnimateMasonryResize only changes when the column count changes', () => {
  assert.equal(shouldAnimateMasonryResize(1360, 4), false)
  assert.equal(shouldAnimateMasonryResize(1390, 4), true)
  assert.equal(shouldAnimateMasonryResize(1390, undefined), false)
})

test('filter routing updates local and bookmark results immediately while coalescing History searches', () => {
  const routingSource = readFileSync(new URL('../src/hooks/useFilterRouting.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const refreshSource = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')

  assert.match(routingSource, /const filter = filterInput/)
  assert.doesNotMatch(routingSource, /FILTER_UPDATE_DELAY_MS/)
  assert.match(routingSource, /const FILTER_SEARCH_UPDATE_DELAY_MS = 200/)
  assert.match(routingSource, /setFilterSearch\(filterInput\)/)
  assert.match(appSource, /bookmarkFilter: filter/)
  assert.match(appSource, /filter: filterSearch/)
  assert.match(refreshSource, /appDashboardStore\.hydrateBookmarkCompanion\(\)/)
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

test('domain card mission names use the heaviest title weight', () => {
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const missionNameMatch = domainCardSource.match(/mission-name[^"]*/)

  assert.ok(missionNameMatch, 'mission-name class should exist')
  assert.match(missionNameMatch[0], /\bfont-black\b/)
  assert.doesNotMatch(missionNameMatch[0], /\bfont-semibold\b/)
})

test('source switch keeps one primed card-move refresh', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')

  assert.match(appSource, /const previousRects = prepareDomainCardMoveAnimation\(currentMissionContainers\(\)\)/)
  assert.match(appSource, /pendingSourceSwitchRectsRef\.current = \{ rects: previousRects, requestId \}/)
  assert.match(appSource, /pendingRects\?\.requestId !== event\.requestId/)
  assert.match(appSource, /layoutMoveRectsRef\.current = pendingRects\.rects/)
  assert.match(intakeSource, /emitBeforeApply\(\{ reason: 'source-switch', requestId \}\)/)
  assert.doesNotMatch(appSource, /\[source,\s*pinnedDomains,\s*pinsLoaded\]/)
})

test('user-driven pinned domain order changes prime card move animation', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const localStateHookSource = readFileSync(new URL('../src/hooks/useDashboardLocalState.ts', import.meta.url), 'utf8')

  assert.match(appSource, /onBeforeApplyPinnedDomains:\s*\(\{ animate \}\) => \{[\s\S]*resetMissionOrder\(\)[\s\S]*if \(animate\) primeCardMoveAnimation\(\)/)
  assert.match(localStateHookSource, /onBeforeApplyPinnedDomainsRef\.current\?\.\(\{ animate: false \}\)/)
  assert.match(localStateHookSource, /onBeforeApplyPinnedDomainsRef\.current\?\.\(\{ animate: true \}\)/)
})

test('pin-driven dashboard refresh cancels its pending animation frame', () => {
  const source = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')
  const callbackIndex = source.indexOf('callbacksRef.current.onBeforePinnedRefresh?.()')
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

test('tabs source reserves the history column before dashboard data is ready', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const showTabHistory = source === 'tabs'/)
  assert.doesNotMatch(source, /const showTabHistory = isReady && source === 'tabs'/)
})

test('activation history panel stays visually empty when there are no rows', () => {
  const source = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /No activation history yet/)
})

test('startup frame updates dashboard and history rows atomically', () => {
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')
  const appStartupSource = readFileSync(new URL('../src/app-startup.ts', import.meta.url), 'utf8')

  assert.match(intakeSource, /type: 'startup'/)
  assert.match(intakeSource, /function appDashboardSnapshotFields/)
  assert.match(intakeSource, /closedTabs: snapshot\?\.closedTabs \?\? \[\]/)
  assert.match(intakeSource, /dashboard: snapshot\?\.dashboard \?\? null/)
  assert.match(intakeSource, /tabHistory: snapshot\?\.tabHistory \?\? null/)
  assert.match(intakeSource, /workingSet: snapshot\?\.workingSet \?\? null/)
  assert.doesNotMatch(intakeSource, /sourceFieldsUpdatedBeforeStartup/)
  assert.match(intakeSource, /case 'startup': \{[\s\S]*startupSnapshotFieldsAfterLiveUpdates/)
  assert.match(appStartupSource, /appDashboardStore\.applyStartup\(\{[\s\S]*historyRange: frame\.historyRange,[\s\S]*snapshot: frame\.snapshot,[\s\S]*source: frame\.source/)
  assert.match(intakeSource, /export const fetchDashboardStartupSnapshotEffect/)
  assert.match(intakeSource, /fetchClosedTabs/)
  assert.match(intakeSource, /buildWorkingSetSnapshot/)
  assert.match(intakeSource, /fetchDashboardServiceState/)
  assert.doesNotMatch(intakeSource, /startupSnapshotFlight/)
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
  const startupOrderDebugHeavySource = readFileSync(new URL('../src/components/startup-order-debug-heavy.ts', import.meta.url), 'utf8')
  const viewModelSource = readFileSync(new URL('../src/hooks/useDashboardViewModels.ts', import.meta.url), 'utf8')

  assert.match(appEntrySource, /setAppStartupFilterIntent\([\s\S]*readFilterFocusPendingInput\(filterInputFromSearch\(window\.location\.search\)\)/)
  assert.ok(appEntrySource.indexOf('setAppStartupFilterIntent(') < appEntrySource.indexOf('attachApp()'))
  assert.ok(appEntrySource.indexOf('attachApp()') < appEntrySource.indexOf('startupAdmissionController.start()'))
  assert.match(appEntrySource, /createStartupAdmissionController<AppStartupFrame, unknown>/)
  assert.match(appEntrySource, /appRuntime\.runCallback\(captureAppStartupFrameEffect\(\)/)
  assert.match(appEntrySource, /startupAdmissionController\.materialChanged\(\)/)
  assert.match(appEntrySource, /publishAppStartupLoading\(\)/)
  assert.match(appEntrySource, /publishAppStartupFailure/)
  assert.match(appEntrySource, /applyAppStartup\(state\.value\)/)
  assert.match(appEntrySource, /const appRuntime = getAppRuntime\(\)/)
  assert.match(appEntrySource, /appRuntime\.dispose\(\)/)
  assert.doesNotMatch(appEntrySource, /Effect\.runPromise\(/)
  assert.doesNotMatch(appEntrySource, /loadCachedDashboardStartup|addCurrentTabOutPageToStartupSnapshot/)
  assert.match(appStartupSource, /phase: 'loading'/)
  assert.match(appStartupSource, /phase: 'failed'/)
  assert.match(appStartupSource, /phase: 'ready'/)
  assert.doesNotMatch(appEntrySource, /mountApp\(/)
  assert.doesNotMatch(appEntrySource, /requestDashboardRefresh\(\{ startupSnapshot: true/)
  assert.doesNotMatch(appSource, /startupRefreshRequestedRef|live-startup-refresh-requested/)
  assert.match(appSource, /firstDashboardLayoutRecordedRef/)
  assert.match(appSource, /const \[dashboardContentVisible, setDashboardContentVisible\] = useState\(false\)/)
  assert.match(appSource, /requestAnimationFrame\(\(\) => setDashboardContentVisible\(true\)\)/)
  assert.match(appSource, /const dynamicContentVisible = dashboardContentVisible && startupReady/)
  assert.match(appSource, /const visibleDashboard = dynamicContentVisible \? dashboard : null/)
  assert.match(appSource, /waitForInitialState: !startupReady/)
  assert.match(appSource, /startupState\?\.phase !== 'ready'/)
  assert.match(appSource, /data-tabout="dashboard-startup-status"/)
  assert.match(appSource, /Couldn’t load dashboard/)
  assert.match(appSource, /data-tabout-part="retry-button"/)
  assert.match(appSource, /startupPriorityWorkingSet/)
  assert.doesNotMatch(appSource, /setStartupPriorityWorkingSet|appliedStartupPriorityRef/)
  assert.doesNotMatch(appSource, /type: 'startup',[\s\S]*historyRange: startupState\.historyRange/)
  assert.match(intakeSource, /startupPriorityWorkingSet/)
  assert.match(appSource, /dashboard: visibleDashboard/)
  assert.match(appSource, /workingSet: visibleWorkingSet/)
  assert.match(appSource, /freezeTabsChipOrder: dynamicContentVisible && !!effectiveStartupPriorityWorkingSet/)
  assert.match(appSource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'first-dashboard-layout'/)
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
  assert.match(viewModelSource, /useLayoutEffect\(\(\) => \{[\s\S]*previousOrderRef\.current\[source\]/)
  assert.match(startupFrameSource, /captureAppStartupFrameEffect = Effect\.fn/)
  assert.match(startupFrameSource, /loadDashboardLocalStateResultEffect\(\)/)
  assert.match(startupFrameSource, /loadHistoryRangePreferenceResultEffect\(\)/)
  assert.match(startupFrameSource, /loadClosedGhostDismissalsResultEffect\(\)/)
  assert.match(startupFrameSource, /fetchDashboardStartupSnapshotEffect/)
  assert.match(startupFrameSource, /closedGhostDismissals: dismissalsResult\.value/)
  assert.match(startupFrameSource, /dashboardStartupPreviousOrder/)
  assert.match(startupFrameSource, /rebaseDashboardStartupWorkingSetPriority/)
  assert.match(startupControllerSource, /STARTUP_ADMISSION_QUIET_MS = 300/)
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
  assert.match(startupOrderDebugSource, /timings: StartupTiming\[\]/)
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

test('native tab highlighting owns its serialized browser workflow behind Effect', () => {
  const source = readFileSync(new URL('../src/extension/native-tab-highlight.ts', import.meta.url), 'utf8')

  assert.match(source, /const runNativeTabHighlightRequests = Effect\.fn/)
  assert.match(source, /const reconcileNativeTabHighlight = Effect\.fn/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /yield\* BrowserTabs/)
  assert.match(source, /getAppRuntime\(\)\.runPromise\(runNativeTabHighlightRequests\(\)\)/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /async function run\(\)/)
})

test('dashboard pin transactions serialize their complete storage workflow with Effect', () => {
  const source = readFileSync(new URL('../src/extension/storage-list-mutations.ts', import.meta.url), 'utf8')

  assert.match(source, /const runStorageListMutation = Effect\.fn/)
  assert.match(source, /Semaphore\.makeUnsafe\(1\)/)
  assert.match(source, /mutationSemaphore\.withPermit/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /Schema\.TaggedErrorClass/)
  assert.match(source, /getAppRuntime\(\)\.runPromise/)
  assert.match(source, /runPromiseExclusiveEffect/)
  assert.doesNotMatch(source, /runExclusive\(\(\) => getAppRuntime\(\)\.runPromise/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /let mutationQueue = Promise\.resolve\(\)/)
})

test('Saved Pages serializes each read-modify-write transaction with Effect', () => {
  const source = readFileSync(new URL('../src/extension/saved-pages-mutations.ts', import.meta.url), 'utf8')
  const sharedSource = readFileSync(new URL('../src/extension/saved-pages.ts', import.meta.url), 'utf8')
  const storageSource = readFileSync(new URL('../src/extension/saved-pages-storage.ts', import.meta.url), 'utf8')
  const sharedRenderSource = readFileSync(new URL('../src/extension/render.ts', import.meta.url), 'utf8')

  assert.match(source, /const runSavedPagesMutation = Effect\.fn/)
  assert.match(source, /const persistMetadataUpdatesEffect = Effect\.fn/)
  assert.match(source, /export function mutateSavedPagesStoreEffect/)
  assert.match(source, /export function persistSavedPageMetadataUpdatesEffect/)
  assert.match(source, /Semaphore\.makeUnsafe\(1\)/)
  assert.match(source, /mutationSemaphore\.withPermit/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /Schema\.TaggedErrorClass/)
  assert.match(source, /getAppRuntime\(\)\.runPromise/)
  assert.match(source, /runPromiseExclusiveEffect/)
  assert.doesNotMatch(source, /runExclusive\(\(\) => getAppRuntime\(\)\.runPromise/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /let mutationQueue = Promise\.resolve\(\)/)
  assert.doesNotMatch(sharedSource, /from 'effect'/)
  assert.match(storageSource, /Schema\.Struct/)
  assert.match(storageSource, /loadSavedPagesStoreResultEffect = Effect\.fn/)
  assert.match(storageSource, /getAppRuntime\(\)\.runPromise\(loadSavedPagesStoreResultEffect\(\)\)/)
  assert.doesNotMatch(storageSource, /export async function loadSavedPagesStore/)
  assert.doesNotMatch(sharedRenderSource, /saved-pages-mutations/)
})

test('startup state reads compose directly in the shared Effect runtimes', () => {
  const localStateSource = readFileSync(new URL('../src/extension/dashboard-local-state.ts', import.meta.url), 'utf8')
  const closedTabsSource = readFileSync(new URL('../src/extension/closed-tabs.ts', import.meta.url), 'utf8')
  const startupFrameSource = readFileSync(new URL('../src/extension/startup-frame.ts', import.meta.url), 'utf8')
  const startupServiceSource = readFileSync(new URL('../src/extension/background/startup-snapshot-service.ts', import.meta.url), 'utf8')

  assert.match(localStateSource, /loadDashboardLocalStateResultEffect = Effect\.fn/)
  assert.match(localStateSource, /getAppRuntime\(\)\.runPromise\(loadDashboardLocalStateResultEffect\(\)\)/)
  assert.doesNotMatch(localStateSource, /export async function loadDashboardLocalState/)
  assert.match(closedTabsSource, /fetchClosedTabsResultEffect = Effect\.fn/)
  assert.match(closedTabsSource, /const browserTabs = yield\* BrowserTabs/)
  assert.match(closedTabsSource, /getAppRuntime\(\)\.runPromise\(fetchClosedTabsResultEffect\(\)\)/)
  assert.doesNotMatch(closedTabsSource, /export async function fetchClosedTabsResult/)
  assert.match(startupFrameSource, /yield\* Effect\.all\(\[/)
  assert.match(startupFrameSource, /loadDashboardLocalStateResultEffect\(\)/)
  assert.match(startupFrameSource, /loadHistoryRangePreferenceResultEffect\(\)/)
  assert.match(startupFrameSource, /loadClosedGhostDismissalsResultEffect\(\)/)
  assert.match(startupServiceSource, /yield\* Effect\.all\(\[/)
  assert.match(startupServiceSource, /loadSavedPagesStoreResultEffect\(\)/)
  assert.doesNotMatch(startupServiceSource, /loadDashboardLocalStateResultEffect|fetchClosedTabsResultEffect/)
  assert.doesNotMatch(startupServiceSource, /Promise\.all/)
})

test('History range keeps Effect Schema behind its storage boundary', () => {
  const sharedSource = readFileSync(new URL('../src/extension/history-range.ts', import.meta.url), 'utf8')
  const storageSource = readFileSync(new URL('../src/extension/history-range-storage.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(sharedSource, /from 'effect'/)
  assert.match(storageSource, /Schema\.Literals/)
  assert.match(storageSource, /HistoryRangePreferenceError extends Schema\.TaggedErrorClass/)
  assert.match(storageSource, /runPromiseExclusiveEffect/)
  assert.match(storageSource, /loadHistoryRangePreferenceResultEffect = Effect\.fn/)
  assert.match(storageSource, /loadHistoryRangePreferenceEffect = Effect\.fn/)
  assert.match(appSource, /captureAppStartupFrameEffect\(\)/)
  assert.doesNotMatch(appSource, /try: \(\) => loadHistoryRangePreference\(\)/)
})

test('closed-history dismissals serialize their complete storage transaction with Effect', () => {
  const source = readFileSync(new URL('../src/extension/closed-ghost-dismissals.ts', import.meta.url), 'utf8')

  assert.match(source, /const runClosedGhostDismissalMutation = Effect\.fn/)
  assert.match(source, /Semaphore\.makeUnsafe\(1\)/)
  assert.match(source, /mutationSemaphore\.withPermit/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /Schema\.TaggedErrorClass/)
  assert.match(source, /getAppRuntime\(\)\.runPromise/)
  assert.match(source, /runPromiseExclusiveEffect/)
  assert.doesNotMatch(source, /runExclusive\(\(\) => getAppRuntime\(\)\.runPromise/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /let mutationQueue = Promise\.resolve\(\)/)
})

test('background Tab History serializes complete browser and persistence tasks with Effect', () => {
  const source = readFileSync(new URL('../src/extension/background/tab-history-service.ts', import.meta.url), 'utf8')

  assert.match(source, /Layer\.effect\(TabHistory/)
  assert.match(source, /makeTabHistoryEffectService = Effect\.fn/)
  assert.match(source, /const tabHistoryCache = yield\* Ref\.make/)
  assert.match(source, /const runTabHistoryMutation = Effect\.fn/)
  assert.match(source, /serialize\(service\.getTabHistorySnapshot/)
  assert.match(source, /Deferred\.makeUnsafe<void>\(\)/)
  assert.match(source, /Deferred\.await\(previous\)/)
  assert.match(source, /Effect\.ensuring\(Deferred\.succeed/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /Schema\.TaggedErrorClass/)
  assert.doesNotMatch(source, /makeTabHistoryPromiseService/)
  assert.doesNotMatch(source, /const runTask = Effect\.fn/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /let tabHistoryQueue: Promise<void> = Promise\.resolve\(\)/)
})

test('background Working Set serializes complete activity transactions with Effect', () => {
  const source = readFileSync(new URL('../src/extension/background/working-set-service.ts', import.meta.url), 'utf8')

  assert.match(source, /const runActivityMutation = Effect\.fn/)
  assert.match(source, /Layer\.effect\(WorkingSet/)
  assert.match(source, /Queue\.unbounded<Effect\.Effect<void>>/)
  assert.match(source, /const drainActivityTasks = Effect\.fn/)
  assert.match(source, /Queue\.offerUnsafe/)
  assert.match(source, /Deferred\.complete/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /Schema\.TaggedErrorClass/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /let activityQueue: Promise<void> = Promise\.resolve\(\)/)
})

test('startup seed cache serializes its complete shared-lock transaction with Effect', () => {
  const source = readFileSync(new URL('../src/extension/startup-snapshot.ts', import.meta.url), 'utf8')

  assert.match(source, /const runStartupSeedCacheMutation = Effect\.fn/)
  assert.match(source, /Semaphore\.makeUnsafe\(1\)/)
  assert.match(source, /startupSeedCacheMutationSemaphore\.withPermit/)
  assert.match(source, /runPromiseExclusiveEffect/)
  assert.match(source, /navigator\.locks\.request/)
  assert.match(source, /loadDashboardStartupSeedResultEffect = Effect\.fn/)
  assert.match(source, /saveDashboardStartupSeedEffect = Effect\.fn/)
  assert.match(source, /promoteDashboardStartupSeedEffect = Effect\.fn/)
  assert.match(source, /Effect\.tryPromise/)
  assert.doesNotMatch(source, /createSerializedEffectQueue/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /let startupSeedCacheMutationQueue: Promise<void> = Promise\.resolve\(\)/)
})

test('background badge owns its latest-wins browser workflow behind Effect', () => {
  const source = readFileSync(new URL('../src/extension/background/badge.ts', import.meta.url), 'utf8')

  assert.match(source, /const runBadgeRefreshLoop = Effect\.fn/)
  assert.match(source, /const applyBadgePresentation = Effect\.fn/)
  assert.match(source, /Effect\.tryPromise/)
  assert.match(source, /Layer\.effect\(Badge/)
  assert.match(source, /Effect\.forkIn\(scope, \{ startImmediately: true \}\)/)
  assert.match(source, /Ref\.modify\(state/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /async function runRefreshLoop\(\)/)
})

test('background entrypoints share one ManagedRuntime for Effect services', () => {
  const runtimeSource = readFileSync(new URL('../src/extension/background/runtime.ts', import.meta.url), 'utf8')
  const backgroundSource = readFileSync(new URL('../src/extension/background.ts', import.meta.url), 'utf8')
  const browserWindowSource = readFileSync(
    new URL('../src/extension/background/browser-window.ts', import.meta.url),
    'utf8'
  )
  const filterCommandSource = readFileSync(
    new URL('../src/extension/background/filter-command.ts', import.meta.url),
    'utf8'
  )
  const newTabCommandSource = readFileSync(
    new URL('../src/extension/background/new-tab-command.ts', import.meta.url),
    'utf8'
  )

  assert.match(runtimeSource, /ManagedRuntime\.make/)
  assert.match(runtimeSource, /BrowserTabs\.layer\(\)/)
  assert.match(runtimeSource, /Badge\.layer\(chromeApi\)/)
  assert.match(runtimeSource, /NativePlacementBridge\.layer\(chromeApi\)/)
  assert.match(runtimeSource, /TabHistory\.layer\(chromeApi\)/)
  assert.match(runtimeSource, /WorkingSet\.layer\(chromeApi\)/)
  assert.match(runtimeSource, /StartupSnapshot\.layer\(/)
  assert.match(runtimeSource, /Layer\.provideMerge\(coreServices\)/)
  assert.match(runtimeSource, /runtime\.runSync\(Effect\.void\)/)
  assert.match(runtimeSource, /captureDashboardServiceStateEffect = Effect\.gen/)
  assert.match(runtimeSource, /workingSet\.getWorkingSetActivity\(\)/)
  assert.match(backgroundSource, /const backgroundRuntime = createBackgroundRuntime\(chromeApi\)/)
  assert.match(backgroundSource, /settleBackgroundEffect\(refreshBadgeEffect\)/)
  assert.match(backgroundSource, /const handleActionClick = Effect\.fn/)
  assert.match(backgroundSource, /yield\* closeDuplicateTabsEffect/)
  assert.match(backgroundSource, /sendEffectResponse\(/)
  assert.match(backgroundSource, /Effect\.all\(\[/)
  assert.match(backgroundSource, /const workingSetService = backgroundRuntime\.runSync\(WorkingSet\.WorkingSet\)/)
  assert.match(browserWindowSource, /createActiveTabInNormalWindowEffect = Effect\.fn/)
  assert.match(filterCommandSource, /openFilterTabEffect = Effect\.fn/)
  assert.match(newTabCommandSource, /openNewTabEffect = Effect\.fn/)
  assert.match(backgroundSource, /settleBackgroundEffect\(openFilterTabEffect\(chromeApi\)\)/)
  assert.match(backgroundSource, /settleBackgroundEffect\(openNewTabEffect\(chromeApi\)\)/)
  assert.doesNotMatch(backgroundSource, /settleBackgroundTask/)
  assert.doesNotMatch(backgroundSource, /Effect\.promise/)
  assert.doesNotMatch(backgroundSource, /Promise\.all/)
  assert.doesNotMatch(backgroundSource, /void \(async \(\) =>/)
  for (const source of [browserWindowSource, filterCommandSource, newTabCommandSource]) {
    assert.doesNotMatch(source, /async function/)
    assert.doesNotMatch(source, /Effect\.runPromise/)
  }
})

test('app entrypoints share one ManagedRuntime for browser services', () => {
  const runtimeSource = readFileSync(new URL('../src/extension/app-runtime.ts', import.meta.url), 'utf8')
  const browserTabsSource = readFileSync(new URL('../src/extension/browser-tabs-service.ts', import.meta.url), 'utf8')
  const watchdogSource = readFileSync(
    new URL('../src/extension/closed-tab-restore-watchdogs.ts', import.meta.url),
    'utf8'
  )
  const closedTabsSource = readFileSync(new URL('../src/extension/closed-tabs.ts', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')

  assert.match(runtimeSource, /ManagedRuntime\.make\(Layer\.mergeAll\(/)
  assert.match(runtimeSource, /BrowserTabs\.layer\(\)/)
  assert.match(runtimeSource, /ClosedTabRestoreWatchdogs\.layer/)
  assert.match(runtimeSource, /sharedAppRuntime \?\?= createAppRuntime\(\)/)
  assert.match(runtimeSource, /runtime\.runSync\(Effect\.void\)/)
  assert.match(browserTabsSource, /Context\.Service<BrowserTabs/)
  assert.match(browserTabsSource, /Layer\.succeed\(BrowserTabs/)
  assert.match(watchdogSource, /FiberMap\.make<string, void, never>\(\)/)
  assert.match(watchdogSource, /Effect\.sleep\(delayMs\)/)
  assert.match(closedTabsSource, /getAppRuntime\(\)\.runSync\(applyRemoteRestoreStateEffect\(message\)\)/)
  assert.doesNotMatch(closedTabsSource, /remoteRestoreWatchdogTimers/)
  assert.doesNotMatch(closedTabsSource, /setTimeout/)
  assert.doesNotMatch(closedTabsSource, /clearTimeout/)
  assert.match(appSource, /appRuntime\.runCallback\(captureAppStartupFrameEffect\(\)/)
  assert.doesNotMatch(appSource, /Effect\.runPromise\(/)
})

test('tab activation composes focus, move, and open workflows in the shared Effect runtimes', () => {
  const focusSource = readFileSync(new URL('../src/extension/tab-focus.ts', import.meta.url), 'utf8')
  const moveSource = readFileSync(new URL('../src/extension/tab-move.ts', import.meta.url), 'utf8')
  const activationSource = readFileSync(new URL('../src/extension/tab-activation.ts', import.meta.url), 'utf8')
  const tabsSource = readFileSync(new URL('../src/extension/tabs.ts', import.meta.url), 'utf8')
  const historyServiceSource = readFileSync(
    new URL('../src/extension/background/tab-history-service.ts', import.meta.url),
    'utf8'
  )

  assert.match(focusSource, /focusExistingTabTargetEffect = Effect\.fn/)
  assert.match(moveSource, /moveTabToCurrentWindowEffect = Effect\.fn/)
  assert.match(moveSource, /yield\* focusResolvedTabTargetEffect/)
  assert.match(activationSource, /performDashboardItemActivationEffect = Effect\.fn/)
  assert.match(tabsSource, /focusExactTabOrOpenEffect = Effect\.fn/)
  assert.match(tabsSource, /openTabUrlEffect = Effect\.fn/)
  assert.match(historyServiceSource, /Effect\.provideService\(BrowserTabs, browserTabs\)/)
  assert.match(historyServiceSource, /serialize\(switchTabHistory\(direction\)\)/)
  for (const source of [focusSource, moveSource, activationSource, tabsSource]) {
    assert.doesNotMatch(source, /Effect\.runPromise\(/)
  }
})

test('tab mutation actions preserve revalidation and partial results inside Effect workflows', () => {
  const tabsSource = readFileSync(new URL('../src/extension/tabs.ts', import.meta.url), 'utf8')
  const actionsSource = readFileSync(new URL('../src/extension/tab-actions.ts', import.meta.url), 'utf8')
  const historySource = readFileSync(new URL('../src/extension/tab-history.ts', import.meta.url), 'utf8')

  assert.match(tabsSource, /closeResolvedTabsEffect = Effect\.fn/)
  assert.match(tabsSource, /beforeSingleRemove: async/)
  assert.match(tabsSource, /closeTabsByTargetsEffect = Effect\.fn/)
  assert.match(tabsSource, /closeDuplicateTabsEffect = Effect\.fn/)
  assert.match(actionsSource, /TabActionWorkflowError extends Schema\.TaggedErrorClass/)
  assert.match(actionsSource, /const finishTabCloseAction = Effect\.fn/)
  assert.match(actionsSource, /const runCloseChipTarget = Effect\.fn/)
  assert.match(actionsSource, /const applySuspendToTabsEffect = Effect\.fn/)
  assert.match(actionsSource, /const revalidateMutationTarget = Effect\.fn/)
  assert.match(actionsSource, /getAppRuntime\(\)\.runPromise/)
  assert.doesNotMatch(actionsSource, /browser-tabs-gateway/)
  assert.doesNotMatch(actionsSource, /Effect\.runPromise\(/)
  assert.match(historySource, /closeHistoryEntryEffect = Effect\.fn/)
  assert.match(historySource, /yield\* closeResolvedTabsEffect/)
  assert.doesNotMatch(historySource, /Effect\.runPromise\(/)
})

test('open-tab snapshots compose browser reads and suspender persistence in Effect', () => {
  const tabsSource = readFileSync(new URL('../src/extension/tabs.ts', import.meta.url), 'utf8')
  const groupsSource = readFileSync(new URL('../src/extension/groups.ts', import.meta.url), 'utf8')
  const suspensionSource = readFileSync(new URL('../src/extension/suspension.ts', import.meta.url), 'utf8')
  const startupSource = readFileSync(
    new URL('../src/extension/background/startup-snapshot-service.ts', import.meta.url),
    'utf8'
  )

  assert.match(tabsSource, /fetchOpenTabsSnapshotEffect = Effect\.fn/)
  assert.match(tabsSource, /yield\* rememberSuspendTargetFromTabsEffect/)
  assert.doesNotMatch(tabsSource, /queryAllTabsResult, getAllWindowsResult/)
  assert.match(groupsSource, /fetchTabGroupColorsEffect = Effect\.fn/)
  assert.match(suspensionSource, /SuspendTargetStoreError extends Schema\.TaggedErrorClass/)
  assert.match(suspensionSource, /runPromiseExclusiveEffect/)
  assert.match(suspensionSource, /getSuspendTargetEffect = Effect\.fn/)
  assert.match(startupSource, /yield\* fetchOpenTabsSnapshotEffect/)
  assert.doesNotMatch(startupSource, /try: \(\) => fetchOpenTabsSnapshotResult/)
})

test('startup seed service owns its rebuild flight and scheduler behind Effect', () => {
  const source = readFileSync(new URL('../src/extension/background/startup-snapshot-service.ts', import.meta.url), 'utf8')

  assert.match(source, /const computeStartupSeed = Effect\.fn/)
  assert.match(source, /const runStartupSnapshotRefresh = Effect\.fn/)
  assert.match(source, /yield\* Effect\.all\(\[/)
  assert.match(source, /yield\* saveDashboardStartupSeedEffect/)
  assert.match(source, /buildDomainGroups/)
  assert.match(source, /Layer\.effect\(StartupSnapshot/)
  assert.match(source, /Ref\.make<Deferred\.Deferred<void> \| null>/)
  assert.match(source, /FiberHandle\.make<void, never>\(\)/)
  assert.match(source, /FiberSet\.makeRuntime<never, void, never>\(\)/)
  assert.match(source, /Effect\.sleep\(STARTUP_SNAPSHOT_DEBOUNCE_MS\)/)
  assert.match(source, /Effect\.forkIn\(scope, \{ startImmediately: true \}\)/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /Effect\.runSync/)
  assert.doesNotMatch(source, /setTimeout/)
  assert.doesNotMatch(source, /clearTimeout/)
  assert.doesNotMatch(source, /async function compute\(\)/)
})

test('closed-tab restore owns suppression cleanup through an Effect bracket', () => {
  const source = readFileSync(new URL('../src/extension/closed-tabs.ts', import.meta.url), 'utf8')
  const actionSource = readFileSync(new URL('../src/extension/closed-tab-actions.ts', import.meta.url), 'utf8')

  assert.match(source, /export function restoreClosedTabEffect/)
  assert.match(source, /Effect\.acquireUseRelease/)
  assert.match(actionSource, /yield\* BrowserTabs/)
  assert.match(actionSource, /getAppRuntime\(\)\.runPromise\(runRestoreClosedTab\(sessionId\)\)/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(actionSource, /Effect\.runPromise/)
})

test('Undo owns sequential partial restore and restoring cleanup behind Effect', () => {
  const source = readFileSync(new URL('../src/extension/undo.ts', import.meta.url), 'utf8')

  assert.match(source, /const runUndoClosure = Effect\.fn/)
  assert.match(source, /const restoreSnapshotTab = Effect\.fn/)
  assert.match(source, /Effect\.acquireUseRelease/)
  assert.match(source, /yield\* BrowserTabs/)
  assert.match(source, /getAppRuntime\(\)\.runPromise\(runUndoClosure\(closure\)\)/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /browser-tabs-gateway/)
  assert.doesNotMatch(source, /async function undoClosure\(/)
})

test('Saved Page actions own mutation, refresh, and Undo failure branches behind Effect', () => {
  const source = readFileSync(new URL('../src/extension/saved-page-actions.ts', import.meta.url), 'utf8')
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')
  const dataFetchSource = readFileSync(new URL('../src/extension/dashboard-data-fetch.ts', import.meta.url), 'utf8')

  assert.match(source, /const runSavePageTarget = Effect\.fn/)
  assert.match(source, /const runRemoveSavedPageTarget = Effect\.fn/)
  assert.match(source, /const runRestoreSavedPage = Effect\.fn/)
  assert.match(source, /mutateEffect: mutateSavedPagesStoreEffect/)
  assert.match(source, /return mutateEffect\(mutation\)\.pipe/)
  assert.match(source, /Effect\.result\(Effect\.tryPromise/)
  assert.match(source, /Schema\.TaggedErrorClass/)
  assert.match(source, /getAppRuntime\(\)\.runPromise\(runSavePageTarget\(target\)\)/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /async function savePageTarget\(/)
  for (const fetchSource of [intakeSource, dataFetchSource]) {
    assert.match(fetchSource, /persistSavedPageMetadataUpdatesEffect\(/)
    assert.match(fetchSource, /Effect\.forkDetach\(\{ startImmediately: true \}\)/)
    assert.doesNotMatch(fetchSource, /void persistSavedPageMetadataUpdates\(/)
  }
})

test('page startup frame runs one fresh interruptible Effect capture', () => {
  const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
  const frameSource = readFileSync(new URL('../src/extension/startup-frame.ts', import.meta.url), 'utf8')
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')

  assert.match(frameSource, /captureAppStartupFrameEffect = Effect\.fn/)
  assert.match(frameSource, /yield\* fetchDashboardStartupSnapshotEffect/)
  assert.match(appSource, /appRuntime\.runCallback\(captureAppStartupFrameEffect\(\)/)
  assert.match(appSource, /return \{ cancel: \(\) => interrupt\(\) \}/)
  assert.match(intakeSource, /export const fetchDashboardStartupSnapshotEffect = fetchDashboardStartupSnapshotOnceEffect/)
  assert.doesNotMatch(intakeSource, /startupSnapshotFlight|runDashboardStartupSnapshot/)
  assert.doesNotMatch(frameSource, /Effect\.runPromise/)
})

test('dashboard intake collects browser and source state in one Effect workflow', () => {
  const intakeSource = readFileSync(new URL('../src/extension/dashboard-intake.ts', import.meta.url), 'utf8')
  const dataFetchSource = readFileSync(new URL('../src/extension/dashboard-data-fetch.ts', import.meta.url), 'utf8')
  const serviceStateSource = readFileSync(new URL('../src/extension/dashboard-service-state.ts', import.meta.url), 'utf8')
  const renderSource = readFileSync(new URL('../src/extension/render.ts', import.meta.url), 'utf8')

  assert.match(intakeSource, /export const fetchDashboardSnapshotEffect = Effect\.fn/)
  assert.match(intakeSource, /const fetchDashboardStartupSnapshotOnceEffect = Effect\.fn/)
  assert.match(intakeSource, /yield\* Effect\.all\(\[/)
  assert.match(intakeSource, /fetchDashboardServiceStateResultEffect\(\)/)
  assert.match(intakeSource, /getCurrentWindowIdResultEffect\(\)/)
  assert.match(intakeSource, /fetchOpenTabsSnapshotEffect\(/)
  assert.match(intakeSource, /loadSavedPagesStoreResultEffect\(\)/)
  assert.match(intakeSource, /fetchClosedTabsResultEffect\(\)/)
  assert.match(intakeSource, /fetchLatestClosedTabsEffect\(\)/)
  assert.match(intakeSource, /requestEffect: <Failure>/)
  assert.match(intakeSource, /fetchSourceSwitchSnapshotEffect\(snapshotOptions\)/)
  assert.match(intakeSource, /await refreshRunner\.requestEffect\(\s*fetchRefreshSnapshot,/)
  assert.doesNotMatch(intakeSource, /async function fetchTabsDashboardSnapshot/)
  assert.doesNotMatch(intakeSource, /export async function fetchDashboardSnapshot/)
  assert.doesNotMatch(intakeSource, /Promise\.all\(/)
  assert.match(dataFetchSource, /export const fetchDashboardDataEffect = Effect\.fn/)
  assert.match(serviceStateSource, /export const fetchDashboardServiceStateResultEffect = Effect\.fn/)
  assert.match(renderSource, /export const getCurrentWindowIdResultEffect = Effect\.fn/)
})

test('native placement requests own validation and browser operations behind Effect', () => {
  const source = readFileSync(new URL('../src/extension/background/native-placement-bridge.ts', import.meta.url), 'utf8')

  assert.match(source, /export const handleNativePlacementBridgeMessageEffect = Effect\.fn/)
  assert.match(source, /Effect\.result\(Effect\.tryPromise/)
  assert.doesNotMatch(source, /Effect\.runPromise/)
  assert.doesNotMatch(source, /Effect\.runSync/)
  assert.match(source, /Layer\.effect\(NativePlacementBridge/)
  assert.match(source, /Queue\.unbounded<unknown>/)
  assert.match(source, /Queue\.offerUnsafe\(messages, message\)/)
  assert.match(source, /Effect\.callback<void>/)
  assert.match(source, /Effect\.sleep\(delay\)/)
  assert.match(source, /Effect\.forkIn\(scope, \{ startImmediately: true \}\)/)
  assert.doesNotMatch(source, /setTimeout\(/)
})

test('source switch indicator keeps transform-based transition', () => {
  const source = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')

  assert.match(source, /transform-\[translateX\(var\(--active-tab-left\)\)_translateY\(-50%\)\]/)
  assert.match(source, /transition-\[width,transform\] duration-200 ease-swift/)
  assert.doesNotMatch(source, /source-switch-indicator[^"]*-translate-y-1\/2/)
})

test('header controls share one size and corner radius contract', () => {
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const headerBarSource = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')
  const historyRangeSelectSource = readFileSync(new URL('../src/components/HistoryRangeSelect.tsx', import.meta.url), 'utf8')
  const headerStatsSource = readFileSync(new URL('../src/components/HeaderStats.tsx', import.meta.url), 'utf8')
  const selectSource = readFileSync(new URL('../src/components/ui/select.tsx', import.meta.url), 'utf8')
  const tabFilterWrapClass = headerBarSource.match(/"tab-filter-wrap [^"]+"/)?.[0]
  const tabFilterClass = headerBarSource.match(/'tab-filter [^']+'/)?.[0]

  assert.ok(tabFilterWrapClass)
  assert.ok(tabFilterClass)
  assert.match(baseCss, /--header-control-height: 34px/)
  assert.match(baseCss, /--header-control-radius: 16px/)
  assert.match(baseCss, /--header-control-font-size: 13px/)
  assert.match(baseCss, /--header-control-line-height: 16px/)
  assert.match(headerBarSource, /source-switch-root[^"]*h-\(--header-control-height\)[^"]*rounded-\(--header-control-radius\)/)
  assert.match(headerBarSource, /source-switch-option[^"]*text-\(length:--header-control-font-size\)[^"]*leading-\(--header-control-line-height\)/)
  assert.match(headerBarSource, /source-switch-option[^"]*before:rounded-\[calc\(var\(--header-control-radius\)-6px\)\]/)
  assert.match(headerBarSource, /source-switch-indicator[^"]*rounded-\[calc\(var\(--header-control-radius\)-6px\)\]/)
  assert.match(historyRangeSelectSource, /<SelectTrigger[\s\S]*?className="[^"]*h-\(--header-control-height\)[^"]*rounded-\(--header-control-radius\)[^"]*bg-tab-card[^"]*text-\(length:--header-control-font-size\)[^"]*leading-\(--header-control-line-height\)/)
  assert.doesNotMatch(historyRangeSelectSource, /<SelectTrigger\s+className="[^"]*bg-\[rgba\(115,115,115,0\.06\)\]/)
  assert.match(historyRangeSelectSource, /<SelectContent[\s\S]*align="start"[\s\S]*className="[^"]*rounded-\(--header-control-radius\)/)
  assert.doesNotMatch(historyRangeSelectSource, /alignItemWithTrigger=\{false\}/)
  assert.match(historyRangeSelectSource, /<SelectItem[\s\S]*className="[^"]*rounded-\[calc\(var\(--header-control-radius\)-6px\)\][^"]*text-\(length:--header-control-font-size\)[^"]*leading-\(--header-control-line-height\)/)
  assert.doesNotMatch(historyRangeSelectSource, /aria-selected:bg-accent|aria-selected:text-accent-foreground/)
  for (const token of ['isolate', 'before:z-0', 'before:border-input', 'before:drop-shadow-xs', 'before:[corner-shape:squircle]', 'after:z-0', 'after:border-blue-500', 'after:opacity-0', 'after:drop-shadow-md', 'after:drop-shadow-blue-500/50', 'after:transition-opacity', 'after:duration-150', 'after:[corner-shape:squircle]', '[&:has(input:focus-visible)::after]:opacity-100']) {
    assert.ok(tabFilterWrapClass.includes(token), token)
  }
  assert.doesNotMatch(tabFilterWrapClass, /transition-\[filter|focus-visible\)::before/)
  assert.doesNotMatch(headerBarSource, /filterFocusHandoffPending|filterFocusRequest|autoFocus=/)
  assert.doesNotMatch(tabFilterWrapClass, /ring-/)
  assert.ok(!tabFilterWrapClass.includes(']:shadow-['))
  for (const token of ['relative', 'z-1', 'h-(--header-control-height)', 'rounded-(--header-control-radius)', 'text-(length:--header-control-font-size)', 'leading-(--header-control-line-height)', 'caret-blue-500', 'shadow-none', '[corner-shape:squircle]']) {
    assert.ok(tabFilterClass.includes(token), token)
  }
  assert.doesNotMatch(tabFilterClass, /drop-shadow/)
  assert.doesNotMatch(tabFilterClass, /focus-visible:(?:border|ring)/)
  assert.match(headerBarSource, /border border-transparent bg-transparent/)
  assert.match(headerBarSource, /data-tabout-part="clear-button"[\s\S]*?onPointerDown=\{\(event\) => event\.preventDefault\(\)\}[\s\S]*?onClick=\{onClear\}/)
  assert.doesNotMatch(tabFilterClass, /md:!text|md:!leading/)
  assert.doesNotMatch(tabFilterClass, /rounded-\[12px\]/)
  assert.match(headerStatsSource, /action-btn[^"]*h-\(--header-control-height\)[^"]*rounded-\(--header-control-radius\)/)
  assert.doesNotMatch(headerBarSource, /<SelectTrigger\s+size="header"|<SelectContent\s+size="header"/)
  assert.doesNotMatch(selectSource, /data-\[size=header\]|in-data-\[size=header\]|SelectPrimitive\.Popup[\s\S]*data-size=\{size\}|SelectPrimitive\.List[\s\S]*data-size=\{size\}/)
  assert.doesNotMatch(headerBarSource, /source-switch-root[^"]*rounded-\[16px\]|source-switch-(?:option|indicator)[^"]*_-_[457]px/)
  assert.doesNotMatch(headerStatsSource, /action-btn[^"]*rounded-\[10px\]/)
})

test('masonry resize observer rebinds after conditional mission grids mount', () => {
  const source = readFileSync(new URL('../src/extension/layout.ts', import.meta.url), 'utf8')

  assert.match(source, /useLayoutEffect\(\(\) => \{/)
  assert.match(source, /observer\.observe\(container\)/)
  assert.match(source, /if \(!targetsChanged\) return/)
  assert.doesNotMatch(source, /\},\s*containerRefs\.map\(\(ref\) => ref\.current\)\s*\)/)
})

test('masonry batches card height reads before position writes', () => {
  const source = readFileSync(new URL('../src/extension/layout.ts', import.meta.url), 'utf8')
  const heightRead = source.indexOf('const cardHeights = cards.map')
  const positionWrite = source.indexOf("card.style.left =")

  assert.ok(heightRead > 0)
  assert.ok(positionWrite > heightRead)
  assert.doesNotMatch(source.slice(positionWrite), /getBoundingClientRect\(\)\.height/)
})

test('dashboard edge gutters are owned by panes instead of the shell', () => {
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  // .dashboard-shell / .dashboard-main own-box layout lives as inline Tailwind
  // utilities in App.tsx; the class names survive in base.css only as selector
  // anchors. These assertions follow the layout to its new home.
  const shellClass = appSource.match(/'dashboard-shell([^']*)'/)
  const shellHistoryBranch = appSource.match(/\?\s*'has-history([^']*)'/)
  const shellPlainBranch = appSource.match(/:\s*'grid-cols-\[minmax\(0,1fr\)\]'/)
  const mainClass = appSource.match(/'dashboard-main([^']*)'/)
  const mainHistoryBranch = appSource.match(/\?\s*'col-2([^']*)'/)
  const mainPlainBranch = appSource.match(/:\s*'col-1([^']*)'/)

  assert.ok(shellClass)
  assert.ok(shellHistoryBranch)
  assert.ok(shellPlainBranch)
  assert.ok(mainClass)
  assert.ok(mainHistoryBranch)
  assert.ok(mainPlainBranch)
  const shellClasses = shellClass[1]
  const shellHistoryClasses = shellHistoryBranch[1]
  const mainHistoryClasses = mainHistoryBranch[1]
  const mainPlainClasses = mainPlainBranch[1]
  assert.ok(shellClasses)
  assert.ok(shellHistoryClasses)
  assert.ok(mainHistoryClasses)
  assert.ok(mainPlainClasses)

  assert.match(baseCss, /--dashboard-history-edge-gutter:\s*12px;/)

  // Edge gutters are NOT on the shell.
  assert.doesNotMatch(shellClasses, /\bp[xlr]?-/)

  // The page gutter padding is owned by the main pane (default and has-history).
  assert.match(mainPlainClasses, /px-\(--dashboard-page-gutter\)/)
  assert.match(mainHistoryClasses, /\bpl-0\b/)
  assert.match(mainHistoryClasses, /pr-\(--dashboard-page-gutter\)/)

  // has-history shell is a two-column grid sized off the history edge gutter.
  assert.match(
    shellHistoryClasses,
    /grid-cols-\[minmax\(calc\(220px\+var\(--dashboard-history-edge-gutter\)\),calc\(260px\+var\(--dashboard-history-edge-gutter\)\)\)_minmax\(0,1fr\)\]/
  )

  // The history panel keeps its own edge gutter, never the page gutter.
  assert.doesNotMatch(tabHistoryPanelSource, /pl-\(--dashboard-page-gutter\)/)
  assert.match(tabHistoryPanelSource, /className="[^"]*tab-history-panel[^"]*pl-\(--dashboard-history-edge-gutter\)/)
})
