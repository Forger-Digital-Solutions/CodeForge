# R76 — Free Inference Reliability Session Report

Status: **CODEFORGE_R76_PARTIAL** — core repairs landed and are regression-tested; the
autonomous completion streak requirement (3 consecutive) is not yet met.

## Baseline

- Base SHA: `f8cd589f` (R75 baseline, matched remote at audit)
- Branch: `codex/r76-free-supply-recovery-and-reliability`
- Worktree: `G:\CodeForge\worktrees\r76-free-supply-recovery-and-reliability`

## Repairs landed this session

| Repair | Evidence |
|--------|----------|
| Rate-limit scope propagation through `ModelExecutionAdapter` rethrow | `agent-provider-contract.test.ts` — model/provider/undefined scopes verified through execution AND durable route-health ledger round-trip; sibling routes excluded only for non-model scopes; foreign quota domains unaffected |
| Planner contract repair — every reviewer linked | `r75-planner-contract-repair.test.ts` |
| **NEW: post-review coder demotion** — live campaign R3 found corrected graphs with a coder depending on the reviewer created a repair-induced cycle and blocked as `AGENT_INVALID_STRUCTURED_OUTPUT`. Repair now demotes post-review coders into `planningIntent.verification` (advisory only — runtime commands are supplied separately); fails closed when every coder is post-review | same test file, incl. exact R3 campaign graph shape |
| Reviewer parent/child-workspace admission | `r76-reviewer-parent-admission.test.ts` (5 tests) |
| Packaging isolation (`assertPackagingIsolation` + `package-isolated.mjs`); pack/dist routes through guard | `packaging-isolation.test.ts` (7 tests) |

## Live provider state (this session, real probes)

| Route | Result |
|-------|--------|
| `kilo-free-direct` `liquid/lfm-2.5-2.6b:free` | **CODER QUALIFIED** (fresh compact qualification, 4 requests) |
| `kilo-free-direct` `poolside/laguna-s-2.1:free` | NOT_QUALIFIED (failed first probe) |
| `blockrun-free-direct` `poolside/laguna-xs-2.1` | UNAVAILABLE — "not currently available with explicit Free billing" (0 inference requests) |
| `kilo-free-direct` `cohere/north-mini-code:free` | Bundled receipt; hit a real upstream 429 during R3 (high-demand limit) |

True Coder redundancy: **not demonstrated** — only one currently-qualified Coder route
(liquid). Poolside is gone on both providers; cohere is demand-limited. This is recorded
honestly; a second model in the same Kilo quota domain would be model-level failover only.

## Autonomous campaigns (history preserved, not reset)

| Run | Tasks | Result | Notes |
|-----|-------|--------|-------|
| R1 (prior) | 3 | 1 completed / 2 blocked | preserved |
| LIQUID (prior) | 1 | failed | preserved |
| LIQUID-CORRECTED (prior) | 1 | blocked | preserved |
| ALTERNATE (prior) | 0 | blocked | preserved |
| R2 (this session) | 0 | blocked | `CURRENT_QUALIFIED_EXPLORER_ROSTER_UNAVAILABLE` — liquid-only roster lacks an explorer |
| R3 (this session) | 2 attempted | 0 completed | 01-bug-fix blocked by the planner post-review-coder defect (**repaired this session**); 02-feature blocked by a real `cohere/north-mini-code:free` 429. Cost: `CATALOG_VERIFIED_EXACT_ZERO_NO_CREDENTIALS_NO_PAID_FALLBACK`, 37 inference frames |
| R4 (this session) | 3 attempted | **2 completed** / 1 blocked | 01-bug-fix + 03-refactor: source changed, independent review passed, durable integration — the post-review-coder repair unblocked the pipeline. 02-feature blocked on `TOOL_WORKSPACE_ESCAPE` (model emitted an absolute `/workspace/…` path; deny correct). Zero spend, 54 frames |
| R5 (this session) | — | aborted at startup | `git diff` exceeded maxBuffer because uncommitted evidence JSON exceeded stdout cap — evidence committed, rerun queued |

Longest verified completion streak: **1** (consecutive within a single campaign; R4 produced 2 completions separated by a block). Required for R76 closure: 3 consecutive — not met.

## Regression

30 targeted tests pass (rate-limit scope, planner repair, reviewer admission, packaging).
Merged-tree verification with the ForgeAAA track: 92 tests green, typecheck clean.

## Blockers

- Real Coder redundancy requires a second genuinely-independent qualified route — none
  currently verified.
- Campaign throughput is bounded by free-tier demand limits (real 429s observed).
- Remote publication not attempted (no push authorization verified in-session).
