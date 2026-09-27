# R51 Final Report — Free Capacity, ForgeGreen, ForgeVerify & Autonomous Reliability Closure

Round: R51. Scope: eliminate avoidable "waiting for free capacity" states while preserving
fail-closed correctness, $0 supply, independent verification, and the 16-Bit boundary.

## Defect found (Phase B/C trace → fix → live proof)

**Unmeasured capacity was indistinguishable from measured exhaustion — a self-sealing
false park.**

`RouteQuotaTracker` is in-memory and fed only by observed response headers. A route whose
quota domain has never been measured projected `windows: []`, which the reservation ledger
classified as `CAPACITY_EXHAUSTED` → `QUEUED_FOR_CAPACITY` with **no `nextAvailableAt`**
→ the turn parked durably and the sweeper re-decided into the identical denial forever.
Self-sealing: an unadmittable route can never serve the call that would measure it.

Production reachability: cold start with fresh durable qualification receipts (qualifyPending
returns early → zero quota observations); model-quota-domain providers (`groq`, `mistral`,
`github-models`) where the catalog-refresh bootstrap probes one model per provider and
sibling domains stay unmeasured indefinitely; providers that emit no rate-limit headers.

Full trace: `R51-CAPACITY-STATE-MACHINE.md`.

## Implemented fix

1. **`CapacityReservationDecision.reason: "CAPACITY_UNMEASURED"`** (forge-zero) — a route
   with no authoritative quota-unit window is *unverifiable*, not *exhausted*. Denied, never
   admitted on faith, never parked. Pool windows fall back to route windows only when the
   pool array is empty; token/credit/provider-unit windows count as metering evidence.
2. **Fabric surface** — candidate status `CAPACITY_UNMEASURED` + `capacityPoolId` on reports;
   domain-qualified codes `PROVIDER_QUOTA_UNMEASURED` / `MODEL_QUOTA_UNMEASURED` /
   `USER_QUOTA_UNMEASURED`; unmeasured-only denials emit `DENIED_NO_SUPPLY` with no
   `nextAvailableAt`; measured exhaustion still emits `QUEUED_FOR_CAPACITY` with real reset.
3. **`FreeCloudService.probeRouteCapacity(providerId, modelId?, {capacityPoolId?})`** —
   bounded on-demand measurement: `probeAccountQuota` metadata first (zero inference), else
   one `maxTokens:1` ping whose headers land through `onResponse` even on 429. Per-domain
   60s cooldown; managed-account scope resolved through the pool table (no string splits).
   Returns whether authoritative evidence now exists — a failed probe fabricates nothing.
4. **Runtime measurement triggers at every non-admitted decision point** — initial
   `executeTurn` admission (probe → release hold → real decide under same requestId),
   `probeCapacityWait` sweeper/workflow re-evaluation, `runAgentTurn` admission, and both
   `handleTurnFailure` failover sites via `FailoverRequest.measureCapacity` (once per
   failure path, guarded by `capacityMeasured`, same requestId → reservations replaced
   not double-spent, no stale `capacityWait` wrapping of post-measure verdicts).
5. **No measurement hook → truthful `no_replacement`/`DENIED`, not a false wait.**

## Regression & unit coverage (added/updated)

- `packages/forge-zero/test/capacity-transition-chaos.test.ts` — empty windows now classify
  UNMEASURED (not exhausted); non-authoritative *documented* windows still gate by numbers.
- `packages/eight-bit/test/free-fabric.test.ts` — unmeasured candidate →
  `CAPACITY_UNMEASURED` + domain code + no `nextAvailableAt`; measured-zero still queues
  with reset.
- `packages/eight-bit/test/runtime.test.ts` — failover measures an unmeasured candidate once
  and rotates after re-admission; no hook → honest `no_replacement` (not `capacityWait`).
- `packages/model-registry/test/probe-route-capacity.test.ts` (new, 6 tests) — metadata
  probe preferred, ping fallback, 429-still-measures, dedup/cooldown, managed-account scoping,
  failed-probe-fabricates-nothing, and the full deadlock regression (unmeasured denial →
  probe → admit).
- `packages/server/test/free-fabric-wiring.test.ts` (+2, 18 total) — serving path measures
  an unmeasured route, admits, executes, releases; durable capacity-wait unchanged.

## Test & build totals

| Suite | Result |
|---|---|
| forge-zero | 152 pass |
| model-registry | 138 pass (10 files) |
| eight-bit | 332 pass, 2 skip (31 files) |
| server | 896 pass, 3 skip, **2 baseline failures** — `agent-certification-r`, `fg3-model-aware-budget` (unchanged since `d4769e8`, documented at R50; standalone rerun confirms both unrelated to R51) |
| `npm run build` | clean — all workspaces |

Note: the default-timeout full-server sweep shows ~50 wall-clock timeouts on this machine
(heavy git/worktree failover tests legitimately run 5–10s). Verified non-regression by
stash A/B + standalone reruns; at `--testTimeout 20000` the suite is 896/2-baseline/3-skip.

## Live missions ($0, real providers)

Three missions through the full production stack (FreeCloudService → FreeFabric → roles →
ForgeVerify → completion gate → integration). Evidence JSONs in this directory.

| Scenario | Result | Proof |
|---|---|---|
| `unmeasured` | **completed** 130s | 112 domains unmeasured, 0 observed; all 3 roles pre-denied `CAPACITY_UNMEASURED`; runtime demand-probed, admitted, completed; gate=completed, treeEqual=true. Pre-R51 this parked forever. |
| `healthy` | **completed** 193s | Normal bootstrap (20 domains pre-measured); coder served `managed:groq`, reviewer `managed:openrouter` — independent pools. |
| `reviewer-scarcity` | **completed** 377s | 13 reviewer-capable routes rate-limited; real mid-run failover onto surviving Groq pool; independent pools; gate verified. |

All served routes ForgeAuto-eligible, `paidSpendUsd: 0`, verified-tree == integrated-tree.

## Long-horizon simulation

`benchmarks/r51/r51-capacity-simulation.mjs` — seeded, deterministic: 5 managed routes
churning measured/exhausted/unmeasured over 240 assignments through the real ledger +
fabric. Result: 241 decides, 210 admitted, 30 measured queues, 1 unmeasured-denial
recovery via probe, **0 invariant violations** (`R51-LONG-HORIZON-SIMULATION.json`).

## Phase E — Cloudflare third-domain re-check

Re-queried `aiInferenceAdaptiveGroups` on the live token: `"not authorized for that
account"` — the token still lacks account analytics-read. Workers AI remains legitimate
free supply (inference path verified at R50), and the neuron guard correctly continues to
fail closed. Honest limitation unchanged: mint a token with Workers AI analytics read to
open the third domain.

## Boundary & policy audit

- No paid or unknown-cost route was added anywhere; all measurement calls are `maxTokens:1`
  on ForgeZero-verified free routes or metadata endpoints.
- The completion gate is untouched; nothing reaches `completed` without it.
- Quality ≠ capacity separation preserved (role-quality channel untouched).
- Fail-closed preserved: unmeasured → denied until measured; probe failure → still denied.

## Files changed

`packages/forge-zero/src/capacity-types.ts`, `capacity-reservations.ts` ·
`packages/eight-bit/src/free-fabric.ts`, `failover.ts`, `runtime.ts` ·
`packages/model-registry/src/free-cloud-service.ts` ·
`packages/server/src/agent-runtime.ts` ·
tests listed above · `scripts/r51-capacity-mission.mjs` ·
`benchmarks/r51/r51-capacity-simulation.mjs` · evidence in `docs/evidence/r51-capacity-closure/`.

## Verdict

The central R51 question — *when one free route disappears or was never measured, does
CodeForge find the next legitimate zero-cost path without false-parking?* — is answered
with live proof: unmeasured supply is now a bounded measurement, not an infinite wait;
measured exhaustion still waits truthfully; and denial without a measurement path stays
honest. Closed at $0 with independent verification intact.
