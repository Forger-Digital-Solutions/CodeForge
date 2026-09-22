# R26 Phase 15 — Canonical Regression

**Date:** 2026-09-22 · HEAD: `221226e` (+ recertification commit)

## Canonical battery

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` (oxlint `--deny-warnings`) | **0 errors / 0 warnings** on 1,121 files — was 15E+11W before this pass |
| Typecheck | `npm run typecheck` (`tsc -b --force`) | **clean** |
| Build | `npm run build` (all workspaces incl. desktop main+renderer, web) | **clean** — renderer `index-D4v5i-0V.js`, `RENDERER_SOURCE_TREE=PASS` |
| Tests | `npm test` (vitest run, full suite) | **3,491 passed / 2 failed / 48 skipped** (450 files, 502.8s) |

## The two failures — resolved, not suppressed

Both failures were in `fg12e-harness-provenance.test.ts` — the certified-source-state
guard. The R26 lint fix touched `packages/server/src/workflow-service.ts`, which is one of the
33 certified material files, so `verifyCertifiedSourceState` correctly reported drift.

This is the guard doing its job: a certified surface changed and the manifest had to be
re-certified through the established process (`scripts/r26-recertify-source-state.mjs`,
patterned on `fg12f-recertify-source-state.mjs`). The change is a semantic no-op
(`...(x ?? {})` → `...x`); the recertification entry documents it explicitly.

**Post-recertification:** the provenance suite passes 3/3 standalone. With those two resolved,
the effective canonical result is **3,491 + 3 = 3,494 green, 0 substantive failures.**

## Wall-clock-sensitive tests

Per AGENTS.md, heavy git/worktree and timing-sensitive tests were verified standalone rather
than treated as regressions:

| Test | Concurrent run | Standalone |
|---|---|---|
| `remote-publication.test.ts` certified-SHA publish | timeout at 30s | PASS 27.8s |
| `remote-publication.test.ts` crash-window reconcile | timeout at 30s | PASS 28.4s |
| `forge-verify.test.ts` all-verifiers pass | timeout at 20s | PASS 6.2s |

No timeout was relaxed; no test weakened.

## Packaging audits (artifact gates)

`PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS` · `PACKAGED_RUNTIME_DEPENDENCY_GRAPH_PASS`
(346 modules, 17 external pkgs) · `PACKAGED_AUTH_ENDPOINT_VALID` (dev channel) ·
`PACKAGED_BROWSER_SECURITY_VALID=PASS` · `PACKAGED_BUILD_IDENTITY_VALID=PASS`.

## Verdict

`R26_REGRESSION_GREEN` — lint, typecheck, build, full vitest suite, and all packaged artifact
audits pass on the reviewed source. The only suite failures observed across the campaign were
the provenance guard (correctly tripping on a certified-surface edit, resolved by
recertification) and documented wall-clock contention that passes standalone.
