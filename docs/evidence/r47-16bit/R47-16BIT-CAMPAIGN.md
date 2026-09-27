# R47 Phase B — Live 16-Bit Campaign Evidence

Authorized scope: bounded live spend against the OpenRouter account under
`CODEFORGE_16BIT_CAMPAIGN=1`, durable campaign cap **$0.50**, campaign `r47-16bit`,
session `r47-16bit-campaign`, ledger `R47_PAID_DB` (temp dir). All spend below is
receipted; nothing ran outside `BudgetGatedProviderAdapter`.

## 1. Route probes (capability + identity)

One ~8-token `chat` per fallback route. 4/4 returned HTTP 200, exact served-model
identity match, ACTUAL reconciliation.

| Route | Served model | Provider-reported cost | Ledger actual |
|---|---|---|---|
| glm-5.3-flash:openrouter | z-ai/glm-5.3-flash | $0.00000468 | $0.000005 |
| deepseek-v4.1-flash:openrouter | deepseek/deepseek-v4.1-flash | — | $0.000005 |
| qwen3.8-flash:openrouter | qwen/qwen3.8-flash | — | $0.000014 |
| gpt-5.6-luna:openrouter | openai/gpt-5.6-luna | — | $0.000009 |

Probe spend: **$0.000033**. Evidence: `R47-16BIT-PROBE-<model>.json` ×4.

## 2. Role qualification (live, durable, receipted)

`runRoleAwareQualification` driven through the gated adapter — every probe request
reserved before dispatch and settled on the campaign ledger.

| Role | deepseek ($0.0024, 16 req) | glm ($0.0023, 15 req) | qwen ($0.0049, 16 req) | gpt-5.6-luna ($0.0086, 17 req) |
|---|---|---|---|---|
| CODER | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED |
| TOOL_AGENT | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED |
| ANALYST | QUALIFIED | QUALIFIED | QUALIFIED | QUALIFIED |
| PLANNER | NOT_TESTED (empty completions) | QUALIFIED | NOT_TESTED (empty) | QUALIFIED |
| REVIEWER | HARD_FAILURE | QUALIFIED | QUALIFIED | PROBATION |
| EXPLORER | **NOT_QUALIFIED** | **NOT_QUALIFIED** | **NOT_QUALIFIED** | **NOT_QUALIFIED** |

Qualification spend: **$0.0182** cumulative. Evidence: `R47-16BIT-QUALIFY-<model>.json` ×4.

**EXPLORER gap is real and uniform:** 0/4 paid models qualify — same zero-reads /
invalid-tool signature as the free Mistral fleet in Phase A. The only qualified
Explorer anywhere remains the free Groq gpt-oss-20b pool. Empty-completion planner
failures on deepseek/qwen are reasoning-token starvation (provider returns
reasoning-only completions within the probe's output bound).

## 3. First live 16-Bit mission

- Command: `r47-16bit-mission.mjs --model glm-5.3-flash --cap 0.50`
- Pipeline: Explorer → Planner → Coder → Reviewer → Verification → Integration,
  all roles pinned to `paid-auto/glm-5.3-flash` via `setModelSelection` +
  `ModelExecutionAdapter` paid branch.
- Goal: implement `multiply` + `power` in `math.mjs` so `node --test test/math.test.mjs` passes.
- Result: **completed** — completion gate passed, `changedFiles: ["math.mjs"]`,
  verification exit 0 (2/2 tests pass in the worktree), reviewer verdict pass
  (1 advisory finding), integration `integrated`.
- Wall clock: 149 s. Task attempts: 1 (first-try completion).
- Calls: 17 provider streams — 16 ACTUAL + 1 RELEASED (stream produced no billable
  completion; reservation released, receipt retained).
- **Mission spend: $0.003740** for ~49k total tokens (≈2.5–3.3k input/call shows
  bounded context assembly).
- Evidence: `R47-16BIT-MISSION-glm-5.3-flash.json`.

### Runtime wiring gaps found and fixed this run

- `ModelExecutionAdapter.resolveModel` had no paid-auto branch — exact paid
  selections failed closed as "not registered in ForgeZero" before any dispatch.
  Added the canonical-model branch mirroring `resolveTurnModel`, wired
  `paidAuto` through `createModelExecutionAdapter`, regression-tested
  (`agent-provider-contract.test.ts`, 5/5).
- `PaidAutoService` required a credentialled direct route before any dispatch;
  a credential-absent direct (`NOT_CONFIGURED`) now falls through to the
  OpenRouter fallback when `openRouterFallbackEnabled` — every other gate
  (kill switch, policy, certification, circuit) still fails closed.
  Regression-tested (`paid-auto.test.ts`, 50/50).

## 4. Spend ledger proof

- Campaign ceiling enforced durably: `authorizedUsd=0.50`, never exceeded;
  committed after all Phase B activity: **$0.021986** (4.4% of ceiling).
- Every receipt carries route identity, price-card source, usage, and
  reconciliation state; `RELEASED` receipts distinguish provably-unbilled calls.
- Durable `ESTIMATED_ONLY` now commits the reservation bound when a completed
  call reports no usage — aligned with the in-memory ledger (was $0).

## 5. Honest caveats

- Stream receipts cannot observe `servedModelId` (the StreamEvent contract has no
  model field). Identity verification is ACTUAL-grade only on `chat` probes;
  mission traffic was streams. Documented as the audit signal, not hidden.
- The mission ran with `paidExecutionEnabled` + route qualification asserted from
  this session's measured evidence — appropriate for an owner-dev campaign, not a
  certification path.
- The Explorer role ran unqualified on the paid pin (0/4 roster coverage). The
  mission still completed because the task was narrow; missions that lean on
  exploration depth need a qualified explorer — currently only the free Groq pool.
- One-model-pin missions cannot mix routes per role; per-role paid routing is
  Phase B+ scope.
