/**
 * FG-8: sustainability & resource-measurement types.
 *
 * FG-8 is observational only, exactly like FG-1E's ledger and FG-7's coverage authority: it
 * never returns a permission, approval, verification, routing, or completion decision, and it
 * never overrides `RouteReceipt`/`FinancialReceipt` classification.
 *
 * Two provenance boundaries run through every type here:
 *  - `MetricCoverageClass` says WHERE a metric's value came from (measured/provider/derived/
 *    replayed/simulated/estimated/unavailable).
 *  - `SustainabilityConfidence` grades a numeric estimate's trustworthiness once it is `estimated`.
 * Unknown or failed measurement is represented as `undefined`/`"unavailable"` — never as `0`.
 */

/** Bump when `NormalizedMeasurementInput`'s shape changes. A receipt persists the version it was
 * built with, so historical receipts stay interpretable even if upstream types (`AgentUsage`,
 * `ToolExecutionRecord`, `ForgeGreenLedgerTotals`, `RouteReceipt`, `FinancialReceipt`) evolve. */
export const MEASUREMENT_NORMALIZATION_SCHEMA_VERSION = "fg8-normalization-1";

/** Bump when `SustainabilityReceipt`'s shape changes. */
export const SUSTAINABILITY_RECEIPT_SCHEMA_VERSION = "fg8-receipt-1";

export type SustainabilityConfidence =
  | "DIRECT"
  | "PROVIDER_REPORTED"
  | "HIGH_CONFIDENCE_ESTIMATE"
  | "MODELED_ESTIMATE"
  | "INSUFFICIENT_DATA";

/** Provenance classification for the certification coverage map and per-receipt accounting
 * sections. Distinct from `SustainabilityConfidence`: this classifies WHERE a value came from,
 * confidence grades HOW MUCH to trust an estimate once it is `estimated`. */
export type MetricCoverageClass =
  | "directly_measured"
  | "provider_reported"
  | "derived_from_authoritative_telemetry"
  | "replayed"
  | "simulated"
  | "estimated"
  | "unavailable";

export type MeasurementStatus = "complete" | "incomplete" | "failed";

export type WasteCategory =
  | "useful_work"
  | "retry_overhead"
  | "routing_overhead"
  | "failed_attempt_waste"
  | "duplicate_work"
  | "context_waste"
  | "verification_overhead"
  | "prevented_waste";

export type BaselineKind =
  | "A_FIXED_MODEL_NO_SMART_ROUTING"
  | "B_NAIVE_FULL_CONTEXT"
  | "C_NAIVE_SEQUENTIAL_RETRY"
  | "D_VERIFICATION_OVERHEAD_COMPARISON";

export type ComparisonBasis = "measured" | "replayed" | "simulated" | "estimated";

// ---------------------------------------------------------------------------
// Normalization boundary (hardening #1)
// ---------------------------------------------------------------------------

export interface NormalizedIdentity {
  runId: string;
  sessionId?: string;
  agentId?: string;
  turnId?: string;
  taskId?: string;
  workflowId?: string;
  workstreamScope?: string;
  executionRevision?: string;
  namespace: string;
}

export interface NormalizedTokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  reasoningTokens: number | undefined;
  totalTokens: number | undefined;
  requestCount: number | undefined;
  provider: string | undefined;
  model: string | undefined;
  coverage: MetricCoverageClass;
}

export interface NormalizedToolUsage {
  toolCallCount: number | undefined;
  toolFailureCount: number | undefined;
  readOnlyToolCallCount: number | undefined;
  mutatingToolCallCount: number | undefined;
  duplicateActionsSuppressed: number | undefined;
  noProgressInterruptions: number | undefined;
  toolWallClockMs: number | undefined;
  coverage: MetricCoverageClass;
}

export interface NormalizedVerificationUsage {
  obligationsGenerated: number | undefined;
  targetedSuitesUsed: number | undefined;
  fullSuitesAvoided: number | undefined;
  fullSuitesRequired: number | undefined;
  evidenceReused: number | undefined;
  rerunsAvoided: number | undefined;
  staleEvidenceRejected: number | undefined;
  blockedEvents: number | undefined;
  coverage: MetricCoverageClass;
}

export interface NormalizedRoutingUsage {
  modelFailoverRotations: number | undefined;
  modelFailoverBlockedDispatches: number | undefined;
  fallbackEvents: number | undefined;
  routeReceiptId: string | undefined;
  financialReceiptId: string | undefined;
  coverage: MetricCoverageClass;
}

export interface NormalizedContextUsage {
  contextPagesReused: number | undefined;
  contextPagesPulled: number | undefined;
  tokensAvoidedMeasured: number | undefined;
  bytesAvoidedMeasured: number | undefined;
  coverage: MetricCoverageClass;
}

export interface NormalizedTiming {
  wallClockMs: number | undefined;
  coverage: MetricCoverageClass;
}

/** FG-8-owned, versioned measurement input. `createSustainabilityReceipt` consumes ONLY this
 * shape — never `AgentUsage`/`ToolExecutionRecord`/`ForgeGreenLedgerTotals`/`RouteReceipt`/
 * `FinancialReceipt` directly — so a receipt's meaning never silently drifts when those upstream
 * types change. Build one with `normalizeMeasurementInput()`. */
export interface NormalizedMeasurementInput {
  normalizationVersion: string;
  identity: NormalizedIdentity;
  tokens: NormalizedTokenUsage;
  tools: NormalizedToolUsage;
  verification: NormalizedVerificationUsage;
  routing: NormalizedRoutingUsage;
  context: NormalizedContextUsage;
  timing: NormalizedTiming;
  sourceLedgerId: string | undefined;
  sourceLedgerPolicyVersion: string | undefined;
}

// ---------------------------------------------------------------------------
// Baseline / counterfactual provenance (hardening #2, #3)
// ---------------------------------------------------------------------------

export interface BaselineProvenance {
  baselineKind: BaselineKind;
  baselinePolicyVersion: string;
  comparisonBasis: ComparisonBasis;
  /** Hash of the evidence the comparison was computed from — lets a later audit reconstruct
   * exactly which input state produced this claim. */
  inputEvidenceHash: string;
  assumptions: string[];
  numerator: number | undefined;
  denominator: number | undefined;
  units: string;
  confidence: SustainabilityConfidence;
  createdAt: string;
  executionRevision: string | undefined;
}

/** Baseline B hardening: "full context" must state exactly what it means for THIS receipt —
 * repository size is never equated with eligible model context. */
export interface ContextComparisonPopulation {
  fullContextDefinition: string;
  eligibleFileCount: number;
  excludedFileCount: number;
  /** e.g. { binary: 3, generated: 1, gitignored: 2 } */
  exclusionReasons: Record<string, number>;
  eligibleBytes: number | undefined;
  eligibleTokensEstimate: number | undefined;
  actualTransmittedBytes: number | undefined;
  actualTransmittedTokens: number | undefined;
  naivePolicyBytes: number | undefined;
  naivePolicyTokens: number | undefined;
}

export interface BaselineComparison extends BaselineProvenance {
  description: string;
  /** Present only for `B_NAIVE_FULL_CONTEXT`. */
  contextPopulation?: ContextComparisonPopulation;
}

/** A savings percentage is derived on demand, never stored as the only fact — and only valid
 * when both numerator and denominator are defensible and the denominator is non-zero. */
export function derivedSavingsPercent(comparison: BaselineProvenance): number | undefined {
  const { numerator, denominator } = comparison;
  if (typeof numerator !== "number" || typeof denominator !== "number") return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
  if (numerator < 0 || denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 10000) / 100;
}

// ---------------------------------------------------------------------------
// Energy / carbon estimation (pluggable, versioned)
// ---------------------------------------------------------------------------

export interface EnergyEstimateProvenance {
  estimatorId: string;
  estimatorVersion: string;
  methodology: string;
  assumptions: string[];
  hardwareClass: string | undefined;
  region: string | undefined;
  confidence: SustainabilityConfidence;
  sourceType: "measured" | "provider_reported" | "estimated" | "unavailable";
}

export interface EnergyEstimate extends EnergyEstimateProvenance {
  joules: number | undefined;
  wattHours: number | undefined;
  kilowattHours: number | undefined;
}

export interface CarbonEstimate extends EnergyEstimateProvenance {
  gramsCO2e: number | undefined;
}

// ---------------------------------------------------------------------------
// Waste taxonomy
// ---------------------------------------------------------------------------

export interface WasteBreakdownEntry {
  category: WasteCategory;
  quantity: number;
  unit: "count" | "tokens" | "bytes" | "ms";
  coverage: MetricCoverageClass;
  reasonCodes: string[];
  /** True only for `prevented_waste` — such an entry MUST carry `baselineRef`. */
  requiresBaseline: boolean;
  baselineRef: BaselineKind | undefined;
}

// ---------------------------------------------------------------------------
// Cross-receipt integrity (hardening #6, FG-8R live wiring)
// ---------------------------------------------------------------------------

/** FG-8R: where a receipt's financial (free/paid) classification actually came from. The rich
 * `RouteReceipt`/`FinancialReceipt` schema (`packages/eight-bit/src/receipts.ts`) is currently
 * unused dead code in production (confirmed: `createRouteReceipt`/`createFinancialReceipt` are
 * called nowhere outside their own definition file) — the REAL live authority is the
 * `FreeModelRecord` ForgeZero/the firewall already verified for the model that actually executed
 * (`costProfile.isFree`), optionally cross-checked against any persisted 8-Bit `DecisionReceipt`s
 * for this run. `financial_receipt`/`route_receipt` remain supported for forward compatibility
 * (fully tested) but are not the live production path today. */
export type LiveFinancialClassificationSource =
  | "financial_receipt"
  | "live_free_model_record"
  | "unavailable";

export interface CrossReceiptIntegrityCheck {
  checked: boolean;
  consistent: boolean;
  mismatches: string[];
  routeReceiptId: string | undefined;
  financialReceiptId: string | undefined;
  financialClassification: "free" | "paid" | "unknown";
  /** FG-8R: provenance of `financialClassification` above. */
  financialClassificationSource: LiveFinancialClassificationSource;
  /** FG-8R: the live provider/model the firewall/ForgeZero actually verified for this run's
   * executed requests (from `AgentUsage.provider`/`.model`), when known. */
  liveModelProviderId: string | undefined;
  liveModelModelId: string | undefined;
  liveModelAccessClass: string | undefined;
  /** FG-8R: ids of any persisted 8-Bit `DecisionReceipt`s cross-checked against this run. Empty
   * when none exist for this run — this is common and expected: `DecisionReceipt`s are only
   * written on a rotation/failover event, not on every run. */
  decisionReceiptIds: string[];
}

// ---------------------------------------------------------------------------
// Coverage map (hardening #7)
// ---------------------------------------------------------------------------

export type MeasurementCoverageMetric =
  | "tokens"
  | "requests"
  | "tools"
  | "timing"
  | "contextBehavior"
  | "retriesFallbacks"
  | "verificationActivity"
  | "financialSpend"
  | "energy"
  | "carbon";

export type MeasurementCoverageMap = Record<MeasurementCoverageMetric, MetricCoverageClass>;

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

export interface SustainabilityReceipt {
  receiptSchemaVersion: string;
  normalizationVersion: string;
  receiptId: string;
  runId: string;
  sessionId: string | undefined;
  taskId: string | undefined;
  workflowId: string | undefined;
  workspaceIdentityHash: string | undefined;
  createdAt: string;

  measurementStatus: MeasurementStatus;
  /** Never empty when `measurementStatus !== "complete"`. */
  measurementFailureReasonCodes: string[];

  identity: NormalizedIdentity;
  tokenAccounting: NormalizedTokenUsage;
  toolAccounting: NormalizedToolUsage;
  verificationAccounting: NormalizedVerificationUsage;
  routingAccounting: NormalizedRoutingUsage;
  contextAccounting: NormalizedContextUsage;
  timing: NormalizedTiming;

  crossReceiptIntegrity: CrossReceiptIntegrityCheck;

  wasteBreakdown: WasteBreakdownEntry[];
  baselines: BaselineComparison[];

  energyEstimate: EnergyEstimate;
  carbonEstimate: CarbonEstimate;

  measurementCoverage: MeasurementCoverageMap;

  finalized: boolean;
  finalizedAt: string | undefined;
}

export class SustainabilityMeasurementError extends Error {
  readonly reasonCodes: string[];
  constructor(message: string, reasonCodes: string[]) {
    super(message);
    this.name = "SustainabilityMeasurementError";
    this.reasonCodes = reasonCodes;
  }
}
