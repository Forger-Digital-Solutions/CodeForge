import crypto from "node:crypto";
import { generateAllBaselines } from "./baseline.js";
import { createDefaultEnergyEstimator, type EnergyEstimator } from "./energy-estimator.js";
import type { HardwareTelemetrySample } from "./hardware-telemetry.js";
import {
  normalizeMeasurementInput,
  type RawDecisionReceiptLike,
  type RawFinancialReceiptRefLike,
  type RawFreeModelRecordLike,
  type RawRouteReceiptRefLike,
} from "./measurement-normalization.js";
import { classifyWaste } from "./waste-taxonomy.js";
import {
  SUSTAINABILITY_RECEIPT_SCHEMA_VERSION,
  SustainabilityMeasurementError,
  type ContextComparisonPopulation,
  type CrossReceiptIntegrityCheck,
  type MeasurementCoverageMap,
  type NormalizedIdentity,
  type NormalizedMeasurementInput,
  type SustainabilityReceipt,
} from "./sustainability-types.js";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

/** Integrity requirement (spec §14/§15 #15): impossible negative usage must fail validation, not
 * be silently clamped. Walks every numeric leaf in the normalized accounting sections. */
function collectNegativeMetricViolations(input: NormalizedMeasurementInput): string[] {
  const violations: string[] = [];
  const check = (label: string, value: number | undefined): void => {
    if (typeof value === "number" && value < 0) violations.push(`NEGATIVE_METRIC:${label}`);
  };
  check("tokens.inputTokens", input.tokens.inputTokens);
  check("tokens.outputTokens", input.tokens.outputTokens);
  check("tokens.cachedInputTokens", input.tokens.cachedInputTokens);
  check("tokens.cacheWriteTokens", input.tokens.cacheWriteTokens);
  check("tokens.reasoningTokens", input.tokens.reasoningTokens);
  check("tokens.requestCount", input.tokens.requestCount);
  check("tools.toolCallCount", input.tools.toolCallCount);
  check("tools.toolFailureCount", input.tools.toolFailureCount);
  check("tools.duplicateActionsSuppressed", input.tools.duplicateActionsSuppressed);
  check("tools.noProgressInterruptions", input.tools.noProgressInterruptions);
  check("tools.toolWallClockMs", input.tools.toolWallClockMs);
  check("verification.obligationsGenerated", input.verification.obligationsGenerated);
  check("verification.targetedSuitesUsed", input.verification.targetedSuitesUsed);
  check("verification.fullSuitesAvoided", input.verification.fullSuitesAvoided);
  check("verification.fullSuitesRequired", input.verification.fullSuitesRequired);
  check("verification.evidenceReused", input.verification.evidenceReused);
  check("verification.rerunsAvoided", input.verification.rerunsAvoided);
  check("verification.staleEvidenceRejected", input.verification.staleEvidenceRejected);
  check("verification.blockedEvents", input.verification.blockedEvents);
  check("routing.modelFailoverRotations", input.routing.modelFailoverRotations);
  check("routing.modelFailoverBlockedDispatches", input.routing.modelFailoverBlockedDispatches);
  check("routing.fallbackEvents", input.routing.fallbackEvents);
  check("context.contextPagesReused", input.context.contextPagesReused);
  check("context.contextPagesPulled", input.context.contextPagesPulled);
  check("context.tokensAvoidedMeasured", input.context.tokensAvoidedMeasured);
  check("context.bytesAvoidedMeasured", input.context.bytesAvoidedMeasured);
  check("timing.wallClockMs", input.timing.wallClockMs);
  return violations;
}

/**
 * Cross-receipt integrity (hardening #6). FG-8 never independently reclassifies a route/model or
 * a financial free/paid decision — it only checks that what it was told is internally consistent
 * and surfaces a mismatch as an integrity failure, never a silent reconciliation.
 */
export interface LiveCrossReceiptEvidence {
  /** The `FreeModelRecord` ForgeZero/the firewall verified for the model that actually executed
   * this run's requests (read via `firewall.getModel(usage.provider, usage.model)`). */
  freeModelRecord?: RawFreeModelRecordLike;
  /** Any persisted 8-Bit `DecisionReceipt`s for this run (from `EightBitDecisionStore.listReceipts`,
   * filtered to this runId by the caller). Commonly empty — a `DecisionReceipt` is written only on
   * a rotation/failover event, not on every run. */
  decisionReceipts?: RawDecisionReceiptLike[];
}

export function checkCrossReceiptIntegrity(
  identity: NormalizedIdentity,
  routeReceipt: RawRouteReceiptRefLike | undefined,
  financialReceipt: RawFinancialReceiptRefLike | undefined,
  live?: LiveCrossReceiptEvidence,
): CrossReceiptIntegrityCheck {
  const mismatches: string[] = [];
  const decisionReceipts = live?.decisionReceipts ?? [];
  const checked = routeReceipt !== undefined || financialReceipt !== undefined || live?.freeModelRecord !== undefined || decisionReceipts.length > 0;

  if (routeReceipt?.taskId !== undefined && identity.taskId !== undefined && routeReceipt.taskId !== identity.taskId) {
    mismatches.push("ROUTE_RECEIPT_TASK_ID_MISMATCH");
  }
  if (financialReceipt?.taskId !== undefined && identity.taskId !== undefined && financialReceipt.taskId !== identity.taskId) {
    mismatches.push("FINANCIAL_RECEIPT_TASK_ID_MISMATCH");
  }
  const routeModel = routeReceipt?.selectedRoute;
  if (
    routeModel &&
    typeof routeModel.providerId === "string" &&
    typeof financialReceipt?.providerId === "string" &&
    routeModel.providerId !== financialReceipt.providerId
  ) {
    mismatches.push("ROUTE_FINANCIAL_PROVIDER_MISMATCH");
  }
  if (
    routeModel &&
    typeof routeModel.modelId === "string" &&
    typeof financialReceipt?.modelId === "string" &&
    routeModel.modelId !== financialReceipt.modelId
  ) {
    mismatches.push("ROUTE_FINANCIAL_MODEL_MISMATCH");
  }

  const freeModelRecord = live?.freeModelRecord;
  const liveProviderId = typeof freeModelRecord?.providerId === "string" ? freeModelRecord.providerId : undefined;
  const liveModelId = typeof freeModelRecord?.modelId === "string" ? freeModelRecord.modelId : undefined;
  const liveAccessClass = typeof freeModelRecord?.accessClass === "string" ? freeModelRecord.accessClass : undefined;

  // Cross-check against only the MOST RECENT decision receipt for this run (store order is
  // createdAt-ascending — see EightBitDecisionStore.listReceipts): an earlier receipt from before
  // a later, untracked rotation is not a genuine disagreement, so comparing against anything but
  // the latest would produce false positives.
  const latestDecision = decisionReceipts[decisionReceipts.length - 1];
  const latestSelected = latestDecision?.selected;
  if (
    liveProviderId !== undefined &&
    latestSelected &&
    typeof latestSelected.providerId === "string" &&
    latestSelected.providerId !== liveProviderId
  ) {
    mismatches.push("LIVE_DECISION_RECEIPT_PROVIDER_MISMATCH");
  }
  if (
    liveModelId !== undefined &&
    latestSelected &&
    typeof latestSelected.modelId === "string" &&
    latestSelected.modelId !== liveModelId
  ) {
    mismatches.push("LIVE_DECISION_RECEIPT_MODEL_MISMATCH");
  }

  let financialClassification: "free" | "paid" | "unknown" = "unknown";
  let financialClassificationSource: CrossReceiptIntegrityCheck["financialClassificationSource"] = "unavailable";
  const receiptIsFree = financialReceipt?.pricingEvidence?.isFree;
  const liveIsFree = freeModelRecord?.costProfile && typeof freeModelRecord.costProfile === "object" ? freeModelRecord.costProfile.isFree : undefined;
  if (typeof receiptIsFree === "boolean") {
    financialClassification = receiptIsFree ? "free" : "paid";
    financialClassificationSource = "financial_receipt";
  } else if (typeof liveIsFree === "boolean") {
    financialClassification = liveIsFree ? "free" : "paid";
    financialClassificationSource = "live_free_model_record";
  }

  return {
    checked,
    consistent: mismatches.length === 0,
    mismatches,
    routeReceiptId: typeof routeReceipt?.receiptId === "string" ? routeReceipt.receiptId : undefined,
    financialReceiptId: typeof financialReceipt?.receiptId === "string" ? financialReceipt.receiptId : undefined,
    financialClassification,
    financialClassificationSource,
    liveModelProviderId: liveProviderId,
    liveModelModelId: liveModelId,
    liveModelAccessClass: liveAccessClass,
    decisionReceiptIds: decisionReceipts.map((d) => d.receiptId).filter((id): id is string => typeof id === "string"),
  };
}

function computeMeasurementCoverage(
  input: NormalizedMeasurementInput,
  crossReceiptIntegrity: CrossReceiptIntegrityCheck,
  energyCoverage: "estimated" | "unavailable",
  carbonCoverage: "estimated" | "unavailable",
): MeasurementCoverageMap {
  return {
    tokens: input.tokens.coverage,
    requests: input.tokens.requestCount !== undefined ? input.tokens.coverage : "unavailable",
    tools: input.tools.coverage,
    timing: input.timing.coverage,
    contextBehavior: input.context.coverage,
    retriesFallbacks: input.routing.coverage,
    verificationActivity: input.verification.coverage,
    financialSpend: crossReceiptIntegrity.financialClassificationSource !== "unavailable" ? "derived_from_authoritative_telemetry" : "unavailable",
    energy: energyCoverage,
    carbon: carbonCoverage,
  };
}

export interface CreateSustainabilityReceiptParams {
  identity: NormalizedIdentity;
  normalized: NormalizedMeasurementInput;
  routeReceipt?: RawRouteReceiptRefLike;
  financialReceipt?: RawFinancialReceiptRefLike;
  /** FG-8R: the real live routing/financial authority — see `LiveCrossReceiptEvidence`. */
  live?: LiveCrossReceiptEvidence;
  contextPopulation?: ContextComparisonPopulation;
  energyEstimator?: EnergyEstimator;
  hardware?: HardwareTelemetrySample;
  taskId?: string;
  workflowId?: string;
  workspaceIdentityHash?: string;
}

/**
 * Builds a draft (not yet finalized) `SustainabilityReceipt`. Throws `SustainabilityMeasurementError`
 * only for genuinely impossible input (negative metrics, run/session identity mismatch between the
 * caller's identity and the normalized input it built) — never for merely missing/unknown data,
 * which is represented as `undefined`/`"unavailable"` instead. Callers that catch this error
 * should persist a `createFailedSustainabilityReceipt` record rather than dropping the failure
 * silently (hardening #4) and must never let it fail the underlying agent run.
 */
export function createSustainabilityReceipt(params: CreateSustainabilityReceiptParams): SustainabilityReceipt {
  const { identity, normalized } = params;

  if (normalized.identity.runId !== identity.runId) {
    throw new SustainabilityMeasurementError(
      `Normalized input runId "${normalized.identity.runId}" does not match receipt identity runId "${identity.runId}"`,
      ["RUN_ID_MISMATCH"],
    );
  }
  if (normalized.identity.sessionId !== identity.sessionId) {
    throw new SustainabilityMeasurementError(
      `Normalized input sessionId "${String(normalized.identity.sessionId)}" does not match receipt identity sessionId "${String(identity.sessionId)}"`,
      ["SESSION_ID_MISMATCH"],
    );
  }
  const negativeViolations = collectNegativeMetricViolations(normalized);
  if (negativeViolations.length > 0) {
    throw new SustainabilityMeasurementError("Impossible negative usage in normalized measurement input", negativeViolations);
  }

  const crossReceiptIntegrity = checkCrossReceiptIntegrity(identity, params.routeReceipt, params.financialReceipt, params.live);
  const wasteBreakdown = classifyWaste(normalized);
  const baselines = generateAllBaselines(normalized, params.contextPopulation);
  const estimator = params.energyEstimator ?? createDefaultEnergyEstimator();
  const { energy, carbon } = estimator.estimate({ tokens: normalized.tokens, timing: normalized.timing, hardware: params.hardware });
  const measurementCoverage = computeMeasurementCoverage(normalized, crossReceiptIntegrity, energy.sourceType === "estimated" ? "estimated" : "unavailable", carbon.sourceType === "estimated" ? "estimated" : "unavailable");

  const reasonCodes = [...crossReceiptIntegrity.mismatches];
  const measurementStatus = crossReceiptIntegrity.consistent ? "complete" : "incomplete";

  // Content-addressed (hardening §12): the receiptId hashes the actual measured content, not
  // just identity — an exact retry of the SAME measurement always yields the SAME id (so
  // `insertIfAbsent` makes it a true no-op), while a retry that legitimately observed MORE or
  // DIFFERENT work yields a genuinely different id (so it is never silently merged/dropped).
  // `createdAt` fields (baselines, the receipt itself) are excluded — those are call-time
  // metadata, not measured content, and would otherwise make even an exact retry hash different.
  const identityFingerprint = hash({
    identity,
    normalizedVersion: normalized.normalizationVersion,
    sourceLedgerId: normalized.sourceLedgerId,
    tokens: normalized.tokens,
    tools: normalized.tools,
    verification: normalized.verification,
    routing: normalized.routing,
    context: normalized.context,
    timing: normalized.timing,
    crossReceiptIntegrity,
    wasteBreakdown,
    baselines: baselines.map(({ createdAt: _createdAt, ...rest }) => rest),
    energy,
    carbon,
    createdMarker: "fg8",
  });

  return {
    receiptSchemaVersion: SUSTAINABILITY_RECEIPT_SCHEMA_VERSION,
    normalizationVersion: normalized.normalizationVersion,
    receiptId: `fg8-${identityFingerprint}`,
    runId: identity.runId,
    sessionId: identity.sessionId,
    taskId: params.taskId ?? identity.taskId,
    workflowId: params.workflowId ?? identity.workflowId,
    workspaceIdentityHash: params.workspaceIdentityHash,
    createdAt: new Date().toISOString(),
    measurementStatus,
    measurementFailureReasonCodes: reasonCodes,
    identity,
    tokenAccounting: normalized.tokens,
    toolAccounting: normalized.tools,
    verificationAccounting: normalized.verification,
    routingAccounting: normalized.routing,
    contextAccounting: normalized.context,
    timing: normalized.timing,
    crossReceiptIntegrity,
    wasteBreakdown,
    baselines,
    energyEstimate: energy,
    carbonEstimate: carbon,
    measurementCoverage,
    finalized: false,
    finalizedAt: undefined,
  };
}

/** Builds a durable, schema-valid record of a FAILED measurement attempt — never a zero-value
 * "successful" receipt (hardening #4). All accounting sections report `"unavailable"` coverage
 * and `undefined` numbers; the failure is explicit, not erased. */
export function createFailedSustainabilityReceipt(identity: NormalizedIdentity, reasonCodes: string[]): SustainabilityReceipt {
  const normalized = normalizeMeasurementInput({ identity });
  const estimator = createDefaultEnergyEstimator();
  const { energy, carbon } = estimator.estimate({ tokens: normalized.tokens, timing: normalized.timing, hardware: undefined });
  const crossReceiptIntegrity: CrossReceiptIntegrityCheck = {
    checked: false,
    consistent: true,
    mismatches: [],
    routeReceiptId: undefined,
    financialReceiptId: undefined,
    financialClassification: "unknown",
    financialClassificationSource: "unavailable",
    liveModelProviderId: undefined,
    liveModelModelId: undefined,
    liveModelAccessClass: undefined,
    decisionReceiptIds: [],
  };
  return {
    receiptSchemaVersion: SUSTAINABILITY_RECEIPT_SCHEMA_VERSION,
    normalizationVersion: normalized.normalizationVersion,
    receiptId: `fg8-failed-${hash({ identity, reasonCodes, ts: Date.now() })}`,
    runId: identity.runId,
    sessionId: identity.sessionId,
    taskId: identity.taskId,
    workflowId: identity.workflowId,
    workspaceIdentityHash: undefined,
    createdAt: new Date().toISOString(),
    measurementStatus: "failed",
    measurementFailureReasonCodes: reasonCodes.length > 0 ? reasonCodes : ["UNKNOWN_MEASUREMENT_FAILURE"],
    identity,
    tokenAccounting: normalized.tokens,
    toolAccounting: normalized.tools,
    verificationAccounting: normalized.verification,
    routingAccounting: normalized.routing,
    contextAccounting: normalized.context,
    timing: normalized.timing,
    crossReceiptIntegrity,
    wasteBreakdown: [],
    baselines: [],
    energyEstimate: energy,
    carbonEstimate: carbon,
    measurementCoverage: computeMeasurementCoverage(normalized, crossReceiptIntegrity, "unavailable", "unavailable"),
    finalized: false,
    finalizedAt: undefined,
  };
}

/** Marks a receipt immutable. A second finalize call on an already-finalized receipt is rejected
 * (spec §14/§15 #14) rather than silently succeeding again. */
export function finalizeSustainabilityReceipt(receipt: SustainabilityReceipt): SustainabilityReceipt {
  if (receipt.finalized) {
    throw new SustainabilityMeasurementError(`Receipt ${receipt.receiptId} is already finalized`, ["ALREADY_FINALIZED"]);
  }
  return { ...receipt, finalized: true, finalizedAt: new Date().toISOString() };
}
