# R24 Mission C Checkpoint — Free Fabric Authoritative in the Serving Path

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
Prior: `3486a5d` (Mission B checkpoint — fabric composed, not wired)

## Verdict

**`R24_FREE_FABRIC_AUTHORITATIVE`** — `FreeFabric.decide()` is no longer a library surface;
it is the admission authority on every automatic free-routing path in `forge serve`.
Interactive ForgeAuto turns, role-routed agent runs, and their failovers all pass through
one seam (`EightBitRuntime.admitThroughFabric`), and an ADMITTED verdict carries a real
capacity reservation held until the turn/run settles. QUEUED and DENIED verdicts fail
closed — no provider call, no paid or local substitution, no silent bypass.

Mission C closes the gap Mission B named explicitly: "the fabric is not yet wired into
`forge serve` — `decide()` exists and is proven; the server seam is deliberately the next
integration step." ForgeGreen audit, topology work, the paired benchmark, and the
production pilot remain open.

## Where the seam is

```
interactive turn ──► AgentRuntime.selectModel(turnId)
                          │  (was: ForgeRouter ranking + advisory hooks)
                          ▼
role-routed run ──► EightBitRuntime.selectInitialRoute(scope, …, runId)
                          │  (was: router.selectRoute + admission filter)
                          ▼
failover ──► EightBitRuntime.handleTurnFailure ──► fabricReplacement(exclude)
                          │  (was: router.selectReplacement ranking)
                          ▼
              EightBitRuntime.admitThroughFabric ──► FreeFabric.decide()
                          │        requestId = runId | forgeauto:<turnId>
                          ▼
        ADMITTED ─► hold tracked (fabricHolds), binding persisted + hydrated,
                    receipt recorded, provider executes under reservation
        QUEUED  ─► no_eligible_route + nextAvailableAt, no provider call
        DENIED  ─► no_eligible_route, no provider call
                          │
        turn/run finally ─► releaseFabricAdmission(requestId) ─► ledger.release
```

`FreeFabric` itself is unchanged in shape: live route/pool projections from
`FreeCloudService` (re-read inside every `decide()`), Mission A health authority, one
process-wide `CapacityReservationLedger` shared by all session runtimes.

## Composition decisions

- **The seam is `EightBitRuntime`, not each call site.** Interactive selection,
  role-routed selection, and failover already converged there; attaching the fabric at
  that boundary means every automatic free-routing decision is governed without touching
  the turn loop's control flow. `freeFabric`/`fabricContext` are optional — hosts that
  don't supply them keep the pre-fabric path (tests, single-caller embeddings).
- **Reservations are keyed by stable request ids, not routes.** `runId` for role runs,
  `forgeauto:<turnId>` for interactive turns. The ledger now treats a repeated
  `reserve()` under the same `reservationId` as replacing its own hold — it cannot count
  against the caller's concurrency cap or pool budget — which is what makes a failover
  re-decide atomic instead of a double-spend.
- **A denied re-decide keeps the old hold.** `reserve()` only writes on admission, so a
  failover that finds nothing admissible leaves the failed route's reservation intact;
  the bounded same-route retry (capacity blips, short rate-limit windows) then executes
  under exactly the reservation it originally paid for.
- **Same-route re-admission is not a rotation.** If the fabric re-picks the failed route
  (demoted but not excluded, nothing better admissible), the failover coordinator falls
  through to the bounded-retry path — the hold stays, no phantom rotation is recorded.
- **Reservation demand is per-call, not per-run.** `inputTokens` is clamped to a 16k
  near-term estimate; reserving a run's whole `maxContextTokens` would exhaust real
  provider windows on admission. Post-call quota headers remain the true accounting and
  every failover re-decides against them.
- **Per-user ownership is stamped, never claimed.** Desktop stamps `ownerUserId` onto
  provider connection state at connect time; `FreeCloudService.routesForUser` /
  `poolsForUser` / `capacityIdentitiesFor` only expose `PER_USER_POOL` supply whose
  stamped owner matches the requesting user. `localconn:<providerId>` remains the
  sentinel for plain BYOK connections with no account hash. The fabric's ownership check
  (identity match) is defense-in-depth on top — a user cannot name an identity it does
  not hold.
- **`maxActiveReservationsPerUser: 8`.** The default of 3 would starve a legitimate
  orchestrated wave (planner + explorers + coder + reviewer) alongside an interactive
  turn. Real contention is enforced by the physical pool windows; the per-user cap is a
  fairness backstop.
- **Binding consistency.** A fabric-admitted route is persisted via `saveRouteState`
  AND hydrated into the router's in-memory binding map — `currentBinding()` and durable
  state agree after both initial admission and failover rotation.
- **Explicit pins keep their privilege.** Exact model/route pins never consult the
  fabric; they fail closed by their own semantics. A `model` pin's same-model alternates
  keep the pre-fabric replacement path (documented limitation below).

## User-visible behavior

- Queued capacity surfaces honestly: `SelectRouteResult` carries
  `queued.nextAvailableAt` and `FABRIC_QUEUED_FOR_CAPACITY` reason codes; the turn/run
  fails closed rather than silently spending unadmitted capacity.
- Denials carry the fabric's per-candidate report (`POLICY_EXCLUDED`,
  `HEALTH_EXCLUDED`, `NOT_USER_OWNED`, `CAPACITY_DENIED`, …) into the decision receipt.
- Suggestions stay zero-cost: "connect your own account", "wait for the window reset" —
  never "pay for it".

## Test evidence (this mission)

| Suite | Result |
|---|---|
| `packages/server/test/free-fabric-wiring.test.ts` (new, 8 cases) | 8/8 — role-routed run admits + releases on settle; queued run fails closed with no provider call; interactive ForgeAuto admits + releases; queued interactive fails closed; failover re-decide replaces the hold in place (one reservation, re-pointed); owner reaches own PER_USER_POOL; other user denied; shared-pool contention releases to the next decider; firewall-eligible route absent from fabric is unreachable by ForgeAuto |
| `packages/model-registry/test/free-cloud-registry.test.ts` (+3) | 36/36 — per-user route/pool projection owner-gated; capacity identities stamped not claimed |
| `packages/server/test/route-health-wiring.test.ts` | 6/6 (Mission A integration intact) |
| `packages/eight-bit` full suite | 219 passed, 2 skipped (postgres) |
| `packages/forge-zero` full suite | 117/117 |
| `packages/model-registry` full suite | 90/90 |
| `tsc -b` eight-bit, forge-zero, model-registry, server, desktop | clean |
| Broad `packages/server` suite | 57 pre-existing failures — reproduced identically at stashed HEAD (5s wall-clock timeouts in dynamic-runtime/workflow/budget integration tests + `node:sqlite` finalized-statement errors); standalone reruns of the suspect files pass. Environmental flakes, not regressions; no policy weakened. |

## Money

$0 spent. All capacity/provider behavior is fixture data and in-process assertions; no
provider calls were added.

## Known limitations / open work

- **`model`-pin failover is not fabric-admitted.** A same-model alternate rotation spends
  free capacity on a route the fabric did not reserve (it keeps the health/admission-filter
  path). Governing it needs a `requiredCanonicalModelId` constraint in `FabricRequest` —
  scoped for the scenario-completion mission.
- **Admitted-but-no-adapter edge.** If the fabric admits a route whose provider adapter is
  absent from this runtime, the failover path releases the re-decided hold and falls back
  to bounded same-route retry — which then runs reservation-free for up to two bounded
  retries. Registry/catalog inconsistency is the precondition; the release is the honest
  failure mode.
- **`QUEUED_FOR_CAPACITY` is a verdict, not a queue.** No durable wait/recall yet — the
  hosted admission authority owns that.
- **Reservation lease is a crash net, not a run fence.** Default 10-minute lease; a run
  that outlives it keeps executing correctly but loses fairness protection until its next
  re-decide (failover) or settle.
- **Desktop `ownerUserId` propagation** depends on the host supplying `localUserId`; a
  host that supplies neither stamps nothing and per-user supply stays unreachable —
  fail-closed, never misattributed.
