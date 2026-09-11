# ForgeGreen Phase 3 — FG-8R live-measurement closure certification report

**Generated:** 2026-09-11T08:15:00Z · **Branch:** feat/codeforge-cloud · **HEAD at session start:** 3d5ba374e1ebf140813401c0b4dcbcebdf6a010c

This report **supersedes** the earlier FG-8 report as the current certification authority. FG-8's summary is preserved in `revisionHistory` in the paired JSON artifact for traceability.

## 1. Verdict

**`CODEFORGE_FORGEGREEN_FG8R_LIVE_MEASUREMENT_CLOSURE_CERTIFIED`**

## 2. Repository state

Branch `feat/codeforge-cloud`, HEAD `3d5ba37` at session start, working tree clean apart from this work's own uncommitted changes (`git status` re-checked at session start showed only FG-8's own modifications/additions — no inherited or unrelated user changes existed to protect). No commits were made this session, per the standing no-commit policy. No destructive git operations (stash/reset/clean) were used; the one investigation that in a prior session used `git stash` to compare against an unmodified HEAD was avoided this round in favor of non-destructive, direct-inspection methods (reading dependency install scripts and driver-selection source directly — see §9).

## 3. Certification reconciliation

The FG-8R task asked me not to trust the FG-8 report's prose blindly. Three specific claims were independently re-verified:

- **Event count.** The FG-8 certification **JSON** already correctly listed all 8 `forgegreen.*` events (`run_started`, `model_usage_recorded`, `tool_usage_recorded`, `verification_usage_recorded`, `baseline_generated`, `energy_estimated`, `run_finalized`, `measurement_failed`). A chat-summary sentence undercounted them as 7 by omitting `measurement_failed` from an inline list — a prose slip, not an artifact defect. Re-confirmed by direct inspection: all 8 are defined in `packages/protocol/src/workspace-events.ts`, emitted via matching methods in `packages/server/src/workspace-event-adapter.ts`, and all 8 are actually called from `agent-runtime.ts` — none are dead code. **No correction needed to the JSON; this entry documents the verification.**
- **File count.** A prior chat summary said "20 new" while its own breakdown (10+8+1+4) sums to 23 — an arithmetic slip in prose, not in any artifact. Re-derived directly from `git status --short`: FG-8 baseline was 11 modified + 23 new = 34 files; FG-8R added 1 source file and 7 test files, bringing the total to **11 modified + 31 new = 42 files**. The certification JSON now states these counts explicitly under `implementation.fileCounts`.
- **Test counts.** Nothing was copied forward — every number below was captured from actual command output during this session.

## 4. Live cross-receipt wiring

**Key finding:** the FG-8R brief assumed `RouteReceipt`/`FinancialReceipt` (`packages/eight-bit/src/receipts.ts`) were a real authority merely not yet wired. Direct investigation found this is not accurate — `createRouteReceipt`/`createFinancialReceipt` are called **nowhere in the entire repository** outside their own definition file, in production or in tests. They are dead code.

The REAL live authority the production routing path actually builds and persists is:

```
AgentUsage.provider/.model (the model that actually executed, from real provider responses)
        │
        ▼
firewall.getModel(provider, model)  →  live FreeModelRecord (ForgeZero's own verified record:
        │                                costProfile.isFree, accessClass, freeStatus)
        ▼
eightBit.store.listReceipts(sessionId) → filtered to this runId → persisted DecisionReceipt[]
        │                                  (written only on an actual rotation/failover —
        │                                   commonly empty, and that is expected)
        ▼
createSustainabilityReceipt({ live: { freeModelRecord, decisionReceipts } })
        │
        ▼
checkCrossReceiptIntegrity: derives financialClassification from the LIVE record (never
recomputed independently), cross-checks it against the MOST RECENT DecisionReceipt's selected
route, and surfaces any disagreement as measurementStatus:"incomplete" with explicit reason
codes — never silently reconciled.
```

FG-8R wires to this real lifecycle instead of the unused schema, matching the task's own instruction to "use the real existing lifecycle" and "not invent another parallel receipt authority." The `RouteReceipt`/`FinancialReceipt`-shaped inputs remain fully supported (and tested) for forward compatibility should 8-Bit ever construct them live.

Code: `packages/forge-green/src/measurement-normalization.ts` (`normalizeLiveRoutingFinancial`, `RawFreeModelRecordLike`, `RawDecisionReceiptLike`), `packages/forge-green/src/sustainability-receipt.ts` (`checkCrossReceiptIntegrity`'s new `live` parameter), `packages/server/src/agent-runtime.ts` (`persistForgeGreenSustainabilityReceipt`). Tests: `fg8r-live-cross-receipt.test.ts` (7), `fg8r-live-lifecycle.test.ts` (2, full 12-stage lifecycle).

## 5. Live context baseline

Baseline B's eligible population now comes from a bounded, zero-duplication read-model (`packages/forge-green/src/live-context-adapter.ts`, `computeLiveContextPopulation`) over `RepositoryIntelligence`'s already-existing facts:

1. `getCompleteness()` — one cheap existing query → `analyzableFiles` (eligible) vs `skippedFiles` (excluded; repo-intelligence exposes no per-reason binary/generated/gitignored breakdown at this level — reported honestly, not invented).
2. **One** bounded `listFiles({ limit: cap })` call. `QueryPage.truncated` tells the adapter, without a second call, whether that page covered the whole workspace:
   - **Not truncated** (workspace fits the cap): an **exact** sum of every returned file's real stored size — never a sample, never extrapolated — plus a real binary/generated/sensitive breakdown for the population actually seen.
   - **Truncated**: bytes are explicitly `undefined` (no Baseline B byte comparison), rather than computed from an undercounted partial page. **Never fake precision.**

Actual-transmitted bytes/tokens come from `AgentContextMetrics.contextBytes`/`.estimatedInputTokens`, hoisted into module-scope variables in `agent-runtime.ts` so they survive safely to the `finally` block (the original in-function `const contextMetrics` would be in its temporal-dead-zone there after an early failure).

Repository size is never equated with eligible context — the population always states exactly what "full context" means for that receipt. Tested against a **real** `RepositoryIntelligence` instance indexing a real temp workspace (`fg8r-live-context-baseline.test.ts`, 4 tests, both the exact-sum and truncated/unavailable paths) and end-to-end in `fg8r-live-lifecycle.test.ts`.

## 6. Restart/durability proof

`fg8r-live-lifecycle.test.ts`'s second test: builds a live-shaped receipt (real ledger, real `RepositoryIntelligence`, live FreeModelRecord + DecisionReceipt evidence) → finalizes it → persists to a real on-disk SQLite file → closes that persistence instance → opens a **brand-new** `ISessionPersistence` against the same file (a genuine simulated process restart, sharing no in-memory state) → reloads → asserts `receiptSchemaVersion`, `normalizationVersion`, run/session identity, `crossReceiptIntegrity` (route/financial reference + classification), `tokenAccounting`, `baselines` (provenance), `energyEstimate`/`carbonEstimate` (estimator provenance + confidence) are all exactly equal to the pre-restart receipt, and that `generateForgeGreenSummary` regenerates an identical summary. No reinterpretation due to restart.

## 7. Privacy & authority proof

**Privacy** (`fg8r-privacy-regression.test.ts`, 3 tests): a real temp workspace containing a secret API token and a `.env` file is indexed by a real `RepositoryIntelligence` instance; the resulting `ContextComparisonPopulation` and a full receipt built from live evidence carrying an injected secret-shaped extra field are asserted, by full-JSON-serialization scan, to never contain the secret, the file paths, or the variable name — only counts/sizes/classifications survive.

**Authority** (`fg8r-authority-regression.test.ts`, 4 tests): no `packages/eight-bit`, `packages/router`, `packages/workflow`, or `packages/forge-zero` file was modified this revision — only `packages/forge-green` and `agent-runtime.ts`'s own sustainability-receipt method. The new live-authority reads (`firewall.getModel`, `eightBit.store.listReceipts`) are read-only queries against already-computed state; no write, no routing decision, no model selection happens through FG-8R. Structurally: no `SustainabilityReceipt` field name reads as a permission/approval/verdict/routing-decision/verification-pass; a cross-receipt mismatch degrades to advisory `incomplete` status rather than throwing or blocking; `CrossReceiptIntegrityCheck` has no `selected*`/`chosen*`/`picked*` field. The full `packages/server/test` suite (real `AgentRuntime`, mission/delivery/parallel/steering, 455 tests) passes unchanged after the live wiring.

## 8. Energy/carbon status

**Unchanged and correctly still `INSUFFICIENT_DATA` in production.** No hardware/power telemetry source was integrated this phase (explicitly out of scope), and no magic watts-per-token constant was introduced into the production default estimator. `ReferenceHeuristicEstimator` remains a clearly-labeled, non-authoritative test fixture, never wired as the default. This is the correct, non-inflated state per the closure task's own instruction not to force the verdict toward the unrestricted variant.

## 9. Validation

| Suite | Passed | Failed | Skipped |
|---|---|---|---|
| Focused FG-8 (original, 8 files) | 45 | 0 | 0 |
| Focused FG-8R (closure, 7 files) | 26 | 0 | 0 |
| `packages/forge-green/test` total (22 files) | 144 | 0 | 0 |
| Affected packages (`sessions`+`eight-bit`+`protocol`) | 191 | 1* | 2 |
| Integration (`packages/server/test`) | 455 | 0 | 3 |
| **Full monorepo suite** (reproduced 3×) | **1906** | **1*** | **36** |

\* Same single pre-existing failure both times — see §9a.

- **Typecheck** (`tsc -b --force`, root, 3 runs this session): **PASS**.
- **Build** (`npm run build --workspaces --if-present`, root, includes Electron desktop + Vite web builds, 2 runs): **PASS**.
- **Lint**: still `NOT_CONFIGURED` — no ESLint config or `lint` script anywhere in this repository.
- **Full suite growth**: 1917 → 1943 total tests (+26, exactly the new FG-8R test count). **Zero regressions.**

### 9a. The pre-existing sqlite failure — investigated precisely, non-destructively

Root-caused directly (no `git stash`, no reinstall, no repository state touched): `better-sqlite3@12.11.1`'s own install script (`prebuild-install || node-gyp rebuild`) places its compiled addon at `node_modules/better-sqlite3/bin/win32-x64-130/better-sqlite3.node`. `better-sqlite3`'s own `lib/database.js` loads it via `require('bindings')('better_sqlite3.node')` — and the classic `bindings` npm package only searches legacy paths (`build/Release/better_sqlite3.node` and similar), never the `bin/<platform>-<abi>/` layout `prebuild-install` actually used. This is a **packaging/install-path mismatch** between two dependencies, not a Node ABI mismatch (both reference ABI 130) and not related to any FG-8/FG-8R file.

It **does not affect FG-8/FG-8R's own correctness**: `packages/sessions/src/sqlite.ts` prefers Node's built-in `node:sqlite` (present in this environment, Node v24.19.0) and falls back to `better-sqlite3` only when `node:sqlite` is unavailable (documented reason: the Electron desktop app currently bundles Node 20.x, which lacks `node:sqlite`). Every FG-8/FG-8R test that persists data — including every restart/rehydration/duplicate-finalization test in this closure phase — uses the default driver and never touches this code path. Only the one test that explicitly forces `driver: "better-sqlite3"`, specifically to test that alternate backend in isolation, is affected. **Classification: pre-existing, environmental, confirmed unrelated to FG-8/FG-8R.**

## 10. Files changed

**42 total** (verified directly from `git status --short`): 11 modified, 31 new. FG-8R's own contribution this revision: 1 new source file (`live-context-adapter.ts`), 7 modified source files, 7 new test files, plus the certification/contract docs and the benchmark artifact regenerated. Exact lists are in the paired JSON's `implementation` section.

## 11. Remaining limitations (real, not hidden)

1. Live financial classification is `unavailable` for a run that completes with no successful model call (nothing to look up) — inherent, not a defect.
2. Live Baseline B bytes are `unavailable` for any workspace larger than the bounded `listFiles` cap (default 5000 files) — by design, to avoid fake precision.
3. No real hardware/GPU telemetry adapter exists — interface-only, explicitly out of scope this phase.
4. `context_waste` is never emitted — no defensible per-run heuristic exists yet, explicitly out of scope for this closure task.
5. Energy/carbon remain `INSUFFICIENT_DATA` in production — correct, not a gap to close here.

## 12. Phase 4 readiness

**`READY_FOR_FORGEGREEN_PHASE4_OPTIMIZATION`**

Both mandatory closure targets (live `RouteReceipt`/`FinancialReceipt`-equivalent wiring, live Baseline B context population) are closed against real production authorities, not synthetic accounting — and closing them surfaced and fixed two genuine correctness bugs (a receipt-id collision risk under retry, and an unguarded negative-byte input) that would otherwise have quietly undermined trust in any future optimization claim built on this data. The measurement chain — from live routing/financial evidence and live repository-intelligence facts, through normalization, waste taxonomy, baselines, and energy/carbon provenance, to durable append-only persistence proven across a real simulated restart — is now demonstrably connected to CodeForge's real execution path, not only to hand-built fixtures. Energy/carbon remaining `INSUFFICIENT_DATA` does not block this readiness per the task's own success criteria.
