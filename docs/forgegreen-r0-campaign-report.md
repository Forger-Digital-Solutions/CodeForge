# ForgeGreen R0 campaign report

## A. Starting state

- Repository: `G:\CodeForge`
- Branch: `forger-digital-solutions-forgegreen-certified`
- Starting HEAD: `2673f1374fa4d3d623bca187b4068128ce0a9e9c` (`2673f13`)
- Working tree: clean at audit time; R0 changes remain local and were not pushed.
- R4 relationship: additive measurement work only. The R4 verdict remains `CODEFORGE_R4_CAPACITY_LIMITED_EXTERNAL_EVIDENCE_PENDING`.

The R4 report, scale evidence, and provider research were read before implementation. No paid inference was performed and no OpenRouter daily counter was manufactured.

## B. Current-state audit

Before R0, CodeForge already had the ForgeGreen ledger, sustainability receipts and persistence, live context accounting, canonical repository caching, duplicate/no-progress suppression, tool-output compression, provider prompt-cache metadata, optimization receipts, and FG-8/FG-9 workspace events. The relevant runtime seams were `packages/server/src/agent-runtime.ts`, `packages/server/src/model-execution-adapter.ts`, `packages/tools/src/index.ts`, `packages/sessions/src/session-state.ts`, and `packages/protocol/src/workspace-events.ts`.

## C. Telemetry added

R0 adds `packages/forge-green/src/r0-telemetry.ts` and exports it from `packages/forge-green/src/index.ts`.

The bounded collector records run identity, optional repository revision/generation, route class and route attempts, model/provider attempts, provider-reported input/cached/output usage, derived total and effective uncached input, tool calls/executions/failures, raw output byte counts, model-context bytes, compression, duplicate-equivalent calls, context source categories, retries, provider failures/rate-limit signals, wall time, authority observations, completion status, and collector overhead. It stores no tool or source content.

The existing session work-item persistence now accepts `forgegreen_r0_telemetry`. One summary event, `forgegreen.r0_telemetry_recorded`, carries only bounded counters and the durable telemetry ID.

`ModelExecutionAdapter` now distinguishes `PROVIDER_REPORTED` usage from `UNKNOWN` when a provider ends without a usage event. `ToolExecutionRecord` carries only `rawOutputBytes`; redacted/bounded output remains the authoritative content. Runtime instrumentation is observational and is persisted best-effort in `finally`, so measurement failure cannot change routing, permissions, verification, or completion.

## D. Measurement sources

- `OBSERVED`: provider usage events, runtime dispatch/tool/context counters, and runtime status.
- `DERIVED`: total tokens when calculated from observed input plus output, effective uncached input, compression avoided bytes/ratio, and stable experiment deltas.
- `ESTIMATED`: not used for the R0 replay artifacts.
- `UNKNOWN`: absent provider cache metadata, provider cost/quota, ForgeVerify, and Completion Gate results in the local harness. Unknown is never encoded as zero.

Metric objects also identify their origin (`PROVIDER`, `RUNTIME`, `LOCAL`, or `SIMULATION`) where applicable.

## E. Baseline findings

The local deterministic replay measured three representative workloads:

| Workload | Status | Model attempts | Input / output tokens | Tool calls / executed / duplicate | Raw / delivered tool bytes | Compression avoided | Wall / R0 overhead |
|---|---|---:|---:|---:|---:|---:|---:|
| single local read | completed | 2 | 200 / 40 | 1 / 1 / 0 | 114 / 114 | 0 | 556 ms / 0.885 ms |
| repetitive large local output | completed | 2 | 200 / 40 | 1 / 1 / 0 | 10,392 / 734 | 9,658 | 491 ms / 0.117 ms |
| rotating unchanged discovery | blocked by no-progress guard | 6 | 600 / 120 | 6 / 3 / 2 | 321 / 895 | 0 | 804 ms / 0.197 ms |

Across these runs: 10 model attempts, 1,000 provider-reported input tokens, 200 output tokens, 8 tool calls, 5 physical tool executions, and 2 duplicate-equivalent suppressions. No provider failures or retries occurred. The strongest measured waste signal is large tool output: 10,392 authoritative bytes were represented to model context as 734 bytes. The second is repeated unchanged discovery: 2 of 6 requested tool calls were suppressed and the run was blocked rather than allowed to continue. These are observations from the replay, not population-wide rates.

## F. First experiment

The prompt-cache experiment uses the same local workspace state, repository revision, provider/model identifiers, route class, task shape, tools, permissions, and measurement policy. The control provider emits no cache metadata. The experiment provider emits cache-shaped metadata of 80 cached input tokens on each of two turns. Both runs finished with runtime status `completed`, two model attempts, 200 input tokens, and 40 output tokens.

This is a safe scripted replay, not a live provider cache operation. It demonstrates the comparison and false-win guard but cannot establish provider cache economics or authority parity.

## G. Efficiency result

The experiment artifact reports 160 cached input tokens and 40 effective uncached input tokens. The control's cached input is `UNKNOWN`, not zero, so the uncached-input delta is not valid. The replay comparison is `comparable: false`, `netPositive: false`, with reasons `VERIFICATION_PARITY_UNPROVEN`, `COMPLETION_PARITY_UNPROVEN`, and `UNCACHED_INPUT_UNKNOWN` (the exact wall-time result is run-dependent and is not treated as a win).

## H. ForgeGreen overhead

R0 overhead is measured inside the collector's record/finalize operations rather than from run start. The baseline runs measured 0.647 ms, 0.102 ms, and 0.289 ms respectively. The cache control/experiment replay measured 0.078 ms and 0.119 ms. These are local instrumentation timings, not a claim about production fleet cost.

## I. Security / isolation review

Telemetry stores counters, bounded identifiers, classifications, hashes/IDs already used by runtime decisions, and references; it does not retain raw tool output, prompt text, source content, or secrets. The R0 store requires matching `sessionId` when loading by run. Existing canonical-cache and duplicate-suppression scopes remain unchanged. The scripted provider is protected by the existing `CODEFORGE_ALLOW_TEST_PROVIDERS=1` test-only opt-in and is not a production route.

## J. Provenance review

Each durable record has a schema version, policy version, telemetry ID, run/session/workspace identity, route/model observations, measurement source/origin, and optional repository revision/generation. Evidence artifacts pin the starting revision and workload ID. Remaining gaps are explicit: ordinary callers that do not supply a repository revision remain revision-unknown; local R0 does not invoke ForgeVerify or Completion Gate; providers that omit usage/cost/cache fields remain unknown.

## K. Regressions

- `npm run typecheck`: PASS.
- Focused ForgeGreen R0 tests: 4 passed.
- Existing provider prompt-cache and FG-1 runtime-efficiency tests: 12 passed in the combined run.
- R0 evidence harness: PASS with no paid inference.
- Repository-wide Vitest: 333 test files passed, 7 skipped, and 1 failed; 2,497 tests passed, 36 skipped, and 1 failed. The single failure is the known intentionally red archived R3 smoke fixture documented by the R4 campaign.

## L. Deferred work

R0 does not implement live provider cache activation, cost/quota accounting, ForgeCapacity, energy/carbon estimates, new routing authority, new verification authority, or changes to the Completion Gate. A valid live prompt-cache experiment remains pending until a legitimate free provider exposes comparable cache/usage evidence while ForgeVerify and Completion Gate parity are available. R1 should be selected from measured evidence, not from the illustrative targets in the request.

## Verdict

`CODEFORGE_FORGEGREEN_R0_BASELINE_IMPLEMENTED_EXPERIMENT_PENDING`

The telemetry contract, durable artifacts, and local baseline are implemented and tested. The controlled cache-shaped replay is intentionally not certified as a production efficiency win because provider cache behavior, cost, and authority parity are not established.
