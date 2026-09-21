# R24 Phase 10 Checkpoint — Role-Specific Qualification and Role-Aware Routing

Date: 2026-10-06 · Branch: `forger-digital-solutions-forgegreen-certified`
Prior: `31f30ee` (Phase 7–9 — capacity-aware topology, paired 2× benchmark)

## Verdict

**`R24_ROLE_QUALIFICATION_PROVEN`** — qualification is no longer one universal
coding verdict feeding every routing decision. Frozen, versioned role protocols now
measure EXPLORER, PLANNER and REVIEWER fitness as structured evidence; a composed
runner emits one receipt carrying all role verdicts; `qualificationFor` projects them
into route roles; and `FreeFabric.decide()` automatically admits only the route
qualified for the requested role — with live health and capacity able to override
static qualification.

This is a mechanism verdict, not a live-model claim: all evidence is from deterministic
scripted adapters and in-process fixtures. No provider calls were made.

## The gap that existed (measured before changing)

The R10-era qualification layer was real — per-role receipts, SQLite persistence,
staleness — but production wired only `runCompactQualification`, whose `roleResults`
cover CODER / TOOL_AGENT / ANALYST. Consequences:

- `PLANNER` and `REVIEWER` ModelRoles could **never** be earned: the compact suite
  emits no verdicts for them, so `qualificationFor` produced no such route roles, and
  `forgeAutoSupplyPlan(entries, "PLANNER")` found zero eligible routes. Planner and
  reviewer fabric requests had no qualified supply — `DENIED_NO_SUPPLY` by construction.
- `PRIMARY_CODING_AGENT` was granted on `CODER || TOOL_AGENT` — a tool-competent but
  coder-weak model was projected eligible for primary coding work, conflating
  explorer-strong/coder-weak specialization with coder-strong.
- "Capability" was one universal property: three generic probes fed every verdict.

## What changed

### Frozen role protocols — `packages/eight-bit/src/qualification/role-protocols.ts`

Each protocol freezes protocolId/version/task set/acceptance/scoring dimensions/
disqualifiers/tool+mutation policy together; receipts name the version so old evidence
is never reinterpreted under new rules.

- **EXPLORER_PROTOCOL_V1** — 2 cases over `EXPLORER_REPO`, a frozen fixture filesystem.
  The model is offered `list_files/read_file/search_files/edit_file` (the edit tool is
  a deliberate trap). Scored on relevant-files-recalled, read precision, search count,
  hallucinated paths, mutation attempts, valid tool-call rate, answer correctness.
  Acceptance 0.75.
- **PLANNER_PROTOCOL_V1** — 2 cases; structured task-graph output scored on schema
  validity, required roles, dependency order, invented paths (grounded in the
  per-case findings capsule), verification step, scope within budget. An unparseable
  plan is disqualifying — a planner the runtime cannot consume is no planner.
- **REVIEWER_PROTOCOL_V1** — 6 cases of controlled diffs with known verdicts:
  planted critical bugs (approving one is disqualifying), clean diffs (false-positive
  rate is scored, not disqualifying), swallowed failures, reservation leaks, test
  cheats. Scored on schema validity, verdict correctness, finding localization,
  false-positive rate.

### Suite executor + composed runner — `packages/eight-bit/src/qualification/role-suite.ts`

- `runRoleQualification` executes the 10 role cases (2+2+6) with bounded timeouts and
  a single clean-fail retry; provider-side interruptions mark cases inconclusive —
  `transientCases` are reported, never scored as failures.
- `runRoleAwareQualification` is the production runner: compact suite first (answers
  "is this a competent coding agent at all"), then role protocols (answers "which
  roles may it serve"). A transient compact run short-circuits before role probes —
  inconclusive spend stays pending. The overall `qualificationState` now admits a
  route measurably good at **any** served role; the projected route `roles` confine
  it to that work.

### First-class EXPLORER role — `packages/eight-bit/src/types.ts`, `runtime.ts`, `free-fabric.ts`, `route-health-authority.ts`

- `EightBitRole` gains `EXPLORER` with its own `ROLE_CONTRACT` (tools + structured
  output required; minToolReliability 0.6 — read-only tool discipline, not the full
  write-path bar). `eightBitRoleForAgentRole("explorer")` returns it instead of
  aliasing `TOOL_AGENT`.
- `FABRIC_MODEL_ROLE` maps `EXPLORER → SUBAGENT` at the fabric boundary — explorer
  agents execute as subagents over read/search tools.
- `TOOL_DEPENDENT_ROLES` gains `EXPLORER` — malformed tool output bites explorer
  work as hard as tool-agent work.
- **`FabricRequest.healthRole`** (new optional field): explorer requests reach the
  fabric as `SUBAGENT` in the route vocabulary; without the caller's true role the
  health assessment looked up `TOOL_AGENT`-scoped conditions and could never see
  `EXPLORER`-tagged evidence. `admitThroughFabric` now passes the real EightBitRole,
  so role-scoped conditions (`CAPABILITY_LIMITED`, `TOOL_UNRELIABLE` roles lists)
  bind the work that produced them.

### Projection correction — `packages/model-registry/src/free-cloud-registry.ts`

- `PRIMARY_CODING_AGENT` requires `CODER` specifically (was `CODER || TOOL_AGENT`).
- `SUBAGENT` granted by `TOOL_AGENT || EXPLORER`.
- `PLANNER`/`REVIEWER`/`VERIFIER_ASSIST` now producible from role results.

### Service wiring — `packages/model-registry/src/free-cloud-service.ts`

- Default `qualificationRunner` is now `runRoleAwareQualification`.
- **Spend accounting follows the runner.** The daily-budget pre-check previously
  hardcoded 3 requests/cycle. A hardcoded role-suite bound broke every injected
  custom runner; the resolved cost is now `qualificationRequestsPerCycle` —
  explicit option, else the role suite's clean cost (13) for the default runner,
  else the legacy 3 for injected runners. The receipt's reported request count
  reconciles actual spend after the run (symmetric — under-spend is refunded).
- Default `qualificationDailyBudgetPerProvider` 12 → **24**: the role suite's clean
  cost is 13 and retries can reach ~23, so the old default could never admit even
  one suite — the default runner would have been permanently starved.

## Fixture defects found and fixed (no gate weakened)

1. **Reservation-cap collision across independent assertions.** Sequential role
   `decide()` calls in one test held live reservations against the fixture ledger's
   `maxActiveReservationsPerUser: 3`, so the planner request was denied for fairness
   — the intended production behavior, wrong fixture. Fixture cap raised for the
   sequential-assertion scenario.
2. **Health authority constructed with an options object** (`{ now }`) where the
   signature is positional `(policy, now)` — produced `NaN` time →
   `RangeError: Invalid time value` in saturation math. Fixed to the real signature.
3. **Assertion vocabulary drift.** Candidates live under `explanation.candidates`;
   role-mismatched routes report `ROLE_INELIGIBLE`; a saturated route reports
   `STANDBY` (demoted behind the backup, still reachable — health demotes, it does
   not fabricate ineligibility). Assertions corrected to the real contract.
4. **Planner fixture invented a path.** The scripted "valid" plan referenced
   `src/provider/client.ts`, absent from that case's findings capsule — the scorer
   correctly flagged an invented path. The script now grounds plans in each case's
   own findings.
5. **Reject-all reviewer could not be measured.** With one clean case, a
   reject-everything reviewer scored 1 FP in 5 — under the false-positive threshold.
   A second clean case (`reviewer.clean_comment`) makes FP behavior measurable.

## Test evidence (this phase)

| Suite | Result |
|---|---|
| `packages/eight-bit/test/role-qualification.test.ts` (new, 9 cases) | 9/9 — frozen disjoint protocols; explorer evidence incl. hallucination/mutation failure; planner grounding + schema disqualification; reviewer TP/FP + planted-bug disqualification; interruption stays pending; explorer-strong/coder-weak representable; composed receipt merges under `R24_ROLE_QUALIFICATION_V1` |
| `packages/eight-bit/test/r24-role-routing.test.ts` (new, 4 cases) | 4/4 — each role request admits only the route qualified for it (a lower-quality role-matched route beats a higher-quality role-mismatched one); role-mismatched candidates reported `ROLE_INELIGIBLE`; saturated preferred route yields `STANDBY` then recovers after expiry; role-scoped health evidence binds only via the true `healthRole`; a qualified route still loses when its pool cannot serve demand |
| `packages/eight-bit` full suite | 232/232 (+2 skipped postgres) — no regressions from `EXPLORER` enum, `healthRole`, `TOOL_DEPENDENT_ROLES` |
| `packages/model-registry` full suite | 90/90 — including qualification budget/interval, transient-slot, chaos cooldown, and capacity-projection tests under the new runner defaults |
| `packages/server` focused regression | 25/25 — `provider-topology-capacity` 6, `free-fabric-wiring` 8 (Mission C intact), `r21-adaptive-topology-wiring` 10, `r24-topology-efficiency-benchmark` 1 (still 2× provider-call ratio) |
| `npm run build` (workspace) | clean — all packages + desktop + web |

## Money

$0 spent. Deterministic in-process fixtures and scripted adapters only.

## Known limitations / open work

- **No live model has been qualified.** Protocols, scoring, projection and routing
  are proven against scripted adapters; the first real run will produce the first
  real receipts. Fixture difficulty/acceptance thresholds may need a version bump
  after live evidence (`_V2` protocols exist for exactly this).
- **CODER has no dedicated role protocol yet** — it retains the compact suite's
  three probes, which are genuine but generic. A coding-task protocol (like the
  reviewer diff protocol) is the natural next hardening.
- **`qualificationRequestsPerCycle` for injected runners defaults to the legacy 3** —
  honest for compact-shaped runners; custom suites should declare their real cost.
- **The role→fabric mapping compresses EXPLORER into SUBAGENT at the fabric
  boundary.** CapacityRoute roles are the product vocabulary; the runtime's
  `healthRole` pass-through preserves the distinction for health assessment, but the
  supply filter cannot distinguish explorer-qualified from tool-agent-qualified
  routes — both project `SUBAGENT`. If specialization between them ever matters for
  supply, the route role vocabulary needs a new product role.
- Multi-pool scenarios, the production-realistic pilot, and canonical regression
  remain open (Phases 11–14).
