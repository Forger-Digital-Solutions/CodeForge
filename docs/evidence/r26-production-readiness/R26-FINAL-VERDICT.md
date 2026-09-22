# R26 — Final Evidence Freeze & Release Verdict

**Freeze commit:** `b71d894` · **Date:** 2026-09-22 · **Tree state at freeze: clean**
**Shipped artifact:** `CodeForge-Setup-0.4.0.exe` sha256 `b6a9c038…` / asar `1e4f6d68…` (built from `221226e` tree; `b71d894` adds docs/scripts only — no product-code delta)

> Standard applied: *not* "the architecture supports it" — execution evidence only.

## What is proven (execution evidence, this campaign)

| Claim | Evidence |
|---|---|
| `forge serve` works as a real HTTP runtime — auth, SSE replay, workspace bind, agent tasks via `/api/send`, workflow runs, cancellation, concurrent-lease rejection, health endpoint | `R26-SERVER-E2E.md` — 13/13 checks |
| Production-shaped canary: 8 canaries, 13 invariants — lease exclusivity proven as 409 conflict (1 winner/7 rejected, zero corruption), failure injection poisons route health fail-closed | `R26-CANARY.md` / `canary.json` |
| Live free supply exists: 6 qualified routes, zero spend verified (`usage 0→0`) | `R26-LIVE-MODEL-ROSTER.md` |
| ForgeGreen runs real tasks end-to-end on live free models: 1 valid pair verified_complete both arms; honest negative result — optimized lost on a tiny task (overhead dominates) | `R26-FORGEGREEN-BENCH.md` |
| Completion gate blocks `no_effective_change` in production-shaped runs | pilot voided pair — honest block preserved |
| Multi-user fairness: lease rotates across 10 sessions, no starvation, 20/20 concurrent chat | `scale-fairness.json` |
| Postgres durability under chaos: 20/20 exactly-once through 7 backend-kill rounds — after a real crash fix | `db-chaos.json` + `c17336d` |
| Installed desktop product works on shipped bytes: startup, packaged runtimes, renderer lifecycle, zero-prompt workflow, interrupt/recover, credential encryption, all 5 packaged audits | `R26-DESKTOP-E2E.md` |
| Permission system: risk-tiered, fail-closed on unknown tools, durable approvals | `R26-PERMISSION-AUDIT.md` — 18/18 |
| GitHub surface: narrow publication authority, HMAC-SHA256 webhook, PKCE OAuth, no merge/release power | `R26-GITHUB-AUDIT.md` — 18/18 tests |
| Context/memory correctness + staleness machinery | `R26-CONTEXT-MEMORY.md` — 55/55 |
| Subagent pipeline correctness | `R26-SUBAGENT-VALUE.md` — 21/21 deterministic |
| Semantic verification catches real cheats, passes honest fixes | `R26-SEMANTIC-VERIFICATION.md` — corpus holds |
| Security suites | 40/40 |
| Canonical regression | `R26-REGRESSION.md` — lint 0/0, typecheck+build clean, vitest 3,494 green effective |

## What is NOT proven — stated plainly

1. **Managed multi-user product capacity = 0.** Every owner-pool route fails
   `MANAGED_MULTI_USER_TERMS_NOT_CLEARED`. The product cannot honestly ship "we host the
   fleet" today — see `quota-forecast-r26.json` productPosture and `R26-CAPACITY.md` Posture 1.
2. **373 DAU on the owner pool fails at measured demand.** Physical ceiling ≈ **196
   task-units/day** (token-bound on Groq; R13's 520-unit claim rested on a 14× smaller
   synthetic demand profile, and the R4 script itself is silently broken at HEAD). At 373×1
   task/day the model blocks 196 tasks (47.3% success).
3. **The scaling answer is user-connected accounts** — `:free` capacity scales linearly per
   user (Posture 3: 373 DAU → 73k units). The product scales socially, not on the owner pool.
4. **Planner supply = 1 route** (`qwen3.8-27b`), Explorer = 1 route (`gpt-oss-20b`). One
   provider outage degrades orchestrated planning to unavailable. Free-tier models emit
   schema-valid thin plans — a capability boundary, deliberately not loosened.
5. **No live proof of ForgeGreen net benefit at R26 scale** — the single valid pair showed the
   optimized arm *losing* on a tiny task; the second pair voided on honest blocks/rate limits.
   Efficiency claims rest on R25 evidence + deterministic suites, not a fresh live win.
6. **Subagent live value-delta unmeasured** — quota-bound; deterministic machinery proven only.
7. **Cloudflare Workers AI is qualified-capable but unwired** — `forge serve` never
   instantiates the adapter; its 10k-neuron/day supply is unreachable.
8. **Packaged browser/MCP paths are present but unexercised at runtime** — the dependency
   audit proves they're shipped; no smoke leg invokes them (F-R26-D2).

## Release verdict

`R26_RC_READY_WITH_CONDITIONS`

**Ready** as a *user-connected / single-operator* desktop product: the runtime, gates,
permissions, durability, desktop install path, and security surfaces all hold under
execution-level evidence on the shipped artifact.

**Not ready** to claim: managed multi-user hosting (0 admissible capacity until terms or
user-connected supply), "373 DAU supported" on owner-pool capacity (fails at 47.3%), or a
fresh live ForgeGreen efficiency win (one valid pair, optimized lost).

**Recommended release framing:** single-user desktop with user-connected provider accounts;
treat managed-fleet marketing as blocked pending terms clearance and ≥1 more qualified
Planner+Explorer route.

## Evidence index

All artifacts under `docs/evidence/r26-production-readiness/` — recovery, server-e2e, canary,
roster, forgegreen-bench, scale-fairness, db-chaos, desktop-e2e, permission-audit,
github-audit, context-memory, subagent-value, semantic-verification, release-blockers,
regression, capacity. Raw JSON beside each doc. R25 evidence preserved untouched.
