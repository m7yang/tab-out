# Development

Read the sections relevant to build generation, tooling, formatting, or Chrome support. Paths below are relative to the repository root.

## Source And Build

- Use package scripts to build: `pnpm build` runs the manifest and page generators before entry-specific Vite builds, keeping the MV3 service worker standalone. Raw `vite build` does not perform that complete pipeline.
- Manifest source is `src/extension/manifest.ts`. Dashboard generation is `src/index-html.tsx`, beside `src/app.tsx`, with its UTF-8 wrapper in `src/index-html.template.html`. The generator prerenders the same `AppRoot` that the client attaches; see [ADR 0004](../adr/0004-prerender-and-attach-dashboard-shell.md) when changing that boundary.
- For current entrypoints, output paths, and CSS inputs, inspect `scripts/build-extension.ts` and `vite.config.ts`. `pnpm dev` watches native filesystem events; `scripts/watch-build.ts` owns its watched paths.
- The optional macOS integration owns its Spoon under `integrations/hammerspoon/TabOut.spoon/`, native host under `native/bridge-host/`, and read-only diagnostic at `scripts/doctor-macos-integration`. Follow `integrations/hammerspoon/README.md` for setup and acceptance. `pnpm hammerspoon:build` and `pnpm native-host:build` create ignored local artifacts outside the cross-platform extension build.
- Keep `pnpm dev` running while editing source or bundled styles. Refresh the dashboard for UI changes; generated HTML needs a page or extension reload. Manifest, permission, service-worker, or extension package changes need an extension reload in `chrome://extensions`.
- Use `pnpm build:debug` when a local sourcemap is needed.

## Toolchain And Iteration

- Use the Node and pnpm versions pinned by `.node-version` and `package.json#packageManager`. With Mise configured for those version files, `mise install` provisions the tools. Use normal `pnpm` commands once Mise is active, or `mise exec -- pnpm <script>` when shell activation is unavailable.
- pnpm owns installs and the lockfile. Run `pnpm install` when dependencies are missing or `pnpm-lock.yaml` changes. For first-time development setup, see `README.md#development`; browser prerequisites are in [verification.md](verification.md).
- Native Node entrypoints that do not import the browser render graph are checked through `tsconfig.node.json` with NodeNext resolution. Keep their syntax erasable so the pinned Node runtime can execute them directly. The build orchestrator uses the browser-aware root project because it imports the manifest and prerender generators.
- Use `tsc6` only for targeted diagnosis of legacy compiler-API consumers. Retain source syntax those consumers can parse until the bridge can be removed; see [ADR 0006](../adr/0006-run-typescript-7-with-a-typescript-6-api-bridge.md).
- `pnpm test` runs Node tests under `tests/*.test.ts` and Effect-aware Vitest tests under `tests/vitest/**/*.test.ts`. Select `pnpm test:node`, `pnpm test:vitest`, or `pnpm test:vitest:watch` for iteration as appropriate.
- `pnpm verify:quick` is an iteration-only parallel pass. Its checks are defined in `package.json`; it does not replace final verification.
- `pnpm lint:tailwind` runs the official Tailwind language server across repository source documents, including canonical-class suggestions and CSS conflicts. Both verification pipelines include it. Use the repository's configured React Doctor commands; verification already includes its scan.

## Formatting And Diff Hygiene

- ESLint Stylistic is the canonical formatter for JavaScript, TypeScript, and JSX. `pnpm lint` checks formatting without writing; `pnpm format -- <changed-file> [...]` applies layout-only fixes to the files named after `--`.
- During normal work, format only files changed for the current task. Reserve a repository-wide `pnpm format` run for an explicit formatting baseline or formatter upgrade.
- Use trailing commas in multiline comma-separated constructs. Once a construct is multiline, keep one logical item per line when the syntax and existing layout allow it; keep small literals compact.
- Preserve declaration, object-property, test-case, CSS-declaration, and side-effect-import order unless a focused rule documents and enforces canonical sorting. Do not align neighboring code with padding spaces.
- Preserve intentional Markdown hard breaks; prefer `<br>` for new explicit breaks so `git diff --check` can continue to catch accidental trailing whitespace.
- Keep formatter upgrades and formatting-only baselines separate from behavior changes. Inspect the resulting diff for unrelated churn before handoff.
- `.editorconfig` and `.gitattributes` own repository text normalization. Keep generated files and lockfiles under their owning tools rather than formatting them by hand.
- Formatting commands must not stage, unstage, or otherwise change the Git index.

## Chrome Support

`chrome-support.json` owns the approved minimum Chrome major and audit date. The support target is Chrome on Apple silicon Macs; the updater uses the newest `mac_arm64` Stable release that reached 100% rollout, excluding early Stable entries without that evidence. Vite's build target and the manifest's minimum version derive from that policy. Add Browserslist only when a concrete compatibility tool will consume it.

- `pnpm chrome-support:check` is offline and deterministic. It checks the policy, generated manifest, and Playwright's bundled Chromium major. It runs first in `pnpm verify`.
- `pnpm chrome-support:release-check` makes a fresh read-only observation before release or when reviewing the floor. `lastBumpedAt` is audit metadata, not a reason to skip that observation.
- `pnpm chrome-support:bump` makes a fresh observation, raises the policy only when the floor advances, rebuilds output, and checks consistency. A floor advance also requires an `@playwright/test` release bundling that Chromium major. Review the diff; the command does not stage, commit, push, or lower the floor.

[ADR 0003](../adr/0003-rolling-chrome-support-floor.md) owns the policy rationale and exceptions.
