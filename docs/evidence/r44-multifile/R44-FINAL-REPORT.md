CODEFORGE R44 FINAL

# Verdict

**R44 PARTIALLY VERIFIED — one live completion, honest supply-bound negatives**

Every defect identified from R43 telemetry was fixed, regression-pinned, and
re-proven deterministically. The headline improvement over R43: **one live
mission completed end-to-end on verified-free supply** — the first verified
live completion in the campaign's evidence — while the normal-topology corpus
remained blocked by provider rate limits. The unfinished claims are carried
forward explicitly, not laundered.

# Starting point

- Branch `codex/r29-release-closure` at `42c5d39` (R43 close, PARTIALLY
  VERIFIED).
- R43 open items: live duplicate suppression unobserved (~40 arms); reviewer
  context fix needed regression proof; `AGENT_INVALID_STRUCTURED_OUTPUT` the
  leading live failure; provider churn dominated; multi-file weakest.
- Worktree carried two user-preserved benchmark scripts (untouched throughout).

# What changed

1. **Structured-output repair hardening** (`a2d2a7f`): ordered bounded repair
   (fenced block → brace extraction → trailing-comma strip) with recorded
   `repairStrategies`, bounded rejection telemetry, exhaustion →
   `AGENT_INVALID_STRUCTURED_OUTPUT`, and a route-reliability penalty
   (`structured_output_failure`) on exhaustion. Canonical `EDIT_MISSING_STATE`
   added.
2. **First-edit discipline** (`0b3b93e`): an observed-state gate denies
   blind mutations of existing files with the read→hash→retry recovery recipe;
   observed-but-unhashed edits get the hash auto-attached with staleness still
   enforced (`CONTEXT_EVIDENCE_STALE`); `EditAttemptRecord` telemetry lands on
   the run journal; tool failures carry canonical `[CODE]` prefixes;
   write/edit replies surface `[hash:H]` for the next edit.
3. **Journal stopReason fix** (`b791f87`): structured-output exhaustion
   returned a blocked result but never assigned the local `stopReason`, so
   `finally` journaled the `"completed"` placeholder — false terminal state
   feeding recovery classification. Fixed and regression-pinned.
4. **Byte-exact edit guidance** (`b791f87`): the `target_not_found` error now
   states the byte-for-byte requirement (corpus coders paraphrased `oldText`).
5. **Reviewer visibility regression** (`c28eff9`): the reviewer diff-context
   construction extracted to `buildReviewerDiffContext`; a planted defect
   beyond the retired ~2KB slice is provably reachable (3/3).
6. **Compression real-world formats** (`68c434f`): failure pattern extended to
   Jest `●` bullets, Rust `panicked at`, `Segmentation fault`, core-dump and
   timeout lines; two genuine coverage gaps found by the new suite and closed
   (9/9 new + 9/9 existing).
7. **Explorer prompt nudge** (`68c434f`): explicit instruction to batch
   independent read-only lookups rather than serialize one per turn.
8. **Provider-saturation campaign** (`80c1c32`): 28/28 deterministic checks —
   no paid fallback, no false waiting, genuine-exhaustion queueing, health-TTL
   recovery, catalog-retirement handling, role qualification, reservation
   hygiene, mid-run mutation honoring.
9. **Multi-file corpus harness + journal telemetry** (`80c1c32`,
   `627b46b`): seven task families, baseline/green arms, production
   orchestrator, per-role `agent_run_journal` telemetry harvest, observed
   rate-limit cooldown pacing, per-attempt session ids.
10. **Role-level benchmark** (`99b1970`): 15/15 deterministic role checks.
11. **16-Bit prep** (`778042c`): evidence schema + authorization gate +
    readiness doc; zero paid calls.
12. **Source-state recertification** (this commit): `compress.ts` enters the
    certified material set; fg11/fg12e canaries green over the final surface.

# Live evidence

## The completed mission

`r44-distributed-bug` on the adaptive → **tiny** plan (Coder + ForgeVerify):

- `status: completed` through `evaluateCompletion`; `node
  tests/report.test.mjs` exit 0 on the agent's diff.
- Correct root-cause file changed (`src/normalize.mjs` — the test pointed at
  `report.mjs`).
- 7 calls, 22,770 in / 565 out tokens, 12.3s wall.
- One `RATE_LIMITED` mid-run; failover `cohere/north-mini-code:free →
  codestral-latest` completed the work.
- First `edit_file` carried a model-supplied `expectedHash`; outcome success.

## The blocked corpus (honest negative)

- 14 corpus arms + 4 retry arms: **all blocked, every failure
  `RATE_LIMITED`**, zero paid fallback, zero fake success.
- Windows deliver ~9–14 calls before 429s; a normal topology needs ~15–20.
- Explorer turn serialization persists on weaker models: one retry's explorer
  consumed all 10 turns one tool at a time (`AGENT_MODEL_TURN_LIMIT`) on a
  4-file fixture.
- Structured-output rejections still occur (empty `summary`); now journaled
  truthfully as `converged_failed`.
- Natural duplicate suppression: 0 live observations (deterministic proof
  stands; live evidence outstanding).

# Regression record

- R44 targeted surface: **71/71** (edit-discipline 6/6 incl. journal pin,
  reviewer-visibility 3/3, compression-formats 9/9, fg1-compression 9/9,
  structured-output-security 19/19, orchestrator-integration 8/8,
  fg1-runtime-efficiency 8/8, plus tool suites).
- forgegreen-campaign + workflow: **326 passed / 1 skipped**, including the
  recertified fg11/fg12e source-state canaries.
- Saturation sim 28/28; role benchmark 15/15; compression proof 18/18.

# Provenance

- Commits `1e8deb7` → `b791f87` + closure commit on
  `codex/r29-release-closure`.
- Certified source state re-issued: `d863c424…` under surface
  `r44-multifile-intelligence-v1` (55th recertification entry).
- Evidence: `docs/evidence/r44-multifile/`, `r44-provider-saturation/`,
  `r44-role-benchmark/`, `r44-16bit-prep/`.
- Harnesses: `scripts/r44-multifile-corpus.mjs`,
  `r44-provider-saturation.mjs`, `r44-role-benchmark.mjs`,
  `r44-recertify-source-state.mjs`.

# Handoff to R45

1. Re-run the normal-topology corpus when a wider capacity window opens —
   supply, not machinery, was the binding constraint.
2. Explorer serialization is the strongest residual defect: consider a
   deterministic read-plan scaffold (emit candidate file list in one turn)
   rather than relying on prompt-level batching for weak models.
3. Live duplicate suppression still needs a natural trigger — consider a
   corpus family that provokes a repeated read after a state change.
4. Measure whether route-quality penalties from structured-output exhaustion
   shift route selection over a longer campaign.
