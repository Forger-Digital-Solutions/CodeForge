# R21 Adaptive Topology + Deterministic Review Wiring Checkpoint (M10 partial)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — deterministic tests only; no provider calls.

## Scope recovered

This increment continues work the previous agent left uncommitted in the working tree:
`resolveAdaptiveTopology` existed in `packages/server/src/adaptive-topology.ts` (contract in
`packages/protocol/src/subagent-runtime.ts`) but had **no production caller** — the autonomous
orchestrator always ran the fixed R1 team regardless of task size, and the deterministic diff
review (`reviewDiff`: sensitive files, verification-config edits) ran only inside the
single-agent WorkflowEngine.

## What landed

| Piece | Where | Status |
|---|---|---|
| Deterministic task-complexity classifier (tiny / normal / complex, reason codes, reproducible, hint override, breadth escalates) | `packages/server/src/task-complexity.ts` | NEW |
| Topology decision before any spawn; receipt persisted on the run (`policy`, `complexity`, `plan`, `repositoryFileCount`, `decidedAt`) | `autonomous-orchestrator.ts` | wired |
| Explorer/planner/reviewer phases driven by `plan.explorers` / `hasPlanner` / `hasReviewer`; coder works from the goal-derived task graph when no planner runs | `autonomous-orchestrator.ts` | wired |
| Deterministic `reviewDiff` on **every** topology, model-free, findings enter the same bounded revision loop | `autonomous-orchestrator.ts` | wired |
| Certified R1 baseline reachable via explicit `topology: "fixed_r1"` or `CODEFORGE_TOPOLOGY_POLICY=fixed_r1` | `resolveAdaptiveTopology` + env | wired |
| ForgeVerify + completion gate still mandatory on every plan (`requiresForgeVerify: true` is schema-enforced) | protocol schema | unchanged invariant |

## Defects found while finishing the wiring (closed)

| # | Defect | Evidence | Fix |
|---|---|---|---|
| DT-001 | `reviewDiff`'s no-snapshot fallback collapsed the entire `git diff` into **one** `DiffEntry` named after `statusFiles[0].path`, so path-scoped checks (`basename === "package.json"`, `includes(".env")`) bound to whatever file happened to lead the porcelain listing. A verification-script rewrite on `package.json` produced a README-named entry → **no finding**. | `r21-adaptive-topology-wiring` "rewriting its own verification script" failed (run completed); fixed in `r21-diff-review-git-fallback` "per-file entries" | `parseGitDiffEntries` splits `diff --git` blocks into per-file entries (path from `+++`/`---`/`rename`/`header`, changeType from mode markers, per-file bounded patch, index hashes). |
| DT-002 | Untracked files were invisible twice over: `git diff` never reports them, and `getGitStatusFiles` emits `"??"` while both detection branches tested `"?"` — **dead code since introduction**. A change consisting only of a new `.env` reviewed as "No diffs" → approved. | `r21-diff-review-git-fallback` "untracked-only change", "untracked sensitive file" | porcelain `??`/`A*` paths become `created` DiffEntries via `createdEntryFromDisk` (binary-safe, >4 MB fingerprinted by size+prefix hash instead of slurped). |
| DT-003 | The fallback ran `git diff` (unstaged only): staged changes and **commits the coder made inside the worktree** were invisible to review. | `r21-diff-review-git-fallback` "committed inside the worktree", "staged via HEAD fallback" | `reviewDiff` accepts `base`; orchestrator passes `baseRevision`. Resolution order: `git diff <base>` → `git diff HEAD` → `git diff` + `git diff --cached` (unborn HEAD). |
| DT-004 | Reviving `??` detection in the snapshot path would have false-blocked on **pre-existing** untracked dotfiles — `snapshotBefore()` never snapshots dotfiles, so a user's un-gitignored `.env` is indistinguishable from an agent-created one. | analysis + `sinceMs` tests | `reviewDiff` accepts `sinceMs`; engine records `snapshotTakenAtMs` at snapshot start, persists it through the desktop-worker suspension record, and restores it on resume. Untouched pre-existing untracked files are excluded; files created **or touched** during the task are still flagged. |

## Test evidence

| Suite | Result |
|---|---|
| `r21-task-complexity.test.ts` (28-case labeled corpus, determinism, hint, escalation) | 28/28 |
| `r21-adaptive-topology-wiring.test.ts` (tiny→coder-only, normal→explorer+reviewer, complex→2 explorers, explicit request, env baseline, hint, `.env` revision drive, verification-script rewrite block) | 8/8 |
| `r21-diff-review-git-fallback.test.ts` (per-file binding, untracked `.env`, untracked-only change, committed-in-worktree vs base, staged via HEAD, `sinceMs` both directions) | 7/7 |
| `agent-orchestrator-integration.test.ts` | 7/7 (30 s timeout applied to the four full-pipeline tests — the R4 worker-bound config already assumes this class; standalone runs previously hit the 5 s default after the added review spawns) |
| `diff-review*.test.ts` existing | green |

## Known boundary (honest)

- `topology: "vision"` remains contract-level: `AdaptiveTopologyPlan.hasVision` is honored by the
  resolver, but no vision worker exists in the subagent system; nothing in production passes
  `hasImages` today. The receipt records the plan and `spawned` agents, so plan/execution
  divergence is inspectable rather than silent.
- The deterministic review sees the git-visible change: tracked edits vs base + untracked
  (non-ignored) files + staged state. A gitignored `.env` is outside git visibility by design —
  same boundary ForgeVerify documents for gitignored generated content.

## Authority posture

No new completion path was added; reviewer findings (deterministic or model) feed the same
bounded revision loop, and ForgeVerify + `evaluateCompletion` remain the only route to
`completed`. The topology receipt is recorded on the durable run row for audit.
