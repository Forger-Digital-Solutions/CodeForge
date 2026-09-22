# R27 Planner Semantic Compatibility Report

Status: `R27_PLANNER_SEMANTIC_COMPATIBILITY_DETERMINISTIC_PROVEN_LIVE_QUALITY_NOT_PROVEN`

## Finding

Production Planner authorization previously accepted one legacy task-graph wire shape, while the
qualification probe judged a looser shape. That made protocol compliance an accidental proxy for
Planner quality and allowed qualification/runtime disagreement.

## R27 correction

The runtime now accepts either `task_graph_v1` or `semantic_steps_v1`. A semantic step names an
`intent`, a constrained `phase`, and explicit predecessor ids. The parser converts that form into
the existing canonical task graph; it does not bypass any later gate. Legacy payloads without a
protocol field remain interpreted as `task_graph_v1` for compatibility.

`semantic_steps_v1` rejects mixed schemas, unknown phases, and missing `after` arrays. After
normalization, the unchanged planning-completeness check, graph authorization, dependency check,
review, ForgeVerify, and completion gate remain authoritative.

Planner qualification is versioned to `PLANNER_PROTOCOL_V2` under
`R27_ROLE_QUALIFICATION_V2` and now invokes the production parser. The frozen
`PLANNER_PROTOCOL_V1` remains in source so historical R24 receipts retain their original meaning.

## Deterministic validation

Four focused suites passed 39/39 tests in approximately 62 seconds, covering parser adversarial
inputs, both qualification protocols, AgentRuntime structured output, and a complete production
orchestrator run using semantic steps. Agent, Eight-Bit, and Server typechecking also passed.
Every provider in this validation was scripted; no paid or live cloud inference was used.

The broader autonomous-orchestration regression passed 39/39 tests across five integration suites
in approximately 149 seconds. The independent R27 Eight-Bit route-health/lifecycle/drift suite
also passed 38/38.

## Boundary

This proves compatibility and preservation of the deterministic safety path. It does not prove
that live models plan better, qualify more often, or use fewer tokens with the new protocol. Those
claims require paired live free-route runs with identical repositories, budgets, verifiers, and
completion criteria; unavailable capacity remains a blocker, not a substitute result.
