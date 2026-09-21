# R25 Final Checkpoint — Live Reality, Distributed Runtime, Real-World Intelligence

**Recorded:** 2026-09-21 · **Branch:** `forger-digital-solutions-forgegreen-certified`
**Surface version:** `r25-live-reality-v1` (recertified; prior `r24-free-fabric-runtime-v1`)
**Protocol:** `r25-live-1.0.0` · digest `4695e7e1…`

## The question R25 had to answer

> Does this still work when the models, providers, queues, networks, quotas, code changes,
> users, failures, and timing are real?

## Answer — by dimension, with the evidence that backs it

**Real providers & real quotas — YES, bounded.**
Phase 3 qualified 5 free routes live (3 OpenRouter `:free` verified-$0 by catalog price, 3
Groq free-plan). Qualification is *role-specific*: `gpt-oss-120b` qualified coder/planner but
failed explorer; `qwen3.8-27b` qualified five roles. Gemini and Cloudflare inference stayed
skipped — billing state unprovable → fail closed, exactly per §5.
(`live-preflight.json`, `qualification-pass1.json`)

**Real coding work — YES.**
Phase 5 pilot on `groq::gpt-oss-120b`: 3 × `verified_complete` across two tasks and both arms,
through ForgeZero admission → live tool calls → hidden verifier → `evaluateCompletion`.
`checkout-discount` produced a valid pair (optimized 7 calls vs control 10).
(`bench/raw/pilot/`)

**Detecting incorrect solutions — YES.**
Phase 4 added a deterministic semantic diff-review layer — 17 adversarial cases all detected
(hard-coded answers, test-input special-casing, env gates, empty catches, dead branches,
weakened assertions, unreferenced symbols, comment-only), 5 honest controls unflagged, all
flowing through the single `evaluateCompletion` authority as `review_rejected` blockers.
The Phase 5 pilot also recorded a real `tool_failure` honestly rather than hiding it.

**Provider/runtime failure recovery — YES.**
Phase 7: 18/18 real process-boundary crash tests — resume without duplicate writes,
read-only replay exactly-once, unobserved write/command converge REPLAN and never
re-execute, no-journal FAILS closed. Phase 6 case D: post-dispatch worker loss →
`recovery_pending` → requeue refused without dispatch identity (fail closed).
Probe gates closed saturated/malformed routes *before* spending benchmark capacity — twice.

**Durable distributed admission under real contention — YES.**
Phase 6: 7/7 cases on real PostgreSQL 16.15 with spawned worker processes: atomic
multi-process admission (8 racers → 3 claims on capacity 3), lease-expiry fencing, idempotent
enqueue, fail-closed recovery, per-user fairness (6/6 distinct), fair scheduling
(20 executions → 5/5/5/5), and a clean 40-execution drain.
(`durable-admission.json`)

**Quota honesty — YES.**
Phase 8: `forecastCapacity` replayed on live-observed quota correctly excludes owner-plan
supply from managed multi-user posture (`MANAGED_MULTI_USER_TERMS_NOT_CLEARED`), and its
terms-cleared physical estimate (2 task-units remaining) matches the allowance gate's actual
decision to void the third pilot pair. Forecast and enforcement agree.
(`quota-forecast.json`)

**Duplicate work & tool safety — YES.**
Phase 10: 22/22 — duplicate read suppression with provenance replay, bounded no-progress
escalation, mutating tools never suppressible, fresh supervisor per run. Phase 11: 21/21 —
tool loops fail closed, network/Tier-3/MCP-effect tools gated on autonomous runs, secrets
redacted from tool output.

## Honest limits (recorded, not hidden)

- **Supply is the bottleneck.** Free PLANNER-qualified routes are rare; the pilot ran
  `single_agent_run`. Multi-agent live benchmarking awaits supply, not machinery.
- **Efficiency signal is mixed at n=2 pairs.** One pair saved calls (−3), one cost more
  (+4 calls / +20 k tokens after the control's tool_failure truncated it). No savings claim.
- **Owner-key supply ≠ product supply.** Managed multi-user terms are uncleared — correct
  exclusion, and a real product-launch boundary.
- **Serve transport not re-proven live.** Quota forecast (~2 task-units left) made a
  serve-path re-verification poor evidence-per-quota; deferred to a fresh quota window.
- **Environment flake:** WSL Postgres VM idle-cycled repeatedly; the proof ran with a
  VM-pinned process. `forge-verify` process-spawn tests got a 20 s timeout (documented
  Windows boundary, not a policy change).

## Canonical state

`npm test` after the R25 changes: **3491 pass / 2 fail / 48 skip** (Postgres-gated) — the 2
failures were `SOURCE_STATE_DRIFT`, expected while the certified surface still pointed at
R24. Recertification to `r25-live-reality-v1` (adding `diff-review.ts` +
`semantic-diff-review.ts` as material; `types.ts` union widened) was verified by re-running
both drift tests green, and the boundary-flaky `forge-verify` spawn tests now carry a 20 s
timeout. Prior campaign baselines preserved: 25-task frozen corpus
(15 r23 + 10 r25), `r23-task-manifest-1` protocol unchanged.

## Verdict

**R25 LIVE REALITY — EVIDENCED WITHIN BOUNDS.** The system demonstrably works with real
providers, real quotas, real queues, real crashes, real code changes, and real contention —
and it fails closed and honestly where supply or proof runs out. The remaining distance to a
full multi-agent live benchmark is quota and planner-qualified supply, not machinery.
