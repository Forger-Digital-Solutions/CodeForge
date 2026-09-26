# R37 — Subagent Topology Benchmark (SIMULATED)

## Method

`R20ScaleHarness` (`packages/benchmark/src/r20-scale.ts`, `evidenceClass: "simulated"`
— the harness refuses `production`), 50 virtual users × 2 tasks, burst, one
`subagent` task type (400in/200out, 8 turns, role `coder`). Topology fanout T0/T2/T4
maps to 1/2/4 executions of equal share. All waits are *queue* waits — synthetic,
not provider reality.

## Result A — constrained supply (1 route × 2 concurrency)

| Topology | Completed | Requests | Queue P95 (ms) | Wait events |
|---|---|---|---|---|
| T0 | 100/100 | 100 | 3,760 | 3,920 |
| T2 | 100/100 | 200 | 7,520 | 7,920 |
| T4 | **26/100** | 252 | 9,520 | 10,001 |

Fanout under a single saturated pool turned parallelism into self-congestion:
T4 consumed the same queue as 4× the demand, executions expired at
`MAX_QUEUE_WAIT_EXCEEDED`, and 74% of tasks failed.

## Result B — wide supply (8 providers × 2 concurrency)

| Topology | Completed | Requests | Queue P95 (ms) |
|---|---|---|---|
| T0 | 100/100 | 100 | 400 |
| T2 | 100/100 | 200 | 880 |
| T4 | 100/100 | 400 | 1,840 |

All complete; per-execution latency identical (80 ms). Fanout costs N× requests and
~4.6× aggregate queue wait, buying wall-clock turn parallelism — only a win when
the task *actually* splits into independent work and supply exists to absorb it.

## What the codebase already enforces (VERIFIED, code audit)

- Smallest-topology machinery exists: `TOPOLOGY_FANOUT` bounds fanout, role demand is
  differentiated (`outputDemandForRole`: coder 2048 / planner 1536 / reviewer 1024 —
  writer-sized demand on a reviewer turn is what made 8k-TPM pools unreachable, R34 K).
- Duplicate-work suppression: `duplicate-suppression.ts` (read/search event reuse),
  state-version invalidation, and no-progress escalation in agent-runtime.
- Reviewer/verifier independence is preserved by the task-graph contract —
  `assignedRole` is validated and the completion gate, not the coder's verdict,
  decides completion. Independent verification is *not* deduplicated; only tool-level
  duplicate reads/searches are.

## Conclusions

1. "Smallest effective topology" is the right default: fanout multiplies supply
   consumption, and under scarce free capacity it *reduces* verified completions.
2. Fanout is justified only by genuine work parallelism — the harness models equal
   share, so the real decision input is whether the planner's task graph has ≥2
   independent branches with eligible routes.
3. Reviewer/verifier value is structural (separate role, separate demand, gate
   authority) and must not be traded for tokens.

## Limits

Synthetic: no model-quality variance, no semantic reviewer catches, equal task share
is an optimistic split. Live topology economics = UNRESOLVED.
