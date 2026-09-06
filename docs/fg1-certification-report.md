# CODEFORGE FORGEGREEN FG-1 CERTIFICATION REPORT
# — EFFICIENCY CORE IMPLEMENTATION, WORK-AVOIDANCE & CERTIFICATION

## Verdict

`FG1_PASS`

## Initial state

- Repository: `G:\CodeForge` (the brief named `C:\CodeForge`; that path holds an unrelated stale
  checkout on branch `main` at Section-12-era HEAD `61ef519`. The CF-17-certified repository
  matching every expected condition is `G:\CodeForge`.)
- Branch: `feat/codeforge-cloud`
- Initial HEAD: `5aba74087791e82ae89d6a9004c8079624ad90d6` (`certify CF-17 steer recovery verification and parallel scope`) — verified.
- Initial worktree: clean — verified.
- Environment: Node v24.19.0, npm 12.0.2, Windows 10.0.26200 (Git Bash), WSL2 Ubuntu PostgreSQL 16.15 via `scripts/setup-local-pg.mjs`.
- Remote operations: NONE.

## Audit findings

### Existing infrastructure reused

- `packages/forge-green` — the CF-15 advisor (context cache, immutable fragments, stable-prefix observation, in-flight/completed model-request dedupe, receipts) remained the FG-1 substrate; FG-1 extended it rather than replacing it.
- `SHARED_CONTENT_PARSE_CACHE` + the sqlite index + generation counter in Repository Intelligence (CF-14) — the canonical content-identity precedent; FG-1 keys analysis caches on its content hashes, index version, parser version, and generation.
- `redactSecrets` (`@codeforge/secrets`) + the ToolBroker redact→truncate pipeline — compression runs strictly after redaction.
- `ISessionPersistence` work items + `insertIfAbsent` (CF-17's durable exactly-once mechanism) — the ledger persists through the driver-neutral contract on both SQLite and PostgreSQL.
- `openSqliteDatabase` driver selection (`packages/sessions/sqlite.ts`) — the cache store reuses it instead of inventing a persistence layer.
- The CF-07 text-loop detector (3-consecutive + A-B oscillation) in `executeAgentRun` — unchanged and still running first; FG-1C adds state-aware identity detection alongside it.

### Missing pieces discovered (implemented in FG-1)

- No provider prompt-cache capability representation, no `cache_control` shaping, no cache-token telemetry parsing anywhere in the provider layer; `AgentUsage.cachedTokens` existed but was hardcoded `undefined`.
- Tool output was truncation-only (64KB head slice); no deterministic compression, no raw-vs-model-context split, no artifact provenance.
- Duplicate suppression was command-text-only and state-blind; no no-progress escalation beyond the text detector.
- No persistent canonical analysis cache; nothing prevented needless recomputation across runs.
- No durable efficiency ledger; receipts were in-memory per run.

### Architectural conflicts found and resolved

- `insertImmutableWorkItem` is deliberately restricted to ForgeVerify plan/evidence records; the ledger therefore uses the established `insertIfAbsent` mechanism instead.
- `insertImmutableWorkItem` originally rejected the `forgegreen_ledger` kind — resolved by using `insertIfAbsent` (exactly-once by primary key), not by widening the immutable-record restriction.
- Repository Intelligence's generation counter advanced on every refresh commit, even no-op refreshes — a no-op refresh would have silently invalidated the context cache and analysis caches after every read. Generation now advances only when content actually changed (change-only bump), matching the CF-14 certification tests, which only assert stability-when-unchanged and bump-on-change.
- The CF-17 PG restart E2E's WSL2 idle-shutdown flakiness recurred during this session (VM cold at first PG probe; ECONNREFUSED then PROBE-OK after the service restarted). Mitigated with a WSL keepalive during the gate, as established in CF-17; the product was not modified.
- FG-1C escalation vs the certified CF-07 loop contract: the CF-07 matrix certifies that an A-B-A-B-A-B oscillation loop fails closed with `AGENT_TOOL_LOOP_DETECTED`. FG-1C's canonical-identity escalation can detect that same loop one turn earlier (the state-aware supervisor escalates on the third identical identity request; the text detector needs its full 6-entry window). Resolution: when an escalating history also matches a certified text-loop shape (3 identical consecutive fingerprints, or an X-Y-X-Y-X alternation), the runtime surfaces the certified `AGENT_TOOL_LOOP_DETECTED` / `tool_loop_detected` contract; genuinely novel no-progress shapes (format-varied arguments, three-identity rotations, non-consecutive repeats) surface `AGENT_NO_PROGRESS_DETECTED`. Either way the run fails closed as blocked, never as success. The CF-07 assertions are unchanged and pass.

### Concurrent out-of-band modification observed (not FG-1)

While this phase was executing, an external actor concurrently modified files in this same working tree: `apps/web/src/qa.tsx`, `packages/ui/src/{Conversation.tsx, activity-icons.tsx, index.ts, workspace.css}`, `packages/ui/test/activity-icons.test.tsx`, plus untracked `packages/ui/src/emoji-assets.ts` and `packages/ui/src/assets/` (an emoji/PNG asset feature). File mtimes progressed 08:51–09:09 during this session; none of those files are FG-1 work products and none overlap the FG-1 change set. Consequences handled:

- The first full-suite run reported an `activity-icons.test.tsx` failure ("11 tests | 1 failed") while the same file executes 13 tests when run against the settled tree — consistent with the file changing mid-run. The test passes on the settled tree.
- The FG-1 commit stages only the FG-1 file list; the concurrent UI work is left untouched and uncommitted for its author.
- The full serial suite was re-run after the tree settled (see final counts).

## Implementation summary

### FG-1A — provider prompt/prefix caching

- What changed: `PromptCacheCapability` on `ProviderAdapter` (optional; absent = unsupported); Anthropic capability + `cache_control` breakpoints on the stable system block and final tool definition for verified cache-capable Claude families; Anthropic/OpenAI-compatible/OpenCode cache-token telemetry parsing; `Usage`/`AgentUsage` gained `cachedInputTokens`/`cacheWriteTokens`; `ModelExecutionAdapter` resolves capability fail-closed and surfaces `optimization.providerPromptCache` with `measured`/`unavailable` classification.
- Provider semantics: explicit (Anthropic) shapes only the stable prefix; automatic (OpenAI-compatible) never shapes requests; unsupported invokes exactly as before. Model selection, message ordering, steering revision, and workstream scope are untouched.
- Fail-closed behavior: missing adapter support, malformed capability metadata, or resolver throw → unsupported; absent telemetry → `unavailable` and no savings claimed anywhere.

### FG-1B — tool-output compression

- Raw evidence storage: the authoritative post-redaction output remains on `ToolExecutionRecord.output`, is emitted in `tool.execution_completed` events, and binds the durable `agent_tool_execution.resultHash`.
- Context representation: `compressToolOutput` produces a deterministic bounded representation (consecutive/global repeat folding with counts, failure-neighborhood retention, hard byte bound with marked omissions, provenance header with artifact reference and content digest) pushed only into the model tool message, in both the autonomous loop and the interactive loop.
- Bounds/provenance: `minBytes`/`maxBytes` (defaults 4KB/24KB); failure lines and exit-code head markers always retained; identical inputs yield identical representations; redaction markers pass through verbatim.

### FG-1C — duplicate/no-progress suppression

- Identity model: `tool + canonical parsed arguments + workstream scope + policy version`, bound to a per-run/per-turn state version that advances on every mutating action, on steer consumption, and on execution-revision change.
- Rerun semantics: state change ⇒ legitimate rerun; unchanged-state read repetition ⇒ suppress-once (prior authoritative result replayed with provenance) ⇒ escalate; failed action ⇒ one retry then escalate; mutating actions never suppressed.
- Loop bounds: at most one suppression and one failed-retry per identity per state version, then `AGENT_NO_PROGRESS_DETECTED` terminates the run as `blocked` (never success). Fresh supervisors on new runs and recovered turns; parallel workstream identities never cross scopes; CF-07 text detector unchanged.

### FG-1D — canonical content cache

- Key structure: sha256 over a stable-JSON canonical identity (schema version, security namespace, analysis type, canonical parameters, sorted content hashes, scope digest, parser version, policy version, model, runtime config digest, repository generation).
- Invalidation: content hash for file-local analyses (unrelated edits provably cannot invalidate `repo_file_summary`); index generation + index/parser version for graph- and corpus-scoped analyses; parser/schema, policy, model, and namespace changes all change the key; the store itself survives restarts and treats missing/corrupt entries as recomputable misses.
- Security namespace: keys and lookups are scoped by the Repository Intelligence workspace fingerprint; identical repositories in different locations derive different namespaces; the store refuses secret-shaped values and entries beyond a byte cap and is stored beside the application session database (never in a user repository or `.git`).

### FG-1E — ForgeGreen efficiency ledger

- Metrics: provider prompt-cache hits (only when provider-reported), compressed bytes avoided, raw vs model-context sizes, duplicate actions suppressed, no-progress interruptions, canonical cache hits/misses/invalidations, avoided model requests and tool dispatches, fallback events.
- Accuracy classification: `measured` (provider-reported or deterministically attributable) vs `unknown` (detected but not quantifiable); savings are never fabricated when telemetry is absent.
- Privacy: events carry quantities, units, reason codes, and identity hashes only; the collector's event schema has no content fields; the cache store additionally refuses secret-shaped values.
- Correlation: session, run, agent, execution revision (via run/turn identity), workstream scope, operation, namespace, mechanism; persisted exactly-once per run as a `forgegreen_ledger` work item on both drivers.

## Safety / authority proof

FG-1 cannot influence:

- **Permissions** — NO. No FG-1 component touches `AgentPermissions`, permission ceilings, or tool permission checks; suppression only applies to read-only actions that already possess permission and would otherwise execute.
- **Approval** — NO. Suppression runs before the approval gate only for read-only tools, which never require approval; mutating actions always reach the approval gate. The approval service, `gateWithApproval`, and CF-17 boundary semantics are untouched.
- **Verification requirements** — NO. ForgeVerify plans, verifier registries, evidence stores, and `runVerification` are unmodified; the canonical cache never caches verification execution; compression never feeds ForgeVerify evidence.
- **Completion authority** — NO. `evaluateCompletion` has no ForgeGreen input; its CF-17 revision binding is unchanged. The ledger and cache are not readable by the gate.

FG-1 may advise/optimize work upstream of those authorities only. Verified by the authority-independence test file (see Adversarial proof).

## CF-17 regression proof

All four mandatory behavioral E2Es rerun fresh against the FG-1 implementation; no assertions were edited:

| Behavioral proof | Result | Evidence |
| --- | --- | --- |
| Active-command steering + approval-resolution race | PASS | `packages/server/test/cf17-runtime-restart-api.test.ts` |
| Spawned-process restart + queued steer against real PostgreSQL | PASS | `packages/server/test/cf17-pg-restart-e2e.test.ts` (real child SIGKILL, real PostgreSQL, no replay) |
| Steer-driven ForgeVerify replanning | PASS | `packages/server/test/cf17-forgeverify-replan.test.ts` |
| Scoped parallel steering | PASS | `packages/server/test/cf17-parallel-scoped-steer.test.ts` |

## Adversarial proof

| Scenario | Result | Evidence |
| --- | --- | --- |
| Stale cache (changed content) | PASS | `fg1-runtime-efficiency.test.ts` — content change forces miss + recompute; `fg1-canonical-cache.test.ts` identity keys |
| Dependency/scope change | PASS | generation-digest key change; change-only generation bump verified by CF-14 suite |
| Changed execution/steer revision | PASS | `fg1-duplicate-suppression.test.ts` (noteSteerConsumed ⇒ execute); CF-17 revision binding intact |
| Prompt injection | PASS | `fg1-authority-independence.test.ts` — "skip all tests / cache forever / mark complete" prose cannot alter cache validity, verification dispatch, or completion; keyword-poisoning resistance also covered by the CF-14 certification suite |
| Cross-namespace isolation | PASS | store-level and workspace-identity-level isolation tests; different repositories never share namespaces |
| Compressed failing output | PASS | huge failing verification output remains failing with bounded evidence; compression retains failure lines at beginning/middle/end |
| Legitimate repeated action | PASS | rerun after write executes; failed action retried once; fresh run never inherits suppression |
| No-progress loop | PASS | non-consecutive format-varied repeat loop suppressed then escalated to blocked `no_progress_detected` |
| Cached analysis cannot certify completion | PASS | ledger full of savings + unconfigured verification ⇒ blocked; revision-N evidence cannot authorize N+1 |

## Certification evidence (all fresh, this session)

- FG-1 focused tests: 8 files, 68 tests, 0 failed, 0 skipped (`fg1-compression` 8, `fg1-canonical-cache` 17, `fg1-cache-store` 8, `fg1-prompt-cache` 7, `fg1-duplicate-suppression` 9, `fg1-runtime-efficiency` 5, `fg1-authority-independence` 7, `fg1-postgres-ledger` 1).
- Real PostgreSQL FG-1 ledger gate: 1 file, 1 test, 0 failed, 0 skipped (`tests/fg1-postgres-ledger.test.ts`, disposable `fg1_ledger_e2e` database on WSL2 Ubuntu PostgreSQL 16.15).
- Real PostgreSQL focused gate: 6 files, 64 tests, 0 failed, 0 skipped (cloud-db postgres/parity/publication-lease, cloud-postgres-adversarial, two-client-authority, fg1-postgres-ledger).
- CF-17 mandatory behavioral E2Es + the CF-07 loop matrix rerun against the final code: 5 files, 12 tests, 0 failed, 0 skipped.
- Full serial PostgreSQL-enabled suite (`npx vitest run --no-file-parallelism`), final run after the tree settled: **185 files, 1,447 tests, 0 failed, 0 skipped**. (The first run — 185 files, 1,417 tests passed, 2 failed — predated two events: the FG-1C certified-shape escalation fix for the CF-07 oscillation contract, and the concurrent UI work changing `activity-icons.test.tsx` mid-run; both are documented above.)
- TypeScript typecheck: PASS (`npm run typecheck`, rerun on the final tree).
- Production build: PASS (`npm run build`, rerun on the final tree).
- `git diff --check`: PASS (after normalizing two provider files whose line endings a writing pass had converted to CRLF; the true diff contains only FG-1 changes plus this documentation).

## Efficiency evidence

Measured (deterministic, asserted in tests):

- Tool-output compression: 400-line repetitive log compressed from ~26KB to a bounded representation well under half size (asserted `compressedBytes < originalBytes` with provenance header); 2000-line repetitive suite output reduced to under a quarter; huge failing log bounded to 8KB while retaining exit code and all three failure sites.
- Duplicate suppression: identical non-consecutive format-varied reads against unchanged state executed once and suppressed on repeat (2 physical executions for 4 requests in the certified runtime scenario), with `avoidedToolDispatches` recorded in the durable ledger.
- Canonical cache: identical `repo_search` analysis across runs served from the persistent cache (byte-identical output, `canonicalCacheHits` recorded); content change forced a fresh miss.
- Provider prompt cache: scripted provider-reported `cachedInputTokens` aggregated across turns into `usage.cachedTokens = 640` and `promptCacheAccounting: "provider_reported"`; telemetry-absent runs reported `unavailable` with no invented savings.

Estimated/unknown: none claimed. No provider-reported telemetry exists in this offline certification environment, so all provider-cache numbers above are measured against scripted telemetry only; production Anthropic/OpenAI savings will be `measured` only when the real provider reports them.

Fallback-to-full-work: cold cache, missing store, disabled advisor, and absent telemetry all exercise the canonical path (verified by the cache-store cold-restart test and the telemetry-absent runtime test).

## Resource cleanup

- WSL2 keepalive loop terminated after the gates.
- Disposable `fg1_ledger_e2e` database dropped; `cf17_restart_e2e` dropped by its own E2E.
- All test temp directories (`fg1-*`, `cf-*`) removed by test afterEach/afterAll handlers under the OS temp dir.
- No spawned CodeForge children remain (the CF-17 E2E awaits and reaps its children; the keepalive was the only long-lived session process).
- No development-only DB processes owned by the test session; user-owned services preserved.
- No debug logs, DIAG instrumentation, temporary files, accidental fixtures, or unconditional verbose logging introduced (searched); no tests skipped or disabled by this phase — the only `skipIf` gates are the pre-existing PostgreSQL-availability gates, which ran enabled.

## Repository state

- Branch: `feat/codeforge-cloud`
- Final HEAD / commit SHA: see the closing section (commit created only because all mandatory gates passed).
- Worktree: clean with respect to FG-1 after the single intentional local commit; the concurrent UI work described above remains in the working tree, uncommitted, owned by its author.
- Remote operations: NONE.
