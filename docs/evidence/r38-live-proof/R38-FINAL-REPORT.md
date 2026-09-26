# R38 — Live Free-Intelligence Proof: Final Report

Branch `codex/r29-release-closure`. R38 commits: `f534462`, `e17279b`, `601c3cd`
(plus the two preserved bench-script modifications remain untouched and unstaged).
No paid inference, no push, no deploy, no secret changes.

## 1. What free intelligence was actually available (Gate A — LIVE)

Real catalog refresh against OpenRouter: 1,810 models scanned → **21 verified-free**,
0 errors, ~1.2s. All single-provider (`openrouter/*`); context spans 65k–1M+; 18/21
tool-capable. `opencode` adapter skipped (no credential). Live probes: 3/4 served at
measured $0.00; `qwen3.8-27b:free` catalog-verified but **live 429** — catalog entry
is not schedulable supply, and the fabric treats it accordingly.

## 2. Route changes during the campaign (Gate B)

Second refresh ~1h later: zero churn (no models appeared/disappeared). Churn
*handling* proven deterministically instead — new fabric tests: a 429'd route
re-enters after TTL without restart; a catalog `not_found` route stays excluded
through time alone and re-enters only on `present` evidence.

## 3. Recovery when providers/models failed (Gate E — LIVE)

Real failover chain measured: `qwen3.8-27b:free` → HTTP 429 classified `RATE_LIMITED`
in 413ms → `cohere/north-mini-code:free` served in 296ms → **710ms end-to-end**,
in-process classification ~0ms; all delay is provider round-trip, no artificial
backoff on the measured path.

## 4. False waits (Gate F — LIVE, partial)

No false wait observed live. The live run's only failure (429) was followed by an
alternate route serving successfully. Deterministic suite continues to prove the
full adversarial matrix (sibling model-domain quota, probation fallback, context-fit
escape, health re-entry).

## 5. What ForgeGreen saved (Gate C/D — LIVE, n=1)

Production orchestrator, real free model, scripted file executor:

| Arm | Calls | Input tokens (billed) | Output | Wall | Verdict |
|---|---|---|---|---|---|
| Baseline (levers off) | 14 | 25,814 | 3,378 | 72.3s | completed |
| ForgeGreen (on) | 9 | 15,758 | 1,998 | 57.5s | completed |

Equal verified outcome → **VWM 1.64×** (−36% requests, −39% input tokens, −41%
output). Honest limit: n=1 task/1 model; proves live machinery works, not a
population estimate.

## 6. Equivalent quality (Gate C)

Both arms `completed` with `verificationAttempts: 1` — identical verifier outcome;
the A/B never traded correctness for tokens.

## 7. ForgeVerify cost vs catch value (Gate G — DETERMINISTIC)

14 adversarial defect classes surfaced by the deterministic layer at **0 inference
requests, ~300ms each**; 6/6 honest controls unflagged; model review only when
deterministic evidence is insufficient; `evaluateCompletion` remains sole
completion authority. Live-run comparison: the entire task cost 16–29k input
tokens while the defect-catching layer cost zero.

## 8. Subagents help vs hurt (Gate H — SEMI-LIVE)

`tiny` topology runs completed with **zero** model calls (8.5s) — correct
smallest-topology behavior on a deterministic-fix task. `normal` topology spawned
2 real subagents, 13 real calls, completed. R37's simulation result stands: fanout
hurts under narrow supply; here the selector picked correctly-sized teams.

## 9. Scarce-capacity preservation

R37's `rightFitPenalty` verified; live inventory shows the context spread
(65k–1M+) that preservation logic protects. Live evidence of context-window
routing decisions on real tasks: UNRESOLVED (would need a task forcing >262k
context through the live fabric).

## 10. Estimator accuracy (Gate — partial)

Real billed usage captured per call (`usage.inputTokens`/`outputTokens` from
provider receipts — 13+23 live calls recorded). Calibration against the
`estimatorAccuracy` pipeline needs a larger live corpus before p50/p95 claims;
current evidence populates the measurement path but doesn't yet yield statistics.

## 11. Fabric under quota depletion (Gate I/J — SIMULATED)

Scale sweep: 1/10/50/100 users, 4 routes — 100% completion, zero starvation,
Jain 1.0, linear queue growth. Combined with R37: fanout under one saturated pool
failed 74% of tasks; right-sized topologies complete.

## 12. Remaining unproven

- Live A/B at n>1 and across diverse task sizes
- Estimator p50/p95 under real provider usage (needs corpus)
- Live endurance over quota-depletion cycles
- Context-scarcity routing decisions on a live >256k task
- Multi-provider diversity (all verified supply was one provider this window)

## Regression (Gate L)

Canonical `npm test` (whole workspace, vitest): **3,774 passed / 3 failed / 48
skipped** in 962s; `tsc -b` full build clean. All 3 failures proven environmental
by standalone reruns on the idle machine:

- `cf14-large-repo-benchmark` (120s wall bound): 160s under parallel suite load →
  **85.5s standalone, PASS**
- `fg2-efficiency` large-repo certification (planMs < 2s bound): 2,574ms under
  load → **1,126ms standalone, PASS**
- `r21-forgeverify-malicious-corpus`: **24/24 PASS standalone** (same flake as R37)

48 skips = expected Postgres-environment gates (8 files). These are timing-bound
flakes on a loaded machine, not semantic regressions — the bound values were
already marginal before R38 (67–86s against a 120s line).

## Evidence classes

- LIVE_FREE_PROVIDER: catalog refresh (21 models), probes (3 OK / 1 rate-limited),
  failover chain (710ms), ForgeGreen A/B (VWM 1.64×, n=1), normal-topology run
- DETERMINISTIC: churn re-entry tests (2 new), ForgeVerify economics corpus,
  16-Bit sensitivity (18 tests)
- SIMULATED: scale sweep, topology/fanout economics
- UNRESOLVED: per §12 above

## Defects found and fixed in R38

1. `quotaDomainReason` referenced nonexistent `RouteLedgerEntry.capacityPoolScope`
   — masked by vitest transpile, caught by `tsc -b`. Fixed to `quotaPoolScope`
   (`f534462`). **Lesson: a canonical run must include the typecheck, not just tests.**
