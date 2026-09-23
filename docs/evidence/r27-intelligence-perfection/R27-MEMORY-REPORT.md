# R27 Memory Report

Status: `R27_MISSION_MEMORY_FRESHNESS_AND_BOUNDARIES_DETERMINISTICALLY_PROVEN`

## Findings

The implemented memory system is durable, structured, and scoped to a single autonomous mission;
it is not a cross-session preference or history system. It has a 16 KB serialized ceiling and
retains public summaries, evidence references, contracts, risks, failures, and steering data.
Private worker context and runtime transcripts remain outside it.

The stale marker was preserved durably after target drift but its stale milestone-summary text was
still passed to the replanner. That made a potentially outdated claim visible as advisory context.

## R27 correction

`projectMissionMemoryForPrompt` now removes `stale: true` milestone summaries from planner and
replanner input while exposing an omission count. The original memory record still retains those
entries for audit. Contradictory repository evidence continues to invalidate assumptions through a
runtime-owned replan, not a model assertion or memory claim.

## Deterministic validation

Thirty-nine tests passed across memory state, real-worktree drift acceptance, security, recovery,
steering, context-budget, and seeded retrieval-corpus suites. The new projection test proves stale
text is absent from planning JSON and that the projected fixture is smaller. Server, repository
intelligence, and context TypeScript builds pass.

## Boundary

There is no cross-mission task history, user preference, or project preference memory. Retrieval
relevance is measured only on the seeded corpus, and token cost is bounded only by deterministic
byte/context budgets—not a provider tokenizer or live model run. Unversioned public memory fields
remain untrusted context and can never establish acceptance or completion.
