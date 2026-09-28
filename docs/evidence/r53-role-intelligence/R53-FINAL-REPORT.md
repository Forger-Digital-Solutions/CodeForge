# R53 final evidence report

Status: **CODEFORGE_R53_BLOCKED**. Production changes, benchmarks, zero-cost live missions, regressions, build, and source recertification are complete. Large-task autonomy closure is unproved: two different Coders exhausted their turn budgets on the shared-aggregation refactor without reaching review or ForgeVerify. A third diagnostic run was cancelled at its 600-second harness bound while still editing. Four other live attempts completed with independent verification and matching integrated trees.

## Repository and certification

Branch: `codex/r29-release-closure`. The R52 `r52-production-scale-v1` checkpoint and its 39 material hashes were verified before changes. R53 recertification is `r53-role-intelligence-v1`, source-state ID `d122e0cce57f80a5c81612a2fe120cc1223db585f5df9eb91dd6e751e6791593`. Only `packages/agent/src/index.ts` drifted within that material surface; the model-registry, EightBit, and mission-harness changes are outside it. The source-state/provenance tests passed 8/8 after recertification. The unrelated existing R34 evidence edit was preserved and excluded from R53 staging.

## Production changes

- Reviewer instructions now start from the supplied diff and ask for a verdict once concrete uncertainty is resolved. The structured verdict and blocker contract remain.
- Fresh role qualification now re-enters the governed queue after three distinct, current, net-negative role runs. A single failure, duplicate run ID, unrelated role, and provider capacity event cannot trigger it; free, consent, and terms filters remain.
- An upstream transient stops later role probes, leaves those roles NOT_TESTED, and retains the prior receipt for retry.
- Reviewer pool independence is bounded by qualification tier and effective role score. A weak independent or probation route cannot displace a materially stronger qualified route.
- The live mission harness can replay one witnessed role outcome and records tool names, outcomes, result lengths, and argument hashes without raw tool arguments or outputs. This is diagnostic evidence, not a new production failover rule.

## Role matrix and benchmarks

`R53-ROLE-QUALIFICATION-MATRIX.json` contains ten managed-free routes with distinct Explorer, Planner, Coder, and Reviewer verdicts, sample counts, capacity states, and data-policy states. The inventory found 20 eligible routes across 18 pools. Groq, Mistral, and OpenRouter were usable; Cloudflare usage telemetry remained authorization-blocked, Google credentials suspended, and Cerebras not proven as recurring free supply.

The seven-case direct Reviewer challenge scored Nemotron Super 7/7 in 36.2 seconds, Groq GPT-OSS 20B 7/7 in 3.9 seconds, and Mistral Codestral 2508 5/7 in 4.5 seconds, with no direct-challenge non-convergence. The challenge used one request per case and does not replace autonomous qualification. The R52 healthy Nemotron Reviewer had exhausted ten turns and ten tools; its receipt lacked tool arguments, so a duplicate loop was unproven. Its prior five-case qualification remains QUALIFIED. R53 healthy review returned in eight requests; multi-step and checkout-recovery reviews returned in seven each. No global blacklist or unsupported downgrade was made.

The six-shape Explorer challenge scored Nemotron Super 5/6, Codestral 2508 5/6, and Groq GPT-OSS 20B 2/2 before provider interruption. The retained strict grader counted one arguably relevant extra quota test against both 5/6 routes. The current production role suite found Codestral Explorer NOT_QUALIFIED (0/2), Planner and Coder QUALIFIED (2/2 each), and Reviewer PROBATION (4/6). Groq GPT-OSS 20B had Explorer PROBATION (1/2), Coder QUALIFIED (2/2), and interrupted Planner/Reviewer probes. Nemotron Super passed two compact Coder cases before provider interruption. These probes did not overwrite persisted receipts.

Live Coder evidence is mixed. Groq GPT-OSS 120B completed the three-file mission in 14 requests and 13 tools; Nemotron Lightning completed the four-file checkout feature on recovery in 17 requests and 20 tools. The first feature attempt was blocked on `TOOL_WORKSPACE_ESCAPE`. The refactor exhausted Nemotron Super (26 requests, 29 tools) and Lightning (25 requests, 31 tools) without required exports. A Groq GPT-OSS 120B diagnostic made two edits, then was cancelled after 600 seconds, 19 requests, and 18 tools; its 18 argument hashes were unique. No live Planner was invoked because all attempts resolved to normal topology. Codestral's 2/2 Planner protocol result establishes competence, not incremental Planner value.

## Adaptation, no-progress, and failover

Production Free Fabric replay tests demonstrate negative winner flips, verified positive recovery, role isolation, and capacity-neutral quality; a 34-decision simulation covers evidence expiry. One witnessed feature workspace escape and one witnessed refactor budget exhaustion were replayed into fresh role decisions. The feature route still won under concurrent capacity and policy, so no live winner flip is claimed. The refactor route changed, but changed capacity prevents causal attribution to the replay.

Existing no-progress rules catch three identical calls, a six-call alternating pair, repeated same-state reads, eight ineffective reads, and four ineffective writes. The diagnostic's distinct calls and late edits do not support a generic no-edit timeout. The earlier failed Coders' call sequences were not retained. A safe early role switch also requires a simultaneously admitted alternative and preserved state/capacity; no such live switch is proven. Actual provider 429 and temporary-capacity failovers occurred without quality penalties.

## ForgeVerify, subagents, and live missions

`evaluateCompletion` remains the sole completion authority. Adversarial tests cover forged test claims, failing exit codes, partial test sets, semantic-review disagreement, stale tree evidence, missing obligations, and Reviewer exhaustion. No false completion was observed. Four completed missions passed independent tests and verified/integrated tree equality. The feature escape and refactor blocks did not reach completion; the diagnostic cancellation did not reach verification. Alternate live semantic-verifier routing remains unproved.

All eight attempts used normal Explorer → Coder → Reviewer → ForgeVerify topology when roles reached those stages. Completed multi-step and provider-outage missions used independent Reviewer pools; healthy and checkout recovery reported same-pool fallback. Duplicate-suppression tests cover state-bound read reuse and mutation exclusion. No live parallel-Explorer value comparison or live Planner correctness result was produced. `R53-LIVE-MISSIONS.md` contains the per-attempt models, requests, tools, failovers, time, spend, verification, gate, and tree results, with full JSON receipts. The eight attempts comprise four completions, three blocks, and one bounded cancellation. Every receipt reports zero paid spend and ForgeAuto-eligible served routes.

## Regressions, tests, and build

The bounded-worker server suite finished 902 passed, 3 skipped, 0 failed. Seven focused ForgeGreen files finished 52/52; the affected EightBit/model-registry/server-routing set finished 529 passed, 2 skipped, 0 failed. The 34-decision simulation observed no capacity-to-quality contamination. Canonical 16-Bit billing and paid-route suites finished 83/83; no live mission used Paid Auto or BYOK.

The first full root run executed 4,142 tests: 4,089 passed, 48 skipped, 5 failed. Two were expected pre-recertification source-state drift and passed 8/8 after certification. Three timed out under the 500-file run's machine load; their complete files passed alone (desktop bridge 6/6, parallel orchestrator 4/4). `R53-TEST-FAILURE-CLASSIFICATION.md` and raw outputs preserve the evidence. The full monorepo build passed. The later mission-harness trace passed `node --check` and produced the diagnostic receipt; it did not change production TypeScript.

## Remaining limitations and commits

R53 does not prove reliable refactor completion, a failing cross-package integration task, a live Planner benefit, live early quality-driven role switching, or alternate semantic-verifier routing. The two refactor turn-limit blocks are not presented as success; the diagnostic cancellation is not counted as a quality failure. These gaps keep the round BLOCKED despite clean safety and regression boundaries.

Source checkpoints: `8023123` (Reviewer convergence, requalification, transient probes), `d382055` (quality-bounded Reviewer independence), and `b44ec02` (witnessed Coder failure replay). This report, the mission trace harness, certification file, and evidence form the R53 evidence checkpoint; its hash is available in Git history.
