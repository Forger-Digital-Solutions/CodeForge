# R36 — UI audit findings (input to implementation)

Date: 2026-09-25/26
Scope: audit of `@codeforge/ui` against the R35 contract freeze; findings drove the R36 slice.

## Findings (all confirmed in source, pre-change)

1. **Streaming command lifecycle invisible in the feed.** Runtime emits
   `command.started` / `command.output` / `command.completed`; `timeline.ts` handled only legacy
   `command.executed`. Live commands never appeared in the conversation — only in Inspector.
2. **Steering invisible.** `turn.steered` events never produced a timeline row.
3. **Subagents rendered as flat system rows.** `subagent.started/progress/completed/failed` and
   `subagent.lifecycle` collapsed to generic `system` text; no role, task, state, or progress.
4. **Capacity/route waits had no feed representation.** `eightbit.status` events
   (`FREE_CAPACITY_WAIT`, `ROUTE_ROTATED`, `NO_ELIGIBLE_FREE_MODEL`) only surfaced through the
   canonical run header; nothing in the conversation explained the pause.
5. **Browser tools rendered as generic "Activity".** No browser identity in feed or panes.
6. **Grouping only merged consecutive same-kind completed tools.** Mixed work sequences stayed
   fragmented; no elapsed time, no per-kind breakdown.
7. **Assistant speaker label repeated on every row**; phase labels could duplicate words
   ("Verify Verification…").
8. **Commands tab honest but plain** — no transcript stream presentation, no cwd, raw durations.
9. **Changes tab had no inline diff expansion.**
10. **Inspector width fixed** — no resize affordance.
11. **Left-nav "Files" view was a dead stub.**
12. **Colorful emoji iconography** conflicted with the monochrome-professional direction.

## Non-goals respected

- No backend contract changes: all rendering consumes existing frozen events.
- No completion-gate bypass, no fake success states.
- Free-cloud/ForgeZero semantics untouched.
