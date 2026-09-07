# AGENTS.md -- Tab Out Coding Agent Guide

Tab Out is a Chrome Manifest V3 extension. Use `README.md` for product and installation guidance.

## Working Contract

- Check the current code path before changing or documenting behavior. Keep edits within the requested task and preserve unrelated dirty files.
- Check `git status --short` before edits and before handoff. Leave changes unstaged unless the user requests staging or a commit. Amend, rewrite history, or push only when explicitly requested.
- Edit runtime source under `src/`. The unpacked extension is `extension/`; regenerate `extension/dist/*`, `extension/index.html`, and `extension/manifest.json` through `pnpm build` or `pnpm verify`. Hand-edit generated output only for emergency diagnosis. Include legitimate generated changes in the ready-to-commit diff.
- Before changing dashboard grouping, sources, cards, tab actions, history, Working Set, filtering, startup/hydration, or interactions, read the relevant `CONTEXT.md` rules. Update that contract in the same patch for intentional durable behavior changes; copy tweaks, CSS-only polish, experiments, and internal refactors do not require contract changes. Put decision rationale in a focused `docs/adr/` record.
- Tab Out is unavailable in Incognito. Private browsing data must never enter shared extension storage.
- Use neutral examples in comments, tests, fixtures, and documentation. Replace private URLs, customer domains, tenants, accounts, project/space/entry IDs, route paths, titles, and screenshot labels before committing a real repro. Public product hosts may appear in implementation code when a feature depends on them; test data must still use generic tenants, paths, IDs, and titles.

## Completion And Verification

Finish the requested behavior, run the applicable checks, fix failures caused by the change, and rerun affected checks before handoff. Continue already-authorized local work through verification without asking for approval at each step. Report a concrete blocker when a required check cannot be completed.

For code, UI, extension, or macOS integration changes, use the relevant rows in [verification.md](docs/agents/verification.md). Composite commands already include `pnpm verify`; select the appropriate combination once for the final patch. The pre-commit hook still runs its required verification when a commit is requested.

For docs-only changes, check the edited references and run `git diff --check`; application suites are unnecessary unless the documentation change also changes executable behavior.

## Version-Sensitive Work

- When changing Effect code or diagnosing an Effect API, consult `node_modules/effect/AGENTS.md` and only the relevant examples in `node_modules/effect/ai-docs/` or source in `node_modules/effect/src/`. For scoped packages, use the corresponding `node_modules/@effect/<package>/` documentation and source. Install from the lockfile when dependencies are missing. Keep all Effect packages at the same exact version; the installed packages are authoritative, so avoid a second checkout under `.repos/`.
- TypeScript 7's `tsc`, exposed by `@typescript/native`, owns typechecking. The `typescript` dependency supplies the TypeScript 6 compiler API for legacy consumers. Preserve this bridge and compatible source syntax until those consumers migrate; consult [ADR 0006](docs/adr/0006-run-typescript-7-with-a-typescript-6-api-bridge.md) when changing compiler dependencies.

## Task-Specific References

Read the relevant section when its task applies.

| Task | Guidance |
| --- | --- |
| Build generation, watching, Node scripts, toolchain setup, or formatting | [development.md](docs/agents/development.md) |
| React components/hooks, shared UI primitives, styling, or UI selectors | [ui.md](docs/agents/ui.md), including React Compiler identity exceptions |
| UI, browser, extension, or native integration verification | [verification.md](docs/agents/verification.md), including real-Chrome evidence requirements |
| Release preparation or Chrome compatibility changes | [Chrome support](docs/agents/development.md#chrome-support) and [ADR 0003](docs/adr/0003-rolling-chrome-support-floor.md) |
| A requested commit or history rewrite | [Commit preparation and reference hygiene](docs/agents/commit-reference-hygiene.md) |
| Creating or reading local issues/specs under `.scratch/<feature>/` | [issue-tracker.md](docs/agents/issue-tracker.md) |
| Triaging an issue | [triage-labels.md](docs/agents/triage-labels.md) |
| Domain terminology, behavior, or architecture changes | [domain.md](docs/agents/domain.md); read only the relevant contract sections and ADRs |
| Installation or onboarding | `README.md`: “Install with a coding agent” and “Manual Setup” |
| macOS integration installation, diagnosis, permissions, or live acceptance | [Hammerspoon integration guide](integrations/hammerspoon/README.md) |
| Dashboard geometry or fixture-based inspection | [debugging-the-dashboard.md](docs/debugging-the-dashboard.md) |
| Looking up completed engineering work | [engineering-change-ledger.md](docs/engineering-change-ledger.md) |
