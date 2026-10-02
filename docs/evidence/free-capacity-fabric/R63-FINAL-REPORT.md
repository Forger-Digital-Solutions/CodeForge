# R63 Free Capacity Fabric continuation report

Status: **PARTIAL**. The mandatory two-live-domain gate did not pass: no second independently
owned zero-cost quota domain could be admitted, so live cross-domain failover and genuine
independent multi-user concurrency remain unproven. Everything implementable without external
account authorization — free-wallet isolation, delegated entitlement authority, quota-independence
grouping, production dispatch authority, remote transport, sponsor pipeline, legacy cutover, and
the queue-worker heap root cause — is implemented, tested, and evidence-backed.

## Repository state

- R63 starting HEAD: `57db998de17eead4254f7a1e9ba985e482d91e8c` on `codex/r29-release-closure`.
- R63 implementation commit: `4d620d8584852eb25c91babfbbb744b0a7206412` (source hardening,
  tests, R63 scripts, and the recertified ForgeGreen source-state document;
  evidence/report committed separately).
- Interrupted-session dirty tree was recovered intact: 53 modified tracked files, nothing staged,
  ~30 new R63 source/test files plus evidence and scripts. Six pre-R63 tracked modifications and
  all pre-existing untracked benchmark/evidence debris (`benchmarks/r58|r59|r60 tmp`,
  `docs/evidence/r57-*`, `r59-*`, screenshots, `deploy/inference/qwen-coder-free`,
  `.playwright-mcp`) were left untouched and uncommitted.
- See `R63-START-STATE.json` for the full recovery inventory.

## Recovered interrupted work

All of it was retained; none was discarded. Verification found the dirty tree coherent: strict
typecheck clean, secret scan PASS, and every R63-touched test file green after the fixes made
this session:

- `GovernedProviderAdapter` now forwards `isTestProvider`, so governed test fixtures are not
  mistaken for production Free dispatch candidates.
- The server-stop fixture declares `isTestProvider`.
- A secret-scan false positive on a JSON field name in `scripts/r63-provider-candidates.mjs` was
  reworded rather than allowlisted.
- Two model-registry fixtures (`free-cloud-chaos`, `r59-supply-recovery`) used bare
  `credentialSource:"OAUTH"` connections — which R63 correctly classifies as unverifiable —
  and now model user-owned connected free accounts (`USER_CONNECTED_FREE_API_KEY`).
- `model-selection-boundary`: R63 correctly stopped binding client-supplied `userId` to the
  session runtime identity, but the GEMS paid-entitlement check still read only that identity.
  The requesting user's id now reaches the entitlement check through `TurnState.requestUserId`
  while quota/pool binding stays on the host identity — the paid path is restored and the
  anti-spoofing hardening is preserved.
- `paid-role-routing`: the real `paid-auto` adapter paced its test calls against the
  process-global `defaultCapacityGovernor` sliding window; ~20 scripted paid calls exhausted it
  and the twelfth waited ~27s — marginal past the 30s timeout only inside the full file. Every
  runtime in the file now gets an explicit per-test `ProviderCapacityGovernor`; the previously
  hanging test runs in ~1s and the whole file is green in ~54s.

The two ForgeGreen provenance canaries were resolved by legitimate recertification
(`scripts/r63-recertify-source-state.mjs` → `r63-free-capacity-fabric-v1`), not by weakening them.

## Free-wallet isolation (P0)

ForgeAuto/Free can consume **purchased credits: NO. Paid Auto: NO. BYOK: NO** — unless the user
explicitly selects a non-Free mode.

- `EntitlementService.evaluateTaskExecution(product:"FREE")` evaluates the dedicated Free usage
  period and Free feature set; the paid subscription and wallet balance are not consulted, and
  exhausted Free capacity cannot be refilled or authorized by paid funds.
- `GatewayService` passes `product:"FREE"` explicitly and applies Free per-task credit,
  concurrency, and kill-switch limits unconditionally on Free routes.
- Hosted adapters reject `gems*` model ids outright; `assertFreeDispatch` →
  `authorizeProductionFreeDispatch` requires Fabric admission on every non-test Free dispatch
  (automatic, exact pin, streaming), so catalog registration alone cannot reach a provider.
- Evidence: `R63-FREE-WALLET-ISOLATION.json`, `R63-cloud-e2e-final.json` (Free allowance exhausts
  to zero; a Pro upgrade mints 5,000,000 paid credits and the next Free request is still denied),
  `R63-free-wallet-authority.json` (16 tests).

## Domain A — live

- provider: `kilo-free-direct` (`PACKAGED_FREE_DIRECT`, CLIENT_DIRECT anonymous egress)
- quota scope: `EGRESS_IP` — Kilo documents 200 requests/hour per public IP; recorded
  independence group `kilo-free-direct:PUBLIC_IP:shared-unverified`
- model: `kilo-auto/free`
- live coding: real run `run-b983e1e7` — repository inspection, tool calls, `math.ts` edited
- Reviewer: independent review passed (two advisory findings, both subsequently discharged)
- tests: `npm test` → 3/3 pass inside ForgeVerify with real output
- ForgeVerify: PASS; completion gate: `evaluateCompletion` → `completed`; integration: worktree
  branch integrated
- cost: **UNKNOWN** (upstream cost not fabricated as $0)
- evidence: `R63-DOMAIN-A-LIVE.json`

## Domain B — not admitted

**BLOCKED — EXTERNAL HUMAN AUTHORIZATION REQUIRED.** All 33 cataloged providers were audited
(`R63-PROVIDER-CANDIDATES.json`); every available credential failed authoritative Free
verification. No developer-paid credential was substituted.

| Candidate | Result |
| --- | --- |
| OpenRouter | Env key verified **PAID** (`is_free_tier=false`) → DENIED. Delegated Free path fully implemented (PKCE → current-key metadata → fingerprint/owner-bound receipt → admission); needs a real user Free account. |
| Groq | Env key present; org tier unprovable from inference-key metadata → DENIED. |
| Cloudflare Workers AI | Subscription read HTTP 403; Workers Free plan unverifiable with available scope → DENIED. |
| Cerebras | Only an expiring $5 trial credit exists per official docs → REJECTED (promotional, non-durable). |
| Google/Gemini, Mistral, GitHub Models, SambaNova, OpenCode, Ollama Cloud | Unverified plan/billing, temporary programs, or policy gaps → DENIED. |
| Puter | No authoritative free-vs-purchased allowance boundary provable → not admitted. |

## Cross-domain failover — blocked live, authority proven

No live A→B chain exists (single admitted domain; same-egress Kilo users correctly count as one
group). Deterministic authority is tested: independence grouping, degraded-primary yield,
no paid/BYOK/unqualified fallback, no false waits — `R63-CROSS-DOMAIN-FAILOVER.json`.
paidFallback=0, byokFallback=0, unqualifiedFallback=0, falseWaits=0.

## Multi-user — blocked live, isolation proven

Two users behind one Kilo public IP are one independence group — the correct behavior under the
R63 fix. Isolation surfaces are tested (two-client authority, transaction serialization, sponsor
fairness); concurrent independent-domain live execution awaits Domain B —
`R63-MULTI-USER-LIVE.json`.

## Kilo NAT scope

`packages/forge-zero/src/capacity-independence.ts`: verified physical quota-scope receipts
(provider + scope + hashed owner) form independence keys; unknown/unverified scopes collapse to
`<provider>:<domainType>:shared-unverified`. Same-egress Kilo users/models/sessions/keys can never
manufacture a second domain — `R63-KILO-NAT-SCOPE.json`, `R63-DOMAIN-INDEPENDENCE.json`.

## Remote transport

- **Local/source:** deployable and socket-tested — authenticated bootstrap, device/workspace/
  account binding, expiring+revocable sessions, encrypted secrets, MAC-bound single-use acks,
  bounded leases, heartbeat recovery, generation fencing, PROPOSED_ONLY result validation,
  zero-reported-cost enforcement, feedback binding, cancellation. 28 focused tests pass —
  `R63-REMOTE-TRANSPORT.json`.
- **Deployed production:** **NOT PROVEN.** Render `codeforge-cloud-staging` runs a pre-R63 commit;
  `autoDeploy:false`, production branch is `feat/codeforge-cloud`, and no deploy authorization
  exists in this session — `R63-REMOTE-DEPLOYMENT.json`. These claims are not merged.

## Sponsor pipeline — PASS (production-capable, no live sponsor)

Enrollment, signing-key fingerprint/rotation/expiry/revocation, signed manifests held INERT until
independent qualification, forged-receipt fencing, funded-pool accounting across aliases, fairness
queueing, suspension scoping, restart durability — 13/13 tests over real HTTP + SQLite.
`R63-SPONSOR-OPERATOR.json`, `docs/sponsor-operator-deployment.md`.

## Legacy cutover — COMPLETE

MIGRATE: `productionCapacityRoutes()` migrates recurring zero-cost legacy classes via
`migrateLegacyFreeRoute`. QUARANTINE: migrations failing evidence gates disable the route.
RETIRE/DELETE: classes without recurring zero-cost provenance return `RETIRED`. KEEP: diagnostic
`capacityRoutes()` projection only. Authority canary: `free-routing-authority.test.ts` fails if a
provider bypass is reintroduced — `R63-LEGACY-CUTOVER.json`.

## Queue-worker memory — root cause confirmed and repaired

Zero-delay claim retry loop starved timers and retained unbounded errors (baseline: 45,000 claims,
0 timer ticks, 26MB retained in 1.5s). Repaired: failed/idle claims wait `idleWaitMs` inside the
bounded dispatch loop (13 claims, timers responsive, 5.2MB). Session transactions moved to
AsyncLocalStorage-scoped serialization; direct/BYOK suites re-passed under the previous 4GB
ceiling — `R63-HEAP-DIAGNOSIS.json`, `R63-QUEUE-WORKER-MEMORY.json`, `R63-direct-heap-after.json`.

## Repository validation

`R63-REPOSITORY-TESTS.json` — **PASS, repository-wide green**: bounded-main 527 files / 4378
passed / 0 failed / 50 skipped (exit 0), plus four serial heavy suites (22+4+1+6 = 33 tests);
totals 531 files, 4411 passed, 0 failed; peak process-tree working set ~905MB against the 2048MB
worker cap. `R63-FAILURE-CLASSIFICATION.json` triages every round: 18 failures in the first
interrupted-session run and 24 assertions in the second — every REGRESSION and the one
RESOURCE_FAILURE (shared governor window, above) were fixed in source or fixture; the two
ForgeGreen EXPECTED_DRIFT failures were resolved by recertification; no PRE_EXISTING, REGRESSION,
or RESOURCE_FAILURE remains open. One transient teardown `EPIPE` surfaced during a rerun's
worker shutdown (0 failed assertions, clean on re-run) — classified TRANSIENT_TEARDOWN with the
latent pre-existing cause noted in the classification file.

## Capacity metrics

`R63-CAPACITY-METRICS.json`: live admitted domains=1, independent groups=1, healthy groups=1,
live coding domains=1, successful failovers=0, false waits=0, paid leakage=0, BYOK leakage=0.

## Remaining blockers

1. **EXTERNAL HUMAN AUTHORIZATION REQUIRED** — a real user-owned Free provider account (or a
   provider-issued durable zero-cost grant) must complete the implemented delegated flows.
2. Render deploy authorization: push the committed R63 tree to the production branch and trigger
   the manual deploy, then run the live endpoint checklist in `R63-REMOTE-DEPLOYMENT.json`.
3. With a live Domain B: run live failover and independent multi-user concurrency per
   `R63-CROSS-DOMAIN-FAILOVER.json` / `R63-MULTI-USER-LIVE.json`.

## Evidence

All under `docs/evidence/free-capacity-fabric/` — `R63-*.json` per gate plus
`source-certification.json` (canary: `tests/free-capacity-certificate.test.ts`).
