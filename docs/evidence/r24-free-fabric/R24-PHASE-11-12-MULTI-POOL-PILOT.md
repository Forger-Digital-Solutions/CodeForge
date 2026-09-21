# R24 Phase 11–12 Checkpoint — Multi-Pool Scenarios and the Production-Shaped Serving Pilot

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
Prior: `fd10e9b` (Phase 10 — role-specific qualification drives fabric routing)

## Verdict

**`R24_MULTI_POOL_FABRIC_AND_PILOT_PROVEN`** — the Free Fabric's supply-domain
semantics hold as a *system*, not just per decide: the conservation order
(shared → sponsored → user entitlement) survives failure injection, shared-pool
windows are global across users, per-user fairness is per-user, user-owned supply
stays unreachable under contention, and a production-shaped flight through the real
AgentRuntime serving path executed every provider call inside a live reservation
with zero leaked holds.

Mechanism verdict, not a live-provider claim: all evidence is deterministic,
in-process, $0.

## Phase 11 — multi-pool scenario matrix

`packages/eight-bit/test/r24-multi-pool.test.ts` (11 scenarios). The single-decide
semantics were already proven in `free-fabric.test.ts`; this matrix proves what only
emerges when several pools and several users interact:

| Scenario | Proven |
|---|---|
| Exhaustion chain across all three domains | Shared window empty → **sponsored** serves while the user's eligible pool stays `STANDBY`; sponsored empty too → `USER_ENTITLEMENT` |
| Sponsored is policy-gated | Default policy → `POLICY_EXCLUDED` + `SPONSORED_FREE_NOT_AUTHORIZED`, never silently served |
| Owner-development supply | `OWNER_DEV_FREE` → `OWNER_DEV_FREE_NOT_PRODUCT_FREE`; never user-facing even as the only route |
| Global shared concurrency window | Two users fill the window; a third `QUEUED_FOR_CAPACITY`/`CAPACITY_EXHAUSTED`; a release admits them — the window belongs to the pool, not a user |
| Per-user concurrency cap | Caps *that user only* (`USER_CONCURRENCY_LIMIT`); another user still admits on the same pool — the cap consumes no pool capacity |
| Shared request budget across users | Two users' demands deplete `remaining`; the third queues with `nextAvailableAt` = the real window reset |
| Two routes, one provider account | Sibling routes on one `capacityPoolId` contend for one budget — a hold on model-A denies model-B |
| Isolation under contention | Shared exhausted → owner falls to her pool; identity-less user queues — the pool is reported `NOT_USER_OWNED`, never used |
| Identity required | Same request without `userIdentities` cannot touch its own pool |
| Data-policy boundary | `PUBLIC_CODE_ONLY` route refuses `PRIVATE_CODE` work (`DATA_POLICY_PUBLIC_CODE_ONLY`), serves `PUBLIC_CODE` work |
| Deposit-unlocked supply | `DEPOSIT_UNLOCKED_FREE` gated by default; admitted when policy authorizes |

### Real seam found and fixed: `dataContext` at reserve time

The supply plan judged route eligibility under the request's `dataContext`, but the
reservation ledger re-checked under its own construction-time context (default
`PRIVATE_CODE`). A `PUBLIC_CODE` request could plan eligible and then fail closed at
reserve time — the two authorities disagreed on the same request.

Fix: `CapacityReservationRequest.dataContext` (optional); `reserve()` evaluates
`request.dataContext ?? this.dataContext`; `FreeFabric.decide()` passes the resolved
context through. Production (`index.ts` `fabricContext`) already supplies per-request
context, so the fix is live in the real path. No policy weakened — the check is
identical, just evaluated under the right context.

## Phase 12 — production-shaped serving pilot

`packages/server/test/r24-serving-pilot.test.ts` (3 flights over one fleet). Not a
library-level scenario: real `AgentRuntime` sessions against one fabric, one shared
reservation ledger, one health authority — the `forge serve` shape.

Fleet: `managed-strong` (shared, qs 90) + `sponsored-mid` (shared, qs 60,
policy-authorized) + `alice`'s user-owned pool. Providers instrumented so every call
records the ledger's `byRoute` snapshot mid-stream.

| Flight | Proven in the serving path |
|---|---|
| Conservation under failure | Turn 1 lands on managed under a hold on that route. Authority-injected saturation (4 capacity failures) → turn 2 lands on **sponsored** — the middle domain — while alice's pool stays at **0 calls** |
| Failover domain order | Managed starts 429ing mid-flight → the failover re-decide lands on **sponsored**, not alice's entitlement — exactly one hold, on the sponsored route, no double-spend |
| Contention → drain | Two other users fill both shared pools' single slots → carol's turn **fails closed** (zero provider calls); releasing a hold admits her retry on the freed pool; ledger returns to 0 |

Pilot invariants asserted: every provider call observed `byRoute` containing its own
route (the reservation precedes provider execution); alice's pool was never called
by anyone; `activeReservations` ends at 0.

### Fixture finding (production contract confirmed correct)

The pilot's sponsored route initially never admitted: the test ledger was built with
the default policy while the fabric planned under `allowSponsoredFree`. The reserve-
time eligibility check excludes it — exactly the mismatch `CapacityLedgerOptions.policy`'s
doc warns about ("must match the eligibility policy the caller's supply plan was built
under"). Production wiring passes **no** policy to either — both default, consistently.
Fixture corrected to share one policy; no production change needed.

## Test evidence (these phases)

| Suite | Result |
|---|---|
| `packages/eight-bit/test/r24-multi-pool.test.ts` (new) | 11/11 |
| `packages/server/test/r24-serving-pilot.test.ts` (new) | 3/3 |
| `packages/eight-bit` full suite | 243/243 (+2 skipped postgres) |
| `packages/forge-zero` full suite | 117/117 — reserve signature change is backward compatible |
| `packages/server` focused | `free-fabric-wiring` 8/8, `provider-topology-capacity` 6/6, pilot 3/3 |
| `npm run build` (workspace) | clean |

## Money

$0 spent. Deterministic in-process fixtures only.

## Known limitations / open work

- **Sponsored supply is exercised with the policy enabled; production ships it off.**
  The pilot proves the domain ordering works when authorized — not that sponsored
  capacity exists today.
- **Queued turns fail closed rather than waiting.** `QUEUED_FOR_CAPACITY` is a
  verdict, not a durable queue — the pilot's drain is a caller-side retry, matching
  current semantics (documented since Mission C).
- **Fabric/ledger policy consistency is contractual, not enforced.** The reserve-time
  check fails closed on mismatch (safe direction), but nothing stops a host from
  passing different policies. A startup assertion would harden this.
- **Failure injection is at the authority and provider-script level** — the same
  seams real 429s and saturation land on, but not a live provider.
- Canonical regression + security evidence and the final checkpoint remain
  (Phases 13–14).
