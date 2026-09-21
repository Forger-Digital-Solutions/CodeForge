# R24 Phase 7–9 Checkpoint — ForgeGreen Audit, Live Capacity Topology, Paired Efficiency Benchmark

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
Prior: `555d98e` (Mission C checkpoint — fabric authoritative in the serving path)

## Verdict

**`R24_CAPACITY_AWARE_TOPOLOGY_PROVEN`** — ForgeGreen's provider-capacity topology
advice is no longer dead code: the orchestrator now resolves adaptive topology against
live Free Fabric + route-health observations, and a paired benchmark shows the
capacity-advised reduction reaching the **same gate-verified completion** with
**2× fewer provider calls and ~1.96× fewer tokens** under a deterministic mechanism
harness.

This is a mechanism verdict, not a live-model quality claim: the scripted provider
returns contract-valid output per role, so correctness is equal by construction and
every measured difference is attributable to the topology decision alone.

## Phase 7 — ForgeGreen audit: what is measured, and the gap

ForgeGreen's R0 telemetry (`packages/forge-green/src/r0-telemetry.ts`) already measures,
with source/origin provenance:

- provider/model attempts, input/cached-input/output/total tokens, effective uncached input;
- stable prompt-cache hits (self-reported and provider-reported);
- tool calls executed/failed, duplicate-equivalent tool calls, raw vs delivered tool-output
  bytes and compression savings;
- retry counts/reasons, provider failures/rate limits;
- context bytes by source category, route class;
- completion/authority observations bound to the run.

Baseline simulation, sustainability receipts, and shadow mode exist and are honest —
they never fabricate a live counterfactual. `topology-advice.ts` is correctly advisory.

**The gap against "verified useful work per legitimate unit of free capacity":**
`resolveAdaptiveTopology()` accepted a `providerCapacity` input — designed to reduce a
parallel plan when observed capacity cannot serve it — but **production never passed it**.
`AutonomousRunOrchestrator.startRun()` called it with only `complexityHint`, so every
production run received `PROVIDER_CAPACITY_UNOBSERVED` and the capacity-aware reduction
was unreachable dead code. Telemetry measured work and capacity; nothing connected live
capacity observations to the topology decision.

## Phase 8 — live capacity feed into topology resolution

- New pure module `packages/server/src/provider-topology-capacity.ts`:
  `buildProviderTopologyCapacity(source, health)` projects `FreeCloudService` capacity
  routes/pools + the route-health authority into
  `{ distinctHealthyProviders, minimumRouteConcurrency, saturatedRoutes }`.
  SATURATED routes count against parallel headroom; hard-excluded routes count as absent;
  live reservation holds subtract from declared concurrency windows.
- `AutonomousRunOrchestrator` gains an optional `providerTopologyCapacity()` option,
  consulted by `resolveAdaptiveTopology` alongside the classifier hint.
- `packages/server/src/index.ts` wires the producer over the shared `freeCloud` +
  route-health authorities — the same projections the fabric decides against.
- Explicit topology requests keep authority: a user-requested `fixed_r1` is never
  reduced by capacity advice (test-proven).

## Phase 9 — paired benchmark

`packages/server/test/r24-topology-efficiency-benchmark.test.ts`

| | Arm A — baseline | Arm B — adaptive + constrained |
|---|---|---|
| Topology | explicit `fixed_r1` | adaptive, capacity `1 provider / concurrency 1` → `normal` |
| Spawned agents | 2 explorers + planner + reviewer (coder via deterministic executor) | 1 explorer + reviewer |
| Fabric admissions | 4 | 2 |
| Max concurrent holds | 2 (parallel explorers) | 1 (serialized) |
| Provider calls | **8** (6 explorer + 1 planner + 1 reviewer) | **4** (3 explorer + 1 reviewer) |
| Scripted tokens | 9,680 | 4,940 |
| Completion | `completed` through `evaluateCompletion` | `completed` through `evaluateCompletion` |
| Leaked reservations | 0 | 0 |

Headline: `providerCallRatio = 2`, `tokenRatio ≈ 1.96` — identical verified outcome
(same goal, same repo state, same scripted correctness, same ForgeVerify command,
same gate) at half the measured provider spend.

### Fixture defects found and fixed (no implementation defect, no weakened gate)

1. **Shared mutable target repo.** Phase 6 integration merges a completed run's change
   back into the target workspace. Running arm B against the same repo meant its
   checkpoint already contained the change — the identical write produced an empty
   diff and the completion gate correctly blocked with `no_effective_change`.
   Fix: each arm gets a fresh repository with identical content.
2. **Polling instrumentation missed real holds.** A 5 ms `setInterval` probe of
   `reservationSnapshot()` read 0 across ~2,400 samples because reservations for
   near-instant scripted calls live for single-digit microtask hops. Fix: synchronous
   `reserve`/`release` wrappers on the injected ledger count exact hold concurrency —
   proving every spawned agent (4 vs 2) ran inside a real fabric reservation.

## Test evidence (this phase)

| Suite | Result |
|---|---|
| `packages/server/test/provider-topology-capacity.test.ts` (new, 6 cases) | 6/6 — projection counts healthy providers, subtracts live holds, treats hard-excluded as absent |
| `packages/server/test/r21-adaptive-topology-wiring.test.ts` (+2) | 10/10 — capacity advice reduces adaptive parallel plan and records it; explicit request wins |
| `packages/server/test/r24-topology-efficiency-benchmark.test.ts` (new) | 1/1 — paired arms complete through the gate; 2× provider-call reduction; reservation lifecycle exact |
| `packages/server/test/free-fabric-wiring.test.ts` | 8/8 (Mission C regression intact) |
| `tsc --noEmit` packages/server | clean |

## Money

$0 spent. Deterministic in-process fixtures only; no provider calls were made.

## Known limitations / open work

- **Mechanism benchmark, not a quality verdict.** The scripted provider returns
  contract-valid output per role, so "same verified outcome" is equal by construction.
  A real planner may improve downstream correctness on genuinely complex work; the
  benchmark measures the topology mechanism's efficiency, not live-model quality
  equivalence.
- **Injected capacity snapshot.** The benchmark arm supplies
  `{ distinctHealthyProviders: 1, minimumRouteConcurrency: 1 }` directly; the live-feed
  path is proven by the `provider-topology-capacity` unit tests and the `index.ts`
  wiring, not end-to-end in this benchmark.
- **Calls and scripted tokens are the measured unit.** Not wall-clock, not real quota
  header consumption — the honest claim is "fewer provider calls at equal verified
  outcome", which is the capacity unit ForgeGreen's window accounting prices.
- Role-specific qualification (Explorer/Planner/Reviewer protocols), full multi-pool
  scenarios, the production-realistic pilot, and the canonical regression pass remain
  open (Phases 10–14).
