# R25 Phase 5–6 Checkpoint — Live Paired Benchmark (Pilot) + Durable Distributed Admission

**Recorded:** 2026-09-21 · **Commit:** `3818d78` · **Protocol:** `r25-live-1.0.0` (`4695e7e1…`)
**Evidence class:** live provider inference (free-tier only) + local real PostgreSQL

---

## Phase 5 — Live paired benchmark (pilot, `single_agent_run`)

Route: `groq::openai/gpt-oss-120b` — probe-gated open (2/2 served probes) after two sibling
routes were correctly refused (`qwen3.8-27b` ITPM 429; `gpt-oss-20b` malformed tool call —
Groq channel-marker leak). Free admission enforced by ForgeZero allowance; live quota
observed via `x-ratelimit` headers.

Campaign: `pilot-2026-09-21T22-59-51-949Z` — stopped by the allowance safety margin, exactly
as designed (daily token bucket reached the guard; remaining pairs voided rather than run
with insufficient budget for a valid comparison).

| Task | Arm | Classification | Calls | Tokens | Wall |
|------|-----|----------------|-------|--------|------|
| r25-ambiguous-js-checkout-discount | optimized | verified_complete | 7 | — | 224 s |
| r25-ambiguous-js-checkout-discount | control | verified_complete | 10 | 21 031 | 129 s |
| r25-ambiguous-ts-session-clock | control | tool_failure | 11 | 24 127 | 134 s |
| r25-ambiguous-ts-session-clock | optimized | verified_complete | 15 | 44 481 | 232 s |
| r25-testfix-js-stale-expected | both | **voided** — allowance below margin | — | — | — |

**What the pilot proves (real, not architectural):**
- A live free-tier model completed real coding tasks end-to-end through ForgeZero admission →
  agent loop → tool execution → hidden verifier → `evaluateCompletion` (`verified_complete`,
  authority PASS) — three times across two tasks and both arms.
- `checkout-discount` produced a **valid paired comparison**: optimized 7 calls vs control 10
  calls on the same task — the optimized arm converged in fewer model calls.
- `session-clock` shows honest asymmetry: optimized verified_complete, control tool_failure —
  recorded, not hidden.
- The allowance gate voided the third pair mid-campaign rather than produce an invalid
  comparison — the capacity guard works under a real shrinking quota window.

Allowance ledger: 988 → 946 requests (42 consumed across probe + 4 runs), daily token bucket
200 000 → 84 387 — the margin that halted the campaign.

## Phase 6 — Durable distributed admission (real PostgreSQL 16.15)

`scripts/r25-durable-admission.mjs` — spawned worker **processes** against shared Postgres,
explicit small pools (max 4) after the R20 harness saturated the server (20 workers × pool-20
> `max_connections`). Verdict: **`DURABLE_ADMISSION_PROVEN`** — `durable-admission.json`.

| Case | Result |
|------|--------|
| A multi-process admission | 8 processes raced 30 queued on capacity 3 → exactly 3 distinct claims across 3 users, zero duplicates |
| B lease expiry + fencing | dead worker's lease expired → row requeued → stale fencing token **rejected** → new worker claimed and completed; receipt chain QUEUE_ENQUEUED→CAPACITY_RESERVED→LEASE_EXPIRED→CAPACITY_RESERVED→CAPACITY_RELEASED |
| C idempotent enqueue | duplicate idempotency key returned the existing execution; one row |
| D dispatching crash | no dispatch-id → `recovery_pending` → requeue **refused** → failed closed; with dispatch-id → requeued → reclaimed at attempt=2 under a new fencing token |
| E per-user fairness | capacity 6, `maxUserConcurrent` 1, 24 queued across 6 users → 6 claims on 6 distinct users (no capture, no dupes) |
| F queue drain | 40 executions claimed+completed exactly once each; queue empty |
| G fair scheduling | capacity 2, 20 executions across 4 users drained round-robin → per-user admissions **5/5/5/5** — no starvation, no capture |

## Phase 7 — Chaos and crash recovery (real process boundaries)

`packages/server/test/run-recovery.test.ts` — 18/18 pass standalone (Windows, 17.4 s). The
suite kills real spawned child processes mid-run and verifies recovery through durable
SQLite journals + tool-execution records:

- **RESUME** — crash before first model call → completes; crash after a real file write →
  completes with **no duplicate write**; crash with an unobserved read-only call → replayed
  **exactly once**.
- **REPLAN** — crash with an unobserved `write_file` or `run_command` converges honestly to
  `converged_failed`; the unobserved side effect is **never re-executed** (verified on disk).
- **FAIL** — a non-terminal worker with no durable journal converges to `failed`.
- Cancelled/terminal workers never resurrect; a killed reviewer resumes and still fails the
  run closed when its verdict blocks.

Combined with Phase 6 case D (post-dispatch worker loss → `recovery_pending` → fail-closed
resolution), the runtime-crash and queue-crash surfaces are both proven.

## Phase 8 — Quota forecast vs observed reality

`scripts/r25-quota-forecast.mjs` replays the pilot's **live-observed** quota headers through
ForgeZero's real `forecastCapacity` engine with a demand profile measured from the actual runs
(≈11 calls / ≈32 k tokens per arm):

- **Product posture:** route ineligible — `MANAGED_MULTI_USER_TERMS_NOT_CLEARED`. Correct:
  owner-plan supply is not managed multi-user capacity; the gate is honest.
- **Terms-cleared physical capacity:** `estimatedTaskUnits = 2` (946 requests / 84 387 daily
  tokens remaining) — matches the allowance gate's actual decision to void the third pair.
  Forecast prediction ↔ observed enforcement agree.
- **Alert recorded:** provider concentration 100 % on a single route (>80 % threshold).
- **Actual pair deltas (honest):** `checkout-discount` optimized −3 calls vs control (30 %
  fewer calls, both verified); `session-clock` optimized +4 calls / +20 354 tokens (control
  truncated by tool_failure). One pair saved quota, one did not — reported as measured.

## Phase 9 — Multi-user fairness

Admission-layer evidence above (cases E + G): concurrent claims isolate per-user capacity,
and sustained contention round-robins perfectly (5/5/5/5). Deeper product-level multi-user
load (concurrent real inference across user accounts) remains out of scope for this
environment — owner-key supply is single-tenant.

One honest operational finding: under concurrent racing a claim can return empty even with
eligible capacity (SKIP LOCKED head-row collision) — dispatchers must loop; the proof's
workers retry up to 5× and all six slots fill.

Environment caveat recorded for reproducibility: the WSL Postgres VM idle-cycled during the
session (localhost forwarding dropped twice); the proof was run with a persistent WSL process
pinning the VM. This is an environment property, not a system-under-test property.

## Status against the R25 question

Execution evidence now covers: live free inference (Phase 3 qualification + Phase 5 pilot),
semantic gate enforcement (Phase 4), and durable multi-process admission/fencing/recovery
(Phase 6). Still outstanding for the full R25 verdict: chaos/crash at the runtime level,
quota-forecast savings, browser/tool product audit, full-stack pilot, and final regression.
