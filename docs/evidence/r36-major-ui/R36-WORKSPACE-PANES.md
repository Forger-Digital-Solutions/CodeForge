# R36 — Workspace panes (Inspector)

## Commands tab

`projectSessionCommands` (session-activity.ts) consumes `command.started/output/completed` and
legacy `command.executed`, accumulating a transcript per command. The Inspector renders:

- command text + working directory
- status: Running / Passed (exit 0) / Failed (exit≠0) / Interrupted (session terminal with an
  unfinished command)
- formatted duration (`durationMs` → `1.8s` etc.)
- expandable live transcript (stdout/stderr stream)

## Changes tab

- Projected `file.change_proposed/applied/reverted` + `file.written` rows with +add/−del stats.
- Rows are expandable; expansion mounts `DiffViewer` with `initialOpen` so the diff shows
  immediately (no nested "View Diff" toggle). `DiffViewer` gained an optional `initialOpen` prop;
  standalone usage unchanged.

## Browser tab

New tab projecting `browser_*` tool events into an action log (action + URL + result status).

## Resize handle

`WorkspaceApp` holds inspector width state; a drag handle on the pane edge resizes it (clamped
min/max). Collapse/expand behavior preserved.

## Files

Left-nav "Files" view now mounts the real `FileExplorer` (was a dead stub); `Navigation` accepts
`workspacePath`/`apiBase`.

## QA harness

`apps/web/src/qa.tsx` passes fixture `events` through to the Inspector so pane scenarios render
real projected content (previously panes received no events).
