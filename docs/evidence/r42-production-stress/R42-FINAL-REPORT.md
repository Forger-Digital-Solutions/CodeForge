# CODEFORGE R42 FINAL

**Verdict: R42 PARTIALLY VERIFIED.** ForgeGreen is now selective by construction — a
per-run policy resolves FULL/CONSERVATIVE/OFF from task shape and escalates on
quality-risk signals — and every timing gate left open in R41 now has a closed,
mechanism-level explanation or a deterministic assertion. The paired live corpus
(12 tasks × 2 arms) shows the safety property holds: zero correctness regressions
provably attributable to Green controls, and the one paired outcome regression
(multi-file) was caught by the verifier and failed closed. What the evidence does
**not** show is a general efficiency win: duplicate suppression never engaged in
the corpus (0 candidates considered in 24 arm-runs), and quality-adjusted Green
output is a modest −4.5% input tokens on paired passes. R42 is honest about both
halves of that sentence.

## Selective ForgeGreen policy

New module `packages/server/src/forgegreen-run-policy.ts`, resolved per run inside
`executeAgentRun` (the `AgentRuntime` is session-scoped, so the policy is not a
construction-time flag):

- **FULL** — all enabled controls run (duplicate suppression, tool-output
  compression, superseded compaction, completed-response dedup).
- **CONSERVATIVE** — the classifier still runs and `escalate` verdicts still
  interrupt no-progress loops; only *replay* paths are downgraded
  (`suppress` → `execute`, `runDeduplicated` completed-cache disabled). Repair,
  review, and coordinated-multi-step dispatches enter CONSERVATIVE; they are the
  runs where an identical retry must see fresh output, not a cached one.
- **OFF** — escalation target when the run shows quality-risk signals (unusable
  response, content-filter/length truncation, no-effect write, failover, provider
  error). OFF still records policy state; it never reports an escalation as a
  success.

A latent hazard was closed in the process: `ForgeGreenAdvisor.runDeduplicated`
cached **completed** identical model responses for the advisor's lifetime, so an
exact-identical retry after an unusable response could replay the same bad answer.
Dedup is now gated by the per-run policy.

The `forgegreen.optimization_summary` event payload carries a `runPolicy` record
(`initialLevel`, `level`, `initialReasonCodes`, `escalations`,
`preventedReplays`), so per-run policy state is durable evidence, not inference.
Baseline arms pin the ceiling to `OFF`-equivalent controls; policy resolution and
escalation counters still run, which is what makes the arms comparable.

## Paired corpus — the numbers, not the narrative

`R42-FORGEGREEN-AB.json`: 12 tasks × 2 arms against 64 verified-free routes
(openrouter / groq / mistral). Historical arm ordering was kept (baseline first
per task), all runs under the production orchestrator.

| Outcome class | Count | Tasks |
|---|---|---|
| BOTH_PASS | 7 | cfg-edit, bug-fix, sum, test-repair, refactor, exploration-bug, one-shot-edit |
| BOTH_BLOCK | 3 | rename, guard, coordinated-api |
| G pass / B block | 1 | add-fn |
| **G block / B pass** | 1 | **multi-file** |

BOTH_PASS aggregate (7 pairs): green **85 calls / 251,908 in / 10,669 out** vs
baseline **88 / 263,668 / 11,574** → 0.966× calls, 0.955× input tokens,
0.922× output tokens. Modest and real — not a multiplier claim.

- **Suppressions: 0** in all 24 arm-runs (`candidatesConsidered: 0` in every
  optimization summary). These workloads produced no identical-read patterns for
  the supervisor to replay — the R38–R40 "suppression" deltas were therefore
  almost certainly compression/compaction effects plus variance, now directly
  measured rather than inferred.
- **Escalations fired: 4** (add-fn ×1, coordinated-api ×2, exploration-bug ×1) —
  CONSERVATIVE→OFF on quality-risk signals. The escalation path is exercised by
  real traffic, and two of the escalated runs still completed.
- **Verification parity:** identical verifier exit codes on every BOTH_PASS pair
  (all 0). Reviewer verdicts matched arms. The multi-file green arm's verifier
  ran and exited **1** — the gate blocked it correctly.
- **multi-file forensic:** the green coder made a wrong edit (`a.a()` did not
  emit the expected marker), ForgeVerify caught it, the run blocked. Suppression
  counters were 0, so the Green mechanisms still in play were compression and
  superseded compaction; attribution of the wrong edit to them is *plausible but
  unproven* at n=1. Two consecutive corpora (R40 +26% calls, R42 blocked) place
  multi-file coordination as the weakest Green surface — the policy already
  enters it CONSERVATIVE.
- **add-fn** went the other way (green completed, baseline blocked at 8 calls) —
  symmetric evidence that single-run outcome differences on this corpus carry
  provider nondeterminism in both directions.

## ForgeVerify under Green

Mechanism chain, all evidenced:

1. `compressToolOutput` retains every failure line plus ±8 lines of neighborhood
   and head/tail (`fg1-compression.test.ts`, 8/8) — a verifier's failing summary
   cannot be folded away.
2. The completion gate reads **structured** `VerificationResult` fields
   (`exitCode`, `failed`, `status`) — transcript text is display-only
   (`fg2-runtime-integration` proves the gate is unchanged by Green controls).
3. The corpus shows it empirically: every paired arm produced identical verifier
   exit codes, and the one divergence (multi-file) was a real failure the gate
   caught — not a suppressed or laundered one.

## Role intelligence under pressure

`roleQualificationStatusFor` / `roleAdmissionAllowed` were extracted into
`packages/eight-bit/src/role-quality.ts`; `AgentRuntime.roleQualificationStatus`
now delegates, so the runtime and the stress harness execute the *same* expiry
and inheritance semantics (EXPLORER reads a legacy TOOL_AGENT verdict; a fresh
receipt that never measured the role reads NOT_TESTED and is excluded; stale
evidence reverts to legacy eligibility rather than permanent quarantine).

`R42-ROLE-ROUTING-STRESS.json` (deterministic, production fabric + ledger +
health authority — simulated capacity, not live users):

- **Role conflicts** (23 checks): reviewer work never landed on a
  HARD_FAILURE/NOT_TESTED route; with zero qualified reviewer supply the fabric
  fails closed instead of routing to a disqualified route.
- **Evidence expiry** (9 checks): HARD_FAILURE excludes at 0d and 29.999d, expires
  to legacy eligibility at exactly 30d; stale QUALIFIED keeps eligibility but
  contributes 0 score, `ROLE_EVIDENCE_STALE`, `needsRequalification`. Stale
  evidence can no longer permanently quarantine *or* permanently promote.
- **Capacity vs quality** (4 checks): a saturated QUALIFIED route yields to a
  healthy PROBATION peer — no false wait; when all supply is constrained the task
  queues bounded and re-admits when the window reopens.
- **Stampede** (5 checks): 373 simultaneous coder tasks spread 128/117/128 across
  three asymmetric-quality routes, peak holds inside the concurrency ceilings,
  zero false waits, zero leaked reservations. Bounded ±12 role adjustment steers
  ordering; it does not stampede.

## Reasoning/output budgets

`R42-BUDGET-STRESS.json` (7 checks) plus the standing `role-output-budget.test.ts`
suite (15+): role demands + per-route reasoning reserve (North Mini, gpt-oss-120b)
stay inside the 4k cap; unresolved routes hold the bounded worst case; a
nearly-full context contracts `maxTokens` instead of overrunning; zero context
room fails closed before any provider request; failover recomputes the budget for
the replacement route.

## Timing determinism — the three mechanisms, separated

- **CF14** (`cf14-large-repo-benchmark.test.ts`): the fixture claimed a repo
  benchmark but never `git init`'d — `buildContextPack`'s four git probes were
  pure failed-spawn overhead. The fixture is now a real repo, and the absolute
  `<500ms` bound is expressed relative to the test's own measured symbol-search
  median (the bound now measures the mechanism, not machine load). Standalone:
  green in 44s.
- **Delivery certification**: a serialized spawn-storm (~60 git/node subprocesses
  per delivery pipeline, ~15–19s standalone) that breached vitest deadlines under
  parallel worker contention. Tests were re-isolated and given honest deadlines;
  every correctness assertion retained; 14/14 standalone. Nothing skipped.
- **Progress watchdog**: root-caused a real race — wall-clock staleness could win
  over an objectively exhausted extension budget, letting a paced worker be
  classified `stalled`. Fixes: stall requires **two consecutive** stale windows,
  and an abort at the exhausted extension ceiling is always labeled
  `watchdog_budget_ceiling` (the budget spent is the objective fact; final-window
  staleness is the racy signal). `watchdogAbortReason`/`watchdogExtensions` now
  persist on the worker record; tests assert mechanism facts, not durations.
  2/2 standalone.

## Parser hardening (audit → real fix)

`npm-echo-parse.test.ts` (7/7) pins the R41 npm-echo fix (banner-anchored strip
survives preambles) and **closed a residual hole the audit found**: pnpm/yarn echo
commands as `$ node fail.cjs`, which the old `>`-banner strip left in parsed text
— a `fail`-named script could fabricate `failed=1` on the marker path. `$ cmd`
echo lines are now stripped; bare `> ` lines without a banner are still kept
(program output legitimately starts lines that way). The full malicious corpus
(24/24) still passes — the hardening added no laundering surface.

## Endurance — simulated vs real, kept separate

**Simulated** (`R42-ENDURANCE.json`): 120 epochs × 8 mixed-role tasks (960 total)
through the production fabric/ledger/health code paths with injected churn — 4
park→probe→re-enter cycles, 27 transient timeouts, role-conflicting receipts
(mistral HARD_FAILURE reviewer). Result: **960/960 completed, 0 starved, 0 false
waits, 0 denied-residue, 0 leaked reservations, 4/4 parks recovered.**

**Real:** the 24 arm-run corpus above (~35 min wall, ~700k input tokens across
verified-free routes) — real provider traffic, real verification, real gate.

No conflation: the 960-task number is deterministic simulation evidence about the
admission/health machinery; the corpus is the live evidence about the models.

## Recovery

`R42-RECOVERY.json` (6 checks): healthy primary → injected 429 burst parks it
(`RATE_LIMITED`, hard-excluded) → four consecutive admissions all fail over to
the alternate, primary never selected → cooldown + a successful
production-shaped `probe_gate` observation → route re-enters selection. Zero
leaked reservations at every phase boundary.

## Gemini

In `scenarioRoles` the catalog fixture includes `gemini/gemini-2.5-flash` with the
*highest* qualityScore in the set, excluded by the same structural entitlement
quarantine the runtime applies (`CONSUMER_SUSPENDED` → removed before the fabric
sees it). Across repeated admissions: **0 candidates, 0 selections** — and no
retry loop, since exclusion happens above the retry path entirely.

## Scale

`R42-SCALE.json` revalidates R41's 373-user/746-task profile with the role
admission filter now active on the fabric path (the delta vs R41's sim, which
applied only ranking advice): **746/746 completed, 0 starved, 0 false waits, 0
leaked reservations, 50 injected 429s, 0 role-ineligible selections, every
distinct park recovered.** Receipt statuses are the real R41-ROLE-PROFILES
verdicts with timestamps re-based into the fixture window (the property under
test is status-driven eligibility, not calendar age — flagged in the artifact).
Provider distribution 378/272/96, max concentration 50.7% — identical to R41.

## Free-only guarantee

Every live call in the corpus ran on verified-free routes ($0 prompt/completion
price checked against the authenticated catalog; the harness throws on any
positive `costUsd` and parks on 402/403/429). No Gemini, no paid fallback, no
BYOK, no local inference. Observed spend: **$0**.

## Canonical regression

- `npm test` (pre-watchdog-label-fix): **3,844 pass / 2 fail / 48 skip** in 660s —
  the two failures were the R42 watchdog assertion itself (extension count, load
  residue — re-scoped to the mechanism fact) and `agent-orchestrator-integration`
  (a real regression the R42 abort-reason rule introduced: `extensions >= max`
  degenerated to `0 >= 0` on the zero-extension phase-ceiling path, labelling
  phase-killed explorers `watchdog_budget_ceiling` → `blocked` instead of
  `cancelled`; fixed by requiring `maxExtensions > 0` before a ceiling label).
- `npm test` (final): **3,846 pass / 0 fail / 48 skip** in 610.55s. All skips are
  Postgres-gated files consistent with prior canonical runs. Zero unexplained
  failures; no test skipped or weakened to get here — the delivery-certification
  and CF14 suites kept every correctness assertion, only the incidental deadline
  and the non-repo fixture changed.

Targeted surfaces beyond canonical: forgegreen-run-policy 10/10,
npm-echo-parse 7/7, role-quality 19/19, role-qualification 11/11, free-router
13/13, role-routing 14/14, ForgeVerify corpus + gate suites 73/73,
delivery-certification 14/14, progress-watchdog 2/2, cf14 standalone green (44s).

Source-state recertification: `r42-forgegreen-selectivity-v1` re-issued with the
new policy file and the parser/runtime changes (`01929018…`).

## Remaining risks — evidence-backed only

- **Suppression is unexercised in vivo.** 0 candidates across 24 arm-runs means
  the replay path's live benefit is still unproven (unit-tested, never fired
  live). A corpus with read-heavy exploration loops is needed to measure it.
- **multi-file attribution is indeterminate.** One paired outcome regression
  where Green mechanisms cannot be excluded; two corpora in a row flag
  coordinated multi-file work as the weakest surface. n=2 is a pattern to watch,
  not a proof.
- **Homogeneous route field.** codestral-latest dominated candidate ranking this
  run; cross-provider heterogeneous assignment under Green was exercised via
  policy levels but not via provider diversity.
- **Single-machine canonical.** Wall-clock-sensitive suites are green standalone
  and in canonical order; a heavily loaded different host could still expose
  residual spawn-storm sensitivity — the assertions now target mechanism facts.

## Commits

- `856b878` — selective ForgeGreen run policy (FULL/CONSERVATIVE/OFF), per-run
  resolution in `executeAgentRun`, dedup-cache gating, policy event payload, 10
  policy tests, source-state recertification.
- `6678f04` — watchdog abort-reason mechanism fix + persisted abort facts;
  delivery-cert isolation; CF14 fixture/load-relative bound; npm-echo `$ `
  hardening + regression suite; shared role-quality status extraction; R42
  stress harness + corpus harness.
- (this commit) — R42 evidence directory (5 stress artifacts + paired corpus +
  probe) and this report.

## R43 recommendation

1. Build a read-heavy exploration corpus to exercise suppression live — without
   it the mechanism is proven-safe but unproven-useful.
2. Re-run `multi-file`/`coordinated-api` shapes with ≥5 samples per arm to
   resolve the attribution question; if Green-attributed, coordinated work
   should start at OFF rather than CONSERVATIVE.
3. Extend the endurance sim with receipt-expiry mid-run (cross the 30-day
   boundary during a run) — currently proven at the boundary, not over it.
4. Keep R43's pass bar on mechanism evidence, not Green multipliers.
