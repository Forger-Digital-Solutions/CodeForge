# R50 Quality-Signal Callgraph

Traced from source at `be583f8e`. One authority owns runtime evidence — no second feedback
system is built; R50 extends this path, it does not fork it.

## The single feedback pipeline

```
producers ──observe(NormalizedObservation)──▶ EightBitRouteHealthAuthority
  agent-runtime (role run loop, turn loop, failover)          │
  catalog-refresh (probe gates, catalog/entitlement facts)    │ per RouteState:
  providers (quota headers, account probes)                   │   conditions (TTL'd, role-scoped)
  governor, free-cloud-service                                │   calls/tools ring windows
          │                                                 ▼
        ┌─┴──────────────────────────────────────────────────────────┐
        │ consumers                                                   │
        │  assess(route,{role}) → scoreAdjustment, hardExclude        │
        │     └→ FreeFabric.decide()  (free-fabric.ts:349-385)        │
        │     └→ ForgeRouter.selectRoute() (router.ts:174-215)        │
        │  probeAdvice() → bounded re-probing                          │
        │  snapshot() → EightBitRouteHealthLedger → work_items         │
        │             (durable; hydrate() on restart)                  │
        └─────────────────────────────────────────────────────────────┘
```

Persistence: `EightBitRouteHealthLedger` (`route-health-ledger.ts`) appends every observation
to `eight_bit_route_observation` work items (append-only, durable) and upserts each route's
`RouteHealthSnapshot` under `eight_bit_route_health_authority`. Conditions (incl. role-scoped
`roles[]`) survive restart via `hydrate()`; call/tool windows restart empty by design.
Qualification receipts persist separately in the session DB via `QualificationPersistence`.

## `role_outcome` producers (all current call sites)

| Site | Outcome | Attribution |
|---|---|---|
| `agent-runtime.ts:2056` | `role_failed` — empty/cap-truncated response | `activeSelection` (current route) |
| `agent-runtime.ts:3291` | `role_failed` — `AGENT_MODEL_TURN_LIMIT` | `journalActiveRoute` (final served route ✓) |
| `autonomous-orchestrator.ts:1003` | `verification_failed` — ForgeVerify rejected implementer output | implementer's exact served route |
| `autonomous-orchestrator.ts:1138` | `verified_complete` — only after completion gate + integration accept | implementer route |
| `catalog-refresh.ts:404,413` | `role_failed` ×{CODER,TOOL_AGENT} — toolCalling capability dropped from catalog | registry source |
| `agent-runtime.ts:1108` `recordRoleOutcome()` | public seam; union limited to verified_complete/verification_failed/role_failed; ignores paid routes | caller-supplied route |

## `role_outcome` handling (authority switch, `route-health-authority.ts:512-530`)

| Outcome | Effect today |
|---|---|
| `role_failed`, `verification_failed` | CAPABILITY_LIMITED condition, role-scoped, TTL=4×healthyTtl (2h), conf 0.5, +0.1 reinforcement per repeat |
| `verified_complete` | removes this role from CAPABILITY_LIMITED (instant clear) |
| `security_blocked` | **ignored** (declared in union, no case) |
| `budget_exhausted` | **ignored** (declared in union, no case) |

CAPABILITY_LIMITED → −40 score via `assess(role)`, role-filtered at `activeConditions` (line 748).
Not a hard exclude — demotion only.

## `tool_outcome` producers

| Site | Path |
|---|---|
| `runtime.ts:232` `recordToolCallOutcome` | → `reliability.record` (in-memory tracker, `reliability.ts`; score<0.8 demotes, 4-streak quarantines via `eligibility.ts:79-86`) AND → `tool_outcome` observation → TOOL_UNRELIABLE (−50 role-scoped, `TOOL_DEPENDENT_ROLES`) / QUARANTINED hard-exclude after 4-streak |
| `agent-runtime.ts:4966` | interactive path: malformed/valid args |
| `agent-runtime.ts:5541` | provider-side `INVALID_TOOL_OUTPUT` → `reliability.record("malformed")` (authority already saw it as call_failure → tool sample; deliberately not double-fed) |
| `agent-runtime.ts:2560,2585` | structured-output failure/repaired |

**Subagent role-run loop emits nothing** for locally-detected bad calls:
malformed args (`PARSE_FAILED`), unknown tool, boundary violations
(`TOOL_PATH_ESCAPE`/`TOOL_WORKSPACE_ESCAPE`/`TOOL_SENSITIVE_PATH_DENIED`/`TOOL_PERMISSION_DENIED`
at `:3170` — returns `blocked` with no observation), `AGENT_TOOL_LOOP_DETECTED`/oscillation
(`:2707`,`:2733`), permission denials (`:2895-2916`).

## Qualification vs runtime quality (two separate concepts — preserved)

- `roleQualificationStatusFor(receipt, role)` → admission floor (`routeAdmission` filter, fabric `:345`)
- `roleQualityAdvice(receipt, role)` → ±12 scoreAdjustment from receipt verdict (`role-quality.ts:87`)
- `roleQualityAdjustmentFor(role)` (`agent-runtime.ts:4495`) → wired into `admitThroughFabric`,
  `selectInitialRoute` (`:1868`), and failover re-decide (`:2185`)
- Runtime evidence reaches ranking ONLY through authority conditions → `assess(role)` inside
  `fabric.decide` (scoreAdjustment) and `router.selectRoute`. Coarse: CAPABILITY_LIMITED −40,
  TOOL_UNRELIABLE −50, or nothing. No graded per-role accumulation; verified_complete erases
  the role's condition fully (single success = full clear).

## Turn budget / failover accounting

- `turnCount++` at `:2405` per outer loop iteration. `requestModelTurn` (`:1954`) contains an
  internal `for(;;)` bounded by `ROLE_ROUTE_MAX_FAILOVERS` — **failovers do not consume extra
  turns**; a turn that ends in unrecovered provider failure throws and ends the run.
- `routeFailovers[]` records each rotation (`from/to/at/reason/callsBeforeFailure`) — run scope.
- Gap: the replacement route inherits the remaining `maxModelTurns` unchanged; no bounded
  headroom grant exists for post-failover continuation.
- `exhaustedModelTurns` → `role_failed` evidence (`:3290`) — the R49 nemotron explorer
  non-convergence DID feed quality evidence; the reviewer workspace-escape did NOT.

## Reliability tracker

`EightBitReliabilityTracker` (`reliability.ts`): in-memory Map, 50-call window,
MIN_SAMPLES_FOR_GATE=5, score<0.8 demotes, 4 consecutive bad → quarantined (hard gate in
`eligibility.ts`). Not persisted — a restart resets it; authority conditions carry the durable
weight. Feeds eligibility only, not ranking score.

## What R50 changes (mapped to gaps)

- Authority `role_outcome` handles `security_blocked`/`budget_exhausted` + `failureClass`
  discriminator (canonical §4 vocabulary; capacity failures never reach this kind).
- Per-role graded evidence buffer on RouteState → bounded `roleQualityDelta` merged into
  `roleQualityAdjustmentFor`; persisted in RouteHealthSnapshot (hydrate-safe).
- Subagent loop emits `tool_outcome` (+`security_blocked` role_outcome) for local rejections.
- Bounded failover turn-grant from `routeFailovers.length`.
- Dedup: correlationId-keyed role evidence (double emission can't double-penalize).
