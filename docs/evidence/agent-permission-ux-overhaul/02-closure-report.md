# Autonomous Agent UX, Permissions & Chat Workflow Overhaul — Closure Report

## Scope

The campaign replaced per-operation approvals with trust-boundary authority: routine
reversible workspace work runs autonomously; only meaningful trust-boundary crossings
interrupt. It also removed workflow-protocol spam from the transcript, consolidated
run controls, and made fix-and-continue reuse the same permission lease.

## Defects found in the forensic baseline (01-forensic-baseline.md)

1. `workflow:execute_plan` approval fired twice for the same plan — initial run and again
   after "Fix and continue", because repair re-submitted the task as a new run with no
   authority carry-over.
2. `requiresApproval` was binary: every side-effecting step asked, every session grant was
   unscoped persistence (`allow_once` recorded nothing reusable).
3. Transcript exposed internal turn labels and workflow protocol text.
4. Pause/Stop/Cancel affordances were duplicated across Composer, WorkflowProgress, and
   the header.

## What changed

### Authority model (`packages/permissions`)

- `TaskAuthority` resolves each tool call through a risk-tiered policy: tier-0 reads,
  tier-1 routine workspace writes/tests/diffs, tier-2 unclassified/sensitive commands,
  tier-3 external/shared-state operations, tier-4 destructive.
- Permission modes: `auto_review` (default — tier ≥2 asks), `ask_more` (asks more
  broadly), `full_autonomy` (asks only at hard boundaries).
- `TaskPermissionLease` mints session-scoped grants; `allow_once` re-prompts per
  operation, `allow_session` mints a lease grant that never covers destructive tiers and
  never crosses sessions.
- Reads outside the configured workspace are tier-2; reads inside (or with no configured
  workspace boundary) are tier-0 — fixing an early regression where unconfigured
  workspaces made every read "outside".

### Plan gate (`packages/workflow`, `packages/server`)

- `planMode: "auto"` (default) skips the strategy approval phase entirely;
  `"review_first"` preserves it for plans flagged `requiresApproval`.
- `planGateMode` is wired from the session record through `WorkflowService` into
  `WorkflowEngine`; the authority endpoint `POST /api/sessions/:id/authority` updates
  `permissionMode`/`planMode` and lazily creates the session record.
- Fix-and-continue sends `repair: true`, injects failure context, and reuses the same
  session lease — no second approval cycle.

### UI (`packages/ui`)

- `ApprovalBar` became a compact permission dock: operation-first copy, plan-review
  variant, task-scope button withheld on destructive/external risks.
- Composer carries Agent/Chat + authority controls; Pause/Stop canonicalized to the
  header; the duplicate Cancel in WorkflowProgress removed.
- `timeline.ts` suppresses workflow-origin turn spam and surfaces grouped
  verification/repair/completion activity rows; failures render problem-centric cards.

### Old-contract test migrations

- Tests asserting "every side effect asks" now opt sessions into `ask_more` +
  `review_first` (plan-execution-e2e, workflow.test, workflow-agent-budget,
  cf17-runtime-restart-api, sse-reconnect-e2e, workflow-hardening cap test).
- `approval-session-grants.test.ts` rewritten to lease semantics; its scripted providers
  marked `isTestProvider: true` — they previously routed through the process-global
  `defaultCapacityGovernor`, whose 60 s/60 k-TPM window was exhausted by ~14 scripted
  calls, producing a fake 55 s stall diagnosed as a policy bug.

## Verification

- `packages/permissions`: 21/21 authority-policy tests.
- `plan-gate-authority.test.ts` (new): 4/4 — auto mode emits no approval, review_first
  parks once, dedupe prevents double cards, repair continuation reuses the lease.
- `approval-session-grants.test.ts`: 5/5 — tier-1 auto-allow, lease grant reuse,
  destructive `rm -rf` always prompts and is never covered by a task grant.
- `packages/ui`: 238/238.
- `packages/server` touched files: all green; broad-suite failures classified as
  old-contract tests (fixed), governor contamination (fixed), or parallel-load timeouts
  (each heavy file re-verified green standalone: autonomous-orchestrator 13/13,
  parallel-orchestrator-integration 4/4, agent-orchestrator-integration 7/7,
  delivery-service 13/13, cf17-parallel-scoped-steer 2/2, fg2-runtime-integration 3/3,
  remote-publication 6/6, progress-watchdog, delivery-certification).
- Desktop main + renderer builds clean; desktop test suite 302/302.

## Packaged smoke (native, installed-build class)

`apps/desktop/release/win-unpacked` against a sterile profile:

- `packaged_zero_prompt_workflow=PASS` — routine fix-and-verify completed with exactly
  zero resolved approvals under default authority (waitForTask now counts and asserts).
- `packaged_failure_repair_pass=PASS` — bounded repair traversed inside the same run.
- Interrupt smoke: `electron_restart_interruption_ready=PASS` — under `review_first` the
  plan still parks at the strategy gate, so the escalation boundary is certified in the
  packaged app.
- Recover smoke: `electron_restart_no_approval_replay=PASS`,
  `electron_restart_fresh_task=PASS` — parked approvals never replay; a post-restart
  no-op plan fails closed as `blocked`/`no_effective_change`.
- All three modes: `PACKAGED_FULL_SMOKE_OK`, `PACKAGED_INTERRUPT_EXPECTED_EXIT`,
  `PACKAGED_RECOVERY_SMOKE_OK`.

Evidence: `smoke/packaged-smoke-result.log` (59 PASS markers, zero FAILED).

## Residual notes

- Broad-suite "statement has been finalized" warnings are best-effort persistence writes
  racing test teardown (`emitBestEffort`), observed only under 98-file parallel load.
- `full_autonomy` still prompts at destructive boundaries by design; there is no mode
  that makes `rm -rf` silent.
