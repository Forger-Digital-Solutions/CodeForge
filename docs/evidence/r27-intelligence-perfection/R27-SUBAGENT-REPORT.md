# R27 Subagent Value Report

Status: `R27_SUBAGENT_DETERMINISTIC_VALUE_PARTIALLY_PROVEN_LIVE_VALUE_NOT_PROVEN`

## Evidence boundary

No live model inference or paid inference was used. The R27 runtime comparison uses equivalent
temporary repositories, the same coder executor, semantic verifier, and completion gate. Only the
adaptive arm invokes the production Explorer/Planner/Reviewer path through a deterministic scripted
free provider. Its structured receipt is `R27-SUBAGENT-RUNTIME-DETERMINISTIC.json`.

## Structural coverage

The current orchestrator integration rerun covers isolated coder worktrees, persisted lifecycle
records, bounded exploration, planner authorization, cancellation, recovery, and deterministic
review/revision. It passed 38/38 tests across five files in approximately 82 seconds.

## Controlled runtime comparison

| Scenario | Single-agent result | Adaptive result | Observed consequence |
| --- | --- | --- | --- |
| Tiny multiplication fix | completed, 0 child calls | completed, 0 child calls | Adaptive correctly stays out of the way. |
| Healthy normal task | completed, 0 child calls | completed, 2 child calls | Extra coordination had no deterministic correctness gain. |
| Reviewer-repair task | blocked by semantic verifier | completed after 1 revision, 3 child calls | The controlled Reviewer finding triggered a bounded repair that changed the terminal outcome. |
| Healthy complex task | completed, 0 child calls | completed, 4 child calls | Extra coordination had no deterministic correctness gain. |

AgentRuntime observed request bytes for the adaptive role calls. The test provider reports scripted
token usage, and wall time is retained as a receipt rather than a crossover claim. The focused
protocol fixture emits no tool calls. Every successful arm passed ForgeVerify and the completion
gate; the one single-agent repair arm ended `blocked` rather than being counted as success.

## What is proven

- Tiny work reaches the smallest useful topology with no child-agent overhead.
- The adaptive normal and complex paths invoke the production subagent lifecycle and free-fabric
  admission path.
- A Reviewer can supply a blocking finding, trigger one bounded coder revision, and enable a
  subsequent semantic-verifier pass.
- Coordination cost is measurable and visible where both arms have equal correctness.

## What remains unproven

This does not establish live Explorer relevance, Planner semantic quality, Reviewer precision or
recall, conflict reconciliation, or net live-model benefit. A scripted provider follows its fixed
role protocol, so it cannot establish a real topology crossover point. Live proof requires paired
free-route runs with the same repository state, model budget, verifier, tool permissions, and
completion criteria. Quota, route-health, or availability constraints must remain recorded as
blockers rather than converted into a result.
