# CodeForge R75 Final Report

**Status: `CODEFORGE_R75_PARTIAL`**

R75 delivered the Planner contract repair and shared hourly capacity controls, and the Windows packages now build with all three packaging audits passing. The live Free route did not pass exact-model qualification: BlockRun served a different model during the coding probe, which CodeForge rejected. No additional Coder, real-task completion streak, or organic Coder failover is claimed.

## Repository

- Branch: `codex/r75-reliable-free-autonomous-coding`
- Worktree: `G:\CodeForge\worktrees\r75-reliable-free-autonomous-coding`
- R74 baseline: `230510131f40532ad8a402bdef131c3b8c637436`, aligned with the R74 remote branch at start.
- Implementation commit `8899a028681e5bbf5a57af78c138cfe58dbc4f71` is pushed to the R75 branch; this report and the live evidence are included in the follow-up branch update.
- R74 historical evidence remains intact. The ten-attempt classification is in [R75-R74-ROOT-CAUSE-CLASSIFICATION.json](R75-R74-ROOT-CAUSE-CLASSIFICATION.json).

## Changes delivered

- Added bounded deterministic Planner repair in [planner-contract-repair.ts](../../../packages/server/src/planner-contract-repair.ts). It restores explicit request clauses and runtime verification commands, adds missing mandatory Coder/Reviewer roles when their source requirements are authoritative, and links the Reviewer to all implementation tasks. Duplicate identities, missing dependencies, cycles, and constraint overflow remain fail-closed for the existing single correction attempt.
- Wired repairs into [autonomous-orchestrator.ts](../../../packages/server/src/autonomous-orchestrator.ts) and records each repair as run evidence. A recoverable missing Reviewer now completes the production lifecycle with one Planner call instead of paying for a correction call.
- Corrected BlockRun catalog admission in [blockrun-free.ts](../../../packages/providers/src/blockrun-free.ts): catalog membership is availability evidence, an explicit `available: false` still rejects the model, and explicit zero-cost checks remain required. The official catalog lists currently available models. [BlockRun model catalog](https://blockrun.ai/docs/api-reference/models)
- Extended [capacity-governor.ts](../../../packages/providers/src/capacity-governor.ts) with shared per-provider hourly request accounting, parsing of request limit/remaining/reset headers, model-scoped 429 cooldowns, and a conservative one-minute cooldown when reset information is absent. Kilo is capped at 190/hour and BlockRun at 28/minute and 285/hour, below the published gateway allowances. [R74 capacity evidence](../r74-autonomous-completion-and-free-reliability/R74-FINAL-REPORT.md), [BlockRun rate limits](https://blockrun.ai/docs/rate-limits)

Quota history remains in memory and resets on a full server-process restart. The shared governor remains active across child-worker interruptions within one server process; this change does not add cross-process quota-state persistence.

## R74 failure findings

The 10 attempts ended with 3 completed, 1 failed, and 6 blocked; longest completion streak was 1 and false completions were 0. The largest product defect was avoidable Planner contract rejection: a missing Reviewer caused an authorization failure, and a small feature’s explicit “do not mutate input or modify tests” requirement was absent from structured planning intent. Other blocks came from Planner cancellation with unresolved underlying trigger and real Kilo/Cohere rate limits. A test-creation task correctly stopped when every alternate route was role-ineligible.

The R75 unit regression mirrors the R74 feature plan and shows the original exact constraints and verification commands are retained, while the Reviewer is linked to both Coder tasks. This is fixture evidence, not a live task completion.

## Validation

- Forced workspace typecheck and full workspace build passed.
- Server dependency-graph compile after the final Planner edit passed.
- `npm run security:gate` passed.
- Focused tests passed: Planner repair 5/5, capacity governor 26/26, BlockRun adapter 12/12, and end-to-end deterministic Planner repair 1/1. Machine-readable Vitest results are in this directory.
- The full autonomous-orchestrator file produced 24 passes and one 30-second timeout with a Windows temporary Git cleanup lock. The timed case passed alone with a 60-second limit. The first run is not counted as 25/25 in one invocation.
- After the pushed R75 commit, the desktop main and renderer rebuilt successfully with the matching commit identity. The Windows package and all three post-package audits passed; details and artifact hashes are in [R75-WINDOWS-PACKAGING.json](R75-WINDOWS-PACKAGING.json).

## Free supply and live reliability

- BlockRun terms, privacy, and rate-limit policy checks passed, and the public catalog returned Poolside Laguna XS 2.1 as explicitly Free and coding-capable during qualification. Availability varied across catalog checks.
- The bounded compact suite dispatched two synthetic requests to `poolside/laguna-xs-2.1`. The read/tool probe returned the requested model and passed. The edit probe response identified itself as `nvidia/nemotron-3-super-120b`; the adapter classified this as `MODEL_SUBSTITUTED`, kept every role `NOT_TESTED`, and did not promote Poolside. The later [live catalog snapshot](R75-LIVE-CATALOG-CHECK.json) found no row for the substitute and no currently available Free coding model. The request receipts are [blockrun-compact-1791638168218.json](blockrun-compact-1791638168218.json) and [its request observations](blockrun-compact-observations-1791638168218.json). A preceding [catalog-only check](blockrun-compact-1791638141240.json) stopped before inference because Poolside was then unavailable.
- The live requests used the anonymous public Free endpoint, with no payment credentials; money spent was `$0` and purchased credits consumed were `0`.
- No production coding task was dispatched because no exact-model Coder passed qualification. No additional Coder, three-completion streak, or organic cross-provider failover is demonstrated. Completion acceptance criteria were not relaxed.

## Windows packaging

- The R75 desktop main and renderer rebuilt at commit `8899a028681e5bbf5a57af78c138cfe58dbc4f71`.
- `electron-builder --win` completed from the R75 worktree and produced the Setup and Portable artifacts under `apps/desktop/release`.
- Internal dependency, runtime dependency, and build identity audits passed. The archive identity matched the R75 commit, and the runtime audit scanned 416 modules and 26 external packages.
- Both generated executables are unsigned (`Authenticode: NotSigned`). Neither was executed or installed. The artifacts are for review only; installed lifecycle certification remains incomplete.

## Primary-checkout artifact incident

The first packaging invocation accidentally used `G:\CodeForge\apps\desktop` instead of the R75 worktree. It refreshed the primary checkout’s ignored `apps/desktop/release` outputs, including its existing Setup and Portable executables. The primary checkout already had unrelated tracked and untracked changes; this run did not intentionally edit its source files. The prior ignored package binaries were not backed up and cannot be restored from this run. The final audited R75 packages were built separately under the R75 worktree. This incident is recorded here so the primary-checkout artifact change is explicit.

The detailed checks and receipts are summarized in [R75-VALIDATION.json](R75-VALIDATION.json). The status remains partial because exact-model Free Coder qualification and the live completion/failover gates remain unmet.
