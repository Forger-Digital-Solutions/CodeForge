# R36 — Subagent UX

## Feed rows

`subagent.started/progress/completed/failed` and `subagent.lifecycle` render as dedicated rows:

- role + task summary (e.g. `Explorer · Map signup flow call sites`)
- state: Queued / Working / Done / Failed, progress message, optional percent
- parent linkage (`parentAgentId`) preserved in the model for future nesting

Previously these collapsed to indistinguishable `system` text.

## Contracts consumed

- `subagent.lifecycle` payload: `agentId`, `role`, `parentAgentId?`, `task`, `state`,
  `capsuleVersion`, `model?`, `telemetry?`, `reason?` — display uses the frozen fields only.
- `subagent.artifact_written` → artifact reference surfaced via file/artifact projection.

## Verified

- Unit: timeline tests for each lifecycle state incl. progress percent.
- Visual: `screenshots/r36-live-run.png` shows Explorer/Reviewer rows with found/queued states.
