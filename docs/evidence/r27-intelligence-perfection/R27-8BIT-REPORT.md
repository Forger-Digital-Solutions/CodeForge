# R27 8-Bit Report

Status: `R27_8BIT_DETERMINISTIC_LIFECYCLE_PROVEN_WITH_RUNTIME_WIRING_BLOCKER`

## Scope

This report covers deterministic 8-Bit behavior only. No paid inference was used and no live
provider quota was consumed during this checkpoint. 8-Bit remains downstream of ForgeZero: health
evidence may demote or exclude an already-admitted route, but it may not create free eligibility.

## Evidence

The R27 lifecycle suite exercises the transitions that a changing free-model supply must handle:

- temporary provider outage becomes recoverable after its bounded TTL;
- catalog `not_found` becomes a permanent retirement with no probe spending;
- catalog `present` clears the retirement only after positive catalog evidence returns;
- Planner failure is role-scoped and does not poison the Coder role;
- verified Planner completion clears that role-specific limitation;
- repeated malformed tool calls quarantine a route and require explicit recovery;
- catalog free-term and capability changes are detected;
- a route whose temporary quota is filtered out is not falsely classified as disappeared;
- a paid catalog transition fails closed under the adaptive/free policy.

Commands and results:

| Command | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run packages/eight-bit/test/r27-route-lifecycle.test.ts` | 5/5 passed |
| `node node_modules/vitest/vitest.mjs run packages/eight-bit/test/r27-route-lifecycle.test.ts packages/eight-bit/test/route-health-authority.test.ts packages/eight-bit/test/drift.test.ts` | 38/38 passed |
| `node_modules/.bin/tsc.cmd -b packages/eight-bit/tsconfig.json --pretty false` | passed |

The existing authority suite also covers rate-limit windows, daily allowances, authentication,
probe budgeting, persistence/hydration, role reliability, router selection, and runtime feeding.
The existing drift suite covers route appearance, disappearance, replacement, free-term changes,
capability changes, staleness, and promotion receipts.

## Findings

The route-health authority is materially stronger than a static provider list. It keeps temporal
conditions, hard exclusions, role-scoped capability evidence, probe advice, expiry, persistence,
and route-level receipts. Planner scarcity is represented as capability evidence rather than being
hidden by inflating the qualified roster.

The remaining gap is integration, not unit behavior. `CatalogDriftTracker.detectCatalogDrift()` has
no production call site outside tests, and no catalog-refresh path currently emits normalized
`catalog` observations into the host-shared `EightBitRouteHealthAuthority`. Current routing still
benefits from ForgeZero's current model map and role eligibility, but historical retirement and
reappearance state is not proven to update automatically after a real provider catalog refresh.

This is intentionally not marked complete. A later R27 checkpoint must either wire the real
catalog-refresh boundary to the authority and durable ledger, or provide evidence that the free
cloud registry already owns that boundary and emits equivalent receipts. A test-only coordinator
would not satisfy this requirement.

## Next proof required

1. Identify the authoritative free-catalog refresh boundary.
2. Emit drift and normalized catalog observations there, preserving the temporary-quota invariant.
3. Persist the observations through the existing route-health ledger.
4. Prove router behavior across disappearance, replacement, capability shrink, free-status removal,
   provider outage, and recovery using a real registry fixture rather than direct authority calls.
5. Re-run the lifecycle suite and a no-paid-inference guard.

