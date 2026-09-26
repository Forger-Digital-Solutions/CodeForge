# R44 — Structured-Output Reliability Report

## Defect class (from R43 live corpus)

`AGENT_INVALID_STRUCTURED_OUTPUT` was the leading live failure mode. Raw responses from
small free models arrived as fenced JSON inside prose, prose with a trailing comma, or
truncated JSON — all rejected byte-for-byte by the previous parser, with no telemetry
distinguishing "model emitted prose" from "schema violation".

## Changes

**`packages/agent/src/index.ts` — ordered bounded repair**

`validateStructuredAgentResult` now tries candidates in a fixed order and records which
strategies produced the accepted payload:

1. **Raw text** — pure JSON (including braces/fences inside string values) is never
   reinterpreted.
2. **Single fenced block** — only when the fence is the only brace-bearing content; a JSON
   object preceding a fence is never silently replaced by the fenced payload (conflicting
   payloads still reject).
3. **Brace extraction** — first `{` to last `}` when no fence exists.
4. **Trailing-comma strip** — bounded regex removal of `,}`/`,]` before a final re-parse.

Every success carries `repairedWith` for telemetry. Odd fence counts (truncation),
multiple fenced blocks, prose-without-JSON, and schema violations still fail closed — no
repair fabricates structure or tool arguments.

**Runtime**

- Exhausted repairs return blocked with `AGENT_INVALID_STRUCTURED_OUTPUT` and feed the
  Eight-Bit reliability tracker as `structured_output_failure` — repeated malformed output
  demotes/quarantines the route through the existing 50-sample rolling window.
- Per-run `contextMetrics.structuredOutput` records `repairs`, `truncationRepairs`,
  `repairStrategies`, `rejections`, `exhausted`.
- The journal (`agent_run_journal`) persists the same telemetry per role for offline
  attribution.

## Deterministic evidence

- `packages/agent/test/structured-output-security.test.ts` — 19/19, including the new
  repair-path pins (fenced recovery, conflicting-payload rejection, truncation rejection).
- `scripts/r44-role-benchmark.mjs` — `reviewer-fenced-verdict` proves fenced JSON is
  recovered with a recorded strategy; `reviewer-invalid-blocks` proves prose never
  becomes valid structured output and exhaustion blocks honestly.

## Live evidence

Live structured-output rejection rates are recorded per run in the corpus journals
(`telemetry.structuredOutput.rejections` / `exhausted`); see `R44-MULTIFILE-CORPUS.json`.
