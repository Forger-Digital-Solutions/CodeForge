# R85 two-project concurrent execution

Harness `benchmarks/r85/concurrent-projects.mjs` — two isolated git workspaces (`project-a`, `project-b`), separate runIds, shared FreeCloud supply, real `createAutonomousRunOrchestrator` runs launched concurrently. Receipts: `R85-CONCURRENT-CAMPAIGN-1791757743077.json`, `R85-CONCURRENT-CAMPAIGN-1791759512621.json` (+ `-source.json` manifests).

## Run 2 (corrected roster, bundled + laguna-s receipt) — SINGLE_DOMAIN_FAIR_INTERLEAVING

Supply: 5 qualified routes (north-mini CODER/TOOL/ANALYST/EXPLORER, laguna-s CODER/PLANNER, nemotron-ultra REVIEWER [dev-only], nemotron-super PLANNER [dev-only], llama-vision PLANNER).

- project-a `01-bug-fix`: planner served (laguna-s), explorer children spawned (3), coder stage starved — `cohere/north-mini-code` `USER_QUOTA_EXHAUSTED`, `next_available` bounded. → `blocked`.
- project-b `02-feature`: 12 north-mini frames (planner/explorer/coder turns), then upstream `429 RATE_LIMITED` on north-mini → `blocked`.
- Total frames: 14 (12 kilo, 2 blockrun). Both runs isolated — no shared workspace, session, or ledger state; no paid or unknown-cost route used (`No paid or unknown-cost route was used` in every admission failure).

## Findings

1. **Concurrency mechanics work**: two runs in flight simultaneously, interleaved frames, per-workspace git isolation, per-run ledgers/journals. No cross-project contamination observed in journals or diffs.
2. **Single quota domain saturates**: all viable roles resolve to the `kilo:source-ip` domain; ~12 north-mini frames + earlier same-window traffic exhausted the upstream allowance → real `429` (`limit_rpd`-class). The capacity governor queued fairly (`QUEUED_FOR_CAPACITY`, `next_available`) until the upstream hard limit.
3. **Fail-closed verified**: quota exhaustion and unqualified roles end `blocked`, never paid fallback, never `completed`.
4. **REVIEWER gap confirmed in-run**: when a coder slot was free, project-b reached review and blocked `REVIEWER_FAILED` — no production-eligible REVIEWER route exists (see R85-SUPPLY-AUDIT).
5. **Verdict**: true two-project *concurrent progress* is demonstrated; two *completed* projects require a second independent quota domain plus a production-eligible reviewer route — external-supply blocked, not scheduler-blocked.
