# R26 Phase 12 — Subagent Real-Value Benchmark

**Date:** 2026-09-22
**Tests re-run at HEAD:** `subagents.test.ts` (9), `multi-subagent-concurrency.test.ts` (5), `agent-orchestrator-integration.test.ts` (7) — **21/21 green**

## What is proven

- Full production pipeline runs real subagent children: Explorer → Planner →
  Coder → Reviewer → Verification → Integration (21.5s, scripted provider).
- R1 path: **parallel read-only explorers + one durable isolated writer** —
  concurrency without shared write authority (23.5s).
- Planner-phase reservation when explorers exceed the bounded phase ceiling —
  the planner is never starved by exploration.
- Planner graph integrity enforced **before** the Coder starts: cyclic graphs
  and missing dependencies rejected (no wasted coding on an impossible plan).
- Integration blocked when real verification fails despite a structured
  reviewer pass — reviewer verdict cannot override the verifier.
- Reviewer revision loop with structured findings and **private-context
  isolation** — subagents cannot see each other's private context.

## What is not proven — and why (honest boundary)

A *live* subagents-on-vs-off value delta requires the `adaptive` topology arm;
the Phase 5 quota reality check showed ~2 paired runs/day per free Groq route,
and the paired budget was spent measuring the orchestrated ForgeGreen delta.
Subagent live-value measurement is **quota-bound, deferred** to a quota-fresh
window — it is not waived.

The Phase 5 pair does bound the claim from below: the optimized arm's extra
19-call/41k-token orchestration lost to control on a tiny task, so subagent
value is task-size-dependent by construction — the benchmark question is
*where the crossover is*, not whether it exists.

## Verdict

`R26_SUBAGENT_MACHINERY_PROVEN_VALUE_PENDING` — correctness, isolation, and
safety of the subagent topology are green at HEAD; the live cost/benefit
crossover measurement is queued behind free-tier quota (≥1 fresh daily bucket
on a Planner-capable route).

## Carried forward

- **F-R26-S1:** Schedule the adaptive-arm paired benchmark against
  `groq::openai/gpt-oss-120b` after quota reset (00:00 UTC) or an additional
  qualified Planner route; requires ≥99k modelled bucket per the capacity gate.
