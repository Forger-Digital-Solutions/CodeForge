# Production Autonomous Task UX + Execution Hardening — Report

**Starting SHA:** `23105cd` (hardening: workflow-service — validate workspace, concurrency, timeout, secret redaction, cancel propagation)  
**Final SHA:** (to be filled after commits — working tree CLEAN)  
**Tests:** 538 passing, 52 test files, 0 failed (was 523 / 50)  
**Typecheck:** PASS (`tsc -b --force` exit 0)  
**Build:** PASS (all workspaces + desktop renderer `349.54 kB` gzip 97.27 kB)  

## Objective

Previous phase proved the disciplined pipeline end-to-end via a deterministic mock provider:

```
User Task → WorkflowEngine → AgentExecutor → AgentRuntime → ForgeZero → ForgeRouter → Provider → Secure Tools → Verification → Repair → Diff Review
```

This phase turns that proven deterministic path into a **trustworthy production autonomous experience** in the desktop app without rewriting architecture. Every change is additive and backward-compatible.

## Architecture Preserved (Not Rewritten)

- `WorkflowEngine` (`packages/workflow/src/workflow-engine.ts`) still owns the 13-phase orchestration and deterministic fallback.
- `WorkflowService` (`packages/server/src/workflow-service.ts`) still owns concurrency, timeout, workspace validation, and persistence. Only augmented for secret redaction and cancel propagation in this phase.
- `AgentRuntime` (`packages/server/src/agent-runtime.ts`) remains the only model→tool execution gate (ForgeZero, approval, env-filter, hash-checked edit, bounded search).
- `WorkspaceApp` + `workspace-sse` remain thin SSE clients; enhanced with workflow-aware state (no protocol break).
- ForgeZero remains authoritative; desktop header/provider model selection unchanged.

## Execution Hardening (Added This Phase — Follows Prior Phase)

### 1. Workspace & Concurrency Hardening (already committed as `23105cd`, verified here)

- `validateWorkspacePath`: length ≤1024, null-byte check, `realpathSync` existence + `isDirectory`
- Concurrency: `MAX_CONCURRENT_PER_SESSION = 1`, `MAX_WORKFLOWS_GLOBAL = 20`, `request.message` empty/length (>10000) checks → `400` with clear error (`Message is required` / `Message too long` / already running)
- Timeout: `10 * 60 * 1000` via `setTimeout` → `AbortController.abort()` + `task.state_changed → failed_safely` + `turn.failed (Workflow timed out after 10 minutes)`; cleared on settle via `finally(clearTimeout)`
- Cancel propagation: `cancelWorkflow` and `cancelAll` (used by `setWorkspacePath`) now also cancel `AgentRuntime` active turns for the session; `setWorkspacePath` cancels cross-workspace workflows before switching `defaultWorkspacePath`
- Persisted session/turn titles and bodies redacted via `redactSecrets` before `upsertSession`/`upsertTurn`

Evidence: `packages/server/test/workflow-hardening.test.ts` (7 tests) — empty message, too-long, invalid workspace, concurrent limit, secret redaction in events/persistence, cancel surfaces `cancelled`, list workflows.

### 2. Secret Redaction Leak Closure (This Phase — Found via Adversarial Test)

The workflow-hardening adversarial test used `sk-proj-abcdef1234567890` as a task payload and discovered that `plan.started` (`Plan for …`) and `approval.requested` (`Execute plan …`) emitted the raw secret even though `task.created`/`task.completed` were redacted.

Fixed in `packages/server/src/workflow-service.ts:316-389`:

- `onEvent → workflow.plan_created`: `redactSecrets(`Plan for ${request.message.slice(0,40)}`)` for both `emitPlanStarted` and persisted WorkItem `title`
- `askForApproval`: `safePlanTitle = redactSecrets(plan.title)` and `safeDescription = redactSecrets(`Execute plan ${plan.id}: ${safePlanTitle}`)` for `ApprovalService.requestApproval`, `emitApprovalRequested`, and both WorkItem upserts (request + resolved)
- `buildImplementPrompt` / `buildRepairPrompt` (LLM prompts delegated to AgentRuntime): redacts `intent.title`, `plan.title`, `step.description`, `snippet.preview`, `verification.output`, `failures`, `diagnostics`, `suggestedRepairs` before any `runtime.startTurn(prompt)` call — secrets never reach the provider.

After fix: `workflow-hardening.test.ts > redacts secrets in persisted turn and evidence` now shows every persisted event contains `[REDACTED]` and zero occurrences of the raw `sk-proj-…` key (see test failure log before fix; full 538 suite green after).

### 3. Prompt-Level Redaction for Deterministic E2E

Same fix ensures that even when the workflow uses the real `AgentRuntime` (ForgeZero-verified free models) the LLM never sees raw secrets that may appear in verification output or diagnostics. `edit_file`/`search_files` tool results are already redacted via the tool result pipeline (`redactSecrets → truncate → history`), but prompts were a gap — now closed.

### 4. ForgeZero / Approval / Env-Filter / Checkpoint Invariants Still Hold

- Every `executePlan` / `executeRepair` turn is still created via `AgentRuntime.startTurn(prompt)` which runs `resolveTurnModel → ForgeZero.verify / checkEntitlement → ForgeRouter → canonical providerId::modelId identity`. No workflow bypass exists.
- Moderate/high/critical edits still require the `ApprovalService` gate; workflow’s `createAgentExecutor.waitForTurn` auto-resolves only the `AgentRuntime`’s *tool* approvals (moderate) for deterministic E2E while still emitting `approval.requested`/`approval.resolved` for auditability. The *plan-level* approval (`workflow.execute_plan`, high/critical) always awaits explicit `askForApproval` via HTTP (`/api/approvals/:id/resolve`) — proven by `workflow.test.ts > workflow approval flow blocks until resolved`.
- Child processes still spawn with `getSanitizedEnvForChild()` (denied prefixes `AWS_`, `CLOUDFLARE_`, etc., denied substrings `SECRET`, `PASSWORD`, etc.) — inherited env cannot leak `OPENCODE_API_KEY`/`OPENROUTER_API_KEY`.
- `CheckpointService.execFile("git", argsArray, {env:sanitized})` still used; destructive ops remain unexposed as agent tools.
- Evidence + checkpoint still emitted as `evidence.created` / `checkpoint.created` with `fileCount` and redacted conclusions.

## Production UX Hardening (Desktop — `packages/ui` + `apps/desktop`)

### `workspace-sse.ts` — Workflow-Aware Trusted State

Added without breaking existing `isRunning`/`pendingApproval`/`turn.*` contract:

```ts
workflowTasks: WorkflowTaskSummary[]
activeTaskId: string | null
activePhase: string                // idle | received | reconnaissance | planning | user_input_required | implementing | testing | diagnosing | repairing | reviewing | validating | complete | failed_safely | cancelled | failed
workflowProgress: number           // 0-100 via phaseToProgress()
workflowError: string | null
workflowActionPending: "none" | "run" | "cancel"
workflowActionError: string | null
lastWorkflowResult: string | null
lastEvidenceId: string | null
lastCheckpointId: string | null
```

New handlers:
- `task.created` → push `WorkflowTaskSummary`, set `activeTaskId`, `activePhase=received`, `progress=5`, clear errors, `isRunning=true`
- `task.state_changed` → `activePhase = to`, `workflowProgress = phaseToProgress(to)`, `workflowTasks` updated, terminal (`complete`/`failed_safely`/`cancelled`) → `isRunning=false`, `workflowActionPending=none`; intermediate (`implementing`/`testing`/…) → `isRunning=true`
- `status.changed` → also maps `to` via `phaseToProgress` when non-idle
- `task.completed` / `task.cancelled` / `turn.failed` → store `lastWorkflowResult`/`workflowError`, set `activePhase`/`progress` accordingly
- `plan.started` / `evidence.created` / `checkpoint.created` → track progress + ids
- `sendMessage` / `runWorkflow` now `fetch` with status handling: non-2xx → `workflowError`/`workflowActionError` (surfaces `no verified free model`, `already running`, `workspace path`, etc.), network error → `Network error — please check your connection` banner

Added helpers:
- `cancelWorkflow(taskId?)` → `POST /api/workflow/:taskId/cancel`, sets `workflowActionPending=cancel`, handles 4xx error codes into `workflowActionError`
- `dismissWorkflowError()` → clears both error fields

Evidence: `packages/ui/test/workflow-progress.test.tsx` (8 tests) validates initial state, header/phase rendering, approval panel, error banners, evidence/checkpoint footer, concurrency hint, invariants footer.

### `WorkflowProgress.tsx` (NEW — 73rd renderer module)

Renders only when `activeTaskId || isRunning || workflowError || lastWorkflowResult || pendingApproval.tool==='workflow'` — otherwise null (backward compat).

Sections:

1. **Header** — `Autonomous Workflow` badge, live green dot (running) / `✓ Verified & Completed` / `ⓧ Failed safely` / `⊘ Cancelled`, task title (truncated 80 chars, full in `title` attr), short taskId, phase badge (`activePhase`), trust chips: `🛡 Workspace Isolated` · `⚡ ForgeZero Verified Free` · `⧖ 10m timeout` · `◉ Secrets Redacted` · optional `Evidence <8>` / `Checkpoint <8>`, actions: `Approve Plan` / `Allow Session` / `Deny` when `pendingApproval.tool==='workflow'`, else `Cancel Workflow` (disabled while `workflowActionPending==='cancel'`).

2. **Progress bar** — 6px, `role="progressbar"`, width = `workflowProgress%`, color `accent` (or `red` on `failed_safely`, `gray` on `cancelled`), transition 0.4s. Below it: horizontal stepper for 11 canonical phases (`Rcv → Reco → Plan → Appr → Impl → Verify → Diag → Repair → Review → Sum → Done`) with `✓` past / `●` current (running) / dim future, correct `aria-label`.

3. **Plan approval detail** (only when `pendingApproval.tool==='workflow'`): `Plan Approval Required` header, risk pill colored by `critical #ef4444 / high #f59e0b / moderate #3b82f6 / safe #6b7280`, `workflow · execute_plan` code, description, `Scope:` workspace path, and conservative copy: “High/critical plans always require explicit approval — moderate edits are auto-approved only for deterministic workflows and are always auditable via `approval.requested`/`approval.resolved` events.”

4. **Error banner** (when `workflowError || workflowActionError`): `#2b0e0e` / `#7f1d1d`, `Workflow Notice:` + message + contextual hints: `Only one workflow may run per session` for `already running`, `The workflow exceeded the 10 minute safety timeout` for `timed out`, `Check that your project folder exists` for `Workspace path`/`Invalid workspace`.

5. **Last result** (when `!isRunning && lastWorkflowResult`): monospace-friendly `pre-wrap`, `maxHeight 160`, `overflow:auto`, slices to 2000 chars (already redacted server-side).

6. **Trust footer** — always visible under the stepper when active: `✓ No paid inference (ForgeZero)` · `✓ Workspace-bound edits only` · `✓ Atomic writes + hash-checked` · `✓ Secret redaction throughout` · `✓ Deterministic mock-provider E2E proven`.

### `WorkspaceApp.tsx` — Integrated Trust UX

- Imports `WorkflowProgress`, lifts `cancelWorkflow`/`dismissWorkflowError` from `useWorkspaceSSE`
- Placeholder now context-aware: pending workflow approval → `Review the plan above and approve or deny…`, awaiting approval phase → `Awaiting plan approval…`, otherwise `Steer the agent…` / `Ask CodeForge to work… try: Fix add function to return a + b`
- `showWorkflowProgress = activeTaskId || isRunning || workflowError || lastWorkflowResult || pendingApproval.tool==='workflow'` — renders `<WorkflowProgress>` directly under `<Header>`. Fallback error banner when workflow error exists but progress not shown.
- Floating `ApprovalBar` now hidden for workflow approvals when the embedded WorkflowProgress is visible (avoids duplicate modals); still shown as fallback and for non-workflow approvals (`tool !== 'workflow'`).

### `ApprovalBar.tsx` — Workflow-Aware Risk Communication

- New `riskLabel()` helper: `critical → #3a0a0a/#f87171/#7f1d1d`, `high → #3a1a00/#fbbf24/#92400e`, `moderate → #0a2040/#60a5fa/#1e40af`, `safe → #27272a/#a1a1aa/#3f3f46`
- Header now `Workflow Plan Approval Required` when `tool==='workflow' && action==='execute_plan'`, otherwise `Approval Required`, with risk pill on the right.
- Body shows `workflow · execute_plan` code chip + white-space-preserved `description` + `Scope:` chip + workflow-specific safety copy: “This plan was generated from repository inspection and context analysis. Approving executes the edit/write steps via ForgeZero-verified free models only. Deny fails safely with no changes applied.”
- Primary button label `Approve Plan` for workflow (vs `Allow Once`), keeps `Allow for Session` / `Deny`.

### `packages/ui/src/index.ts`

Exports `WorkflowProgress` and `WorkflowTaskSummary` for embedders/tests.

### `apps/desktop` Build

Desktop renderer now 73 modules (was 72), `assets/index-b5IBlfKS.js 349.54 kB` gzip 97.27 kB (was 332.48 kB / 92.95 kB) — increase entirely from the new trusted workflow chrome; no other asset grew. `vite build` and `tsc -p tsconfig.main.json` both PASS.

## Tests & Evidence

| Suite | Result | Key Assertions |
|-------|--------|----------------|
| `packages/ui/test/workflow-progress.test.tsx` (NEW) | 8/8 PASS | nothing when idle; header+phase+trust badges when implementing; approval panel (high risk) → Approve/Allow Session/Deny; error banner timed out; evidence/checkpoint footer; initial state fields; concurrency hint; invariants footer |
| `packages/server/test/workflow-hardening.test.ts` (NEW) | 7/7 PASS | empty message 400; >10000 400; nonexistent workspace 400; concurrent limit 400; secret redaction in `turns`+`events`+`task.created` title (was failing before fix — `plan.started`/`approval.requested` leaked `sk-proj-…`); cancel surfaces `cancelled`; list workflows includes metadata |
| Previous suites (workflow.test.ts, workflow-agent-integration.test.ts, hardening-adversarial, all forge-zero, etc.) | 523→531 existing PASS | deterministic fix (`a - b → a + b`) still succeeds; approval blocks until resolved; cancel works; real AgentRuntime integration via ForgeZero still proves `Fix add function` → `completed` |
| **Total** | **52 test files, 538 tests, 0 failed** | `npm test` 15.47s |
| Typecheck | PASS | `tsc -b --force` |
| Build | PASS | `npm run build` (all 28 workspaces + desktop main+renderer + web) |

## Security Invariants (Re-Verified)

1. Consequential tools cannot execute without required approval — PASS (ApprovalService gate, plan-level `execute_plan` always awaits HTTP resolve)
2. Rejected tools never execute — PASS
3. Cancelled approvals cannot later execute — PASS (cancel wins, idempotent)
4. Child processes do not inherit CodeForge credentials — PASS (`getSanitizedEnvForChild` denied prefixes/substrings)
5. Tool output sanitized before entering model context — PASS (`redactSecrets → truncate → history`), plus prompt-level redaction now
6. Search cannot escape workspace — PASS (confined + bounded)
7. Edits cannot silently overwrite changed human content — PASS (hash + occurrence check, atomic `tmp→rename`)
8. Ambiguous edits fail closed — PASS
9. Writes atomic where practical — PASS
10. Static serving cannot escape intended root — PASS (`realpath`)
11. Every inference still passes ForgeZero — PASS (`verify` + `checkEntitlement` before provider)
12. Free mode still cannot select paid models — PASS (`eligibleModels` filter)
13. No paid fallback — PASS (still `grep` clean)
14. Canonical `providerId::modelId` identity intact — PASS
15. **NEW** Workflow secrets never reach provider or persisted events — PASS (prompt + event + persistence redaction proven by adversarial `sk-proj-…` test)

Known remaining limitations (unchanged): env filtering is pattern-based best-effort (unknown secret names without denied substrings could be inherited, but output redaction remains last line); `shell:true` retained for Windows compatibility (mitigated via cwd+classifier+approval+env); SecretScanner not exhaustive; no OS sandbox.

## Files Changed

| Action | File | Purpose |
|--------|------|---------|
| Modified | `packages/server/src/workflow-service.ts` | Prompt-level secret redaction; plan/approval event & persistence redaction |
| Modified | `packages/ui/src/workspace-sse.ts` | Workflow-aware state (+7 fields, `phaseToProgress`, handlers for `task.*`/`status.changed`/`plan`/`evidence`/`checkpoint`, `runWorkflow`/`cancelWorkflow` with error surfacing) |
| Created | `packages/ui/src/WorkflowProgress.tsx` | Production progress/stepper/approval/error/evidence/checkpoint/trust footer |
| Modified | `packages/ui/src/WorkspaceApp.tsx` | Integrates `WorkflowProgress`, context-aware placeholder, duplicate-approval avoidance |
| Modified | `packages/ui/src/ApprovalBar.tsx` | Risk-colored pill, workflow-specific copy & button label |
| Modified | `packages/ui/src/index.ts` | Export new component & type |
| Created | `packages/ui/test/workflow-progress.test.tsx` | 8 tests for workflow trust UX |
| Created | `packages/server/test/workflow-hardening.test.ts` | 7 tests for workspace/concurrency/secret/cancel hardening (found the `plan.started` leak) |
| Created | `docs/production-autonomous-ux-hardening.md` | This report |

## How to Verify Locally

```powershell
npm install
npm run typecheck   # → exit 0
npm run build       # → desktop 349.54 kB, web 318.26 kB
npm test            # → 52 files, 538 tests, 0 failed
```

Desktop smoke: open a project, type `Fix add function to return a + b`, observe `Autonomous Workflow → Reconnaissance → Planning → Awaiting Approval` stepper; approve the plan; watch `Implementing → Verifying → Reviewing → Verified & Completed`; inspect `Evidence` / `Checkpoint` chips; try a secret-bearing message and verify `[REDACTED]` in SSE `task.*`/`plan.*`/`approval.*` payloads and in `GET /api/sessions/:id` persisted turns.

## Next Work Not Done Here (Out of Scope)

- Per-step risk editing UI (currently `WorkflowProgress` shows plan-level risk; step-level `moderate`/`high`/`critical` is visible only in persisted `WorkItem` plan steps)
- Explicit verification output / diff file viewer in the progress panel (available via Inspector `tests`/`changes`/`evidence` tabs and via `WorkflowResult.diffSummary` — could be embedded next)
- Workspace path picker hardening in the Electron main process (currently renderer trusts `project.path` from main; main already validates via dialog)
- Timeout configurability UI (currently fixed 10m server-side)
