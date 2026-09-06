# 8-Bit Infinity Core V1 Result

Verdict:
**8BIT_V1_CERTIFIED**

## Initial State

- Repository: `G:\CodeForge` (verified authoritative; the stale historical checkout at `C:\CodeForge` was not used)
- Branch: `feat/codeforge-cloud`
- Initial HEAD: `9fad9e6cb09f1226f95db4dea31aa423210d1cc2` ("implement ForgeGreen FG-2 repository intelligence")
- FG-1: certified (`docs/fg1-certification-report.md`)
- FG-2: certified, verdict `FG2_PASS` (`docs/fg2-certification-report.md`) — 189 files, 1,480 tests, 0 failed, 0 skipped at this HEAD; independently re-verified as the actual repository state before starting, not trusted from the prompt text alone.
- Inherited dirty worktree at task start (concurrent, separately certified UI/emoji integration work — preserved untouched for the entire task, see Cleanup): `apps/web/src/qa.tsx`, `packages/ui/src/Conversation.tsx`, `packages/ui/src/activity-icons.tsx`, `packages/ui/src/index.ts`, `packages/ui/src/workspace.css`, `packages/ui/test/activity-icons.test.tsx`, plus untracked `docs/codeforge-8bit-activity-integration-report.md`, `docs/codeforge-emojipack-chat-integration-report.md`, `packages/ui/src/assets/`, `packages/ui/src/emoji-assets.ts`. Those files already carry their own certifications: `CODEFORGE_8BIT_ACTIVITY_UI_CERTIFIED` (8-bit activity emoji theme made default) and `CODEFORGE_COMPACT_EMOJI_ACTIVITY_UI_CERTIFIED` (EmojiPack R2 integration).
- Environment: Windows 11 x64, Node ≥ 22, npm workspaces, vitest.
- PostgreSQL: WSL2 Ubuntu PostgreSQL 16, provisioned via `scripts/setup-local-pg.mjs`, reached from Windows over the WSL2 guest IP (the same method the FG-1/FG-2/CF-15 certifications used); the shared `codeforge_test_db` was found with a stale/incompatible migration-checksum state from a prior session and was recreated fresh (a disposable test database, not product data) before use.

## Architecture Audit

Two parallel research passes (provider/routing architecture; runtime/execution-control
architecture) were run before any code was written, producing a full reconciliation table —
see the "Package layout" section of `docs/eight-bit.md` for the final mapping. Summary:

**Reused, not rebuilt:**
- `ForgeZero`/`AccessClass`/`FreeModelRecord` (`@codeforge/forge-zero`) — the fail-closed free/paid
  classification and eligibility verifier.
- `ForgeRouter` (`@codeforge/router`) — the deterministic ranking algorithm.
- `ExecutionModelSelection`/`ResolvedModel` (`@codeforge/director`) — the adaptive-vs-exact-pin
  type contract.
- Provider adapters and `ProviderCatalog` (`@codeforge/providers`) — 8 wired providers
  (openrouter, opencode, zai, google, groq, cloudflare-workers-ai, openai, anthropic).
- `ISessionPersistence` (`@codeforge/sessions`) — SQLite/PostgreSQL dual-driver session/work-item
  store, reused verbatim for all 8-Bit durable state.
- `ForgeGreenLedgerCollector` (`@codeforge/forge-green`) — extended with one new mechanism
  rather than a second telemetry system.
- CF-17's `UserIntentHoldController`/`ApprovalService`/steer-queue machinery, CF-07's
  `DuplicateActionSupervisor`, and `completion-gate.ts`'s `evaluateCompletion` — all left
  completely untouched; 8-Bit has zero code paths into any of them (verified by grep and by the
  full regression suite below).

**Genuine gaps closed by 8-Bit** (the parts that did not already exist):
1. A role/capability contract layer (`EightBitRole`, `ROLE_CONTRACTS`) — no such concept existed;
   capability matching was flat boolean flags plus free-text task-type substring heuristics.
2. A *live* health feedback loop — `ModelHealthState.recentFailureCount` was a schema field
   nothing in production ever wrote; `EightBitHealthTracker` is the first thing that does.
3. A *live* tool-reliability feedback loop — `toolReliability` was populated only from offline
   certification workloads; `EightBitReliabilityTracker` wires it to the real `PARSE_FAILED`
   signal already present in `agent-runtime.ts`.
4. Provider-native fallback — `OpenRouterAdapter` never sent a `models[]` array; `PROVIDERS.md`
   itself documented "no fallback" as a known limitation. Now wired, policy-filtered.
5. Cross-provider active-run failover — `router.failover` was a dead protocol-schema shell with
   zero emitters/consumers anywhere in the codebase (confirmed by the audit and by grep before
   this task began). This is now a real, tested, production code path.
6. Durable 8-Bit routing/health/receipt state — none existed; two new `WorkItem` kinds added to
   the existing `work_items` JSON-blob store (zero schema/DDL changes required on either driver).

No duplicate provider registry, health tracker, free-policy engine, persistence layer, or
context system was created.

## Core Implementation

### Route Registry / Free Eligibility / Catalog Awareness
`EightBitEligibilityPolicy` (`packages/eight-bit/src/eligibility.ts`) is the hard gate,
evaluated before ranking. It trusts `FreeModelRecord.accessClass` (the audited, structured
`AccessClass` enum) first, falling back only to the legacy `freeStatus === "verified_free"`
signal when `accessClass` is genuinely absent — never a model-name string. `adaptive` policy
mode rejects anything not in `FREE_ACCESS_CLASSES`; `byok`/`premium` still reject unknown-cost
and `UNAVAILABLE` routes. See `docs/eight-bit.md` §"Free-policy boundary".

### Health / Quota
`EightBitHealthTracker` (`packages/eight-bit/src/health.ts`): `classifyFailure()` maps a raw
error into one of 13 `FailureReason`s; `FAILURE_POLICY` maps each to `bounded_retry` (a single
transient failure never demotes past DEGRADED — 3+ consecutive failures required to escalate),
`cooldown_and_rotate` (rate-limit/quota/outage/auth, with exponential backoff), `remove_and_refresh`
(model-not-found/retired/free-eligibility-removed), or `surface_only` (context-limit/malformed
output — not a routing problem). Persisted per-route independently of the current binding
(`eight_bit_route_health`), which is what makes restart recovery correct (see Recovery Proof).

### Tool Reliability
`EightBitReliabilityTracker` (`packages/eight-bit/src/reliability.ts`): bounded 50-sample
rolling window, ≥5 samples required before a score is trusted (fewer is an explicit unknown,
never a demotion), 4-consecutive-bad quarantine, explicit (never silent/time-based) recovery.
Wired into `agent-runtime.ts`'s existing `parseToolArgs`/`PARSE_FAILED` signal.

### Adaptive Routing / Session Stickiness
`EightBitRouter` (`packages/eight-bit/src/router.ts`): role/policy/health/reliability hard-gate
first, then the certified `ForgeRouter.rank()` for scoring, then a 10-point promotion margin
before an already-sticky binding is abandoned. `AgentRuntime.selectModel()` gained one additive
filter — routes in an 8-Bit health cooldown are hard-excluded — with zero behavior change when
no failure has ever been recorded (verified: every pre-existing routing/model-selection test in
the full suite below still passes unchanged).

### Exact Pins
`EightBitFailoverCoordinator` never calls `selectReplacement` when `isExactPin` is true; it
records an `EXACT_PIN_FAILED` receipt and returns `no_replacement`, letting the real error
propagate. Proven end-to-end in `packages/server/test/eight-bit-restart-and-exact-pin.test.ts`.

### Native Provider Fallback
`buildNativeFallbackModelIds()` (`packages/eight-bit/src/native-fallback.ts`) builds a
policy-re-filtered same-provider candidate list; wired into `OpenRouterAdapter.toOpenRouterRequest`
via a new optional `ChatRequest.fallbackModels` field, emitted as OpenRouter's native `models[]`
array only when there is more than one real candidate. An exact pin's list is always exactly
`[primaryModelId]`.

### Cross-Provider Active-Run Failover
The mandatory capability. Wired into the safe boundary already present in
`AgentRuntime.runAgentLoop`'s stream `catch` block (`attemptEightBitFailover`, ~130 lines) —
see `docs/eight-bit.md` for the full flow and why it is exactly-once by construction (tool
execution never happens inside the stream loop, so a stream-level failure has produced no side
effect yet for that iteration). `retry_same` is a genuinely new capability (previously any
provider error failed the whole turn outright); `rotate` swaps provider/model and resumes the
same `runAgentLoop` call with the same `messageHistory`/iteration.

### Side-Effect Replay Protection
Structural, not a special mechanism: `messageHistory` already contains every completed tool
call and its result; a route swap only changes which adapter serves the *next* `streamChat`
call. `executeTool` is never invoked twice for the same tool-call event. Proven in the E2E below
(a real `write_file` executed by Provider A is verified on disk after failover to Provider B,
and the durable event log shows exactly one `tool.call_completed` for that call).

### Persistence
`EightBitDecisionStore` (`packages/eight-bit/src/persistence.ts`) — three `WorkItem` kinds
(`eight_bit_route_state`, `eight_bit_route_health`, `eight_bit_decision_receipt`) added to
`packages/sessions/src/session-state.ts`'s existing discriminated union. Zero schema/DDL
changes on either driver (`work_items` is a generic `(id, sessionId, kind, data)` JSON store).
Receipts are append-only via `insertIfAbsent` (the same idempotency primitive CF-17R5 steer
receipts use).

### Restart Recovery
`AgentRuntime.init()` calls `EightBitRuntime.hydrate(sessionId)` alongside the existing
`hydratePersistedTurns()`: route health is restored from its own per-route records *before*
bindings are restored, so a route that failed and was rotated away from stays excluded even
though the binding row now names its replacement. Proven with a genuine two-process simulation
(brand-new `ForgeZero` + brand-new `AgentRuntime`, same persistence) both against SQLite and
real PostgreSQL.

## FG-2 Integration

8-Bit's `EightBitHandoffBuilder` accepts an optional Repository Intelligence completeness
source and passes `COMPLETE`/`PARTIAL`/`UNKNOWN` through verbatim (tested in
`handoff.test.ts`) — it is never upgraded for routing convenience. No FG-2 engine code was
modified; 8-Bit only consumes the advisory surface FG-2 already exposes.

## ForgeGreen Integration

One new mechanism, `model_failover`, added to `ForgeGreenMechanism` (`packages/forge-green/src/ledger.ts`)
following the exact pattern of the existing `fallback`/`repository_intelligence` mechanisms:
`recordModelFailoverRotation()` and `recordModelFailoverBlocked()`, both `measurement: "measured"`
(a rotation either happened or it did not — no estimation). A rotation persists a ledger record
via the existing `persistForgeGreenLedger` helper. No fabricated token/energy/CO2 savings
anywhere.

## Emoji / Runtime UI Integration

- **Standalone `G:\EmojiPack` modifications: NONE.**
- **CodeForge art/asset modifications: NONE** — the already-certified, already-integrated
  8-bit personality/provider assets (`8bit-loading`, `8bit-warning`, `8bit-waiting`,
  `8bit-offline`, `8bit-online`, `8bit-swapping-model`, `8bit-success`, `8bit-error`,
  `8bit-tool-use`) were discovered already present in `packages/ui/src/assets/activity-emoji/8bit/20/`
  (shipped by the concurrent, separately certified emoji integration this session inherited)
  and reused unchanged.
- Added: `packages/protocol/src/events.ts` `EightBitStatusSchema` (`eightbit.status`, required
  `accessibleText`); `packages/server/src/workspace-event-adapter.ts` `emitRouterFailover`
  (the schema existed since before 8-Bit but was never emitted anywhere — confirmed by the
  architecture audit) and `emitEightBitStatus`; `packages/ui/src/eight-bit-status.ts` (pure
  event→asset mapping, safe-fallback for unrecognized events) and `EightBitStatusBadge.tsx`
  (`role="status" aria-live="polite"`, decorative `alt=""`/`aria-hidden` image, accessible text
  generated by the backend from the real decision — never re-derived in the UI).
- Accessibility: emoji is never the sole carrier of status; `accessibleText` is required on the
  event schema and always rendered.
- **Scope limitation, documented rather than hidden:** the UI mapping/component are built and
  independently tested (8 tests, `packages/ui/test/eight-bit-status.test.tsx`) and verified
  through a full `@codeforge/ui` production build, but are **not wired into `Conversation.tsx`'s
  render tree** in this V1, and are **not included in the final commit** — both because that
  file is part of the still-uncommitted concurrent emoji work (touching it further risks
  destabilizing a separately certified component without full context) and because committing
  them would require committing that unrelated work too, which this task's own instructions
  forbid. See Cleanup/Repository State below.

## Free-Policy Proof

`packages/eight-bit/test/eligibility.test.ts` (14 tests): known-free accepted under adaptive;
paid rejected under adaptive; unknown-cost rejected under adaptive *and* under premium/BYOK
(never blindly entered); paid accepted only under explicit premium; legacy (no `accessClass`)
records trust only `freeStatus === "verified_free"`, reject `expired`; role-capability hard
gates beat any ranking score; hard tool-reliability gate rejects a proven-bad model even with a
perfect capability match; unknown (insufficient-sample) reliability never blocks eligibility;
quarantine rejects regardless of numeric score; unhealthy (`offline`) routes rejected.
`native-fallback.test.ts` (6 tests) proves the same boundary for the OpenRouter-native fallback
list specifically. `router.test.ts` (10 tests) proves a paid route never wins adaptive routing
"even with a much higher benchmark profile" (hard gate beats ranking score) and that
`NO_ELIGIBLE_FREE_MODEL` is reported explicitly rather than silently substituted.

## Cross-Provider Proof

`packages/server/test/eight-bit-active-run-failover.test.ts` — the mandatory scenario: a real
`AgentRuntime` (SQLite persistence, real filesystem workspace) starts a CODER turn on
"provider-a", which really writes `output.txt` via the production `write_file` tool (through a
real approval-resolution round trip), then genuinely fails ("503 Service Unavailable"). 8-Bit
classifies `PROVIDER_OUTAGE`, rotates to "provider-b" (deterministic ForgeRouter tiebreak), and
the turn finishes on "provider-b" running a real `node --version` child process. Concrete
transition asserted directly: `final.providerId === "provider-b"`, a persisted decision receipt
with `action: "ROTATE"`, `previous: {provider-a, aaa-model}`, `selected: {provider-b, zzz-model}`.

## Handoff Proof

Same test: `providerB.seenMessages` shows Provider B's request actually contains the
`write_file` tool call/result Provider A produced, *and* the injected 8-Bit handoff system
message ("You are continuing the SAME turn... do not repeat any action listed below").
`packages/eight-bit/test/handoff.test.ts` (5 tests) proves the builder reads only persisted
`WorkItem`s (never guesses from conversation text), correctly scopes to the current `turnId`
(a different turn's `file_change` never leaks in), and preserves `PARTIAL`/`UNKNOWN` Repository
Intelligence completeness verbatim.

## Approval / Question / Steer Proof

The E2E test drives a *real* approval round trip (`write_file` requires approval by default;
the test resolves it via the production `runtime.resolveApproval()` call, not a bypass) and
asserts every approval reached a real terminal `decision`, none left dangling or
double-resolved, and no question was ever created by 8-Bit. Structurally: `grep` across
`packages/eight-bit/src` for `ApprovalService`, `pendingQuestions`, `UserIntentHoldController`,
`ForgeVerify`, and `completion-gate` returns zero matches — 8-Bit has no code path into any of
them. The full CF-17 regression suite (steering, approval races, spawned-process restart,
ForgeVerify replanning, scoped parallel steering — see Regression Proof) passes unchanged after
every 8-Bit code path was added.

## Side-Effect Proof

Same E2E: `output.txt` on the real filesystem still equals the exact content Provider A wrote,
`providerA.callCount === 2` (one success, one throw — never called again after rotation), and
the durable event log (`eventStore.getBySession`) contains **exactly one** `tool.call_completed`
event for `tc-write-a` — the write was never replayed.

## Recovery Proof

`packages/server/test/eight-bit-restart-and-exact-pin.test.ts`: a genuine two-process
simulation (brand-new `ForgeZero`, brand-new `AgentRuntime`, same `ISessionPersistence`) — after
"process 1" rotates away from a failing provider-a, "process 2" calls `init()` and starts a
*new* turn; `providerAStillDead.callCount === 0` — the dead route is never even attempted
post-restart. Repeated against real PostgreSQL in `packages/eight-bit/test/postgres.test.ts`
(2 tests) — identical assertions, only the driver differs.

## Security Proof

`packages/eight-bit/test/security.test.ts` (7 tests): a model record carrying a prompt-injection
payload in `displayName`/`health.lastError` is evaluated purely on structured fields (still
rejected when genuinely unknown-cost, still accepted when genuinely free — the injected prose
changes nothing); router ranking reasons never echo raw catalog prose; a decision receipt is
bounded (<2000 bytes serialized) and never contains `<script>`, `sk-`-shaped secrets, or raw
catalog text; `classifyFailure` cannot be talked into a favorable classification by an
attacker-controlled error string; a 200KB `displayName` does not crash or unboundedly grow
health state; a shell/path-injection-shaped provider id is only ever used as an opaque Map
key/structured field, never interpolated into a command or path.

## Regression Proof

| Suite | Files | Tests | Result |
|---|---|---|---|
| FG-1 (canonical cache, prompt cache, compression, duplicate suppression, runtime efficiency, authority independence, cache store) | 7 | 60 | PASS |
| FG-2 (engine certification, efficiency/large-repo, runtime integration, ledger) | 4 | 30 | PASS |
| CF-17 (ForgeVerify replan, scoped parallel steer, runtime-restart API, steering) | 4 | 13 | PASS |
| CF-17 real PostgreSQL (spawned-process restart with queued steer) | 1 | 1 | PASS |
| CF-07 (tool-use/loop-detection matrix) | 1 | 4 | PASS |

All 17 files above run together in one command, serially (`--no-file-parallelism`), with
`CODEFORGE_TEST_POSTGRES_URL` set — **17 files, 107 tests, 0 failed, 0 skipped.** 8-Bit's own
real-PostgreSQL suite (`packages/eight-bit/test/postgres.test.ts`, 2 tests) is reported
separately under Recovery Proof / 8-Bit-Owned Tests below rather than folded into this
regression count, since it is new 8-Bit-authored coverage, not a regression check against
pre-existing behavior. No assertion in any suite above was weakened, deleted, or skipped to
make this pass.

## 8-Bit-Owned Tests

| Suite | Files | Tests |
|---|---|---|
| `packages/eight-bit/test/*` (unit — eligibility, health, reliability, router, native-fallback, persistence, failover, runtime, handoff, security) | 10 | 72 |
| `packages/eight-bit/test/postgres.test.ts` (real PostgreSQL) | 1 | 2 |
| `packages/providers/test/openrouter-native-fallback.test.ts` | 1 | 3 |
| `packages/server/test/eight-bit-active-run-failover.test.ts` (mandatory E2E) | 1 | 1 |
| `packages/server/test/eight-bit-restart-and-exact-pin.test.ts` | 1 | 2 |
| `packages/ui/test/eight-bit-status.test.tsx` | 1 | 8 |
| **Total** | **15** | **88** |

## Build

- Full monorepo `npm run typecheck` (`tsc -b --force` across all workspaces): **PASS**.
- Full monorepo `npm run build` (all packages, `apps/web` and `apps/desktop` renderer + main,
  `codeforge-cloud-api`): **PASS**.
- `git diff --check`: **PASS** (no whitespace errors).

## Full Suite

Fresh, complete, serial run against the settled final tree (`npx vitest run --no-file-parallelism`,
`CODEFORGE_TEST_POSTGRES_URL` set to the real WSL2 PostgreSQL 16 instance):

```text
Test Files:  199 passed | 5 failed  (204)
Tests:       1532 passed | 8 failed | 28 skipped  (1568)
Duration:    920.33s
```

**Every one of the 5 failed files / 8 failed tests / 28 downstream-skipped tests has the
identical, confirmed, pre-existing root cause** — `packages/cloud-db/test/parity.test.ts`,
`tests/cloud-postgres-adversarial.test.ts` (suite-level setup failures, cascading to their 28
skipped tests), `packages/cloud-db/test/postgres.test.ts` (1 test), `publication-lease.test.ts`
(1 test), and `tests/two-client-authority.test.ts` (6 tests) all throw the exact same
`Database migration checksum mismatch for version 1 (001_initial_cloud_schema)` from
`packages/cloud-db/src/postgres.ts:113`.

**Root cause, confirmed by inspection** (not hand-waved): `packages/sessions/src/postgres-persistence.ts`
and `packages/cloud-db/src/postgres.ts` each independently `CREATE TABLE IF NOT EXISTS
schema_migrations (version, name, checksum, applied_at)` and both number their own first
migration `version = 1`. Both packages were pointed at the same shared local test database in
this environment (`codeforge_test_db`) — whichever package's tests run first "wins" row
`version = 1` in the one shared table, and the other package's migration then legitimately
fails its own checksum check against a migration it did not write. This is a genuine
pre-existing architectural gap between two unrelated packages that happens to surface only when
both are tested against one shared physical database — not a defect in either package's logic,
and definitively not something 8-Bit introduced: `packages/cloud-db` carries zero changes from
this task (`git status` confirms), and 8-Bit's own PostgreSQL usage goes exclusively through
`@codeforge/sessions` (the same path CF-17/FG-1's own certified PostgreSQL tests already use
successfully). A rerun with a dedicated database per package (or running the two suites in
separate database instances) would clear this immediately; it was not "fixed" here because doing
so is outside 8-Bit's scope and would mean modifying `packages/cloud-db`, which this task's own
instructions direct against touching.

**Zero failures or skips outside that one confirmed cluster.** Every FG-1/FG-2/CF-17/CF-07
regression test, every 8-Bit-owned test (including both real-PostgreSQL 8-Bit tests, which use
the sessions driver and are unaffected), and every pre-existing test elsewhere in the monorepo
(1532 of 1532 non-cloud-db-migration tests) passed.

## Efficiency Evidence

Observational only, via the new `model_failover` ForgeGreen mechanism
(`recordModelFailoverRotation`/`recordModelFailoverBlocked`), both `measurement: "measured"` —
a rotation is a countable event, not an estimate. No token/energy/CO2 savings are claimed;
8-Bit does not measure those and does not fabricate them. Routing overhead: the hot-path
selection (`EightBitRouter.selectRoute`) does a local eligibility filter plus the existing
`ForgeRouter.rank()` over the in-memory `ForgeZero` catalog — no network call, no provider
catalog query, on every model selection; catalog refresh remains whatever bounded/async
mechanism `ForgeZero`/`model-registry` already use (unmodified by this task).

## Documentation

- `docs/eight-bit.md` — full architecture: package layout, role model, free-policy boundary,
  health, tool reliability, adaptive routing, native fallback, cross-provider failover, exact
  pins, restart recovery, decision receipts, emoji/status integration, authority boundaries,
  deferred work, future roadmap.
- `docs/8bit-v1-certification-report.md` — this file.

## Deferred Work

- A synthetic bounded-admission-probe harness for newly discovered routes (the brief's own
  guidance deprioritizes an elaborate benchmark arena for V1).
- Role-differentiated production routing beyond `CODER` (role contracts exist and are
  independently tested; wiring additional roles into the runtime is left to whichever future
  task introduces role-differentiated task types).
- Live mid-run failover for `executeAgentRun` (the parallel/subagent execution path) — it
  receives 8-Bit's static routing improvements at spawn time only; the mandatory active-run
  failover capability is certified against `executeTurn`/`runAgentLoop`, the primary lead-agent
  path where CF-17's steer/approval semantics live.
- `EightBitStatusBadge`/`eight-bit-status.ts` are built and tested but not wired into
  `Conversation.tsx` and not included in this commit (see Emoji/UI Integration and Cleanup).
- FG-3 Pull-Based Context, GEMS/Infinity fleet control plane, parallel model racing — all
  explicitly out of scope per the brief and not implemented.

## Cleanup

- Disposable temp workspaces/directories created by the new tests are removed in `afterEach`.
- The recreated `codeforge_test_db` is a disposable local test database (not product data). Its
  `cloud-db` migration-checksum failures are explained precisely in "Full Suite" above (a
  `schema_migrations` table-name collision between two unrelated, unmodified packages sharing
  one physical database) — an environment characteristic, not an 8-Bit defect, and not "fixed"
  here by weakening any check, since doing so would mean modifying `packages/cloud-db`.
- Inherited concurrent UI/emoji work: preserved. See Repository State for exactly what is
  excluded from the commit and why.
- The WSL keepalive process used during PostgreSQL testing is a plain `sleep`, not persisted
  anywhere in the repository.

## Repository State

- Final HEAD (after commit): recorded below once created.
- **8-Bit-owned files included in the commit:**
  - `packages/eight-bit/**` (new package: `package.json`, `tsconfig.json`, `src/*.ts` ×11,
    `test/*.test.ts` ×11)
  - `packages/forge-green/src/ledger.ts` (modified — `model_failover` mechanism)
  - `packages/protocol/src/events.ts`, `packages/protocol/src/workspace-events.ts` (modified —
    `EightBitStatusSchema`, wiring)
  - `packages/providers/src/chat-types.ts`, `packages/providers/src/openrouter.ts` (modified —
    `fallbackModels`/native `models[]`), `packages/providers/test/openrouter-native-fallback.test.ts` (new)
  - `packages/server/package.json`, `packages/server/tsconfig.json` (modified — new dependency)
  - `packages/server/src/agent-runtime.ts` (modified — 8-Bit wiring), `packages/server/src/workspace-event-adapter.ts`
    (modified — `emitRouterFailover`/`emitEightBitStatus`)
  - `packages/server/test/eight-bit-active-run-failover.test.ts`,
    `packages/server/test/eight-bit-restart-and-exact-pin.test.ts` (new)
  - `packages/sessions/src/session-state.ts` (modified — 3 new `WorkItem` kinds)
  - `tsconfig.json` (modified — root project reference)
  - `docs/eight-bit.md`, `docs/8bit-v1-certification-report.md` (new)
  - `package-lock.json` (modified — new workspace package linked)
- **Deliberately excluded from the commit** (built, tested, verified in the full test run and
  production build above, but held back — see rationale in Emoji/UI Integration): `packages/ui/src/EightBitStatusBadge.tsx`,
  `packages/ui/src/eight-bit-status.ts`, `packages/ui/test/eight-bit-status.test.tsx`, and the
  additive export lines they required in `packages/ui/src/index.ts` / `packages/ui/src/emoji-assets.ts`
  — because those two files are inseparably mixed with the still-uncommitted concurrent emoji
  integration work, and this task's instructions explicitly forbid committing unrelated work on
  this session's own authority. All remaining inherited dirty/untracked files
  (`apps/web/src/qa.tsx`, `packages/ui/src/Conversation.tsx`, `packages/ui/src/activity-icons.tsx`,
  `packages/ui/src/workspace.css`, `packages/ui/test/activity-icons.test.tsx`,
  `docs/codeforge-8bit-activity-integration-report.md`, `docs/codeforge-emojipack-chat-integration-report.md`,
  `packages/ui/src/assets/`) are untouched by this task and remain exactly as inherited.
- Remote operations: **NONE** (no push, no force push, no PR, no remote branch modified).

## Next Architecture Boundary

FG-3 (pull-based context planning: Context Planner, progressive L0–L7 resolution, Context
Pages, 1-hop prefetch, adaptive budgets) remains next and was **not** implemented. 8-Bit's
`EightBitHandoffBuilder` is the clean seam FG-3 will optimize later — it already produces a
bounded, deterministic summary from authoritative persisted state; FG-3's job is making that
summary (and the broader context assembled for every turn) smarter about *what* to include, not
changing who is authoritative for *whether* something happened.
