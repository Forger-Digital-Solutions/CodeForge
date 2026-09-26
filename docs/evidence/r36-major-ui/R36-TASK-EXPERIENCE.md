# R36 — Task experience: timeline & conversation feed

## What ships

`packages/ui/src/timeline.ts` now projects the full frozen event vocabulary into feed rows:

- `command.started` → live `command` row (running state, cwd when present)
- `command.output` → appended to the matching command row's transcript (matched by `commandId`,
  with adoption of the oldest still-running command for legacy producers that emitted mismatched ids)
- `command.completed` → terminal state, exit code, `durationMs`
- `command.executed` → legacy path preserved
- `turn.steered` → `steer` row ("You · steering")
- `subagent.started/progress/completed/failed` and `subagent.lifecycle` → `subagent` rows with
  role, task, state, progress percent, result/error
- `eightbit.status` with `FREE_CAPACITY_WAIT` / `ROUTE_*` / `NO_ELIGIBLE_FREE_MODEL` → `notice`
  rows carrying `reasonCodes` and `accessibleText`
- `file.change_proposed/applied/reverted`, `file.written` → `file` rows with diff/stats
- `browser_*` tool events → `browser` kind with URL/action identity
- Every item carries `ts` for timestamps and group elapsed computation.
- Workflow-dispatched internal turns are suppressed from user-visible prose.

## Rendering (`Conversation.tsx`)

- Command cards: `RUN COMMAND` label, command text, status (Running/Passed/Failed), exit code,
  formatted duration, expandable transcript.
- Steer rows: distinct "You · steering" attribution.
- Subagent rows: role + task + state (Queued/Working/Done/Failed + progress text).
- Capacity notices: honest "Parked · Waiting for free capacity" strip with reason codes —
  never fake progress.
- Assistant speaker label shown once per contiguous prose run.
- Phase labels de-duplicated ("Verify" no longer renders "Verify Verification…").

## Honesty invariants

- Failed operations remain individually visible inside groups and feed.
- `waiting_for_free_capacity` and `NO_ELIGIBLE_FREE_MODEL` are stated plainly.
- No timeline state can mark a run successful; completion still belongs to the backend gate.

## Tests

`packages/ui/test/timeline.test.ts` covers: streaming command lifecycle, orphan output
adoption, legacy `command.executed`, steering, subagent lifecycle + progress, capacity notices,
file changes, internal-turn suppression, timestamps.
