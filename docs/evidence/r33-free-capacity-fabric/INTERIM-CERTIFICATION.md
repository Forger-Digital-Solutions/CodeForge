# R33 free capacity fabric — interim certification (2026-09-24)

**Verdict: R33 is not complete.** This checkpoint removes one normal workflow starvation mechanism, corrects a hosted capacity reporting defect, and establishes a sourced demand and acquisition baseline. It does not certify a million-user control plane or any mass-scale managed inference supply.

## Source and change evidence

- Starting source: `f99cfb4398d453f88519199fda03e00d25063d47` on `codex/r29-release-closure`, clean working tree before R33 edits.
- R32 source: `docs/certification/codeforge-r32-autonomy-perfection-2026-09-24.md` and `docs/evidence/r32-autonomy-perfection/`. Its live acceptance used a 32-request envelope with ten reserved review requests on a single OpenRouter route.
- Normal workflow runs no longer construct a fixed per-run request envelope. An explicitly supplied envelope remains for controlled tests and diagnostics. No-progress, tool, working-time and completion controls remain active.
- Hosted discovery checks the existing provider-policy authority before registering a route. An OpenRouter standard-terms account with no enterprise override is `policy_blocked`, not reported as healthy managed capacity.
- A deterministic workflow test performed 34 changing edit calls, then completed only after verification and a decisive goal review. A focused hosted-policy test proves the blocked discovery behavior.
- The guarded `scripts/r33-recertify-source-state.mjs` recorded material-source ID `bd2f90f6ea49cb420c9e0f3021ae34bb2db055b453ef169f8e2e27f6eb864441`, changing only the reviewed workflow-service material file. R32's historical identity remains in the recertification ledger.

## Verification at this checkpoint

- Full TypeScript project build: PASS (`node node_modules/typescript/bin/tsc -b --force`).
- Focused goal-review suite before the new long-edit case: 15/15 PASS; the new 34-edit case: 1/1 PASS. Focused hosted registry suite: 13/13 PASS.
- Initial canonical `vitest run`: 3,624 passed, 48 skipped, two source-state provenance failures from the changed R32 fingerprint. The R33 guarded recertification was then applied; both provenance files passed 8/8. A fresh canonical run against the updated identity is in progress.
- Capacity model validation and all R33 JSON parsing: PASS. Secret-scan self-test and scan: PASS, zero owner-review-required findings; the generated legacy scan report was restored to avoid unrelated evidence churn.

## Actual supply observed

An authenticated **read-only** `GET /api/v1/key` at 2026-09-24 21:01:49 UTC reported **718 used / 1,000 limit / 282 remaining** for the configured OpenRouter account's shared free-model request pool. No inference request or credit purchase was made to obtain this receipt. The values are account-wide, not per-model or per-user. `openrouter-account-quota-2026-09-24.json` contains the redacted receipt. The account's hosted multi-user use remains blocked pending a written agreement, so these 282 requests are **not certified CodeForge-managed Free capacity**.

No authenticated Groq, Cloudflare, Gemini, or other account-specific capacity reading is in this evidence set. The [provider quota inventory](provider-quota-inventory.md) keeps public ceilings separate from actual entitlements. The [credit ledger](credit-opportunity-ledger.json) records opportunities, not awards. Secured credit value and exact usable managed inference supply are **uncertified**, not assumed to be zero or unlimited.

## Limit audit

| Limit | Class | R33 disposition |
| --- | --- | --- |
| Workflow default 64 total / 24 review reserve | LEGACY/ARBITRARY LIMIT | Removed as the normal stopping authority. Explicit test/operator envelope remains. |
| AgentRuntime 50 iterations per turn | SAFETY LIMIT with an arbitrary threshold | Still active; progress-aware replacement is required before full R33 certification. |
| Two role-route failovers and three pinned same-route retries | SAFETY LIMIT | Still active; can end a task while independent supply exists. Must be reconciled with durable waiting/migration. |
| 20-minute agent working window / 30-minute workflow timeout | SAFETY LIMIT | Still active; currently terminalizes long or waiting work. A durable capacity wait must pause the working clock. |
| One workflow per session / 20 per process | USER FAIRNESS LIMIT / local process protection | Not a million-user control-plane proof. Distributed admission requires separate load evidence. |
| Provider governor RPM/TPM/concurrency and header-based cooldown | PROVIDER LIMIT | Preserved. Public defaults are pacing fallbacks; actual organization limits require telemetry. |
| ForgeZero zero-billing and provider-policy gates | COST LIMIT / SAFETY LIMIT | Preserved and checked before hosted discovery. |
| R32 completion gate and inconclusive review blocker | SAFETY LIMIT | Preserved; no path to `completed` was added. |

## Scale distinction

The executable [capacity model](capacity-model/REPORT.md) uses seven R32 receipts and explicit sensitivities. At 10,000 continuously active normal-coding users, it estimates 52,100 requests/minute, 4.64 million input tokens/second, 363,000 output tokens/second, and about 10,420 parallel generations under a 12-second occupancy assumption. These are modeled **requirements**, not supply or a provider commitment. At 1 million users every quantity is 100 times that 10,000-user row. The model also provides 25% and 5% duty-cycle scenarios and illustrative credit burn; none is a production quote.

## Separate verdicts

| Gate | Verdict |
| --- | --- |
| Product architecture | PARTIAL — existing Free Fabric and completion gate retained; fixed workflow envelope removed |
| Free capacity fabric | PARTIAL — turn-level admission exists; per-dispatch durable leasing and replenishment are unproven |
| Provider migration | EXISTING PATH, R33 LIVE PROOF OPEN |
| 8-Bit supply intelligence | PARTIAL — health and quota headers exist; current account/domain registry incomplete |
| Review capacity | FAIL-CLOSED, INDEPENDENT DOMAIN PROOF OPEN |
| Fairness | EXISTING RESERVATIONS, DISTRIBUTED SCALE PROOF OPEN |
| Control-plane scale | NOT CERTIFIED at 1K, 10K, 100K or 1M virtual users |
| Current inference supply | NOT CERTIFIED for managed commercial use |
| Credit runway | OPPORTUNITY MODEL ONLY; no award or balance certified |
| Mass-scale economics | SENSITIVITY MODEL, not contracted pricing |
| Security | HOSTED LEGAL GATE IMPROVED; full R33 chaos/security suite open |
| Billing safety | UNCHANGED ZERO-BILLING POLICY; credit overage controls unverified |
| Desktop and packaging | R32 evidence inherited; R33 packaging rerun open |

## Remaining release gates

The highest-priority engineering work is durable `WAITING_FOR_FREE_CAPACITY` and scheduler resumption, progress-aware iteration/failover control, reviewer allocation on an independent quota domain, and cross-provider mid-run live proof with exact quota accounting. The highest-priority supply work is account-scoped read-only quota/plan checks for remaining providers and written commercial-use clearance. No production deployment, credit application, billing change, or release certification follows from this interim result.
