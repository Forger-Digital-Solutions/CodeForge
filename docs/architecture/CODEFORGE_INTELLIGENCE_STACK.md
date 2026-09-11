# CodeForge Intelligence Stack

This is the canonical responsibility contract for the production paths that coordinate execution, efficiency, free-model supply, optional GEMS capability, and verification. It documents the existing implementation; it does not introduce another router, ledger, cache, or completion path.

## Authority

| Component | Production responsibility | It cannot authorize |
| --- | --- | --- |
| CodeForge | Session, workflow, tool, approval, recovery, provider invocation, and completion orchestration | A paid or unapproved action outside its existing policies |
| ForgeGreen | Deterministic work avoidance, evidence planning, reuse, delta analysis, and honest efficiency receipts | Approval, security policy, verification success, or completion |
| 8-Bit | Eligible $0 model supply, capability fit, live health, deterministic selection, and failover | Task strategy, verification sufficiency, evidence reuse, or completion |
| GEMS | Optional premium capability boundary | Any execution, policy, security, verification, or completion decision |
| ForgeVerify | Required verifier planning and execution evidence | Workflow orchestration or a completion bypass |

The production order is:

```text
user intent / authorization
  -> CodeForge runtime and approval policy
  -> optional GEMS capability selection or advice boundary
  -> ForgeGreen necessity and evidence constraints
  -> CodeForge + 8-Bit / ForgeZero routing
  -> execution
  -> ForgeVerify evidence
  -> CodeForge evaluateCompletion
```

`packages/server/src/agent-runtime.ts` owns interactive execution and `packages/workflow/src/workflow-engine.ts` owns workflow execution. `packages/workflow/src/completion-gate.ts` is the sole completion decision point: no ForgeGreen, 8-Bit, or GEMS output can set a run to `completed`.

## Feature-off behavior

CodeForge Free is CodeForge + ForgeGreen + 8-Bit + ForgeVerify. GEMS is not a dependency of routing, recovery, verification, evidence resolution, persistence, or completion. Today GEMS is implemented as an entitlement-protected premium model boundary; there is no production learned-recommendation consumer. No recommendation schema, score, or marginal-value metric is invented until one has a real consumer.

ForgeGreen remains optional for correctness. A disabled, cold, corrupt, or unavailable ForgeGreen cache causes recomputation and canonical verification, never success by omission.

## ForgeGreen validity rules

ForgeGreen uses repository-native cache and receipt storage. Reuse is valid only when its identity is sufficient for the evidence class:

- context and repository analyses bind workspace namespace, relevant content or graph generation, policy, parser, and runtime configuration;
- FG-6 verification evidence additionally requires the exact workspace path, input-state hash, execution revision when one is required, verification policy version, scope, kind, and targeted paths when applicable;
- FG-6 resolution cache receipts carry the canonical input `cacheIdentity`. Resolver version `fg6-evidence-resolution-2` rejects older, malformed, mismatched, or incomplete cache payloads and creates a fresh plan;
- broad verification can subsume narrower obligations only through the explicit configuration-backed FG-6 planner. An unscoped evidence record cannot claim that authority;
- unknown, missing, stale, failed, skipped, or policy-mismatched evidence fails toward fresh execution.

The existing `DuplicateActionSupervisor` permits suppression only for an allowlist of read-only repository tools and binds identity to canonical arguments, workstream, policy, and workspace state version. Writes, edits, commands, external effects, and unknown operations execute rather than being deduplicated. Recovery classifies incomplete side effects conservatively and requires revalidation or replanning.

## Supply and verification boundaries

8-Bit evaluates role capability requirements, ForgeZero free eligibility, adapter availability, live health, cooldown, context capacity, and reliability before ranking. A selected route is revalidated by the execution adapter immediately before invocation. On failure, 8-Bit records health and a duplicate-safe receipt, then can rotate only an adaptive free route; exact pins are surfaced rather than silently replaced. It continues the same durable conversation state and does not replay completed tools.

ForgeVerify executes the structured verifier plan and records evidence. ForgeGreen may reduce redundant evidence producers, but cannot declare an obligation satisfied without identity-valid evidence. `evaluateCompletion` independently rejects missing, failed, stale, or revision-mismatched verification.

## Measurement and bounds

ForgeGreen records only operational facts it can classify: measured provider cache tokens when reported, deterministic bytes or dispatches avoided, cache outcomes, evidence reuse, and unknown quantities. It does not treat cache misses, failed work, deferred work, rejected reuse, or suggestions as savings. FG-8 (`docs/codeforge-forgegreen-measurement-contract.md`) adds a pluggable, versioned energy/carbon estimator with an explicit confidence classification (`DIRECT` … `INSUFFICIENT_DATA`) and provenance record on every figure it produces; absent a calibrated hardware or provider telemetry source, energy and carbon are still reported as `INSUFFICIENT_DATA`, never invented — FG-8 makes "unknown" explicit and auditable rather than claiming a number.

In-memory advisor and duplicate-action maps have configured bounds. Durable ForgeGreen, 8-Bit, ForgeVerify, and session records use the established session persistence abstraction and idempotent insertion primitives; no parallel data store is introduced.
