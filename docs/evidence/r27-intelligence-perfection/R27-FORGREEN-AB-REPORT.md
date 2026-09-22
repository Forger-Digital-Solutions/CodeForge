# R27 ForgeGreen A/B Report

Status: `R27_FORGEGREEN_DETERMINISTIC_MECHANISM_PROVEN_LIVE_VALUE_NOT_PROVEN`

## Correction to the superseded R27 output

The prior R27 A/B script generated provider, token, context, tool, and elapsed-time values from
hard-coded simulation profiles. It only ran golden-task reference verifiers, not ForgeGreen or
AgentRuntime. Those former empirical efficiency and crossover claims are withdrawn. The retained
preflight confirms 13 of 15 reference fixtures pass and the two Python fixtures are honestly
`BLOCKED_ENVIRONMENT`.

## Deterministic production-runtime A/B

`packages/server/test/r21-forgegreen-ab.test.ts` was rerun with its structured receipt persisted
at `R27-FORGREEN-RUNTIME-DETERMINISTIC/forgegreen-ab.json`. It executes production AgentRuntime
arms with ForgeGreen OFF and ON, a deterministic scripted provider, and three alternating
repetitions per arm. The 15-test suite passed.

Across 13 deterministic tasks, the arms had equal terminal status, summary, and workspace hash.
ForgeGreen reduced physical tool executions from 103 to 81 (22 avoided) and the receipt recorded
7,821,991 model-visible context bytes versus 9,532,009 in control. Provider calls were unchanged,
as expected with a fixed model tool trace. Ten task medians showed a wall-time improvement, but
wall time is retained as a receipt rather than a performance guarantee.

The subagent-heavy case also records an important limit: ForgeGreen suppresses duplicate reads
within an agent run but not across sibling agents. Explorer overlap remains a measured waste
candidate; Coder rereads and Reviewer rereads remain intentionally distinct contexts.

`packages/forgegreen-campaign/test/` also passed 116/116 current tests.

## What is proven

- The ForgeGreen OFF/ON switch exercises the real runtime mechanism under controlled conditions.
- Duplicate read suppression can reduce physical tool work without changing deterministic output.
- The receipt exposes both benefits and the present cross-sibling boundary.

## Still unproven

- Live-model efficiency or correctness benefit
- Adaptive-topology crossover
- Live Explorer, Planner, or Reviewer value

Live proof requires paired free-route runs with identical repository state, model budget, verifier,
tool permissions, and completion criteria. Quota or route-health limitations must remain blockers,
not be converted into an outcome.
