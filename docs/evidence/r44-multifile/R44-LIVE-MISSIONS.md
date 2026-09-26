# R44 Live Mission Evidence — Retry Campaign

Continuation of `R44-MULTIFILE-CORPUS.json` (14 arms, all blocked on provider
rate limits). After the corpus, focused retries were run to (a) land at least
one verified live completion and (b) characterize the residual failure modes
with clean per-session journals.

## Result matrix

| Run | File | Task | Topology | Status | Calls | Errors |
|-----|------|------|----------|--------|-------|--------|
| retry-1 | R44-MISSION-RETRY-1.json | distributed-bug | normal (explicit) | blocked | 9 | 3× RATE_LIMITED |
| tiny-1 | R44-MISSION-TINY-1.json | distributed-bug | adaptive → **tiny** | **completed** | 7 | 1× RATE_LIMITED (recovered) |
| retry-2 | R44-MISSION-RETRY-2.json | distributed-bug, fail-repair | normal (explicit) | blocked, blocked | 10, 10 | RATE_LIMITED |
| retry-3 | R44-MISSION-RETRY-3.json | distributed-bug | normal (explicit) | blocked | 14 | RATE_LIMITED + turn limit |

## The completed mission (tiny-1)

`r44-distributed-bug` — a real root-cause task: the failing test points at
`report.mjs` totals, but the defect lives in `normalize.mjs` (dropping negative
amounts so `count` comes out wrong).

- **Topology:** adaptive → `tiny` (Coder + ForgeVerify). Topology decision is
  recorded on the run receipt; the operator hint narrowed the team under a
  tight free-capacity window — the intended use of smallest-useful planning.
- **Status:** `completed` — passed `evaluateCompletion`; `node
  tests/report.test.mjs` exited 0 on the agent's diff.
- **Changed file:** `src/normalize.mjs` — the correct root-cause file.
- **Calls:** 7 model calls, 22,770 in / 565 out tokens, 12.3s wall.
- **Resilience:** one `RATE_LIMITED` failure mid-run; failover
  `cohere/north-mini-code:free → codestral-latest` completed the work.
- **Edit discipline:** the coder's first `edit_file` carried a model-supplied
  `expectedHash` (`hashSupplied: 1`), outcome `success`. The read → hash →
  exact-edit chain works end-to-end on a real free model.
- **ForgeGreen:** run policy `CONSERVATIVE → OFF` via `provider_failover`
  escalation — waste reduction correctly yielded to correctness.

Caveat: the journal list inside `R44-MISSION-TINY-1.json` includes stale
`agent_run_journal` rows from retry-1 (same session id → same leftover sqlite
in tmpdir). The mission verdict fields (`status`, `verification`,
`changedFiles`, `firstEditQuality`) are computed from the authoritative run
result and are unaffected. Harness fixed afterwards: session ids are unique
per attempt.

## What the blocked retries prove

Every blocked arm dies on **provider capacity**, not system defects:

- `supplyBlocked` separation holds; all error kinds are `RATE_LIMITED` (429s).
- Failover rotates across openrouter/groq/mistral correctly; no route is
  parked forever; parked routes recover after health TTL.
- Zero paid fallback; every run is honestly `blocked`, never fake success.

## Residual weaknesses (carried forward, not hidden)

1. **Explorer turn serialization.** retry-3's explorer consumed all 10 model
   turns one tool call at a time (`AGENT_MODEL_TURN_LIMIT`) on a 4-file
   fixture. The R44 prompt nudge (batch independent lookups) did not reach
   this model. Explorer turn efficiency remains the weakest observed link and
   burns the capacity window before the coder starts.
2. **Capacity-window depth.** Observed windows allow ~9–14 calls before 429s
   arrive; a normal topology needs ~15–20. Normal-topology live completion is
   therefore **unproven** at this supply level — demonstrated end-to-end only
   on the tiny plan.
3. **Structured-output rejections persist** on some models (e.g. empty
   `summary`). They are now recorded truthfully (journal `converged_failed`,
   not `completed`) after the stopReason fix.
4. **Natural duplicate suppression:** still not observed live (0 suppressions
   across all R44 arms). Proven deterministically; live evidence outstanding.

## Supply snapshot

64 verified-free routes across openrouter, groq, mistral during the campaign.
~23k input tokens per mission — dominated by repeated context sends, not
reasoning depth (565–1,335 output tokens per run).
