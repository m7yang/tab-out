import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

const repositoryRoot = join(import.meta.dirname, '..')
const sourceRoot = join(repositoryRoot, 'src')

function productionTypeScriptFiles(): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: sourceRoot })
    .map((file) => join(sourceRoot, file))
    .sort()
}

function readProductionSource(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8')
}

function sourceWithoutLayout(source: string): string {
  return source.replace(/\s+/g, '').replace(/,(?=[)}\]])/g, '')
}

test('production Effects cross the runtime boundary only through the shared app and worker runtimes', () => {
  const sources = productionTypeScriptFiles().map((path) => ({
    path,
    relativePath: relative(repositoryRoot, path),
    source: readFileSync(path, 'utf8'),
  }))

  const managedRuntimeOwners = sources
    .filter(({ source }) => /\bManagedRuntime\.make\(/.test(source))
    .map(({ relativePath }) => relativePath)

  assert.deepEqual(managedRuntimeOwners, [
    'src/extension/app-runtime.ts',
    'src/extension/background/runtime.ts',
  ])

  for (const owner of managedRuntimeOwners) {
    const runtimeCount = readProductionSource(owner).match(
      /\bManagedRuntime\.make\(/g,
    )?.length ?? 0
    assert.equal(runtimeCount, 1, `${owner} must own exactly one ManagedRuntime`)
  }

  for (const { relativePath, source } of sources) {
    assert.doesNotMatch(
      source,
      /\bEffect\.run(?:Callback|Fork|Promise(?:Exit)?|Sync(?:Exit)?)\b/,
      `${relativePath} must use its entrypoint's shared ManagedRuntime`,
    )
  }
})

test('shared runtimes retain their required service graphs', () => {
  const appRuntimeSource = sourceWithoutLayout(readProductionSource(
    'src/extension/app-runtime.ts',
  ))
  assert.match(
    appRuntimeSource,
    /ManagedRuntime\.make\(Layer\.mergeAll\(BrowserTabs\.layer\(\),ClosedTabRestoreWatchdogs\.layer,?\)\)/,
  )

  const workerRuntimePath = 'src/extension/background/runtime.ts'
  const workerRuntimeSource = sourceWithoutLayout(readProductionSource(workerRuntimePath))
  const requiredGraphEdges = [
    'constretentionHealth=RetentionHealth.layer(',
    'constretainedPages=RetainedPages.layer(',
    'constactivityServices=Layer.mergeAll(TabHistory.layer(chromeApi),WorkingSet.layer(chromeApi)).pipe(Layer.provideMerge(workingSetActivityStorage))',
    'constbrowserAndNativeServices=Layer.mergeAll(BrowserTabs.layer(),makeNativePlacementBridgeLayer(chromeApi))',
    'constdesktopWindowMerge=DesktopWindowMerge.layer(chromeApi).pipe(Layer.provideMerge(browserAndNativeServices))',
    'constcoreServices=Layer.mergeAll(desktopWindowMerge,Badge.layer(chromeApi),retainedPages,retentionHealth,activityServices)',
    'construntimeLayer=StartupSnapshot.layer({alarms:chromeApi.alarms,getDashboardServiceState:captureDashboardServiceStateEffect}).pipe(Layer.provideMerge(coreServices))',
    'construntime=ManagedRuntime.make(runtimeLayer)',
  ]

  for (const edge of requiredGraphEdges) {
    assert.ok(
      workerRuntimeSource.includes(edge),
      `${workerRuntimePath} must retain the connected service graph edge ${edge}`,
    )
  }
})

test('worker listeners enter the shared background runtime', () => {
  const source = readProductionSource('src/extension/background.ts')
  const listenerRegions = [
    {
      name: 'command',
      start: 'chromeApi.commands.onCommand.addListener',
      end: 'chromeApi.runtime.onMessage.addListener',
    },
    {
      name: 'runtime message',
      start: 'chromeApi.runtime.onMessage.addListener',
      end: '// ─── Initial run',
    },
  ]

  assert.match(source, /\bcreateBackgroundRuntime\(chromeApi\)/)
  for (const { name, start, end } of listenerRegions) {
    const startIndex = source.indexOf(start)
    const endIndex = source.indexOf(end, startIndex + start.length)
    assert.notEqual(startIndex, -1, `${name} listener must remain present`)
    assert.notEqual(endIndex, -1, `${name} listener boundary must remain present`)
    assert.match(
      source.slice(startIndex, endIndex),
      /\bbackgroundRuntime\.runPromise\(/,
      `${name} listener must submit its workflow through the shared runtime`,
    )
  }
})

test('toolbar tab actions mutate windows only through the Browser Tabs Gateway', () => {
  const source = readProductionSource(
    'src/extension/move-current-tab-action.ts',
  )

  assert.match(source, /\byield\* BrowserTabs\b/)
  assert.match(source, /\bbrowserTabs\.createWindow\(/)
  assert.doesNotMatch(source, /\bchrome(?:Api)?\.windows\./)
})

test('adopted Promise adapters enter the shared app runtime', () => {
  const promiseAdapterOwners = [
    'src/extension/closed-ghost-dismissals.ts',
    'src/extension/closed-tab-actions.ts',
    'src/extension/closed-tabs.ts',
    'src/extension/dashboard-data-fetch.ts',
    'src/extension/dashboard-intake.ts',
    'src/extension/dashboard-local-state.ts',
    'src/extension/dashboard-service-state.ts',
    'src/extension/groups.ts',
    'src/extension/history-range-storage.ts',
    'src/extension/native-tab-highlight.ts',
    'src/extension/render.ts',
    'src/extension/retained-page-actions.ts',
    'src/extension/saved-page-actions.ts',
    'src/extension/saved-page-activation.ts',
    'src/extension/saved-pages-mutations.ts',
    'src/extension/saved-pages-storage.ts',
    'src/extension/startup-snapshot.ts',
    'src/extension/storage-list-mutations.ts',
    'src/extension/suspension.ts',
    'src/extension/tab-actions.ts',
    'src/extension/tab-activation.ts',
    'src/extension/tab-focus.ts',
    'src/extension/tab-history.ts',
    'src/extension/tab-move.ts',
    'src/extension/tabs.ts',
    'src/extension/undo.ts',
  ]

  for (const relativePath of promiseAdapterOwners) {
    assert.match(
      readProductionSource(relativePath),
      /\bgetAppRuntime\(\)\.runPromise\(/,
      `${relativePath} must enter the shared app runtime at its Promise boundary`,
    )
  }
})

test('UI, animation, and lazy source seams remain Effect-free', () => {
  const explicitEffectFreeSeams = new Set([
    'src/extension/bookmarks.ts',
    'src/extension/card-move-animation.ts',
    'src/extension/domain-card-view-model.ts',
    'src/extension/history-entry-move-animation.ts',
    'src/extension/history-range.ts',
    'src/extension/history-source.ts',
    'src/extension/intra-card-move-animation.ts',
    'src/extension/layout.ts',
    'src/extension/move-animation.ts',
    'src/extension/saved-pages.ts',
  ])
  const effectFreeSources = productionTypeScriptFiles()
    .map((path) => relative(repositoryRoot, path))
    .filter((relativePath) =>
      relativePath.startsWith('src/components/') ||
      relativePath.startsWith('src/hooks/') ||
      relativePath.startsWith('src/lib/') ||
      explicitEffectFreeSeams.has(relativePath),
    )

  for (const relativePath of effectFreeSources) {
    assert.doesNotMatch(
      readProductionSource(relativePath),
      /\b(?:from\s+|import\s*(?:\(\s*)?)['"]effect(?:\/[^'"]+)?['"]/,
      `${relativePath} must stay outside the Effect runtime graph`,
    )
  }
})

test('scoped Effect owners do not regress to native timers', () => {
  const scopedOwners = [
    'src/extension/background/badge.ts',
    'src/extension/background/native-placement-bridge.ts',
    'src/extension/background/startup-snapshot-service.ts',
    'src/extension/closed-tab-restore-watchdogs.ts',
  ]

  for (const relativePath of scopedOwners) {
    assert.doesNotMatch(
      readProductionSource(relativePath),
      /\b(?:set|clear)(?:Interval|Timeout)\s*\(/,
      `${relativePath} must keep timer ownership in its Effect scope`,
    )
  }
})

test('persisted and cross-context owners retain Schema validation', () => {
  const schemaOwners = [
    'src/extension/background/native-placement-bridge.ts',
    'src/extension/background/tab-history-service.ts',
    'src/extension/background/working-set-activity-authority.ts',
    'src/extension/background/working-set-activity-indexed-db.ts',
    'src/extension/closed-ghost-dismissals.ts',
    'src/extension/closed-tabs.ts',
    'src/extension/dashboard-local-state.ts',
    'src/extension/dashboard-service-state-schema.ts',
    'src/extension/history-range-storage.ts',
    'src/extension/retention-health.ts',
    'src/extension/runtime-messages.ts',
    'src/extension/saved-pages-storage.ts',
    'src/extension/startup-snapshot-schema.ts',
    'src/extension/suspension.ts',
    'src/extension/tab-history.ts',
    'src/extension/working-set.ts',
  ]

  for (const relativePath of schemaOwners) {
    assert.match(
      readProductionSource(relativePath),
      /\bSchema\.(?:decode\w*|encode\w*|is)\(/,
      `${relativePath} must validate its persisted or cross-context boundary`,
    )
  }
})
