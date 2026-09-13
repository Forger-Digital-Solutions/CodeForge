# CodeForge Desktop UI Contract

Status: **DRAFT — ACTIVATES AFTER R5 CERTIFICATION** (authored 2026-09-13 during the R5 → UX-lock
continuation; based on the audit in `apps/desktop/release/ui-lock-evidence/`). This document becomes
binding when `docs/codeforge-desktop-ux-lock.json` records `CODEFORGE_DESKTOP_AUTONOMOUS_UX_LOCK_CERTIFIED`.

Purpose: stop UI drift. Every agent or person changing the desktop renderer amends THIS contract first
(a short "Contract change" note in the PR/commit), then the code, then the visual fixtures. A change that
is not reflected here is a regression, not a redesign.

## 1. Product identity

CodeForge is a serious, compact, desktop-first autonomous coding agent. Visual identity: black / white /
charcoal / gray, restrained semantic color, technical typography. The 8-Bit activity sprites are the only
illustrative asset family; they appear at 16–20 px inside activity rows and status chips, never as
decoration. No gradients, glow, oversized cards, marketing headlines, emoji glyphs as controls, or
component-local color invention.

## 2. Design tokens (single source: `packages/ui/src/tokens.css`)

Exactly one `:root` block in the application defines tokens. `apps/desktop/src/renderer/styles.css` and
`settings.css` consume tokens and define none. Components never hardcode hex/rgba values, font sizes,
radii, or z-indices; they use the tokens below.

| Group | Tokens |
| --- | --- |
| Surfaces | `--cf-bg-base` (window), `--cf-bg-raised` (sidebar/panels), `--cf-bg-overlay` (menus/dialogs), `--cf-bg-hover`, `--cf-bg-active`, `--cf-bg-input` |
| Text | `--cf-text`, `--cf-text-secondary`, `--cf-text-muted`, `--cf-text-inverse` |
| Lines | `--cf-border`, `--cf-border-subtle`, `--cf-border-strong`, `--cf-focus-ring` |
| Accent | `--cf-accent` (near-white on dark; used for selection/focus/primary action only), `--cf-accent-hover`, `--cf-accent-muted` |
| Semantic | `--cf-success`, `--cf-warning`, `--cf-danger`, `--cf-info`, each with a `-muted` background variant |
| Type | `--cf-font`, `--cf-font-mono`; sizes `--cf-fs-11/12/13/14/16/20`; line heights `--cf-lh-tight (1.25)`, `--cf-lh-body (1.45)` |
| Space | `--cf-sp-1 (2px)`, `-2 (4)`, `-3 (6)`, `-4 (8)`, `-5 (12)`, `-6 (16)`, `-7 (20)`, `-8 (24)`, `-9 (32)` |
| Radius | `--cf-radius-sm (4px)`, `--cf-radius (6px)`, `--cf-radius-lg (8px)` |
| Geometry | `--cf-sidebar-width (260px)`, `--cf-sidebar-collapsed (0)`, `--cf-details-width (340px)`, `--cf-bottom-height (240px)`, `--cf-composer-max (880px)`, `--cf-row-height (28px)` |
| Layers | `--cf-z-panel 10`, `--cf-z-popover 100`, `--cf-z-dialog 200`, `--cf-z-toast 300` |
| Motion | `--cf-motion-fast 120ms`, `--cf-motion-base 180ms`; `prefers-reduced-motion` and the Appearance "reduced motion" setting set both to 0ms and stop pulses/spinners |

States share one recipe everywhere: hover = `--cf-bg-hover`; selected = `--cf-bg-active` + 2px left rule
in `--cf-accent`; focus-visible = 1px `--cf-focus-ring` outline with 2px offset; disabled = 45% opacity,
`cursor: not-allowed`, never removed from the tab order silently.

## 3. Shell

```
┌ sidebar (260) ┬ center ──────────────────────────────┬ details (340, optional) ┐
│ brand · ⌘K    │ task header (32px)                    │ Changes | Files | Plan  │
│ + New task    │ ─────────────────────────────────────  │ | Context | Verify     │
│ Search        │ transcript (virtualized)               │                        │
│ WORKSPACES    │                                        │                        │
│ TASKS         │ approvals / questions (inline)         │                        │
│ …             │ composer                               │                        │
│ account ▾ ⚙   ├────────────────────────────────────────┴────────────────────────┤
│               │ bottom panel (optional): Terminal | Problems | Output | Verify  │
└───────────────┴─────────────────────────────────────────────────────────────────┘
```

* Regions are structurally stable across every task state; only their content changes.
* One chrome row only: the task header. Account, ForgeZero status, and Settings live in the sidebar
  bottom; help lives in the account menu. The window has no application menu bar.
* Sidebar collapse (Ctrl+B) removes the column entirely and exposes a 32px rail with brand, New task,
  Search, Settings. Details (Ctrl+Alt+B) and bottom panel (Ctrl+J) collapse independently; their state
  persists per app.
* Minimum supported window: 960×600. Below 1100px the details panel overlays instead of docking. The
  application never scrolls horizontally; wide content scrolls inside its own container.

## 4. Sidebar

Top: brand mark + "CodeForge" (click = idle workspace), collapse control, search (Ctrl+K).
Primary: `+ New task` (Ctrl+N).
Workspaces: every recent project (name, branch, running-task dot); the active one is selected; a workspace
row exposes Open in Explorer / Remove from recent in its context menu.
Tasks (of the active workspace): grouped Today / Yesterday / Earlier; each row = status dot + title
(single line, ellipsis) + status word + relative time. Status words come from §9 only. Context menu:
Rename, Pin, Delete.
Bottom: account chip (avatar/initial, display name, plan or "Cloud offline · retrying"), Settings,
ForgeZero chip (Verified Free / Discovering / No qualified route / Rate limited until HH:MM).

## 5. Idle workspace

Calm: 8-Bit idle mark (32px), greeting, workspace brief (repository, branch/worktree, tree state, index
summary), favorite models row, six repository-aware starter prompts, composer. Activity overview
renders only when history exists. Nothing else.

## 6. Composer

Multiline textarea (auto-grow to 8 lines), Enter sends, Shift+Enter newline, IME-safe. Left toolbar:
attach (file / image / folder), execution mode (Agent | Chat), approval mode (see §8). Right toolbar:
model picker trigger (canonical name · Free/BYOK badge), send / steer button. Context row above the
textarea: runtime · workspace · branch/worktree chips. While a task runs the placeholder reads
"Keep typing to queue follow-up changes"; a queued steer renders as a "Queued" chip above the textarea
until the runtime acknowledges it (`user_intent_steer.queued` → `…reconciliation_completed`).
Stop (Esc while the textarea is empty, or the Stop button) always targets the running turn.

## 7. Model picker

Sections in order: ForgeAuto/Free · Favorites · Recent · Free coding (qualified first) · Connect
(verified-free routes on providers not yet connected) · BYOK (configured) · GEMS. One row per canonical
model; routes never create rows. Row = name · badge (Free / BYOK / Paid) · readiness word
(Ready = qualified, Awaiting qualification, Rate limited, Unavailable) · star · ⓘ. Filter box focused on
open; ↑↓ move, Enter selects, Esc closes from anywhere inside the picker; outside click closes.
Detail dialog: canonical id, lab/family, status, context, capabilities, 8-Bit qualification, ForgeAuto
eligibility, routes table (provider · access · connection · health · stage). Esc and ✕ close it.

## 8. Approval mode

Modes are presentation over the runtime's existing session-grant mechanism (`${action}@${risk}`):
* **Ask** (default): every write/edit and every non-safe command asks.
* **Auto-approve edits**: the session pre-grants `write@moderate`; commands still ask.
* **Auto-approve edits & safe commands**: pre-grants `write@moderate` and `exec@moderate`; high/critical
  commands still ask.
The active mode shows in the composer and the task header. Approval cards stay inline in the transcript
(operation, target, risk, reason, scope, Allow once / Allow for task / Deny). There is no
"approve all" command.

## 9. Canonical task states

| State word | Source |
| --- | --- |
| Idle | no session / no running turn |
| Thinking | assistant.message.started with no visible text yet, or reasoning block streaming |
| Planning | phase `planning` / `received` |
| Waiting for approval | phase `awaiting_approval` or pendingApprovals.length > 0 |
| Running | phase `implementing` (or agent turn running with tool calls) |
| Testing | a run_command whose command matches a test runner is running |
| Verifying | phase `verifying` / `reviewing`, forgeverify.attempt_started |
| Recovering | phase `repairing`, workflow.repair_attempted, turn.recovery |
| Rate limited | router.failover / turn.failed with 429 semantics, health COOLDOWN |
| Paused | turn.paused |
| Completed | phase `complete`/`completed`, workflow.completion_decided outcome=complete |
| Failed | phase `failed`/`failed_safely`/`blocked`, turn.failed |
| Cancelled | phase `cancelled`, turn.cancelled |

The same word appears in the task header, the transcript's final row, the sidebar task row, and the
close safeguard.

## 10. Activity mapping (transcript)

Every row is built from real session events (`packages/ui/src/timeline.ts`). Display types and their
sources:

| Type | Events | Row |
| --- | --- | --- |
| thinking | assistant.message.started → first text.delta/tool call | `Thinking · 12s` |
| planning | plan.started, workflow.plan_created/plan_revised | `Plan · 5 steps` (expands to steps) |
| explore | consecutive completed read/list/search tools | `Explore · 8 files` (expands) |
| search | search_files, repo_search, repo_symbol, repo_references | `Search · refreshSession · 6 matches` |
| read | read_file, file.read | `Read · src/session.ts · 28 lines` |
| edit / create / delete | edit_file, write_file, file.written, file.change_applied | `Edit · src/session.ts +24 −8` (expands to diff) |
| terminal | command.started/output/completed, command.executed | `Terminal · npm test · exit 1 · 2.3s` (expands to output) |
| test | terminal row whose command matches a test runner; result parsed when recognizable | `Test · 1 failed` / `Test · 24 passed` |
| git | create_checkpoint, checkpoint.created/restored | `Checkpoint · before edits` |
| approval | approval.requested / approval.resolved | inline card while pending; `Approval · write src/x.ts · Allowed` after |
| retry | workflow.repair_attempted, turn.recovery | `Retry · fixing expiration edge case` |
| route | router.selection (first) / router.failover / eightbit.status | `ForgeAuto · Nemotron 3 Super` / `ForgeAuto switched free route` |
| verify | forgeverify.plan_created/attempt_started/evidence_created, workflow.verification_* | `ForgeVerify · Passed` (expands to checks) |
| warning / error | turn.failed, execution.start_failed, tool.execution_failed/blocked | `Error · provider 502 · retrying` |
| completion | workflow.completion_decided, turn.completed | `Completed` / `Blocked · no_effective_change` |

Rows are compact by default; expansion shows command output (cwd, exit code, duration, stdout/stderr),
diffs (+/−, unified with line numbers), search matches, verification checks. Hidden chain-of-thought is
never rendered; a reasoning block shows only a duration and a one-line safe summary.

## 10a. Task header

One 32px row: state dot + state word (§9) · task title (single line, ellipsis, full title on hover) ·
workspace · branch/worktree · model in use (from `router.selection`, e.g. "ForgeAuto · Nemotron 3
Super") · approval mode · elapsed · actions (Pause/Resume, Stop, Details, Terminal). No banner and no
progress bar: phases are words, not percentages.

## 10b. Steering

While a task runs the composer stays enabled with the placeholder "Keep typing to queue follow-up
changes". Send → `user_intent_steer.queued` → a "Queued" chip above the textarea;
`…reconciliation_completed` clears the chip and a `Steer · applied` row appears in the transcript. The
user-intent hold (typing pauses expensive actions) shows as the composer status "Holding for your
input". Stop cancels the running turn only; queued steers are shown as discarded.

## 10c. Verification and completion

ForgeVerify is a first-class transcript row (`ForgeVerify · running` → `ForgeVerify · Passed · 7
passed` / `Failed · 1 failed`), and the Verification panel lists each verifier attempt with status and
evidence. Completion is the transcript's final row, from `workflow.completion_decided`: `Completed` or
`Blocked · <code>` / `Failed`; the same outcome sets the task state word in the header, sidebar and
close dialog. Blocked/failed outcomes show the rationale and offer "Fix and continue" (a real repair
prompt) — never a synthetic success.

## 10d. Web / browser

The runtime has no web-search, fetch, or browser tools today, so the UI renders no web rows and no
browser surface. If such tools are added they map to a `web` display type (query · domain · result
count · status) on the same ActivityRow primitive.

## 11. Panels

Details (right): Changes (modified/created/deleted/renamed with +/−; click opens diff), Files (tree),
Plan (real plan steps with ✓ ● ○ ✕), Context (attached refs, repository intelligence), Verification
(ForgeVerify plan, attempts, evidence). Bottom: Terminal (command history with output, cwd, exit,
duration, copy, clear, stop-turn), Problems (failed tools/commands/tests), Output (runtime notices),
Verification (mirror). Agent-run commands are labelled "agent"; a manual terminal, when the runtime
supports one, is labelled "you".

## 12. Settings information architecture

Account · General · Appearance · Models · Free Cloud / 8-Bit · Providers · Environment Credentials ·
Agent · Permissions · Verification · Privacy / ForgeZero · Tools · Usage · Advanced · About. A section
exists only when it has at least one real, persisted or live control. Every control has a name, a
one-line explanation, its actual current value, validation, and a "restart required" tag where true.
Credentials show variable name, source, enabled, valid — never the value.

## 13. Keyboard

Enter send · Shift+Enter newline · Esc close transient / stop when composer empty · Ctrl+K search ·
Ctrl+Shift+P command palette · Ctrl+N new task · Ctrl+B sidebar · Ctrl+Alt+B details · Ctrl+J bottom
panel · Ctrl+, settings · ↑↓ Enter Esc inside every list/menu · Tab order follows visual order;
focus returns to the trigger when a popover closes.

## 14. Accessibility

Every control is a `<button>`/`<a>`/input with an accessible name; icon-only buttons carry
`aria-label`; menus use `role="menu"`/`menuitem`; lists use `listbox`/`option`; live status uses
`role="status"` with `aria-live="polite"`; dialogs use `role="dialog"` + `aria-modal` + focus trap;
contrast ≥ 4.5:1 for text, ≥ 3:1 for UI glyphs.

## 15. Performance

Transcript rows are windowed (only rows near the viewport mount); command output above 200 lines
renders a tail with "show all"; diffs above 2,000 lines render per-file on demand; event batches apply
in one state update per animation frame.

## 16. Persistence

Persisted: active workspace, recent workspaces, sidebar/details/bottom collapse state, favorite models,
default model, approval mode (per workspace), Settings. Not persisted: popovers, filter text, scroll.

## 17. Visual regression fixtures

`apps/desktop/test/visual/` renders canonical states from recorded real sessions and compares PNGs
(pixelmatch, threshold 0.1, dynamic text masked): empty workspace, populated sidebar, model picker,
approval card, active task, thinking, read, edit, terminal, command failure, retry, ForgeVerify,
completed task, Settings General/Models/Providers/Credentials, collapsed sidebar, narrow window.
