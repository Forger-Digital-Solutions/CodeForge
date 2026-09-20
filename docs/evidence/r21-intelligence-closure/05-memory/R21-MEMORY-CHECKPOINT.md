# R21 Memory Audit + Fixes Checkpoint (M5)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — deterministic tests only; no provider calls.

## What exists (verified, not assumed)

`MissionMemory` in `packages/server/src/mission-state.ts` is a real bounded structured
memory: per-field ceilings, a hard 16 KB serialized cap with deterministic shedding order,
per-milestone `contextRevision` provenance, a `stale` marker, and a written contract that
runtime transcripts never enter it. It persists inside the durable mission detail record
(survives restart — mission-recovery suite proves the record reloads), compactions are
counted and emitted as events, and `mission-security` proves a wave-1 Coder's private
context never reaches memory or any later mission surface.

## Defects found this increment (closed)

| # | Defect | Evidence | Fix |
|---|---|---|---|
| MEM-001 | **`taskPlan` was silently dropped for every non-coder role.** The context assembler's role switch renders `options.taskPlan` only inside `case "coder"`. The supervisor passes serialized mission state to `mission-planner` (intent+memory), `replanner` (intent, plan, evidence, assumptions, memory, trigger), the assumption evaluator, and the final reviewer (acceptance matrix, milestones, verification, contracts); `delivery-service` passes the full delivery analysis to its reviewer. All of it was discarded — those agents received only goal + kernel while their system prompts claimed they could see the plan and trigger. Captured provider request in `mission-acceptance` showed the replanner receiving only "Objective: Mission replan v2…" with no structured state at all. | test failure on the new payload assertion exposed it; direct read of `context/src/index.ts` role switch | `assemble()` now emits `Structured Task State` (UNTRUSTED_DATA-wrapped — fields can carry model-authored text) for any non-coder role that receives `taskPlan`. Coder path unchanged. |
| MEM-002 | **`stale` was marked only on resume, never on in-mission drift.** Milestone summaries captured at a pre-drift `contextRevision` reached a `repository_divergence` replan unlabelled — the flag existed but the only `markMemoryStaleness` call site was the resume path. | `mission-acceptance` drift scenario: durable record asserted `stale === true` only after the fix | `mission-supervisor.ts` marks memory stale against `drift.actual` on any detected drift (REPLAN_REQUIRED and SAFE_ADDITIVE_DRIFT) before the replanner serializes it. |

## Verified guarantees after this increment

- Bounded: 16 KB serialized ceiling, per-field caps, compaction count emitted as an event
  (`mission-state` unit tests + `mission-orchestrator-integration` end-to-end byte check).
- Freshness-labelled: stale marking on resume (existing) **and** on in-mission target drift
  (new); the flag now provably reaches the replanner's request payload.
- Privacy: memory holds public evidence-linked state only; `mission-security` asserts the
  coder-private sentinel never appears in `mission.memory` or any serialized surface —
  including now-delivered task state.
- Durable: rides the mission detail record; restart recovery suites green.
- Authority boundary unchanged: memory is advisory context; replan validity is enforced by
  `validateMilestoneRoadmap` and acceptance by ForgeVerify/`evaluateCompletion` — a stale or
  hostile summary cannot certify anything.

## Known boundary (honest)

- **No cross-mission/cross-session memory exists.** `MissionMemory` is scoped to one
  mission; nothing learns across missions or persists user preferences. That is a *missing
  capability* relative to the "memory-capable" charter headline, not a correctness defect —
  per-mission-only memory is also the privacy-safer default. Recorded as open work rather
  than claimed.
- **Symptom-query retrieval rank weakness** (from M4) is unchanged: memory delivery is now
  correct, but retrieval ordering inside it is only as good as the index.
- `stale` remains advisory-to-the-model (a labelled flag in untrusted JSON). The runtime
  does not mechanically exclude stale claims; acceptance authority stays with verification.

## Test evidence

| Suite | Result |
|---|---|
| `mission-acceptance.test.ts` (drift → stale flag on durable record + replanner payload) | 4/4 |
| `mission-state.test.ts` (compaction ceilings, staleness unit) | 11/11 |
| `mission-security.test.ts` (private context, injection, hostile replanner, self-verification) | 4/4 |
| `mission-steering` / `mission-recovery` / `mission-api` | 4/4, 4/4, 2/2 |
| `subagents`, `delivery-service`, `delivery-certification` | 9/9, 13/13, 14/14 |
| `packages/context` full | 55/55 |
| FG-11/FG-12E provenance canaries | green after `r21-memory-taskstate-delivery-v1` recertification |
