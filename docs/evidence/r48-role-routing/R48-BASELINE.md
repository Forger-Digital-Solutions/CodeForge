# R48 Baseline — Verified 2026-09-27

## Repository identity

- Branch: `codex/r29-release-closure`
- HEAD: `d4769e8` (R47 closure: measured 16-Bit ranking, closure matrix, source-state recert)
- Working tree: clean
- Source-state certification: `r47-16bit-first-light-v1` (`499bc26c2afd…`)

## Preserved R47 state

- R47 commits: `1978bbf` (Phase A), `41f75ac` (Phase B substrate), `d8e1228` (Phase B live), `d4769e8` (closure).
- Durable paid ledger: `%TEMP%/r47-16bit-ledger.db` — campaign `r47-16bit`, session
  `r47-16bit-campaign`, `authorizedUsd=0.5`, `committedUsd=0.021986`, `reservedUsd=0.0`,
  **170 durable receipts** (probe + qualification + mission traffic, all settled).
- Durable free qualification DB: `%TEMP%/r46-qualification.db` (151 KB) — Phase A role
  receipts persist.

## R47 carried findings (the starting truth)

- 16-Bit roster: gpt-5.6-luna / glm-5.3-flash / qwen3.8-flash / deepseek-v4.1-flash; all four
  OpenRouter fallback routes live and CURRENT-priced.
- Live qualification: deepseek → CODER/TOOL_AGENT/ANALYST; glm → PLANNER/REVIEWER/CODER/
  TOOL_AGENT/ANALYST; qwen → CODER/TOOL_AGENT/ANALYST/REVIEWER (PLANNER untested — empty
  completions); gpt-5.6-luna → CODER/TOOL_AGENT/ANALYST/PLANNER (REVIEWER probation).
  **EXPLORER: 0/4 paid models qualified.** Free fleet: only Groq gpt-oss-20b qualified.
- First live mission: glm-5.3-flash, single-pin, completed, $0.0037, 17 receipts.
- Known gaps: ranker price-fallback on all-NOT_QUALIFIED roles; single-model pin (no per-role
  routing); stream receipts can't verify served-model; reasoning-token starvation defeats
  deepseek/qwen planner probes; credential-absent direct→fallback now works.

## Focused regression state at baseline

- paid-auto: 50/50 · server pipeline: 75/75 · sweep: 152/152 · Phase A: 635 focused.
