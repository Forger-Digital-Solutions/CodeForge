# ForgeGreen FG-9 — optimization & efficiency policy contract

## Status

Phase 4 ("ForgeGreen optimization & efficiency policy"). Implementation: `packages/forge-green/src/optimization-*.ts`. Tests: `packages/forge-green/test/fg9-*.test.ts`, `packages/server/test/fg9-unsafe-mutating.test.ts`. Certification: `docs/codeforge-forgegreen-phase4-certification.json`/`-report.md`.

This document extends `docs/forgegreen.md` (FG-1…FG-8R) and `docs/codeforge-forgegreen-measurement-contract.md` (FG-8/FG-8R measurement). It does not redesign either.

## 1. Authority boundary

FG-9 gains narrowly scoped optimization authority **only** over the four resource-control surfaces named below. It has and can never gain authority over: final model selection, free/paid classification, 8-Bit qualification, provider safety, security policy, approval requirements, ForgeVerify verdicts, Completion Gate verdicts, user intent, task completion, permissions, authentication, or billing. Every `ForgeGreenOptimizationDecision`/`ForgeGreenOptimizationReceipt` is structurally incapable of carrying a model-selection, approval, verification-verdict, or completion field — proven in `fg9-privacy-authority.test.ts` (§34-37) by key-absence assertion, and proven behaviorally by `fg9-unsafe-mutating.test.ts` against the real FG-1C supervisor.

The operating sequence is always `MEASURE → IDENTIFY → PROPOSE → GUARD → APPLY → VERIFY → COMPARE`, never `REDUCE RESOURCE USE → HOPE QUALITY SURVIVES`.

## 2. Policy modes

`OptimizationPolicyMode`: `OFF` (no candidate detection), `SHADOW` (candidates identified and recorded, execution never altered), `ACTIVE_SAFE` (a graduated kind may actually take effect). Resolved per-kind via `resolveOptimizationMode` (`optimization-policy.ts`)'s versioned `GRADUATION_REGISTRY` — never one global switch. An optional `CODEFORGE_FORGEGREEN_OPTIMIZATION` env var can only ever *lower* a kind's effective mode (a ceiling), never raise a `SHADOW` kind to `ACTIVE_SAFE`.

`createOptimizationDecision` enforces the boundary at construction: a decision for a kind whose resolved mode is not `ACTIVE_SAFE` can never carry status `APPLIED` — this is a type/runtime invariant, not caller discipline (`fg9-decision-framework.test.ts`).

## 3. Candidate taxonomy

| Kind | Mode this phase | What it composes | Why |
|---|---|---|---|
| `DUPLICATE_READ_ONLY_TOOL_REUSE` | **ACTIVE_SAFE** | FG-1C `DuplicateActionSupervisor` (`packages/server/src/duplicate-suppression.ts`) — ALREADY ACTIVE in production | FG-9 introduces no new suppression logic; it wraps already-happening, already-certified behavior into the decision/receipt provenance framework. Zero new execution-path risk. |
| `DUPLICATE_CONTEXT_PAGE_TRANSMISSION` | SHADOW | FG-3D context-page identity (`packages/context`) | Detects a page transmitted more than once with an identical content hash AND workspace revision. Not yet wired into live context assembly this phase. |
| `OPTIONAL_PREFETCH_SUPPRESSION` | SHADOW | FG-3's `omittedOptionalPages`/progressive-context concepts | Proposes suppressing prefetch only when explicitly non-required AND already validly available. Not yet wired into live context assembly this phase. |
| `VERIFICATION_EVIDENCE_REUSE` | **ACTIVE_SAFE (cost-gated, FG-12F)** | FG-5/FG-6 verification-policy/evidence-resolution validity semantics | Reuse is proposed **only** when the caller passes an explicit `forgeVerifyConfirmedValid: true` — FG-9 never independently judges verification validity. Since FG-12F the kind's ACTIVE_SAFE execution policy is cost-gated: see §15. |

Per §22 of the task's own instruction ("if only one is defensible, activate one"), only Candidate A graduated at FG-9. Candidate D graduated at FG-12F under its own cost-gated execution policy after the FG-12D controlled trial and FG-12E performance characterization (break-even ≈152 ms, IQR 139–184 ms).

## 4. Decision & receipt schema

`ForgeGreenOptimizationDecision` (`optimization-types.ts`): identity (decisionId, runId, sessionId, policyVersion, mode, createdAt), candidate (kind, targetResource, sourceEvidenceIds, sustainabilityReceiptId), `expectedEffect` (avoidedRequests/Tokens/Bytes/ToolExecutions/VerificationReruns/timeReductionMs — each `undefined` unless evidence supports it), `confidence` (reuses `SustainabilityConfidence`), `safetyGuards` (redundancyRationale, invariant, verificationProof, reasonCodes), `status` (`PROPOSED`/`APPLIED`/`REJECTED`/`SKIPPED_INSUFFICIENT_EVIDENCE`/`ROLLED_BACK`/`INVALIDATED`), finalization.

`ForgeGreenOptimizationReceipt` links before → decision → after → verification: `beforeSustainabilityReceiptId`/`afterSustainabilityReceiptId` (references, never embedded duplicates), `resourceDelta` (tagged `measured`/`replayed`/`simulated`/`projected` — a `measured` delta requires BOTH receipt references, enforced at construction), `verificationEvidenceRef`, `qualityResult` (`EQUIVALENT`/`IMPROVED`/`REGRESSED`/`UNKNOWN`), `survivedValidation` (can only be `true` for an `APPLIED` decision, enforced at construction), `rollbackStatus`.

Both are content-addressed (hash of identity + measured content, matching the FG-8R fix to `SustainabilityReceipt.receiptId`): an exact retry yields the identical id (true idempotency via `insertIfAbsent`); a retry that legitimately observed different evidence yields a genuinely different id (never silently merged).

## 5. Shadow-mode semantics

In `SHADOW` mode a detector (`optimization-candidates-shadow.ts`) is a pure function: it identifies a candidate, computes `expectedEffect`, and returns a `PROPOSED` decision — it never mutates its input, never calls a tool, never alters context assembly or verification execution. `fg9-shadow-mode.test.ts` proves the candidate objects passed in are byte-identical after detection and that no field on a `PROPOSED` decision claims a measured outcome.

## 6. Quality floor & context/mutating-tool safety guards

An optimization is rejected outright if it would remove context that is explicitly user-requested, required by an active tool/command, included by a verification obligation, required by a known dependency/import relationship, needed to preserve current working-state understanding, or pinned by another authority — encoded as the `required`/`alreadyValidlyAvailable` flags on Candidate C's input; `required: true` always wins. Mutating tools (`write_file`, `edit_file`, `run_command` — installs/deployments included, since those run via `run_command`) are **never** cacheable: `READ_ONLY_SUPPRESSIBLE` and `MUTATING_TOOLS` are disjoint by construction in FG-1C, proven directly against the real supervisor in `packages/server/test/fg9-unsafe-mutating.test.ts`.

## 7. Verification relationship

FG-9 never invents a parallel verification-cache validity policy. `detectReusableVerificationEvidence` only ever proposes reuse for evidence whose `forgeVerifyConfirmedValid` field is an explicit `true` supplied by the caller — never computed by FG-9 from workspace/policy hashes alone. Removing verification is never representable as an optimization (unchanged from FG-8's Baseline D). "Verification skipped" is never a valid receipt state; "existing valid verification evidence reused" (ForgeVerify-authorized) is the only representable reuse.

## 8. Persistence

`OptimizationDecisionStore`/`OptimizationReceiptStore` (`optimization-persistence.ts`) use the same `ISessionPersistence` abstraction as every other ForgeGreen receipt, as two new append-only `WorkItem` kinds: `forgegreen_optimization_decision`, `forgegreen_optimization_receipt` (`packages/sessions/src/session-state.ts`). `insertIfAbsent` guarantees a retried write of the same content-addressed id is a no-op — proven for restart, non-reapplication, and non-doubled prevented-work accounting in `fg9-persistence.test.ts`.

## 9. Privacy

Only ids, hashes, counts, and byte sizes are ever recorded — never prompt text, source contents, tool arguments/output, secrets, or environment variables. Candidate A's live evidence (`DuplicateToolSuppressionEvent`) captures a tool name, an identity-key **hash**, a prior-execution **id**, and a byte **length** (never the replayed content itself). `fg9-privacy-authority.test.ts` proves secret/prompt/source-shaped extra fields injected onto raw evidence never appear in a built decision/receipt's JSON.

## 10. Observability

`forgegreen.optimization_candidate`, `optimization_applied`, `optimization_rejected`, `optimization_invalidated`, `optimization_summary` (`packages/protocol/src/workspace-events.ts`, emitted via `packages/server/src/workspace-event-adapter.ts`). Aggregated once per run per kind — never one event per candidate/suppression instance.

## 11. Rollback / fail-open behavior

If the FG-9 optimization subsystem itself fails (a thrown detector, a persistence rejection), the failure is caught in its own try/catch — isolated from FG-8/FG-8R's sustainability measurement above it — logged via `console.error`, and the agent run proceeds completely unaffected. No run is ever failed because an FG-9 lookup or decision-construction call errored. For an `APPLIED` decision later found unsafe by post-hoc verification, the correct representation is a fresh `INVALIDATED` decision (never a mutation of the original — immutability preserved) plus a receipt with `qualityResult: "REGRESSED"`, `survivedValidation: false`, `rollbackStatus: "ROLLED_BACK"` — never a silently-dropped or falsely-successful record.

## 12. Before/after comparison rules

`resourceDelta.basis` distinguishes `measured` (both before/after are real `SustainabilityReceipt`s — requires both ids, enforced), `simulated` (a deterministic counterfactual replay — Candidate A's live receipts use this basis: "before" is the naive re-execution of the suppressed calls, not a second real run), and `projected` (expected-only, no after-measurement exists yet — a `SHADOW` decision's `expectedEffect` is always this category and is never relabeled as measured). Raw values are always reported alongside any percentage; a percentage is never presented alone.

## 13. Energy/carbon

Unchanged from FG-8/FG-8R: `INSUFFICIENT_DATA` in production. FG-9 reports resource-count reductions (tool calls, bytes) separately and never converts them into an energy/carbon figure without a defensible power model — none exists yet.

## 14. Relationship to ForgeAuto / 8-Bit / ForgeVerify / Completion Gate

Unchanged. FG-9 reads already-computed state (FG-1C's supervisor metrics) and writes only its own decision/receipt records. It never calls into 8-Bit's routing, ForgeVerify's execution, or the Completion Gate, and none of those subsystems read FG-9 output.

## 15. FG-12F — Candidate D's cost-gated ACTIVE_SAFE execution policy

FG-12F wired `VERIFICATION_EVIDENCE_REUSE` into the real production verification path. The kind's registry mode is `ACTIVE_SAFE`, but that mode means **cost-gated** reuse — never unconditional:

- **Policy**: `fg12f-verification-reuse-cost-gated-1` (`packages/forge-green/src/reuse-cost-policy.ts`). Threshold **250 ms**, inclusive (`estimatedFreshMs >= 250` is eligible; 249 is not). FG-12E measured break-even ≈152 ms (IQR 139–184 ms); 250 ms sits above the p75 reuse overhead (184 ms) and at the low end of the measured consistently-positive class, keeping the cheap `node --check` class (~81 ms) fresh.
- **Unknown cost → fresh verification** (fail closed). A verifier with no trusted duration history is never reused on a guess; its first fresh execution persists its real `elapsedMs`, making the next equivalent invocation cost-eligible (natural learning, no prediction model).
- **Cost history source**: `elapsedMs` of prior PASSED evidence records for the same verifier identity (id + version + definition digest), read from the session's already-persisted ForgeVerify evidence — most-recent-5 median. No second telemetry store is created.
- **Authority boundary (unchanged)**: ForgeVerify's `isEvidenceCurrentlyValid` is decided FIRST and always; the cost gate can only veto an already-valid reuse. `executeVerificationPlan` revalidates at the authoritative execution boundary, unchanged.
- **Seam**: one shared integration point — `runVerification` (`packages/workflow/src/verification-service.ts`) consults the observer-provided durable prior evidence through `adviseCostGatedReuse` between authoritative plan construction and `executeVerificationPlan`. All five production callers reach it via their existing persistence-backed `ForgeVerifyObserver`; no caller contains rollout logic.
- **Receipts**: a per-verifier `VerificationReuseCostGateReceipt` (schema `fg12f-cost-gate-receipt-1`) is attached to the verification report and persisted as an immutable `cost_gate_receipt` work item. Actual reuse is counted only from ForgeVerify's real `reusedEvidenceId` — never from advisor proposals.
- **Kill switch**: the existing `CODEFORGE_FORGEGREEN_OPTIMIZATION` ceiling is fully effective (OFF disables immediately with no receipt path; SHADOW degrades the kind to observation-only), without restart. Any advisor/duration-lookup failure falls back to fresh verification.

Certification evidence: `docs/codeforge-forgegreen-fg12f-cost-gated-rollout.json` / `-report.md` (40-case corpus through production composition + component overhead measurement). Certified source-state: `fg12f-certified-v1` in `docs/codeforge-forgegreen-certified-source-state.json`.
