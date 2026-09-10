import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

import {
  CHROME_BUILD_TARGET,
  MINIMUM_CHROME_VERSION,
  chromeSupportPolicy,
} from '../src/extension/chrome-support.js'
import { createIndexHtml } from '../src/index-html.js'
import { createPopupHtml } from '../src/popup-html.js'
import { createExtensionManifest } from '../src/extension/manifest.js'

test('verification checks every tracked generated extension surface', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(
    pkg.scripts?.['verify:bundle'],
    'node scripts/check-generated-extension-output.ts',
  )
  assert.match(pkg.scripts?.verify, /pnpm build && pnpm verify:bundle/)
})

test('browser proof scripts expose focused and complete harness runs', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  assert.equal(pkg.scripts?.['test:browser'], 'pnpm test:browser:all')
  assert.equal(
    pkg.scripts?.['test:browser:all'],
    'playwright test --config tests/playwright.config.ts',
  )
  assert.equal(
    pkg.scripts?.['test:browser:smoke'],
    'playwright test --config tests/playwright.config.ts tests/browser/dashboard-smoke.spec.ts',
  )
  assert.equal(
    pkg.scripts?.['test:browser:layout'],
    'playwright test --config tests/playwright.config.ts tests/browser/dashboard-layout.spec.ts',
  )
  assert.equal(
    pkg.scripts?.['test:browser:first-paint'],
    'playwright test --config tests/playwright.config.ts tests/browser/dashboard-first-paint.spec.ts',
  )
  assert.equal(pkg.scripts?.['verify:browser'], 'pnpm verify && pnpm test:browser:all')
  assert.equal(pkg.scripts?.['verify:extension'], 'pnpm verify && pnpm test:extension')
})

test('extension build configuration produces the committed package', async () => {
  assert.ok(existsSync('package.json'), 'package.json should define the Vite build')
  assert.ok(existsSync('scripts/build-extension.ts'), 'scripts/build-extension.ts should generate package files and build extension entries without shared runtime chunks')
  assert.ok(existsSync('scripts/check-tailwind-diagnostics.ts'), 'the Tailwind diagnostics client should be strict TypeScript')
  assert.ok(existsSync('scripts/check-commit-references.ts'), 'commit reference checks should guard immutable commit messages')
  assert.ok(existsSync('scripts/chrome-support.ts'), 'scripts/chrome-support.ts should maintain the rolling Chrome floor')
  assert.ok(existsSync('scripts/react-compiler-check.ts'), 'the React Compiler coverage gate should be strict TypeScript')
  assert.ok(existsSync('scripts/serve.ts'), 'the local fixture server should be strict TypeScript')
  assert.ok(existsSync('scripts/watch-build.ts'), 'scripts/watch-build.ts should drive local rebuilds without watching dist output')
  assert.ok(existsSync('tsconfig.node.json'), 'Node-executed TypeScript should have a NodeNext compiler boundary')
  assert.deepEqual(
    readdirSync('scripts').filter((file) => file.endsWith('.mjs')),
    [],
    'maintained Node scripts should use TypeScript',
  )
  assert.ok(existsSync('src/app.tsx'), 'src/app.tsx should be the React entry source')
  assert.ok(existsSync('src/extension/background.ts'), 'src/extension/background.ts should be the service worker source')
  assert.ok(existsSync('src/extension/manifest.ts'), 'src/extension/manifest.ts should be the manifest source')
  assert.ok(existsSync('src/index-html.tsx'), 'src/index-html.tsx should be the dashboard page source')
  assert.ok(existsSync('src/index-html.template.html'), 'src/index-html.template.html should define the static dashboard page wrapper')
  assert.equal(existsSync('src/index-html.template.d.html.ts'), false, 'the Node generator should read the HTML template without an arbitrary-extension declaration')
  assert.ok(existsSync('components.json'), 'components.json should define the shadcn project setup')
  assert.ok(existsSync('.dependency-cruiser.cjs'), 'dependency-cruiser should define repository architecture rules')
  assert.equal(
    existsSync('.dependency-cruiser-known-violations.json'),
    false,
    'dependency-cruiser should stay clean without a known-violations baseline',
  )
  assert.ok(existsSync('chrome-support.json'), 'chrome-support.json should be the tracked browser-support policy')
  assert.ok(existsSync('doctor.config.json'), 'doctor.config.json should define the React Doctor policy')

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const doctorConfig = JSON.parse(readFileSync('doctor.config.json', 'utf8'))
  const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'))
  const nodeTsconfig = JSON.parse(readFileSync('tsconfig.node.json', 'utf8'))
  const testTsconfig = JSON.parse(readFileSync('tsconfig.test.json', 'utf8'))
  const shadcnConfig = JSON.parse(readFileSync('components.json', 'utf8'))
  assert.equal(readFileSync('.node-version', 'utf8').trim(), '26.8.2')
  assert.match(pkg.packageManager, /^pnpm@/)
  assert.equal(pkg.scripts?.['setup:hooks'], 'git config core.hooksPath .githooks')
  assert.equal(
    pkg.scripts?.['commit-references:check'],
    'node scripts/check-commit-references.ts',
  )
  assert.equal(pkg.scripts?.dev, 'node scripts/watch-build.ts')
  assert.equal(pkg.scripts?.serve, 'node scripts/serve.ts')
  assert.equal(pkg.scripts?.build, 'node --import tsx scripts/build-extension.ts')
  assert.equal(pkg.scripts?.['build:debug'], 'node --import tsx scripts/build-extension.ts --sourcemap')
  assert.equal(
    pkg.scripts?.['build:working-set-storage-benchmark'],
    'node scripts/build-working-set-storage-benchmark.ts',
  )
  assert.equal(pkg.scripts?.['chrome-support:check'], 'node scripts/chrome-support.ts check')
  assert.equal(
    pkg.scripts?.['chrome-support:bump'],
    'node scripts/chrome-support.ts bump && pnpm build && pnpm chrome-support:check',
  )
  assert.equal(
    pkg.scripts?.['chrome-support:release-check'],
    'node scripts/chrome-support.ts release-check',
  )
  assert.match(pkg.scripts?.typecheck, /tsconfig\.node\.json/)
  assert.equal(pkg.scripts?.test, 'pnpm test:node && pnpm test:vitest')
  assert.equal(
    pkg.scripts?.['test:node'],
    'node --import tsx --test tests/*.test.ts',
  )
  assert.equal(pkg.scripts?.['test:vitest'], 'vitest run')
  assert.equal(pkg.scripts?.['test:vitest:watch'], 'vitest')
  assert.equal(pkg.scripts?.lint, 'eslint . --max-warnings=0')
  assert.equal(
    pkg.scripts?.['deps:architecture'],
    'depcruise --config .dependency-cruiser.cjs src',
  )
  assert.equal(pkg.scripts?.['deps:peers'], 'pnpm peers check')
  assert.equal(pkg.scripts?.['deps:nolyfill'], 'pnpm dlx nolyfill --pm pnpm')
  assert.match(pkg.scripts?.['react-doctor'], /--scope lines --base HEAD/)
  assert.match(pkg.scripts?.['react-doctor'], /--no-telemetry/)
  assert.match(pkg.scripts?.['react-doctor:diff'], /--no-telemetry/)
  assert.match(pkg.scripts?.['react-doctor:full'], /--no-telemetry/)
  assert.equal(doctorConfig.noScore, true)
  assert.equal(doctorConfig.supplyChain?.enabled, false)
  assert.equal(doctorConfig.offline, undefined)
  assert.equal(pkg.scripts?.['verify:compiler'], 'node scripts/react-compiler-check.ts')
  assert.match(pkg.scripts?.verify, /pnpm knip/)
  assert.equal(pkg.scripts?.['lint:tailwind'], 'node scripts/check-tailwind-diagnostics.ts')
  assert.equal(
    pkg.scripts?.['verify:quick'],
    'pnpm run "/^(typecheck|lint|lint:tailwind|deps:architecture|deps:peers|knip|react-doctor|verify:compiler)$/"',
  )
  assert.match(pkg.scripts?.verify, /pnpm lint:tailwind/)
  assert.match(pkg.scripts?.verify, /^pnpm chrome-support:check &&/)
  assert.match(pkg.scripts?.verify, /pnpm lint/)
  assert.match(pkg.scripts?.verify, /pnpm deps:architecture/)
  assert.match(pkg.scripts?.verify, /pnpm deps:peers/)
  assert.match(pkg.scripts?.verify, /pnpm verify:bundle/)
  assert.ok(pkg.dependencies?.react)
  assert.ok(pkg.dependencies?.['react-dom'])
  assert.ok(pkg.dependencies?.['@base-ui/react'])
  assert.equal(pkg.dependencies?.['class-variance-authority'], undefined)
  assert.ok(pkg.dependencies?.foxact)
  assert.equal(pkg.dependencies?.idb, '8.0.3')
  assert.ok(pkg.dependencies?.['es-toolkit'])
  assert.ok(pkg.devDependencies?.['@types/chrome'])
  assert.match(pkg.devDependencies?.['@types/node'], /^\^26\./)
  assert.ok(pkg.devDependencies?.['@rolldown/plugin-babel'])
  assert.ok(pkg.devDependencies?.['@tailwindcss/vite'])
  assert.ok(pkg.devDependencies?.['@iconify-json/ooui'])
  assert.ok(pkg.devDependencies?.['babel-plugin-react-compiler'])
  assert.ok(pkg.devDependencies?.['dependency-cruiser'])
  assert.equal(
    pkg.devDependencies?.['@effect/vitest'],
    pkg.dependencies?.effect,
  )
  assert.equal(pkg.devDependencies?.['fast-check'], undefined)
  assert.ok(pkg.devDependencies?.tailwindcss)
  assert.ok(pkg.devDependencies?.vite)
  assert.ok(pkg.devDependencies?.vitest)
  assert.ok(pkg.devDependencies?.shadcn)
  assert.equal(pkg.devDependencies?.['@sinonjs/fake-timers'], undefined)
  assert.ok(pkg.devDependencies?.['type-fest'])
  assert.ok(tsconfig.compilerOptions?.types?.includes('chrome'))
  assert.equal(tsconfig.compilerOptions?.allowArbitraryExtensions, undefined)
  assert.equal(tsconfig.compilerOptions?.allowUnreachableCode, false)
  assert.equal(tsconfig.compilerOptions?.noFallthroughCasesInSwitch, true)
  assert.equal(tsconfig.compilerOptions?.noImplicitReturns, true)
  assert.equal(tsconfig.compilerOptions?.noUncheckedIndexedAccess, true)
  assert.equal(tsconfig.compilerOptions?.noUncheckedSideEffectImports, true)
  assert.equal(tsconfig.compilerOptions?.exactOptionalPropertyTypes, true)
  assert.equal(tsconfig.compilerOptions?.strict, true)
  assert.equal(nodeTsconfig.extends, './tsconfig.json')
  assert.equal(nodeTsconfig.compilerOptions?.module, 'NodeNext')
  assert.equal(nodeTsconfig.compilerOptions?.moduleResolution, 'NodeNext')
  assert.deepEqual(nodeTsconfig.compilerOptions?.types, ['node'])
  assert.deepEqual(nodeTsconfig.compilerOptions?.paths, {})
  assert.ok(nodeTsconfig.files?.includes('scripts/build-working-set-storage-benchmark.ts'))
  assert.ok(nodeTsconfig.files?.includes('scripts/check-generated-extension-output.ts'))
  assert.ok(nodeTsconfig.files?.includes('scripts/check-tailwind-diagnostics.ts'))
  assert.ok(nodeTsconfig.files?.includes('scripts/chrome-support.ts'))
  assert.ok(nodeTsconfig.files?.includes('scripts/react-compiler-check.ts'))
  assert.ok(nodeTsconfig.files?.includes('scripts/serve.ts'))
  assert.ok(nodeTsconfig.files?.includes('scripts/watch-build.ts'))
  assert.equal(testTsconfig.extends, './tsconfig.json')
  assert.equal(testTsconfig.compilerOptions, undefined)
  assert.deepEqual(tsconfig.compilerOptions?.paths?.['@/*'], ['./src/*'])
  assert.equal(CHROME_BUILD_TARGET, `chrome${chromeSupportPolicy.minimumMajor}`)
  assert.equal(MINIMUM_CHROME_VERSION, String(chromeSupportPolicy.minimumMajor))
  assert.equal(shadcnConfig.style, 'base-nova')
  assert.equal(shadcnConfig.rsc, false)
  assert.equal(shadcnConfig.tsx, true)
  assert.equal(shadcnConfig.tailwind?.css, 'src/styles/app.css')
  assert.equal(shadcnConfig.tailwind?.config, '')
  assert.equal(shadcnConfig.tailwind?.cssVariables, true)
  assert.equal(shadcnConfig.aliases?.ui, '@/components/ui')
  assert.equal(shadcnConfig.aliases?.components, '@/components')
  assert.equal(shadcnConfig.aliases?.utils, '@/lib/utils')
  assert.equal(shadcnConfig.aliases?.lib, '@/lib')

  const indexHtml = readFileSync('extension/index.html', 'utf8')
  const indexHtmlTemplate = readFileSync('src/index-html.template.html', 'utf8')
  assert.equal(indexHtmlTemplate.split('<!-- TAB_OUT_PRERENDERED_APP -->').length, 2)
  assert.equal(indexHtml, await createIndexHtml())
  assert.doesNotMatch(indexHtml, /TAB_OUT_PRERENDERED_APP/)
  const appRootStart = indexHtml.indexOf('<div id="appRoot">') + '<div id="appRoot">'.length
  const appRootEnd = indexHtml.indexOf('</div>\n    <!-- TAB_OUT_APP_ROOT_END -->', appRootStart)
  assert.ok(appRootStart >= '<div id="appRoot">'.length)
  assert.ok(appRootEnd > appRootStart)
  const appRootContent = indexHtml.slice(appRootStart, appRootEnd)
  assert.equal(appRootContent.trim(), appRootContent)
  assert.match(appRootContent, /^<div data-tabout="dashboard-shell"/)
  // The Tab Actions Menu lives in the toolbar popup page, not the header.
  assert.doesNotMatch(appRootContent, /data-tabout="tab-actions"/)
  assert.doesNotMatch(appRootContent, /data-tabout-part="menu-trigger"/)
  assert.doesNotMatch(appRootContent, /filterFocusBootShell/)
  const dashboardViewBootScript = '<script src="dist/dashboard-view-boot.js"></script>'
  assert.ok(indexHtml.indexOf(dashboardViewBootScript) < indexHtml.indexOf('<div id="appRoot">'))
  const appModuleScript = '<script type="module" src="dist/app.js"></script>'
  const appModuleScriptIndex = indexHtml.indexOf(appModuleScript)
  assert.ok(appModuleScriptIndex >= 0)
  assert.ok(appModuleScriptIndex < indexHtml.indexOf('</head>'))
  assert.equal(indexHtml.match(/(?:href|src)="dist\/app\.js"/g)?.length, 1)
  assert.doesNotMatch(indexHtml, /rel="(?:module)?preload" href="dist\/app\.js"/)
  assert.match(indexHtml, /href="dist\/assets\/app\.css"/)
  assert.match(indexHtml, /src="dist\/filter-focus-boot\.js"/)
  assert.doesNotMatch(indexHtml, /config\.local\.js/)
  assert.match(indexHtml, /src="dist\/app\.js"/)
  assert.doesNotMatch(indexHtml, /src="app\.js"/)

  const popupHtml = readFileSync('extension/popup.html', 'utf8')
  const popupHtmlTemplate = readFileSync('src/popup-html.template.html', 'utf8')
  assert.equal(popupHtmlTemplate.split('<!-- TAB_OUT_PRERENDERED_POPUP -->').length, 2)
  assert.equal(popupHtml, await createPopupHtml())
  assert.doesNotMatch(popupHtml, /TAB_OUT_PRERENDERED_POPUP/)
  assert.match(popupHtml, /<html lang="en" data-tabout-popup>/)
  assert.match(popupHtml, /href="dist\/assets\/app\.css"/)
  assert.match(popupHtml, /<script type="module" src="dist\/popup\.js"><\/script>/)
  assert.match(popupHtml, /<div id="popupRoot"><div data-tabout="tab-actions"/)
  assert.match(popupHtml, /data-tabout-part="merge-desktop-windows-button"/)
  assert.match(popupHtml, /<div id="toastRoot"><\/div>/)

  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))
  assert.deepEqual(manifest, createExtensionManifest({ version: pkg.version }))
  assert.equal(manifest.background?.service_worker, 'dist/background.js')
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.incognito, 'not_allowed')
  assert.equal(manifest.minimum_chrome_version, MINIMUM_CHROME_VERSION)
  assert.equal(manifest.action?.default_popup, 'popup.html')
  assert.deepEqual(manifest.commands?.['_execute_action'], {})

  const viteConfig = readFileSync('vite.config.ts', 'utf8')
  const buildScript = readFileSync('scripts/build-extension.ts', 'utf8')
  const workingSetBenchmarkBuildConfig = readFileSync(
    'scripts/working-set-benchmark-build-config.ts',
    'utf8',
  )
  const workingSetBenchmarkBuildScript = readFileSync(
    'scripts/build-working-set-storage-benchmark.ts',
    'utf8',
  )
  const manifestSource = readFileSync('src/extension/manifest.ts', 'utf8')
  const indexHtmlSource = readFileSync('src/index-html.tsx', 'utf8')
  const serveScript = readFileSync('scripts/serve.ts', 'utf8')
  const watchScript = readFileSync('scripts/watch-build.ts', 'utf8')
  assert.match(indexHtmlSource, /import \{ prerender \} from 'react-dom\/static'/)
  assert.match(indexHtmlSource, /import \{ AppRoot \} from '\.\/components\/App\.js'/)
  assert.doesNotMatch(indexHtmlSource, /with \{ type: 'text' \}/)
  assert.doesNotMatch(workingSetBenchmarkBuildScript, /experimental-import-text/)
  assert.match(manifestSource, /chrome\.runtime\.ManifestV3/)
  assert.match(manifestSource, /minimum_chrome_version: MINIMUM_CHROME_VERSION/)
  assert.match(manifestSource, /permissions: \['tabs', 'tabGroups', 'bookmarks', 'history', 'sessions', 'storage', 'alarms', 'favicon', 'system\.display', 'nativeMessaging'\]/)
  assert.match(viteConfig, /reactCompilerPreset/)
  assert.match(viteConfig, /@rolldown\/plugin-babel/)
  assert.match(viteConfig, /@tailwindcss\/vite/)
  assert.match(viteConfig, /TAB_OUT_BUILD_ENTRY/)
  assert.match(viteConfig, /target: CHROME_BUILD_TARGET/)
  assert.match(viteConfig, /find: \/\^tldts\$\//)
  assert.match(viteConfig, /tldts\/dist\/index\.esm\.min\.js/)
  assert.ok(existsSync('node_modules/tldts/dist/index.esm.min.js'))
  assert.match(viteConfig, /buildEntry === 'background' \|\| buildEntry === 'popup' \? \{ codeSplitting: false \} : \{\}/)
  assert.match(viteConfig, /const repoRoot = import\.meta\.dirname/)
  assert.match(viteConfig, /\{ find: '@', replacement: resolve\(repoRoot, 'src'\) \}/)
  assert.match(viteConfig, /workingSetBackgroundEntryPath/)
  assert.match(workingSetBenchmarkBuildConfig, /src\/extension\/background\.ts/)
  assert.match(workingSetBenchmarkBuildConfig, /resolve\(repositoryRoot, 'extension'\)/)
  assert.match(buildScript, /createExtensionManifest/)
  assert.match(buildScript, /createIndexHtml/)
  assert.match(buildScript, /createPopupHtml/)
  assert.match(buildScript, /resolveWorkingSetBuildSelection/)
  assert.match(buildScript, /resolve\(extensionPackageDirectory, 'manifest\.json'\)/)
  assert.match(buildScript, /resolve\(extensionPackageDirectory, 'index\.html'\)/)
  assert.match(buildScript, /resolve\(extensionPackageDirectory, 'popup\.html'\)/)
  assert.match(buildScript, /ChildProcess\.make\('pnpm'/)
  assert.match(buildScript, /runBuild\('app', viteArgs\)/)
  assert.match(buildScript, /runBuild\('background', viteArgs\)/)
  assert.match(buildScript, /Effect\.provide\(NodeServices\.layer\)/)
  assert.match(buildScript, /NodeRuntime\.runMain/)
  assert.match(watchScript, /from 'node:fs'/)
  assert.match(watchScript, /watch\(path, \{ recursive \}/)
  assert.match(watchScript, /ChildProcess\.make\('pnpm'/)
  assert.match(watchScript, /Effect\.provide\(NodeServices\.layer\)/)
  assert.match(watchScript, /NodeRuntime\.runMain/)
  assert.match(serveScript, /NodeHttpServer\.make\(createServer/)
  assert.match(serveScript, /HttpServerResponse\.file/)
  assert.match(serveScript, /Effect\.provide\(NodeHttpServer\.layerHttpServices\)/)
  assert.match(serveScript, /NodeRuntime\.runMain/)
  assert.match(watchScript, /scripts.*build-extension\.ts/)
  assert.doesNotMatch(watchScript, /extension\/dist/)
  assert.doesNotMatch(watchScript, /POLL_MS|snapshotFiles/)
})

test('repo hooks verify changes and reject unsafe commit references', () => {
  assert.ok(existsSync('.githooks/pre-commit'), 'pre-commit hook should be committed for local setup')
  assert.ok(existsSync('.githooks/commit-msg'), 'commit-msg hook should check proposed messages')
  assert.ok(existsSync('.githooks/pre-push'), 'pre-push hook should check outgoing commits')

  const preCommitHook = readFileSync('.githooks/pre-commit', 'utf8')
  const commitMessageHook = readFileSync('.githooks/commit-msg', 'utf8')
  const prePushHook = readFileSync('.githooks/pre-push', 'utf8')
  assert.notEqual(statSync('.githooks/commit-msg').mode & 0o111, 0)
  assert.notEqual(statSync('.githooks/pre-push').mode & 0o111, 0)
  assert.match(preCommitHook, /^#!\/bin\/sh/)
  assert.match(preCommitHook, /pnpm verify/)
  assert.match(commitMessageHook, /node scripts\/check-commit-references\.ts --message-file/)
  assert.match(prePushHook, /node scripts\/check-commit-references\.ts --pre-push/)
})

test('commit reference policy records custom-autolink audit status', () => {
  const policy = JSON.parse(
    readFileSync('.github/commit-reference-policy.json', 'utf8'),
  ) as { customAutolinks: unknown[], customAutolinksAudited: boolean }

  assert.deepEqual(policy.customAutolinks, [])
  assert.equal(policy.customAutolinksAudited, false)
})

test('built extension bundle is packaged locally', () => {
  assert.ok(existsSync('extension/dist/app.js'), 'extension/dist/app.js should be committed build output for unpacked extension loading')
  assert.ok(existsSync('extension/dist/background.js'), 'extension/dist/background.js should be committed service worker output')
  assert.equal(existsSync('extension/dist/app.js.map'), false, 'production build should not ship a sourcemap')
  assert.equal(existsSync('extension/dist/background.js.map'), false, 'production build should not ship a service-worker sourcemap')
  assert.equal(existsSync('extension/dist/chunks'), false, 'dashboard UI should be bundled into one JS entry')
  assert.ok(existsSync('extension/dist/assets/app.css'), 'extension/dist/assets/app.css should be committed stylesheet output')

  const distFiles = readdirSync('extension/dist').sort()
  const assetFiles = readdirSync('extension/dist/assets').sort()
  const assetJsFiles = assetFiles.filter((name) => name.endsWith('.js'))
  const indexHtml = readFileSync('extension/index.html', 'utf8')
  assert.deepEqual(distFiles, ['app.js', 'assets', 'background.js', 'dashboard-view-boot.js', 'filter-focus-boot.js', 'popup.js'])
  assert.ok(assetFiles.includes('app.css'))
  assert.equal(assetJsFiles.length, 8)
  assert.ok(assetJsFiles.some((name) => /^startup-order-debug-heavy-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^bookmarks-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(!assetJsFiles.some((name) => /^CardActionsMenuLoaded-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^HistoryRangeSelect-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^history-source-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^mountToast-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(!assetJsFiles.some((name) => /^PageChipContextMenuLoaded-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^ReactStore-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^getPseudoElementBounds-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(assetJsFiles.some((name) => /^rolldown-runtime-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.ok(!assetJsFiles.some((name) => /^TitleSuppressionTokenContextMenuLoaded-[A-Za-z0-9_-]+\.js$/.test(name)))
  assert.deepEqual(readdirSync('extension').filter((name) => name.endsWith('.js')), [])
  assert.doesNotMatch(indexHtml, /config\.local\.js/)

  const bundle = readFileSync('extension/dist/app.js', 'utf8')
  const backgroundBundle = readFileSync('extension/dist/background.js', 'utf8')
  const stylesheet = readFileSync('extension/dist/assets/app.css', 'utf8')
  assert.doesNotMatch(bundle, /from\s+['"]https?:\/\//)
  assert.doesNotMatch(backgroundBundle, /from\s+['"]https?:\/\//)
  assert.doesNotMatch(bundle, /vendor\/preact|vendor\/htm/)
  assert.match(bundle, /mission-card/)
  assert.match(stylesheet, /\.dashboard-main/)
  assert.match(stylesheet, /body\{[^}]*font-family:sans-serif/)
  assert.doesNotMatch(stylesheet, /@layer base\{/)
  assert.doesNotMatch(stylesheet, /@layer components\{/)
  assert.doesNotMatch(stylesheet, /@font-face/)
  assert.doesNotMatch(stylesheet, /url\(["']?https?:\/\//)
  assert.doesNotMatch(stylesheet, /tailwindcss\/preflight/)
})
