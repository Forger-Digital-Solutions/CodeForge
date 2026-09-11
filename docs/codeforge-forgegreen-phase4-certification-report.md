# ForgeGreen Phase 4 (FG-9) — optimization & efficiency policy certification report

**Generated:** 2026-09-11T08:45:00Z · **Branch:** feat/codeforge-cloud · **HEAD at session start:** 3d5ba374e1ebf140813401c0b4dcbcebdf6a010c

## 1. Verdict

**`CODEFORGE_FORGEGREEN_PHASE4_OPTIMIZATION_CERTIFIED`**

## 2. Repository state

Branch `feat/codeforge-cloud`, HEAD `3d5ba37`, unchanged all session. `git status` at the start of this phase showed only FG-8/FG-8R's own prior uncommitted work — no inherited or unrelated changes. No commits this session, per the standing no-commit policy.

## 3. Optimization architecture

FG-9 is CodeForge's first phase where ForgeGreen may narrowly act, not just measure. The phase numbering was verified, not assumed: `grep -rn "FG-9" docs/forgegreen.md packages/forge-green/src/*.ts` returned zero matches before this phase began, confirming FG-9 as the correct next number.

**What was added:** `optimization-types.ts` (the `ForgeGreenOptimizationDecision`/`ForgeGreenOptimizationReceipt` schema), `optimization-policy.ts` (a versioned, per-kind `GRADUATION_REGISTRY` resolving `OFF`/`SHADOW`/`ACTIVE_SAFE`), `optimization-decision.ts` (construction/finalization with negative-metric rejection and a structural guarantee that a non-`ACTIVE_SAFE` kind can never carry status `APPLIED`), `optimization-candidate-a.ts` (the live-composed builder for Candidate A), `optimization-candidates-shadow.ts` (pure detectors for B/C/D), `optimization-persistence.ts` (two new append-only `WorkItem` kinds through the existing `ISessionPersistence` abstraction).

**What was reused, not reimplemented:**

| Candidate | Existing mechanism composed | New FG-9 code |
|---|---|---|
| A — duplicate read-only tool reuse | FG-1C `DuplicateActionSupervisor` (already active in production) | Only a receipt-construction wrapper around its already-emitted suppression events |
| B — duplicate context page transmission | FG-3D context-page identity concepts | A pure detector, not wired to FG-3's live assembler |
| C — optional prefetch suppression | FG-3's progressive-context/`omittedOptionalPages` concepts | A pure detector, not wired to FG-3's live planner |
| D — verification evidence reuse | FG-5/FG-6 verification-policy validity semantics | A pure detector requiring an explicit ForgeVerify confirmation input; never computes validity itself |

## 4. Shadow results

Candidates B, C, D remain `SHADOW` this phase — detection logic implemented and tested, never wired to alter live execution. `createOptimizationDecision` refuses to let a `SHADOW`-mode decision carry status `APPLIED`; this is enforced by the constructor, not caller discipline. All three detectors are pure functions: `fg9-shadow-mode.test.ts` proves candidate inputs are byte-identical after detection. Invalidation was proven for every §21 adversarial case implemented: content-hash change, workspace-revision change, verification-policy-revision change, dependency/config-state change, and same-path-different-content — each degrades cleanly to "no candidate," never a fabricated reuse. A mixed-evidence false-positive scenario (`fg9-shadow-mode.test.ts` item 22) shows the false-positive rate is reconstructable: 1 genuine duplicate out of 2 pages considered.

## 5. Active-safe optimizations

**Exactly one class graduated: `DUPLICATE_READ_ONLY_TOOL_REUSE`.** The other three remain `SHADOW`, per the phase's own instruction ("if only one is defensible, activate one") — B/C/D would each require new live wiring into context assembly or a ForgeVerify call site, judged out of this phase's risk budget; their detection logic is the natural next-phase wiring target.

Candidate A graduates safely because it introduces **zero new execution-path risk**: FG-1C's `DuplicateActionSupervisor` already suppresses duplicate read-only tool calls in production, unconditionally, with its own certified state-version-bound identity key. FG-9 only wraps its already-emitted suppression events (tool name, identity-key hash, prior-execution id, replayed-output byte length — never content) into a `ForgeGreenOptimizationDecision`/`ForgeGreenOptimizationReceipt`, wired into `agent-runtime.ts` in its own isolated try/catch positioned strictly *after* the FG-8/FG-8R sustainability receipt is already saved.

## 6. Before/after results

Deterministic, zero-network benchmark (`scripts/forgegreen-fg8-benchmark.mjs`, using the `tool_heavy_task` fixture's 4 already-recorded FG-1C suppressions):

```text
Control (naive re-execution, suppressed calls added back):
  tool calls: 31
  wall clock: 15260 ms
  measurementStatus: complete

Treatment (actual, FG-1C suppression ON):
  tool calls: 27
  wall clock: 15200 ms
  measurementStatus: complete

Delta:
  tool calls avoided: 4
  wall clock: -60 ms
  verification outcome: identical
```

Full control/treatment `SustainabilityReceipt`s and the FG-9 decision/receipt are embedded verbatim in `docs/codeforge-forgegreen-fg8-benchmark-fixtures.json`'s `optimizationBenchmark` field. Raw values are always reported alongside any delta — no percentage is presented alone.

## 7. Correctness & verification

`measurementStatus` is `complete` for both control and treatment — identical. `qualityResult: EQUIVALENT` and `survivedValidation: true` on the receipt represent FG-1C's own already-certified guarantee (the replayed prior authoritative result is the exact output a fresh execution against unchanged state would have produced), not a new claim FG-9 invents. `verificationAccounting` is untouched by this optimization path — FG-9 never reruns, skips, or reinterprets verification.

## 8. Prevented work

Attributable and reconstructable only: 4 duplicate read-only tool executions avoided, 1500 bytes of replayed prior output not retransmitted (`fg9-candidate-detection.test.ts` item 26) — never a rounded or guessed figure.

## 9. Energy/carbon

**Unchanged: `INSUFFICIENT_DATA`.** FG-9 reports resource-count reductions (tool calls, bytes, wall-clock) separately and never converts a token/request reduction into an energy figure. Valid: "4 fewer tool dispatches, 60ms faster." Not valid without a defensible power model: any percentage-energy claim.

## 10. Privacy & authority

**Privacy PASS**: `fg9-privacy-authority.test.ts` §31-33 — secret/prompt/source-content-shaped extra fields injected onto raw evidence never appear in a built decision/receipt's JSON.

**Authority PASS**: zero files modified in `packages/eight-bit`, `packages/router`, `packages/workflow`, or `packages/forge-zero` this phase. No decision/receipt field matches a model-selection/approval/verification-verdict/completion-verdict shape (key-absence assertion, §34-37). `fg9-unsafe-mutating.test.ts` proves directly against the real `DuplicateActionSupervisor` that `write_file`/`edit_file`/`run_command` (installs and deployments run through `run_command`) can never be suppressed. The full `packages/server/test` suite (461 tests — real routing, verification, approval, and completion flows) passes unchanged after the live Candidate A wiring.

## 11. Persistence/restart

`fg9-persistence.test.ts`: decision persists (15) and reloads identically; receipt persists (16) and reloads identically; a retried save after a simulated restart never duplicates a decision — content-addressed idempotency via `insertIfAbsent` (17); a post-hoc `INVALIDATED` record stays invalid across reload, never reinterpreted (18); two distinct runs' avoided-tool-execution counts remain separate and are never summed into one record (19).

## 12. Validation

| Suite | Passed | Failed | Skipped |
|---|---|---|---|
| Focused FG-9 (7 forge-green files + 1 server file) | 46 | 0 | 0 |
| `packages/forge-green/test` total (29 files, FG-1…FG-9) | 184 | 0 | 0 |
| Affected packages (sessions/eight-bit/protocol/context/repo-intelligence/tools/workflow) | 384 | 1* | 2 |
| Integration (`packages/server/test`) | 461 | 0 | 3 |
| **Full monorepo suite** | **1952** | **1*** | **36** |

\* Same single pre-existing `better-sqlite3`/`bindings` packaging mismatch documented in the FG-8R certification — reproduced identically a fourth time across this session, confirmed unrelated to any FG-9 file.

- **Typecheck** (2 runs): **PASS**. **Build** (2 runs, incl. Electron + Vite): **PASS**. **Lint**: `NOT_CONFIGURED`.
- Full suite grew 1943 → 1989 total tests (**+46**, exactly the new FG-9 test count). **Zero regressions.**

## 13. Files changed

**58 total this session (Phase 3+4 combined), 15 new this phase**: 6 new source files, 6 modified source files (incl. exporting two existing constants from `duplicate-suppression.ts` for a direct regression test — no behavior change), 8 new test files, 1 new doc. Exact lists in the paired JSON's `implementation` section.

## 14. Remaining limitations

1. Candidates B/C/D are shadow-only — not wired into live context assembly or a live ForgeVerify call site. Their detection/invalidation logic is fully proven; live wiring is the natural next step.
2. Candidate A's benchmark replays the FG-8 fixture's already-recorded suppression counts rather than a brand-new live agent dispatch — the same zero-cash, deterministic-replay methodology FG-8/FG-8R already established as sufficient.
3. Energy/carbon remain `INSUFFICIENT_DATA` — correct, not a gap.

## 15. Next recommendation

Wire Candidates B, C, and D as **passive shadow observers** inside their respective live pipelines (context assembly for B/C, a ForgeVerify call site for D) before evaluating any of them for graduation — this produces real-run false-positive/true-positive evidence (§14 point 5's "compare candidate recommendation against actual execution") rather than only fixture-derived evidence, which is the same evidentiary bar Candidate A needed before FG-9 could trust it. Broader ForgeAuto/ForgeGreen cooperative efficiency routing and real hardware energy telemetry both remain explicitly out of scope until that shadow-observation evidence exists.
