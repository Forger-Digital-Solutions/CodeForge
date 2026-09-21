# CodeForge Efficiency Protocol — R23

| Field | Value |
|---|---|
| Protocol id | `codeforge-efficiency-protocol-r23` |
| Protocol version | **1.0.4** (frozen; any change after the first live pilot run requires a new minor version and a re-run of affected results) |
| Frozen at commit | `ae2aa87487e7bd4ca2c4fde47bfc3b978fa50e41` (R22 closure) — the protocol is committed *before* any paired result exists |
| Date frozen | 2026-09-20 |
| Authors | R23 engineering team (one founder + AI agents) |
| Evidence root | `docs/evidence/r23-efficiency-proof/` |
| Digest | the sha256 of this file is stamped into every run record as `protocol_digest`; a mismatch invalidates the record |

---

## 0. Research question

> For the same software-engineering work, performed by the same model through the same CodeForge platform with the same tools, repository state, permissions and verification criteria, how much does CodeForge's efficiency architecture ("the ForgeGreen stack") change the amount of **verified** work delivered per unit of inference?

The headline claim is **CodeForge vs CodeForge control**. Cross-tool comparisons are secondary and never establish the claim (§14).

Pre-registered primary outcomes (decided before any paired data exist):

1. **Verified tasks per 1M model tokens** (ratio of totals, per arm) and its paired per-task counterpart, model tokens per verified task.
2. **Verified success rate** per arm (non-inferiority of the optimized arm is a *requirement* for any efficiency claim, §9).

Everything else in §8 is secondary and reported, never promoted to the headline after the fact.

---

## 1. Environment (recorded, not assumed)

| Item | Value |
|---|---|
| Workstation | Windows 11 Pro 10.0.26200, x64; Intel Core i7-9850H (12 logical CPUs); 32 GB RAM; NVIDIA Quadro T2000 4 GB (idle — no local inference) |
| Runtime | Node v24.19.0, npm 11.17.0, Vitest 5.0.1; Python 3.13.14 (task verifiers only); git 2.55.0 |
| Docker | CLI present, **daemon not running** — public benchmarks that require a container harness are feasibility-gated (§13) |
| CodeForge | branch `forger-digital-solutions-forgegreen-certified`; HEAD recorded per run as `codeforge_commit`; the harness refuses to run on a dirty tree unless `--allow-dirty` is passed **and** the dirty file list is written into the run record |
| Network | Provider calls only; no cloud-api deployment is used or required |

Every run record carries an `environment_fingerprint` = sha256 of {os, cpu model, logical cpus, total memory, node version, codeforge commit, protocol digest, harness version}.

---

## 2. Model and provider

### 2.1 Primary live route

- **Provider:** OpenRouter, via the existing `@codeforge/providers` OpenRouter adapter, credential from the `OPENROUTER_API_KEY` environment variable (never persisted, never logged).
- **Route class:** exact-pinned `:free` model id. `:free` routes are $0 per request. The account holds a pay-as-you-go deposit that unlocks the higher free allowance — live account read on 2026-09-20: `free_model_daily_requests {limit: 1000, used: 59}`, `total_credits: 25, total_usage: 0`. **The deposit is never to be consumed**: the harness sets an explicit `modelSelection` (exact id) — the runtime never substitutes an explicit selection (R21 M9) — and ForgeZero admits only $0-verified routes. If any run record ever shows `actual_cost > 0`, the campaign halts and the cause is recorded.
- **Daily allowance:** 1,000 requests/day (resets 00:00 UTC), 20 requests/min. The harness tracks the day's request count from the live `auth/key` endpoint before each run and **refuses to start a run** that would not fit in the remaining allowance with a 15% margin (§6.3).
- **Substitute primary route (v1.0.4):** if the OpenRouter `:free` pool demonstrably cannot produce a qualified model — defined as: every tool-capable `:free` candidate pre-screened, no candidate meeting the §2.2 bar across at least three qualification rounds, and remaining candidates classified as permanent failures (provider refusal, capability, or policy) rather than transient ones — the primary route may move to **another provider already configured and approved in CodeForge** (an existing credential on the benchmark machine, a `CLEARED` terms status in the provider registry, and an existing adapter). The substitute route must satisfy, with evidence recorded in the pin record:
  1. ForgeZero admits the exact `{providerId, modelId}` pair under a verified free-access class (`FREE_NATIVE`, `FREE_ROUTED`, `FREE_ALLOWANCE`, or `FREE_PROMO`);
  2. the provider's documented free allowance is corroborated by live evidence (quota/rate-limit response headers captured at pin time and per response thereafter);
  3. tool support is verified by a live tool-call probe at pin time, not merely advertised;
  4. the provider returns usage telemetry on served calls;
  5. an **equivalent-cost price reference exists**: the same model's paid listing on the reference marketplace (OpenRouter catalog) — the free route's actual cost remains $0 and the §2.1 `actual_cost > 0` halt applies unchanged;
  6. the unchanged §2.2 qualification bar is applied in full — the substitution changes *where* the bar is applied, never the bar itself. Both arms always run the same provider and model; the A/B comparison is unaffected.
- **Trigger evidence for this clause (2026-09-21):** 19/19 tool-capable `:free` candidates pre-screened on OpenRouter; `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — the only prescreen passer — reached **2 verified of 12 qualification runs across four rounds** (intermittent upstream 502s mid-run); all other candidates ended in provider failure, verification failure, budget exhaustion, permanent restriction, or persistent infrastructure void. The substitute route exercised is `groq::openai/gpt-oss-120b` (registry: `FREE_DAILY_ALLOCATION`, terms `CLEARED`, existing adapter + `GROQ_API_KEY`).

### 2.2 Model selection rule (frozen; the choice is recorded before any pair runs)

The single benchmark model is chosen by a **qualification round that never sees paired OFF/ON data**:

1. Candidates: the tool-capable `:free` models in the live catalog on the qualification day. Because a full round for every candidate would consume most of a day's allowance, candidates first pass a **pre-screen**: one qualification task (`qual-js-return-sign`) in single-agent mode with the optimized runtime switches. Candidates whose pre-screen run does not end `verified_complete`, or that hang, error, or emit malformed tool calls, are excluded with the reason recorded; of the passers, the **six with the lowest pre-screen wall time** proceed (an outcome-blind, capacity-driven cap — efficiency numbers are still not scoring inputs).
2. Each remaining candidate runs the same 3 short qualification tasks (from the pilot corpus, tagged `qualification`) through the **orchestrated execution path in the optimized (production-default) configuration only**.
3. Scoring is reliability and capability only: (a) zero hangs (>120 s without a stream event) and zero upstream 429/5xx in the qualification round, (b) completed all 3 tasks with the deterministic verifier passing, (c) tool-call format validity (no malformed tool calls), (d) lowest median wall time as the tie-break.
4. The winner is written to `docs/evidence/r23-efficiency-proof/pilot/MODEL-SELECTION.json` with all candidates' scores. It is then **fixed for the entire campaign** (pilot, main, ablations). Both arms always use the same model id, provider, and per-call parameters. If the provider retires the model mid-campaign, all incomplete pairs are voided (§7) and the campaign restarts on a new model with a new protocol minor version.

Efficiency numbers (tokens, bytes, calls) are **not** scoring inputs at selection time.

### 2.3 Per-call parameters (identical in both arms)

Runtime defaults are used unchanged in both arms: temperature `0.7` (runtime default), `maxTokens 4096`, `toolChoice auto`, the same tool set (§4.4), the same role prompts, the same execution budgets (`AgentExecutionBudget` defaults for the role). None of these are tuned during the campaign.

### 2.4 Secondary live routes (not headline)

- Mistral (Free plan, pay-as-you-go disabled, $10 included/month; account privacy setting permits training → **synthetic fixtures only**) may be used for a cross-model replication of a task subset. Reported separately as "replication", never pooled with the primary model.
- Groq is eligible as a **substitute primary route** under §2.1 (v1.0.4) — free daily allocation, owner-dev credential, full usage telemetry. Cerebras is **not used** (live 402 — promotional credit exhausted, 2026-09-21). OpenAI key (paid) is **never used**. Gemini key is non-functional (403).

---

## 3. Arms

Every pair runs both arms on the **same task, same starting commit, same freshly materialised workspace copy, same model, same tools, same permissions, same verifier**, back-to-back, in an order alternated per pair (§6.1).

### 3.1 ARM A — CONTROL ("ForgeGreen OFF")

CodeForge's real `AgentRuntime` with every efficiency mechanism that has an off-switch **disabled**:

| Mechanism | Switch | ARM A | ARM B |
|---|---|---|---|
| ForgeGreen advisor: in-flight duplicate model-request coalescing, stable-prefix observation, canonical analysis cache | `createForgeGreenAdvisor({enabled:false})`, no `forgeGreenCacheStore` | off | on |
| FG-1C duplicate read-only action suppression (incl. R22 external-read dedup) | `efficiencyControls.duplicateSuppression` | off | on |
| FG-1B tool-output compression | `efficiencyControls.toolOutputCompression` | off | on |
| FG-3 progressive Context Pages (kernel + narrow slice, cross-run page reuse) | `repositoryIntelligenceFactory` **absent** → assembler `safe_fallback` (Goal + role prompt + plan; **no pre-selected file content**; the model explores with tools) | off | on |
| Repository intelligence retrieval (relevant-file candidates, symbol graph) | same factory | off | on |
| Adaptive topology (deterministic complexity → tiny/normal/complex plan) | orchestrator: explicit `tiny` (coder → ForgeVerify) vs adaptive classifier | off (single agent) | on |
| Mission memory delivery (bounded structured memory into planner/replanner/reviewer prompts) | **inert in this campaign** — mission memory exists only in the long-horizon mission supervisor, which the autonomous run path (`AutonomousRunOrchestrator.startRun`) does not use | — | — |
| FG-12F cost-gated ForgeVerify evidence reuse | **inert in this campaign** — `runVerificationWithControlledReuse` has no production caller (finding F-3, v1.0.1); the orchestrator always runs ForgeVerify fresh | — | — |

The last two rows remain in the arm configuration record (`memoryDelivery`, `verificationReuse`) for provenance, but the harness cannot make them differ between arms on the execution path being measured; every run record notes them as inert. Any later ablation that wires them must say so explicitly.

**Identical in both arms:** model, provider, per-call parameters, tool set, permission leases (`network:false`, `executeCommand` as the task requires), security gates, completion authority (`evaluateCompletion`), the deterministic task verifier, wall-clock and turn budgets, the harness, the machine.

The control is still CodeForge: same runtime, same tools, same prompts, same safety. It is "CodeForge with the efficiency architecture switched to its plainest configuration", not a different product.

### 3.2 ARM B — OPTIMIZED ("production defaults")

The production-intended stack with all rows above **on**, exactly as shipped at the frozen commit. No arm-specific prompt text, tool, budget, or retry policy exists anywhere in the harness (a tripwire test asserts the two arm configurations differ only in the listed switches).

### 3.3 Ablation arms (M8 — after the headline pair set is complete)

Single-mechanism toggles starting from ARM B (turn one row off) and from ARM A (turn one row on). Ablations reuse the same tasks, model and seeds policy; their results are reported in `ablations/` and never mixed into the headline pair set.

---

## 4. Tasks

### 4.1 Corpus composition (target for the main benchmark; the pilot uses a 12-task subset)

| Class | Share | Examples |
|---|---|---|
| small fix | 20% | off-by-one, wrong constant, missing null guard |
| normal bug fix | 25% | regression traced across 2–4 files, wrong branch, race in async code |
| feature implementation | 20% | new module + wiring + tests |
| refactor | 10% | rename/extract across files with tests pinning behaviour |
| build / config / dependency repair | 10% | broken `package.json` script, tsconfig path, lockfile mismatch, failing CI config |
| repository investigation | 10% | "find where X is decided and report the file:line and reason" — answer verified against a hidden key |
| large-context / difficult | 5% | change spanning ≥6 files or requiring reading a >1,000-line file |

Languages: TypeScript, JavaScript, Python, JSON/YAML config, shell/CLI. Platforms: all tasks run on Windows (this workstation). Repository sizes: small (≤20 files), medium (50–300 files), large (≥1,000 files — generated or vendored open-source snapshots).

### 4.2 Task record (frozen before its first run)

Each task is a directory `tasks/<task_id>/` with `task.json` (id, class, language, repo size, goal text shown to the agent, `starting_commit`, permissions, budgets, `verifier` command, `hidden` = true/false), the fixture repository (or a materialiser script producing a bit-identical tree; `starting_tree_hash` recorded), and a verifier that is **never visible to the agent** (hidden test files are injected after the run, into a copy of the resulting workspace, before verification).

### 4.3 Selection and exclusion rules

- Tasks are authored and frozen (`tasks/manifest.json` with per-task sha256) **before** the pilot. Adding tasks later is allowed only as an appended, separately reported batch ("batch 2"); removing or editing a frozen task is not allowed. A task whose verifier turns out to be wrong is **voided for both arms** with the reason logged (§7) — never fixed-and-rerun inside the same batch.
- No task may be constructed from CodeForge's own repository (the agent runs on CodeForge code paths; using CodeForge as the subject would contaminate the harness and the model's view of the tree).
- No task text may mention ForgeGreen, efficiency, tokens, or the benchmark.
- The same task never runs more than once per arm per repetition; a repetition is a full re-run of the task in both arms with fresh workspaces.

### 4.4 Tools available to the agent (both arms)

The runtime's repository tools: `list_files`, `read_file`, `search_files`, `edit_file`, `write_file`, `run_command` (only when the task record grants `executeCommand`), `repo_context` pull tool. No browser, MCP or plugin tools in the headline set (they are measured in M12 with their own tasks). `network:false` on every run.

### 4.5 Contamination policy

- Private corpus tasks are authored for R23; fixture code is synthetic or vendored with a license permitting it, and the task's expected patch never appears in any prompt, memory or index the agent can reach.
- For any public benchmark task (§13): record benchmark name, version/date, instance id, whether CodeForge had previously encountered the instance (search evidence directories and memory for the id), and never tune prompts per instance.
- Models are third-party; their training contamination cannot be controlled — it is identical across arms (same model), so it cannot bias the paired difference, but it can inflate absolute pass rates. Reported as a limitation.

---

## 5. Verification — what "verified" means

A task run is **verified** only when **all** hold:

1. The runtime run ends `status: completed` (the model claimed completion — "claimed_complete").
2. The **deterministic task verifier** passes on the resulting workspace copy with hidden tests injected (`tests_failed == 0`, verifier exit code 0, within its own timeout). For investigation tasks the verifier compares the agent's final answer against a hidden key with an exact-match or bounded-regex rule frozen in `task.json`.
3. CodeForge's completion authority (`evaluateCompletion` → ForgeVerify) returns PASS for the run's own verification plan (the same plan definition in both arms; ARM B may *reuse* evidence under FG-12F, ARM A always runs fresh).
4. No forbidden action occurred: no file written outside the workspace, no security-gate denial escalated into a bypass, no network use.

Definitions used in every report:

| Term | Definition |
|---|---|
| `claimed_complete` | runtime `status === "completed"` |
| `verified_complete` | claimed_complete ∧ verifier pass ∧ completion-authority PASS ∧ no forbidden action |
| `false_complete` | claimed_complete ∧ ¬verified_complete (the dangerous case) |
| `verification_failed` | ran to a terminal state, verifier or authority failed |
| `blocked` / `failed` / `aborted` | runtime terminal states other than completed; classified in §7 |

**Read-only investigation tasks** (`role: explorer`) produce a report, not a change, so ForgeVerify has nothing to verify. For them criterion 3 is the production explorer contract: the run must end `completed` with a **validated structured explorer result** (summary + findings + evidence, the same contract an explorer child must satisfy inside the orchestrator); criterion 2 is the hidden tree-intact verifier plus the answer key applied to the structured `summary`. They run through the single-agent execution path in both arms (topology is inapplicable); every other switch applies.

Partial completion is **never** counted as verified. Verification criteria are frozen in the task record and cannot change after a run.

---

## 6. Run policy

### 6.1 Pairing and order

Pairs run back-to-back on the same day and same model. Arm order alternates per pair by task index parity (even → A then B; odd → B then A); repetitions flip the order. Order is recorded (`pair_order`).

### 6.2 Repetitions and stochasticity

- Pilot (M5): 12 tasks × 2 arms × 1 repetition, plus 3 qualification tasks per candidate model.
- Main (M7): all frozen tasks (target 30–50) × 2 arms × 1 repetition = the **primary set**.
- Variance subset: a pre-declared subset of ≥ 8 tasks (chosen by stratified task index — every 4th task in manifest order — *not* by result) × 2 arms × 3 repetitions. Repetition data are used to estimate within-task dispersion and are reported alongside the primary set; the primary set's first repetition is never replaced by a "better" repetition.
- Temperature is the runtime default (0.7) in both arms. Provider-side randomness is not controllable on `:free` routes; no seed parameter is sent.

### 6.3 Budgets, timeouts, and rate limits

- Per run: the role's default `AgentExecutionBudget` (model turns, tool calls, writes, commands) — identical in both arms; a run that exhausts its turn budget is `blocked` (R21 budget honesty) and counts as **not verified**.
- Wall-clock cap per run: **20 minutes** of active time; provider rate-limit waits (429 with `retry-after`, 20 RPM pacing) are recorded as `rate_limit_wait_ms` and excluded from `active_agent_time` but included in `wall_clock_time`.
- Daily allowance: a run is not started unless `remaining_daily_requests ≥ 1.15 × p90(model_calls per run observed so far, min 40)`. If the allowance runs out mid-pair, the incomplete pair is **voided** (§7) and re-run whole the next day. For substitute routes (§2.1) the same gate is evaluated on the provider's own capacity signal: live `x-ratelimit-*` headers for the request window, plus the day's cumulative token spend from the per-call ledger against the provider's documented daily token cap (same 15% margin). Minute-scale rate windows are handled by the capacity governor's pacing, which is recorded as `rate_limit_wait_ms`, not counted as allowance exhaustion.
- A run terminated by a **provider-side** failure (HTTP 5xx, upstream 429 not caused by our own pacing, or a stream hang > 120 s) **before the model's first tool call** is `infrastructure_void` and re-run once in the same arm order; the void is logged. The same failure **after** the first tool call counts as a run failure (`provider_failure`) — autonomous agents must survive their supply, and both arms face the same supply.

### 6.4 What the harness records (schema in `docs/evidence/r23-efficiency-proof/schemas/`)

Identity, outcome, inference, context, agent activity, time, economics fields as listed in the R23 brief and formalised in `run-record.schema.json`; plus a **per-model-call ledger** (`calls[]`: provider/model, latency, prompt/completion/cached/reasoning tokens with `usage_source`, finish reason, provider-reported cost, http status, retry index) so provider receipts can be reconciled call-by-call.

---

## 7. Failure classification and exclusions

Terminal classification (one per run):

`verified_complete` · `false_complete` · `verification_failed` · `budget_exhausted` · `provider_failure` · `tool_failure` · `security_blocked` · `timeout` · `harness_error` · `infrastructure_void`

Rules:

- `harness_error` (a defect in the benchmark harness itself, not in CodeForge) voids **both arms** of the pair; the defect is fixed, a regression test is added, and the pair is re-run.
- `infrastructure_void` is the only single-arm re-run (§6.3).
- **Every** void/exclusion is appended to `docs/evidence/r23-efficiency-proof/raw/exclusions.jsonl` with `{reason, timestamp, task_id, run_id, pair_id, protocol_rule}`. Excluded runs' raw records are kept, never deleted.
- Nothing else is ever excluded. A task on which both arms fail stays in the denominator.

---

## 8. Metrics

### 8.1 Primary

```
verified_tasks_per_1M_tokens(arm) = Σ verified_complete(arm) / (Σ total_model_tokens(arm) / 1,000,000)
model_tokens_per_verified_task(arm) = Σ total_model_tokens(arm) / Σ verified_complete(arm)
verified_success_rate(arm) = Σ verified_complete(arm) / N_tasks
```

`total_model_tokens` = provider-reported prompt tokens (cached and uncached) + completion tokens (+ reasoning tokens where the provider reports them separately) across **every model call made on behalf of the task** — orchestrator, planner, explorer, coder, reviewer and any LLM-based verification call. Estimated tokens are never substituted for provider-reported tokens; a call with `usage_source: UNKNOWN` makes the run's token total `UNKNOWN` and the run is reported but excluded from token metrics (with the count of such runs shown).

### 8.2 Secondary (all reported per arm and as paired differences)

- false_completion_rate, verification_failed_rate, severe_failure_rate (security_blocked + tool_failure + harness_error), retry_rate
- input / output / cached / uncached tokens per task; model_calls, failed_calls, retried_calls, rate_limited_calls per task
- tool_calls per task by class (read, search, write, command); avoidable_duplicate_context_tokens per task (§10)
- wall_clock_time, active_agent_time, model_wait_time, tool_time, verification_time per task; per verified task
- verified_tasks_per_100_model_calls; verified_tasks_per_$1_equivalent; equivalent_cost_per_verified_task (§11)
- local resources: process CPU time (user+system), peak RSS, network bytes (§12)
- ForgeVerify: verification model calls and tokens, deterministic checks run, evidence reused (ARM B), false-completions caught
- subagents (topology arms): subagent_count, incremental tokens, incremental verified successes

### 8.3 Statistics

- Tasks are paired; all inferential statistics are on **paired per-task differences** (B − A) and on **ratios of per-arm totals**.
- For each headline metric: N, mean, median, IQR, and a **95% bootstrap confidence interval** (10,000 resamples, resampling *tasks* — pairs — with replacement; for ratio-of-totals metrics the ratio is recomputed on each resample). Wilcoxon signed-rank on paired token differences is reported as a secondary check. No other tests are run; nothing is chosen after seeing data.
- Verified-rate difference: paired proportion difference with a bootstrap CI; a non-inferiority margin of **5 percentage points** is pre-declared (§9).
- Heterogeneity: results are also shown per task class; with N ≈ 30–50 heterogeneous tasks the report states dispersion honestly and does not claim precision the CIs do not support.
- Repetition data: within-task standard deviation of tokens and success is reported for the variance subset; the primary set is never replaced by repetition means.

---

## 9. What may be claimed

A ForgeGreen efficiency claim requires **all** of:

1. `verified_success_rate(B) ≥ verified_success_rate(A) − 0.05` with the CI's lower bound above −0.10 (non-inferiority), **and** `false_completion_rate(B) ≤ false_completion_rate(A) + 0.02`.
2. The 95% CI of the paired difference in `total_model_tokens` per task excludes zero in the saving direction.
3. The saving is not driven by a single task class: removing any one class leaves the point estimate's sign unchanged.

If (1) fails, the verdict is `R23_EFFICIENCY_NOT_YET_PROVEN — quality regression`, regardless of token savings. If (2) fails, `R23_EFFICIENCY_NOT_YET_PROVEN — no detectable saving`. Otherwise `R23_CODEFORGE_EFFICIENCY_AND_AUTONOMY_PROVEN` may be stated **only with** the measured X/Y/Z and their CIs, N, task population, model, and limitations. Percentages are stated as measured (7% is 7%).

---

## 10. Duplicate context — frozen definition

Applied per run over the sequence of model calls `c_1..c_n`, each a list of messages.

- **Necessary repeat (not waste):** the re-transmission of the conversation prefix on each call — `Σ_i bytes(messages_i) − bytes(messages_n)` — is `provider_statelessness_repeat_tokens`; reported but never labelled avoidable. Also necessary: the first delivery of any content; re-reads after a mutation of the same path (`stateVersion` bump in `DuplicateActionSupervisor`); explicit recovery replays; critical instruction reinforcement blocks defined by the role prompt.
- **Avoidable duplicate:** a tool result whose **exact content hash** (after stripping the provenance prefix) equals that of an earlier tool result in the same run with no intervening mutation of any file it depends on (read/list/search with identical canonical arguments and identical output), or bootstrap-injected file content whose hash equals a later `read_file` result of the same path with no intervening write. Measured exactly by sha256 of normalised content; counted in bytes and in tokens using the provider's own prompt-token ratio for the run (`total_prompt_tokens / total_prompt_bytes`), labelled `DERIVED`.
- **Semantic near-duplicates** (same file, different range; paraphrased summaries) are **not** counted as duplicates. If a future R23 report wants to discuss them it must label them `ESTIMATED` and give the method.

---

## 11. Economics

- `actual_cost`: provider-reported cost when available (OpenRouter `usage.cost`, requested with `usage: {include: true}`), else derived from the route's listed price (`$0` on `:free`), labelled by source.
- `equivalent_public_api_cost`: tokens × the **frozen pricing snapshot** `docs/evidence/r23-efficiency-proof/cost/pricing-snapshot-<date>.json` (taken from the live OpenRouter catalog on the qualification day: the paid listing of the *same* model where one exists, else the nearest paid variant with the mapping written down). Cached-input tokens priced at the snapshot's cache-read rate where listed, else at the input rate (stated).
- `equivalent_market_cost`: the same tokens priced at a named reference frontier-model rate from the snapshot, to express "what this work would cost on a typical paid API" — clearly labelled a reference, not a saving.
- `actual_cost` and equivalent costs are never conflated; every table shows both.

---

## 12. Resource and energy accounting

- **Measured (local):** for each run, the harness process's CPU time (user+system via `process.cpuUsage()`), peak RSS, wall time, and provider-response bytes counted at the adapter; sampled via a new RUNTIME-origin adapter that replaces `NullHardwareTelemetryAdapter` only for measurement fields it can actually observe. GPU power via `nvidia-smi` is sampled once per run for completeness and reported as "idle local GPU" — it is not attributed to inference.
- **Remote provider energy:** **never measured, never claimed as measured.** If reported, it is a clearly separated MODELED section with CONSERVATIVE / CENTRAL / HIGH scenarios, each citing its assumed Wh per 1k tokens and PUE with source, applied to the *measured* token reduction only. The report states the provider's accelerator type, batching, quantisation and electricity mix are unknown.

---

## 13. Public benchmark component (M15) — feasibility-gated

- Candidates: SWE-bench Verified; SWE-rebench (rolling, decontaminated). Both require executing each instance's test suite in the instance's own environment (typically via the official container harness).
- Gate: the official evaluation harness must run on this workstation (Docker daemon or a documented WSL2 path) **without** paid spend. If not feasible during R23, the public component is reported as `NOT RUN — environment`, and the private corpus stands alone with that limitation stated.
- If feasible: a fixed random sample (seeded, seed recorded) of ≥ 20 instances, both arms, same run schema, same statistics; results in `public-benchmark/`, kept separate from the private corpus and from any cross-tool comparison.

---

## 14. Cross-tool references

Published results of other agents (Claude Code, Cursor, OpenHands, Codex-style agents, Kilo, OpenCode) may be cited with source, date, model and benchmark version, in a clearly separate section labelled "not a controlled comparison". They never enter the headline arithmetic.

---

## 15. Anti-gaming rules (binding)

Forbidden: deleting hard tasks after failure; changing task criteria or verifiers after seeing results; changing model, provider or parameters across arms; changing the starting tree; giving one arm more tools, turns or budget; manual help to either arm; hiding failed runs; counting partial completion; selecting seeds or repetitions by outcome; dropping expensive runs without a §7 rule; changing this protocol's metric definitions after the pilot.

Enforced mechanically where possible: arm-configuration tripwire test; per-task frozen sha256 in the manifest checked at run start; `protocol_digest` on every record; `exclusions.jsonl` append-only; the analysis script recomputes every summary number from raw run records (no hand-entered numbers).

---

## 16. Pilot gate (M5 → M7)

The pilot's purpose is to prove the measuring equipment. The main benchmark starts only when every item below is true and recorded in `pilot/R23-PILOT-REPORT.md`:

- per-call ledger totals equal the run totals for every pilot run (Σ calls == run record);
- provider-reported prompt+completion tokens are present (`usage_source: PROVIDER_REPORTED`) on ≥ 98% of calls, and the live account's daily request counter advanced by exactly the number of ledger calls carrying provider-reported usage — the free-request counter counts *served* requests; upstream errors do not consume it (semantics verified against live counter data on 2026-09-21: 87 served ledger calls = `used: 87`) (receipt reconciliation);
- cached-token fields are populated when the provider reports them and `UNKNOWN` otherwise (never zero-by-default);
- every run carries task_id, pair_id, arm, protocol_digest, environment_fingerprint, model, starting_tree_hash, ending_tree_hash;
- the verifier verdict and the completion-authority verdict are both present on every terminal run;
- the harness survives a forced mid-run crash and the surviving records are complete or explicitly marked incomplete (restart fixture, M4);
- cost conversion reproduces the frozen snapshot arithmetic exactly (golden test);
- the arm-configuration tripwire passes.

If any item fails: stop, fix the instrumentation, add a golden test, re-run the pilot.

---

## 17. Reporting

Raw records first (`raw/*.jsonl`), then generated summaries (`summaries/*.json|.md`), then the final report. Every number in a summary is recomputed from raw by `scripts/r23-efficiency-report.mjs`; the final report links each headline number to the summary field and the summary to the raw files. The final report states what was and was not proven, N, model/provider, task and repository population, environment, success rates, failures, exclusions, CIs, measured token/cost/local-resource differences, modelled remote-energy scenarios, and known limitations.

---

## 18. Change log

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-20 | Frozen before the first pilot run. |
| 1.0.2 | 2026-09-21 | Before any live run: §2.2 adds the outcome-blind pre-screen and the six-candidate cap for the qualification round (daily-allowance budget). |
| 1.0.3 | 2026-09-21 | Before any pilot run: §16's receipt-reconciliation item is corrected to match the counter's measured semantics — `free_model_daily_requests.used` advances only on served requests, so it must equal the count of ledger calls with `usage_source: PROVIDER_REPORTED`, not raw attempts (raw attempts include upstream 4xx/5xx that are never served). Verified on live data: 87 served calls = `used: 87`. |
| 1.0.4 | 2026-09-21 | Before any pilot run, with the qualification bar unchanged and `winner: null` preserved: §2.1 adds a substitute-primary-route clause (necessity amendment — the OpenRouter `:free` pool produced no qualified model: 19/19 pre-screened, best candidate 2/12 verified across four rounds, remainder permanent failures or persistent voids; trigger evidence is recorded in §2.1). §2.4 moves Groq from "not used" to substitute-route eligibility; Cerebras stays excluded (live 402). §6.3 generalises the allowance gate to provider-native capacity signals. Equivalent-cost pricing for a substitute route uses the same model's paid listing on the reference marketplace. No success criterion, threshold, or scoring rule is relaxed. |
| 1.0.1 | 2026-09-21 | Before any live run, after the scripted dry run of all 15 tasks: (a) §5 defines the completion authority for read-only investigation tasks (the v1.0.0 wording only covered change-making tasks and made every investigation run a false completion by construction); (b) §6.4 records that `dry_run` is a phase. Two product findings from the dry run are recorded, not worked around: ForgeVerify's autonomous path admits only `node`/`npm`/`npx` verifiers (Python tasks fail identically in both arms), and the deterministic diff review blocks verification-config edits (the build-config task fails identically in both arms). Both stay in the corpus as measured. (c) §3.1 corrects the arm table: mission memory and FG-12F evidence reuse are inert on the autonomous run path (FG-12F has no production caller — finding F-3); the exercised switches are the ForgeGreen advisor, FG-1C, FG-1B, the FG-1D/FG-3D cache, the FG-3 context planner, and topology. |
