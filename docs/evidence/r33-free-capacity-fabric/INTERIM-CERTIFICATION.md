# R33 free capacity fabric — interim certification (2026-09-24, revised)

**Verdict: R33 is not complete.** This checkpoint removes one normal workflow starvation mechanism, corrects a hosted capacity reporting defect, establishes a sourced demand and acquisition baseline, adds durable `waiting_for_free_capacity` parking/resumption across user and workflow turns, wires independent-pool reviewer routing, and rewrites the reservation ledger for O(1) admission proven to 1M virtual users under the production primitive. It does not certify a million-user production deployment or any mass-scale managed inference supply.

## Addendum — capacity waiting, reviewer independence, ledger scale (2026-09-25)

- `waiting_for_free_capacity` is now a durable, nonterminal turn state: the wait is persisted (`free_capacity_wait` work item with `midTurn` flag), survives process restart, and resumes only on a fresh fabric `ADMITTED` decision — explicit `probeCapacityWait`, an automatic sweeper (`capacityWaitRetryMs`, 15s in server wiring), or the workflow's own `waitForTurn` poll. A parked workflow-owned turn defers the workflow timeout and stops charging the working budget. Cancellation while parked is terminal and honest.
- Mid-turn capacity loss (failover `no_replacement` with a fabric `QUEUED` verdict) parks instead of terminalizing; resume on a different physical pool injects a directive to inspect current workspace/durable evidence rather than replay prior tool calls or edits.
- Reservation identity is stable across probe→resume (`forgeauto:${turnId}`); the ledger's same-id replace prevents double-booking. Parked turns hold no reservation.
- Reviewer routing is physical-pool aware: the implement turn's `capacityPoolId` is passed to the review turn as `preferIndependentFromPoolId`; reviewer-qualified supply is preferred (`INDEPENDENT_POOL_PREFERRED`), with same-pool fallback recorded honestly (`SAME_POOL_FALLBACK`).
- `CapacityReservationLedger` was rewritten to indexed bookkeeping after a direct probe measured O(active) scans per `reserve()` (~0.79 ms at 1.2k actives, ~5.9 ms at 10.2k — a quadratic wall at scale). The indexed ledger measures ~0.006 ms per admission at 1,000,003 live reservations. The R33 control-plane harness now routes **every** admission through this production ledger, cross-validated per tick against the independent synthetic model: 2,002,048 `reserve()` calls, 0 divergences, 0 duplicate admissions, 0 leaked leases, 0 starved users at 1M virtual users / 2M tasks (19.1 s wall, 908 MiB RSS). See `load-simulation/README.md`.
- This remains **synthetic control-plane evidence**: virtual users, invented route capacities, no network, no database, no live inference. It proves the production admission primitive is correct and flat at 1M concurrent-lease scale; it does not prove CodeForge owns or can serve a million concurrent coding sessions.

## Addendum — live supply audit, telemetry repair, wait→recovery proof (2026-09-25)

- **Live supply audited** against real credentials (`live-supply/INVENTORY-2026-09-24.md`):
  Groq per-model 1,000 req + 8k TPM pools; Mistral codestral 125 RPM / 625k TPM; Cloudflare
  10k neurons/day (0.35–1.48 n/call measured); GitHub Models serving but unquantified;
  OpenRouter 282/1,000 remaining but `POLICY_BLOCKED`; Cerebras trial dead (402); Gemini
  project suspended; Mistral non-codestral models at `limit: 0`.
- **Quota telemetry repaired**: Mistral's `-minute` header aliases now parse in both quota
  layers; `effectiveQuota` refills elapsed provider-declared resets instead of stranding a
  pool at a stale `remaining: 0` forever; `GraphqlCloudflareUsageSource` +
  `FileCloudflareNeuronBudgetStore` are wired in the desktop — the shipping Cloudflare
  adapter was previously dead code (no `usageSource` injected → fail-closed on every call).
  The neuron oracle still needs an analytics-scoped token (owner action).
- **Capacity-transition chaos suite** (`capacity-transition-chaos.test.ts`): absent windows
  deny (GitHub-Models semantics), `limit:0` windows deny, negative remaining denies,
  unparseable `resetAt` never poisons `nextAvailableAt`, demand-boundary admits/denies,
  pool-window precedence, foreign-pool identity mismatch. Fixed a real gap:
  `provider_units` windows now count as an authoritative accounting dimension — a
  neuron-metered route was previously undenied-able on request/token dimensions it does
  not meter.
- **Live wait→recovery proven twice** (`cross-pool-migration-2026-09-25.json`,
  `token-efficiency-2026-09-25.json`): real Mistral inference → injected 429 → durable
  `waiting_for_free_capacity` → sweeper re-admission at ~60 s (`rateLimitDefaultTtlMs`) →
  resume → review → verification → `completed`. First run also proved a 20-minute
  no-supply park never falsely terminalizes.
- **Single-admissible-pool finding**: `shared:mistral` is the only measured pool that fits
  the honest 16k-token turn demand (Groq 8k TPM, GitHub 8k/request cap, Cloudflare gated,
  OpenRouter blocked). Live distinct-pool migration is therefore **supply-blocked**, not a
  runtime defect — documented with unblocking actions in `SUPPLY-CAPACITY-2026-09-25.md`.
- **Supply-class correction**: measured env-key supply is `OWNER_DEV_FREE`
  (`OWNER_DEV_FREE_NOT_PRODUCT_FREE`) — dogfood evidence describing what the same accounts
  would offer as server-owned managed upstreams or user-connected pools; it is not current
  product-facing managed supply.
- **Observability**: `GET /api/free-cloud/capacity` now exposes pools, routes, and the live
  reservation ledger — the operator surface for capacity waits.
- **Measured turn economics**: a real trivial-fix workflow cost 8 calls / ~22.5k input +
  ~330 output tokens (~98% input-dominated; +21% context growth inside one turn).

## Source and change evidence

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
- Initial canonical `vitest run`: 3,624 passed, 48 skipped, two source-state provenance failures from the changed R32 fingerprint. The R33 guarded recertification was then applied; both provenance files passed 8/8. The post-recertification canonical run passed **3,626 tests / 0 failed / 48 skipped** across 454 passing and eight skipped files (2026-09-24 17:09:43 local start; 557.54 seconds). This is the baseline before the subsequent independent-review quota preference change.
- Capacity model validation and all R33 JSON parsing: PASS. Secret-scan self-test and scan: PASS, zero owner-review-required findings; the generated legacy scan report was restored to avoid unrelated evidence churn.

## Actual supply observed

An authenticated **read-only** `GET /api/v1/key` at 2026-09-24 21:01:49 UTC reported **718 used / 1,000 limit / 282 remaining** for the configured OpenRouter account's shared free-model request pool. No inference request or credit purchase was made to obtain this receipt. The values are account-wide, not per-model or per-user. `openrouter-account-quota-2026-09-24.json` contains the redacted receipt. The account's hosted multi-user use remains blocked pending a written agreement, so these 282 requests are **not certified CodeForge-managed Free capacity**.

No authenticated Groq, Cloudflare, Gemini, or other account-specific capacity reading is in this evidence set. The [provider quota inventory](provider-quota-inventory.md) keeps public ceilings separate from actual entitlements. The [credit ledger](credit-opportunity-ledger.json) records opportunities, not awards. Secured credit value and exact usable managed inference supply are **uncertified**, not assumed to be zero or unlimited.

## Limit audit

| Limit | Class | R33 disposition |
| --- | --- | --- |
| Workflow default 64 total / 24 review reserve | LEGACY/ARBITRARY LIMIT | Removed as the normal stopping authority. Explicit test/operator envelope remains. |
| AgentRuntime 50 iterations per turn | SAFETY LIMIT with an arbitrary threshold | Still active; progress-aware replacement is required before full R33 certification. |
| Two role-route failovers and three pinned same-route retries | SAFETY LIMIT | Still active for non-capacity failures. A `no_replacement` failover whose fabric verdict is `QUEUED` now parks the turn instead of terminalizing it. |
| 20-minute agent working window / 30-minute workflow timeout | SAFETY LIMIT | Still active for working turns; both clocks defer while an owned turn is parked on `waiting_for_free_capacity`, and parked time does not charge the working budget. |
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
| Free capacity fabric | PARTIAL — turn-level admission, durable capacity parking, probe/sweeper resumption, and restart recovery exist; live per-dispatch replenishment unproven |
| Provider migration | PARK→RESUME PROVEN LIVE twice on real Mistral (injected 429 → 60s durable park → resume → complete); distinct-pool migration PROVEN IN TESTS, live proof SUPPLY-BLOCKED (single admissible pool) |
| 8-Bit supply intelligence | IMPROVED — Mistral `-minute` headers parse; elapsed-reset refill (`effectiveQuota`); GraphQL neuron oracle wired (scoped token pending); account/domain registry still incomplete |
| Review capacity | FAIL-CLOSED; independent-pool routing proven in workflow tests; independent quota DOMAIN at production scale open |
| Fairness | EXISTING RESERVATIONS; O(1) indexed admission proven to 1M live holds synthetically; distributed scale proof open |
| Control-plane scale | SYNTHETIC PASS at 1K/10K/100K/1M virtual users with production `CapacityReservationLedger` adjudicating every admission (0 divergences); production distributed scale NOT CERTIFIED |
| Current inference supply | MEASURED — 8 quota domains audited live; ≈20 concurrent agent users theoretical on `shared:mistral` alone; still NOT CERTIFIED for managed commercial use (measured keys are `OWNER_DEV_FREE`) |
| Credit runway | OPPORTUNITY MODEL ONLY; no award or balance certified |
| Mass-scale economics | SENSITIVITY MODEL, not contracted pricing |
| Security | HOSTED LEGAL GATE IMPROVED; full R33 chaos/security suite open |
| Billing safety | ZERO-BILLING BOUNDARY AUDITED — ForgeZero verify, zero-cash-only fabric route tables, `freeRouteExclusionReason` final gate; `paid-auto` reachable only by explicit user selection + env flag; credit overage controls unverified |
| Desktop and packaging | R32 evidence inherited; R33 packaging rerun open |

## Remaining release gates

The highest-priority engineering work is durable `WAITING_FOR_FREE_CAPACITY` and scheduler resumption, progress-aware iteration/failover control, reviewer allocation on an independent quota domain, and cross-provider mid-run live proof with exact quota accounting. The highest-priority supply work is account-scoped read-only quota/plan checks for remaining providers and written commercial-use clearance. No production deployment, credit application, billing change, or release certification follows from this interim result.
