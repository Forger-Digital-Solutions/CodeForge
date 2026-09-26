# R36 — Activity grouping v2

## Contract change

v1 grouped only consecutive same-kind completed tools. v2 groups related completed activity
across **mixed kinds** (tool/file/command/browser/subagent) within a turn:

- Short assistant narration may bridge grouped work without splitting the group.
- Group header shows elapsed time (`formatElapsed`) and a per-kind breakdown
  (e.g. `Worked · 4 steps · 2 reads · 2 edits`).
- Members remain individually expandable inside the group (audit trail preserved).
- Failed items are never folded into a successful-looking summary — failures render their own
  state.
- User/system/phase/steer items are not grouped; grouping is bounded to a single turn.

## Why

Three sequential tools previously rendered as scattered fragments or multiple groups. A coherent
"unit of work" reads as one collapsible group with honest counts — matching how users think about
agent progress ("it did 4 things in 1.8s") without hiding detail.

## Test contract update

`conversation-tool-grouping.test.ts` was updated: three mixed tools now produce ONE group
(previously two under v1 semantics). Added coverage for mixed-kind breakdown, elapsed metadata,
and failure visibility inside groups.
