# R43 Multi-File Root-Cause Analysis

Sources: live corpus traces (`R43-MULTIFILE-AB.json`, `R43-LIVE-SUPPRESSION*.json`),
persisted session DBs (`r43-*-*.db` event streams), code audit of the reviewer spawn
path.

## Observed failure modes (ranked by frequency across traces)

### 1. Malformed structured output — `AGENT_INVALID_STRUCTURED_OUTPUT`
The single most common turn failure across runs: children end their turn with
`Expected non-empty string for summary` or `Structured output is not valid JSON`.
Free-tier coding models frequently emit prose with embedded ```json fences instead
of the exact schema. The runtime correctly fails the turn closed; the orchestrator
retries/fails over where bounded. This is a *model conformance* weakness, not a
ForgeGreen mechanism defect — it appears identically in baseline arms.

### 2. `edit_file` first-attempt failures with recovery re-reads
Trace (mf-rename baseline): model submits multi-line `oldText` without
`expectedHash` → `TOOL_EXECUTION_FAILED` → model re-reads the file (identical
`read_file` args) → retries with `expectedHash` + minimal `oldText` → succeeds.
These recovery re-reads *are* suppression candidates, but the coder child runs
under `CONSERVATIVE` policy (`COORDINATED_MULTI_STEP` signal), where the
classifier bounds no-progress loops but never replays prior output. Correctly so:
replaying a read after a failed write attempt is exactly the case R42 made
conservative.

### 3. Provider saturation mid-run — `PROVIDER_RATE_LIMITED` / `PROVIDER_MODEL_UNAVAILABLE`
The corpus ran through two supply dead-windows (OpenRouter `:free` RPM, groq/mistral
RPM after two parallel corpora). Zero-call blocks are honest fail-closed
admissions: every eligible route was hard-excluded by the live health authority
and no paid fallback was attempted. Failover (`router.failover` events) fired on
runs that had supply left.

### 4. Reviewer context truncation — FIXED in R43
`autonomous-orchestrator.ts` sliced the entire diff to 2,000 chars before handing
it to the reviewer, so any multi-file diff larger than ~2KB was reviewed on a
partial view — the reviewer could pass files it never saw. Additionally the same
truncated diff was injected into the reviewer slot `verificationEvidence`,
rendering a "Verification Results" section containing diff text when
verification had not run yet. R43 fix (`c5e6a5c`): reviewer now receives the full
`--stat` inventory plus a 24KB-bounded diff body with an explicit truncation
marker telling it to re-run `git diff` in the worktree for the remainder; the
verification-evidence field is no longer populated with diff text.

### 5. Explorer turn-budget exhaustion on wide workspaces
`hub-consumers`/`wide-explore` explorers hit the 10-model-turn ceiling
(`AGENT_MODEL_TURN_LIMIT`) while enumerating 20+ files. Duplicate suppression
*would* have helped here (fewer tool turns per exploration), but the identical-
call predicate never arose: free models issue `list_files`/`read_file` per file,
not repeated identical calls.

## Why zero live suppressions is honest, not a mechanism failure

Duplicate replay only fires when ALL hold: (a) run policy FULL (explorers/planners
on fresh evidence — coders and review/repair contexts are CONSERVATIVE by design);
(b) an identical read-only call with canonical-equal args; (c) unchanged state
version AND unchanged filesystem/index evidence; (d) prior successful execution.
In ~40 arm-runs across three supply windows, no FULL-policy run emitted an
identical repeat read. The deterministic suites (16/16) prove the branch fires
correctly when the predicate does hold, and `preventedReplays` (3 total across
runs) proves the epoch mechanism is live.

## Mechanism-specific policy change (evidence-supported)

- Reviewer diff context: fixed (above).
- No global Green disabling — corpus shows Green arms never degraded outcomes
  relative to baseline on identical tasks (worst case: BOTH_FAIL; one
  BASELINE_FAIL_GREEN_PASS on coordinated-api).
- No forced FULL — coder runs correctly resolve CONSERVATIVE under coordinated
  multi-step signals.
