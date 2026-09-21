# R24 Mission A Checkpoint — 8-Bit Route-Health Authority Drives Routing

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
Baseline HEAD: `0407e8a` (R24 recovery snapshot) · R23 close: `0c4d9eb`

## Verdict

**`R24_8BIT_HEALTH_ROUTING_PROVEN`** — a real provider event enters CodeForge once, becomes a
normalized time-aware 8-Bit observation, changes the correct route's health for the correct
role and duration, survives/reconciles restart appropriately, and ForgeAuto actually changes
its route decision because of it — without violating supply policy, quota safety, or user
isolation. Mission A is a milestone, not R24 completion: Free Fabric, user-connected supply,
ForgeGreen efficiency, and the production pilot remain open.

## Architecture

```
Provider / Model Execution (both server paths)
        │  streamChat / modelAdapter.execute — success AND failure, once each
        ▼
Normalized Route Observation (kind: call_success | call_failure | tool_outcome |
        rate_limit_headers | governor_pressure | probe_gate | catalog | entitlement | …)
        │
        ├──► Governor (unchanged owner of admission/pacing; pressure read into 8-Bit)
        ├──► RouteQuotaTracker (unchanged FreeCloud quota surface)
        └──► EightBitRouteHealthAuthority  ← host-scoped, shared across session runtimes
                    │  temporal conditions (TTL) · permanent conditions · role-scoped
                    │  conditions · rolling windows · confidence · probe advice
                    ▼
              ForgeAuto Router / selectModel
                    hardExclude → drop · scoreAdjustment → re-rank · NEVER grants eligibility
                    ▼
              Route Decision (ForgeZero + freeCloud hooks still gate admission first)
```

Persistence: `EightBitRouteHealthLedger` on the existing `work_items` surface —
`eight_bit_route_observation` (append-only learning data) + `eight_bit_route_health_authority`
(per-route snapshot upsert). No second health database. Writes are serialized and
failure-isolated.

## Health states (14)

`HEALTHY · DEGRADED · SATURATED · RATE_LIMITED · DAILY_QUOTA_EXHAUSTED · TEMPORARY_CAPACITY ·
ACCESS_RESTRICTED · MODEL_RETIRED · AUTH_REQUIRED · USER_CONNECTION_REQUIRED ·
BILLING_VERIFICATION_REQUIRED · TOOL_UNRELIABLE · CAPABILITY_LIMITED · QUARANTINED · UNKNOWN`

- **Permanent** (expiresAt `null`, only catalog/recovery clears): MODEL_RETIRED,
  ACCESS_RESTRICTED, BILLING_VERIFICATION_REQUIRED.
- **Hard exclusions**: all permanent states + AUTH_REQUIRED, USER_CONNECTION_REQUIRED,
  QUARANTINED, DAILY_QUOTA_EXHAUSTED, active RATE_LIMITED.
- **Condition-aware TTL**: RATE_LIMITED uses provider Retry-After/reset (fallback 60s);
  SATURATED 5 min; TEMPORARY_CAPACITY 3 min; HEALTHY 30 min; daily quota 6h default;
  AUTH_REQUIRED 24h; TOOL_UNRELIABLE/CAPABILITY_LIMITED evidence windows (2×/4× healthy TTL).
- **Role-scoped**: TOOL_UNRELIABLE binds TOOL_DEPENDENT_ROLES (CODER/TOOL_AGENT/FAST_WORKER);
  CAPABILITY_LIMITED binds only the role that failed, cleared by that role's verified
  completion.

## Wiring proven end-to-end

| Producer | Observation | Proof |
|---|---|---|
| Interactive turn (path 2) success | `call_success` + latencyMs, role=CODER, input/output tokens, correlationId=turnId, requestShape=production | route-health-wiring T1: HEALTHY, window.calls=1, durable rows, exactly one observation per call |
| Orchestrated run (path 1) success | same fields, role=eightBitRoleForAgentRole(req.role), correlationId=runId | agent-orchestrator-integration 7/7 |
| Stream error event | `call_failure` with status/retryAfter preserved on thrown error | T2: 410 → MODEL_RETIRED permanent, hardExclude, never called again across 2 turns |
| Provider-rejected tool call | `call_failure(INVALID_TOOL_OUTPUT)` pushes ONE role-scoped malformed sample; failover path feeds only the legacy reliability tracker | T3: 3 rejections → malformedToolCalls=3 (not 6), not QUARANTINED |
| FreeCloudService.onProviderResponse | `rate_limit_headers` (quota + reset), source `registry` | T5/T6: 429+45s-reset → RATE_LIMITED hard-exclude with provider TTL; 200 → quota facts, no fabricated failure |
| Governor | `governor_pressure` (pacingWaitMs, inFlight, bucketRemainingTokens) after each call | T1 durable observation rows |
| Legacy trackers | health/reliability kept for cooldown + hard gates | unchanged contracts, all regressions green |

Dedupes fixed this mission: provider-rejected tool calls were feeding the authority twice
(`call_failure` + `tool_outcome`) — now one sample per event; the same rejection's role was
dropped before reaching `onFailure` — now propagated so role-scoped conditions bind correctly.

## Routing proof

- `selectModel` (interactive) and `resolveCanonicalSelection`/`selectRoute` (orchestrated)
  apply `routeHealth.assess(role)`: `hardExclude` filters candidates, `scoreAdjustment`
  re-ranks survivors. UNKNOWN is mildly negative (-5) so evidenced routes win; SATURATED -60
  loses to a healthy route; permanent/billing/auth/quota states never select.
- T4 cross-session: SATURATED observed under session A re-ranks session B's selection — B
  completes on the healthy route and never touches the saturated one (callCount=0).
- Policy order preserved: ForgeZero → freeCloud admission → health → role → capacity. The
  authority can only remove or re-rank already-admitted routes; it cannot create eligibility.

## Restart / hydration

- `CodeForgeServer` owns one authority + ledger (`routeHealth`), hydrates in `init()` before
  any recovered turn re-routes, injects into every `AgentRuntime` (both creation sites).
- Runtime-private authorities (tests/tools without a host) self-attach a ledger and hydrate
  in `EightBitRuntime.hydrate()`.
- Authority hydration drops expired transient conditions, keeps permanent ones (eight-bit
  suite: restart keeps MODEL_RETIRED excluded, expired SATURATED gone).

## Probe budgeting

`probeAdvice` + `route-probe.ts`: production-shaped probes (real system prompt + tool schemas,
streaming, maxTokens 4096), bounded repeats, request/token reserves (20 req / 20k tok),
state-aware gating — permanent conditions ≈ never, fresh healthy evidence suppresses,
near-expiry saturation can re-probe. Probe verdicts re-enter as `probe_gate` observations.

## Test evidence (this mission)

| Suite | Result |
|---|---|
| `packages/eight-bit/test/route-health-authority.test.ts` | 25/25 |
| `packages/server/test/route-health-wiring.test.ts` (new) | 6/6 |
| `packages/eight-bit` full suite | 207 passed, 2 skipped (postgres) |
| `packages/model-registry` | 85/85 |
| server targeted (agent-runtime, failover, role-routing, tool-loop, governor, restart/exact-pin, no-eligible-route, fg3-context, pinned-recovery) | 29/29 |
| `agent-orchestrator-integration` | 7/7 |
| `tsc -b` eight-bit, model-registry, server, desktop | clean |

## Money

$0 spent. No live inference was sent for this mission — all provider behavior is scripted
test doubles (`isTestProvider: true`); the FreeCloud header observations are synthetic header
sets through the real `onProviderResponse` path. Paid/BYOK routes remain unreachable:
the authority only re-ranks ForgeZero-admitted candidates.

## Known limitations / open work

- `probeRouteIfWorthwhile` is wired for use but no live probe ran this mission (zero-spend).
- Desktop wiring connects `freeCloud.setRouteHealth(server.routeHealth)`; server-initiated
  hydration covers restart. No desktop-specific e2e test added yet.
- `TOOL_UNRELIABLE`/`CAPABILITY_LIMITED` role scoping is unit-proven; role-qualified live
  evidence belongs to the R24 role-protocol missions.
- Free Fabric (Mission B), Copilot/Ollama entitlement, ForgeGreen efficiency, ForgeVerify
  adversarial matrix, DAU capacity model: not started — next.
