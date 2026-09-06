# ForgeGreen runtime efficiency

ForgeGreen reduces measurable computational work upstream of CodeForge’s canonical authorities. It does not weaken verification, permissions, approvals, security, or completion standards.

## Boundary

The directional flow is:

`repository facts → Repository Intelligence → ForgeGreen analysis → efficiency recommendations → canonical authorities → execution / verification / approval / completion`

ForgeGreen never returns a permission, approval, verification authority, execution authority, or completion verdict. Its verification output is explicitly `VerificationRecommendation` and its completeness is `candidate-only`, `bounded`, or `unknown`; an empty candidate set is never proof of no impact.

## Runtime integration

`AgentRuntime` shares a bounded `ForgeGreenAdvisor` with `ContextAssembler` and `ModelExecutionAdapter`.

- Context keys include workspace identity, repository generation, task identity, role, retrieval-policy version, context budget, feature version, and authority state.
- Context reuse is rejected when any identity component changes. Repository generation is obtained after Repository Intelligence refresh.
- Immutable context fragments are keyed by content hash. No private conversation, credentials, approvals, mutable sibling worktree state, or secret-bearing payload is stored in this cache.
- Stable system/tool prefixes are observed through a provider-neutral interface. Provider token accounting is reported as `unavailable` when the provider does not expose it; ForgeGreen never invents cache reads or writes.
- Duplicate model requests are fingerprinted with provider/model, messages, tools, request parameters, user identity, and authority state. Failures are not cached, and cancellation interrupts a deduplicated wait.
- Verification recommendations are emitted alongside verification telemetry, but the existing canonical verifier and `evaluateCompletion` gate always execute and decide.

## Failure and disable behavior

Missing, stale, corrupt, ambiguous, timed-out, or unavailable efficiency analysis uses the existing safe path and records `safe_fallback` or `analysis_unavailable`. `CODEFORGE_FORGREEN=0` disables the optimization layer and returns canonical behavior. Optimization exceptions are not allowed to become permission or completion decisions.

## Evidence

`EfficiencyReceipt` records bounded, inspectable work quantities: context requested/delivered tokens, tokens avoided, cache hits, duplicate requests avoided, fallback use, reason codes, repository generation, and policy version. It does not expose a universal green score and makes no carbon, energy, or emissions claim.

Blast-radius false-negative auditing and acceptance-level sufficiency auditing remain separate concerns. A prior pass, cache hit, retrieval score, impact estimate, or flaky classification cannot certify current verification or completion.

## CF-17 UserIntentHold

The interactive-work-avoidance path is a scheduling optimization layered below trusted execution: `composer transition → server hold acknowledgement → dispatch barrier → existing AgentRuntime / ForgeVerify authorities`.

The composer sends only a bounded `request` or `release` transition. Unsubmitted draft text is never included in the hold request, persisted hold record, SSE event, run projection, or ForgeGreen receipt. Submitted steers remain ordinary durable user messages and are queued in order with an idempotency identity.

`UserIntentHoldController` persists a run/session checkpoint, hold generation, state, and submitted steer queue. Generation-checked releases prevent a late client from releasing a newer hold. The barrier waits only at future model, tool, subagent, verifier, delivery, or publication dispatch boundaries; already-started processes and transactions are not aborted. Existing permission, cancellation, ForgeVerify, Completion Gate, delivery, and publication authorities remain unchanged.

The default desktop policy is `Expensive actions only`; `Always` and `Off` are stored through the existing desktop settings modal. The local composer uses one centralized 1.5-second quiet-grace policy and sends no per-keystroke network events. A stale hold lease is recoverable, while queued submitted steers remain durable until reconciliation.

When a turn becomes terminal, its queued steers are cleared and any waiting scheduling boundary is released. A terminal release is an audit event, not reconciliation or a resumption path; terminal state remains authoritative.

An approval or question wait remains an active turn for submitted-steer routing. Steering may be queued while the approval remains authoritative; it cannot resolve, bypass, or replay the approval.

At the post-approval execution boundary, the runtime admits an already-arrived steer before a synchronous guarded action can terminalize the turn. This is only scheduling: the approval decision still controls the action, and the steer neither grants approval nor waives verification. Public steer identities are preserved end-to-end so duplicate delivery is deduplicated by the durable queue rather than by incidental turn identity.

## Restart recovery

After an interruption, ForgeGreen preserves durable user intent and observed evidence but discards the stale computational continuation. `AgentRuntime` hydrates nonterminal turns into an explicit recovery hold, classifies durable execution records, and requires a new plan based on current workspace facts. It never recreates an interrupted child process, provider stream, tool callback, or model continuation. An ambiguous command remains ambiguous rather than being replayed.

Accepted steers remain ordered durable intent across restart and are reconciled exactly once at the new plan's safe model boundary. A restored pending approval remains an approval boundary; its later resolution authorizes recovery replanning only, never the old operation. Terminal cleanup and parallel scope boundaries remain authoritative. This avoids waste by stopping stale work, but it never treats avoided work as verification: ForgeVerify and Completion Gate continue to decide whether the new reality is sufficient.

## Steer revisions and scoped parallel steering

A material steer consumed at a safe boundary supersedes the authoritative execution revision instead of silently continuing the old one. In the workflow path the engine bumps the plan revision at its post-verification boundary and ForgeVerify issues a fresh verification plan bound to that revision; evidence produced for a previous revision can never authorize completion of the current one, so the run re-verifies rather than reusing stale authority. Steer text carries no authority over verification: it can only demand fresh verification, never skip or weaken it.

In the parallel path a steer may target one workstream explicitly (`targetWorkstreamId`). The scope binding is durable — it survives API retry, persistence, restart, and hydration — and only the targeted workstream holds, replans, and consumes the steer; sibling workstreams' dispatches, plans, and verification are untouched. Invalid or terminal targets are rejected rather than silently widened to a run-wide steer.

Durable runtime state (sessions, turns, holds, steer receipts, verification records) lives behind one driver-neutral async persistence contract with SQLite and PostgreSQL implementations, so the same efficiency semantics hold on both backends and across process restarts.

Interactive receipts expose only deterministic measurements: hold count/duration and dispatches actually blocked at an eligible boundary. No duration-only savings and no energy/carbon conversion are claimed.
