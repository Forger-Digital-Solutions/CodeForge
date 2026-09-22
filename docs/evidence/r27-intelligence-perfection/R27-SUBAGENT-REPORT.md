# R27 Subagent Value Report

Status: `R27_SUBAGENT_MECHANICS_PROVEN_LIVE_VALUE_NOT_PROVEN`

## What was verified

The existing orchestrator integration suite was run against the current source, not inferred from
class presence. It covers the production pipeline, isolated coder worktrees, Explorer/Planner/
Reviewer lifecycle records, bounded Explorer ceilings, malformed or unauthorized Planner graphs,
adaptive topology selection, deterministic review/revision, parallel orchestration, cancellation,
and recovery paths.

Command:

```text
node node_modules/vitest/vitest.mjs run packages/server/test/r21-adaptive-topology-wiring.test.ts packages/server/test/agent-orchestrator-integration.test.ts packages/server/test/autonomous-orchestrator.test.ts packages/server/test/mission-acceptance.test.ts packages/server/test/parallel-orchestrator-integration.test.ts
```

Result: 5 test files passed, 38/38 tests passed. Wall time was approximately 106 seconds, with the
worktree and recovery portions accounting for most of the run.

## Deterministic value evidence

- Tiny tasks select Coder → ForgeVerify and spawn no Explorer, Planner, or independent Reviewer.
- Normal tasks select Explorer → Coder → Reviewer → ForgeVerify.
- Complex tasks select two Explorers → Planner → Coder → Reviewer → ForgeVerify when capacity allows.
- Constrained provider capacity reduces parallel exploration without overriding an explicit topology.
- A deterministic Reviewer finding drives a bounded coder revision and can block unsafe completion.
- Planner graphs with cycles or missing dependencies are rejected before the Coder starts.
- Coder work is isolated in a Git worktree and lifecycle/artifact records are persisted.

These prove that the topology and safety contracts are real and that a Reviewer can add a
deterministic correction gate in a controlled fixture.

## What is not proven

This is not evidence that free-model subagents improve real engineering outcomes. The test provider
returns controlled outputs, so it cannot establish Explorer relevance, Planner quality, Reviewer
precision/recall, reconciliation quality, or net token/call benefit on live models. R26's live
subagent value A/B was quota-limited and was not repeated here. No paid inference was used.

The R27 live experiment remains required: paired task runs with the same repository state and model
budget, comparing no-subagent, selective, and full topologies across tiny, small, medium, large,
ambiguous, adversarial, and recovery classes. A topology may only be called valuable when it
improves correctness or autonomy enough to justify its measured calls, tokens, and wall time.

