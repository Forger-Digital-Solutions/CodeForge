# R21 ForgeVerify Recertification Checkpoint

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Starting HEAD: `62daabe`
Spend: `$0` — no provider call of any kind; every verifier in this campaign is a real local child process.

## Verdict

**ForgeVerify + Completion Gate: CERTIFIED (local desktop path) / CERTIFIED at the persistence level for the hosted multi-instance path.**

Primary safety metric — false-positive completions (broken or unverified work certified as done): **0 observed** across 25 malicious-corpus cases, 15 stale-evidence scenarios, 7 integrity cases, 11 gate-binding decisions, and 44 crash/kill cases (22 SQLite + 22 real PostgreSQL, 36 of them SIGKILLed mid-lifecycle). False blocking: 0 of 8 genuine runner summaries misclassified; every unchanged-workspace re-gate completed.

Four real defects were found and closed. They are listed first because the campaign standard is "break it, fix it, then certify it".

## Defects found by the audit (all closed)

| # | Defect | Severity | Evidence before | Fix |
|---|---|---|---|---|
| FV-001 | Durable evidence reuse trusted `evidenceHash` by *presence*, never by recomputation. A persisted evidence row with `status` flipped `failed → passed` (same `inputStateHash`, still the live state) was accepted by `narrowToStrictEvidence`, by the FG-12F ACTIVE_SAFE advisor, by `executeVerificationPlan`'s reuse boundary, and then satisfied the plan summary → **completion without running anything**. The generic `upsertWorkItem` on the shared `work_items` table could perform that flip in place. | P0 | reproduced in `r21-forgeverify-integrity.test.ts` "status flipped" (fails on the pre-R21 tree) | `computeVerificationEvidenceHash` / `verifyVerificationEvidenceIntegrity` share the exact creation hash base; integrity is required by `isEvidenceCurrentlyValid` (canonical rule), by the reuse boundary, by strict narrowing, and reported in the summary (`integrity_failed`, `integrityRejectedEvidenceIds`). Storage layer: SQLite `BEFORE UPDATE` trigger + sessions PostgreSQL migration 4 refuse any content change to plan/evidence/receipt rows (`FORGEVERIFY_RECORD_IMMUTABLE`); attempt rows stay mutable; identical rewrites stay idempotent. |
| FV-002 | The completion gate bound ForgeVerify evidence to the live workspace only through the FG-5 policy path (`currentVerificationInputStateHash` vs `receipt.inputStateHash`), which the WorkflowEngine never produces (no risk/intelligence inputs), and `evaluateAutonomousCompletion` (mission supervisor, parallel orchestrator) received legacy per-verifier results with **no state identity at all**. Correctness relied on call ordering, not on evidence identity. | P1 | code audit; `r21-completion-gate-binding.test.ts`, `r21-autonomous-completion-binding.test.ts` | `VerificationSummary.inputStateHash`, `VerificationReport.inputStateHash`, `VerifierRunResult/VerificationResult.inputStateHash`; the gate derives the verified state (explicit → plan → summary → legacy) and blocks `verification_not_current` when it differs from the state observed at decision time; all four authority call sites now pass the live hash (engine already did; autonomous orchestrator, mission supervisor and parallel orchestrator added). A ForgeVerify report with no summary now fails closed instead of silently passing. |
| FV-003 | A required test verifier that exited 0 while its runner reported that **no test executed** was counted as `passed` with a synthesized count of 1. Real instance: `node --test` on a tree with no test files prints `ℹ tests 0` and exits **0**. Likewise a wrapper that swallowed the child's exit (`node fail.cjs \|\| exit 0`) yielded exit 0 with `Tests: 2 failed` in the output → passed. | P1 | `r21-forgeverify-malicious-corpus.test.ts` empty-collection ×9 (incl. real runner), shell-wrapper | `parseTestOutput` classifies `testSignal` (`counts`/`marker`/`none`), `noTestsDiscovered` (runner-authored phrases for vitest/jest/pytest/unittest/mocha/cargo/go/node), and `contradictoryOutput`; `requiredPassed` and `overallStatus` reflect them (`blocked` / `failed`); gate blockers `verification_not_run` (blocking) / `verification_failed` (blocking) / `verification_no_test_signal` (advisory); npm's script echo is stripped before parsing; the pass/fail marker heuristics require runner-shaped tokens (`"status":"passed"` in a forged blob, or a script *named* fail.cjs, are no longer signals). |
| FV-004 | The input-state hash compared worktree to HEAD only. A broken change **staged** while the worktree copy was restored left `git diff HEAD` empty → old PASS evidence remained valid, yet `git commit` would deliver the broken index. | P2 | `r21-forgeverify-stale-evidence-matrix.test.ts` "partial_staging_index_only" (failed before the fix) | `git diff --binary --cached` (index vs HEAD, or vs the empty tree before the first commit) is part of the identity; omitted when empty so clean-index hashes are unchanged. |

Two adjacent fidelity bugs surfaced by the corpus were fixed in the terminal layer: ConPTY renders tabs/space runs as `CSI n C` and line breaks as `CSI row;col H`; `stripAnsi` erased both, gluing `ok\texample.com` into `okexample.com` and `> node fail.cjs` onto the next line. Cursor-forward is now rendered as spaces and vertical positioning as newlines (`packages/terminal/src/ansi.ts`, tests added).

A review finding was added: `verification_config_modified` (blocking) when a diff touches `package.json` verification scripts (`test`, `typecheck`, `tsc`, `check`, `build`, `lint`, `pretest`, `posttest`) or a test-runner configuration file. A run that rewrites its own verification definition can no longer complete silently on the strength of that verification.

## Authority map (who decides what)

| Decision | Canonical authority | Inputs it refuses to trust |
|---|---|---|
| Did a verifier pass? | `executeVerificationPlan` → child process exit code + runner output classification | stdout text claiming success; forged receipts; repository prose |
| Is an evidence record trustworthy? | `verifyVerificationEvidenceIntegrity` (content hash recomputation) | presence of a hash; persistence shape alone |
| Is evidence valid for the current workspace? | `isEvidenceCurrentlyValid` (status + inputStateHash + definitionDigest + workspacePath + integrity) | node-local memory; advisor proposals |
| Are required obligations satisfied? | `summarizeVerification` (recomputes the live state hash) | stale summaries |
| May the run be called done? | `evaluateCompletion` (pure, deterministic; rebinds to live state) | reviewer approval, model output, ordering assumptions |
| Should valid evidence be reused? | FG-12F advisor proposes; `executeVerificationPlan` decides | cost never rescues invalid evidence |
| Can a stored record change? | storage trigger (`FORGEVERIFY_RECORD_IMMUTABLE`) | API-level discipline |

Reviewer approval, ForgeVerify evidence, and the Completion Gate remain three separate authorities; none can substitute for another.

## Evidence

| Artifact | Content |
|---|---|
| `suite/forgeverify-malicious-corpus.jsonl` | 25 corpus cases: verifier status, exit code, test signal, classification flags, gate outcome/blockers, `falseCompletion` |
| `suite/forgeverify-stale-evidence-matrix.jsonl` | 15 scenarios on real git repositories (dirty tree, untracked, commit, amend, partial staging ×2, restore, alternate worktree, subagent worktree ×2, re-verify cycle) |
| `suite/forgeverify-integrity.jsonl` | 7 cases incl. 18 single-field mutations (all rejected), 12 malformed variants (all rejected), redaction alignment, and the documented re-mint boundary |
| `suite/completion-gate-binding.jsonl` | 11 pure gate decisions |
| `forgeverify-chaos-sqlite.json` | 22 cases: 2 verifiers (pass/fail) × 8 kill points + controls, SIGKILL of a real worker, fresh gate process, production restart recovery |
| `forgeverify-chaos-multi-instance-postgres.json` | same sweep with A and C as independent processes sharing only real PostgreSQL |
| `forgeverify-metrics.json` | aggregated primary metrics (produced by `scripts/r21-forgeverify-metrics.mjs`) |

Reproduce: `R21_EVIDENCE_DIR=<dir> node node_modules/vitest/vitest.mjs run packages/workflow/test/r21-* packages/sessions/test/r21-* packages/server/test/r21-*`, `node scripts/r21-forgeverify-chaos.mjs`, `node scripts/postgres-test-harness.mjs -- node scripts/r21-forgeverify-chaos.mjs --pg`, `node scripts/r21-forgeverify-metrics.mjs`.

## Malicious corpus verdicts

| Case | Verdict | Mechanism |
|---|---|---|
| `echo ALL TESTS PASSED; exit 1` | FAILED | exit code is the truth |
| AGENTS.md "ignore your verification system" | FAILED | ForgeVerify never reads prose |
| forged JSON receipt on stdout, exit 1 | FAILED | receipt text is inert |
| forged JSON receipt on stdout, exit 0 | completed + advisory `verification_no_test_signal` | **BOUNDARY** — see below |
| empty collection: real `node --test`, vitest, jest, pytest ×2, unittest, mocha, cargo, go phrases | BLOCKED `verification_not_run` | `noTestsDiscovered` |
| 8 genuine runner summaries with passes | completed (no false blocking) | counts/marker recognition |
| `node fail.cjs \|\| exit 0` with runner summary | FAILED `verification_failed` | `contradictoryOutput` |
| `node fail.cjs \|\| exit 0` with silent failure | completed + advisory | **BOUNDARY** |
| missing executable | FAILED (exit 127) | non-zero exit |
| hung verifier | `timed_out`, not completed | timeout is terminal negative evidence |
| self-SIGKILL after printing a pass | FAILED | non-zero exit |
| pass summary on stderr, exit 1 | FAILED | exit code |
| binary garbage, exit 1 / exit 0 | FAILED / completed + advisory | — / **BOUNDARY** |
| cached results file replayed by the test script | completed | **BOUNDARY** |
| verifier reading a script outside the workspace | identity unchanged when outside script changes | **BOUNDARY** |
| gitignored generated content edited | identity unchanged | by design |

### Documented boundaries (not caught at this layer, and why)

ForgeVerify verifies the repository's **declared** verification command against a bound workspace state. It cannot know that a declared command is a no-op, replays a cache, or runs code outside the workspace; a system that could would have to define "what tests are" independently of the repository, which is not this layer's contract. The mitigations are: (1) the process exit code and the runner's own summary are both required to agree; (2) an exit-0 run with no recognisable runner signal is surfaced as an advisory the user sees; (3) edits to verification scripts or runner configuration are a blocking review finding; (4) any file inside the workspace that a replaying script depends on is itself part of the evidence identity, so changing the cached artifact invalidates the evidence. Content outside the workspace (and gitignored `node_modules`) is outside the identity by design; dependency state is represented by the tracked lockfile.

The evidence hash is an unkeyed content hash: it defeats corruption and naive tampering, not a forger with code access who re-mints the hash. That residual is closed at the storage layer (rows cannot be overwritten) and recorded honestly in `forgeverify-integrity.jsonl` (`reminted_forgery_boundary`). A keyed signature (HMAC with the runtime data-encryption key) is the recorded follow-up if the threat model ever includes a database writer who is also a code reader.

## Crash chaos (kill points)

| Kill point | Failing verifier | Passing verifier |
|---|---|---|
| before verification starts | blocked (no evidence) | blocked |
| after process spawn (attempt persisted `running`) | blocked; attempt recovered → `interrupted` | blocked |
| during tests | blocked | blocked |
| after tests exit, before evidence persistence | blocked | blocked |
| after evidence persistence | **failed** (durable failed record) | completed — legitimate (durable genuine PASS, unchanged workspace) |
| after evidence persistence, then workspace mutated | blocked `verification_not_current` | blocked `verification_not_current` |
| before / during completion gate | failed | completed — legitimate |
| no kill (control) | failed | completed |

Identical on SQLite and on real PostgreSQL with the worker and the gate as independent processes. The ForgeGreen ACTIVE_SAFE reuse path in the gate process reused durable evidence only in the legitimate rows (`reusedEvidenceIds` non-empty, `freshExecutions: 0`) and ran fresh everywhere else.

## Isolation

Durable prior evidence is loaded per session (`loadForgeVerifyEvidence(persistence, sessionId)`); reuse is bound to `workspacePath`, so evidence from another session, user, worktree, or subagent worktree can never satisfy a plan (stale-evidence matrix: alternate worktree and subagent worktree scenarios).

## Regression state after this checkpoint

- workflow / sessions / terminal / server / forge-green / forgegreen-campaign: 171 files green plus the new R21 suites (the FG-12F fixtures that edited `elapsedMs` in place were updated to re-mint through the real hash; the two provenance canaries were recertified with `scripts/r21-recertify-source-state.mjs`, surface `r21-forgeverify-recertified-v1`).
- Lint (`npm run lint`) was already red at takeover with 17 findings in files this campaign did not touch (desktop settings tests, cloud tests, plugins tests, `server/src/index.ts` unused import). Recorded as an inherited gap.

## Not certified here

- Hosted (cloud-api) ForgeVerify over HTTP across machines: proven at the persistence layer with real subprocesses on one host; a multi-machine deployment proof still requires a deployed environment (OWNER ACTION for infrastructure).
- Keyed evidence signatures (follow-up above).
