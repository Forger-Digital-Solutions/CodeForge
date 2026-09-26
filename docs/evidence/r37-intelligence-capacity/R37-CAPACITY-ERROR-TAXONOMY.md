# R37 — Capacity / Provider Error Taxonomy

Two complementary vocabularies already exist and are kept distinct:

- **Provider call failures** — `FailureReasonSchema` (17 reasons) +
  `FAILURE_POLICY` action semantics in `packages/eight-bit/src/types.ts`.
- **Admission denials** — `CapacityReservationLedger.reserve()` reason codes +
  the fabric's per-candidate `FabricCandidateReport` ledger.

Cancellation is deliberately **not** a failure reason: it is a task lifecycle event
(`AGENT_CANCELLED` in the runtime, `TASK_CANCELLED` in hosted admission,
`USER_CANCELLED` in outcome taxonomy). Routing never retries a cancelled task — correct.

## Required class → current vocabulary → action

| Required | Vocabulary | Action (existing policy) |
|---|---|---|
| RATE_LIMITED | `RATE_LIMITED` | cooldown_and_rotate — different quota domain next |
| MODEL_QUOTA_EXHAUSTED | `QUOTA_EXHAUSTED` on a model-sharded pool (`...:model:`) → fabric now reports `MODEL_QUOTA_EXHAUSTED` | try sibling model pool |
| PROVIDER_QUOTA_EXHAUSTED | same on account pool → `PROVIDER_QUOTA_EXHAUSTED` | skip routes sharing the account domain |
| USER_QUOTA_EXHAUSTED | PER_USER_POOL exhaustion → `USER_QUOTA_EXHAUSTED` | entitlement boundary respected; other users unaffected |
| ACCOUNT_CREDIT_EXHAUSTED | `PAID_PLAN_REQUIRED` / `FREE_TIER_NOT_AVAILABLE` | remove_and_refresh — never retry into a charge |
| CONCURRENCY_LIMITED | `USER_CONCURRENCY_LIMIT` (admission) | queue, never extra hold |
| PROVIDER_OUTAGE | `PROVIDER_OUTAGE` | cooldown_and_rotate |
| NETWORK_FAILURE | `TRANSIENT_NETWORK` | bounded_retry |
| AUTH_INVALID / AUTH_EXPIRED | `AUTH_FAILURE` | cooldown_and_rotate; `AUTH_REQUIRED` health state |
| MODEL_REMOVED | `MODEL_NOT_FOUND` / `MODEL_RETIRED` | remove_and_refresh + catalog retirement flow |
| MODEL_OVERLOADED | `TEMPORARY_CAPACITY` | cooldown_and_rotate |
| CONTEXT_TOO_LARGE | `CONTEXT_LIMIT` | surface_only — route physically can't serve; right-fit ranking picks larger route |
| TOOL_UNSUPPORTED | eligibility layer (RoleContract.requiresTools) — not a runtime failure | route is skipped before admission, not retried |
| MALFORMED_PROVIDER_RESPONSE | `INVALID_TOOL_OUTPUT` / `BAD_REQUEST` | bounded_retry / surface_only |
| UPSTREAM_5XX | `TEMPORARY_CAPACITY` / `PROVIDER_OUTAGE` | cooldown_and_rotate |
| TIMEOUT | `TIMEOUT` | bounded_retry (single blip never demotes) |
| POLICY_REJECTION | `SAFETY_REJECTION` / `ACCESS_RESTRICTED` / `FREE_ELIGIBILITY_REMOVED` | surface_only / remove_and_refresh |
| CANCELLED | task lifecycle, not failure | terminal, never retried |
| UNKNOWN_PROVIDER_ERROR | `UNKNOWN` | bounded_retry |

## Change this pass

`FreeFabric` now emits domain-qualified denial codes on every capacity denial and
queues them into the wait-state ledger:

- `MODEL_QUOTA_EXHAUSTED` — model-sharded pool (`capacityPoolId` contains `:model:`)
- `PROVIDER_QUOTA_EXHAUSTED` — account-scoped shared pool
- `USER_QUOTA_EXHAUSTED` — per-user entitlement pool

The raw ledger reason (`CAPACITY_EXHAUSTED`) is retained alongside for traceability.

## Wait-state proof shape

A `QUEUED_FOR_CAPACITY` decision's `explanation.candidates` is the exhaustion ledger:
each candidate carries a status + reason codes that reconstruct *why* — e.g.
`MODEL_QUOTA_EXHAUSTED`, `HEALTH_EXCLUDED`, `ROLE_INELIGIBLE`,
`DATA_POLICY_*`, `USER_CONCURRENCY_LIMIT`, `RIGHT_SIZE_PRESERVED`,
`ROLE_PROBATION_FALLBACK`, `INDEPENDENT_POOL_PREFERRED`. A wait means every ranked
candidate has a negative row; nothing is parked without per-route evidence.

## False-wait coverage (adversarial suite, all passing)

- provider A saturated → healthy user pool serves (`demotes saturated shared supply`)
- model A exhausted → sibling model B admits (model-domain independence test)
- qualified unavailable → probation fallback admits (R37 probation tests)
- too-small context → larger-context route admits (right-fit tests)
- first-run reserve → new user admitted, normal queued (reserve test)
- duplicate requestId → replaces hold, never double-spends
- identity-less request → can never touch another user's pool
- stale route table → `updateRoutes` refresh admits on new fleet
