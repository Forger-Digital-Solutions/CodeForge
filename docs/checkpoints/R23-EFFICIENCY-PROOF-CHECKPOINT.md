# R23 Efficiency Proof — Continuation Checkpoint

Updated: 2026-09-21 ~22:20 local (M14/M14A/M14B landed; supply still blocked)
Branch: `forger-digital-solutions-forgegreen-certified`
Base: `ae2aa87` (R22 closure) — verified clean at M0.

## HEAD and tree

| | |
|---|---|
| HEAD | `a0eea9f` R23 M5: prescreen re-screen + qualification round; harness fixes; protocol v1.0.3 (M14 commit pending — see below) |
| Previous | `4299036` complete prescreen (0/19) · `6851e78` stats tests + interrupted prescreen · `70dfbf8` M5 prep · `7969481` M3-M4 · `1ada7c0` M0-M2 · `ae2aa87` R22 closure |
| Dirty state | M14/M14A/M14B working set uncommitted: `forge-zero` (SupplyClass/QuotaPeriod/CapacityWindow/Ollama-local), `eight-bit` (route-ledger + measured-health raw fields + 8 tests), `model-registry` (github-copilot definition + test), `supply/` evidence notes. |
| Canary status | Canonical suite green at recovery: 421 files / 3315 tests / 0 failures / 471 s. Targeted re-runs after M14: forge-zero 172 pass / eight-bit 172 pass / model-registry 85 pass — 0 failures. |

## Completed phases

- **M0 Recovery** — `recovery/R23-RECOVERY-NOTE.md`.
- **M1 Measurement inventory** — `instrumentation/R23-MEASUREMENT-INVENTORY.md` (9 critical gaps).
- **M2 Frozen protocol** — `docs/benchmarks/codeforge-efficiency-protocol-r23.md` **v1.0.3**, sha256 `0f9263db999dd0b7c0d2c9d461d80cb0c50f64a300d559474463038aec057531` (`protocol/PROTOCOL-DIGEST.txt`).
- **M3 Instrumentation** — `packages/forgegreen-campaign/src/r23/*`; inventory gaps 1–7, 9 closed; gap 8 via orchestrated-mode ledger.
- **M4 Golden tests** — 36 instrumentation + 8 report-statistics tests green.
- **M5 prep** — 15-task corpus frozen (`benchmarks/r23/manifest.json`), pricing snapshot, scripted dry-run green, report tool, Python verifier fix.
- **M5 live qualification** — 19-candidate prescreen + re-screens + nemotron qualification; **no qualified model** (details below).
- **M14 8-Bit route ledger** — `eight-bit/src/route-ledger.ts`: consolidated ledger rows (supply class, quota owner/scope/period, remaining/rate limits, reset/expiry, health, latency, 429-rate, lifecycle, terms/production/multi-tenant status, role suitability, on-exhaustion) + `findOwnershipViolations` + `aggregateSupplyDomains`. New `SPONSORED_FREE` supply class (flag-gated, not zero-cash), `QuotaPeriod`, `expiresAt` on `CapacityWindow`. Evidence: `supply/M14-ROUTE-LEDGER.md`; 8 tests.
- **M14A GitHub Copilot entitlement** — `@github/copilot-sdk` v1.0.14 confirmed official: `account.getQuota`, `models.list`, per-call `assistant.usage` events, per-user OAuth tokens (user's own subscription billed). Provider definition corrected `NOT_ALLOWED`→`LEGAL_REVIEW_REQUIRED`, `FREE_ACCOUNT_ENTITLEMENT`, `userConnectedFree` profile behind `githubCopilotUserEntitlement` flag; `implemented:false`. Evidence: `supply/M14A-GITHUB-COPILOT-ENTITLEMENT.md`.
- **M14B Ollama entitlement accounting** — cloud path pre-existing; `OLLAMA_LOCAL` domain added (`DISTRIBUTED_USER_FREE`/`DEVICE` scope, unreachable→0 remaining, routes constructed ineligible pending owner policy on local inference). Evidence: `supply/M14B-OLLAMA-ENTITLEMENT.md`; +3 tests.

## Live capacity facts (measured 2026-09-21 UTC)

- OpenRouter `free_model_daily_requests`: limit 1000/day (resets 00:00 UTC), `used: 87` → ~913 remaining at last check. Receipt reconciliation exact: 87 served ledger calls == `used: 87`.
- Deposit never consumed: exact-pin `:free`, $0/$0 re-checked per run, any `actual_cost > 0` halts.
- **Upstream :free capacity saturated this evening** (US peak): upstream 429s, Nvidia 502 "worker limit 16/16", 2 thinkingmachines models permanently 403 (agentic-harness-only).

## Current benchmark status

- **Prescreen:** 19 candidates → `pilot/MODEL-PRESCREEN.json`. 1 passer: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`. Still retryable (infra-void): `qwen/qwen3.8-27b`, `poolside/laguna-xs-2.1`, `google/gemma-4-26b-a4b-it`, `google/gemma-4-31b-it`.
- **Qualification:** nemotron 1/6 verified across 2 rounds (upstream 502s); `MODEL-SELECTION.json` → **winner: null**, leader nemotron. Bar = §2.2.
- **No pilot run yet** — pilot/main refuse without a winner.

## Harness notes (fixed this session)

- Prescreen self-blocked on its own evidence output → prescreen/qualify use `--allow-dirty` (protocol §1; `dirtyFiles` recorded per run). Pilot/main check tree once — commit evidence first.
- Prescreen merges attempt history; only `infrastructure_void` candidates may re-screen.
- Qualify `winner` enforces the §2.2 bar; `leader` reported separately.
- `treeState` porcelain parse fixed (older records show mangled first dirty path — cosmetic).

## Known blockers / owner actions

1. **Supply:** no qualified `:free` model — retry the 4 infra-void candidates + nemotron at off-peak; catalog churn may help.
2. Live GitHub publication: OWNER ACTION REQUIRED.
3. `githubCopilotUserEntitlement` flag + Copilot managed-relay terms: OWNER/LEGAL review required before any implementation.
4. Local LLM inference (Ollama local): policy-prohibited; accounting exists, routing needs owner decision.
5. Postgres-gated suites skip without `CODEFORGE_TEST_POSTGRES_URL`.
6. Paid spend (OpenAI key) never authorized.

## Next exact action

1. Commit M14/M14A/M14B work (this update).
2. `node scripts/r23-efficiency-bench.mjs prescreen --allow-dirty --models qwen/qwen3.8-27b:free,poolside/laguna-xs-2.1:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free` at off-peak.
3. `node scripts/r23-efficiency-bench.mjs qualify --allow-dirty` when candidates advance.
4. On a real winner: `pilot --model <winner>` → `pilot/R23-PILOT-REPORT.md` vs §16 gate → `R23_INSTRUMENTATION_CERTIFIED` or `NOT_READY`.
5. Remaining non-live: §16 instrumentation certification note, M14C managed-Free provider qualification inventory, M14D ForgeAuto aggregation, M14E capacity model.

## Evidence paths

`docs/evidence/r23-efficiency-proof/{recovery,instrumentation,protocol,schemas,cost,pilot,raw/dry_run,raw/qualification,summaries,supply}` populated; remaining dirs empty by design until their milestone.
