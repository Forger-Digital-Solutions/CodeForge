# R21 ForgeGreen Controlled A/B Checkpoint (M3)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — a deterministic scripted model; no provider call.
Evidence: `forgegreen-ab.json` (produced by `packages/server/test/r21-forgegreen-ab.test.ts` with `R21_EVIDENCE_DIR` set)

## Verdict

**ForgeGreen: PARTIAL.** The mechanisms that are ACTIVE_SAFE (FG-1C duplicate read-only suppression, FG-1B tool-output compression, FG-12F cost-gated verification reuse) reproduce their savings under controlled, comparable conditions with correctness held equal. One prior savings claim was **false under measurement and has been corrected** (below). An end-to-end A/B with a live model — the only thing that can show whether ForgeGreen changes agent *outcomes* or turn counts — is capacity-blocked (see "Not measured").

## Design

| | CONTROL | EXPERIMENT |
|---|---|---|
| ForgeGreen advisor | disabled | enabled |
| FG-1C duplicate read-only suppression | off (new runtime `efficiencyControls` seam, benchmark-only) | on |
| FG-1B tool-output compression | off | on |
| Model | identical deterministic scripted provider issuing a fixed, realistic tool trace per task | identical |
| Repository, topology, permissions | identical, fresh materialisation per run | identical |
| Repetitions | 3 per arm, alternating OFF/ON/ON/OFF/OFF/ON | |

Correctness is equal **by construction** (same script) and was *asserted* per pair on terminal status, final summary, changed-file list and a hash of the resulting workspace. Because the script is fixed, provider calls are equal by construction as well; every difference is attributable to the mechanisms alone.

Corpus: 13 single-agent task classes (tiny bug fix, unknown regression, medium/large feature, TypeScript refactor, Python refactor, large-monorepo search, dependency upgrade, failing-CI investigation, test repair, frontend/backend, database/API, multi-file implementation) plus one subagent-heavy research task with four sibling agents.

## Results (medians of 3 repetitions; counts and bytes are deterministic)

| Task | Physical tool dispatches OFF→ON | Model-visible bytes OFF→ON | Δ bytes | Duplicates suppressed | Compression avoided |
|---|---:|---:|---:|---:|---:|
| tiny-bug-fix | 3 → 3 | 153,080 → 153,432 | **+0.2%** | 0 | 0 |
| unknown-regression | 9 → 7 | 877,920 → 884,130 | +0.7% | 2 | 0 |
| medium-feature | 9 → 7 | 756,830 → 762,590 | +0.8% | 2 | 0 |
| large-feature | 13 → 10 | 1,600,606 → 1,613,024 | +0.8% | 3 | 0 |
| typescript-refactor | 10 → 8 | 916,124 → 923,439 | +0.8% | 2 | 0 |
| python-refactor | 8 → 6 | 395,280 → 189,009 | **−52.2%** | 2 | 23,361 |
| large-monorepo-search | 9 → 6 | 1,191,980 → 568,240 | **−52.3%** | 3 | 63,317 |
| dependency-upgrade | 6 → 5 | 555,933 → 132,797 | **−76.1%** | 1 | 60,669 |
| failing-ci-investigation | 7 → 5 | 1,369,416 → 867,128 | **−36.7%** | 2 | 63,317 |
| test-repair | 5 → 4 | 157,110 → 158,700 | +1.0% | 1 | 0 |
| frontend-backend | 7 → 6 | 333,896 → 336,376 | +0.7% | 1 | 0 |
| database-api-change | 7 → 6 | 311,376 → 313,848 | +0.8% | 1 | 0 |
| multi-file-implementation | 10 → 8 | 899,646 → 906,466 | +0.8% | 2 | 0 |
| **Total (13 tasks)** | **103 → 81 (−21.4%)** | **9,519,197 → 7,809,179 (−18.0%)** | | 22 | |

- Provider calls avoided: **0** (by construction — the scripted model issues the same turns).
- Wall time: median improved in 10/13 tasks by 1–3% (sub-30 ms); not significant at this sample and not claimed.
- Tool dispatches avoided equal the designed duplicates in every task: the FG-1C identity rule suppressed exactly the intended reads and nothing legitimate (post-edit re-reads all executed).

### What the numbers mean

1. **FG-1C duplicate suppression saves tool dispatches, not context.** For every suppressed duplicate the runtime replays the *full* prior output to the model with a provenance prefix. Model-visible bytes therefore rise slightly (+0.2–1.0%) on the nine tasks where only FG-1C fired. This contradicts the Phase-4 statement that replayed bytes were "not retransmitted" and the Candidate A receipt's `bytesAvoided` figure. **Corrected in this checkpoint:** `buildDuplicateToolReuseDecision` now reports `bytesAvoided: undefined`, `avoidedToolExecutions` as before, and records the replay size transparently as `REPLAYED_TO_MODEL_BYTES=<n>` in the decision's reason codes. The two FG-9 tests that encoded the old claim were updated. Context savings from duplicates remain the SHADOW candidate `DUPLICATE_CONTEXT_PAGE_TRANSMISSION`; it is not active and is not credited.
2. **FG-1B compression is where the context savings are.** On the four tasks with large repetitive outputs (CI logs, a lockfile, a Python module set) model-visible bytes fell 37–76%, and the total −18% is entirely those four tasks.
3. **No false suppression.** Every legitimate re-read after a mutation executed; every workspace hash matched across arms.

## Subagent duplication (§18)

Four siblings (explorer-a, explorer-b, coder, reviewer) each read `src/core.ts` and `src/api.ts` in their own runs. Measured: 80,370 bytes of the same two files re-read across siblings; 26,790 bytes of that is explorer↔explorer overlap. ForgeGreen suppressed the 2 *within-run* duplicates (one per explorer) and **0 across siblings** — the supervisor is per run by design, and the run-scoped session cache does not span sibling runs.

Classification: explorer overlap is a waste candidate (identical read-only evidence gathered twice); the coder's re-read is intentional (it edits from its own context); the reviewer's re-read is independent verification and must stay. Sharing distilled explorer evidence with the coder is the only safe target, and it is a topology/handoff design (M6), not a suppression rule.

## Not measured (and why)

- Whether a **live model** issues fewer turns, fewer provider calls, or fewer duplicate requests under ForgeGreen. A scripted model cannot respond to ForgeGreen. Live A/B on free routes is capacity-blocked: the only zero-cash tool-capable routes available to this workstation carry a 50-request/day ceiling (OpenRouter free tier) or account-scoped allowances that R14 declined to certify; 13 tasks × 2 arms × ≥3 repetitions × ~8 turns ≈ 600+ requests. See OWNER ACTION in the campaign scorecard.
- Energy: no kWh/CO₂ figure is derived. Only tokens/bytes/dispatches are measured; `INSUFFICIENT_DATA` for energy remains the correct value.

## Side finding fixed in this milestone (P1, agent runtime)

The A/B harness exposed that an agent whose model was still calling tools when its **model-turn budget** ran out was reported `status: completed` with the canned summary *"Completed the requested work and verification."* — for explorers, coders and reviewers. Cause: `stopReason` was initialised to `"completed"` and the post-loop budget check only fired when it had changed. Consequence: an exhausted reviewer's silence read as approval in the autonomous orchestrator. Fixed: exhaustion is `blocked` with `AGENT_MODEL_TURN_LIMIT` and an honest summary; the orchestrator fails closed with `REVIEWER_BUDGET_EXHAUSTED` when a blocked reviewer delivered no verdict (a `revision_required` verdict still drives the revision loop). Regression suites: `r21-agent-budget-honesty.test.ts`, `r21-orchestrator-reviewer-exhaustion.test.ts`. The efficiency receipt is also rebuilt after the last turn so final-turn suppressions are counted.
