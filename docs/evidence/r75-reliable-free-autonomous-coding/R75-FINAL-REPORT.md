# CodeForge R75 Final Report

**Status: `CODEFORGE_R75_BLOCKED`**

R75 delivered local planner and capacity fixes, but the required live reliability gates could not be completed in this environment. DNS resolution failed for the BlockRun catalog and GitHub packaging helper. No live inference ran, so no new Coder qualification, three-task streak, or organic Coder failover is claimed.

## Repository

- R75 branch: `codex/r75-reliable-free-autonomous-coding`
- Worktree: `G:\CodeForge\worktrees\r75-reliable-free-autonomous-coding`
- R74 baseline: `230510131f40532ad8a402bdef131c3b8c637436`, aligned with the R74 remote branch at start.
- The dirty primary checkout and protected projects were left unchanged.
- R74 historical evidence remains intact. The ten-attempt classification is in [R75-R74-ROOT-CAUSE-CLASSIFICATION.json](R75-R74-ROOT-CAUSE-CLASSIFICATION.json).

## Changes delivered

- Added bounded deterministic Planner repair in [planner-contract-repair.ts](../../../packages/server/src/planner-contract-repair.ts). It restores explicit request clauses and runtime verification commands, adds missing mandatory Coder/Reviewer roles when their source requirements are authoritative, and links the Reviewer to all implementation tasks. Duplicate identities, missing dependencies, cycles, and constraint-overflow remain fail-closed for the existing single correction attempt.
- Wired repairs into [autonomous-orchestrator.ts](../../../packages/server/src/autonomous-orchestrator.ts) and records each repair as run evidence. A recoverable missing Reviewer now completes the production lifecycle with one Planner call instead of paying for a correction call.
- Corrected BlockRun catalog admission in [blockrun-free.ts](../../../packages/providers/src/blockrun-free.ts): catalog membership is availability evidence, an explicit `available: false` still rejects the model, and explicit zero-cost checks remain required. The official catalog API documents that it returns currently available models; the live endpoint was unreachable here. [BlockRun model catalog](https://blockrun.ai/docs/api-reference/models)
- Extended [capacity-governor.ts](../../../packages/providers/src/capacity-governor.ts) with shared per-provider hourly request accounting, parsing of request limit/remaining/reset headers, model-scoped 429 cooldowns, and a conservative one-minute cooldown when reset information is absent. Kilo is capped at 190/hour and BlockRun at 28/minute and 285/hour, below the published gateway allowances. [R74 capacity evidence](../r74-autonomous-completion-and-free-reliability/R74-FINAL-REPORT.md), [BlockRun rate limits](https://blockrun.ai/docs/rate-limits)

Quota history remains in memory and resets on a full server-process restart. The shared governor remains active across child-worker interruptions within one server process; this change does not add cross-process quota-state persistence.

## R74 failure findings

The 10 attempts ended with 3 completed, 1 failed, and 6 blocked; longest completion streak was 1 and false completions were 0. The largest product defect was avoidable Planner contract rejection: a missing Reviewer caused an authorization failure, and a small feature’s explicit “do not mutate input or modify tests” requirement was absent from structured planning intent. Other blocks came from Planner cancellation with unresolved underlying trigger and real Kilo/Cohere rate limits. A test-creation task correctly stopped when every alternate route was role-ineligible.

The current R75 unit regression mirrors the R74 feature plan and shows the original exact constraints and verification commands are retained, while the Reviewer is linked to both Coder tasks. This is fixture evidence, not a live task completion.

## Validation

- Forced workspace typecheck: passed.
- Full workspace build: passed, including Windows desktop main/renderer and web app.
- Server dependency-graph compile after the final Planner edit: passed.
- `npm run security:gate`: passed.
- Focused tests: Planner repair 5/5, capacity governor 26/26, BlockRun adapter 12/12, and end-to-end deterministic Planner repair 1/1. Machine-readable Vitest results are in this directory.
- The full autonomous-orchestrator file produced 24 passes and one 30-second timeout with a Windows temporary Git cleanup lock. The timed case passed alone with a 60-second limit. Do not interpret the first run as 25/25 in one invocation.
- The source build completed; Windows archive packaging did not. `package:builder` terminated in this host’s Git Bash lifecycle wrapper. Direct `electron-builder --win` and `--win --dir` then failed on `getaddrinfo ENOTFOUND github.com`; no package artifact or packaging audit was produced. No installer was run or installed.

## Free supply and live reliability

- The strongest new BlockRun Coder candidate from existing research was Poolside Laguna XS 2.1. Its live catalog row and exact served identity could not be checked because `https://blockrun.ai/api/v1/models` failed DNS resolution. R73’s failed Poolside model-substitution evidence remains in force. No role was promoted.
- No Free inference was dispatched in R75: money spent `$0`, purchased credits consumed `0`.
- No additional Coder is qualified, no three-completion streak is demonstrated, and no organic cross-provider Coder recovery is demonstrated. These gates remain unmet.
- Package generation and remote push are blocked by unavailable GitHub DNS in this environment. No unsigned installer was executed.

Full command and test receipts are summarized in [R75-VALIDATION.json](R75-VALIDATION.json). The status remains blocked until live provider access and the packaging/push network prerequisite are available; acceptance targets were not relaxed.
