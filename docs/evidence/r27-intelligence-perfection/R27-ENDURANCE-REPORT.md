# R27 Endurance Report

Status: `R27_MULTI_STAGE_RECOVERY_AND_BOUNDED_GROWTH_DETERMINISTICALLY_PROVEN`

## Result

Two deterministic matrices passed: 61/61 multi-stage workflow/recovery/retry tests in 101.22
seconds and 18/18 growth/acceptance tests in 79.94 seconds. Together they exercised 181.16
seconds of local test execution. This is stress and recovery evidence, not a claim that CodeForge
has completed unattended hours of real engineering work.

## What the matrix exercised

The primary matrix drives an approval-to-completion workflow through failed verification, bounded
repair, re-verification, review, and the completion gate. It also kills durable workers at real
process boundaries, resumes a two-milestone mission after four different interruption points, and
interrupts a three-workstream synthesis after its first inclusion. Recovery preserves observed
writes, replays only safe unobserved reads, requires a replan for ambiguous side effects, and does
not duplicate already included work.

It additionally proves a same-route retry for a short pinned-route 429 and a retryable tool-output
failure, while a recurring failure terminates instead of retrying forever. Repeated tool actions,
oscillation, and exhausted model/tool budgets likewise end blocked or failed—never completed.

The growth matrix proves that the runtime bounds model turns and tool calls for every tested role,
suppresses duplicate read work with receipts, and limits delivered context for a synthetic
100,000-file / 1,000,000-symbol repository. Sensitive paths and their contents do not reach the
provider request in that fixture. Independent verification and the completion gate still reject
unverified, reviewer-rejected, stale-assumption, and user-overwritten work.

## Boundary

All model responses were scripted and all repositories, worktrees, databases, and verification
commands were local. No paid or live inference was invoked. The test elapsed time is not an
endurance-duration proxy: this report deliberately does not recast a five-minute-scale test run as
hours-long endurance, does not infer live provider reliability, and does not claim live token or
context economics.

An actual endurance claim needs an authorized, checkpointed multi-hour corpus on a free route with
redacted receipts for provider calls/tokens, context bytes, retries, recovery, resource samples,
verification, and the completion-gate verdict.
