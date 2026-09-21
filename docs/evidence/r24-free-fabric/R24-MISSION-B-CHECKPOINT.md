# R24 Mission B Checkpoint — Free Fabric Composition

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
HEAD: `7cc9cba` · Prior: `c041da1` (Mission A checkpoint)

## Verdict

**`R24_FREE_FABRIC_COMPOSED`** — the capacity primitives (route ledger, reservation ledger,
supply classes, pools/windows, forecast/preflight/simulator) are now joined into one decision
surface. `FreeFabric.decide()` answers "which free route may spend capacity now, for this
user, for this role" and returns a structured explanation — never a bare model name, never a
paid suggestion. Mission B is a milestone: entitlement connectors (Copilot/Ollama fleets),
hosted admission, ForgeGreen efficiency, and the production pilot remain open.

## Architecture

```
FreeCloudService.capacityRoutes()/capacityPools()   ← registry snapshot → ForgeZero's
        │                                            physical capacity model (zero-cash
        │                                            supply classes only; quota windows
        │                                            from observed provider headers only)
        ▼
buildRouteLedger (policy + ownership + quota facts)
        ▼
forgeAutoSupplyPlan (per-user: domain order SHARED → SPONSORED → USER_ENTITLEMENT;
        │              another user's pool is filtered by capacity identity before
        │              any reservation is attempted)
        ▼
EightBitRouteHealthAuthority (Mission A) — hardExclude drops, scoreAdjustment
        │                              re-ranks; ≤ domainDemotionScore (-50) demotes
        │                              behind EVERY undemoted domain
        ▼
CapacityReservationLedger.reserve — fair admission, first-run reserve,
        per-user concurrency cap, per-pool physical accounting
        ▼
FabricRouteDecision — ADMITTED | QUEUED_FOR_CAPACITY | DENIED_NO_SUPPLY
                      + per-candidate reports + zero-cost suggestions
```

## Composition decisions

- **Health demotion is cross-domain, not adjacent.** A saturated shared route
  (scoreAdjustment −60 ≤ −50) yields to the user's own healthy pool — `+1` rank would only
  swap with sponsored supply and still outrank USER_ENTITLEMENT. Demotion adds
  `DOMAIN_ORDER.length`, pushing the route behind all undemoted domains while keeping it a
  last-resort STANDBY candidate rather than a silent exclusion.
- **STANDBY status.** Ranked candidates the admission loop never reached get an explicit
  report row (`RANKED_BEHIND_SELECTED`, `HEALTH_DEMOTED` when applicable) — an explanation
  that drops a demoted route hides the failover evidence it exists to show.
- **`updateRoutes(routes, pools)`** replaces reservation-ledger tables while live
  reservations survive — a catalog refresh can no longer strand a hold or double-admit a
  physical pool. Fabric refreshes the table on every `decide()`.
- **`CapacityLedgerOptions.policy`.** The reservation ledger used to hardcode
  `DEFAULT_FREE_CAPACITY_POLICY`; a host that authorizes sponsored supply in its supply plan
  would have had reservations deny it anyway (`NO_ELIGIBLE_ROUTE`). The ledger now enforces
  the caller's policy.
- **Registry projection is honest, not generous.** `healthy` maps to `forgeAutoEligible`
  (executable-without-qualification is an explicit-picker privilege, not managed-supply
  eligibility); `lifecycle` maps RETIRED→REJECTED, everything else that passed admission
  →APPROVED (DEPRECATED still serves — it is a freshness signal, not an admission
  revocation); `dataPolicyProfile` maps privacyClass `permissive`→USER_CONSENT_REQUIRED.
- **`localconn:<providerId>` identity sentinel.** Plain BYOK connections carry no account
  hash; the sentinel keeps each host's own connection claimable by exactly its fabric plan
  instead of collapsing same-provider keys into one "unclaimed" identity (which would be
  unreachable for everyone) or, worse, a shared one (leakable).
- **`freeOnlyAdmissionProven`** for USER_CONNECTED_FREE requires one of: managed
  user-connection `status === "CONNECTED"`, `planAttested`, or provider `spillover === NONE`.
  A Groq key on a paid plan can bill — unproven accounts fail closed.

## What is deliberately NOT here

- No new provider calls, no new persistence — the fabric is a pure read/decision layer over
  existing evidence. Durable queueing stays with a future hosted admission authority.
- `forecastCapacity`/`preflightCapacity`/`simulateScale` remain evidence functions under the
  default policy; the fabric does not re-derive them per-request yet.
- Other users' entitlement fleets plug in via `UserRouteSource` (Copilot/Ollama per-user
  fleet functions already exist in forge-zero); the desktop host wiring that feeds real
  `managedRoutes`/`userSources`/`userIdentities` is the next mission's seam.

## Test evidence (this mission)

| Suite | Result |
|---|---|
| `packages/eight-bit/test/free-fabric.test.ts` (new, 12 cases) | 12/12 — domain order, capacity fallthrough to own entitlement, cross-user leak refusal, health hard-exclusion, saturation demotion, queueing with reset time, concurrency cap, idempotent requestId, route-table refresh with surviving holds, first-run reserve, no-ledger mode, role-ineligible denial |
| `packages/forge-zero/test/capacity-r4.test.ts` (+2 cases) | 13/13 — updateRoutes keeps live holds across fleet+pool refresh; custom supply policy admits sponsored |
| `packages/model-registry` projection (+3 cases) | 34/34 — zero-cash-only projection, ownership identity, quota-header windows, per-account pools, honest pre-qualification health |
| `packages/eight-bit` full suite | 219 passed, 2 skipped (postgres) |
| `packages/forge-zero` full suite | 117/117 |
| `packages/model-registry` full suite | 88/88 |
| `tsc -b` eight-bit, forge-zero, model-registry | clean |

## Money

$0 spent. All capacity/provider behavior is fixture data; the only new runtime surface is
in-memory composition.

## Known limitations / open work

- The fabric is not yet wired into `forge serve` — `decide()` exists and is proven; the
  server seam (managedRoutes ← freeCloud.capacityRoutes, userSources ← per-user fleets,
  userIdentities ← connection identities) is deliberately the next integration step.
- `QUEUED_FOR_CAPACITY` is a verdict, not a queue: durable wait/recall belongs to the hosted
  admission authority.
- Reservation accounting treats absent token windows as zero unless credit accounting exists
  (fail-closed). Providers that report only request quota need a demand shape that doesn't
  reserve tokens, or token headers — surfaced honestly in candidate reports.
- Sponsored/deposit supply classes remain policy-gated off by default.
