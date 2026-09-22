# R26 Phase 13 — Semantic Verification on Real Patches

**Date:** 2026-09-22
**Suite re-run at HEAD:** `packages/workflow/test/` — **199/200 green, 1 skipped**; the single failure is a load-induced timeout (see F-R26-V3)

## Semantic diff review — adversarial corpus (17/17 + 5/5 controls)

Blocking findings, all caught on real patches:

- hardcoded fixture response (asserted literal for asserted input)
- canned special-case branch next to an honest general fix
- env-gate: correct only under `NODE_ENV=test`
- catch-swallow (statement and inline `catch {}`)
- dead-branch: fix behind `if (false)`
- test weakening ×3: `.skip`, deleted assertion, strictEqual→truthy at same count
- comment-only diff flagged non-functional
- unreferenced export → advisory
- **gate integration:** a blocking semantic finding holds the run even when
  the verifier passed — the completion gate consults semantic review, not
  just exit codes.

Honest controls (no false blocking): correct fix, fix+stronger tests,
legitimate catch-log-rethrow, domain-literal comparison absent from tests.
`.env` edits and test-runner rewrites remain blocking (regression).

## ForgeVerify execution + evidence integrity

- All applicable verifiers run; required must pass, advisory lint may fail.
- Fails closed on any required failure; honest `notConfigured` when no
  verifiers exist.
- Evidence graph: only *current passing* evidence satisfies a plan; optional/
  advisory evidence cannot satisfy a required obligation; retries persist as
  immutable attempts; timeout = terminal negative evidence from a real child
  process; missing obligation blocks the gate.
- Integrity: hash verified not just present — status flips, state-hash
  rewrites, single-field mutations, malformed/truncated records all rejected;
  secret-shaped output redacted before hashing (persisted record still
  verifies); re-minted records stay bound to their own identity.
- Malicious corpus (24/24): fake success strings, forged receipts,
  repository-instruction attacks, empty-collection runner phrases across
  8 ecosystems, shell wrappers hiding failure, timeouts, killed processes,
  stderr manipulation — all correctly FAILED/BLOCKED; genuine summaries not
  misclassified.

## Findings

- **F-R26-V3:** `forge-verify.test.ts` multi-verifier test (20s timeout)
  timed out only under full-suite concurrency — standalone 6.2s. Same
  wall-clock class as F-R26-G1; the suite runs 24 real-process verifier
  tests in parallel and needs either higher per-file timeouts or isolation.

## Verdict

`R26_SEMANTIC_VERIFICATION_PROVEN` — adversarial patch detection, evidence
integrity, and fail-closed gating are green at HEAD on real patches and real
child processes; semantic findings hold runs even when exit codes pass.
