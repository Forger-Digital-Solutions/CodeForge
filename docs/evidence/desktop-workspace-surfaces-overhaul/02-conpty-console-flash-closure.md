# P0 Closure — Windows console-flash elimination (headless ConPTY)

Date: 2026-09-19 · Commits: `71be319`, `c459ceb` · Branch: `forger-digital-solutions-forgegreen-certified`

## Root cause (confirmed)

Every agent-facing spawn path already passed `windowsHide: true` — but
`CREATE_NO_WINDOW` does **not** propagate to descendants. A hidden `cmd.exe`/`node`
host that launches a console-subsystem grandchild (npm script shims,
`cmd.exe /d /s /c` inside npm, `.bat`/`.cmd` wrappers, console apps) causes Windows
to allocate a fresh **visible** console window. That is the transient-terminal
flash users see during `npm test`-style agent commands.

## Fix

New `@codeforge/terminal` package. On Windows, commands execute inside a
**ConPTY pseudo console** (invisible; inherited by the whole process tree) via
`node-pty@1.1.0`'s shipped N-API prebuild — loads unmodified under Electron 44,
no toolchain rebuild. POSIX keeps pipes; a missing node-pty degrades to the
previous pipe behavior. ConPTY is a strict improvement where present, never a
new requirement.

Wired into all agent-facing execution:

- `packages/tools/src/index.ts` — `run_command` tool (incl. `node -e` fast path)
- `packages/server/src/command-service.ts` — `/api/command` + cancel
- `packages/server/src/agent-runtime.ts` — agent `run_command`
- `packages/workflow/src/verification-service.ts` — `npm test`-style verification
- `packages/workflow/src/forge-verify.ts` — structured verifier attempts

`prepareShellCommand` (PATH normalization, Electron-as-Node, npm-cli resolution)
still runs first; callers pass the prepared spec to `executePrepared`.

## Non-obvious engineering findings

- **node-pty does not PATH-search** — bare `node`/`cmd.exe` throws "File not
  found". `resolveExecutable` resolves via PATH+PATHEXT first.
- **node-pty arg-array quoting mangles embedded quotes** — `cmd /c node -e "..."`
  arrived as `\"` literals. Passing `args` as a **string** appends verbatim.
- **ConPTY onExit lags 1.4–3.5s** behind real process exit (measured). Shell
  commands append `& echo __CFX_<uuid>_!errorlevel!` under `cmd /v:on` delayed
  expansion — exact exit code arrives in-stream at completion (~0.7s observed).
- **`p.kill()` is unsafe post-exit**: non-dll forks `conpty_console_list_agent`
  which crashes `AttachConsole failed`; dll only disposes its conout worker on
  new data → leaked worker_threads pinned the event loop. `teardownPty` performs
  the native kill + socket/worker disposal directly, deferred ~50ms for output
  flush. `stop()` uses `taskkill /T /F` (no agent fork, no race).
- **Verification semantics preserved**: timeout→124, cancel→130, spawn error→
  `spawnError`, merged stdout under ConPTY, stdout/stderr split under pipes.

## Validation

| Check | Result |
|---|---|
| `packages/terminal` tests | 24/24 PASS |
| `runtime.test.ts` (CommandService) | 19/19 PASS |
| `verification-service.test.ts` | 17/17 PASS |
| `forge-verify*.test.ts` | 11/11 PASS |
| Workspace `npm run build` | all packages PASS |
| `PACKAGED_INTERNAL_DEPENDENCY_GRAPH` | PASS (terminal shipped) |
| `PACKAGED_RUNTIME_DEPENDENCY_GRAPH` | PASS (node-pty shipped) |
| `packaged-smoke full` | **PACKAGED_FULL_SMOKE_OK** incl. `packaged_zero_prompt_workflow=PASS`, `packaged_failure_repair_pass=PASS`, `TASK_TERMINAL_PHASE_completed` |
| `packaged-smoke interrupt` | PASS (`PACKAGED_INTERRUPT_EXPECTED_EXIT`) |
| `packaged-smoke recover` | PASS (`PACKAGED_RECOVERY_SMOKE_OK`) |

Note: verifier timeouts in `forge-verify-evidence.test.ts` were raised 2s→15s —
ConPTY creation (~330ms serial, higher under parallel contention) cannot fit a
2s budget under load; statuses under test are unchanged.

## First-packaged-run flake observed

The first full-smoke run failed `verification_failed` — the repair loop's first
edit had not landed `a + b` before verification 2; the file reached `a + b`
after the attempt budget was spent (legitimate `failed`, gate held — no false
success). The identical verifier command was replayed through the packaged
executor standalone: correct output + exit codes on both broken and fixed
files. Second packaged run passed end-to-end.
