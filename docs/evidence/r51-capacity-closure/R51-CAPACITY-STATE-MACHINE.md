# R51 — "Waiting for Free Capacity" Path Trace & State Machine

Traced 2026-10 (R51 Phase C). Every path that can produce a parked/queued/denied state,
its trigger, its scope, and its recovery mechanism.

## Admission surface

`FreeFabric.decide()` (`packages/eight-bit/src/free-fabric.ts`):

1. Build ledger from `managedRoutes()` + `userSources()` + pools (live projections
   of `FreeCloudService.capacityRoutes()/capacityPools()`).
2. `forgeAutoSupplyPlan` filters to `freeEligible` + role-suitable + owned-domain routes.
   Excluded routes get per-candidate reports (POLICY_EXCLUDED / ROLE_INELIGIBLE /
   NOT_USER_OWNED).
3. Per planned candidate: `routeAdmission` verdict floor (→ ROLE_INELIGIBLE),
   `health.assess` hard-exclude (→ HEALTH_EXCLUDED), then rank by
   (pool-independence, domain, qualification tier, effectiveScore).
4. `reservations.reserve()` attempted per ranked candidate, in order, until one admits.
   Per-candidate denial reasons:
   - `USER_CONCURRENCY_LIMIT` → break, QUEUED (fairness cap, not supply).
   - `CAPACITY_EXHAUSTED` / `FIRST_RUN_RESERVE_PROTECTED` → CAPACITY_DENIED,
     queued += domain-qualified reason + `nextAvailableAt` from real reset windows.
   - `NO_ELIGIBLE_ROUTE` / `CAPACITY_POOL_IDENTITY_MISMATCH` / `INVALID_REQUEST`
     → RESERVATION_DENIED.
   - **(R51 fix) `CAPACITY_UNMEASURED` → CAPACITY_UNMEASURED — never a capacity wait.**
5. Unreached ranked candidates report STANDBY.
6. Outcome: `ADMITTED` | `QUEUED_FOR_CAPACITY` (real reservation denial /
   concurrency cap / all-eligible-health-blocked) | `DENIED_NO_SUPPLY`.

## Consumption paths

| Path | Trigger | Behavior |
|---|---|---|
| Interactive turn `selectModel` | QUEUED → `FreeCapacityQueued` | `enterCapacityWait`: durable `free_capacity_wait` work item, reservation released (turn settles → `releaseFabricAdmission`), session/turn status `waiting_for_free_capacity` |
| Sweeper (`capacityWaitRetryMs=15s`) | parked turns exist | `probeCapacityWait` → fresh decide → ADMITTED → `resumeTurn` (capacity-resume directive, replan over durable workspace) |
| Workflow poll (`capacityWaitPollMs`) | parked owned turn | same probe→resume; workflow timeout defers while parked; cancellation still lands |
| Subagent `runAgentTurn` | `no_eligible_route` + `queued.nextAvailableAt` ≤ 120s | wait once → re-decide once → else PROVIDER_UNAVAILABLE (fail closed, never park) |
| Failover `handleTurnFailure` | route error classified | health.recordFailure → fabric re-decide (full candidate set, `preferIndependentFromPoolId`) → `rotate` (atomic same-requestId reservation replace) / `retry_same` (bounded same-route wait) / `no_replacement` + `capacityWait` → park |
| Restart hydration | durable wait item + `midTurn` | restores `waiting_for_free_capacity` with same hints; sweeper resumes it |

## Verified properties (no change needed)

- **Domain independence**: pool demand is per-pool; provider A's exhaustion cannot deny
  provider B. Health conditions are per-route, TTL-bounded, auto-expiring
  (`activeConditions` skips expired), and cleared early by a success.
- **Failover breadth**: `fabricReplacement` re-decides the whole ranked set — not the
  next entry in a static list.
- **Lease recovery**: `recoverExpired()` runs on every `reserve()`; dead callers' holds
  expire by `leaseUntil` buckets. Reservation is released at every turn settle.
- **Idempotent re-decide**: `reserve()` with the same `reservationId` replaces the old
  hold — failover/probe re-decides never double-book.
- **Quality ≠ capacity**: health `scoreAdjustment` (capacity channel) and
  `roleQualityDelta` (quality channel) are separate ledgers; 429s never enter role
  evidence.
- **Verdict floor ≠ capacity**: `ROLE_VERDICT_EXCLUDED` → DENIED, never QUEUED.

## R51 defect found (the avoidable-parking bug)

**Unmeasured capacity was indistinguishable from measured exhaustion.**

`RouteQuotaTracker` is in-memory and fed only by response headers. A route/pool whose
quota domain has never been observed projects `windows: []`. In `reserve()` that fell
through to `requestRemaining = 0` → `CAPACITY_EXHAUSTED` → fabric reported
`QUEUED_FOR_CAPACITY` with **no `nextAvailableAt`** → the turn parked durably and the
sweeper re-decided into the identical denial — forever. The state was self-sealing:
an unadmittable route can never serve the call that would measure it.

Reachable in production via:
- cold start of a host that already holds fresh durable qualification receipts
  (`qualifyPending` returns without probing → zero quota observations);
- model-quota-domain providers (`groq`, `mistral`, `github-models` — `quotaDomain:
  "model"`): the catalog-refresh bootstrap probes ONE model per provider, so every
  sibling model's quota domain stays unmeasured indefinitely;
- providers that emit no rate-limit headers at all (e.g. GitHub Models).

Secondary defect: `reserve()` preferred `physicalRoute.windows` even when the pool's
array was empty (`??` doesn't fall through on `[]`), discarding route-scoped
observations; and `hasUnitAccounting` ignored observed token-only windows.

## R51 fix (implemented this round)

1. `CapacityReservationDecision.reason` gains `CAPACITY_UNMEASURED` — a route whose
   effective windows carry no authoritative quota-unit accounting is *unverifiable*,
   not *exhausted*. Pool windows fall back to route windows only when non-empty
   (matches `buildRouteLedger`). Token windows count as metering evidence.
2. `decide()` maps it to candidate status `CAPACITY_UNMEASURED` with domain-qualified
   codes (`PROVIDER_QUOTA_UNMEASURED` / `MODEL_QUOTA_UNMEASURED` /
   `USER_QUOTA_UNMEASURED`); unmeasured denials never produce `QUEUED_FOR_CAPACITY`.
3. `FreeCloudService.probeRouteCapacity(providerId, modelId)` — bounded, deduplicated
   on-demand measurement: `probeAccountQuota` (metadata, zero inference) first, then a
   `maxTokens:1` ping whose headers land through the normal `onResponse` channel — a
   429 still measures truthfully. 60s per-key cooldown prevents probe storms.
4. Measurement triggers wired at every non-admitted decision point:
   - `probeCapacityWait` (sweeper/workflow): measure unmeasured candidates, re-decide.
   - `executeTurn` pre-admission probe: measure before `selectModel` decides.
   - `runAgentTurn` admission: on `no_eligible_route` with unmeasured candidates,
     measure, then re-select before the bounded wait/deny logic.
   - `handleTurnFailure` (both failover sites): after `no_replacement` with unmeasured
     candidates, measure once via `FailoverRequest.measureCapacity` and re-decide the
     replacement set (bounded single pass).
5. `AGENTS.md`-safe: nothing admits without verified windows; fail-closed is preserved —
   the change makes *denial truthful* and gives measured recovery a real path.
