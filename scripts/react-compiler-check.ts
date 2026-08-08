/* ================================================================
   React Compiler coverage gate — fails `pnpm verify` when a source
   file gains a compiler bailout beyond the known-by-design baseline
   below. The 2026-07-14 React audit restored compilation
   on the hot path; this keeps future edits from silently un-compiling
   it (a bailed component loses ALL auto-memoization, not one memo).

   When a bailout is deliberate (documented ref architecture etc.),
   add it to BASELINE with a reason. When this script reports fewer
   bailouts than the baseline, ratchet the baseline down.
   ================================================================ */

import { createRequire } from 'node:module'
import { globSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

import type { LoggerEvent } from 'babel-plugin-react-compiler'

type BabelRuntime = {
  transformSync(source: string, options: Record<string, unknown>): unknown
}

type CompilerRegression = {
  rel: string
  expected: number
  errors: string[]
}

type CompilerImprovement = {
  rel: string
  expected: number
  actual: number
}

const REPO = resolve(import.meta.dirname, '..')

// file (repo-relative) -> expected CompileError count
const BASELINE: ReadonlyMap<string, number> = new Map([
  ['src/components/App.tsx', 5], // deliberate ordering-cache reads and forwarded grid refs in render
  ['src/components/title-expansion/use-title-expansion.ts', 1], // lazy-init ref facade (stable return)
  ['src/components/ui/tooltip.tsx', 3], // mergeRefs composition (documented suppressions)
  ['src/extension/layout.ts', 2] // latest-ref render writes; returns are manual useCallbacks
])

const repoRequire = createRequire(join(REPO, 'package.json'))
const compiler: unknown = repoRequire('babel-plugin-react-compiler')
const babel = createRequire(repoRequire.resolve('@rolldown/plugin-babel'))('@babel/core') as BabelRuntime

function sourceFiles(): string[] {
  const sourceRoot = join(REPO, 'src')
  return globSync('**/*.{ts,tsx}', {
    cwd: sourceRoot,
    exclude: ['**/*.d.ts']
  })
    .map((file) => join(sourceRoot, file))
    .sort()
}

function bailoutsForFile(file: string): string[] {
  const errors: string[] = []
  try {
    babel.transformSync(readFileSync(file, 'utf8'), {
      filename: file,
      babelrc: false,
      configFile: false,
      code: false,
      parserOpts: { plugins: ['typescript', 'jsx'] },
      plugins: [
        [
          compiler,
          {
            panicThreshold: 'none',
            logger: {
              logEvent(_filename: string | null, event: LoggerEvent) {
                if (event.kind === 'CompileError') {
                  errors.push(`fn@${event.fnLoc?.start?.line ?? '?'}: ${event.detail?.reason ?? 'unknown reason'}`)
                }
              }
            }
          }
        ]
      ]
    })
  } catch (error) {
    errors.push(`pipeline error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  return errors
}

const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f)) : sourceFiles()

const regressions: CompilerRegression[] = []
const improvements: CompilerImprovement[] = []
let totalBailouts = 0

for (const file of files) {
  const rel = relative(REPO, file)
  const errors = bailoutsForFile(file)
  totalBailouts += errors.length
  const expected = BASELINE.get(rel) ?? 0
  if (errors.length > expected) {
    regressions.push({ rel, expected, errors })
  } else if (errors.length < expected) {
    improvements.push({ rel, expected, actual: errors.length })
  }
}

if (regressions.length > 0) {
  console.error('React Compiler coverage regressed — new bailouts beyond the known-by-design baseline:\n')
  for (const { rel, expected, errors } of regressions) {
    console.error(`  ${rel} (expected ${expected}, got ${errors.length}):`)
    for (const error of errors) console.error(`    ${error}`)
  }
  console.error('\nFix the bailout using the existing stable-return and suppression patterns or, if deliberate and documented, update the baseline in scripts/react-compiler-check.ts.')
  process.exit(1)
}

const summary = `react-compiler-check: ${totalBailouts} bailout${totalBailouts === 1 ? '' : 's'} across ${files.length} files — all within baseline`
if (improvements.length > 0) {
  console.log(`${summary}; baseline can ratchet down: ${improvements.map(({ rel, expected, actual }) => `${rel} ${expected}→${actual}`).join(', ')}`)
} else {
  console.log(summary)
}
