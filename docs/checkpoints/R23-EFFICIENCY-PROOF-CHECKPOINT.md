# R23 Efficiency Proof — Continuation Checkpoint

Updated: 2026-09-21 ~24:00 local / ~04:00 UTC (protocol v1.0.4 + substitute-route path landed; two more qualification rounds done; still no winner)
Branch: `forger-digital-solutions-forgegreen-certified`
Base: `ae2aa87` (R22 closure) — verified clean at M0.

## HEAD and tree

| | |
|---|---|
| HEAD | `3436a79` R23 checkpoint (M14–M14E + §16 note + catalog re-screen evidence) |
| Pending commit | this session's work: protocol v1.0.4, `--provider groq` bench path, `OpenAICompatibleAdapter` credential-store default, pricing-snapshot substitute equivalents, new qualification evidence |
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

- OpenRouter `free_model_daily_requests`: limit 1000/day. Counter at last read: **used 130 / remaining 870** (03:49Z). Counter lags served calls ~1–2 min — reconcile after settlement only.
- Groq free tier (owner-dev key): `x-ratelimit` observed — requests window ~1000, tokens 8K/min window (governor paces at 7500 TPM/28 RPM/2 concurrent); documented daily cap ~200K tokens. **Used today ≈ 76K/200K** (one qual round ~72K + probes).
- Deposit never consumed: exact-pin, $0/$0 or ForgeZero free-class admission re-checked per run; any `actual_cost > 0` halts.
- **OR `:free` upstream saturated at US peak** (429/502 storms, thinkingmachines permanent 403s); post-00:00-UTC window noticeably healthier (nemotron 2/3 this round).
- Cerebras: **402 payment required** (promo credit exhausted) — excluded. Mistral: **429, 0 req/min** on this account — excluded tonight. Gemini: 403 non-functional.

## Current benchmark status

- **OR prescreen:** 19 candidates → 1 passer (nemotron). Permanent-failure classes excluded per §6.3.
- **OR qualification:** nemotron cumulative **4/15 verified across 5 rounds** (rounds: 1/3, 0/3, 1/3, 0/3, 2/3). Latest round 03:49Z: `verified_complete` ×2 (80,792 + 56,032 tokens, full usage), one early-502 provider_failure. `MODEL-SELECTION.json` → **winner: null**, leader nemotron.
- **Groq qualification (v1.0.4 substitute route):** `groq::openai/gpt-oss-120b` round 03:07Z — **0/3 verified, all `provider_failure` on `STREAM_INTERRUPTED`**: ~13% mid-stream drop rate (7/52 calls); **verifier passed on 2/3 runs before the terminal drop** (capability demonstrated, reliability failed). 100% usage coverage on served calls (20/22, 13/16, 12/14 PROVIDER_REPORTED). Non-stream/small-prompt probes: 0/12 drops — drops correlate with real harness-size streams under evening load.
- **No pilot run yet** — pilot/main refuse without a winner.

## Harness notes (fixed this session)

- `OpenAICompatibleAdapter` now defaults `credentialStore: new EnvironmentCredentialStore()` — same convention as `OpenRouterAdapter`; previously factory-built adapters (groq/mistral/cerebras/…) failed `MISSING_API_KEY` even with the documented env var set (latent bug — production impact).
- `capacityGate` generalized: request-window gate for all providers + daily-token-cap gate (ledger-derived cumulative spend vs documented cap, 15% margin) for token-windowed providers.
- `MODEL-SELECTION.json` now carries `providerId` per candidate + `winnerProvider`; live-pair modes enforce provider+model jointly.
- Pin-time evidence for substitute routes is *stronger* than catalog claims: live `tool_choice=required` probe + ForgeZero admission + captured quota headers, all stored in the pin record.

## Known blockers / owner actions

1. **Supply:** still no qualified free model. Nemotron trending upward post-reset (retry at next window). Groq drops may be load-correlated — retry once off-peak. Cerebras/Mistral/Gemini currently dead (402/429/403).
2. Live GitHub publication: OWNER ACTION REQUIRED.
3. `githubCopilotUserEntitlement` flag + Copilot managed-relay terms: OWNER/LEGAL review required before any implementation.
4. Local LLM inference (Ollama local): policy-prohibited; accounting exists, routing needs owner decision.
5. Postgres-gated suites skip without `CODEFORGE_TEST_POSTGRES_URL`.
6. Paid spend (OpenAI key) never authorized.

## Next exact action

1. Commit this session (protocol v1.0.4 + groq path + credential-store fix + new evidence).
2. `node scripts/r23-efficiency-bench.mjs qualify --models nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free --allow-dirty` at the next upstream-healthy window (probe first: bare 200 + usage before spending a round).
3. `node scripts/r23-efficiency-bench.mjs qualify --provider groq --models openai/gpt-oss-120b --allow-dirty` off-peak — drops were ~13% at 03:00–03:45 UTC; if the rate falls, 3/3 is plausible (capability already proven).
4. On a real winner: `pilot --model <winner> [--provider groq]` → `pilot/R23-PILOT-REPORT.md` vs §16 gate → `R23_INSTRUMENTATION_CERTIFIED` or `NOT_READY`.
5. Note: nemotron's 502s structurally cap §16 usage coverage (failed calls carry no usage); Groq reports usage on 100% of served calls — if a Groq route ever qualifies, instrumentation coverage likely clears 98%.

## Evidence paths

`docs/evidence/r23-efficiency-proof/{recovery,instrumentation,protocol,schemas,cost,pilot,raw/dry_run,raw/qualification,summaries,supply}` populated; remaining dirs empty by design until their milestone.
