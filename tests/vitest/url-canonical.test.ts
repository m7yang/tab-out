import assert from 'node:assert/strict'
import { it, vi } from '@effect/vitest'
import { Schema } from 'effect'

import { canonicalDedupeKey } from '../../src/extension/url-canonical.js'

const longForm =
  'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
const canonical = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'

const naturalNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
// encodeURIComponent rejects lone surrogates, which the generator may produce.
const wellFormedString = Schema.String.check(Schema.makeFilter((value: string) => value.isWellFormed()))
const uppercaseLetter = Schema.Literals([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'])
const projectKeyParts = Schema.Tuple([
  uppercaseLetter,
  Schema.Array(Schema.Literals([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']))
    .check(Schema.isLengthBetween(1, 8)),
])

it('the two Jira URL forms of the same comment produce the same key', () => {
  assert.equal(canonicalDedupeKey(longForm), canonical)
  assert.equal(canonicalDedupeKey(shortForm), canonical)
})

it.prop(
  'Jira comment canonicalization holds across generated issue and comment ids',
  [
    projectKeyParts,
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ],
  ([[first, rest], issueId, commentId]) => {
    const projectKey = `${first}${rest.join('')}`
    const issue = `https://example.atlassian.net/browse/${projectKey}-${issueId}`
    const expected = `${issue}?focusedCommentId=${commentId}`

    assert.equal(
      canonicalDedupeKey(
        `${issue}?focusedCommentId=${commentId}&sourceType=mention&page=comment-panel#comment-${commentId}`,
      ),
      expected,
    )
    assert.equal(canonicalDedupeKey(`${issue}#comment-${commentId}`), expected)
  },
)

it('a hash-only comment link matches a focusedCommentId link', () => {
  const hashOnly = 'https://example.atlassian.net/browse/ABC-123#comment-100'
  assert.equal(canonicalDedupeKey(hashOnly), canonical)
})

it('different focused comments on the same issue stay distinct', () => {
  const other = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=200'
  assert.notEqual(canonicalDedupeKey(other), canonical)
})

it('an issue with no comment is distinct from one with a comment', () => {
  const noComment = 'https://example.atlassian.net/browse/ABC-123'
  assert.equal(canonicalDedupeKey(noComment), 'https://example.atlassian.net/browse/ABC-123')
  assert.notEqual(canonicalDedupeKey(noComment), canonical)
})

it('different issue keys stay distinct', () => {
  const other = 'https://example.atlassian.net/browse/XYZ-9?focusedCommentId=100'
  assert.notEqual(canonicalDedupeKey(other), canonical)
})

it('GitHub repository root trailing slashes collapse to the no-slash key', () => {
  const repository = 'https://github.com/example/repo'
  assert.equal(canonicalDedupeKey(repository), repository)
  assert.equal(canonicalDedupeKey(`${repository}/`), repository)
})

it.prop(
  'GitHub repository root canonicalization holds across generated identities',
  [naturalNumber, naturalNumber, wellFormedString, wellFormedString],
  ([ownerId, repositoryId, query, fragment]) => {
    const repository = `https://github.com/user-${ownerId}/repo-${repositoryId}`
    const suffix = `?q=${encodeURIComponent(query)}#section-${encodeURIComponent(fragment)}`

    assert.equal(
      canonicalDedupeKey(`${repository}/${suffix}`),
      canonicalDedupeKey(`${repository}${suffix}`),
    )
  },
)

it('GitHub repository root canonicalization preserves query and hash identity', () => {
  const repository = 'https://github.com/example/repo'
  const canonicalVariant = `${repository}?tab=readme#example-section`
  assert.equal(canonicalDedupeKey(`${repository}/?tab=readme#example-section`), canonicalVariant)
  assert.notEqual(canonicalDedupeKey(`${repository}/?tab=issues#example-section`), canonicalVariant)
})

it('GitHub trailing-slash canonicalization stays scoped to repository roots', () => {
  const nestedRoute = 'https://github.com/example/repo/issues/'
  const reservedRoute = 'https://github.com/settings/profile/'
  assert.equal(canonicalDedupeKey(nestedRoute), nestedRoute)
  assert.equal(canonicalDedupeKey(reservedRoute), reservedRoute)
})

it('non-Jira URLs are returned unchanged', () => {
  const url = 'https://example.com/page?utm_source=x#frag'
  assert.equal(canonicalDedupeKey(url), url)
})

it('a Confluence /wiki path on atlassian.net is returned unchanged', () => {
  const url = 'https://example.atlassian.net/wiki/spaces/DOCS/pages/1'
  assert.equal(canonicalDedupeKey(url), url)
})

it('malformed URLs are returned unchanged without throwing', () => {
  assert.equal(canonicalDedupeKey('not a url'), 'not a url')
  assert.equal(canonicalDedupeKey(''), '')
})

it.prop(
  'canonical URL keys are idempotent for arbitrary input',
  [Schema.String],
  ([url]) => {
    const canonicalUrl = canonicalDedupeKey(url)
    assert.equal(canonicalDedupeKey(canonicalUrl), canonicalUrl)
  },
)

function withExtensionId<T>(id: string, fn: () => T): T {
  vi.stubGlobal('chrome', { runtime: { id } })
  return fn()
}

it('Tab Out dashboard variants collapse to a single dedupe key', () => {
  withExtensionId('tab-out', () => {
    const base = 'chrome-extension://tab-out/index.html'
    assert.equal(canonicalDedupeKey(base), base)
    assert.equal(canonicalDedupeKey(`${base}?filter=github`), base)
    assert.equal(canonicalDedupeKey(`${base}?focusFilter=1`), base)
    assert.equal(canonicalDedupeKey(`${base}#frag`), base)
  })
})

it('chrome://newtab/ folds into the Tab Out dashboard key', () => {
  withExtensionId('tab-out', () => {
    assert.equal(
      canonicalDedupeKey('chrome://newtab/'),
      'chrome-extension://tab-out/index.html',
    )
  })
})

it('other Chrome new-tab implementation URLs remain exact', () => {
  withExtensionId('tab-out', () => {
    for (const url of [
      'chrome-search://local-ntp/local-ntp.html',
      'chrome-untrusted://new-tab-page/',
    ]) {
      assert.equal(canonicalDedupeKey(url), url)
    }
  })
})

it('other chrome-extension pages are left unchanged', () => {
  withExtensionId('tab-out', () => {
    const other = 'chrome-extension://tab-out/suspended.html#uri=https%3A%2F%2Fx.com'
    assert.equal(canonicalDedupeKey(other), other)
  })
})
