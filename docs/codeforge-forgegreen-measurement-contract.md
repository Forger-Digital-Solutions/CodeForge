# ForgeGreen FG-8 — sustainability & resource-measurement contract

## Status

Phase 3 ("ForgeGreen measurement infrastructure"), closed by FG-8R ("live-measurement closure"). Implementation: `packages/forge-green/src/sustainability-*.ts`, `measurement-normalization.ts`, `waste-taxonomy.ts`, `energy-estimator.ts`, `hardware-telemetry.ts`, `baseline.ts`, `live-context-adapter.ts`. Tests: `packages/forge-green/test/fg8-*.test.ts` (original) and `packages/forge-green/test/fg8r-*.test.ts` (live-wiring closure). Certification: `docs/codeforge-forgegreen-phase3-certification.json`/`-report.md` (current verdict `CODEFORGE_FORGEGREEN_FG8R_LIVE_MEASUREMENT_CLOSURE_CERTIFIED`).

This document is the authoritative contract for FG-8/FG-8R. It does not replace `docs/forgegreen.md` (FG-1…FG-7) or `docs/architecture/CODEFORGE_INTELLIGENCE_STACK.md` (the cross-stack authority-boundary contract) — it extends both, consistently with their existing invariants.

## 1. Responsibilities

FG-8 measures, classifies, and reports resource consumption and modeled sustainability impact for an agent run:

- Token/request accounting (provider-reported).
- Tool-call accounting (directly measured by CodeForge).
- Verification-activity accounting (derived from FG-5/FG-6/FG-7's own authoritative counters).
- Routing/retry/fallback accounting (derived from 8-Bit/FG-1E ledger counters).
- Context-behavior accounting (pages reused/pulled, bytes/tokens avoided — derived from FG-3D).
- A conservative waste taxonomy over the above.
- A deterministic, zero-network baseline/counterfactual framework (four baseline kinds).
- Pluggable, versioned energy/carbon estimation with an explicit confidence classification.
- A durable, immutable-once-finalized `SustainabilityReceipt` and a deterministic human-readable summary.

## 2. Non-responsibilities / authority boundaries

FG-8 **never**:

- Grants, denies, or influences a permission, approval, or execution decision.
- Decides verification sufficiency or contributes to `evaluateCompletion` (Completion Gate remains the sole completion authority — `packages/workflow/src/completion-gate.ts`).
- Selects, ranks, or fails over a model or provider (8-Bit remains the routing authority — `packages/eight-bit`).
- Reclassifies a route's free/paid status (`FinancialReceipt`/`RouteReceipt` in `packages/eight-bit/src/receipts.ts` remain the sole financial/routing authorities; FG-8 only *references* their receipt ids and *verifies consistency*, per §8 below).
- Fails an otherwise-valid agent run. A measurement failure is always caught, reported via a best-effort event, and recorded as an explicit `measurementStatus: "failed"` receipt (§7) — never propagated.
- Claims a savings percentage without a reconstructable baseline (§6) — "no baseline means no savings claim."
- Represents removing or weakening verification as an optimization (Baseline D's numerator/denominator are always `undefined`).
- Persists prompt text, source file contents, tool output, or secrets (§9).

## 3. Receipt schema (`SustainabilityReceipt`, `packages/forge-green/src/sustainability-types.ts`)

Top-level identity: `receiptId`, `runId`, `sessionId?`, `taskId?`, `workflowId?`, `workspaceIdentityHash?`, `createdAt`, `receiptSchemaVersion` (`fg8-receipt-1`), `normalizationVersion` (`fg8-normalization-1`), `finalized`, `finalizedAt?`.

Status: `measurementStatus` (`complete` | `incomplete` | `failed`) + `measurementFailureReasonCodes[]` — never empty when status isn't `complete`.

Accounting sections (each with its own `MetricCoverageClass`): `tokenAccounting`, `toolAccounting`, `verificationAccounting`, `routingAccounting`, `contextAccounting`, `timing`.

Derived sections: `crossReceiptIntegrity`, `wasteBreakdown[]`, `baselines[]`, `energyEstimate`, `carbonEstimate`, `measurementCoverage` (the certification-facing per-metric coverage map).

**Versioned normalization boundary.** `NormalizedMeasurementInput` (`sustainability-types.ts`) is FG-8-owned and built by `normalizeMeasurementInput` (`measurement-normalization.ts`) from loosely-typed, structurally-matched "raw" shapes (`RawAgentUsageLike`, `RawToolExecutionLike`, `RawRouteReceiptRefLike`, `RawFinancialReceiptRefLike`) — never a nominal import of `@codeforge/agent`'s `AgentUsage`, `@codeforge/tools`'s `ToolExecutionRecord`, or `@codeforge/eight-bit`'s `RouteReceipt`/`FinancialReceipt`. This is deliberate: a rename or shape change in those packages cannot silently break interpretation of a historical receipt, because every receipt persists `normalizationVersion`, and normalization degrades absence to `undefined`/`"unavailable"` rather than throwing.

## 4. Measured vs. provider-reported vs. derived vs. estimated

| Category | Examples | `MetricCoverageClass` |
|---|---|---|
| Directly measured by CodeForge | tool call counts, tool wall-clock, run wall-clock (`AgentRuntime` times `forgeGreenRunStartedAtMs` → the receipt's finally-block persistence point) | `directly_measured` |
| Provider-reported | input/output/cached tokens, request count | `provider_reported` |
| Derived from CodeForge's own authoritative telemetry | verification obligation counts (FG-5/6/7), routing/fallback counts (8-Bit/FG-1E), context-page reuse (FG-3D) | `derived_from_authoritative_telemetry` |
| Replayed | a receipt regenerated from persisted evidence rather than a live run | `replayed` |
| Simulated | baseline counterfactuals (§6) | `simulated` |
| Estimated | energy/carbon, when a versioned estimator has enough input | `estimated` |
| Unavailable | anything with no source | `unavailable` |

Unknown or failed measurement is represented as `undefined` (numeric fields) or `"unavailable"`/`"failed"` (classification fields) — **never converted to `0`.**

## 5. Waste taxonomy (`waste-taxonomy.ts`)

`useful_work`, `retry_overhead`, `routing_overhead`, `failed_attempt_waste`, `duplicate_work` (folded into `prevented_waste` when the FG-1C supervisor actually suppressed it — see below), `context_waste` (deliberately never emitted this phase — no defensible per-run heuristic exists yet), `verification_overhead` (tracked, never treated as waste), `prevented_waste`.

`prevented_waste` is emitted **only** from counters that are themselves mechanism-proven counterfactuals already tracked by earlier FG phases: FG-1C duplicate-action suppression, FG-5 verification-rerun avoidance / full-suite avoidance, FG-3D context-page reuse. It is never derived from a speculative baseline simulation — baseline comparisons (§6) are a distinct mechanism and are never folded into the taxonomy as if they were the same kind of proof.

## 6. Baseline / counterfactual framework (`baseline.ts`)

| Kind | What it compares | Basis | Notes |
|---|---|---|---|
| `A_FIXED_MODEL_NO_SMART_ROUTING` | Requests continued past a provider failure vs. total requests | `simulated` | A fixed single-model deployment has no rotation mechanism; every actual fallback is a request it could not have continued past. |
| `B_NAIVE_FULL_CONTEXT` | Bytes avoided vs. an explicit naive full-context policy | `simulated` | Requires a `ContextComparisonPopulation` (eligible/excluded files with reasons, eligible/actual/naive bytes). Repository size is never equated with eligible context; absent a population, Baseline B is simply not computed. **FG-8R**: live-wired via `computeLiveContextPopulation` (`live-context-adapter.ts`) — a bounded, zero-duplication read-model over `RepositoryIntelligence.getCompleteness()` + one bounded `listFiles()` call. `QueryPage.truncated` decides exact-sum vs. honestly-unavailable bytes; never a sampled/extrapolated figure. |
| `C_NAIVE_SEQUENTIAL_RETRY` | Doomed calls skipped vs. a naive retry-until-something-works strategy | `simulated` | Uses the real `modelFailoverBlockedDispatches` counter — a recorded refusal, not a guess. |
| `D_VERIFICATION_OVERHEAD_COMPARISON` | Verification obligation counts, reported for transparency | `measured` | Numerator/denominator are always `undefined`. Never a savings source. |

Every `BaselineComparison` persists: `baselineKind`, `baselinePolicyVersion` (`fg8-baseline-1`), `comparisonBasis`, `inputEvidenceHash` (sha256 of the exact evidence used), `assumptions[]`, `numerator`, `denominator`, `units`, `confidence`, `createdAt`. A savings percentage (`derivedSavingsPercent`) is computed on demand and only when both numerator and denominator are defined, non-negative, and the denominator is positive — **it is never the only persisted fact.** No baseline present ⇒ no savings claim anywhere in the receipt.

No baseline ever makes a live paid or free-provider call to manufacture data — every comparison is computed from already-recorded, deterministic counters.

## 7. Energy / carbon estimation (`energy-estimator.ts`, `hardware-telemetry.ts`)

`EnergyEstimator` is an interface (`estimatorId`, `estimatorVersion`, `estimate(input)`), not a hard-coded constant. Shipped estimators:

- `InsufficientDataEstimator` (id `insufficient-data`) — the **production default**. Always reports `sourceType: "unavailable"`, `confidence: "INSUFFICIENT_DATA"`, and every numeric field `undefined`. This is the honest state for OpenRouter free models today: no accelerator identity or power-draw telemetry is exposed.
- `ReferenceHeuristicEstimator` (id `reference-heuristic`) — a deterministic, openly-labeled-as-non-authoritative fixture (fixed illustrative J/token and gCO2e/Wh constants documented inline) used only to prove the interface is pluggable and to give tests a known, reproducible result. Never wired as the production default.

`HardwareTelemetryAdapter` is an interface for future CPU/GPU/power telemetry (NVIDIA `nvidia-smi`, AMD ROCm-SMI, generic CPU accounting). This phase ships **only** the interface and `NullHardwareTelemetryAdapter` (always `INSUFFICIENT_DATA`) — no shell polling loop, no dependency on the current developer's hardware.

A receipt persists the estimator id/version/methodology/assumptions it was built with, so swapping the default estimator later never reinterprets an old receipt's numbers under a newer methodology.

## 8. Confidence & coverage classifications

`SustainabilityConfidence`: `DIRECT`, `PROVIDER_REPORTED`, `HIGH_CONFIDENCE_ESTIMATE`, `MODELED_ESTIMATE`, `INSUFFICIENT_DATA`.

`MetricCoverageClass` (§4) is distinct: it says *where* a value came from; confidence grades *how much to trust an estimate* once it is one. Energy/carbon fields carry their own `sourceType`/`confidence` and never inherit a token field's coverage class — an estimated field and a measured field can never be conflated (tested in `fg8-energy-estimator.test.ts`).

## 9. Privacy

FG-8 records counts, sizes, hashes, ids, timing, and classifications — never prompts, source file contents, tool `output`/`arguments`, or secrets. `normalizeMeasurementInput` only ever reads a small, explicitly named set of numeric/string fields off its "raw" inputs; anything else on those objects (including secret-shaped or prompt-shaped extra fields) is structurally invisible to it. Tested directly in `fg8-privacy.test.ts` by asserting injected secret/prompt strings never appear anywhere in a built receipt's JSON.

## 10. Financial safety / zero-cash

FG-8/FG-8R makes **no** live model calls, paid or free, to manufacture baseline or benchmark data (`packages/forge-green/src/sustainability-fixtures.ts` is entirely hand-built, deterministic, synthetic data; `scripts/forgegreen-fg8-benchmark.mjs` runs those fixtures — plus one FG-8R live-integration-shaped workload that only indexes a local temp directory with a real `RepositoryIntelligence` instance — through the receipt/baseline/summary pipeline with zero network I/O). `checkCrossReceiptIntegrity` (`sustainability-receipt.ts`) verifies a `SustainabilityReceipt`'s cross-references — against an explicit `RouteReceipt`/`FinancialReceipt` when supplied, or (the real live production path, see §13) against the live `FreeModelRecord`/`DecisionReceipt` evidence `AgentRuntime` actually has — but never independently recomputes or overrides that classification: a disagreement is surfaced as `measurementStatus: "incomplete"` with reason codes, never silently reconciled (`fg8-financial-safety.test.ts`, `fg8r-live-cross-receipt.test.ts`).

## 11. Durability & integrity

`SustainabilityReceiptStore` (`sustainability-persistence.ts`) persists through the existing `ISessionPersistence` abstraction — the same one `forgegreen_ledger` (FG-1E) and 8-Bit's `eight_bit_decision_receipt` already use — as the new `forgegreen_sustainability_receipt` `WorkItem` kind (`packages/sessions/src/session-state.ts`), append-only via `insertIfAbsent`. `finalizeSustainabilityReceipt` makes a receipt immutable; a second finalize call is rejected (`SustainabilityMeasurementError`). Impossible negative metrics and run/session identity mismatches are rejected at construction, never silently clamped or accepted. Restart/reload determinism (build → finalize → persist → simulate a fresh process against the same on-disk database → reload → regenerate the summary → assert semantic equality) is certified in `fg8-persistence.test.ts`.

## 12. Observability events

`forgegreen.run_started`, `model_usage_recorded`, `tool_usage_recorded`, `verification_usage_recorded`, `baseline_generated`, `energy_estimated`, `run_finalized`, `measurement_failed` (`packages/protocol/src/workspace-events.ts`, emitted via `packages/server/src/workspace-event-adapter.ts`). Aggregated once per run — never one event per token or tool call — counts/ids/classifications only.

## 13. Relationship to other authorities

- **ForgeAuto / 8-Bit** (`packages/eight-bit`): remains the sole routing/model-selection/failover authority. **FG-8R correction**: `RouteReceipt`/`FinancialReceipt` (`packages/eight-bit/src/receipts.ts`) are unused in production — `createRouteReceipt`/`createFinancialReceipt` are called nowhere outside their own definition file, confirmed by repository-wide search. The real live authority is a `FreeModelRecord` (read via `firewall.getModel(provider, model)` for the model `AgentUsage` shows actually executed) plus any persisted `DecisionReceipt`s for the run (`EightBitDecisionStore.listReceipts`, commonly empty — written only on a rotation/failover). FG-8 reads these — never influences a routing decision, and makes no change to 8-Bit's ranking or eligibility logic.
- **ForgeVerify** (`packages/workflow/src/forge-verify.ts`, FG-5/FG-6/FG-7 in `packages/forge-green`): remains the sole verification execution/sufficiency authority. FG-8 reads already-aggregated verification counters from the FG-1E ledger; it never reinterprets whether verification passed.
- **`FreeModelRecord` / `DecisionReceipt`** (`packages/forge-zero`, `packages/eight-bit/src/types.ts`): the real live financial/routing authorities (see above). FG-8 references and cross-checks them (§8/§10) only, never overrides them. `FinancialReceipt`/`RouteReceipt` remain supported for forward compatibility should 8-Bit ever construct them live.
- **Completion Gate** (`packages/workflow/src/completion-gate.ts`): unaffected. No FG-8 field is ever read by `evaluateCompletion`.

## 14. Limitations (honest, not hidden)

- Energy/carbon remain `INSUFFICIENT_DATA` in live production use today: no provider in the verified-free catalog exposes accelerator identity or power-draw telemetry, and no hardware adapter beyond the null adapter is implemented in this phase.
- Live Baseline B bytes are `undefined` for any workspace larger than the bounded `listFiles` cap (default 5000 files) — by design, to avoid computing an undercounted "naive full-context" figure from a partial page. File/page counts (eligible/excluded) are still reported in that case.
- `context_waste` is never emitted — no conservative, defensible per-run heuristic for "context sent but not required" exists yet.
- Live financial classification is `unavailable` for a run that completes with zero successful model calls (`AgentUsage.provider`/`.model` stay unset, so there is nothing to look up) — inherent to a run with no completed request, not a defect.
- **Closed in FG-8R** (previously listed here as open gaps): `RouteReceipt`/`FinancialReceipt`-shaped cross-reference wiring is now live via the real `FreeModelRecord`/`DecisionReceipt` authority (§13), and Baseline B's `ContextComparisonPopulation` is now computed automatically in live runs via `computeLiveContextPopulation` (`live-context-adapter.ts`). See `docs/codeforge-forgegreen-phase3-certification-report.md` for the closure evidence.
