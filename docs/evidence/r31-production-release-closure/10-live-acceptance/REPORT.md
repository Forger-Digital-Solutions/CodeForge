# R31 Live Acceptance — Report

## Method

`benchmarks/r31/run-acceptance-batch.ps1` drives
`live-workflow-completion.mjs` sequentially over digest-locked R23/R25
tasks through the real `WorkflowService → WorkflowEngine → AgentRuntime`
path — no mocks, no test providers.

- Route: OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` (verified
  FREE_API, `spillover: NONE`; the harness refuses anything else)
- Bounds: request ceiling 24 (raised to 32 mid-batch after tail-starvation
  was measured), per-response output 4096 tokens, 20-min wall clock,
  disposable workspace per run
- Every attempt writes a receipt; failures are never hidden from the
  summary (`summarize-live.mjs`)
- One run (`qual-js-missing-export`) carried `R31_LIVE_INJECT_429_ONCE` to
  exercise provider-recovery live

## Results — 12 attempts

| Task | Class | Workflow | Hidden verifier | Requests | Classification |
|---|---|---|---|---|---|
| qual-js-off-by-one (attempt 1) | bug_fix | failed | — | 1 | provider output-cap |
| qual-js-off-by-one (pilot) | bug_fix | completed | PASS | 15 | **autonomous pass** |
| js-bug-fix-cart-total | bug_fix | completed | PASS | 24 | **autonomous pass** |
| ts-feature-cli-stats | feature | blocked | FAIL | 24 | correct block — goal review `goal_not_satisfied` (subcommand never wired into cli.ts) |
| ts-refactor-extract-validator | refactor | completed | FAIL 10/12 | 24 | **false success** — wrong `ValidationResult` shape; visible checks were syntax-only; review starved at ceiling |
| ts-large-context-rename-config-key | context-heavy rename | failed | FAIL 7/9 | 24 | honest fail — partial rename, ceiling mid-task |
| js-investigation-webhook-retries | investigation | blocked | PASS | 13 | work correct; route lost mid-run → `verification_not_run` |
| r25-testfix-js-stale-expected | test_repair | completed | PASS | 11 | **autonomous pass** |
| r25-review-js-retry-storm | review_heavy | blocked | PASS | 32 | work correct; ceiling before verify step → `verification_not_run` |
| py-bug-fix-config-merge | bug_fix | cancelled | PASS | 32 | work correct; 20-min wall clock |
| qual-js-missing-export (+429) | bug_fix | completed | PASS | 30 | **autonomous pass** — 429 recovery + post-edit loop continuation exercised live |
| ts-bug-fix-queue-order | bug_fix | blocked | PASS(shallow) | 26 | correct block — goal review found `Promise.all` concurrency the shallow hidden checks missed |

## Score

- Autonomous verified passes: **4/12**
- Correctly refused bad/incomplete work: 2 (goal review) + 1 (honest fail)
- Correct work cut short by bounds/provider: 3
- Provider-side failures: 1
- False success: 1 (residual gap — see below)

R30 baseline was 1/8. Improvement is real and the two inherited defect
classes are demonstrably closed, but the ≥9/10 target is not met.

## What R31 fixes proved live

- `qual-js-missing-export`: injected provider 429 → cooldown recorded →
  recovered → `AGENT_NO_PROGRESS` post-edit → bounded continuation →
  completed → hidden verifier pass. Both headline fixes in one run.
- `ts-feature-cli-stats` / `ts-bug-fix-queue-order`: goal review produced
  `goal_not_satisfied` with file/line evidence, drove `review_rejected`
  through the completion gate → honest `blocked` where R30 would have
  false-completed.

## Residual gaps (truthful)

1. **REVIEW_STARVED false success** — when the request budget is exhausted
   exactly at the tail review (harness cap or, in production, provider
   route loss), the run completes on deterministic checks alone. Advisory-
   on-inconclusive is deliberate: making inconclusive reviews blocking
   would have converted `js-bug-fix-cart-total`'s true pass into a false
   block. The residual is documented, not silently closed.
2. **Bounds dominate non-code failures** — free-provider output caps,
   mid-run route unavailability, and request/wall-clock ceilings account
   for most non-pass outcomes; these are capacity economics, partially
   external, and are reported rather than hidden.
3. **Analysis tasks** declare `visibleVerification: []` — when the route
   dies before the verify phase the gate correctly blocks on
   `verification_not_run` even when the deliverable is right. The
   hidden-verifier pass is external truth the product cannot see.
