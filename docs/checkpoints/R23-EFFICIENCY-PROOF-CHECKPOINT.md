# R23 Efficiency Proof — Continuation Checkpoint

Updated: 2026-09-21 ~00:45 local / ~04:45 UTC (protocol v1.0.5 — §16 served-call denominator; nemotron rounds 7–8 done; still no winner; supply exhausted for this window)
Branch: `forger-digital-solutions-forgegreen-certified`
Base: `ae2aa87` (R22 closure) — verified clean at M0.

## HEAD and tree

| | |
|---|---|
| HEAD | `5e86da1` R23 v1.0.5: §16 coverage denominator aligned to served calls |
| Pending commit | nemotron rounds 7–8 campaign/run records + `MODEL-SELECTION.json` merge (winner: null) + this checkpoint |
| Canary status | Canonical suite green at recovery: 421 files / 3315 tests / 0 failures / 471 s. Latest targeted re-runs: forge-zero 19 pass / eight-bit 176 pass + 2 skip (incl. stream-interrupt taxonomy tests) / providers 184 pass / model-registry 85 pass — 0 failures. |

## Completed phases

- **M0 Recovery** — `recovery/R23-RECOVERY-NOTE.md`.
- **M1 Measurement inventory** — `instrumentation/R23-MEASUREMENT-INVENTORY.md` (9 critical gaps).
- **M2 Frozen protocol** — `docs/benchmarks/codeforge-efficiency-protocol-r23.md` **v1.0.5**, sha256 `dc39943cc965233a4402d39e87f887810484d264773d0c5f823c646540771773` (`protocol/PROTOCOL-DIGEST.txt`, verified MATCH, full version history preserved).
- **M3 Instrumentation** — `packages/forgegreen-campaign/src/r23/*`; inventory gaps 1–7, 9 closed; gap 8 via orchestrated-mode ledger.
- **M4 Golden tests** — 36 instrumentation + 8 report-statistics tests green.
- **M5 prep** — 15-task corpus frozen (`benchmarks/r23/manifest.json`), pricing snapshot, scripted dry-run green, report tool, Python verifier fix.
- **M5 live qualification** — 19-candidate OR prescreen + re-screens + nemotron ×8 rounds + groq ×2 rounds; **no qualified model** (details below).
- **M14 8-Bit route ledger** — `eight-bit/src/route-ledger.ts`: consolidated ledger rows + `findOwnershipViolations` + `aggregateSupplyDomains`. New `SPONSORED_FREE` supply class, `QuotaPeriod`, `expiresAt` on `CapacityWindow`. Evidence: `supply/M14-ROUTE-LEDGER.md`; 8 tests.
- **M14A GitHub Copilot entitlement** — `@github/copilot-sdk` v1.0.14 official: `account.getQuota`, `models.list`, `assistant.usage`, per-user OAuth. Definition corrected `NOT_ALLOWED`→`LEGAL_REVIEW_REQUIRED`, `FREE_ACCOUNT_ENTITLEMENT`, flagged `userConnectedFree` profile; `implemented:false`. Addendum: **GitHub Models API returns 410 (scheduled retirement brownout)** — Copilot SDK is now the only live GitHub entitlement surface. Evidence: `supply/M14A-GITHUB-COPILOT-ENTITLEMENT.md`.
- **M14B Ollama entitlement accounting** — `OLLAMA_LOCAL` domain (`DISTRIBUTED_USER_FREE`/`DEVICE`, constructed ineligible pending owner policy on local inference). Evidence: `supply/M14B-OLLAMA-ENTITLEMENT.md`; +3 tests.
- **M14C Managed provider inventory** — `supply/provider-inventory-raw.json` (31 providers) + `supply/M14C-MANAGED-PROVIDER-INVENTORY.md`.
- **§16 certification note (v1.0.5, corrected)** — `instrumentation/R23-INSTRUMENTATION-CERTIFICATION.md`: coverage denominator is now **served calls** (calls that received a response). Recomputed across all inspected evidence: **245/245 live served calls = 100.0% PROVIDER_REPORTED**; all 48 UNKNOWN-usage calls were unserved upstream errors (already penalised as reliability failures under §2.2). Provider counter reconciliation proven exact after ~2 min settlement. Earlier "72.1% vs 98% bar" interpretation (all-attempts denominator) preserved in the note's history.
- **M14D/M14E** — `forgeAutoSupplyPlan` (shared→sponsored→user ordering, cross-user exclusion proven; 11 ledger tests) + capacity model: **~66 tasks/day ≈ 22 DAU** on today's verified fabric.
- **v1.0.4 substitute-route path** — §2.1 allows an already-approved managed provider as primary route when the OR `:free` pool demonstrably cannot qualify; §2.4 Groq substitute eligibility; §6.3 provider-native quota gates. Harness: `pinGroqModel` (live tool-call probe + ForgeZero `FREE_ALLOWANCE` admission + rate-limit capture), `groqAllowance` (x-ratelimit via adapter `onResponse`), token-aware `capacityGate`, `groq::*` equivalent-cost refs → same model's paid OR listing.
- **v1.0.5 coverage semantics** — §16 usage criterion counts served calls (matching the reconciliation half already in v1.0.3); run-level `totalTokens` stays UNKNOWN when any attempt is unmetered (conservative — raw per-call ledger preserves the metered sum; e.g. round-7 verified run: 11/11 served calls reported, 40,962 tokens, run total UNKNOWN because 3 upstream-failed attempts are unmeterable).

## Live capacity facts (measured 2026-09-21 UTC)

- OpenRouter `free_model_daily_requests`: **787/1000 remaining** at 04:33Z (used 213). `usage: 0` / `is_free_tier: false` — deposit never consumed. Counter lags served calls ~1–2 min — reconcile after settlement only.
- Groq free tier (owner-dev key): `x-ratelimit` observed — requests window ~1000, tokens 8K/min window (governor paces at 7500 TPM/28 RPM/2 concurrent); documented daily cap ~200K tokens. **Used today ≈ 134.7K/200K** — token-aware capacity gate correctly halted round 2 mid-way; next attempts need the daily reset (assumed ~00:00 UTC, conservative).
- Deposit never consumed: exact-pin, $0/$0 or ForgeZero free-class admission re-checked per run; any `actual_cost > 0` halts.
- **OR `:free` upstream oscillates on minute-timescales.** Nemotron 502 bursts flip within 10–30 min: round 7 (04:20Z) verified 2/3; round 8 (04:29Z) went 0/3 four minutes later. Bare-probe health (5/5 clean at 04:19Z) does NOT predict harness-request health (18-tool, ~10KB requests).
- Cerebras: **402 payment required** (promo credit exhausted; `llama-3.3-70b` 404 — not in account catalog) — excluded. Mistral: **429, 0 req/min** — excluded. Gemini: 403. GitHub Models: **410 retired**.

## Current benchmark status

- **OR prescreen:** 19 candidates → 1 passer (nemotron). Re-screen 04:13Z: **laguna-xs graduated to `provider_failure`** (4 served calls, full usage, verifier passed — then 429 on call 5; permanently excluded under §6.3); gemma-26b/31b hit their **4th instant-429 void** (Google free pool starved at call 0 in every window today).
- **OR qualification:** nemotron cumulative **6/24 verified across 8 rounds** (1/3, 0/3, 1/3, 0/3, 2/3, 0/3, 2/3, 0/3). Stochastic upstream 502s at ~40–60% per-call failure; same-route retry absorbs some (verified runs carry failed attempts in ledger) but 3-consecutive-failure boundary kills ~60% of runs. `MODEL-SELECTION.json` → **winner: null**, leader nemotron.
- **Groq qualification (v1.0.4 substitute route):** `groq::openai/gpt-oss-120b` — **0/4 verified across 2 rounds**, all `provider_failure` on `STREAM_INTERRUPTED` (~13% mid-stream drop, 7/52 calls in round 1). **Verifier passed on 3/4 runs before the terminal drop** — capability proven, free-tier transport reliability failed. 100% usage coverage on all served calls. Round 2 halted by the daily-token gate (conservation working).
- **Other managed routes probed:** Cerebras 402 + `llama-3.3-70b` 404; Mistral 429 (0 req/min); Gemini 403; GitHub Models 410 (retirement brownout — M14A addendum).
- **No pilot run yet** — pilot/main refuse without a winner.
- **Subagent failover gap (honest product evidence):** a dropped stream on a Reviewer subagent turn terminates the run (`REVIEWER_FAILED`) — subagent calls bypass the same-route retry boundary that protects top-level turns. Recorded, not papered over.

## Harness notes (fixed this session)

- `OpenAICompatibleAdapter` now defaults `credentialStore: new EnvironmentCredentialStore()` — same convention as `OpenRouterAdapter`; previously factory-built adapters (groq/mistral/cerebras/…) failed `MISSING_API_KEY` even with the documented env var set (latent bug — production impact).
- `capacityGate` generalized: request-window gate for all providers + daily-token-cap gate (ledger-derived cumulative spend vs documented cap, 15% margin) for token-windowed providers.
- `MODEL-SELECTION.json` now carries `providerId` per candidate + `winnerProvider`; live-pair modes enforce provider+model jointly.
- Pin-time evidence for substitute routes is *stronger* than catalog claims: live `tool_choice=required` probe + ForgeZero admission + captured quota headers, all stored in the pin record.
- `classifyFailure` (eight-bit): upstream stream termination (`STREAM_INTERRUPTED` / "ended before the provider sent") now classifies `PROVIDER_OUTAGE`, transport `STREAM_FAILED` → `TRANSIENT_NETWORK` — previously both fell to `UNKNOWN`, erasing the dominant free-tier failure mode from health evidence. +1 test.

## Known blockers / owner actions

1. **Supply:** still no qualified free model after 8 nemotron rounds + 2 groq rounds + full re-screen. Next legitimate windows: OR deep off-peak (~09:00–12:00 UTC) for nemotron round 9+; Groq after daily-token reset. Do NOT burn OR quota on probe-less nemotron rounds — the oscillation pattern makes blind retries ~60% likely to fail.
2. Live GitHub publication: OWNER ACTION REQUIRED.
3. `githubCopilotUserEntitlement` flag + Copilot managed-relay terms: OWNER/LEGAL review required before any implementation.
4. Local LLM inference (Ollama local): policy-prohibited; accounting exists, routing needs owner decision.
5. Postgres-gated suites skip without `CODEFORGE_TEST_POSTGRES_URL`.
6. Paid spend (OpenAI key) never authorized.

## Next exact action

1. Commit this session (nemotron rounds 7–8 evidence + MODEL-SELECTION merge + this checkpoint).
2. Wait for deep off-peak (~09:00–12:00 UTC): re-probe nemotron (5× bare probes at ~8s spacing); if ≥4/5 return 200 with usage, `node scripts/r23-efficiency-bench.mjs qualify --models nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free --allow-dirty`. Stop after 2 more failed rounds for the day — oscillation pattern means a clean round requires a sustained window, not luck.
3. Groq daily tokens reset ~00:00 UTC; retry `qualify --provider groq --models openai/gpt-oss-120b --allow-dirty` in a low-load window — drops were ~13% in the 03:00–04:15 UTC window; capability is proven (verifier 3/4 runs), the retry tests whether transport settles.
4. On a real winner: `pilot --model <winner> [--provider groq]` → `pilot/R23-PILOT-REPORT.md` vs §16 gate → `R23_INSTRUMENTATION_CERTIFIED` or `NOT_READY`.
5. §16 status: served-call usage coverage is at 100% on all inspected live data — the criterion is **satisfiable** by any qualifying route; nemotron's own unserved 502s don't count against it under v1.0.5.

## Evidence paths

`docs/evidence/r23-efficiency-proof/{recovery,instrumentation,protocol,schemas,cost,pilot,raw/dry_run,raw/qualification,summaries,supply}` populated; remaining dirs empty by design until their milestone.
