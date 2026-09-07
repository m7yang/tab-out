# Verification

Choose checks for the behavior being changed. Paths below are relative to the repository root.

## Select The Final Pass

Run the base pipeline once for the final patch together with the applicable browser and native lanes. `verify:browser` and `verify:extension` already include `pnpm verify`; use either composite in place of a separate base pass.

| Change or required coverage | Checks |
| --- | --- |
| Docs only | Check edited references and run `git diff --check`. |
| Code without an applicable browser/native lane | `pnpm verify`. |
| UI or layout | `pnpm verify` plus the relevant `pnpm test:browser:smoke`, `pnpm test:browser:layout`, or `pnpm test:browser:first-paint` coverage. Use `pnpm verify:browser` when the complete HTTP-fixture suite is needed. |
| Extension APIs, shortcuts, service worker, tabs/windows, new-tab override, or focus | `pnpm verify:extension` for the complete non-benchmark packaged-extension suite. |
| Both UI/layout and extension behavior | `pnpm verify:extension` plus the relevant HTTP-fixture browser checks. If the complete HTTP-fixture suite is needed, use `pnpm verify:browser` followed by `pnpm test:extension`. |
| Native Placement Bridge, macOS placement, or private-focus behavior | Add both `pnpm native-host:test` and `pnpm hammerspoon:test` on macOS to the applicable checks above. |
| macOS installer or setup diagnostic | Add `pnpm hammerspoon:test` and a focused run of `scripts/doctor-macos-integration [hammerspoon-config-directory]`. The diagnostic is read-only; it does not replace user-observed live acceptance. |

During iteration, use affected tests or `pnpm verify:quick`. After a fix, rerun affected checks and complete any outstanding checks for the final patch. A passing full pipeline does not need another run on unchanged inputs just because another instruction names it.

For a requested commit, the pre-commit hook still runs `pnpm verify` as a separate required pass. Enable repository hooks once per clone/worktree with `pnpm setup:hooks`.

## Browser Harness

- Install the bundled browser once with `pnpm exec playwright install chromium`.
- The Playwright harness uses its bundled Chromium at the declared minimum Chrome major. The HTTP-fixture harness owns its local server and does not reuse another worktree's process. Set `TAB_OUT_PLAYWRIGHT_PORT` for concurrent worktree runs.
- `pnpm test:browser` and `pnpm test:browser:all` run every HTTP-fixture browser spec. Use focused smoke, layout, or first-paint scripts for relevant iteration coverage; select the complete suite when broader coverage is required.

## Live QA And Evidence

- For UI/layout changes, inspect the real Chrome page visually when practical and explain any skipped browser verification.
- For live Tab Out behavior, inspect the real Chrome extension page. In-app browsers and localhost/file harnesses can render the shell but cannot prove real `chrome.*`, service-worker, tab/window data, shortcuts, new-tab overrides, or extension-page focus behavior.
- Use available browser or native-app controls for visible real-Chrome checks. Prefer a working Chrome DevTools/CDP endpoint when DOM, console, service-worker, or network evidence is needed.
- After packaged-extension tests, prefer real Chrome inspection for extension APIs, profile behavior, and focus; packaged Chromium cannot prove every live case.
- Label harness-only evidence as limited. For macOS setup and live acceptance, follow `integrations/hammerspoon/README.md` from the repository root.
