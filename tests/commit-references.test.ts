import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempDisposableSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  commitReferencesMain,
  findCommitReferenceFindings,
  outgoingRevisionArguments,
  parseCommitReferencePolicy,
  parsePrePushUpdates,
  type PrePushUpdate
} from '../scripts/check-commit-references.js'

const ZERO_OBJECT_ID = '0'.repeat(40)
const SCRIPT_FILE = fileURLToPath(
  new URL('../scripts/check-commit-references.ts', import.meta.url)
)
const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
const GIT_LOCAL_ENVIRONMENT_VARIABLES = execFileSync(
  'git',
  ['rev-parse', '--local-env-vars'],
  { encoding: 'utf8' }
).trim().split(/\r?\n/u).filter(Boolean)

function independentGitEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const name of GIT_LOCAL_ENVIRONMENT_VARIABLES) delete environment[name]
  return environment
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: independentGitEnvironment()
  }).trim()
}

function runPrePush(cwd: string, input: string) {
  return spawnSync(TSX_BIN, [SCRIPT_FILE, '--pre-push', 'origin'], {
    cwd,
    input,
    encoding: 'utf8',
    env: independentGitEnvironment()
  })
}

test('temporary repositories discard inherited hook repository pointers', () => {
  const environment = independentGitEnvironment({
    GIT_DIR: '/example/.git',
    GIT_INDEX_FILE: '/example/.git/index',
    GIT_WORK_TREE: '/example',
    PATH: '/example/bin'
  })

  assert.equal(environment.GIT_DIR, undefined)
  assert.equal(environment.GIT_INDEX_FILE, undefined)
  assert.equal(environment.GIT_WORK_TREE, undefined)
  assert.equal(environment.PATH, '/example/bin')
})

test('finds built-in issue, pull-request, URL, and mention syntax', () => {
  const message = [
    'Image #11',
    'Fixes GH-42',
    'See example/repository#9',
    'See https://github.com/example/repository/pull/7',
    'JSDoc @public and @example/team'
  ].join('\n')

  assert.deepEqual(
    findCommitReferenceFindings(message).map(({ kind, token }) => ({ kind, token })),
    [
      { kind: 'bare-reference', token: '#11' },
      { kind: 'gh-reference', token: 'GH-42' },
      { kind: 'qualified-reference', token: 'example/repository#9' },
      {
        kind: 'github-url',
        token: 'https://github.com/example/repository/pull/7'
      },
      { kind: 'mention', token: '@public' },
      { kind: 'mention', token: '@example/team' }
    ]
  )
})

test('rejects every known accidental message shape from the repository audit', () => {
  const snippets = [
    'Image #11',
    'Issue #42',
    'PR #1234',
    'Example title #3210021',
    'JSDoc @public tag',
    'Tailwind @theme token',
    'CSS @property vars',
    'JSDoc @returns annotation'
  ]

  for (const snippet of snippets) {
    assert.notEqual(
      findCommitReferenceFindings(snippet).length,
      0,
      `${snippet} should be rejected`
    )
  }
})

test('allows reference-free prose, emails, SHA citations, colors, and redirect links', () => {
  const message = [
    'Image 11, issue 42, pull request 1234, style 3210021',
    'Keep color #fff and prior commit e4f4926',
    'Example key ABC-1234',
    'See https://redirect.github.com/example/repository/issues/11',
    'Co-authored-by: Example <noreply@example.test>'
  ].join('\n')

  assert.deepEqual(findCommitReferenceFindings(message), [])
})

test('uses configured custom-autolink prefixes without claiming an admin audit', () => {
  const policy = parseCommitReferencePolicy({
    customAutolinksAudited: false,
    customAutolinks: [
      { keyPrefix: 'ABC-', isAlphanumeric: false },
      { keyPrefix: 'CASE-', isAlphanumeric: true }
    ]
  })

  assert.deepEqual(
    findCommitReferenceFindings('Examples ABC-123 and CASE-Alpha9', policy)
      .map(({ kind, token }) => ({ kind, token })),
    [
      { kind: 'custom-autolink', token: 'ABC-123' },
      { kind: 'custom-autolink', token: 'CASE-Alpha9' }
    ]
  )
})

test('validates commit-reference policy containers and indexed custom autolinks', () => {
  assert.throws(
    () => parseCommitReferencePolicy({
      customAutolinksAudited: 'no',
      customAutolinks: []
    }),
    /must define customAutolinksAudited and customAutolinks/
  )
  assert.throws(
    () => parseCommitReferencePolicy({
      customAutolinksAudited: false,
      customAutolinks: [
        { keyPrefix: 'ABC-', isAlphanumeric: false },
        { keyPrefix: '', isAlphanumeric: true }
      ]
    }),
    /customAutolinks\[1\] must define keyPrefix and isAlphanumeric/
  )
})

test('reports stable one-based line and column positions', () => {
  const [finding] = findCommitReferenceFindings('safe line\nImage #11')
  assert.deepEqual(
    finding && { line: finding.line, column: finding.column, token: finding.token },
    { line: 2, column: 7, token: '#11' }
  )
})

test('parses pre-push updates and derives outgoing revision ranges', () => {
  const existingUpdate: PrePushUpdate = {
    localRef: 'refs/heads/dev',
    localObjectId: '1'.repeat(40),
    remoteRef: 'refs/heads/dev',
    remoteObjectId: '2'.repeat(40)
  }
  const newUpdate: PrePushUpdate = {
    ...existingUpdate,
    localRef: 'refs/heads/example/new',
    remoteRef: 'refs/heads/example/new',
    remoteObjectId: ZERO_OBJECT_ID
  }

  assert.deepEqual(
    parsePrePushUpdates(
      `${existingUpdate.localRef} ${existingUpdate.localObjectId} ` +
      `${existingUpdate.remoteRef} ${existingUpdate.remoteObjectId}\n`
    ),
    [existingUpdate]
  )
  assert.deepEqual(
    outgoingRevisionArguments(existingUpdate, 'origin'),
    [existingUpdate.localObjectId, `^${existingUpdate.remoteObjectId}`]
  )
  assert.deepEqual(
    outgoingRevisionArguments(newUpdate, 'origin'),
    [newUpdate.localObjectId, '--not', '--remotes=origin']
  )
  assert.deepEqual(
    outgoingRevisionArguments(newUpdate, 'https://example.test/repository.git'),
    [newUpdate.localObjectId]
  )
  assert.equal(
    outgoingRevisionArguments({ ...existingUpdate, localObjectId: ZERO_OBJECT_ID }, 'origin'),
    null
  )
})

test('accepts the package-manager argument delimiter used by manual range checks', () => {
  const calls: string[][] = []
  const exitCode = commitReferencesMain(['--', '--range', 'base..head'], (args) => {
    calls.push([...args])
    return args[0] === 'rev-list' ? `${'a'.repeat(40)}\n` : 'fix: use safe prose\n'
  })

  assert.equal(exitCode, 0)
  assert.deepEqual(calls, [
    ['rev-list', 'base..head'],
    ['show', '-s', '--format=%B', 'a'.repeat(40)]
  ])
})

test('pre-push scans existing and new branch ranges and quarantines backup refs', () => {
  using temporaryRoot = mkdtempDisposableSync(join(tmpdir(), 'tab-out-commit-references-'))
  const root = temporaryRoot.path
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')

  mkdirSync(work)
  git(root, 'init', '--bare', remote)
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.name', 'Example Contributor')
  git(work, 'config', 'user.email', 'contributor@example.test')
  git(work, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(work, 'example.txt'), 'baseline\n')
  git(work, 'add', 'example.txt')
  git(work, 'commit', '-m', 'chore: create baseline')
  const baseline = git(work, 'rev-parse', 'HEAD')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '-u', 'origin', 'main')

  writeFileSync(join(work, 'example.txt'), 'unsafe\n')
  git(work, 'commit', '-am', 'test: preserve Image #42 example')
  const unsafeExisting = git(work, 'rev-parse', 'HEAD')
  const existingResult = runPrePush(
    work,
    `refs/heads/main ${unsafeExisting} refs/heads/main ${baseline}\n`
  )
  assert.equal(existingResult.status, 1, existingResult.stderr)
  assert.match(existingResult.stderr, /#42/)

  git(work, 'reset', '--hard', baseline)
  writeFileSync(join(work, 'example.txt'), 'safe\n')
  git(work, 'commit', '-am', 'test: preserve image 42 example')
  const safeExisting = git(work, 'rev-parse', 'HEAD')
  const safeResult = runPrePush(
    work,
    `refs/heads/main ${safeExisting} refs/heads/main ${baseline}\n`
  )
  assert.equal(safeResult.status, 0, safeResult.stderr)

  const backupResult = runPrePush(
    work,
    `refs/heads/backup/example ${safeExisting} ` +
    `refs/heads/backup/example ${ZERO_OBJECT_ID}\n`
  )
  assert.equal(backupResult.status, 1, backupResult.stderr)
  assert.match(backupResult.stderr, /recovery ref/)

  git(work, 'reset', '--hard', baseline)
  git(work, 'switch', '-c', 'example/unsafe')
  writeFileSync(join(work, 'example.txt'), 'unsafe branch\n')
  git(work, 'commit', '-am', 'docs: explain @returns syntax')
  const unsafeNewBranch = git(work, 'rev-parse', 'HEAD')
  const newBranchResult = runPrePush(
    work,
    `refs/heads/example/unsafe ${unsafeNewBranch} ` +
    `refs/heads/example/unsafe ${ZERO_OBJECT_ID}\n`
  )
  assert.equal(newBranchResult.status, 1, newBranchResult.stderr)
  assert.match(newBranchResult.stderr, /@returns/)

  const deletionResult = runPrePush(
    work,
    `refs/heads/main ${ZERO_OBJECT_ID} refs/heads/main ${baseline}\n`
  )
  assert.equal(deletionResult.status, 0, deletionResult.stderr)

  const backupDeletionResult = runPrePush(
    work,
    `refs/heads/backup/example ${ZERO_OBJECT_ID} ` +
    `refs/heads/backup/example ${baseline}\n`
  )
  assert.equal(backupDeletionResult.status, 0, backupDeletionResult.stderr)
})
