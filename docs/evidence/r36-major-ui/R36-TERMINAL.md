# R36 — Terminal surface

Scope note: R36 uses the Commands surface as the terminal experience — a real embedded terminal
pane was NOT added this slice.

## What ships

- Feed: live command cards with streaming transcript, cwd, exit code, duration
  (`command.started/output/completed`; legacy `command.executed` preserved).
- Inspector Commands tab: full session command history with transcripts; interrupted state for
  unfinished commands in a terminal session.
- Orphan-output adoption: if `command.output`/`completed` arrive with ids that don't match a
  running command, output attaches to the oldest still-running command (legacy producer compat).

Verified: `screenshots/r36-live-run-2.png` (live transcript + cwd + durations).
