# R36 — Recovery & baseline verification

Date: 2026-09-25
Campaign: R36 major UI/UX transformation
Executor: SWE-2 (Devin)

## Repository state (verified)

| Fact | Expected (handoff) | Observed |
|---|---|---|
| Branch | `codex/r29-release-closure` | `codex/r29-release-closure` ✓ |
| HEAD | `a862286` | `a862286484a65fac1db428bafe51336d7232573a` ✓ |
| Working tree | clean | clean (`git status --porcelain` empty; one unrelated pre-existing stash left untouched) |
| R35 commits | present | `8a78175` … `5826311`, final report commit `897340c` ✓ |
| Source-state id | `r35-backend-finalization-interim-v1` / `81cef21f` | recorded in `docs/evidence/r35-backend-finalization/R35-FINAL-REPORT.md` ✓ |
| Canonical baseline | 3730 passed / 0 failed / 48 skipped | recorded in R35 final report; targeted re-verified below |

## R35 documents read

- `docs/evidence/r35-backend-finalization/R35-FINAL-REPORT.md` — scope, defect list, audits, packaged proof.
- `docs/evidence/r35-backend-finalization/R35-UI-CONTRACT-FREEZE.md` — the frontend boundary this
  campaign builds against. All UI work in R36 consumes these contracts; additive-only changes.

## UI contract surface used by R36

- Session lifecycle: `/api/send`, `/api/sessions`, `/api/sessions/:id` (snapshot incl. durable
  events + pending approvals), `/api/sessions/:id/events`, `authority`, `pause|resume|cancel`,
  `steer`, `intent-hold`, `/api/approvals/:id/resolve`, `/api/questions/:id/resolve`.
- Events: `GET /api/events?lastSeq&sessionId` — global monotonic `seq`, replay-safe.
- Workspace: `/api/workspace/set`, `/api/workspace/tree`, `/api/repository-index/*`.
- Models/free supply: `/api/models`, `/api/model-selection`, `/api/providers/:id/health`,
  `/api/free-cloud/*`, `/api/free/top`.
- Statuses: canonical `SessionStatus`/`TurnStatus`; terminal means terminal; parked
  `waiting_for_free_capacity` resumes via the capacity broker.

## Current UI architecture (audited)

- Desktop shell: `apps/desktop/src/renderer/WorkspaceShell.tsx` — top chrome (project, branch,
  live-activity pill, repo-intelligence popover, account menu, ForgeZero trust indicator, help),
  `SettingsApp` overlay, hosts `WorkspaceApp` from `@codeforge/ui`.
- Workspace: `packages/ui/src/WorkspaceApp.tsx` — `Navigation` (left), center column
  (toolbar → `Header` → `WorkflowProgress` → `Conversation` → approval/question bars →
  failure card → `Composer`), `Inspector` (right: changes/run/commands/files/evidence/overview).
- State: `useWorkspaceSSE` (`workspace-sse.ts`) — SSE + snapshot hydration, canonical run
  projection via `deriveRunLifecycle`/`presentRun` (`run-lifecycle.ts`); every visible surface
  already reads the one projection.
- Activity feed: `timeline.ts` events→items; `Conversation.tsx` renders; existing grouping is
  `groupConsecutiveToolActivity` (consecutive same-kind completed calls only).
- Commands: `session-activity.ts` `projectSessionCommands` already joins
  `command.started|output|completed|executed` — but the main timeline ignores the streaming
  variants entirely (only `command.executed` renders), so live commands are invisible in the
  conversation feed.
- Subagents render as two flat `system` rows (`subagent.started`/`completed`); `progress`,
  `lifecycle`, `artifact_written` are dropped.
- Browser tools (`browser_*`) resolve to the generic `Activity` kind; no browser surface exists.
- `eightbit.status` `FREE_CAPACITY_WAIT` drives `WAITING_FOR_CAPACITY` in the lifecycle; the only
  UI is a status word — the `free_capacity_wait` work item's `reasonCodes`/`nextAvailableAt`
  are not surfaced.
- Left-nav "Files" view is a stub ("connect to workspace to browse files").

## Pre-change test baseline (UI package)

`vitest run packages/ui` → **24 files, 325 tests, all green** (5.7 s), 2026-09-25.

## "Before" screenshots

R19/R16 evidence preserved under `docs/evidence/r19-conversation-responsive-ui/` and
`docs/evidence/r16-desktop-product/` — used as the visual baseline for before/after comparison.

## Constraints honored

- No backend contract changes; additive UI work only.
- No pushes; local commits only.
- Unrelated stash (`stash@{0}`) and all user work preserved.
