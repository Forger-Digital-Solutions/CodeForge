# R48 — Live Mission Evidence (E2 free / E3 paid)

Round: **R48 — Role-Aware Fleet Routing, Explorer Closure, No-False-Waiting &
Production 8-Bit / 16-Bit Runtime**

Commits under test: `de8c4ab` → `b6cc77c` (see git log). Evidence scripts:
`scripts/r48-free-mission.mjs`, `scripts/r48-paid-mission.mjs`.

## E3 — Live paid mission (16-Bit per-role routing) — COMPLETE

Command: `CODEFORGE_16BIT_CAMPAIGN=1 node scripts/r48-paid-mission.mjs`
Evidence: `R48-16BIT-ROLE-MISSION.json`
Spend: **$0.008722 committed of $0.25 authorized** (durable ledger, 18
reservations reconciled to actuals, 12 provider receipts).

| Phase | Verdict | Route (physical pool) | Spend |
|---|---|---|---|
| explorer-denial | failed, correct | none — `NO_QUALIFIED_ROLE_ROUTE` at $0 | $0 |
| coder-selection | completed | `qwen3.8-flash:openrouter` (cheapest QUALIFIED) | real |
| reviewer-independence | completed | `glm-5.3-flash:openrouter` — **distinct pool from implementer** | real |

Proofs held live:

- `paid-auto/auto` sentinel resolved per-role before dispatch; the literal
  `auto` was never sent to a provider. Explorer journal records the unresolved
  sentinel with `converged_failed` — honest.
- Explorer denied closed: all four canonicals carry measured `NOT_QUALIFIED`
  verdicts for EXPLORER from R47 qualification receipts; no free or unknown-cost
  route was substituted.
- Coder selected `qwen3.8-flash:openrouter` (cheapest qualified coder route)
  after direct routes were unexecutable; produced the real fix
  `export function multiply(a, b) { return a * b; }` in `math.mjs`.
- Reviewer selected `glm-5.3-flash:openrouter` with
  `INDEPENDENT_POOL_PREFERRED` in the durable selection reasons — a different
  physical pool than the implementer's `qwen3.8-flash:openrouter`.
- Served-model provenance recorded per attempt (`servedModelId`,
  `executionCertainty: completed`); one glm attempt honestly records
  `servedModelId: null` where the upstream did not report identity.
- Reviewer output refused to overclaim: static-analysis pass with an explicit
  caveat that runtime test execution remained with ForgeVerify.
- The exact frozen `mathFile` artifact was reconstructed without another model
  call and passed ForgeVerify (`node --test test/math.test.mjs`, 1/1). The
  authoritative completion gate returned `completed` with no blockers, then
  integration committed the verified tree; `verifiedTree === integratedTree`.
- `verificationSource.providerCallsIssued=0` proves the closure step reused the
  paid mission artifact rather than spending again or re-deriving model output.

## E2 — Live free mission (8-Bit role routing through the real Free Fabric) — MACHINERY PROVEN, full-completion blocked on provider quota timing

Command: `node scripts/r48-free-mission.mjs`
Evidence: `r48-free-mission.json`, `r48-free-mission-final.json`
Supply: 170 capacity routes across 136 physical pools; 10 durable qualification
receipts restored; owner/dev pools excluded
(`OWNER_DEV_FREE_NOT_PRODUCT_FREE`); Mistral managed routes gated
(`DATA_POLICY_USER_CONSENT_REQUIRED`).

Observed across runs (quota state varied between runs):

| Run | Explorer | Coder | Reviewer | Outcome |
|---|---|---|---|---|
| 1 | converged_failed via managed groq (admitted with `ROLE_QUALIFIED_EVIDENCE`, `QUOTA_RESERVED`) | denied — quota | — | blocked |
| 2 | completed via `gpt-oss-20b` managed (QUALIFIED) | denied — `QUEUED_FOR_CAPACITY`, `MODEL_QUOTA_EXHAUSTED` | — | blocked |
| 3 | denied — quota | **completed via `groq/qwen/qwen3.8-27b` after stale-reset immediate re-decide** | denied — queued past horizon | blocked |
| 4 | completed via `gpt-oss-120b` managed (PROBATION tier served while QUALIFIED supply was quota-blocked) | denied — quota | — | blocked |
| 5 | completed via `gpt-oss-20b` managed | denied — `QUEUED_FOR_CAPACITY`, distant `next_available` | — | blocked |
| 6 | converged_failed after 5 real requests via `gpt-oss-120b` (PROBATION) | denied — quota | — | blocked |
| 7 | completed via `gpt-oss-20b` managed | denied — quota after Explorer used the shared window | — | blocked |
| final | provider fetch failed before Explorer dispatch | admitted `qwen3.8-27b`; 5 requests/6 tools, then provider fetch failed | — | blocked |

Proofs held live:

- Role-verdict floor enforced at fabric admission: only routes with current
  QUALIFIED/PROBATION evidence for the requested role were admitted.
- Physical managed pool identity flows into worker results and run journals
  (`capacityPoolId` per route).
- Probation tier served real work when qualified supply was exhausted —
  ranking `QUALIFIED > PROBATION > NOT_TESTED` is operational.
- Queued capacity receives exactly one bounded wait + re-decision; stale
  `nextAvailableAt` re-decides immediately; distant resets fail closed with
  reason codes + `next_available=<ISO>` in the run summary. `DENIED` never
  waits.
- Every blocked run terminated `blocked` with durable evidence; no fake
  completion, no paid substitution, no promotion of unverified work — the
  mission repo stayed untouched whenever reviewer/verification could not run.

A single fully-completed orchestrated free mission was not observed. Repeated
bounded attempts at provider-stated reset times showed that provider quota
(groq free tier, the only admissible supply at run time) did not survive
sequentially across explorer → coder → reviewer; the final attempt admitted the
coder but ended on a real provider fetch failure after five requests. This is a
supply/model-behavior limit, not a basis for claiming success: Explorer and
Coder each completed in separate live runs, every denial carried exact fabric
reason codes, and every unfinished run remained blocked.

## Defects found and fixed by live evidence

1. `executeAgentRun` replaced the role's execution budget with any partial
   caller-supplied object — `{maxModelTurns: 6}` left `maxContextTokens`
   undefined and NaN'd the context gate before any request. Budgets now merge
   over role defaults (same semantics as `SubagentManager`).
2. `QUEUED_FOR_CAPACITY` surfaced as an instant failure. `executeAgentRun` now
   performs one bounded wait + re-decision within a horizon, immediate
   re-decision on stale resets, fail-closed on distant resets, no wait on
   `DENIED`. Covered by 4 tests in `packages/server/test/role-routing.test.ts`
   (18/18 file green).

## Regression position (E1)

- `packages/server`: 876 passed / 3 skipped / 2 failed — both failures
  pre-existing at baseline commit `d4769e8` (verified by bisect):
  `agent-certification-r` explorer case and `fg3-model-aware-budget`.
- Touched packages (eight-bit, paid-auto, providers, agent, protocol,
  cloud-gateway): 596 passed / 2 skipped.
- R44-class scripted-fixture break (write-without-read against the
  `EDIT_MISSING_STATE` guard) repaired across CF-09, parallel-orchestrator,
  and run-recovery fixtures — `5850f4f`.
