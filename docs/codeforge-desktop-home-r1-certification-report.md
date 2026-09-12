# CodeForge Desktop Home / Empty Session R1 — Certification Report

## Verdict

**`CODEFORGE_DESKTOP_HOME_R1_BLOCKED`**

Every part of this milestone that can be verified in this sandboxed environment has been implemented, unit-tested, and confirmed live (real server, real compiled renderer bundle, a real browser session) — the empty-state dashboard, the composer context bar, real favorites, and the close-safety *decision logic and its authoritative data source*. Certification is withheld only because the milestone explicitly requires **actual runtime proof, inside real Electron chrome, that minimizing to tray keeps a background agent alive** (§29/§50), and that proof cannot be produced here: this machine's toolchain cannot build an Electron-ABI-compatible native SQLite binding, so the packaged app cannot get past server initialization to reach a running window. This is the identical, pre-existing environment limitation documented in the prior model-picker R1 certification — not a defect introduced by this work. See **Remaining Blockers**.

---

## 1. Repository State

- Branch: `forger-digital-solutions-forgegreen-certified`, HEAD `92df553`.
- Inherited, unrelated uncommitted work preserved and untouched throughout: the ForgeGreen sustainability files (`packages/forge-green/**`, `packages/forgegreen-campaign/**`, `packages/workflow/src/{forge-verify,index,types,verification-service}.ts`, `packages/sessions/src/{persistence,postgres-persistence,session-state}.ts`, `packages/server/src/{autonomous-orchestrator,forge-verify-persistence,workflow-service}.ts`) and the prior **CodeForge Model Picker R1** milestone's own uncommitted changes (`apps/desktop/src/cloud-catalog-sync.ts`, `apps/desktop/src/renderer/model-sections.ts`, its docs, etc.) — this milestone builds directly on top of that R1 work rather than redoing it, per its own instruction not to undo the canonical model architecture.
- No commits were created. No destructive git operations were run.

## 2. Audit Findings (before editing)

- **Empty/new-session state** already existed at `packages/ui/src/Conversation.tsx` (`isEmpty` branch) with a generic "What are we forging?" heading, a **hardcoded, always-disabled** favorites row (`ForgeAuto/Free` / `+ Add favorite` buttons that did nothing), and static suggestion chips. No dashboard/activity/stats component existed anywhere in the repo.
- **Composer** (`packages/ui/src/Composer.tsx`) already had a real Agent/Chat toggle and the canonical `ModelSelector` wired in. It had **no** reasoning/effort control and **no** standing "approval mode" control.
- **No backend concept of a standing "approval mode"** exists: `packages/permissions/src/index.ts`'s `PermissionEngine.evaluate()` is a stub that always returns `"ask"`; `SessionRecord.permissionMode` is defined in the schema but never read or written anywhere in `packages/server/src`. The only real, functioning approval mechanism is the existing per-action `ApprovalBar` (allow_once / allow_session / deny). **No reasoning/effort-level concept exists anywhere** in `@codeforge/providers` or `@codeforge/protocol`.
- **Activity data**: real, persisted `SessionRecord`/`TurnRecord`/`WorkItem` data exists (`@codeforge/sessions`), but **no existing aggregation** — every consumer just filters raw arrays in JS. Token usage is recorded **only** on completed `run_inspection` work items (autonomous agent runs), never on ordinary interactive turns.
- **Git worktree detection**: confirmed to not exist anywhere for a user-opened workspace. `packages/server/src/workspace-service.ts` only tags `kind: "git-worktree"` for worktrees CodeForge itself programmatically creates; a pre-existing worktree the user points CodeForge at was never detected. The desktop's branch display (`WorkspaceShell.tsx`) shelled out to `git rev-parse --abbrev-ref HEAD` via `window.electronAPI.execCommand(...)` — **which did not exist**: `execCommand` was called from the renderer but was never implemented in `preload.ts`/`preload.cjs`/`main.ts`. Git branch/worktree detection was silently non-functional in every real build before this milestone.
- **Close/tray lifecycle was already excellent** — a genuine, working three-way `CloseDialog` (Cancel / Quit / Keep running in tray), a real `Tray` with restore/quit, atomic on-disk close-preference persistence, and an `app:close-decision` handler whose `"tray"` branch never calls `server.stop()`/`app.quit()` (verified by direct code reading). The two real gaps: **no tray active-work indicator**, and **zero automated test coverage** of any of it.

## 3. Empty-State Changes

- **Greeting**: `Conversation.tsx` now renders `What's next, ${userDisplayName}?` when a real signed-in display name is known (sourced from `cloudAccount.user.displayName`, the same field the header/account dialog already use), or `What are we forging next?` otherwise — never a hardcoded name.
- **Favorites**: extracted the favorites store into `packages/ui/src/model-favorites.ts` (localStorage key `codeforge:model-favorites`) so `ModelSelector`'s star toggle and the empty state's favorites row are provably the same data, not two that could drift. The row now renders real favorited models by their real display names and calls the real `onSelectModel`; "+ Add favorite" opens the **same canonical `ModelSelector`** instance the composer uses (see §5), not a second picker.
- Suggestion chips are unchanged in function, visually pushed below the new Overview card and favorites row.

## 4. Activity Overview

**Data source**: `GET /api/activity/overview?period=all|30d|7d`, new endpoint in `packages/server/src/index.ts`, backed by a new pure, unit-tested module `packages/server/src/activity-overview.ts`. It reuses only existing persisted data (`listSessions()`, per-session `getTurns()`, `getWorkItemsByKind("run_inspection")`) — no new tracking was added. Raw session/turn data is cached in-process for 15s so repeated polls don't re-scan SQLite.

**Exact metric definitions** (also documented as a doc-comment in the source):
- **Tasks** = sessions whose `updatedAt` falls in the selected period.
- **Messages** = total `TurnRecord` count across those sessions (a session counts as a whole toward the period it was last active in — a documented simplification, not per-turn timestamp filtering).
- **Tokens** = sum of `run_inspection.usage.totalTokens` for those sessions — labeled "Tokens (agent runs)" in the UI because token accounting only exists for completed autonomous runs, never for ordinary chat turns. This is stated explicitly rather than implying a total across every message.
- **Active days** = distinct calendar dates derived from each turn's `completedAt ?? startedAt` (falling back to the session's `updatedAt`), within the period.
- **Current streak** and the **heatmap** are always computed over the account's full lifetime activity, deliberately **independent of the period filter** (a streak should not visibly reset because someone clicked "7d") — confirmed identical across periods in `activity-overview.test.ts`.
- **Most-used model**: the mode of `run_inspection.provider.modelId` (most accurate — one entry per completed agent run, `source: "agent-run"`) with a documented fallback to the mode of `session.currentModelId` (`source: "session-selection"`) when no agent-run data exists yet. Never invented: with zero history, `mostUsedModel` is `null` and the UI shows a truthful empty state instead of a zeroed grid (`hasAnyHistory: false`).
- **Heatmap**: one cell per day for a fixed trailing 365-day window, intensity bucketed 0 (none) / 1 (1–2) / 2 (3–5) / 3 (6+) messages that day — a documented, arbitrary-but-stated bucketing, not a copy of GitHub's exact scheme.

`packages/ui/src/ActivityOverview.tsx` renders exactly six metrics (Tasks, Messages, Tokens, Active days, Streak, Most-used model) plus the heatmap and an All/30d/7d filter — matching the milestone's "roughly six metrics" target.

## 5. Composer / Context Bar

New `packages/ui/src/ContextBar.tsx`, rendered in `WorkspaceApp.tsx` directly above the composer, showing exactly the chips the workspace actually has:
- **Runtime**: `Auto` / `Hosted` / `Direct (BYOK)` — derived in `apps/desktop/src/renderer/model-sections.ts`'s new `resolveRuntimeLabel()` from the real selected model's `providerId`/`tier` (never a made-up label; unit-tested for ForgeAuto, CodeForge-Cloud, GEMS, and BYOK cases).
- **Workspace**: the real project name, with the full filesystem path in a tooltip.
- **Branch**: from a single new canonical source, `apps/desktop/src/renderer/git-workspace-info.ts`'s `classifyGitWorkspace()` — one `git rev-parse --abbrev-ref HEAD --git-dir --git-common-dir` invocation. A non-git directory renders no branch chip at all (no bogus branch); a detached HEAD renders "detached HEAD" truthfully instead of a raw ref.
- **Worktree**: derived from the *same* git call — a linked worktree is detected by `--git-dir` and `--git-common-dir` resolving to different paths (the standard mechanism `git worktree` itself relies on), not a name heuristic. Shown only when actually true.
- The desktop header's own branch display was switched to read from this same `gitInfo` object, so the header and the composer context bar can no longer disagree (§47's "one canonical source" requirement).

**A real, pre-existing bug found and fixed while building this**: `window.electronAPI.execCommand` was called from the renderer but had never been implemented in `preload.ts`/`preload.cjs`/`main.ts` — branch/worktree detection could not have worked in any real build before this milestone. Implemented as a tightly allowlisted IPC bridge (`shell:execCommand`, `main.ts`) that only accepts `command: "git"` with a string-array `args` and validates the sender is the app's own window — not a general command-execution channel across the renderer/main boundary.

**Reasoning/effort and "approval mode" controls were deliberately NOT added.** Per the audit in §2, no backend concept of either exists in this codebase. Inventing a UI control with no real backend behind it is exactly what the milestone's own instructions (§21/§22) forbid ("do not invent backend behavior just for the UI"). This is a considered scope decision, not an oversight.

## 6. Model Integration

Confirmed unchanged and reused: the empty-state's favorites row and its "+ Add favorite" button drive the **same** `ModelSelector` instance the composer already uses. Making that literally true (not just visually similar) required a small, additive fix to `ModelSelector.tsx`: it previously accepted a controlled `isOpen` prop only as an untested seam (its internal close paths — Escape, outside-click, selecting a model — always mutated internal state regardless, which would have made a truly externally-driven open state unclosable). Added `onOpenChange` and a unified `setOpen()` helper so external control is now bidirectional and real; verified live in the browser (see §9) — clicking "+ Add favorite" opens the exact same catalog (Recommended / CodeForge Free / GEMS), selecting or favoriting a model there updates the same underlying state the composer reads.

## 7. Close Protection

- **Active-work detection**: unchanged, already authoritative (`CodeForgeServer.getRuntimeStatus()`). Proven accurate with a **real server, no mocks**, in `packages/server/test/close-safety-runtime-status.test.ts`: a genuinely running local `command` WorkItem makes `activeWork: true` and `recoverable: false`, and clearing it returns the server to idle.
- **Decision logic extracted and exhaustively tested**: `apps/desktop/src/close-lifecycle.ts`'s `resolveCloseAction(status, behavior)` is the pure policy `requestClose()` now delegates to (behavior-preserving refactor, verified by manual truth-table comparison against the original nested-if code). `close-lifecycle.test.ts` covers all nine `(activeWork/recoverable) × behavior` combinations, explicitly asserting the critical safety property: **an unrecoverable state always resolves to "ask", regardless of any remembered preference** — a remembered "tray" or "quit-safe" choice can never silently discard work CodeForge cannot safely preserve.
- **Modal behavior**: unchanged (`CloseDialog.tsx` already implemented Cancel / Quit(-anyway) / Keep running in tray correctly, including the unrecoverable-race re-prompt). Its activity-summary text now comes from the same shared `summarizeActiveWork()` the tray tooltip uses, so the two surfaces can never describe active work differently.
- **Tray active-work indicator (new)**: `main.ts`'s tray now shows `"CodeForge — 1 workflow · 2 agent turns"`-style tooltips whenever real work is running (`countRunningWork()` deliberately excludes pending approvals — something waiting on the user isn't "running"), refreshed every 15s while the tray exists, and reset to plain `"CodeForge"` when idle.
- **Persisted preference**: unchanged, already correct (`"ask" | "tray" | "quit-safe"`, written only when the user explicitly checks "remember" **and** the dialog is offering a recoverable choice — never from the unrecoverable branch).

## 8. Background Agent Proof

**Could not be produced inside real Electron chrome in this environment** — see Remaining Blockers. What **was** proven with real, non-mocked components:
- The real `CodeForgeServer.getRuntimeStatus()` accurately reflects a genuinely active task and accurately reflects it completing (§7, real SQLite-backed persistence, no Electron).
- Direct code reading confirms the `"tray"` decision path in both `requestClose()` and the `app:close-decision` IPC handler never calls `server.stop()` or `app.quit()` — only `hideToTray()` (window hide + tray creation). The process and the embedded server are structurally never touched by that path.
- The packaged app **does** reach `WHEN_READY_WINDOW_CREATED` (window created, renderer bundle loaded) before failing at server initialization for the pre-existing native-module reason — so the Electron shell itself is not the blocker; the local persistence layer is.

No claim of "the agent kept running after minimizing" is made, because it was not directly observed inside a live packaged window. Stating otherwise would be exactly the kind of unverified claim §26 forbids.

## 9. Live UI Verification (real bundle, real server)

Same method as the prior model-picker milestone (a known project anti-pattern is a `qa.html` mock that hides real bugs — avoided): the actual `npm run build` output was served and driven in a real browser session against a real `CodeForgeServer` instance seeded with real session/turn/`run_inspection` history.

**Confirmed by direct observation:**
- Empty state: neutral greeting ("What are we forging next?" — no display name in this signed-out session), real Overview card — `Tasks 9, Messages 27, Tokens (agent runs) 37.5K, Active days 7, Streak 3d, Most-used model "Nemotron 70B Instr…"` (correctly resolved from raw model id to display name), 365-day heatmap rendered.
- **Time filter works live**: clicking "7d" recomputed Tasks→7, Messages→20, Tokens→24K, Active days→5, while Streak (3d) and the heatmap stayed identical — exactly the documented period-independence.
- **Context bar renders all four real chips**: `Auto → Hosted` (updated live after selecting a concrete model), `CodeForge (verify)`, `feat/desktop-home-r1`, and `worktree` (from a simulated `git rev-parse` worktree response) — and the header's own branch/worktree badge matched it.
- **Favorites end-to-end, live**: clicking "+ Add favorite" opened the identical canonical picker (Recommended / CodeForge Free / GEMS sections, search box auto-focused); starring "Nemotron 70B Instruct" and closing the picker made it appear as a real chip in the empty state's "Favorite models" row — proving the shared-favorites-store fix in §6 works in a real browser, not just in a snapshot test.
- Sidebar correctly listed the seeded session history grouped by Today / Yesterday / Previous 7 Days / Older — confirming the new seeded data didn't break any existing, untouched feature.

All scratch verification servers/files were stopped and deleted; nothing was committed.

## 10. A Bug Caught Mid-Session, Fixed, and Worth Recording

While packaging for the close/tray runtime attempt, the user observed a live crash: `Cannot find module '...\close-lifecycle.js'`. Root cause: `close-lifecycle.ts` had been placed under `src/renderer/` so `CloseDialog.tsx` (a renderer-tsconfig file) could import it — but `vite build` (the renderer bundler) empties its entire output directory (`dist/renderer/`) on every run, and `tsc`'s main-process build had put `close-lifecycle.js` in that same directory (mirroring the source layout). Any renderer-only rebuild after the main build silently deleted the main process's compiled file. Fixed by moving `close-lifecycle.ts` back to `src/` (sibling to `main.ts`, matching `cloud-catalog-sync.ts`'s already-working location), updating both consumers' import paths, and adding it to the renderer tsconfig's `include` list purely so `tsc --noEmit` typechecking stays clean (Vite's actual bundling does not care about `tsconfig.json`'s `include`, so this had no effect on runtime behavior). Rebuilt clean, repackaged, and confirmed via the smoke harness that the app now progresses to the same (pre-existing, unrelated) native-module blocker as before, no further.

## 11. Files Changed

```
apps/desktop/src/main.ts                         (close-lifecycle wiring, execCommand + runtime-status IPC, tray indicator)
apps/desktop/src/preload.ts, preload.cjs         (execCommand, getRuntimeStatus — kept in sync, checked by existing test)
apps/desktop/src/close-lifecycle.ts               (new — resolveCloseAction, summarizeActiveWork, countRunningWork)
apps/desktop/src/renderer/git-workspace-info.ts   (new — classifyGitWorkspace)
apps/desktop/src/renderer/model-sections.ts       (+resolveRuntimeLabel; from prior R1 milestone)
apps/desktop/src/renderer/CloseDialog.tsx         (uses shared summarizeActiveWork)
apps/desktop/src/renderer/WorkspaceShell.tsx      (gitInfo, activity overview wiring, runtime label, userDisplayName)
apps/desktop/tsconfig.json                        (include close-lifecycle.ts for typecheck convenience only)
packages/server/src/activity-overview.ts          (new — pure, documented metric computation)
packages/server/src/index.ts                      (GET /api/activity/overview + 15s cache)
packages/ui/src/ActivityOverview.tsx              (new)
packages/ui/src/ContextBar.tsx                    (new)
packages/ui/src/model-favorites.ts                (new — shared favorites store)
packages/ui/src/ModelSelector.tsx                 (onOpenChange controlled-mode fix; uses shared favorites store)
packages/ui/src/Composer.tsx                      (isModelPickerOpen / onModelPickerOpenChange passthrough)
packages/ui/src/Conversation.tsx                  (greeting, activity overview, real favorites)
packages/ui/src/WorkspaceApp.tsx                  (all new state/wiring, ContextBar render)
packages/ui/src/workspace.css                     (activity overview, context bar, heatmap styles)

Tests (new): apps/desktop/test/{close-lifecycle,git-workspace-info}.test.ts,
             packages/server/test/{activity-overview,close-safety-runtime-status}.test.ts,
             packages/ui/test/empty-state-dashboard.test.tsx
Tests (extended): apps/desktop/test/model-sections.test.ts (+resolveRuntimeLabel),
                   packages/ui/test/model-selector.test.tsx (+stale-selection, +controlled-open)
```

## 12. Tests Executed

```
apps/desktop/test + packages/ui/test   34 files, 362 tests — PASS
packages/server/test (full suite)      86 files, 487 passed + 3 skipped (no local Postgres — pre-existing, expected) — PASS
```
53 new test cases added this milestone across 5 new files plus 2 extended files. `npx tsc --noEmit`/`-b --force` clean on `packages/ui`, `apps/desktop` main and renderer, and `packages/server` after every change.

## 13. Build / Package Result

- `npm run build` (tsc + vite): **PASS**.
- `npm run build:native`: **FAIL** — same pre-existing Visual Studio 2026 / node-gyp incompatibility as the prior milestone (unrelated to this work; this milestone touches no native code).
- `npx electron-builder --dir`: **PASS**, produced `apps/desktop/release/win-unpacked/CodeForge.exe`.

## 14. Packaged Runtime Result

`apps/desktop/scripts/packaged-smoke.js full` against the freshly packaged exe: `MAIN_TS_LOADED → WHEN_READY_* → CREATE_WINDOW_START → LOAD_FILE .../dist/renderer/index.html → WINDOW_CONTENT_LOADED → WHEN_READY_WINDOW_CREATED → INIT_SERVER_START` — the packaged Electron app launches and paints the real renderer bundle containing every change in this milestone. It then fails identically to the prior milestone: `better-sqlite3` cannot locate a binding compiled for Electron 33's ABI (`node-v130-win32-x64`), and Electron's bundled Node lacks `node:sqlite`. `node -e "require('better-sqlite3')"` succeeds under plain Node on this machine, confirming the installed binary is Node-ABI, not Electron-ABI — exactly what `build:native` (blocked, §13) would have fixed.

## 15. Regressions Checked

- `git diff --stat` scope confirmed to the files in §11 — no edits to `packages/forge-zero`, `packages/eight-bit`, `packages/model-registry`, `packages/router`, `packages/cloud-gateway`, `apps/cloud-api`, GitHub-auth code, or ForgeVerify/completion-gate logic.
- Full `packages/server` suite (487 tests, including the CF-09 mission steering/budget/security/recovery/acceptance suites, publication, network-exposure, workflow terminal-state races) passes unmodified except the new files added.
- All pre-existing `apps/desktop`/`packages/ui` suites (secret redaction paths, GitHub auth endpoint shape, single-instance guard, onboarding, CSP, EightBit status, GEMS entitlement/lock behavior, execution-mode desktop e2e, the entire prior model-picker R1 suite) pass unchanged.
- The unrelated, pre-existing ForgeGreen and prior-milestone uncommitted changes are untouched (`git status` diffed before/after).

## 16. Remaining Blockers

1. **No real, packaged-Electron proof that minimizing to tray keeps a background agent progressing.** Root cause: this machine's Visual Studio 2026 install is incompatible with `node-gyp`'s Visual Studio detection, so `better-sqlite3` cannot be rebuilt for Electron's V8 ABI, and Electron's own bundled Node lacks `node:sqlite`. The packaged app therefore cannot get past `CodeForgeServer` construction to reach a state where a real agent turn could be started and a real window could be hidden/restored around it. **Missing proof**: the exact 11-step scenario in the milestone's §29, run on a toolchain (or CI runner pinned to `windows-2022`, per this project's own existing memory) capable of the native rebuild.
2. **No packaged validation of the full desktop-home smoke path (§51 items 4–22)** for the same reason — the app never reaches the empty-state screen inside real Electron chrome in this sandbox. Live browser verification in §9 substitutes for everything reachable without a real Electron window; it is not a substitute for the packaged-app proof the milestone explicitly requires.

Neither blocker stems from this milestone's implementation; both are the identical, pre-existing environment constraint documented in the prior model-picker R1 certification. Everything else specified — architecture, empty-state redesign, real activity data, real favorites, context bar, close-safety logic and its tests, and live (non-Electron-shell) verification — is implemented and confirmed to the fullest extent this sandboxed environment allows.

## 17. Final Verdict

**`CODEFORGE_DESKTOP_HOME_R1_BLOCKED`** — blocked strictly on the two packaged-Electron proofs in §16, both gated on a Windows native-toolchain limitation outside this milestone's control. All in-scope implementation, tests, static verification, and live (real server + real bundle) UI verification are complete and passing.
