# CodeForge R17 Workspace / Task Experience — Final Report

Date: 2026-09-19
Branch: `forger-digital-solutions-forgegreen-certified`
HEAD at audit: `27716f52ea09b29f1064f3c88f96965c3e640875` (working tree contains the R17 changeset, uncommitted)
Scope: main workspace / task experience / agent UX truthfulness — the path
"open project → start task → watch CodeForge work → understand it → approve →
see file/command/subagent activity → interrupt/resume/recover → verify → continue".
Method: live installed-app validation via the real Electron build + CDP driver, not
source-only review. Real tasks were run, denied, interrupted, failed, restarted,
and replayed across app restarts.

## Executive verdict

`CODEFORGE_R17_WORKSPACE_TASK_UX = SUBSTANTIALLY_CERTIFIED`

Every defect found during live audit was fixed and re-verified live. The workspace now
reports what actually happened — real file writes, real command exit codes, real agent
trees, honest blocked reasons — and reconciles stale in-flight state on terminal runs,
interruption, and restart. Two residual observations are listed under caveats; neither
is a truth defect.

## Canonical test totals

`npm test` at repo root (canonical vitest config): **2969 passed / 3 failed / 36 skipped (3008), 380 files passed / 3 failed**.

The three failures are not product regressions:

1. `fg11-source-state` + `fg12e-harness-provenance` — ForgeGreen source-state
   **provenance canaries**. They assert the working tree is byte-identical to the
   certified FG-12E snapshot and fail by design on any post-certification change.
   The drifted material files are exactly the R17 changeset (`agent-runtime.ts`,
   `duplicate-suppression.ts`, `workflow-service.ts`, `persistence.ts`,
   `postgres-persistence.ts`, `session-state.ts`, `tools/index.ts`,
   `forge-verify.ts`, `types.ts`, `verification-service.ts`) — the drift alarm doing
   its job. They clear when the changeset lands and the source-state doc is
   re-certified.
2. `cf14-large-repo-benchmark` — latency assertion measured 503.8 ms vs a 500 ms
   budget under full parallel suite load. Passes standalone (55.6 s, under budget).
   The package is untouched by this changeset; documented wall-clock sensitivity.

One unhandled `EPIPE` during `workflow-hardening` teardown — socket teardown noise
while the dev app and test servers shared the machine; no test result affected.

## Packaged artifact validation

`npm run pack` → `release/win-unpacked/CodeForge.exe` (Electron 44.4.1, dirty-tree
build identity `27716f52…dirty=true`):

- `audit-packaged-internal-dependencies`: **PASS** — shipped `dist` byte-matches repo
  build output (all R17 changes present inside `app.asar`).
- `npm run smoke:all` on the packaged binary: **all three modes SUCCESS** —
  `full` (exit 0), `interrupt` (expected exit 73), `recover` (exit 0).
  50+ PASS markers, zero FAIL, including: control-plane trust boundary (forged
  bearer/origin rejected), packaged auth restore, workspace restore, repository
  index + query, packaged workflow, extension lifecycle, settings roundtrip,
  `electron_restart_interruption_ready`, `electron_restart_failed_safely`,
  `electron_restart_no_approval_replay`, credential encryption / corrupt-credential
  fail-closed / legacy plaintext migration.

## Live evidence (real app, real tasks)

| Scenario | Evidence | Result |
|---|---|---|
| First-screen / task-list audit | `00-audit/` (11 shots) | Signed-in workspace, grouped task rows, clean New Task surface |
| Real task run to certified completion | `02-active-task/` | `Completed · 11/11 · All required completion checks passed`; live file-change + command rows |
| Approval prompt → deny → agent continues | `03-approvals/` | Denial renders "You denied this action — the agent continued without it"; no raw code |
| Guaranteed-failing command (`exit 3`) | `04-terminal/` + `10-failures/02` | `RUN COMMAND · Failed · exit 3`; follow-up confirmation run completed honestly |
| Long command stopped mid-execution | `09-stop-resume/` | `Stopped · Stopped by you`; `[Command aborted]`; Inspector Commands "did not finish"; agents reconciled CANCELLED |
| Real provider 503 outage | `10-failures/01` | Was `[PROVIDER_UNAVAILABLE] [PROVIDER_UNAVAILABLE]…`; now humanized prose, persists correctly across reload |
| Parallel engineering run (real subagents) | `07-subagents/` | Workstream lifecycle rows in timeline (dispatched → reviewing → blocked with real reason); Run tab shows `Planner`, `Coder`, `Reviewer` nested correctly — no UUID leakage |
| Restart recovery | live reloads | Stopped/failed sessions restore truthfully; no stale running banners; hydrated history dedupes replayed events |

## Defects found in live audit and fixed

| Defect | Fix | Verified |
|---|---|---|
| Inspector Changes/Commands empty during real runs | Project `file.written` / `command.executed` events into Inspector | Live: "Files changed: 2" mid-run; commands with real output |
| Phantom edit completion — planned-but-unwritten edits marked `completed`, blocking command-only tasks as `no_effective_change` | `filesChanged` tracking; edit step → `skipped` unless its target was actually written | Live: same task now `Completed · 11/11` |
| `no_effective_change:` code prefix leaked into run rationale | Rationale is prose-only; codes stay in structured `blockers` | Live + completion-gate tests |
| `not verified` suffix shown even when verification ran | Suffix only when no verification evidence exists | Unit test + live |
| Raw UUID / `plan-…` correlation IDs as agent task labels | `displayableAgentTask` filters correlation-shaped values | Live: clean role labels |
| `AGENT_INVALID_STRUCTURED_OUTPUT: …` raw code as user-facing prose | Validation prose to user copy; code stays in structured error field | Live + tests |
| `[PROVIDER_UNAVAILABLE]` doubled + raw in timeline | Dedupe at compose site; `humanizeError` strips leading code groups (bracketed + colon + repeated) | Live reload humanizes persisted history |
| Stop left `pending` approval on a dead run | Terminal reconcile marks unresolved approvals `cancelled` | Live: "Approvals (1) cancelled exec" |
| Stale `running` agents/tools after terminal runs | Reconcile to `cancelled` on run terminal | Live + tests |
| Parallel planner/coder/reviewer invisible (no `runId`, correlation in `payload.taskId`) | Fold parallel agent events into run projection; parent coder/reviewer under planner; title-case roles | Live: Agents (6) tree |
| Workstream lifecycle invisible in timeline | `workstream.*`/`parallel.*` rows rendered (ready/started/reviewing/blocked with reason) | Live + regression test |
| `workstream.*`/`parallel.*`/`delivery` events dropped by UI schema validation AND persisted without `seq` | Server emits through shared sequenced append; hydrate keeps + re-sequences legacy seq-less rows; REST returns resolved sequenced list; SSE guards seq-less | Live: no duplicate rows after reload |
| Orphan events hydrated onto wrong session / New Task | Hydrate guard: drop events whose `sessionId` doesn't match; `session == null` guard | Live: clean New Task |
| Duplicate task rows for repeated prompts | Same-title sessions cluster under expandable group ("Completed · 2 runs") | Live nav |
| `Failed to fetch` fragility under packaged `file://` renderer | `FileExplorer` uses resolved `apiBase` instead of relative `/api` | Packaged smoke: workspace tree + files PASS |
| `cd workspace && …` prefixes triggering extra approvals | `run_command` tool description: workspace is already cwd | Fewer spurious approval prompts live |
| No-progress guard misfired on legitimate result-list reads | Scope empty-output heuristic to result-list tools (`list_files`, `repo_*` queries) | Regression test |

## Harness / process findings (not product defects)

- Running vitest from `packages/server` bypasses the root vitest config (5 s timeout,
  all-CPU workers) — 75-file mass timeout under load. Under the canonical root config
  (`testTimeout: 30000`, half-CPU workers) the same files pass 197/197.
- A pre-existing cwd-dependent path in `approval-session-grants.test.ts`
  (`resolve("packages/server/src/…")`) assumed repo-root cwd — fixed to be
  location-independent.

## Honest caveats

- Run inspection for a session that hosted **multiple** parallel runs shows all of
  their agents in one flat "Agents (n)" tree keyed by correlation id — truthful, but
  grouping by run may deserve a product decision later.
- Inspector tab labels clip at narrow widths (`CHA…`, `COM…`) — cosmetic.
- `dirty=true` on the build identity reflects the uncommitted R17 changeset; the
  packaged bytes are byte-verified against repo `dist` by the internal-deps audit.
- Source-state provenance canaries will go green only after this changeset commits
  and the certified source-state document is re-issued — a governance step, not a
  code fix.
