# R39 Phase 4 — ForgeGreen Live A/B Corpus (n=6 pairs)

Evidence class: **LIVE_FREE_PROVIDER**. Driver: `scripts/r39-live-ab.mjs` (reusable, multi-provider). Artifact: `forgegreen-corpus.json` (full call log per arm).

Design: six real engineering tasks on isolated git fixture repos, run through the production `AutonomousRunOrchestrator` with real verified-free providers (openrouter + groq + mistral registered; router free to choose). `topology: "normal"` pinned to exercise explorer+coder+reviewer paths. Arm order alternated per pair to reduce order bias. Green arm enables `duplicateSuppression`/`toolOutputCompression`/`supersededCompaction`; baseline disables all three.

## Per-pair results

| Task | Class | Outcome | Baseline calls / in-tok / wall | Green calls / in-tok / wall |
|---|---|---|---|---|
| cfg-edit | tiny | BOTH_PASS | 20 / 58,581 / 137.4s | 13 / 37,260 / 58.2s |
| add-fn | small | **BOTH_FAIL** | 19 / 48,673 / 89.4s | 22 / 59,657 / 92.5s |
| bug-fix | small | BOTH_PASS | 23 / 71,664 / 119.5s | 24 / 74,968 / 112.1s |
| rename | tiny | BOTH_PASS | 28 / 90,225 / 134.0s | 25 / 80,100 / 108.1s |
| guard | small | BOTH_PASS | 25 / 79,648 / 131.4s | 19 / 59,522 / 102.7s |
| sum | tiny | BOTH_PASS | 20 / 58,284 / 93.3s | 12 / 34,680 / 58.5s |

## Statistics (quality-equivalent pairs only, n=5)

- Green/baseline **requests** median ratio **0.760** (range 0.60–1.04) — median ~24% fewer calls
- Green/baseline **input tokens** median **0.747** (0.60–1.05) — median ~25% fewer billed input tokens
- Green/baseline **output tokens** median **0.756**; **wall time** median **0.782**
- **Aggregate VWM**: requests **1.247×**, input tokens **1.251×** (vs 1.64× on R38's n=1 — the earlier estimate was optimistic; the distribution median is the honest figure)

## Regressions and failures (honest, not hidden)

- **bug-fix Green regression**: green used +1 call and +4.6% input tokens. Both verified successfully. Cause under the hood: green's compacted context didn't eliminate a retry; savings didn't materialize on this pair. Shown, not hidden — range reported above.
- **add-fn BOTH_FAIL**: both arms `blocked`, `taskAttempts=1`, `verificationAttempts=0` — the coder never produced a verifiable write. Symmetric across arms → task-level capability limit of the selected free models (dots-3-note-preview + north-mini-code), not a ForgeGreen defect. Excluded from VWM by the paired design.
- **Provider concentration**: 100% of ~240 corpus calls routed to openrouter models despite groq + mistral being verified — role-suitability prefers them; concentration risk is logged as evidence (Phase 16), not an aesthetic concern.

## False waits

Zero wait events across all 12 runs.
