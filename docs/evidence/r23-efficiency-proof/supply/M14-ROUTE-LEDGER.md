# M14 — 8-Bit Route Ledger (supply classes, quota fields, ownership isolation)

Status: IMPLEMENTED (offline-tested). No live routing behavior changed.

## What exists now

`packages/eight-bit/src/route-ledger.ts` — `buildRouteLedger()` projects ForgeZero's
authoritative capacity model (`CapacityRoute` + `ProviderCapacityPool`), 8-Bit measured health,
and caller-supplied provider terms into one flat `RouteLedgerEntry` per route:

```
provider / model / route_id / canonical model
supply_class            (SupplyClass union, incl. new SPONSORED_FREE)
quota_scope             (CapacityScope: ORG/ACCOUNT/USER_ACCOUNT/DEVICE/…)
quota_pool_scope        (SHARED_OWNER_POOL | PER_USER_POOL)
quota_owner             (SHARED_CODEFORGE_POOL | USER_ENTITLEMENT | OWNER_DEV | SPONSORED | UNKNOWN)
quota_owner_identity    (stable non-secret hash; never raw credentials)
quota_period            (new QuotaPeriod: CONTINUOUS/MINUTE_RESET/HOURLY_RESET/DAILY_RESET/
                         WEEKLY_RESET/MONTHLY_RESET/RECURRING/ONE_TIME_CREDIT/
                         EXPIRING_PROMOTION/TRIAL_ONLY/UNKNOWN)
requests_remaining / tokens_remaining / credits_remaining   (min across quota windows; null = UNKNOWN)
rpm / tpm / rpd / tpd   (rate windows only — never mixed into budget fields)
monthly_limit / concurrency / burst_capacity
reset_at / expires_at   (reset replenishes; expiry retires — distinct semantics)
health / latency_p50 / latency_p95 / rate_limit_rate / failure_rate / sample_size
lifecycle               (ForgeZero FreeProviderLifecycle)
commercial_status       (terms status from policyFacts; UNKNOWN when unreported)
multi_tenant_status     (managedMultiUserAllowed → CLEARED/NOT_CLEARED)
production_status       (PRODUCTION_ALLOWED only when free-eligible + multi-tenant + APPROVED)
role_suitability        (qualified roles)
on_exhaustion           (ROTATE_THEN_AWAIT_RESET | ROTATE_THEN_RETIRE |
                         ROTATE_OWNED_THEN_YIELD | NOT_FREE_ELIGIBLE)
free_eligible + exclusion_reason   (real ForgeZero gate, not a ledger opinion)
field_provenance        (OBSERVED | DERIVED | UNKNOWN per economic field)
```

## Schema additions (forge-zero)

- `SupplyClass` += `SPONSORED_FREE` — recurring sponsor-funded capacity. Deliberately **not**
  in `supplyClassIsZeroCash` (a sponsor pays upstream; it is $0 to the user, not zero-cost).
  Gated by new `FreeCapacityPolicy.allowSponsoredFree` (default `false`), same pattern as
  `DEPOSIT_UNLOCKED_FREE`.
- `CapacityWindow` += `period?: QuotaPeriod`, `expiresAt?: string` — additive, back-compatible.

## Ownership-domain proof

`findOwnershipViolations()` + `aggregateSupplyDomains()` provide the structural checks the
brief requires:

- `PER_USER_POOL` entries must carry `quotaOwnerIdentity` → else `PER_USER_POOL_WITHOUT_OWNER_IDENTITY`.
- Same `poolId` claimed as both shared and per-user → `POOL_SCOPE_CONFLICT`.
- Same physical `capacityIdentity` backing both shared and per-user rows → `IDENTITY_DOMAIN_CROSSOVER`.
- `domains.shared` totals never include per-user quota; `domains.perUser` is keyed by the
  non-secret capacity identity hash.

## Window semantics (documented in code)

- Rate windows (`MINUTE_RESET`, `HOURLY_RESET`) populate rpm/tpm/rpd **limits** — their
  `remaining` is never treated as remaining budget.
- `CONTINUOUS` windows are standing capacity (e.g. concurrency), counted as budget facts.
- Expired windows (`expiresAt <= now`) contribute zero to remaining fields but still surface
  `expiresAt` so `onExhaustion` can retire the route.
- Unknown period → `quotaPeriod: UNKNOWN`; unknown numbers stay `null`, never 0.

## Evidence

- `packages/eight-bit/test/route-ledger.test.ts` — 8 tests covering join correctness,
  UNKNOWN preservation, rate/budget separation, promotion expiry, sponsored gating,
  per-user isolation, and violation detection.
- `packages/eight-bit/src/measured-health.ts` — records now retain raw `latencyP50Ms`,
  `latencyP95Ms`, `sampleSize`, `availableCapacity` so the ledger reports observed values.

## Gaps remaining

- No live provider feeds windows yet beyond the OpenRouter accounting built for M3/M4;
  production pools must populate `period`/`expiresAt` for the ledger to be fully OBSERVED.
- No persistence layer for ledger snapshots (decision-receipt store exists as the pattern).
- `production_status` needs real terms data via `policyFacts` — model-registry definitions
  are the intended source; wiring is a caller concern, keeping eight-bit free of a
  model-registry dependency.
