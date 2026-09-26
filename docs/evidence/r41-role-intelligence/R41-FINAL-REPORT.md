# CODEFORGE R41 FINAL

**Verdict: R41 PARTIALLY VERIFIED.** Role intelligence is now production behavior — persisted qualification receipts drive role admission, ranking, and failover; a live heterogeneous run completed with independent verification after the role-quality filter excluded the route that previously blocked it. Open gates: ForgeGreen selectivity (no new policy or paired corpus), individual root-cause closure for the five R40 timing signatures (they did not recur; mechanisms unproven), and sustained endurance. Historical R39/R40 evidence was not modified.

## Implementation changes

- **Role-quality evidence is runtime-consumable** (`packages/eight-bit/src/role-quality.ts`). `roleQualityAdvice` maps a route's persisted `ModelQualificationReceipt` for one role into a bounded ±12 score adjustment with a 4-sample prior, linear decay to zero at 30 days, transient-error filtering (429/5xx/timeouts/provider-empty), and reason codes (`ROLE_QUALIFIED_EVIDENCE`, `ROLE_CRITICAL_FAILURE`, `ROLE_EVIDENCE_STALE`, …). It is advisory: it cannot create eligibility, cross a supply domain, or override health exclusion.
- **Two-tier route ordering** (`roleRoutePriority`): healthy availability first, then QUALIFIED > PROBATION > unmeasured, evaluated ahead of effective score so a capacity-constrained qualified route cannot strand work a healthy probation peer could serve — enforced in both selection and the sticky-binding promotion margin.
- **Wiring**: `SelectRouteOptions.roleQualityAdjustment`/`roleQualificationTierFor` thread through `router.ts`, `free-fabric.ts` (folded into effective score, compared only within a supply domain after tier and health demotion), `failover.ts` (the re-decide stays role-aware), and `runtime.ts`. `FreeCloudRoutingHooks.getQualificationReceipt` exposes the persisted receipt; `FreeCloudService` serves it from the qualification store.
- **Role admission filter** (`agent-runtime.ts`): automatic role routing now rejects a route whose *current* receipt shows NOT_QUALIFIED, HARD_FAILURE, or NOT_TESTED for that role. Routes with no receipt keep legacy behavior. EXPLORER may consult a legacy TOOL_AGENT verdict; no other cross-role substitution. Explicit model pins bypass the filter.
- **Planner protocol V3**: the qualification prompt now states the `assignedRole` enum literally (`explorer|planner|coder|reviewer`); scoring, tasks, and graph validation are unchanged. Suite version bumped to `R41_ROLE_QUALIFICATION_V3`; V1/V2 protocols remain addressable so old evidence is never reinterpreted.
- **Transient ≠ incompetence**: `role-suite.ts` filters transient-signature cases (extended with `no usable completion choices`, `R41_BOUND`) out of hard-failure computation; an all-transient verdict is `NOT_TESTED`, not `NOT_QUALIFIED`.
- **Router heuristic**: the coding-name hint now applies only when *all* empirical scores (codingScore, agentScore, toolReliability) are absent; measured evidence always wins.
- (From the interim slice, unchanged this round) bounded per-role output budgets with route-specific reasoning reserves and expiry; fail-closed context exhaustion before dispatch; `length` gets one bounded repair while `content_filter` blocks; reasoning tokens accumulate in usage; `CONSUMER_SUSPENDED` → structural `ACCESS_RESTRICTED` quarantine.

## Reasoning-budget fix

R40 recorded North Mini Code consuming 457/500 completion tokens on reasoning and returning an empty answer. The R41 direct probe (`R41-REASONING-BUDGET.json`) shows the route now answers correctly at *both* the old 500 cap (211 reasoning tokens) and the R41 profile's 2,048 (297 reasoning) — confirming the starvation signature is behavioral drift, not permanent incapacity, and validating the design choice of expiring route-specific profiles over permanent model-family assumptions. Planner probes (`R41-PLANNER-BUDGET.json`) showed the earlier schema failures were prompt ambiguity, not budget starvation: under the enum-clarified V3 prompt (`R41-PLANNER-CLARIFIED.json`) all six calls returned valid protocol at unchanged budgets (1,536/2,560 tokens); Codestral and gpt-oss-120b passed both cases, Nemotron produced valid protocol with one semantic miss. Global caps were not raised.

## Role intelligence

Composite live snapshot (`R41-ROLE-PROFILES.json`, evidence-linked per verdict):

| Route | Coder | Explorer | Planner | Reviewer |
|---|---|---|---|---|
| mistral/codestral-latest | QUALIFIED | NOT_QUALIFIED | QUALIFIED | QUALIFIED |
| openrouter/north-mini-code:free | QUALIFIED | PROBATION | NOT_TESTED | HARD_FAILURE |
| openrouter/nvidia/nemotron-3-super-120b-a12b:free | QUALIFIED | NOT_TESTED | PROBATION | QUALIFIED |
| groq/openai/gpt-oss-120b | QUALIFIED (raw) | PROBATION (raw) | NOT_TESTED (TPM 429) | NOT_TESTED (TPM 429) |

Raw runs: `R41-ROLE-QUALIFICATION-RAW.json`, `R41-MISTRAL-QUALIFICATION-RAW.json`, `R41-NEMOTRON-QUALIFICATION-RAW.json`. Groq Planner/Reviewer remain `NOT_TESTED` under TPM-80 429 pressure — recorded as transient, never scored as capability failure. Nemotron Explorer is `NOT_TESTED` after upstream NVIDIA 503s.

## Heterogeneous routing

`R41-HETEROGENEOUS-ROLEQ-AB.json` (multi-file task, fixed_r1 topology, production AgentRuntime + orchestrator, receipts live):

| Arm | Status | Verified | Req | In tok | Out tok | Reasoning | Tools | Switches | Wall |
|---|---|---|---|---|---|---|---|---|---|
| homogeneous (codestral) | blocked — VERIFICATION_FAILED (test exit 1) | no | 33 | 107,605 | 3,925 | 0 | 26 | 0 | 103.7s |
| heterogeneous | **completed** | **yes** | 34 | 87,485 | 6,033 | 3,966 | 28 | 3 | 133.9s |

The heterogeneous arm routed Explorer → north-mini (probation, the only route the filter admitted for that role), Planner/Reviewer → codestral, Coder → nemotron then codestral after a real upstream 503 — a live role failover absorbed mid-task. North Mini's HARD_FAILURE Reviewer and NOT_TESTED Planner receipts correctly excluded it from both roles. Independent verification passed and the fixture test exited 0.

Prior arms without the role filter (R41-HETEROGENEOUS-AB / -NORMAL-AB / -MULTIFILE-NORMAL-AB) show why the filter was needed: heterogeneous runs blocked with `REVIEWER_BUDGET_EXHAUSTED` and `SUBAGENT_WRITER_BLOCKED` while North Mini held roles its evidence could not support. This is one quality-equivalent heterogeneous success — evidence the mechanism works, not yet a statistically meaningful superiority claim. The homogeneous arm's regression between runs (pass → fail on the same task) shows single-run comparisons carry provider nondeterminism.

## ForgeGreen

Unchanged from the interim slice: R40's nine paired cases, three regressions, and 1.107× aggregate stand as historical truth. No selectivity policy, reversible guard, or new paired corpus shipped in R41 — Gates E/F remain open. No Green savings claim is made.

## Canonical regression closure

The five R40 signatures (CF14 latency bound; two delivery-certification timeouts; two watchdog timing assertions) remain standalone-green and did not recur under either R41 canonical run. Their individual scheduling mechanisms are still unproven — nothing was skipped or weakened.

The post-role-quality canonical run did surface one *new* failure — `r21-forgeverify-malicious-corpus [shell-wrapper-hides-silent-failure]` expecting `testSignal: "none"`, got `"marker"` — and this one **was root-caused**: `parseTestOutput` stripped npm's `> pkg@ver script` / `> cmd` echo only when it sat at output byte 0; under parallel load a preamble (spawn/timeout/PTY artifact) pushed the banner off position 0, leaving `> node fail.cjs` in the parsed text where the filename alone trips the FAIL-marker regex. The strip is now anchored to the `name@version` banner shape wherever it occurs; the corpus file passes 24/24 standalone post-fix. Run detail:

- `npm test` (role-quality sources): **3,828 pass / 1 fail / 48 skip** in 1,221.94s — the single fail is the npm-echo case above.
- `npm test` (post-parser-fix, final): **3,829 pass / 0 fail / 48 skip** in 654.82s — zero unexplained failures; all skips are Postgres-gated files consistent with prior runs.

## Gemini

`PERMISSION_DENIED` + `CONSUMER_SUSPENDED` is classified as structural `ACCESS_RESTRICTED`: hard-excluded, no automatic retry, cleared only by an explicit catalog-change signal — not by credential-change or routine `present` listing. Gemini contributes **zero** usable free capacity and was not called. `R41-GEMINI-CLASSIFICATION` is folded into the health tests rather than a separate artifact.

## ForgeVerify

Reviewer routing now consumes role-quality evidence through the same receipts (a HARD_FAILURE reviewer receipt excludes the route from reviewer selection; qualified peers compete on measured evidence). Deterministic-first layering is unchanged; no live reviewer catch-rate corpus was built — partial Gate L.

## Scale

`R41-SCALE.json` — deterministic simulation (not live users) re-running the 373-user profile against the fabric with role-quality advice and per-role output budgets active: **746/746 completed, 0 starvation, 0 false waits, 0 leaked reservations, 50/50 injected 429s absorbed**, 16 recovery observations, peak holds 48/48 slots. Route distribution: nemotron 282, codestral 272, north-mini 96, gpt-oss-120b 96 — max provider concentration 50.7% (OpenRouter), no stampede onto a single "best" route; North Mini was demoted out of reviewer traffic by its HARD_FAILURE receipt. Gate N passes at simulation level.

## Endurance

Bounded only: four live A/B arm executions (~274 logged requests total across all R41 A/B files, all $0), plus 6+6 planner probes and 2 reasoning-budget probes. No sustained mixed-workload endurance run — Gate P open.

## Free-only guarantee

Every live call used R40-verified-free routes re-checked against the authenticated catalog ($0/token for OpenRouter `:free` IDs); the harness throws on any positive `costUsd` and parks routes on 402/403/429. No Gemini, no paid, no BYOK, no local inference. Observed spend: $0.

## Remaining risks

- ForgeGreen selectivity is unimplemented; R40's three regressions are unexplained at mechanism level.
- The five canonical timing signatures are environmentally correlated but not root-caused; they can recur under load.
- Heterogeneous superiority is a single verified completion — n=1 does not prove a general quality advantage.
- Role receipts have 30-day expiry; a route whose receipt lapses returns to unmeasured (filter-passing) status — by design, but worth watching for silent regressions.
- Groq Planner/Reviewer qualification is still unmeasured (TPM-80); the composite snapshot deliberately excludes Groq rather than guessing.

## Regression evidence

role-quality 19/19, role-qualification 11/11, free-router 13/13, role-routing 14/14 (8 R1 + 6 R41 wiring), free-fabric 31/31, failover 9/9, runtime 3/3, malicious-corpus 24/24 standalone, source-state 8/8; `tsc -b` clean for eight-bit/router/model-registry/server/workflow. Canonical suite (pre-parser-fix): 3,828 pass / 1 fail / 48 skip; final post-fix run: **3,829 pass / 0 fail / 48 skip** in 654.82s.

## Commits

- `c229526` — bounded role output budgets, per-route reservation matching, Google structural-denial classification, interim source-state recertification.
- `c31be7a` — interim R41 evidence and report.
- `920257b` — role-quality evidence → production routing (admission filter, two-tier ordering, failover re-decide), planner protocol V3, transient-vs-capability classification, name-hint evidence precedence, npm-echo parser fix; source-state recertification `a6531eff…`.
- (this commit) — R41 evidence artifacts, live scripts, final report.

## R42 recommendation

Close the three open gates rather than expanding scope: (1) implement deterministic ForgeGreen selectivity + escalation guard and run a corrected paired corpus; (2) root-cause the five load-sensitive canonical signatures under controlled parallel stress; (3) run a bounded sustained endurance campaign exercising role failover, receipt expiry, and Green escalation together. Requalify Groq Planner/Reviewer when its TPM headroom allows.
