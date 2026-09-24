# Runtime fixes and limits

- `write_file` and `edit_file` reject byte-identical results with `TOOL_NO_EFFECT`, leaving the file untouched. The direct server edit path does the same for `replaceExact`.
- The agent runtime does not emit file-change events for rejected no-op writes. Two consecutive no-effect attempts produce explicit reread/replan feedback; four block the turn with `AGENT_NO_PROGRESS_DETECTED`. A successful mutation resets the count.
- Snapshot diff review now counts changed lines for same-line replacements. The old line-count delta had understated R28 modifications as `+0/-0`.
- The workflow implementation prompt now asks for one bounded reference search, edits, one consistency search, and a final response before the model-turn budget is exhausted. The diagnostic replay hit provider network failures before this could be evaluated.
- The completion gate remained the only authority for `completed`. No policy was relaxed.

Focused Vitest runs passed 68 and 36 tests respectively, including no-effect writes, direct-edit mtime preservation, no-progress blocking, diff counts, and model-picker rendering. `npm run typecheck` passed after the changes. The canonical regression result is recorded separately.
