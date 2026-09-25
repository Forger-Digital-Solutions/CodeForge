# R35 Mission C — completion authority audit

## Verdict: `evaluateCompletion` remains the only authority; no bypass found.

### Evidence inventory (existing)

| Claim | Proof |
|---|---|
| Unverified is never success | `completion-gate.test.ts` — no verification → `blocked` |
| Failed verifier → `failed`, never `blocked` | same file + `r21-forgeverify-*` |
| Claims-without-effects → blocked | `r24-admission-vs-completion.test.ts` (coder claims edit, empty diff → blocked, reservations still released) |
| Stale verification bound to workspace hash | `r21-autonomous-completion-binding.test.ts` — edit-after-verify → `verification_not_current` |
| Budget exhaustion → blocked, never success | `r21-agent-budget-honesty.test.ts` (every role), `agent-tool-loop.test.ts` |
| exit-0-with-zero-tests is unverified | `r21-completion-gate-binding.test.ts` |
| Gate is pure/deterministic | `completion-gate.test.ts` |
| Pending approval/question blocks completion | `completion-gate.test.ts:347` |
| Malformed ForgeVerify reports fail closed | `r21-forgeverify-malicious-corpus.test.ts`, `-integrity.test.ts` |
| Concurrency caps, cancel surfaces, secret redaction | `workflow-hardening.test.ts` |
| Crash dedupe across planner/replan | `mission-recovery.test.ts` |

### Engine path audited

`workflow-engine.ts:611-677` — the gate is evaluated against the *real* plan steps
(verify/review steps are recorded terminal with their true outcome before the gate
runs, so an interrupted run cannot masquerade as a finished one). A non-`completed`
decision routes to `blocked`/`failed` phase and emits `workflow.completion_blocked`.

`workflow-service.ts` — the terminal record persists session/turn status only from
`safeResult.status`, emits `run.outcome` last and awaited, and cancels any
outstanding approval so no orphan resolver can admit work after the run died.

### R35 fixes landed in this area

1. **Overclaim string**: a turn that finished without a model final response used
   to persist `"Completed the requested work and verification."` — verification
   that never ran. Now `"Completed the requested work."` (3 sites).
2. **Cancel self-loop**: `cancelled → cancelled` emission fixed; terminal turns
   are no longer rewritable by a late Stop.
3. **Vocabulary leaks**: `task.state_changed` now emits TaskStatus on both sides
   (the `from` was always the *new* raw phase — `setPhase` mutates `task.phase`
   before `onPhaseChange` fires); `session.status` now receives only
   `SessionStatus` values via `sessionStatusForPhase` (was: raw TaskStatus like
   `implementing` written into a zod-enum column behind an `as unknown` cast).

### Residual honesty note

Interactive (non-workflow) turns mark `completed` when the agent loop ends
normally — this is a *turn* completing (a conversational response), not a claimed
work verification; autonomous claimed work always runs through the workflow gate.
Interrupted turns persist `recovering` and replan rather than replay.
