# R44 Closure Matrix — Proven / Unproven

Branch `codex/r29-release-closure`. Standard: *fix the defects, prove the fixes,
leave unproven things explicitly unproven.* Every claim below cites its evidence
kind: **test** (committed regression), **sim** (deterministic harness), or
**live** (real free-provider run). Live claims are never made on the strength of
a test or a sim.

## PROVEN

| # | Claim | Evidence |
|---|-------|----------|
| 1 | Blind `edit_file`/`write_file` on an existing file is denied with `EDIT_MISSING_STATE` plus the read→hash→retry recipe, before the broker can write | test: `r44-edit-discipline.test.ts` (6/6) |
| 2 | Observed-but-unhashed `edit_file` gets the observed hash auto-attached; drifted files deny `CONTEXT_EVIDENCE_STALE`; new-file writes stay open | test: same suite |
| 3 | Post-edit `observedFileState` holds the post-edit hash — follow-up edits chain correctly | test: same suite; live: tiny mission's coder edited successfully |
| 4 | Structured output has bounded deterministic repair (fenced → brace → trailing-comma), records `repairedWith`, rejections, `exhausted`; exhaustion → `AGENT_INVALID_STRUCTURED_OUTPUT` + route reliability penalty | test: `structured-output-security.test.ts` (19/19), `r44-edit-discipline` |
| 5 | Structured-output exhaustion journals `converged_failed`, not `completed` (stopReason bug found by corpus telemetry, fixed, regression-pinned) | test: `r44-edit-discipline` journal assertion; live: was the anomaly that exposed the bug |
| 6 | Reviewer sees the complete multi-file diff; a planted defect beyond the retired ~2KB slice is reachable in reviewer context | test: `r44-reviewer-visibility.test.ts` (3/3) |
| 7 | Compression is deterministic, bounded, retains failure neighborhoods incl. Jest `●`, Rust `panicked`, `Segmentation fault`, TAP/Vitest/pytest/go formats; raw output stays authoritative | test: `fg1-compression` (9/9) + `r44-compression-formats` (9/9) |
| 8 | Canonical bracketed error codes reach `ToolExecutionRecord.error` | test: covered by edit-discipline + tools suites |
| 9 | Free Capacity Fabric never pays, never falsely waits when eligible capacity exists, queues only on genuine exhaustion, honors health TTL, retires catalog routes, enforces role qualification, releases reservations | sim: `scripts/r44-provider-saturation.mjs` — 28/28 checks |
| 10 | Role-level behavior: explorer/planner/coder/reviewer contracts, budgets, telemetry all deterministic | harness: `scripts/r44-role-benchmark.mjs` — 15/15 |
| 11 | One live mission **completed** end-to-end on free supply: correct root-cause file changed, ForgeVerify test passed, completion gate passed, failover recovered a mid-run 429, first edit carried a model-supplied hash | live: `R44-MISSION-TINY-1.json` |
| 12 | All live failures are honest: 42+ RATE_LIMITED blocks, zero paid fallback, zero fake success, fail-closed route parking | live: `R44-MULTIFILE-CORPUS.json` + retries |
| 13 | Edit failure messages are byte-exact actionable (`oldText` copy requirement stated explicitly) | code: `packages/tools/src/index.ts` |
| 14 | Source state recertified over the final R44 surface (compress.ts added to material set) | test: fg11/fg12e canaries green post-recert |

## UNPROVEN (explicitly)

| # | Claim | Status |
|---|-------|--------|
| U1 | **Normal-topology live multi-file completion.** 14 corpus arms + 4 retries all blocked by RATE_LIMITED windows (~9–14 calls available vs ~15–20 needed). The full Explorer→Coder→Reviewer→ForgeVerify chain is proven in tests and the tiny plan completed live, but a normal-plan live completion was not observed. | Outstanding — supply-bound |
| U2 | **Natural live duplicate suppression.** 0 suppressions across all R44 live arms. Proven in deterministic tests; live suppression remains unobserved (same honest negative as R43). | Outstanding |
| U3 | **Hash auto-attach observed live.** Live coders supplied hashes themselves (`hashSupplied` seen; `autoAttach` stayed 0). The path is test-proven; a live trigger has not occurred. | Outstanding — model behavior already conforms |
| U4 | **Explorer turn efficiency.** retry-3's explorer burned all 10 turns serially (`AGENT_MODEL_TURN_LIMIT`) on a 4-file fixture despite the batching prompt nudge. Weak free models serialize regardless. | Residual defect — mitigated by prompt, not solved |
| U5 | **Structured-output first-try quality.** Rejections still occur live (empty `summary`). Now recorded truthfully with route penalties; the repair layer recovers prose-wrap/fencing cases, but model adherence is unchanged. | Partially improved, live improvement unmeasured |
| U6 | **Coordinated multi-file work at scale.** The large-diff family never reached a reviewer live. Reviewer visibility is proven by test; the live pipeline was supply-blocked before review. | Outstanding — supply-bound |
| U7 | **16-Bit lane.** Schema + authorization gate + readiness doc prepared; zero paid calls made by design. | Prepared, not executed |

## Integrity notes

- No gate weakened: `evaluateCompletion` is still the only completion authority;
  stale writes still fail closed; suppression still requires state evidence.
- No paid calls: every model call across the campaign used a verified-free route.
- Evidence artifacts were not rewritten; the corpus JSON preserves the all-blocked
  record alongside the later completed mission.
- Two pre-existing dirty scripts (`r11-codeforge-bench-r2-executor.mjs`,
  `r20-postgres-admission-benchmark.mjs`) are unrelated workbench state, preserved.
