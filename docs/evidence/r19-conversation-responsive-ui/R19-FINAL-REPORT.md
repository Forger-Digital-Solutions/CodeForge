# R19 — Conversation UX, Responsive Workspace & Activity Presentation Polish

Campaign date: 2026-09-20
Certified commit: `0c6afddb802e65c4f9fd4cf707b1f14cb5ef0924`
Branch: `forger-digital-solutions-forgegreen-certified`
Artifact: `apps/desktop/release/CodeForge-Setup-0.4.0.exe` (+ `win-unpacked`, `CodeForge-Portable.exe`)

---

## Executive Verdict

**R19 CONVERSATION / RESPONSIVE UX — CERTIFIED**

The installed Windows product now tells the story by default, provides evidence on expansion,
and keeps diagnostics separate. Verified against the *installed* artifact built from the
committed clean tree (`dirty=false`): semantic activity grouping, muted duplicate suppression,
truthful cancelled/stopped/blocked rows, attached metadata, a composer that reads as a
conversation input, scrollable inspector tabs at narrow widths, and a bounded conversation rail
at every tested window size. The canonical suite is fully green (0 failures), packaged smoke and
the headless console-window probe pass on the final bundle, and real tasks completed, blocked,
and stopped — including a stop-during-approval with verified live↔restored parity.

---

## Starting Repository State

- Starting HEAD: `0635319` (R18 evidence anchor) — verified via `git log`/`git status`, clean tree.
- R19 changed **only** `packages/ui` source/tests — zero material ForgeGreen files
  (`materialFiles` filter over `packages/ui` = 0), so the R18-certified provenance surface
  (`r18-release-candidate-v1`) stands untouched; no recertification needed or performed.
- Campaign changes committed as `0c6afdd` **before** the final artifact build — the installer is
  built from a committed, clean tree (`PACKAGED_BUILD_IDENTITY_VALID=PASS`, `dirty=false`).

## What Changed

### Conversation rendering (`packages/ui/src/Conversation.tsx`, `timeline.ts`)

- **Semantic activity grouping.** Adjacent *completed* same-kind tool calls collapse into one
  expandable row — `Explored · 3 files`, `Searched · 2 searches`, `Edited · 2 files`.
  A short narrating message sandwiched between calls of the same kind folds *inside* the group
  (`≤160` chars, non-question), so the story reads as work, not as interleaved event chatter.
  Failed, blocked, and running calls are never grouped — a summary cannot hide something that
  needs attention. Expansion shows every child operation in order plus the bridged narration.
- **Speaker dedup.** `CodeForge` labels once per run of prose instead of on every message.
- **Phase rows.** The outcome row leads with the verdict (`Blocked`, `Done`, `Stopped`) — no more
  `CodeForge Blocked`; the `Verify Verification…` double-verb is stripped; gate rationales of the
  form `code: detail` are humanized (`plan_steps_unfinished` → `Implementation did not finish —
  6 plan step(s)…`) via `describeReasonCode`, keeping the detail attached.
- **Terminal-state rows.** A tool call still marked `running` when the run is terminal renders
  `Cancelled — the run ended first` (muted) instead of a frozen `Working`; duplicate suppression
  renders `Skipped — duplicate of an unchanged read` (muted, neutral icon) instead of red.
- **Icons restrained** to 16px in activity rows; no robot-stamp-per-row.

### Composer (`Composer.tsx`, `WorkspaceApp.tsx`, `ModelSelector.tsx`)

- The context chip row (`ContextBar` inside the composer) is removed from the live path —
  workspace/branch/runtime already live in the nav header and top bar. `ContextBar.tsx` remains
  as an unused library component; no other callers.
- The textarea is the dominant surface; controls are compact and secondary; the model trigger
  shows `ForgeAuto/Free` with the routing explanation moved to `title`/tooltip.
- Failure card carries semantic tone (`tone-blocked` / `tone-stopped` / `tone-failed`), and its
  actions follow the real status (`Resume task` for cancelled, `Fix and continue` otherwise;
  `Review failure` → `View details`).

### Inspector (`Inspector.tsx`, `workspace.css`)

- Natural-width tabs in a horizontally scrollable strip; scroll-edge fade indicators
  (`can-scroll-left` / `can-scroll-right`) driven by real scroll metrics via `ResizeObserver`.
- Verified live at ~340px pane: all tabs reachable, none clipped, strip scrolls.

### Activity presentation (`tool-activity.ts`, `workspace.css`)

- A read of `.` displays as `workspace root` instead of a bare dot.
- Metadata is attached to the row content (no far-right floating column); targets keep the
  meaningful tail via left-truncation.

## Canonical Test Results

`npm test` (root Vitest, full parallel run):

- **384 test files passed / 7 skipped**
- **2,985 tests passed / 0 failed / 36 skipped** (+11 over R18's 2,974 — the new R19 render cases)
- Zero unhandled errors; ~465 s wall clock.

Targeted: `timeline` 20 ✓, `conversation-tool-grouping` 2 ✓, `conversation-r19` 11 ✓,
`model-selector` 20 ✓, plus `composer` / `restored-session-truth` / `run-inspection` /
`conversation-eight-bit-status` — all green. `packages/ui` typecheck clean.

## Packaged Windows Validation

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `CodeForge-Setup-0.4.0.exe` (NSIS) | 117,315,483 | `7D669466781041011C1659B4D11FF38C541251B1A0DF2C805A82C61229614B87` |
| `CodeForge-Portable.exe` | 116,980,073 | `9F047514DC108F56BE258DEFBFB33EF2B1EA14366C2ACF8432BC4AA87963FB15` |
| `win-unpacked/CodeForge.exe` | 246,415,872 | `6C4279265E9D5C4CF794374760B5D400B55613EDB2B9A08ADBCB7D987F4F95AD` |

- Built from commit `0c6afdd`, `dirty=false`; `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS`
  (25 internal packages); `PACKAGED_BUILD_IDENTITY_VALID=PASS`.
- Silent-installed to `…\Programs\CodeForge`; installed `app.asar` verified to contain the R19
  renderer bundle `index-C9uBQezV.js` / `index-BJyXQooy.css`.
- `npm run smoke` (packaged, final bundle): **FULL SMOKE SUCCESS** — renderer lifecycle marks,
  reload ×5, settings round-trip, extensions (load/command/workspace-read/lifecycle),
  credential encryption round-trip — all PASS, zero FAIL.
- Headless command probe (40 ms window sampler, installed ConPTY backend): `npm test`,
  `node -e`, `npm run`, `cmd /c`, `bash -c` — **5/5 PASS, zero console windows**.
  Evidence: `07-terminal/headless-command-probe.json`.

## Real Tasks on the Installed Product

### Successful run
"Create a file named R19.txt … containing exactly the text hello" → `Read workspace root` →
`Explored · 3 files` → `Edit R19.txt · written` → `Verify attempt 1 · 8 passed` →
`Review · approved` → **`Done · All required completion checks passed.`** The transcript reads
as a story: prose, grouped exploration, the write, the proof. Evidence: `06-success/success-full.png`.

### Blocked run
"The inventory test suite is failing…" → repair verified (`4 passed`) and review approved, yet
completion **blocked — 6 plan step(s) unfinished**. Header `Blocked · Implementation did not
finish`; row `Blocked · Implementation did not finish — 6 plan step(s) did not finish
successfully`; amber **RUN BLOCKED** card (never "Verification failed" — verification passed and
the card knows it). Duplicate-suppressed reads render muted; the no-progress stop renders as a
stopped state. Evidence: `04-blocked/blocked-top.png`, `blocked-final.png`.

### Stopped-during-approval + reload parity
Permission mode `Ask More`; "Run the command `node -e "console.log(42)"`…" → **Needs your
approval** (command + scope shown). Stopped while pending → rows read `Execute … Cancelled —
the run ended first`, `Stopped · Task stopped before completion`, `Approval exec · Cancelled —
the run ended before a decision`; `working:false`. After reload the restored transcript is
**byte-identical** (`Stopped · Stopped by you`). Evidence: `08-stopped/approval-pending.png`,
`after-stop.png`, `after-reload.png`.

## Responsive Verification

- **Fullscreen (1536×842 CSS, DPR 2.5):** bounded 860px rail; no stretched-table look.
  Evidence: `01-layout/after-default.png`.
- **1366px:** rail bounded, sidebar/composer proportionate. `09-responsive/after-1366.png`.
- **Windowed 1200×800:** full layout intact. `09-responsive/after-windowed-1200.png`.
- **Narrow (~900px):** content-aware columns, tabs scroll. `09-responsive/after-narrow.png`.
- **2560 emulated:** rail stays 860 centered (display maxes at 1536 CSS px; emulation beyond the
  window is clamped — documented honestly). `09-responsive/after-2560.png`.
- **Inspector open/close** at narrow width: tab strip `can-scroll`, conversation unharmed.
  `05-inspector/inspector-open-v2.png`.
- **Empty state:** `02-chat/empty-state.png`; expanded group evidence: `03-activity-groups/group-expanded.png`.

## Remaining Gaps

- Free-model capacity queues still produce multi-minute "Waiting for free capacity" holds —
  reported honestly, not a product defect; capacity is a provider condition.
- The "Stopped during <phase>" strip under the header on terminal runs is intentional (reports
  *where* the run stopped when the header already carries the verdict) — retained by design.
- Browser surface remains partial (inherited from R16/R18; not regressed).
- Installer/installed binaries are unsigned — local-build reality; release signing is a
  distribution-time decision.
- `ContextBar.tsx` is now an unused export — retained deliberately; removal is a trivial
  follow-up if desired.

## Final Certification Matrix

| Item | Status |
|---|---|
| RESPONSIVE FULLSCREEN | **CERTIFIED** (bounded rail, verified live on installed build) |
| RESPONSIVE WINDOWED | **CERTIFIED** (1200×800 + narrow, evidence captured) |
| CONVERSATION UX | **CERTIFIED** (story-first default, speaker dedup, no event-debugger feel) |
| ACTIVITY GROUPING | **CERTIFIED** (semantic verbs/nouns, bridged narration, per-op evidence on expand) |
| COMMAND PRESENTATION | **CERTIFIED** (command + pass/fail + expandable output; headless probe PASS) |
| FILE ACTIVITY | **CERTIFIED** (path/action/detail; `workspace root` naming; attached metadata) |
| DUPLICATE SUPPRESSION UX | **CERTIFIED** (muted informational, never red) |
| COMPOSER UX | **CERTIFIED** (input-dominant, compact controls, concise route label + tooltip) |
| INSPECTOR RESPONSIVENESS | **CERTIFIED** (scrollable natural tabs + fade indicators, ~340px verified) |
| STOPPED-RUN TRUTH | **CERTIFIED** (stopped ≠ failed; cancelled approvals/tools explicit; reload parity) |
| BLOCKED-RUN TRUTH | **CERTIFIED** (RUN BLOCKED card; verification pass never implies completion) |
| VERIFICATION TRUTH | **CERTIFIED** (gate-only completion unchanged; humanized gate codes) |
| TIMELINE PERFORMANCE | **PASS** (grouping is O(n) over items; no regression observed in suite or live) |
| SETTINGS | **REGRESSION PASS** (packaged settings round-trip markers green) |
| EXTENSIONS | **REGRESSION PASS** (packaged extension markers green) |
| ONBOARDING | **REGRESSION PASS** (inherited; no onboarding surface touched) |
| PACKAGED WINDOWS | **CERTIFIED** (clean-tree build, install verified, smoke + probe PASS) |
| **R19 CONVERSATION / RESPONSIVE UX** | **CERTIFIED** |
