# R47 §9 — Free Role Coverage Audit

Source: durable qualification store (`%TEMP%/r46-qualification.db`), 9 receipts restored.
Method: `scripts/r47-role-coverage-audit.mjs` → `R47-FREE-ROLE-COVERAGE.json`.
No live calls were spent producing this matrix.

## The independence boundary

Pool IDs are `managed:<provider>:<account>:model:<model>` — per-model. Quota fate (RPM burst
windows aside) is shared at the **account**, so the audit reports both granularities and uses
accounts as the true independence count. 15 models on one OpenRouter key are one backup, not
fifteen.

## Coverage by account (true independence)

| account | pools | EXPLORER | PLANNER | CODER | REVIEWER |
|---|---|---|---|---|---|
| managed:groq:live-acct-groq | 4 | QUALIFIED (gpt-oss-20b) | QUALIFIED | QUALIFIED | QUALIFIED (qwen3.8-27b) |
| managed:mistral:live-acct-mistral | 4 | **NOT_QUALIFIED** | QUALIFIED | QUALIFIED | QUALIFIED (ministral-3b/8b) |
| managed:openrouter:live-acct-openrouter | 1 | NOT_QUALIFIED | HARD_FAILURE | QUALIFIED (nemotron-3.5-lightning) | HARD_FAILURE |

## Critical-role independence

| role | qualified pools | independent accounts | verdict |
|---|---|---|---|
| EXPLORER | 1 | **1** | single point of failure — the thin seam R46 hit |
| PLANNER | 5 | 2 | adequate |
| CODER | 8 | 3 | strongest |
| REVIEWER | 3 | 2 | adequate but shallow |

## Why mistral failed EXPLORER (receipt evidence)

- `codestral-latest`, `codestral-2508`: reads=0 on both explorer cases, recall=0 — the model
  answered without ever reading a file (valid tool calls, zero read discipline). Real
  capability failure, not transient.
- `ministral-3b/8b`: validToolCallRate 0.5–0.83, reads=0 — malformed tool calls plus no reads.
- `openrouter/nemotron-3.5-lightning`: engaged correctly (reads>0, validTool=1.0,
  hallucinations=0) but recall=0 — chose wrong files. Near-miss, but same account.
- `groq/qwen3.8-27b`: EXPLORER=NOT_TESTED — both cases aborted on provider 429s (transient,
  excluded from scoring). Route is REVIEWER-qualified and remains pending only at role level;
  `pendingQualification()` re-enters on receipt state (QUALIFIED), so role-level NOT_TESTED is
  not re-probed. Known gap, low value to fix: same account as gpt-oss-20b.

## §10 action taken

One bounded probe ran: `qualifyPending({ budget: 2, providerId: "mistral" })` targeting the
untested mistral pool — the only remaining account that could add independent explorer
coverage. Result: `mistral/mistral-code-latest` QUALIFIED (CODER, TOOL_AGENT, ANALYST,
PLANNER qualified; REVIEWER probation; EXPLORER NOT_QUALIFIED). One receipt persisted; the
second per-cycle slot was not spent (provider cycle gate).

**EXPLORER remains single-account** (groq/gpt-oss-20b only). Five mistral models have now
failed the explorer probe — every one on zero-read discipline (answered without reading files)
or malformed tool calls. That is a measured capability pattern of the mistral free tier, not a
sampling artifact; more mistral explorer probes would spend quota re-proving it. Per §10's
"do not spend scarce calls indiscriminately," probing stops here and the single-account
explorer exposure is the documented supply limitation:

- groq explorer outage/degradation ⇒ no qualified explorer anywhere; missions fall back to
  coder-driven exploration or block honestly.
- Mitigations available without spend: explorer summary recovery (§7) reduces serve-time
  contract failures; the qualification probe measures a different surface (tool discipline +
  recall) where mistral genuinely fails.

Net coverage delta from the probe: PLANNER 5→6 qualified pools, CODER 8→9, REVIEWER unchanged
(3 qualified, mistral-code probation added).
