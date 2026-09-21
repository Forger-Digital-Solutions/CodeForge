# R23 Recovery Note (M0)

Recorded: 2026-09-20
Recorded by: R23 engineering team (one founder + AI agents)

## Exact starting state — verified against the repository, not the prompt

| Item | Expected (R23 brief) | Actual | Match |
|---|---|---|---|
| Branch | `forger-digital-solutions-forgegreen-certified` | `forger-digital-solutions-forgegreen-certified` | YES |
| R22 implementation commit | `1a06f91` | `1a06f91` R22: governed external integrations — browser runtime, real MCP client, webhooks, plugin bridge | YES |
| R22 evidence/closure commit | `ae2aa87` | `ae2aa87487e7bd4ca2c4fde47bfc3b978fa50e41` (2026-09-20 19:05:27 -0400) evidence: R22 closure scorecard | YES |
| HEAD | `ae2aa87` | `ae2aa87` — no commits after the R22 closure | YES |
| Working tree | clean | `git status --porcelain` → 0 entries | YES |
| Main branch for PRs | `master` | `master` | — |

No legitimate work exists after `ae2aa87`; nothing was reset, nothing was discarded.

## R22 closure — verified from evidence, not assumed

Source: `docs/evidence/r22-external-integrations/R22-SCORECARD.md`, `gate-result.txt`.

- Canonical gate (root `vitest.config.mts`): **414 files passed | 8 skipped; 3266 tests passed | 47 skipped; 0 failures; 388.26 s.** Matches the R23 brief exactly.
- Skips are the documented PostgreSQL-gated suites (`CODEFORGE_TEST_POSTGRES_URL` is unset on this workstation, so they silently skip; pre-existing and documented).
- Source-state canaries (FG-11 + FG-12E) were recertified at `829fcc5d…` covering exactly three intentionally changed material files (`agent-runtime.ts`, `duplicate-suppression.ts`, `tools/index.ts`). Any R23 source change to a material file WILL trip these canaries again; recertification must again prove intentional drift file-by-file.
- Live GitHub publication against the real API: **NOT RUN — OWNER AUTHORIZATION REQUIRED.** R23 preserves this boundary.

## Predecessor checkpoints located

| Campaign | Document | Notes |
|---|---|---|
| R20 | `docs/evidence/r20-platform-intelligence-scale/R20-*-CHECKPOINT.md` (4) + `09-scale/scenarios/*.json` (11 scenario JSONs incl. `R20-373-DAU-MODEL.json`) | Capacity-model precedent; scenario numbers were **modelled**, not measured from real task consumption |
| R21 | `docs/evidence/r21-intelligence-closure/R21-CLOSURE-SCORECARD.md` + 9 milestone checkpoints | **`02-forgegreen/R21-FORGEGREEN-AB-CHECKPOINT.md` is the direct predecessor of the R23 controlled experiment** |
| R22 | `docs/evidence/r22-external-integrations/R22-SCORECARD.md`, `gate-result.txt` | External-tools substrate; no R22 checkpoint doc beyond the scorecard |

There was no `docs/checkpoints/` directory; R23 creates it (`R23-EFFICIENCY-PROOF-CHECKPOINT.md`).

## What the R21 ForgeGreen A/B already established (and did not)

Established (deterministic scripted model, 13 tasks × 2 arms × 3 reps, correctness equal by construction; re-run 2026-09-20 on this workstation: 15/15 green, 60.8 s):

- FG-1C duplicate read-only suppression saves **tool dispatches** (103 → 81, −21.4%) but **not context bytes** — the suppressed output is replayed to the model; bytes rose +0.2–1.0% on 9/13 tasks. A prior savings claim was found false and corrected.
- FG-1B tool-output compression is where the context savings are: −37% to −76% model-visible bytes on 4 tasks with large repetitive outputs; the −18% total is entirely those four tasks.
- No false suppression; every post-mutation re-read executed.
- Cross-sibling subagent duplication measured (80,370 bytes re-read across siblings) and **not** suppressed (supervisor is per-run).

NOT established (explicitly recorded as the gap):

- Whether a **live model** issues fewer turns / provider calls / tokens under ForgeGreen — a scripted model cannot respond to ForgeGreen. Reason given: capacity-blocked (OpenRouter free tier = 50 req/day; ~600+ requests needed).
- Any energy figure (`INSUFFICIENT_DATA`).
- Provider-call or token effects of memory, repository index, summaries, subagent topology.

**R23's headline experiment is exactly this gap: same platform, same live model, paired tasks, ForgeGreen stack OFF vs ON, verified outcomes.**

## Existing benchmark / measurement infrastructure located

| Component | Location | State |
|---|---|---|
| CodeForgeBench R1/R2 case contracts | `packages/benchmark/src/codeforge-bench-r{1,2}.ts`, `-r2-executor.ts` | Case/attempt schemas with routing, verification (visible/protected/forgeVerify), failure, fixtureEvidence fields; splits TRAIN/DEV/VALIDATION/PROTECTED_TEST. **No token/cost fields.** |
| R3 corpus, failure corpus, protected acceptance | `packages/benchmark/src/{r3-corpus,failure-corpus,protected-acceptance}.ts` | Present |
| R20 scale/experiments | `packages/benchmark/src/r20-{scale,experiments}.ts`, `scripts/r20-scale-campaign.mjs` | Modelled capacity, not measured consumption |
| R21 ForgeGreen A/B harness | `packages/server/test/r21-forgegreen-ab.test.ts` | Drives the **real `AgentRuntime`** through the `efficiencyControls` seam + `createForgeGreenAdvisor({enabled})`; scripted provider; emits `forgegreen-ab.json`. Basis for the R23 paired harness. |
| FG-12E paired runner (ForgeVerify reuse) | `packages/forgegreen-campaign/src/fg12e/*` | Real paired measurement with safety checks, timing statistics, break-even analysis, harness provenance — verification-scoped |
| FG-11 observation store / candidates A–D | `packages/forgegreen-campaign/src/*` | Shadow observation infra, source-state canaries |
| Per-run ForgeGreen R0 telemetry | `packages/forge-green/src/r0-telemetry.ts` | See M1 inventory — the richest existing per-run record |
| Efficiency receipt | `forgeGreen.createReceipt(...)` in `agent-runtime.ts:1088` | Reason codes, duplicates suppressed, compression bytes, canonical cache hits, provider cached tokens |
| Durable tool records | `agent_tool_execution` work items (`DurableToolExecutionRecord`) | Per tool: argumentsHash, executionClass (read_only/write/command/network), state, resultHash |
| Run journal | `agent_run_journal` work items | Messages, turn/tool/write/command counts, active route; enabled when `roleRouting` or resume |
| Model-registry pricing | `packages/model-registry/src/normalized-types.ts` `NormalizedPricing` (USD / 1M, nullable) | Exists per model record from models.dev/live catalogs; **not consumed by run telemetry** |
| Cost conversion | `packages/cloud-usage/src/types.ts` `calculateTokensAndCredits` | Hard-coded default rates ($0.15/$0.60) — not a frozen per-model snapshot |
| Hardware telemetry | `packages/forge-green/src/hardware-telemetry.ts` | **Null adapter only** → `INSUFFICIENT_DATA` always |
| Energy estimator | `packages/forge-green/src/energy-estimator.ts` | `InsufficientDataEstimator` default; `ReferenceHeuristicEstimator` exists (heuristic, labelled) |
| Provider definitions (legal/quota/terms) | `packages/model-registry/src/provider-definitions.ts` | 30 providers; `FreeAccessClass`, `TermsStatus`, `PaymentSpilloverRisk`, `policyMetadata`, evidence with `checkedAt: 2026-09-15` |
| 8-Bit | `packages/eight-bit/src/*` (capacity-intelligence, health, measured-health, eligibility, failover, handoff, receipts, qualification/) | Route selection + health; supply-class vocabulary is partial (see M14) |
| GitHub Copilot | `provider-definitions.ts` `github-copilot` | `implemented: false`, `terms: NOT_ALLOWED`, `authClasses: [UNSUPPORTED]` (checked 2026-09-15). **No Copilot SDK dependency in the tree.** M14A must first establish whether a supported SDK/API surface exists before any integration. |
| Ollama | `provider-definitions.ts` `ollama-cloud` (`userConnectedFree` profile; `LEGAL_REVIEW_REQUIRED` for managed relay; `USER_CONNECTED_FREE_PERMISSION_REQUIRED`), `OLLAMA-USER-CONNECTED-FREE-FINAL.md` | Local Ollama daemon: **not installed on this workstation** (not on PATH, :11434 not responding) |

## Environment fingerprint (this workstation)

- OS: Windows 11 Pro 10.0.26200 (win32 x64)
- CPU: Intel Core i7-9850H @ 2.60 GHz, 12 logical CPUs
- RAM: 32 GB
- GPU: NVIDIA Quadro T2000 4 GB, driver 610.60 (`nvidia-smi` available → GPU power sampling possible, but no local inference runs on it; CPU package energy has no non-admin sensor on Windows)
- Node v24.19.0, npm 11.17.0, Vitest 5.0.1
- Provider credentials present in the environment (names only; values are never recorded): `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY` (**paid — OWNER-SPEND RULE applies; not to be used without authorization**), `CLOUDFLARE_ACCOUNT_ID` (no token).
- Absent: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `OLLAMA_API_KEY`, `CODEFORGE_TEST_POSTGRES_URL`, `CODEFORGE_DATA_ENCRYPTION_KEYS`.

## Owner actions carried forward (unchanged)

1. Live GitHub publication/PR against the real API — authorization boundary.
2. Any paid API spend (OpenAI key present) — not authorized; will be computed and flagged if a benchmark materially needs it.
3. Postgres-gated suites remain skipped unless `CODEFORGE_TEST_POSTGRES_URL` is provided.
