# Agent UX / Permissions — Forensic Baseline

Source of truth: the R15 sterile-profile native smoke (2026-09-18), session
`d838cf47-4d7c-4f8a-abc9-33f39fad2e3c` in
`docs/evidence/r15-native-first-run-free-closure/sterile-profile/codeforge.db`,
plus the captured workspace screenshot (`smoke/11-post-auth-workspace.png`).

## What the smoke actually showed

Task: "Review the failure, fix the underlying issue, and rerun the relevant
verification." on `cf-hostnative-sample`.

Persisted approval work items — exactly two, both `workflow:execute_plan`:

1. `5884182c` — plan approval for the initial run, `allow_once`, 23:48:27.
2. `310e9c14` — **identical plan**, after `Fix and continue`, `allow_once`, 23:48:52.

Transcript rows rendered as conversation items: "Implementing the approved plan"
×2, "Repairing verification failures" ×2, "Approval Implementation plan" ×2.

Terminal failure card: "TASK NEEDS ATTENTION — CodeForge stopped before
verification could finish" + internal workflow summary (plan id, 3/9 steps,
truncated "Implementatio…").

Root of the mid-task stop: `turn.failed` —
`No eligible free route: ForgeAuto/Free has no admitted, healthy route` — the
repair turn after the first verification failure could not get a route, so the
repair loop died at attempt 1 and the completion gate honestly failed the task.

## Root causes (state machine / policy, not styling)

1. **Plan gate conflates plan review with execution permission.**
   `planRequiresApproval` (packages/workflow/src/plan-service.ts:171) fires for
   any plan containing an edit/write step → `askForApproval` in
   workflow-service.ts:649 emits the giant `workflow:execute_plan` card.
   Strategy review and action authority are the same card.

2. **Plan approvals never persist authority.**
   workflow-service.ts:700-717 maps every result to `allow_once` — an
   `allow_session` decision is discarded. No lease/grant applies to the plan
   gate at all, so every new plan asks again.

3. **`Fix and continue` is a brand-new task.**
   `repairFailure` (packages/ui/src/WorkspaceApp.tsx:462) calls
   `handleSend("Review the failure…")` → new workflow run → new plan → new
   `execute_plan` card. Nothing about prior authority carries over — the user
   literally approved the same plan twice.

4. **Tool gate is a hardcoded binary switch.**
   `requiresApproval` (agent-runtime.ts:4192): write/edit → always
   `requires:true`; run_command → `classifyCommand`, which asks for
   `npm run`, `npx`, `vite build`, `tsc` — i.e. normal Tier-1 agent work asks
   permission. No permission mode, no risk tier, no workspace-boundary
   distinction.

5. **Session grants exist but are shallow.**
   `sessionGrants: Set<`${action}@${risk}`>` (agent-runtime.ts:485,4176) —
   session-scoped `write@moderate`/`exec@moderate`, never offered on the plan
   gate, and too coarse to express "npm installs only" or "this directory".

6. **Failure UI is workflow jargon.** `state.workflowError` →
   `humanizeError(workflow summary)` with plan IDs and step counters as the
   primary text.

7. **Transcript is workflow-phase spam.** Turn labels
   ("Implementing the approved plan") and workflow phase events render as
   individual conversation entries instead of grouped activity.

8. **Control duplication.** Header onStop/onPause + WorkflowProgress onCancel +
   Composer onStop + ApprovalBar Deny — overlapping controls with no canonical
   location.

## Architecture being built (AFTER)

- `packages/permissions`: real policy engine — `RiskTier 0-4` classification
  (deterministic, from tool + args + workspace + command classifier),
  `PermissionMode` (auto_review | ask_more | full_autonomy), `PlanMode`
  (auto | review_first), `TaskPermissionLease` (session-scoped grants with
  pattern matching), `resolve()` → ALLOW | AUTO_REVIEW | ASK | DENY +
  `PolicyReceipt`.
- agent-runtime: `executeTool` consults the lease/policy engine instead of the
  binary switch; ASK goes through the existing ApprovalService; `allow_session`
  decisions record task-scoped grant patterns.
- workflow-service: `askForApproval` consults `planMode` — `auto` executes the
  plan with a policy receipt and no card; `review_first` shows a plan-review
  card. Plan approval and action permission become separate concepts.
- UI: compact permission dock (operation + consequence + Allow once /
  Allow pattern for task / Deny / Details), composer permission+plan selectors,
  problem-centric failure card, grouped activity transcript, deduped controls,
  live sidebar.

Invariants preserved: ApprovalService stays the single authoritative gate;
workspace confinement, secret redaction, financial hard stops, destructive/
privileged/credential classification all stay — autonomy grows inside the
bounded envelope only.
