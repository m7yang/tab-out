import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(repositoryRoot, 'src')
function productionTypeScriptFiles(): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: sourceRoot })
    .map((file) => join(sourceRoot, file))
    .sort()
}

test('production Effects cross the runtime boundary only through the shared app and worker runtimes', () => {
  const sources = productionTypeScriptFiles().map((path) => ({
    path,
    relativePath: relative(repositoryRoot, path),
    source: readFileSync(path, 'utf8')
  }))

  const managedRuntimeOwners = sources
    .filter(({ source }) => /\bManagedRuntime\.make\(/.test(source))
    .map(({ relativePath }) => relativePath)

  assert.deepEqual(managedRuntimeOwners, [
    'src/extension/app-runtime.ts',
    'src/extension/background/runtime.ts'
  ])

  for (const { relativePath, source } of sources) {
    assert.doesNotMatch(
      source,
      /\bEffect\.run(?:Callback|Fork|Promise(?:Exit)?|Sync(?:Exit)?)\b/,
      `${relativePath} must use its entrypoint's shared ManagedRuntime`
    )
  }
})
