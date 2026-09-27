# R50 Nemotron Role Profile

**Route:** `openrouter/nvidia/nemotron-3-super-120b-a12b:free`
**Date:** 2026-09-27
**Provenance:** replayed R49 durable evidence — live qualification receipt + four live mission artifacts (zero new live calls; deterministic analysis only)

## Qualification receipt (R49, R41_ROLE_QUALIFICATION_V3, 2026-09-27T13:51Z)

| Role | Verdict | Cases | Notable |
|---|---|---|---|
| CODER | QUALIFIED | tool_call ✓, edit ✓ | clean 2-turn edit flow |
| TOOL_AGENT | QUALIFIED | tool_call ✓, edit ✓, structured ✓ | |
| ANALYST | QUALIFIED | structured ✓ | |
| EXPLORER | QUALIFIED | route_execution ✓, **reservation_release ✗** | non-hard fail inside a QUALIFIED verdict |
| PLANNER | QUALIFIED | release_callsite ✓, schema ✓ | |
| REVIEWER | QUALIFIED | one_bug ✓, clean ✓, clean_comment ✓, swallowed_failure ✓, **reservation_leak ✗**, test_cheat ✓ | non-hard fail inside a QUALIFIED verdict |

## Live production outcomes (R49 missions)

| Role | Attempts | Completed | Blocked | Classes observed |
|---|---|---|---|---|
| EXPLORER | 2 | 0 | 2 | `NON_CONVERGENCE` (RUN2: 5 turns / 3 tool calls / 75s, turn-limit); reasoning-in-text instead of structured output (RUN3: 2 requests / 0 tools) |
| CODER | 2 | 2 | 0 | verified mission edits, tests passing (RUN2: 9 req / 8 tools; RUN3: 6 req / 7 tools) |
| REVIEWER | 3 | 2 | 1 | 2 correct verdicts (RUN2/RUN3); **1 `TOOL_WORKSPACE_ESCAPE` — `path: "/"`** (RUN1/RUN4 artifacts — identical telemetry, treated as one observed event class) |
| TOOL_AGENT | 0 | — | — | qualification only |
| ANALYST | 0 | — | — | qualification only |
| PLANNER | 0 | — | — | qualification only |

## Role-by-role assessment

**EXPLORER — QUALIFIED but demonstrably weak.**
Two independent live Explorer dispatches both failed to converge (turn-limit exhaustion; structured-output non-compliance — the model reasoned in free text instead of emitting the explorer JSON). Both failures are model-quality classes, not supply failures (requests completed with HTTP 200). The qualification probe's own `reservation_release` case failed too, so qualification + runtime agree the role is marginal.
→ Runtime quality delta should carry repeated `role_failed`/`budget_exhausted` evidence; the route stays QUALIFIED (receipts are not rewritten) but ranks below any qualified Explorer peer until live successes accumulate.

**CODER — QUALIFIED and proven in production.**
Two end-to-end mission completions with real multi-tool edit flows and passing verification. Positive evidence; this route is a legitimate Coder-class candidate.

**REVIEWER — QUALIFIED with one severe tool-safety failure.**
Two accepted reviews and one `WORKSPACE_ESCAPE_ATTEMPT` (`path: "/"`) that the boundary correctly refused and blocked the run. Under R50 weights this is `security_blocked` × `WORKSPACE_ESCAPE_ATTEMPT` factor — the heaviest single-sample class (−2 clamp), partially offset by two verified reviews. The model remains QUALIFIED but ranks below a clean reviewer peer; a second escape pattern would saturate the negative bound.
→ Reviewer routing should prefer an independent qualified route when one exists — which is precisely what R50's quality-aware ordering now does, and why a third reviewer-capable domain matters.

**TOOL_AGENT / ANALYST / PLANNER** — no live production evidence; cold-start neutral. No demotion warranted; qualification stands.

## What R50 changes mechanically

Before R50, this evidence lived only in JSON artifacts — routing rediscovered nemotron's Explorer weakness on every mission at full price in scarce free requests. After R50:

- The two Explorer `role_failed`/`budget_exhausted` outcomes feed `roleQualityDelta` → bounded negative ranking input for EXPLORER only.
- The Reviewer `security_blocked(WORKSPACE_ESCAPE_ATTEMPT)` feeds the same lane at double weight in the malformed-tool streak (two consecutive escape-class proposals quarantine; four ordinary malforms would).
- The two Coder `verified_complete` outcomes (post completion-gate + integration) keep its Coder ranking high.
- Qualification receipts are untouched: the model can recover each role by accumulating verified live work.

No global "nemotron is bad" state exists — that was the design requirement.
