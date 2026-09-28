# CODEFORGE_R54_BLOCKED

## Repository

- Branch: `codex/r29-release-closure`
- R54 implementation checkpoint: `cd6a919` (`R54 harden stalled-role recovery and topology`)
- R53 predecessor certification: `r53-role-intelligence-v1`
- R53 certified source state: `d122e0cce57f80a5c81612a2fe120cc1223db585f5df9eb91dd6e751e6791593`
- Material-surface audit: 39 files checked; only `packages/server/src/agent-runtime.ts` and `packages/server/src/autonomous-orchestrator.ts` drift from R53.
- Certification: not run. R54 remains blocked, so creating an R54 certification identity would overstate the evidence.
- The pre-existing R34 context-efficiency evidence edit remains outside the R54 commits.

## R53 blocker closure

| R53 gap | R54 status | Evidence |
|---|---|---|
| substantial refactor reliability | BLOCKED | The Coder completed one retry with all three intended files changed, but the global mission window expired as Reviewer started. A later retry exercised the new quality switch, but its replacement route ended on an upstream 503. No refactor reached Reviewer pass plus ForgeVerify. |
| cross-package integration | BLOCKED | The contained baseline failed 5/7 contract/checkout tests as intended. The Planner topology blocked before Coder; after the Planner-value gate selected normal topology, two retries ended on free-provider supply failures before edits. |
| Planner value | CLOSED: NO VALUE FOR TESTED CLASS | Planner topology blocked before Coder in both the refactor and cross-package missions. Normal topology reached Coder and produced implementation. Automatic complex tasks now use normal topology unless Planner value is explicitly proven; explicit operator topology remains authoritative. |
| quality-driven role switch | CLOSED | `R54-LIVE-REFACTOR-VERIFICATION-WINDOW.json` records `REPEATED_EDIT_FAILURE` at count 3 and a `QUALITY_DRIVEN_ROLE_SWITCH` from Nemotron Lightning to Nemotron Super. The prior route had made two successful edits. |
| preserved handoff | CLOSED DETERMINISTIC; LIVE CONTINUATION OBSERVED | The focused production-orchestrator test proves one isolated worktree, retained edits, serial ownership, old-route exclusion, continuation context, verification, and completion. The live switch used the same orchestrator worktree and selected one replacement, but the pre-instrumentation receipt did not export its durable handoff record. |
| alternate semantic verifier | BLOCKED LIVE | Deterministic production-path tests prove Reviewer A without a verdict routes once to Reviewer B, ForgeVerify waits, and no valid B remains blocked. Live Reviewer A exhausted its turn budget, but Reviewer B had no eligible supply. |

## Production changes

- Role progress now requires three failed mutations with the same full target, tool, raw-argument hash, and observation hash before emitting `REPEATED_EDIT_FAILURE`.
- A changed successful read or successful mutation of the target clears that target's streak.
- Tool traces retain only request and observation hashes; raw tool arguments remain absent.
- Initial and replacement Coders receive the authoritative verification commands and the `network:false` execution constraint.
- Automatic complex topology avoids Planner until controlled evidence proves value for that task class. Explicit `complex` and `fixed_r1` requests are unchanged.
- Bounded Coder and semantic-verifier replacement, raw request usage provenance, serial worktree ownership, completion-gate authority, and free-only route exclusion from `b108aa9` remain intact.

## Refactor forensics

The original normal retry used 26 Coder requests and 32 tools, made useful edits, repeated a failing third-file edit four times, and never reached Reviewer. The first detector rerun showed that superficially similar failed edits can have distinct request arguments; those attempts correctly did not satisfy the hardened identical-request rule. It then exposed a separate command-context defect: the Coder was not receiving the orchestrator's required verification command and spent turns proposing commands denied by the autonomous lease.

After the execution context fix, one retry changed `src/stats.mjs`, `src/report.mjs`, and `src/index.mjs` and the Coder completed in 18 requests/25 tools. Provider pacing and failovers consumed the 600-second mission window, leaving Reviewer only one cancelled request. A 900-second retry later produced the exact detector event and quality switch, but the replacement route failed with OpenRouter/Nvidia 503 before completion. The larger window was used only after evidence showed continued useful progress and a completed Coder; no model-turn limit was raised.

## Progress/stall detector

- Trigger: at least three failed `edit_file`/`write_file` calls sharing the full target, tool, request hash, and failure observation hash.
- Reset: successful mutation of that target, or a successful read proving that target's observed contents changed.
- Isolation: streaks are keyed by target; file A cannot increment file B.
- False-positive resistance: distinct edit requests with the same `target_not_found` output do not accumulate; missing request hashes do not count; provider/capacity command failures do not count; successful but semantically wrong edits continue to normal review and verification.
- Focused result: 9/9 role-progress tests passed.
- Live result: `REPEATED_EDIT_FAILURE`, `repeatedEditFailures: 3`, two earlier successful mutations, then `QUALITY_DRIVEN_ROLE_SWITCH`.

## Quality-driven Coder switch

- Initial served Coder path: Groq Qwen, then provider-supply failovers to Groq GPT-OSS 120B and Nemotron Lightning.
- Quality event: Lightning made two successful edits, then accumulated three identical failed edits against `src/index.mjs`; the final route was not switched because of 429, timeout, quota exhaustion, or outage.
- Runtime reason: `REPEATED_EDIT_FAILURE` / `AGENT_NO_PROGRESS_DETECTED`.
- Replacement: Nemotron Super, selected through fresh free admission with Lightning excluded.
- Ownership: serial; one replacement maximum.
- Paid spend: `$0`.
- Final result: replacement received the continuation but ended on an upstream 503, so the mission remained blocked.

## Handoff preservation

The deterministic production-orchestrator test records the old and new route, retained changed files, pending goal, required verification command, and one `role_quality_handoff`. The replacement sees the first Coder's function in the same worktree, adds the remaining function, passes review and verification, and integrates. Both Coder contexts now include the exact verification command and autonomous execution constraint.

The live switch retained the same isolated worktree and prior mutations by construction, but its receipt predates the harness fields that now export `roleQualityHandoffs`. Therefore the exact live before/after worktree hash is not claimed.

## Large refactors

| Mission | Result |
|---|---|
| planner topology | blocked before Coder; 180.3 s |
| original normal retry | Coder blocked at 26 requests/32 tools; no review |
| first quality retry | quality switch occurred through an older duplicate-read signal; replacement Coder completed; Reviewer A exhausted and B had no supply |
| exact-detector retry | useful edits continued; request identities differed, so no false stall; blocked at Coder limit |
| execution-context retry | Coder completed three-file implementation; Reviewer cancelled at global 600 s |
| verification-window retry | exact failed-edit stall and real quality switch; replacement hit upstream 503 |

No large refactor achieved Reviewer pass plus ForgeVerify, so this gate remains blocked.

## Cross-package integration

The baseline is genuine: 7 tests ran, 2 passed, and 5 failed. Failures covered object-contract composition (`NaN` instead of 448/403), negative quantity, fractional cents, and invalid discount.

The first adaptive run selected Planner and blocked before Coder. R54 then characterized Planner as non-beneficial and changed automatic complex selection to normal topology. The two normal-topology retries reached Coder admission, but current free supply returned upstream 503 or no eligible replacement before any production edit. No cross-package success is claimed.

## Planner

For the tested substantial-refactor class:

| Topology | Completion | Requests/tools before block | Outcome |
|---|---:|---:|---|
| Explorer -> Planner -> Coder -> Reviewer | no | Explorer 12 requests/9 tools across attempts; Planner 5/4 | blocked before Coder |
| Explorer -> Coder -> Reviewer | no full completion | Coder reached 26/32 in the original run; a later Coder completed at 18/25 | implementation progressed; review remained supply/window blocked |

Planner added latency, duplicate exploration, and a new convergence/supply boundary without producing an authorized graph. For this class the measured decision is not `NOT_PROVEN`: it is no observed value, so automatic routing avoids Planner. Explicit topology requests still permit controlled future comparisons.

## Semantic verifier redundancy

- Deterministic: Reviewer A is selected normally and returns no verdict; qualified Reviewer B receives preserved review state and produces the authoritative pass. ForgeVerify then completes.
- Deterministic negative: A and B both lack a valid verdict; completion remains blocked.
- Live: Reviewer A exhausted 11 requests/16 tools after a capacity failover; alternate admission found no eligible Reviewer B.
- Groq qualification follow-up: the production qualification suite executed for GPT-OSS 20B and 120B, but a 429 during Explorer qualification short-circuited later roles. Reviewer remained `NOT_TESTED` for both and neither was promoted.

## Updated role matrix

| Route family | Explorer | Planner | Coder | Reviewer |
|---|---|---|---|---|
| Nemotron Super | qualified supply, mixed live convergence | no value established | qualified | qualified but live convergence/supply failures |
| Nemotron Lightning | qualified | not used | qualified; exact stall witnessed | not authoritative in this round |
| Groq Qwen | qualified | not used | qualified with current 429 pressure | qualified; live Reviewer exhausted |
| Groq GPT-OSS 20B | qualification interrupted after Explorer 429 | NOT_TESTED in new suite | QUALIFIED | NOT_TESTED |
| Groq GPT-OSS 120B | qualification interrupted after Explorer 429 | NOT_TESTED in new suite | QUALIFIED | NOT_TESTED |

## ForgeVerify

The selected completion-gate, malicious-corpus, stale-evidence, admission-vs-completion, reviewer-exhaustion, and R54 handoff tests all passed. No quality switch bypass reaches completion.

`FALSE_COMPLETION_COUNT = 0`

Live blocked missions produced no completion-gate success and were not integrated.

## Raw usage telemetry

Live receipts capture provider, model, route/pool, role, logical run, request count, tool count, input tokens, output tokens, route failovers, stop reason, paid spend, and per-turn provider usage source where reported. New receipts also capture hashed request identity and durable Coder/Reviewer handoffs.

`UNKNOWN` remains explicit for provider usage events that do not report token counts, provider allowance units not exposed by the provider, absent routes on failed admission, and confidence not supplied by the provider. R54 defines no normalized Shilling value:

`NORMALIZED_SHILLINGS = NOT_DEFINED_IN_R54`

## ForgeGreen

Capacity/failover/role-quality/model-registry regressions passed. The gate covers unmeasured capacity, recovery, provider isolation, bounded failover, no capacity-to-quality contamination, and workflow parking/resumption. The workflow reviewer-independence fixture was updated to stay within the intentionally bounded independence preference after the implementation route earns healthy evidence.

## 8-Bit

- Focused and broad selected gate: all R54, Free Fabric, failover, role qualification, role quality, capacity, topology, subagent, orchestrator, and multi-user fairness tests passed.
- Live missions used verified-free routes only and each reported `$0` paid spend.
- Provider supply currently prevents the remaining live closure gates.

## 16-Bit

Canonical paid-role routing, Paid Auto, and cloud billing tests passed. No live paid mission was run. Quality-driven free replacement cannot enter Paid Auto or BYOK.

## Tests

- Final root-config regression gate: 35/35 files, 312/312 tests passed, 0 failed, 0 skipped.
- Focused R54 gate: 3/3 files, 32/32 tests passed.
- Adaptive topology/wiring follow-up: 2/2 files, 21/21 tests passed.
- Server package typecheck: passed.

## Build

`npm run build` passed for all workspaces, desktop main/preload/renderer, and web renderer.

## Remaining limitations

1. No substantial refactor has completed independent Reviewer plus ForgeVerify.
2. No live cross-package mission has progressed from the known-failing baseline through verified integration.
3. Live alternate semantic Reviewer success remains unavailable; deterministic production-path coverage is green.
4. GPT-OSS 20B/120B Reviewer qualification remains `NOT_TESTED` after current Groq 429 supply.
5. The exact live handoff worktree hash was not exported by the older receipt; future receipts include the durable handoff fields.

## Commits

- `b108aa9` — bounded quality-driven Coder handoff, alternate semantic verifier, role progress, and raw usage foundations.
- `f5fdb164` — cross-package mission fixture and guarded R54 recertifier.
- `cd6a919` — hardened identical-edit identity, Coder execution context, measured Planner gate, evidence plumbing, and regressions.

R54 must remain blocked until the substantial-refactor, cross-package, and live semantic-verifier gates complete through Reviewer and ForgeVerify.
