# CodeForge Free Model Qualification — R1

8-Bit owns qualification evidence for the free-cloud fleet. Discovery and price verification can
create a candidate route, but qualification is a separate bounded compact probe before
ForgeAuto/Free admission.

The compact suite records structured tool/output/edit evidence and assigns `QUALIFIED`,
`PROBATION`, `NOT_QUALIFIED`, `RATE_LIMITED`, `AUTH_REQUIRED`, `UNAVAILABLE` or stale/pending
state as appropriate. Rate limits and authentication failures do not become model-quality
failures. Qualification cycles are bounded by per-provider daily budget and interval.

Receipts inform the existing ForgeZero/ForgeRouter ranking inputs (`agentScore`,
`toolReliability`, `empiricalStatus`); they do not bypass ForgeZero or the completion gate.

Evidence: `packages/eight-bit/src/qualification/compact.ts`,
`packages/model-registry/src/free-cloud-service.ts`,
`packages/eight-bit/test/compact-qualification.test.ts`, and
`packages/eight-bit/test/qualification.test.ts`.
