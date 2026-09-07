# ForgeGreen FG-4 Certification Report

**Phase:** ForgeGreen FG-4 — Structural Blast Radius & Risk-Aware Escalation
**Repository:** `G:\CodeForge`
**Starting HEAD:** `39f56e0` (`FG3_PASS`)
**Status:** `FG4_PASS` — canonical FG-3-compatible certification passed; the noncanonical single-fork stress topology reproduces the same pre-existing cross-file isolation failures on pristine FG-3 and FG-4

## Initial State

- Branch: `feat/codeforge-cloud`.
- The FG-3 baseline was committed and clean at `39f56e0`.
- FG-3 evidence was preserved: 216 test files, 1,641 tests, zero failures/skips, passing typecheck/build, and the 1M+ LOC context benchmark.
- WSL2 PostgreSQL 16.15 was available through the existing TCP test connection; local peer authentication was not used.
- FG-4 began from the clean committed FG-3 state. No destructive Git operation or remote operation was used.

## Architecture Audit

FG-4 extends the existing architecture rather than creating a parallel risk engine:

- **FG-2 input:** `RepositoryIntelligence.getImpactCandidates`, dependency/dependent edges, call graphs, candidate tests, parser status, edge provenance, and `COMPLETE`/`PARTIAL`/`UNKNOWN` completeness.
- **FG-3 input:** `ContextLevel` and `ContextPlanner`; FG-4 only recommends breadth and the planner remains responsible for page construction and token capacity.
- **FG-1 substrate:** `canonicalCacheKey` and the existing ForgeGreen cache/ledger conventions; no risk-specific database was added.
- **8-Bit integration:** `capabilityGuidance` is an optional minimum role hint. 8-Bit still performs hard ForgeZero eligibility, health, reliability, exact-pin, and route ranking.
- **Existing impact path:** the server `repo_impact` tool keeps its legacy candidate fields and adds the richer FG-4 result.
- **Genuine gaps closed:** missing categorical risk/analyzability output, explicit identity-aware receipts, dynamic/unknown conservative handling, capability/context recommendations, and measured risk telemetry.

## Implementation

### Structural Blast Radius

`packages/forge-green/src/risk.ts` returns changed targets, direct and transitive dependents, callers, callees, candidate tests, package ownership, public interfaces, dynamic constructs, unresolved relationships, edge evidence, and graph completeness. Static and heuristic/unresolved relationships remain distinguishable; an empty candidate set is not treated as proof of no impact.

### Analyzability

The deterministic classes are `HIGH`, `MODERATE`, `LOW`, and `UNKNOWN`. Parser fallback/error/skipped files, dynamic calls, unresolved dependencies, ambiguity, traversal truncation, and heuristic relationships lower the class. An unavailable or not-ready index produces `UNKNOWN` rather than fabricated precision.

### Risk Classification and Reason Codes

The deterministic classes are `LOCAL`, `LIMITED`, `CROSS_MODULE`, `CROSS_PACKAGE`, `SYSTEMIC`, and `UNKNOWN`. Reasons include public/shared interface changes, dynamic dispatch, unresolved dependencies, generated/configuration/dependency/migration boundaries, ambiguity, parser failure, traversal truncation, test-candidate limitations, and high-confidence static graph evidence. The policy is inspectable and does not use an LLM, model prestige, or repository prose.

### Change Classification

The advisor accepts explicit `implementation`, `signature`, `public_api`, `type`, `config`, `dependency`, `migration`, `rename`, `delete`, `new_api`, `test`, `documentation`, and `generated` kinds, with deterministic path-based inference when no explicit kind is supplied. Signature/public API/type changes widen even when export metadata is sparse; configuration, package/dependency, migration/schema, generated, rename, and delete boundaries are conservative.

### Dynamic and Unknown Handling

Call-graph dynamic imports, computed calls, event-like unresolved behavior, ambiguous targets, parse failures, unsupported languages, missing targets, and incomplete graph traversal preserve an explicit unresolved/dynamic record and lower analyzability. Unknown is never zero and failures degrade to an `UNKNOWN`/`PLANNER` recommendation.

### Identity, Cache, and Freshness

Each result carries namespace, workspace, content generation, graph generation, changed-file hashes, change identity, graph identity, analyzer version, and policy version. Graph-scoped cache keys use the graph generation so valid comment-only reuse is possible; returned change identity still changes when dirty content changes. Structural graph changes advance the graph identity and reject stale impact reuse. Cache entries contain structured results/receipts only, never raw source or secrets, and namespace is preserved.

### Receipts and Ledger

Every result includes a compact `structural_risk_receipt` with counts, reason codes, risk/analyzability, recommended context/capability, identity, and cache state. The existing ForgeGreen ledger records measured risk analyses, cache hits/misses, role escalations, and context expansions. These are operational observations, not carbon claims and not authority decisions.

## FG-2 Integration

- Impact candidates and direct graph edges come from the existing Repository Intelligence implementation.
- `COMPLETE`, `PARTIAL`, and `UNKNOWN` remain separate from context breadth and risk class.
- Edge provenance and heuristic/test-candidate limitations remain visible.
- Generation and graph-generation semantics preserve dirty-tree correctness, comment-only graph reuse, cross-session/worktree identity, and namespace isolation.
- Runtime observations remain advisory and distinguishable by run/revision; they do not manufacture static completeness or justify a narrow classification circularly.

## FG-3 Integration

FG-4 emits `recommendedContextLevel` without inserting context itself. The context planner accepts this as `minimumLevel`; a recommendation of `L3` can add bounded module ownership/dependency context when capacity allows, while the planner still preserves the mandatory kernel and reports capacity truncation. A small local high-analyzability change remains `L1`; cross-module advice recommends `L3`; cross-package/systemic/unknown advice broadens further without forcing `L7` or bypassing model capacity.

## 8-Bit Integration

FG-4 recommends only a capability class: `FAST_WORKER`, `CODER`, `REASONER`, or `PLANNER`. 8-Bit consumes an optional `capabilityGuidance.minimumRole`, applies its own hard role contract and route ranking, and returns bounded `FG4_CAPABILITY:*` evidence. FG-4 does not select a provider, model ID, pricing class, or health route. An exact pinned role can surface `capabilityMismatch`; no pin is replaced.

## Authority Proof

FG-4 is advisory information delivery. It cannot:

- grant a permission or satisfy an approval;
- declare verification sufficient or implement verification levels;
- call or influence `evaluateCompletion` as an authority input;
- certify completion, publication, or delivery readiness;
- reset no-progress/duplicate-action state.

The Completion Gate test supplies a best-case `LOCAL`/`HIGH` advisory shape while verification is unconfigured and confirms the canonical outcome remains `blocked` with `verification_not_run`. FG-5 verification policy and completion-policy changes were not implemented.

## Prompt-Injection Proof

The risk fixture contains repository prose claiming `LOCAL`, no callers, `FAST_WORKER`, cosmetic scope, and no verification. Classification is determined from graph/parser/change facts, not prose; the test confirms the prose cannot lower risk or grant authority.

## Dynamic-Code Proof

A supported TypeScript fixture with a dynamic import produces dynamic constructs, `DYNAMIC_DISPATCH`, unresolved advisory evidence, lower analyzability, and conservative cross-module/unknown risk. Static neighbors remain reported rather than being erased.

## Steer, Revision, and Parallel-Scope Proof

Risk identity includes task/change content and graph/content generations, so an authoritative steer that changes a structural target must be analyzed under a new identity. A comment-only graph-preserving edit may reuse structural work but receives a different dirty-change identity. Unknown overlap is conservative: `parallelism.safe` is true only for multiple high-analyzability local scopes; all other cases remain non-independent advice. Historical steers are not replayed by this layer.

## Cache and Reuse Proof

The focused cache test proves same-identity reuse, changed dirty content identity, graph-scoped comment-only reuse, and no raw-source receipt. The existing FG-2/FG-3 cache tests continue to own canonical namespace, cross-session/worktree, corruption, and content-addressed guarantees.

## Efficiency Evidence

Only measured operational values are reported:

- Focused FG-4/FG-3/8-Bit/Completion battery: 4 files, 42 tests, all passed.
- Risk telemetry is measured by ledger event counts (`riskAnalyses`, `riskCacheHits`, `riskCacheMisses`, `riskRoleEscalations`, `riskContextExpansions`); no energy/carbon conversion is claimed.
- No pre-FG-4 risk-analysis baseline was measured, so no hypothetical savings number is presented.
- FG-3’s certified 1M+ LOC context evidence remains the context baseline: 1,000,000 LOC, 1,001 files, 50.6 MB indexed source, 38,038 initial context bytes, 15,348 estimated tokens, 287 ms planning, and 1,330.5x byte reduction.

## Large-Repository Proof

The existing 1M+ LOC harness remains the authoritative large-repository context proof. FG-4’s bounded algorithm uses indexed impact traversal and does not turn a localized internal edit into a full-repository prompt or strongest-role requirement when the graph is complete and local. A central interface or incomplete/dynamic boundary widens advice by structural evidence rather than blindly sending the repository.

## Regression Proof

### FG-1

Existing ForgeGreen cache, ledger, prompt-cache, compression, duplicate-suppression, and no-progress tests remain the regression authority. FG-4 adds only the `risk_analysis` ledger mechanism and uses the same observational boundary.

### FG-2

Existing Repository Intelligence symbol/call/impact, dirty-tree, provenance, completeness, cache, and large-repository tests remain the regression authority. FG-4 consumes these APIs without changing their authority semantics.

### FG-3

Context kernel, progressive levels, page reuse, pull planning, budget, prefetch, model-aware capacity, handoff, and large-repository tests remain the regression authority. The new planner minimum-level test confirms bounded L3 delivery.

### 8-Bit

Role eligibility, route ranking, health/quota, exact pin, failover, handoff, and restart tests remain the regression authority. The new guidance test confirms role guidance is handled by 8-Bit independently.

### CF-17 / CF-07

Steering, approval, restart, ForgeVerify replan, parallel scope, duplicate, and no-progress tests remain authoritative; FG-4 does not introduce a completion or verification policy.

### PostgreSQL

Real PostgreSQL runtime, migration namespace, cloud-db, ledger, 8-Bit persistence, restart, and two-client suites are required for final certification and are recorded with the final suite results.

## Full Certification

### Serial Test Lifecycle Investigation

- Earlier timed-out diagnostic wrappers left abandoned Vitest workers and certification-owned child processes; those were cleaned before this continuation, without touching unrelated user processes.
- The delivery determinism case had a real teardown race: three asynchronous `ISessionPersistence.close()` calls were not awaited. The existing repair remains in `packages/server/test/delivery-certification.test.ts`, and delivery passed `14/14` in three clean processes.
- The reported sequence `fg2-certification.test.ts → hardening-adversarial.test.ts → delivery-certification.test.ts` passed as one fork (`3` files / `93` tests / `45.345–45.749s`) in five consecutive stress passes (`3` files / `93` tests each). All six ordered pairs also passed in fresh processes.
- No remaining FG-4-specific lifecycle leak was reproduced; the broader one-fork serial run instead failed in unrelated cloud/publication suites. The first failures were `direct-byok-cloud-outage.test.ts` and `cloud-adversarial-security.test.ts`, with undefined HTTP responses, plus unrelated publication expectations and a best-effort SQLite `statement has been finalized` warning.

### Test Topology Reconciliation

- The committed FG-3 certification report records the literal canonical command:
  ```powershell
  $wslIp = (wsl -e hostname -I).Trim().Split(' ')[0]; $env:CODEFORGE_TEST_POSTGRES_URL="postgres://postgres:postgres@$($wslIp):5432/postgres"; npx vitest run --fileParallelism=false
  ```
- `vitest.config.ts` does not override `pool`, `maxWorkers`, `minWorkers`, or `isolate`; therefore `--fileParallelism=false` serializes files while retaining Vitest's normal isolated worker topology. It is not equivalent to a persistent single fork.
- The diagnostic command was `npx vitest run --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot`.
- A pristine detached worktree at `39f56e0` was run with that exact diagnostic command and live PostgreSQL. FG-3 baseline: `33` failed files, `133` failed tests, `183` passed files, `1,495` passed tests, `13` skipped tests, `563.36s`.
- The FG-4 tree was run with the same diagnostic command. FG-4: the exact same `33` failed files and exact same failure set, `133` failed tests, `184` passed files, `1,504` passed tests, `13` skipped tests, `602.04s`. The one additional file and nine additional tests are FG-4 coverage; there were no FG-4-only failing files.
- The shared failures were cloud/auth, publication, workflow, server integration, and UI execution-mode suites, dominated by undefined cloud responses, lease/workflow contention, and provider-unavailable errors. This establishes `NONCANONICAL_ONE_FORK_ISOLATION_STRESS_LIMITATION`, not an FG-4 regression.
- The earlier `212` passed files / `1,602` passed tests observation came from `npm test -- --reporter=dot` without a recorded explicit PostgreSQL environment; it also reported five skipped files and 32 skipped tests. It was an incomplete intermediate run, not the historical certification command. The final canonical run below executed all discovered files and mandatory gates with no skips.

- Focused tests: 22 files / 158 tests passed in the final FG-labeled battery; the authoritative full suite below also passed every focused test.
- Expanded focused regression: 13 files / 117 tests passed (inherited evidence).
- Runtime integration regression: 4 files / 8 tests passed in the final targeted run; inherited runtime battery remains 11 files / 31 tests passed.
- Delivery certification: 14/14 passed in three consecutive clean processes.
- PostgreSQL battery: 8 files / 72 tests passed, including migration namespace collision, cloud-db parity, FG-1 ledger, 8-Bit persistence, CF-17 restart/recovery, and two-client authority.
- Canonical full suite: 217 files / 1,650 tests passed, 0 failures, 0 skips, `954.14s` (~15.9 minutes), using the historical file-serial/default-isolation topology and live PostgreSQL 16.15.
- One-fork diagnostic limitation: both FG-3 baseline and FG-4 failed the same 33 files / 133 tests; this topology is not the certified contract.
- Typecheck: passed (`npx tsc -b --force`).
- Production build: passed (`npm run build`).
- `git diff --check`: passed.

## Documentation

- Updated `docs/forgegreen.md` with the FG-4 architecture, advisory boundary, identity/cache semantics, FG-3/8-Bit integration, and ledger behavior.
- Created this `docs/fg4-certification-report.md`.

## Repository State

- Final HEAD is `41e0168` (`implement ForgeGreen FG-4 structural risk analysis`).
- The reviewed FG-4 source, tests, documentation, lockfile, and delivery teardown repair are committed; the worktree is clean.
- Remote operations: none.
- FG-5 Verification Policy remains next and is not implemented in this phase.
