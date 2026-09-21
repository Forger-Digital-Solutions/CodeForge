# M14B — Ollama entitlement accounting (cloud + local domains)

Status: CLOUD PATH EXISTS (pre-R23); LOCAL ACCOUNTING ADDED (deliberately ineligible);
this workstation has no Ollama daemon — no live capacity observed.

## Cloud path (pre-existing, verified)

`packages/forge-zero/src/user-connected-free.ts` already implements the cloud domain:

- `OllamaFreeUsageObservation` — included USD allowance, remaining, reset, purchased credits,
  paid-subscription and auto-reload flags, `includedUsageDistinguishable`, `hardStopProven`.
- `evaluateOllamaFreeOnlyAdmission` — the financial boundary: purchased credits never fall
  back, unknown included balance is never capacity, paid crossover is blocked.
- `buildOllamaUserCapacityPool` / `buildOllamaUserRoute` — `PER_USER_POOL` + `USER_ACCOUNT`
  scope, `USER_CONNECTED_FREE`, capacity identity hashed from the user id.
- `OllamaUserConnectedFreeFleet` — per-user 8-Bit projection; no method returns credentials.
- Reservations enforce per-user `capacityIdentity` (user-b cannot reserve user-a's pool — test
  `keeps accounts independent…` and `uses token rates…` in `user-connected-free.test.ts`).

## Local path (added this milestone)

Same file, new section `OLLAMA_LOCAL`:

- `OllamaLocalObservation` — `reachable` (live probe result, never assumed), observed model
  tags, device concurrency, confidence.
- `buildOllamaLocalCapacityPool` — `PER_USER_POOL` + `DEVICE` scope, `DISTRIBUTED_USER_FREE`,
  `capacityIdentity` = hash(user, device). Unreachable daemon → `remaining: 0`,
  `authoritative: false` (this workstation's actual state).
- `buildOllamaLocalRoute` — **constructed ineligible by design**: `lifecycle: POLICY_REVIEW`,
  `explicitZeroPrice: false` (no provider-published $0 price exists; local compute is
  unmetered), `managedMultiUserAllowed: false`, `freeOnlyAdmissionProven: false`.

## Policy tension — recorded, not resolved

`AGENTS.md` rule 1 says "Never use local LLM inference." The R23 brief asks for user-owned
local compute to join the fabric. Resolution chosen: **accounting ships, routing does not**.
The ledger can see and meter the `DISTRIBUTED_USER_FREE`/`DEVICE` domain; the eligibility gate
keeps it out of every route until an owner-level decision changes product policy. Any future
enablement is one explicit policy change, not scattered conditionals.

## Domain separation matrix

| Domain | supplyClass | pool scope | capacity scope | owner | routable today |
|---|---|---|---|---|---|
| CodeForge-managed free | PURE_MANAGED_FREE | SHARED_OWNER_POOL | ORG/ACCOUNT | shared pool | after full gate |
| Deposit-unlocked | DEPOSIT_UNLOCKED_FREE | SHARED_OWNER_POOL | API_KEY | shared pool | policy flag off |
| Sponsored (new) | SPONSORED_FREE | SHARED_OWNER_POOL | SPONSORED | shared pool | policy flag off |
| Ollama Cloud (user) | USER_CONNECTED_FREE | PER_USER_POOL | USER_ACCOUNT | that user | after free-only admission |
| Ollama local (user) | DISTRIBUTED_USER_FREE | PER_USER_POOL | DEVICE | that user's device | never (policy) |

Cross-domain pollution is structurally checked by `findOwnershipViolations()` (M14):
`POOL_SCOPE_CONFLICT`, `IDENTITY_DOMAIN_CROSSOVER`, `PER_USER_POOL_WITHOUT_OWNER_IDENTITY`.

## Evidence

- `packages/forge-zero/test/user-connected-free.test.ts` — +3 local-domain tests
  (8/8 pass), alongside the existing cloud-domain tests.
- M14 ledger test `isolates user-entitlement pools from shared supply in aggregation`
  proves shared totals never include per-user quota.

## Gaps

- No local Ollama probe exists in the runtime (no daemon here to test against anyway).
- Ollama Cloud discovery of `includedUsage` requires the provider's usage surface; the
  observation type exists but no live fetcher is wired.
- `hardStopProven` for cloud included-usage cannot be true until the account's behavior is
  observed — admission stays `AT_RISK`/blocked until proven, by design.
