# R48 §3 — Role-Routing Call Graph Audit (deterministic, code-read)

## Turn → model resolution

```
orchestrator.startRun
  └─ subagent-manager.executeAgentRun → runtime.executeAgentRun({ role, roleRouting: r1Enabled })
       ├─ activeSelection = req.modelSelection ?? this.modelSelection          (explicit pin → never rotated)
       └─ if (!activeSelection && roleRouting && hasRoutableFleet())           (8-Bit role path)
            eightBit.selectInitialRoute({ role: eightBitRoleForAgentRole(role) }, {
              routeFilter: roleRouteFilter(role),            // per-role verdict floor — ROUTER PATH ONLY
              capacityScoreAdjustment: freeCloud.capacityRoutingAdvice,
              roleQualityAdjustment: roleQualityAdjustmentFor(role),
              roleQualificationTierFor: roleQualificationTierCallback(role),
              outputTokenDemandFor: roleOutputBudget(per-candidate, reasoning profiles),
            })
              ├─ fabric attached → selectInitialRouteViaFabric → admitThroughFabric
              │     → FABRIC_MODEL_ROLE[role] (EXPLORER→SUBAGENT) → fabric.decide()
              │        → forgeAutoSupplyPlan (roleSuitability / fallbackRoles floor)
              │        → rank: pool-independence → domain → qualified-vs-probation → score
              │        → reservations.reserve() per candidate until one admits
              │     ⚠ routeFilter + roleQualificationTierFor NEVER reach the fabric request —
              │       FabricRequest has no admission-predicate field.
              └─ no fabric → router.selectRoute (routeFilter + tier + quality all apply)
       └─ requestModelTurn loop → modelAdapter.execute({ modelSelection: activeSelection })
            └─ ModelExecutionAdapter.resolveModel
                 ├─ paid-auto pin → paidAuto.runtimeModel (canonical)          [R47]
                 ├─ exact free → ForgeZero.verify (fail closed)
                 └─ adaptive → ForgeRouter + cooldowns
       └─ on provider error → eightBit.handleTurnFailure → fabric re-decide rotate /
          bounded retry_same; pinned selections never rotate
```

## Decision-awareness matrix (as built)

| Layer | Role-aware | Qualification-aware | Health | Capacity | Cost |
|---|---|---|---|---|---|
| Free fabric `decide()` | SUBAGENT coarse (roleSuitability) | **partial** — QUALIFIED/PROBATION projected onto product roles; per-role verdict (EXPLORER≠TOOL_AGENT) lost | yes (authority) | yes (reservations) | no |
| Bare router path | yes (routeFilter per-role verdict) | yes | yes (cooldown) | advisory | no |
| Failover (8-Bit) | same floor as selection | same caveat | yes | atomic re-reserve | no |
| 16-Bit `rank16Bit` | role via task profile | **no floor** — excluded only for context/tools/price | no | no | expected-cost |
| PaidAutoService | none — one canonical per call | route policy quals only | per-route circuits | no pool model | price card per route |

## No-false-waiting (as built)

- Fabric iterates **every** ranked admissible candidate and only returns `QUEUED_FOR_CAPACITY`
  when none could reserve (`plan.hasSupply`, reservation denial set, concurrency cap, or
  health-blocked-only). Structurally correct: an exhausted first choice already yields to the next.
- Parking: `resolveTurnModel` → `FreeCapacityQueued` → durable `free_capacity_wait` item →
  `waiting_for_free_capacity` → `sweepCapacityWaits` re-probes → `resumeTurn` on ADMITTED.
  Subagent runs fail fast on `no_eligible_route` (no parking) — correct per-turn.
- **Gap:** `QUEUED` reasonCodes don't distinguish model-rate-limit vs account-quota vs
  provider-outage vs auth vs policy for callers (the fabric records per-candidate status but the
  parked surface sees a flat list). Per-candidate denial classes exist in `explanation.candidates`.

## Explorer failures — root-cause evidence

R47 qual receipts: all four paid models EXPLORER `NOT_QUALIFIED`, `validToolCallRate` 0.17–0.67,
`reads=0` (except qwen case-2: reads=2, recall=0), `modelCalls=6` (cap), `hallucinatedPaths=[""]`.

**Assembler defect (three sites):** `openrouter.ts`, `openai-compatible.ts`, and
`ModelExecutionAdapter.executeUncached` each track a single in-flight tool call and ignore the
`index` field on `delta.tool_calls`. Parallel tool calls get their second+ names dropped and their
arguments **concatenated into the first call** → `JSON.parse` fails → `malformed` → invalid call.
Modern models batch read/search calls; the mangling explains `validToolCallRate≈1/6`,
`searches=5` executed with empty args, and the empty-path hallucination on a mangled `read_file`.
Groq `gpt-oss-20b` likely qualified because it emits strictly sequential single calls.

**Planner starvation:** probes use flat `maxTokens` (800/900/1200); reasoning-hybrid models
(DeepSeek/Qwen) burn the cap on in-band reasoning (`delta.reasoning` is not surfaced) →
`EMPTY_COMPLETION` → transient → NOT_TESTED. Production `roleOutputBudget` already has
measured-reasoning reserves; the qualification suite and paid routes have none.

## Stream identity

`StreamEvent` has no served-model field; OpenRouter chunks carry `model` — currently dropped.
`ChatResponse.model` exists for non-stream. Gap confirmed.

## ForgeVerify (as built)

`autonomous-orchestrator` line ~949: `runVerification(verificationCwd, verificationCommands, …)`
with `createForgeVerifyPersistenceObserver` — verifier results enter the completion gate input;
`evaluateCompletion` remains the only `completed` authority. Reviewer is a separate child role.

## Paid evidence plumbing (as built)

- Qualification verdicts: `R47-16BIT-QUALIFY-*.json` files only — **no runtime-readable durable
  store** for per-role paid verdicts.
- Spend receipts: durable ledger `paid_evaluation_receipt` (170 rows, $0.021986 committed).
- `PaidAutoService.onTelemetry` records per-route attempt outcomes (circuits close/open there).
