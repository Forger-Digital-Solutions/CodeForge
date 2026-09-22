# R27 8-Bit Report

Status: `R27_8BIT_PRODUCTION_CATALOG_REFRESH_AND_ROUTING_ENFORCEMENT_PROVEN`

## Scope

This report covers deterministic 8-Bit behavior, production catalog refresh integration, durable
persistence, and ForgeAuto routing enforcement. No paid inference was used and no live provider
quota was consumed during this checkpoint. 8-Bit remains downstream of ForgeZero: health evidence
may demote or exclude an already-admitted route, but it may not create free eligibility.

## Core Architectural Distinctions

| Domain | Status | Evidence / Verification |
| --- | --- | --- |
| **Deterministic Lifecycle** | **PROVEN** | 5/5 in `r27-route-lifecycle.test.ts`, 38/38 in adjacent authority and drift suites. |
| **Production Catalog Refresh Integration** | **PROVEN** | `CatalogDriftTracker` wired into `FreeModelCatalogRefresh.refresh()`, detecting drift across refreshed providers and emitting normalized observations (`not_found`, `retired`, `present`, `access_restricted`, `role_failed`). |
| **Durable Persistence & Hydration** | **PROVEN** | `EightBitRouteHealthLedger` attached to `routeHealth`, writing snapshots and observations to `ISessionPersistence`; proven to survive process/authority reconstruction in Scenario 9. |
| **Real Routing Enforcement** | **PROVEN** | `FreeCloudService.routeHealthLookup` queries canonical `EightBitRouteHealthAuthority.assess()`; `isForgeAutoEligible()` strictly excludes retired/restricted/degraded routes while preserving healthy routes. |
| **Controlled Requalification on Recovery** | **PROVEN** | Model re-appearance clears `MODEL_RETIRED` in the authority but evicts stale receipts, requiring re-testing through `qualifyPending` before ForgeAuto trust is restored. |
| **Temporary Quota & Outage Invariants** | **PROVEN** | Outage produces bounded `TEMPORARY_CAPACITY` rather than permanent retirement; `quota_exhausted` is never treated as route disappearance (Invariant §40). |
| **Live-Provider Quota Lifecycle** | **NOT PROVEN (BY POLICY)** | Live provider API keys were not invoked to consume external cloud quota; verification was conducted over production-shaped contracts and mock adapters in strict adherence to zero-cost rules. |

## Production Catalog Refresh & Routing Evidence

Commands and results:

| Command | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run packages/model-registry/test/catalog-refresh-health.test.ts` | 9/9 passed |
| `node node_modules/vitest/vitest.mjs run packages/eight-bit/test/r27-route-lifecycle.test.ts packages/eight-bit/test/route-health-authority.test.ts packages/eight-bit/test/drift.test.ts` | 38/38 passed |
| `node node_modules/vitest/vitest.mjs run packages/model-registry/test/free-cloud-registry.test.ts` | 36/36 passed |
| `node node_modules/vitest/vitest.mjs run packages/model-registry/test/` (all 7 files) | 98/98 passed |
| `node node_modules/vitest/vitest.mjs run packages/eight-bit/test/router.test.ts packages/router/test/free-router.test.ts packages/server/test/route-health-wiring.test.ts packages/server/test/no-eligible-route-turn.test.ts` | 28/28 passed |
| `node_modules\.bin\tsc.cmd -b packages/model-registry/tsconfig.json packages/eight-bit/tsconfig.json packages/forge-zero/tsconfig.json packages/server/tsconfig.json --pretty false` | passed (0 errors) |

## Proven Scenarios

1. **Healthy route stability**: Route remains healthy and ForgeAuto-eligible across repeated refreshes without state thrashing.
2. **Catalog disappearance**: Upstream model disappearance triggers `ROUTE_DISAPPEARED`, emits `fact: "not_found"`, establishes `MODEL_RETIRED`, unregisters from ForgeZero, and excludes route from `isForgeAutoEligible()`.
3. **Temporary provider outage**: Upstream provider outage (e.g. 503) does not classify routes as disappeared; establishes bounded `TEMPORARY_CAPACITY` that expires safely without permanently poisoning the route.
4. **Quota preservation (Invariant §40)**: `quota_exhausted` condition is preserved and never misclassified as route disappearance.
5. **Upstream replacement**: `ROUTE_RENAMED_OR_REPLACED` retires the old route and introduces the new candidate without premature eligibility.
6. **Terms change / paid transition**: Model transitioning from free to paid is flagged with `FREE_TERMS_CHANGED`, establishes `ACCESS_RESTRICTED`, revokes free status, and fails closed.
7. **Capability regression**: Upstream loss of tool calling triggers `CAPABILITIES_CHANGED`, penalizing `CODER` and `TOOL_AGENT` roles while leaving unaffected roles (`PLANNER`) intact.
8. **Controlled recovery**: Re-appearance clears retirement in the authority, but evicts cached qualification receipts so the route is held in `NOT_TESTED` until re-qualified via `qualifyPending()`.
9. **Persistence & hydration**: Complete route state and observations persist via `EightBitRouteHealthLedger` and restore correctly into a fresh authority.

## Conclusion

The previously recorded runtime wiring blocker is **CLOSED**. `CatalogDriftTracker` is actively invoked at the production catalog refresh boundary, normalized observations feed the canonical `EightBitRouteHealthAuthority`, observations persist via the durable ledger, and `FreeCloudService.isForgeAutoEligible()` strictly enforces the authority's health decisions.
