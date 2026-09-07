# Commit-reference hygiene

GitHub parses commit messages as more than inert prose. Issue and pull-request
shorthand can create timeline backlinks, while mention-shaped source tokens can
link to or notify GitHub accounts. Commit messages are immutable after
publication without rewriting their commit and every descendant.

## Commit Preparation

When a commit is requested, stage only one independently verified logical change; keep unrelated fixes separate. Use a Conventional Commit subject with a domain-specific scope such as `page-chip`, `domain-card`, `activation-history`, `working-set`, `suspend`, or `build` rather than a broad bucket like `ui`.

For Codex-authored or Codex-assisted commits, make `Co-authored-by: Codex <noreply@openai.com>` the final non-empty line with no extra blank line afterward. An extra blank line can prevent GitHub from rendering the co-author even when `git interpret-trailers` accepts it.

For an explicitly requested metadata-only commit-message rewrite, preserve author and committer timestamps. Before rewriting published history, create a backup branch. Push rewritten published history only when explicitly requested and only with `git push --force-with-lease`.

## Message policy

Keep GitHub reference and mention syntax out of commit messages, including
examples and source-language vocabulary.

| Avoid in a commit message | Prefer |
| --- | --- |
| `Image #11` | `image 11` |
| `Issue #42` | `issue 42` |
| `PR #1234` | `pull request 1234` |
| `/** @public */` | `the JSDoc public tag` |
| `@theme token` | `Tailwind theme directive` |
| `@property vars` | `CSS property at-rules` |

The checker rejects built-in issue and pull-request forms, direct GitHub issue
or pull-request URLs, and non-email mention shapes. It deliberately allows
emails in trailers, commit SHA citations, and ordinary reference-free numbers.
Do not rely on a backslash or Markdown code span as a bypass.

Put intentional issue linkage and user mentions in a reviewed pull-request or
issue conversation, where the relationship is visible and editable. When an
explicit GitHub URL must remain clickable without creating a backlink, use the
documented `redirect.github.com` form.

## Local enforcement

`pnpm setup:hooks` activates three repository hooks for the current worktree:

- `pre-commit` runs the full verification pipeline;
- `commit-msg` checks the proposed commit message;
- `pre-push` scans every commit newly introduced to the remote and refuses to
  push local `backup/` or `backup-` recovery refs.

The pre-push range uses the exact server object ID for an existing remote ref.
For a new branch, it excludes commits already reachable from that remote's
local tracking refs. Fetch before pushing a new branch when those refs may be
stale.

These are local guardrails, not an authorization boundary: `--no-verify` can
bypass them, and each clone or worktree must activate and contain the hooks.
That tradeoff is intentional for the current single-owner workflow. There is no
Actions check because post-push CI runs only after GitHub has already processed
the commit message.

Legacy worktrees that predate these hook files remain quarantined. Do not push
from one until it has been updated, rebased onto sanitized history, or replaced
with a fresh worktree. They do not need to be cleaned as a prerequisite for an
isolated history rewrite.

## Custom autolinks

`.github/commit-reference-policy.json` records administrator-confirmed custom
autolink prefixes. An empty list with `customAutolinksAudited: false` means the
configuration has not been inspected with repository-administrator access; it
does not prove that the repository has no custom autolinks.

After an administrator audit, add each configured prefix with GitHub's
`keyPrefix` and `isAlphanumeric` values and set `customAutolinksAudited` to
`true`. The same checker will then enforce those prefixes in both local hooks.
