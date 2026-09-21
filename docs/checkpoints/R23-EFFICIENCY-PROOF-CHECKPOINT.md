# R23 Efficiency Proof — Continuation Checkpoint

Updated: 2026-09-21 ~00:15 local / ~04:15 UTC (protocol v1.0.4 + substitute-route path landed; nemotron rounds 5–6 + groq rounds 1–2 + laguna/gemma re-screen done; still no winner)
Branch: `forger-digital-solutions-forgegreen-certified`
Base: `ae2aa87` (R22 closure) — verified clean at M0.

## HEAD and tree

| | |
|---|---|
| HEAD | `1f5de16` R23 v1.0.4: substitute-route clause + Groq qualification path |
| Pending commit | eight-bit `classifyFailure` stream-interrupt taxonomy fix (+test), M14A GitHub-Models-retirement addendum, latest qual/prescreen evidence |
| Canary status | Canonical suite green at recovery: 421 files / 3315 tests / 0 failures / 471 s. Targeted re-runs after M14: forge-zero 172 pass / eight-bit 172 pass / model-registry 85 pass — 0 failures. |

## Completed phases

- **M0 Recovery** — `recovery/R23-RECOVERY-NOTE.md`.
- **M1 Measurement inventory** — `instrumentation/R23-MEASUREMENT-INVENTORY.md` (9 critical gaps).
- **M2 Frozen protocol** — `docs/benchmarks/codeforge-efficiency-protocol-r23.md` **v1.0.4**, sha256 `03023faceb378620b9607569567f39468c898050ed3d4ea2bf8258701b90d8e7` (`protocol/PROTOCOL-DIGEST.txt`, full version history preserved).
- **M3 Instrumentation** — `packages/forgegreen-campaign/src/r23/*`; inventory gaps 1–7, 9 closed; gap 8 via orchestrated-mode ledger.
- **M4 Golden tests** — 36 instrumentation + 8 report-statistics tests green.
- **M5 prep** — 15-task corpus frozen (`benchmarks/r23/manifest.json`), pricing snapshot, scripted dry-run green, report tool, Python verifier fix.
- **M5 live qualification** — 19-candidate OR prescreen + re-screens + nemotron ×5 rounds + groq ×1 round; **no qualified model** (details below).
- **M14 8-Bit route ledger** — `eight-bit/src/route-ledger.ts`: consolidated ledger rows + `findOwnershipViolations` + `aggregateSupplyDomains`. New `SPONSORED_FREE` supply class, `QuotaPeriod`, `expiresAt` on `CapacityWindow`. Evidence: `supply/M14-ROUTE-LEDGER.md`; 8 tests.
- **M14A GitHub Copilot entitlement** — `@github/copilot-sdk` v1.0.14 official: `account.getQuota`, `models.list`, `assistant.usage`, per-user OAuth. Definition corrected `NOT_ALLOWED`→`LEGAL_REVIEW_REQUIRED`, `FREE_ACCOUNT_ENTITLEMENT`, flagged `userConnectedFree` profile; `implemented:false`. Evidence: `supply/M14A-GITHUB-COPILOT-ENTITLEMENT.md`.
- **M14B Ollama entitlement accounting** — `OLLAMA_LOCAL` domain (`DISTRIBUTED_USER_FREE`/`DEVICE`, constructed ineligible pending owner policy on local inference). Evidence: `supply/M14B-OLLAMA-ENTITLEMENT.md`; +3 tests.
- **M14C Managed provider inventory** — `supply/provider-inventory-raw.json` (31 providers) + `supply/M14C-MANAGED-PROVIDER-INVENTORY.md`.
- **§16 certification note** — `instrumentation/R23-INSTRUMENTATION-CERTIFICATION.md`: **R23_INSTRUMENTATION_NOT_READY** — 7/8 criteria proven; provider-reported usage 72.1% vs ≥98% bar (Nvidia omits usage on failed calls; served calls report fully). Counter reconciliation proven exact 124==124; counter lags ~2 min.
- **M14D/M14E** — `forgeAutoSupplyPlan` (shared→sponsored→user ordering, cross-user exclusion proven; 11 ledger tests) + capacity model: **~66 tasks/day ≈ 22 DAU** on today's verified fabric.
- **v1.0.4 substitute-route path (this session)** — §2.1 allows an already-approved managed provider as primary route when the OR `:free` pool demonstrably cannot qualify (trigger evidence recorded in-protocol); §2.4 moves Groq to substitute eligibility; §6.3 generalises the allowance gate to provider-native quota signals. Harness: `pinGroqModel` (live tool-call probe + ForgeZero `FREE_ALLOWANCE` admission + rate-limit capture), `groqAllowance` (x-ratelimit headers via adapter `onResponse`), token-aware `capacityGate`, `groq::*` equivalent-cost refs → same model's paid OR listing.

## Live capacity facts (measured 2026-09-21 UTC)

- OpenRouter `free_model_daily_requests`: limit 1000/day. Counter at last read: **~812 remaining** (04:14Z). Counter lags served calls ~1–2 min — reconcile after settlement only.
- Groq free tier (owner-dev key): `x-ratelimit` observed — requests window ~1000, tokens 8K/min window (governor paces at 7500 TPM/28 RPM/2 concurrent); documented daily cap ~200K tokens. **Used today ≈ 134.7K/200K** — the token-aware capacity gate correctly halted the second round mid-way (15% margin enforced); next attempts need the daily reset.
- Deposit never consumed: exact-pin, $0/$0 or ForgeZero free-class admission re-checked per run; any `actual_cost > 0` halts.
- **OR `:free` upstream saturated at US peak** (429/502 storms, thinkingmachines permanent 403s); post-00:00-UTC window noticeably healthier (nemotron 2/3 this round).
- Cerebras: **402 payment required** (promo credit exhausted) — excluded. Mistral: **429, 0 req/min** on this account — excluded tonight. Gemini: 403 non-functional.

## Current benchmark status

- **OR prescreen:** 19 candidates → 1 passer (nemotron). Re-screen 04:13Z: **laguna-xs graduated to `provider_failure`** (4 served calls, full usage, verifier passed — then 429 on call 5; permanently excluded under §6.3); gemma-26b/31b hit their **4th instant-429 void** (Google free pool starved at call 0 in every window today).
- **OR qualification:** nemotron cumulative **4/18 verified across 6 rounds** (1/3, 0/3, 1/3, 0/3, 2/3, 0/3). Volatile upstream: round 5 at 03:49Z verified 2/3 (80,792 + 56,032 tokens); round 6 at 04:00Z went 0/3 on 502s minutes after clean probes — bare-probe health does NOT predict harness-request health (18-tool, ~10KB requests). `MODEL-SELECTION.json` → **winner: null**, leader nemotron.
- **Groq qualification (v1.0.4 substitute route):** `groq::openai/gpt-oss-120b` — **0/4 verified across 2 rounds**, all `provider_failure` on `STREAM_INTERRUPTED` (~13% mid-stream drop, 7/52 calls in round 1). **Verifier passed on 3/4 runs before the terminal drop** — capability proven, free-tier transport reliability failed. 100% usage coverage on all served calls. Round 2 halted by the daily-token gate after 1 run (conservation working).
- **Other managed routes probed tonight:** Cerebras 402 (credits exhausted) + `llama-3.3-70b` 404 (not in account catalog); Mistral 429 (0 req/min); Gemini 403; **GitHub Models 410 — scheduled retirement brownout** (service being shut down; recorded in M14A addendum — Copilot SDK is now the only GitHub entitlement surface).
- **No pilot run yet** — pilot/main refuse without a winner.

## Harness notes (fixed this session)

- `OpenAICompatibleAdapter` now defaults `credentialStore: new EnvironmentCredentialStore()` — same convention as `OpenRouterAdapter`; previously factory-built adapters (groq/mistral/cerebras/…) failed `MISSING_API_KEY` even with the documented env var set (latent bug — production impact).
- `capacityGate` generalized: request-window gate for all providers + daily-token-cap gate (ledger-derived cumulative spend vs documented cap, 15% margin) for token-windowed providers.
- `MODEL-SELECTION.json` now carries `providerId` per candidate + `winnerProvider`; live-pair modes enforce provider+model jointly.
- Pin-time evidence for substitute routes is *stronger* than catalog claims: live `tool_choice=required` probe + ForgeZero admission + captured quota headers, all stored in the pin record.
- `classifyFailure` (eight-bit): upstream stream termination (`STREAM_INTERRUPTED` / "ended before the provider sent") now classifies `PROVIDER_OUTAGE`, transport `STREAM_FAILED` → `TRANSIENT_NETWORK` — previously both fell to `UNKNOWN`, erasing the dominant free-tier failure mode from health evidence. +1 test.

## Known blockers / owner actions

1. **Supply:** still no qualified free model. Nemotron trending upward post-reset (retry at next window). Groq drops may be load-correlated — retry once off-peak. Cerebras/Mistral/Gemini currently dead (402/429/403).
2. Live GitHub publication: OWNER ACTION REQUIRED.
3. `githubCopilotUserEntitlement` flag + Copilot managed-relay terms: OWNER/LEGAL review required before any implementation.
4. Local LLM inference (Ollama local): policy-prohibited; accounting exists, routing needs owner decision.
5. Postgres-gated suites skip without `CODEFORGE_TEST_POSTGRES_URL`.
6. Paid spend (OpenAI key) never authorized.

## Next exact action

1. Commit this session (taxonomy fix + M14A addendum + rounds 5–6 + groq round 2 + re-screen evidence).
2. Wait for deep off-peak (~09:00–12:00 UTC): re-probe nemotron (bare 200 + usage); if clean, `node scripts/r23-efficiency-bench.mjs qualify --models nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free --allow-dirty`.
3. Groq daily tokens reset ~00:00 UTC; off-peak retry `qualify --provider groq --models openai/gpt-oss-120b --allow-dirty` — drops were ~13% in the 03:00–04:15 UTC window; capability is proven (verifier 3/4 runs), the retry tests whether transport settles.
4. On a real winner: `pilot --model <winner> [--provider groq]` → `pilot/R23-PILOT-REPORT.md` vs §16 gate → `R23_INSTRUMENTATION_CERTIFIED` or `NOT_READY`.
5. §16 note: nemotron's 502s structurally cap provider-usage coverage (failed calls carry no usage); Groq reports usage on 100% of served calls — a qualifying Groq route would likely clear 98%.

## Evidence paths

`docs/evidence/r23-efficiency-proof/{recovery,instrumentation,protocol,schemas,cost,pilot,raw/dry_run,raw/qualification,summaries,supply}` populated; remaining dirs empty by design until their milestone.
