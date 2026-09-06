# 8-Bit — Dynamic Model-Routing/Failover Core (V1)

8-Bit is CodeForge's dynamic model-control core. It is not an LLM. It keeps CodeForge
operational as free-model availability, quotas, health, and tool reliability change over time:
when the currently preferred route stops being usable, 8-Bit stops sending it new work,
selects a policy-eligible replacement, preserves authoritative runtime state, records why the
transition happened, and lets CodeForge continue.

8-Bit is **routing authority only**. It cannot grant filesystem/shell permission, satisfy an
approval or question, certify ForgeVerify or the Completion Gate, or cross the
free/paid/BYOK/premium policy boundary without explicit authorization. Every component below
either enforces or falls back to that boundary; none of them has a code path into the
permission, approval, verification, or completion systems.

## Package layout

`packages/eight-bit/src/`:

| File | Responsibility |
|---|---|
| `types.ts` | Roles, role capability contracts, failure reasons + policy, route/health types, decision receipts, handoff types, status events |
| `eligibility.ts` | `EightBitEligibilityPolicy` — hard role-capability + free-policy gate, evaluated before ranking |
| `health.ts` | `EightBitHealthTracker` — live per-route health feedback loop + failure classification |
| `reliability.ts` | `EightBitReliabilityTracker` — live per-route tool-call reliability rolling counters |
| `router.ts` | `EightBitRouter` — role-aware adaptive routing, session/workstream stickiness, anti-flapping |
| `native-fallback.ts` | Builds a policy-filtered provider-native fallback candidate list (e.g. OpenRouter `models[]`) |
| `handoff.ts` | `EightBitHandoffBuilder` — bounded deterministic handoff snapshot from persisted runtime state |
| `persistence.ts` | `EightBitDecisionStore` — persists route state, route health, and decision receipts via the existing `ISessionPersistence` (SQLite/PostgreSQL) |
| `failover.ts` | `EightBitFailoverCoordinator` — classify → decide → select replacement → receipt |
| `runtime.ts` | `EightBitRuntime` — thin facade wiring the above together; the one object `AgentRuntime` holds |

No new database, no new persistence driver, no duplicate provider registry, no duplicate
health tracker, no duplicate free-eligibility check. 8-Bit reuses:

- **`@codeforge/forge-zero`** (`ForgeZero`, `AccessClass`, `FreeModelRecord`) as the catalog and
  the free/paid/policy source of truth — `markProviderHealth`/`eligibleModels`/`verify` are all
  still the ones enforced.
- **`@codeforge/router`** (`ForgeRouter`) as the ranking algorithm — 8-Bit narrows the candidate
  set first (role + policy + live health/reliability), then still ranks with the same certified
  scorer, so "Top Verified Free" and 8-Bit routing never disagree about what a good route looks
  like.
- **`@codeforge/sessions`** (`ISessionPersistence`) for all durable 8-Bit state — two new
  `WorkItem` kinds (`eight_bit_route_state`, `eight_bit_route_health`, `eight_bit_decision_receipt`),
  stored as JSON in the existing `work_items` table. SQLite and PostgreSQL both work
  automatically — the table is a generic `(id, sessionId, kind, data)` blob store, so adding a
  kind requires zero schema/DDL changes.
- **`@codeforge/forge-green`** (`ForgeGreenLedgerCollector`) — a new `model_failover` mechanism
  was added (`recordModelFailoverRotation`/`recordModelFailoverBlocked`), following the exact
  pattern of the existing `fallback`/`repository_intelligence` mechanisms.
- **`@codeforge/protocol`** (`WorkspaceEvent`) — a new `eightbit.status` event was added, and the
  previously-dead `router.failover` schema (present since before 8-Bit, never emitted) is now
  actually emitted.

## Role model

```ts
type EightBitRole = "CODER" | "REASONER" | "PLANNER" | "REVIEWER" | "FAST_WORKER" | "LONG_CONTEXT" | "VISION";
```

Each role has a `RoleContract` (`ROLE_CONTRACTS` in `types.ts`): hard minimums for tools,
structured output, vision, long context, minimum context tokens, and a minimum tool-reliability
score. `EightBitEligibilityPolicy.evaluate(model, ctx)` is a hard gate — a route either
satisfies every requirement or it is not a candidate, regardless of ranking score
(`ForgeRouter.scoreModel` still ranks *among* eligible routes only). V1 wires `CODER` into the
production runtime (`AgentRuntime`'s lead-agent turn loop); the other roles are defined and
independently testable but not yet driving separate turn types — that binding is left to
whichever future task introduces role-differentiated task routing, matching the brief's
instruction to keep role selection and model selection separate responsibilities.

## Free-policy boundary (fail-closed)

`EightBitEligibilityPolicy` trusts, in order:

1. `FreeModelRecord.accessClass` (`FREE_NATIVE | FREE_ROUTED | FREE_ALLOWANCE | FREE_PROMO | TRIAL | PAID | UNAVAILABLE`) when present — the audited, structured classification `deriveAccessClass()` produces from real pricing/policy data, never from a model-name string.
2. When `accessClass` is absent (a legacy pre-migration record, per its own schema comment), the legacy `freeStatus` enum — only an explicit `verified_free` (with `costProfile.isFree === true`) is trusted; `unknown`/`expired`/`paid`/`temporarily_unavailable` all fail closed.

`adaptive` policy mode never selects a non-free access class. `byok`/`premium` policy modes
(the caller has already obtained authorization elsewhere — 8-Bit does not grant it) still
reject `UNAVAILABLE`/unknown-cost routes. There is no string check on model IDs/names anywhere
in 8-Bit.

## Health

`EightBitHealthTracker` is the audited gap this closes: `ModelHealthState.recentFailureCount`
existed as a schema field nothing ever wrote. `recordFailure(providerId, modelId, reason)` now:

- Increments a real per-route consecutive-failure counter.
- Classifies the failure via `classifyFailure(error)` (pattern-based on the error message —
  401/429/5xx/timeout/quota/context-limit/etc.) into one of 13 `FailureReason` values.
- Applies `FAILURE_POLICY[reason]` — `bounded_retry` (single transient failures never
  demote past DEGRADED; only 3+ consecutive failures escalate), `cooldown_and_rotate`
  (rate-limited/quota/outage/auth), `remove_and_refresh` (model not found/retired/free
  eligibility removed), or `surface_only` (context-limit/malformed-output — not a routing
  problem, so 8-Bit does not rotate for it).
- Applies exponential-backoff cooldown for cooldown-eligible reasons.
- Pushes a mapped status into `ForgeZero.markProviderHealth()` — this is provider-granularity
  (ForgeZero's existing API only marks a whole provider, not one model), matching the *existing*
  production behavior in `agent-runtime.ts`'s own 401/429 handling; 8-Bit's own per-route
  tracking stays finer-grained internally.
- Is independently persisted per-route (`eight_bit_route_health`), not just alongside whichever
  route currently happens to be bound — this is what makes restart recovery correct: a route
  that failed and was rotated away from must stay excluded even though the *binding* row now
  points at its replacement.

## Tool reliability

`EightBitReliabilityTracker` is the second audited gap: `toolReliability` existed only as an
offline-certified score, never fed by live production behavior. `record(providerId, modelId,
outcome)` tracks a bounded rolling window (50 samples) of `valid | malformed | unknown_tool |
missing_args | schema_violation | structured_output_failure`. Below 5 samples the score is
`undefined` — an explicit unknown, not a failure, so a brand-new route is never blocked for lack
of data. A 4-in-a-row bad streak quarantines the route regardless of older good history; a
single valid call resets the streak counter (not the quarantine flag — quarantine is lifted only
by an explicit `clearQuarantine()` call, never silently by time). Wired into production at the
one clear signal already in the runtime: `agent-runtime.ts`'s `parseToolArgs` `PARSE_FAILED`
path, which the audit confirmed is a real observed failure mode (small models sometimes
concatenate JSON objects).

## Adaptive routing, stickiness, anti-flapping

`EightBitRouter.selectRoute(options)`:

1. Filters `firewall.eligibleModels()` to routes with a registered provider adapter, not in
   health cooldown, and passing `EightBitEligibilityPolicy` for the requested role/policy.
2. Ranks the survivors with the certified `ForgeRouter.rank()`.
3. If a sticky binding exists for the (session, role, workstream) scope and it is still in the
   eligible set, it is kept unless a candidate beats it by more than a fixed promotion margin
   (10 points) — a 1-point difference never causes a switch.
4. Otherwise binds and returns the top-ranked candidate.

**Production wiring note**: `AgentRuntime`'s *initial* per-turn model pick still goes through
the existing, separately-certified `selectModel()`/`ForgeRouter.rank()` path (augmented only
with the additive health-cooldown filter described above) rather than
`EightBitRouter.selectRoute()` directly — the lower-risk integration choice for V1, since
`selectModel()` is exercised by a wide existing test surface this task did not want to disturb
further than necessary. `EightBitRouter.selectRoute()`/`EightBitRuntime.selectInitialRoute()`
(with the full role-capability + live-reliability gate) are fully implemented and independently
tested, and are what `EightBitFailoverCoordinator.selectReplacement()` actually uses during a
live rotation — direct production wiring of the initial pick through the same facade is a
natural, low-risk follow-up once the initial-pick path needs role-differentiated routing beyond
`CODER`.

`selectReplacement(options, exclude)` is the failover variant: same filtering, plus an explicit
exclusion of the just-failed route (belt-and-suspenders alongside the health-cooldown filter,
since health state may not have propagated yet within the same failure).

## Provider-native fallback

`buildNativeFallbackModelIds()` builds an ordered same-provider candidate list — primary model
first, then other eligible same-provider free routes (by empirical coding score, id tiebreak) —
every candidate re-checked against the same role/policy eligibility gate as adaptive routing.
Wired into `OpenRouterAdapter`: `ChatRequest.fallbackModels` (new, optional field) becomes the
OpenRouter-native `models` array in the outgoing request when it has more than one candidate; an
exact pin's fallback list is always exactly `[primaryModelId]` — a pin never silently expands
into an adaptive fallback list.

## Active-run cross-provider failover

The mandatory V1 capability. Wired into `AgentRuntime.runAgentLoop`'s existing
`try { for await (streamChat) } catch` block — that catch is a genuine safe boundary: any tool
calls accumulated during the failed stream iteration are only ever *executed* later in the same
function, never inside the stream loop, so a stream/model-call failure there has not yet
produced any side effect for that iteration.

`AgentRuntime.attemptEightBitFailover()`:

1. Calls `EightBitRuntime.handleTurnFailure()` → classify → health-record → decide.
2. `retry_same`: bounded retry against the identical route (does not consume the turn's
   iteration/tool budget) — new capability; previously any provider error failed the whole turn.
3. `rotate`: builds a bounded handoff summary from `EightBitHandoffBuilder` (persisted
   `WorkItem`s only — see below), pushes it as a system message, swaps `state.providerId`/
   `modelId`, persists the new route state, emits `router.failover` + `eightbit.status`
   (`ROUTE_ROTATION_STARTED` then `ROUTE_READY`) events, records a `model_failover` ForgeGreen
   ledger event, and resumes the **same** `runAgentLoop` call — same `turnId`, same
   `messageHistory` (which already contains every prior tool call and its result), same
   iteration count.
4. `no_replacement`/`surface`: the original error propagates to the existing `executeTurn`
   catch, unchanged — the turn fails honestly; 8-Bit never converts a real failure into a fake
   success.

**Why this is exactly-once by construction, not by a special mechanism**: `messageHistory` is
process-local, mutated only by completed stream events and completed tool executions. A
model/provider swap only ever changes which adapter the *next* `streamChat` call targets; it
never re-emits `tool_call_started`/`tool_call_completed` for calls that already happened, so
`executeTool` is never invoked twice for the same call. CF-17 (`UserIntentHoldController`,
`ApprovalService`, `pendingQuestions`) and CF-07 (`DuplicateActionSupervisor`, whose identity is
`{tool, canonicalArguments, workstreamScope, policyVersion}` — no model field at all) are
untouched by any 8-Bit code path; the failover coordinator never calls into them.

### Handoff builder

`EightBitHandoffBuilder.build(sessionId, turnId, objective)` reads `persistence.getWorkItems()`
for the turn and summarizes completed commands/file changes/activities and pending
approval/question flags into a bounded `HandoffContext` (`renderHandoffMessage` turns it into a
short system message: "you are continuing the SAME turn — do not repeat any action listed
below"). This is advisory context for the replacement model, not the mechanism that prevents
replay (see above) — its absence (e.g. a persistence hiccup) is caught and never blocks
continuing the turn. **Known scope limitation**: the primary lead-agent turn loop
(`executeTurn`/`runAgentLoop`) does not currently persist per-tool-call `command`/`file_change`
work items (only `approval`/`question` are persisted there today), so in that path the handoff
message is presently limited to the objective plus pending-approval/question flags; the builder
is written generically against the full `WorkItem` schema and will pick up richer content
automatically wherever a runtime path (e.g. a future delivery/mission integration) does persist
those kinds. Repository Intelligence (FG-2) completeness, when supplied, is passed through
verbatim — `PARTIAL`/`UNKNOWN` is never upgraded to "good enough" for handoff convenience.

## Exact pins

`ExecutionModelSelection`'s existing `exact-free`/`exact-premium` modes (via
`AgentRuntime.setModelSelection`) are respected: `attemptEightBitFailover` passes
`isExactPin: !!this.modelSelection` into the failover request; `EightBitFailoverCoordinator`
never calls `selectReplacement` for an exact pin — it records an `EXACT_PIN_FAILED` receipt and
returns `no_replacement`, and the real failure propagates to the user. Adaptive rotation is
never silently applied to a pin.

## Restart recovery

`AgentRuntime.init()` calls `EightBitRuntime.hydrate(sessionId)` (alongside the existing
`hydratePersistedTurns()`), which:

1. Loads every persisted `eight_bit_route_health` row for the session and applies it to the
   live `EightBitHealthTracker` (and, through it, back into `ForgeZero.markProviderHealth`) —
   this is what keeps a rotated-away-from route excluded after a process restart, independent
   of whatever the current binding points at.
2. Loads every persisted `eight_bit_route_state` binding and restores it into
   `EightBitRouter`'s sticky-binding map.

`AgentRuntime.selectModel()` additionally hard-excludes any route currently in an 8-Bit health
cooldown (`!this.eightBit.health.isInCooldown(...)`) — additive to the existing `ForgeRouter`
ranking-only health penalty, and zero-behavior-change when no failure has ever been recorded
(so it does not perturb any pre-existing routing test).

## Decision receipts

Every meaningful routing action (`INITIAL_SELECTION`, `ROTATE`, `NO_ELIGIBLE_ROUTE`,
`EXACT_PIN_FAILED`) produces an immutable `DecisionReceipt` — session/run/agent/workstream
identity, role, action, policy mode, previous/selected route, and reason codes only. Persisted
append-only via `insertIfAbsent` (the same durable idempotency primitive CF-17R5 steer receipts
use), so a retried write of the same `receiptId` never duplicates the record. Receipts never
carry raw prompts, model catalog prose, or secret-shaped content — see the security test matrix
below.

## Runtime status / emoji integration

`packages/protocol/src/events.ts` adds `EightBitStatusSchema` (`eightbit.status`): `event`
(`CATALOG_SCAN_STARTED | ROUTE_DEGRADED | ROUTE_COOLDOWN | PROVIDER_OFFLINE | PROVIDER_ONLINE |
FREE_ELIGIBILITY_REMOVED | ROUTE_ROTATION_STARTED | ROUTE_ROTATED | ROUTE_READY |
NO_ELIGIBLE_FREE_MODEL`), `role`, `previous`/`selected` route, `reasonCodes`, and a required
`accessibleText` string generated by the backend from the actual decision (never re-derived in
the UI, never dependent on the emoji rendering).

`packages/ui/src/eight-bit-status.ts` maps each event to an **already-certified, unmodified**
8-bit asset already shipped in `packages/ui/src/assets/activity-emoji/8bit/20/` (the personality/
provider set integrated by the concurrent, separately-certified emoji work this session
inherited and left untouched):

| Event | Asset |
|---|---|
| `CATALOG_SCAN_STARTED` | `8bit-loading` |
| `ROUTE_DEGRADED`, `FREE_ELIGIBILITY_REMOVED` | `8bit-warning` |
| `ROUTE_COOLDOWN` | `8bit-waiting` |
| `PROVIDER_OFFLINE` | `8bit-offline` |
| `PROVIDER_ONLINE`, `ROUTE_READY` | `8bit-online` |
| `ROUTE_ROTATION_STARTED` | `8bit-swapping-model` |
| `ROUTE_ROTATED` | `8bit-success` |
| `NO_ELIGIBLE_FREE_MODEL` | `8bit-error` |
| unrecognized/future event | `8bit-tool-use` (safe fallback) |

**Zero standalone emoji-pack modifications; zero new artwork.** `EightBitStatusBadge` renders
the icon (`alt=""`, `aria-hidden`) next to `accessibleText` inside `role="status"
aria-live="polite"`, renders nothing when there is no status yet (not an error state), and never
throws on an unrecognized event. Both are exported from `@codeforge/ui` but not yet wired into
`Conversation.tsx`'s render tree — a deliberate, documented scope limitation (see the
certification report) rather than a risky blind edit to a large, already-dirty, separately
certified component; the mapping and component are independently built, tested, and ready for
that wiring.

## Authority boundaries (invariants, enforced by construction)

- 8-Bit never calls into `ApprovalService`, `pendingQuestions`, `UserIntentHoldController`,
  `ForgeVerify`, or `completion-gate.ts` — grep confirms zero references in `packages/eight-bit`.
- 8-Bit never writes to the filesystem or spawns a process.
- `EightBitEligibilityPolicy` is the only place free/paid/BYOK/premium crossing is decided, and
  it is fail-closed (unknown → rejected) in every policy mode.
- `EightBitFailoverCoordinator` never calls `selectReplacement` for an exact pin.
- No component reads or interpolates model/provider display names, descriptions, or error text
  into an executable path (shell command, file path, or agent instruction) — see the security
  test matrix in `packages/eight-bit/test/security.test.ts`.

## Deferred (explicitly out of scope for V1)

- A synthetic bounded-admission-probe harness for newly discovered routes (the brief's own
  guidance deprioritizes an elaborate benchmark arena; V1 relies on the capability eligibility
  gate plus live production reliability tracking instead).
- Role-differentiated routing beyond `CODER` driving separate turn types in the production
  runtime (the role contracts exist and are tested; wiring additional roles into the runtime is
  left to whichever future task introduces them).
- `executeAgentRun` (the parallel/subagent execution path) does not yet get live mid-run
  failover — it gets 8-Bit's static routing improvements at spawn time only. `executeTurn`/
  `runAgentLoop` (the primary lead-agent path, where CF-17's steer/approval semantics live) is
  where the mandatory active-run failover capability is certified.
- FG-3 Pull-Based Context, GEMS/Infinity fleet control, parallel model racing, and everything
  else this brief explicitly defers.

## Future 8-Bit roadmap

- **V2** — production telemetry intelligence (aggregate operational dashboards over the
  decision-receipt/health/reliability history already being recorded).
- **V3** — expanded certification + controlled promotion (a bounded admission workflow for
  newly discovered routes).
- **V4** — full Infinity fleet control plane (GEMS integration, multi-role production wiring).
