# R45 Baseline

Recorded at R45 start before any code change.

## Repository

- Branch: `codex/r29-release-closure`
- HEAD: `bd1cd09c90d63b18a6380e5d5842f22bff432ea0` — `R44 final: closure
  matrix, live mission record, source-state recertification`
- Source-state identity: `d863c424…` / `r44-multifile-intelligence-v1`
- Certified doc: `docs/codeforge-forgegreen-certified-source-state.json`
  carries the R44 recertification entry (55th), `compress.ts` in material set.

## Dirty state

Exactly the two intentionally preserved pre-existing workbench scripts:

- `scripts/r11-codeforge-bench-r2-executor.mjs`
- `scripts/r20-postgres-admission-benchmark.mjs`

No unexpected drift. Nothing else dirty, nothing untracked outside
`docs/evidence/` output pending from this campaign.

## Canary status

`fg11-source-state.test.ts` + `fg12e-harness-provenance.test.ts`: **8/8 green**
at R44 HEAD — the live tree matches the certified document.

## R44 handoff defects (to fix, not revisit)

1. Normal topology too call-hungry for free windows (9–14 calls available vs
   ~15–20 needed; 18/18 live arms blocked on `RATE_LIMITED`).
2. Explorer serialization — one explorer burned all 10 turns on a 4-file
   fixture (`AGENT_MODEL_TURN_LIMIT`), one tool per turn.
3. Live duplicate suppression: still 0 (deterministic proof stands).
4. Hash auto-attach: deterministic-only proof (models supplied hashes live —
   good behavior; path unexercised).
5. Structured-output rejections persist on some models (empty `summary`).

## R44 carried-forward working machinery (do not regress)

- Observed-state edit gate + `EDIT_MISSING_STATE` + recovery recipe.
- Hash auto-attach + `CONTEXT_EVIDENCE_STALE` drift denial.
- Bounded structured-output repair + `exhausted` telemetry + route penalty.
- `converged_failed` journal on structured exhaustion.
- `buildReviewerDiffContext` full-diff reviewer visibility.
- `evaluateCompletion` sole completion authority; ForgeZero verified-free only.
