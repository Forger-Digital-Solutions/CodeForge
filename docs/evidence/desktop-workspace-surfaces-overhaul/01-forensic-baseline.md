# Desktop Workspace Surfaces Overhaul — Forensic Baseline

Repository: `G:\CodeForge` · Branch: `forger-digital-solutions-forgegreen-certified`
Baseline SHA: `d2b3aa4` (permission/chat overhaul landed; this campaign layers on top)
Electron 44.4.1 · React 19 · Vite 8 · `node-pty` evaluated for ConPTY.

## Reconciliation with the preceding campaign

The permission/chat overhaul (commits `2b4831c`…`d2b3aa4`) is fully committed; nothing is
reverted. Surfaces it touched that this campaign must preserve:

- `ApprovalBar` (compact permission dock), `Composer` (authority controls, Agent/Chat),
  `Conversation`/`timeline.ts` (grouped activity, no workflow spam), `WorkflowProgress`
  (Stop canonicalized to Header), `workspace-sse.ts` (`authority`, `repair` flag,
  `leftNav`/`activeTab` state), `WorkspaceApp` (failure card, `sendMessage({repair})`).
- Server: `authorityFor`, `/api/sessions/:id/authority`, `TaskAuthority` gating in
  `agent-runtime.ts`, plan gate in `workflow-service.ts`/`workflow-engine.ts`.

## Shell architecture (BEFORE)

- `packages/ui/src/WorkspaceApp.tsx` — three-column body:
  `Navigation` (left) | `workspace-center` (toolbar → WorkflowProgress → Conversation →
  ApprovalBar/QuestionBar → failure card → Composer) | `Inspector` (right).
- Left (`Navigation.tsx`): brand, New task, Search, "Workspaces" section with ONE active
  project + Switch, Tasks/Files toggle (Files is a stub string), sessions grouped only by
  age (Today/Yesterday/7d/Older) — **flat per active project, no project→task hierarchy**.
  Bottom: Settings + Help. Collapse: `Ctrl+B`, persisted `codeforge:sidebar-collapsed`.
- Right (`Inspector.tsx`): fixed-width tab strip with 6 tabs — `changes` (Changes),
  `run` (Run), `commands` (Commands — command *history*, not a PTY), `files`
  (FileExplorer tree), `evidence` (Evidence+checkpoints), `overview` (task telemetry).
  Labels truncate at the panel's fixed width (CHAN…/RUN/COM…/EVIDE…/OVER…).
  Collapse: `Ctrl+Alt+B`, **not persisted**, no resize, no launcher state.
- No interactive terminal, no browser, no real diff view in the shell (`DiffViewer.tsx`
  exists as a component; Changes tab is a flat file list with +/− counts).
- Sessions carry `workspacePath`; `/api/sessions` is global → project grouping is a
  rendering concern, not a data problem.
- Server: `CodeForgeServer` runs **in-process inside Electron main** on 127.0.0.1 with a
  control-plane bearer; renderer→server is HTTP `/api/*`; renderer→main is 54 IPC
  handlers (settings/providers/credentials/diagnostics/…).
- `/api/workspace/tree` — full recursive tree to depth 20 in ONE response (scans whole
  workspace; not lazy — a large-repo liability for Files).
- `shell:execCommand` IPC — git read-only allowlist for renderer introspection.

## Process-spawn audit (terminal-flash forensics)

Every spawn site already passes `windowsHide: true` on the **immediate** child:

| Caller | Executable | Shell | windowsHide | stdio | Tree kill | Notes |
|---|---|---|---|---|---|---|
| `tools/src/index.ts` run_command | `cmd.exe /d /c` or `node -e` | cmd | ✓ | pipe | proc.kill only | agent tool |
| `server/command-service.ts` | prepared (npm-cli→node, else shell) | mixed | ✓ | pipe | taskkill /T /F | verification/approval cmds |
| `server/agent-runtime.ts:4552` | prepared | mixed | ✓ | pipe | yes | runtime exec |
| `workflow/verification-service.ts` | prepared | mixed | ✓ | pipe | yes | verifier runs |
| `workflow/forge-verify.ts:355` | direct executable | none | ✓ | pipe | yes | shell:false only |
| git plumbing (8 sites, execFile) | `git` | none | ✓ | pipe | n/a | status/diff/rev-parse |
| `providers/codex-app-server-process` | codex binary | none | ✓ | pipe | — | provider host |
| `desktop/environment-refresh` | exe | none | ✓ | pipe | — | env probe |
| `desktop/shell:execCommand` | `git` allowlist | none | ✓ | pipe | — | renderer git RO |
| `terminateProcessTree` | taskkill | none | ✓ | ignore | self | cleanup |

### Root cause — CREATE_NO_WINDOW does not propagate

`windowsHide` (CREATE_NO_WINDOW) gives the immediate child **no console at all**. When
that console-less child spawns a console-subsystem grandchild with default creation
flags — `npm test` internally launches `cmd.exe /d /s /c "<script>"`; `node_modules/.bin/*.cmd`
shims; `cmd /c` inside npm; console apps — Windows allocates a **new, visible console**
for the grandchild. That console is the transient PowerShell/cmd window that flashes.

Pipes + `windowsHide` can never fix this: there is no "invisible but inheritable" console
flag. The only correct mechanism is a **ConPTY pseudo console** (Win10 1809+): invisible,
and the entire process tree started inside it inherits it — zero windows, and as a bonus
commands get real TTY behavior (colors, progress). This is the same mechanism VS Code
uses for task execution.

Verified on this host: `node-pty@1.1.0` ConPTY spawn under Node 24 returns ANSI output
and exit codes (`useConpty: true`, `pty.spawn('cmd.exe', …)` → exit 0).

### Stream-merge compatibility

PTYs merge stdout+stderr into one stream. All agent-command consumers already
concatenate (`result.stdout + result.stderr`, run_command's combined block, forge-verify
output) → compatible. Git plumbing stays on `execFile` (needs clean stdout; plumbing
verbs spawn no console children).

## Implementation shape decided

- New `packages/terminal` (`@codeforge/terminal`): ConPTY-backed `PtyProcess` wrapper +
  headless `executeCommand` (Windows) with pipe fallback (POSIX/unavailable) +
  interactive `TerminalSession` for the user terminal.
- `node-pty@1.1.0` as an optional lazy dependency — absent ⇒ pipe path (no worse than
  today). Electron-ABI build via the existing `@electron/rebuild` machinery
  (`scripts/rebuild-native.mjs`, better-sqlite3 precedent).
- Desktop main hosts the interactive terminal (`terminal:*` IPC → renderer xterm.js);
  the embedded server hosts agent execution.
- Browser: `<webview>` guest contents on a dedicated `persist:browser` partition —
  separate process, no nodeIntegration, sandboxed, no CodeForge preload — embedded in
  the right work surface.
