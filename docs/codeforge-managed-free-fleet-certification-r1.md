# CodeForge Managed-Free Intelligence Fleet — R1 Certification Record

**Certification verdict:** `CODEFORGE_MANAGED_FREE_R1_PARTIALLY_CERTIFIED`
(live-certified on Groq and Cloudflare Workers AI; Z.AI is
`EXTERNAL_AUTHORIZATION_REQUIRED` — no operator credential is configured for it).

**Date:** 2026-09-14 · **Branch:** `forger-digital-solutions-forgegreen-certified`
**Source state after this phase:** `c7bf94a85fb48f9d091302d4939c27214d037eb199a1003a86ddb95da4fe090c`
(recertification entry `CODEFORGE_SUBAGENTS_R1_PHASE2_SOURCE_STATE` in
`docs/codeforge-forgegreen-certified-source-state.json`).

This document records what was actually verified this phase. Nothing here is derived from
compiles alone; every live claim points at evidence captured under `docs/evidence/`.

---

## 1. What was verified live (real external calls)

Evidence file: `docs/evidence/managed-free-live-certification.json`
(harness: `scripts/managed-free-live-certification.mjs`).

| Provider | Status | Auth | Live catalog | Qualified (8-Bit compact suite, real calls) |
| --- | --- | --- | --- | --- |
| Groq | `CERTIFIED` | OK (218 ms) | 14 models; all 4 candidates present | `openai/gpt-oss-120b` QUALIFIED, `openai/gpt-oss-20b` QUALIFIED, `qwen/qwen3.8-27b` QUALIFIED (all roles CODER/TOOL_AGENT/ANALYST QUALIFIED) |
| Cloudflare Workers AI | `CERTIFIED` | OK (1.2 s) | 31 text-generation models; all 7 candidates present | `@cf/openai/gpt-oss-120b` QUALIFIED, `@cf/nvidia/nemotron-3-120b-a12b` QUALIFIED, `@cf/zai-org/glm-4.7-flash` QUALIFIED (CODER qualified; TOOL_AGENT probation; ANALYST not qualified) |
| Z.AI | `EXTERNAL_AUTHORIZATION_REQUIRED` | — | — | — |

* Qualification used the production 8-Bit compact suite (`runCompactQualification`): native
  tool-call probe, bounded ≤3-call exact-span edit probe, structured-output probe — the same
  bounded probes the desktop qualification path uses.
* Groq rate-limit headers observed live and recorded in the evidence
  (`x-ratelimit-limit-tokens: 8000`, `x-ratelimit-remaining-requests: 996` at capture time) —
  consistent with the documented free-tier allocation in the provider definition.
* Z.AI requires operator credential `ZAI_API_KEY` (alias `ZHIPU_API_KEY`) to be configured
  externally. Nothing else was blocked by it.

## 2. Live R1 SubAgent run (end-to-end, external models)

Evidence file: `docs/evidence/managed-free-r1-live-run.json`
(harness: `scripts/managed-free-r1-live-run.mjs`).

A real bounded task ("make `test/math.test.mjs` pass by fixing `src/math.mjs`") ran through the
R1 fixed topology with real provider inference:

| Worker | Permissions | Workspace | Route selected by 8-Bit | Model requests | Tokens | Tools | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Repository Explorer (A) | read/search only, no network | local | `cloudflare-workers-ai / @cf/openai/gpt-oss-120b` | 10 | 25,546 | 10 | completed |
| Repository Explorer (B) | read/search only, no network | local | `cloudflare-workers-ai / @cf/openai/gpt-oss-120b` | 10 | 25,100 | 10 | completed |
| Task Planner | read/search only | local | `cloudflare-workers-ai / @cf/openai/gpt-oss-120b` | 6 | 14,527 | 5 | completed |
| Autonomous Builder (SWE writer) | read/search/write/execute, no network | **git worktree** `wt-51482cc1` | `cloudflare-workers-ai / @cf/openai/gpt-oss-120b` | 8 | 22,682 | 7 | completed |
| Independent Code Reviewer | read/search only, private context | git worktree | `cloudflare-workers-ai / @cf/openai/gpt-oss-120b` | 7 | 15,390 | 5 | completed |

* ForgeVerify-equivalent verification ran the real command `node --test test/math.test.mjs` —
  **exit code 0, 1 test passed**; run status `completed`; integration status `integrated` on the
  isolated worktree branch.
* Task Capsules isolated each worker's context (schema v1; per-role constraints incl. the
  read-only contract; required-output contracts; bounded context).
* Every worker produced a hashed evidence artifact (`forge://run/.../worker/<id>/result`,
  SHA-256 digests recorded in the evidence file).
* `router.selection` events (8-Bit role-scoped selection: TOOL_AGENT / PLANNER / CODER /
  REVIEWER contracts) were emitted per worker with scores and reasons.
* Total external spend: $0 (free endpoints only; no upgrade, purchase, or plan-activation path
  was invoked).

**Runtime hardening found and fixed by this live run:** the independent reviewer had hit its
60 s wall-clock budget in an earlier attempt and the orchestrator treated "reviewer died, zero
findings" as a pass. The review phase now fails the run closed
(`REVIEWER_CANCELLED` / `REVIEWER_FAILED` → run `blocked`); the completed run above had a
reviewer that finished inside its budget.

## 3. Canonical model fleet (deduplicated)

Canonical identity is derived deterministically from provider model IDs
(`packages/model-registry/src/canonical.ts`); provider routes never appear as duplicate
user-facing models.

| Canonical model | Family | Capabilities (live) | Intended roles | Qualification | Preferred route(s) today |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | gpt-oss | tools ✓, structured ✓, coding ✓ | Primary coding agent, Coder | QUALIFIED (live, Groq) | Groq |
| `openai/gpt-oss-20b` | gpt-oss | tools ✓, structured ✓ | Fast worker | QUALIFIED (live, Groq) | Groq |
| `qwen/qwen3.8-27b` | qwen | tools ✓, structured ✓ | Fast worker, Coder | QUALIFIED (live, Groq) | Groq |
| `nvidia/nemotron-3-super-120b-a12b` | nemotron | tools ✓, structured ✓ | Explorer/tool worker | QUALIFIED (live, Cloudflare) | Cloudflare Workers AI |
| `zai/glm-4.7-flash` | glm | tools ✓, structured ✓ | Coder (probation on tool-agent role) | QUALIFIED w/ probation (live, Cloudflare) | Cloudflare Workers AI |
| `openai/gpt-oss-120b` (Cloudflare route) | gpt-oss | tools ✓, structured ✓ | same as above | QUALIFIED (live, Cloudflare) | Cloudflare Workers AI (alternate route for the same canonical model) |

Present in the live catalogs this phase but **not yet qualification-probed** (bounded daily
probe budget; they remain discovered, not certified):
`qwen/qwen3.6-27b` (Groq), `@cf/qwen/qwen3.8-27b`, `@cf/qwen/qwen2.5-coder-32b-instruct`,
`@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/google/gemma-4-26b-a4b-it` (Cloudflare),
`glm-4.5-flash`, `glm-4.6v-flash` (Z.AI — route blocked on credential).

## 4. Provider route matrix

| Canonical model | Provider | Exact provider ID | Recurring free? | Quota / rate-limit notes | Live certification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | Groq | `openai/gpt-oss-120b` | Yes — free plan daily allocation | 30 RPM / 1K RPD / 8K TPM / 200K TPD (documented; live headers consistent) | 2026-09-14, QUALIFIED | ACTIVE |
| `openai/gpt-oss-20b` | Groq | `openai/gpt-oss-20b` | Yes — same free plan allocation | same | 2026-09-14, QUALIFIED | ACTIVE |
| `qwen/qwen3.8-27b` | Groq | `qwen/qwen3.8-27b` | Yes — same free plan allocation | same | 2026-09-14, QUALIFIED | ACTIVE |
| `qwen/qwen3.6-27b` | Groq | `qwen/qwen3.6-27b` | Yes — same free plan allocation | same | present in live catalog; not probed | DISCOVERED |
| `openai/gpt-oss-120b` | Cloudflare Workers AI | `@cf/openai/gpt-oss-120b` | Yes — Workers Free 10k Neurons/day, hard stop | allowance allow-list includes this model | 2026-09-14, QUALIFIED | ACTIVE |
| `nvidia/nemotron-3-super-120b-a12b` | Cloudflare Workers AI | `@cf/nvidia/nemotron-3-120b-a12b` | Yes — same daily Neurons allocation | allowance allow-list includes this model | 2026-09-14, QUALIFIED | ACTIVE |
| `zai/glm-4.7-flash` | Cloudflare Workers AI | `@cf/zai-org/glm-4.7-flash` | Yes — same daily Neurons allocation | allowance allow-list includes this model | 2026-09-14, QUALIFIED (probation on one role) | ACTIVE |
| `qwen/qwen3.8-27b` | Cloudflare Workers AI | `@cf/qwen/qwen3.8-27b` | Yes — allow-listed | bounded probe budget not spent | present in live catalog | DISCOVERED |
| `qwen/qwen2.5-coder-32b-instruct` | Cloudflare Workers AI | `@cf/qwen/qwen2.5-coder-32b-instruct` | Yes — allow-listed | bounded probe budget not spent | present in live catalog | DISCOVERED |
| `qwen/qwen3-30b-a3b` | Cloudflare Workers AI | `@cf/qwen/qwen3-30b-a3b-fp8` | Yes — allow-listed | bounded probe budget not spent | present in live catalog | DISCOVERED |
| `google/gemma-4-26b-a4b` | Cloudflare Workers AI | `@cf/google/gemma-4-26b-a4b-it` | Yes — allow-listed | bounded probe budget not spent | present in live catalog | DISCOVERED |
| `zai/glm-4.7-flash` | Z.AI direct | `glm-4.7-flash` | Yes — GLM Flash family listed at $0 (per provider docs) | per Z.AI free tier | **blocked: no operator credential** | `EXTERNAL_AUTHORIZATION_REQUIRED` |
| `zai/glm-4.5-flash` | Z.AI direct | `glm-4.5-flash` | Yes — GLM Flash family | per Z.AI free tier | blocked: no operator credential | `EXTERNAL_AUTHORIZATION_REQUIRED` |
| `zai/glm-4.6v-flash` | Z.AI direct | `glm-4.6v-flash` | Yes — GLM Flash family (vision) | per Z.AI free tier | blocked: no operator credential | `EXTERNAL_AUTHORIZATION_REQUIRED` |
| Kimi K2.x / GLM-5.x / DeepSeek V4 routes | Cloudflare Workers AI | `@cf/moonshotai/...`, `@cf/zai-org/glm-5.*`, `@cf/deepseek-ai/...` | **No** — require Workers Paid or AI Gateway credits (provider pricing docs) | — | not attempted | EXCLUDED (paid-plan models in the provider definition) |

Providers researched and **not** admitted to the core free fleet (existing policy, unchanged):
Gemini free tier (free-tier data usage terms unsuitable as a silent default; BYOK-only),
Mistral (experiment tier is evaluation-only), Cerebras (one-time trial credits),
Hugging Face (tiny monthly credits), NVIDIA NIM (development/prototype access),
SambaNova (`PENDING_LIVE_FREE_VERIFICATION` posture retained).

## 5. Role-aware routing and failover (what changed in the runtime)

* `executeAgentRun` (the path every SubAgent worker executes) now resolves its route through
  8-Bit's role-scoped eligibility/ranking when role routing is enabled (the R1 SubAgent manager
  enables it): explorer → `TOOL_AGENT`, planner → `PLANNER`, coder → `CODER`, reviewer →
  `REVIEWER` contracts; ranking via the certified `ForgeRouter`; hard exclusions for cooldown,
  quarantine, capability mismatch; Free Cloud admission filter when the registry is wired.
* Bounded failover inside a worker run: provider failures are classified by the existing
  8-Bit machinery and rotate within the **free fleet only** (≤2 rotations per run), preferring
  same-canonical-model alternates; route health (per-session and shared cross-session) is
  recorded both ways. No paid/BYOK crossing exists on this path.
* Exact-model selections are never substituted: an explicit `modelSelection` runs as-is or the
  run fails closed (tested).
* When no fleet route exists (e.g. test harnesses with a scripted provider only), the previous
  deterministic provider-catalog fallback is preserved — default behavior is unchanged.
* Restart recovery converges durable worker records left non-terminal by a crash into an honest
  `failed` state (replan-only recovery; no fake resumption).

Tests: `packages/server/test/role-routing.test.ts` (7 tests), the R1 suites in
`packages/server/test/subagents.test.ts` and
`packages/server/test/agent-orchestrator-integration.test.ts`.

## 6. ForgeEval A/B (initial empirical evidence, no statistical claim)

Evidence file: `docs/evidence/managed-free-forgeeval-ab.json`
(harness: `scripts/managed-free-forgeeval-ab.mjs`).

One matched pair, identical frozen fixtures, identical goal, identical verification command,
same live fleet, deterministic `node --test` oracle:

| Arm | Topology | Status | Verified | Wall time | Workers | Tokens | Tools |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Control | single_agent | completed | ✅ | 96 s | — | — | — |
| Treatment | fixed_team (R1) | completed | ✅ | 151 s | 5 | 121,594 | 42 |

Both arms produced the correct, verified fix. The R1 team spent more wall time and tokens for
durable worker evidence, capsule isolation, and an independent review pass. One pair supports no
superiority claim; it demonstrates the measurement loop works end-to-end on live traffic.

## 7. Remaining limitations (explicit)

1. Z.AI routes are unverified until the operator configures `ZAI_API_KEY` / `ZHIPU_API_KEY`.
2. Fleet slots beyond the three Groq + three Cloudflare models probed this phase are DISCOVERED,
   not certified (bounded probe budget; the automated qualification cycle will process them).
3. Active worker execution is not resumed after a process crash (replan-only recovery, by
   design; stale records now converge to an honest terminal state). Real resumption requires a
   durable per-turn execution journal — deliberately deferred.
4. Blind-model and human judging tiers of ForgeEval remain unexecuted (schemas + deterministic
   tier exercised only).
5. Adaptive topology remains not started (fixed topology first, per plan).
6. Allowance units in worker telemetry remain schema-only; the authoritative user allowance
   counter is the cloud `credit_ledger` (reserve/settle/release, idempotent), which this phase
   did not change.
