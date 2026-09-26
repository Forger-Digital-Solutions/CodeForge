# R36 — Certification

Date: 2026-09-26
Branch: `codex/r29-release-closure`

## Verification results

| Check | Result |
|---|---|
| `npm run build` (all workspaces incl. desktop renderer + web bundle) | PASS (exit 0) |
| `npm run typecheck` (`tsc -b --force`, whole repo) | PASS (exit 0) |
| `@codeforge/ui` vitest | 24 files / **337 tests** PASS (baseline was 325) |
| `npm run lint` (oxlint) | 5 errors — ALL pre-existing in untouched files (`packages/server/test/release-status.test.ts`, `packages/plugins/test/marketplace.test.ts`, `scripts/r33-live-cross-pool-migration.mjs`); none in R36-touched code |
| Playwright visual QA | PASS — 8 screenshots in `screenshots/`; only console error is harness `favicon.ico` 404 |
| Live `forge serve` + web harness | PASS — real send → turn lifecycle → honest status surfaces |

## Contract compliance

- Zero backend contract changes; all new rendering consumes frozen R35 events.
- No completion-gate bypass; terminal/parked/failed states preserved honestly.
- No paid/local inference paths touched.

## Not certified this slice (honest gaps)

- Packaged Electron desktop build not rebuilt/e2e'd (renderer bundle builds cleanly).
- Light theme, narrow-viewport, and full keyboard/focus traversal passes not performed.
- Demo-mode feed quirk documented in R36-PLAYWRIGHT.md (backend follow-up).
- Settings/models surfaces untouched (existing R35-era surfaces still govern).

## Files changed

`packages/ui/src/`: timeline.ts, Conversation.tsx, session-activity.ts, Inspector.tsx,
WorkspaceApp.tsx, Navigation.tsx, FileExplorer.tsx, DiffViewer.tsx, activity-icons.tsx,
emoji-assets.ts, workspace.css. Tests: timeline.test.ts, conversation-tool-grouping.test.ts.
Harness: apps/web/src/qa.tsx, apps/web/vite.config.ts (dev-proxy auth header via env).
Minor: tests/evidence/qualification-fixtures/index.ts (`any`→`unknown`).
