# R27 Terminal Lifecycle Report

Status: `R27_TERMINAL_PROCESS_TREE_LIFECYCLE_DETERMINISTICALLY_PROVEN_ON_HOST`

## Finding

Bounded command execution already terminated process trees, but the persistent user-facing
`TerminalSession` killed only its PTY root. A shell or terminal root can have descendants, so the
interactive path had a weaker orphan-prevention guarantee than the command path.

## R27 correction

`TerminalSession.kill()` now uses the shared platform process-tree terminator. Windows requests a
tree kill through `taskkill /T /F` and falls back to the direct child when needed; POSIX targets the
process group before falling back to the root. The session's PTY exit handler remains responsible
for trailing-output cleanup and agent-handle teardown.

## Deterministic validation

This host reports PTY support. A real PTY session started a root Node process that spawned a child
scheduled to write an orphan marker. After `TerminalSession.kill()`, the session exited and the
marker never appeared. The terminal suite passed 30/30. A combined terminal, command-service,
runtime-failure, and command-exit suite passed 66/66, and Terminal, Server, and Tools typechecking
passed.

## Boundary

This is host-local deterministic lifecycle evidence, not a guarantee for every Windows shell or
security product. The visible packaged-desktop terminal experience, including console-flash
behavior, still requires a fresh isolated desktop artifact and an interactive smoke test.
