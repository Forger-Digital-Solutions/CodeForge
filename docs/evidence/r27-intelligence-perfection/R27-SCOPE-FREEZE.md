# R27 Scope Freeze — Single-User Intelligence First

**Campaign:** R27 Intelligence Perfection & Single-User Mastery  
**Effective baseline:** `c42a8bc35d95a1c158703ad99d92945f5b4fbe17`  
**Date:** 2026-09-22

## Decision

R27 is scoped to making one local CodeForge instance materially more intelligent,
reliable, autonomous, efficient, and useful. Existing multi-user behavior remains
protected by regression tests and release gates, but multi-user expansion is frozen
as a primary workstream until the single-user intelligence scorecard has evidence of
real-world value.

## Explicitly deferred

Unless a change is required to fix a single-user defect, R27 will not spend campaign
time on:

- 373 DAU capacity claims or owner-pool scaling;
- shared-owner inference capacity and hosted-fleet multiplication;
- public queue throughput, multi-user fairness expansion, or SaaS concurrency;
- multi-tenant cost projections, public rollout economics, or provider-account packing;
- expanding managed hosted capacity or clearing managed-free fleet terms;
- large-user admission simulations and horizontal hosted scaling.

The existing durable admission, fairness, and hosted paths are preserved. They remain
release-regression surfaces, not R27 optimization targets.

## In scope

The primary R27 evidence target is a complete single-user engineering loop:

```text
request → understand → explore → plan → implement → validate → repair → review → result
```

The campaign therefore prioritizes core task quality, ForgeGreen, 8-Bit, subagent
value, ForgeVerify, context, tool use, browser, Git/GitHub safety, recovery,
observability, UX, performance, and exact packaged-desktop behavior.

## Guardrails

- No paid inference is used for baseline or deterministic architecture evidence.
- Live paid probes require a separately recorded necessity and cost budget.
- Free eligibility remains ForgeZero-authoritative and fail-closed.
- GEMS remains simulation/entitlement-bound; no GEMS integration is fabricated.
- `evaluateCompletion` remains the only authority that can produce `completed`.
- Existing multi-user functionality must not regress; no claim of new scale is implied.

## Exit criterion for removing the freeze

The freeze can be revisited only after the final R27 report has a measured,
repeatable single-user value result and explicitly states which multi-user claims are
still unsupported. Passing unit tests alone is not sufficient.
