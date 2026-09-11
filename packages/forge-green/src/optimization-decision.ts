import crypto from "node:crypto";
import { resolveOptimizationMode } from "./optimization-policy.js";
import {
  FORGE_GREEN_OPTIMIZATION_POLICY_VERSION,
  OptimizationDecisionError,
  type ForgeGreenOptimizationDecision,
  type ForgeGreenOptimizationReceipt,
  type OptimizationDecisionStatus,
  type OptimizationExpectedEffect,
  type OptimizationKind,
  type OptimizationResourceDelta,
  type OptimizationSafetyGuards,
} from "./optimization-types.js";
import type { SustainabilityConfidence } from "./sustainability-types.js";

const DECISION_SCHEMA_VERSION = "fg9-decision-1";
const RECEIPT_SCHEMA_VERSION = "fg9-optimization-receipt-1";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

function assertNonNegative(effect: OptimizationExpectedEffect): void {
  const violations: string[] = [];
  const check = (label: string, value: number | undefined): void => {
    if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) violations.push(`NEGATIVE_METRIC:${label}`);
  };
  check("avoidedRequests", effect.avoidedRequests);
  check("avoidedTokens", effect.avoidedTokens);
  check("avoidedBytes", effect.avoidedBytes);
  check("avoidedToolExecutions", effect.avoidedToolExecutions);
  check("avoidedVerificationReruns", effect.avoidedVerificationReruns);
  check("timeReductionMs", effect.timeReductionMs);
  if (violations.length > 0) {
    throw new OptimizationDecisionError("Impossible negative expected-effect value", violations);
  }
}

export interface CreateOptimizationDecisionParams {
  runId: string;
  sessionId: string | undefined;
  kind: OptimizationKind;
  targetResource: string;
  sourceEvidenceIds: string[];
  sustainabilityReceiptId: string | undefined;
  expectedEffect: OptimizationExpectedEffect;
  confidence: SustainabilityConfidence;
  safetyGuards: OptimizationSafetyGuards;
  /** Explicit status override. If omitted: `ACTIVE_SAFE` mode + non-empty evidence -> `APPLIED`;
   * `SHADOW` mode -> `PROPOSED`; `OFF` mode or empty evidence -> `SKIPPED_INSUFFICIENT_EVIDENCE`. */
  status?: OptimizationDecisionStatus;
  statusReasonCodes?: string[];
}

/**
 * Builds a draft (not finalized) `ForgeGreenOptimizationDecision`. A `SHADOW`-mode decision can
 * never carry status `APPLIED` — this is enforced here, not left to the caller's discipline.
 */
export function createOptimizationDecision(params: CreateOptimizationDecisionParams): ForgeGreenOptimizationDecision {
  assertNonNegative(params.expectedEffect);
  const mode = resolveOptimizationMode(params.kind);

  let status = params.status;
  if (status === undefined) {
    if (mode === "OFF" || params.sourceEvidenceIds.length === 0) status = "SKIPPED_INSUFFICIENT_EVIDENCE";
    else if (mode === "ACTIVE_SAFE") status = "APPLIED";
    else status = "PROPOSED";
  }
  if (mode !== "ACTIVE_SAFE" && status === "APPLIED") {
    throw new OptimizationDecisionError(
      `Decision kind "${params.kind}" cannot carry status APPLIED while its resolved policy mode is "${mode}"`,
      ["MODE_STATUS_MISMATCH"],
    );
  }

  const decisionId = `fg9-${hash({
    runId: params.runId,
    sessionId: params.sessionId,
    kind: params.kind,
    targetResource: params.targetResource,
    sourceEvidenceIds: [...params.sourceEvidenceIds].sort(),
    expectedEffect: params.expectedEffect,
    status,
    marker: "fg9-decision",
  })}`;

  return {
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    decisionId,
    runId: params.runId,
    sessionId: params.sessionId,
    policyVersion: FORGE_GREEN_OPTIMIZATION_POLICY_VERSION,
    mode,
    kind: params.kind,
    createdAt: new Date().toISOString(),
    targetResource: params.targetResource,
    sourceEvidenceIds: params.sourceEvidenceIds,
    sustainabilityReceiptId: params.sustainabilityReceiptId,
    expectedEffect: params.expectedEffect,
    confidence: params.confidence,
    safetyGuards: params.safetyGuards,
    status,
    statusReasonCodes: params.statusReasonCodes ?? [],
    finalized: false,
    finalizedAt: undefined,
  };
}

export function finalizeOptimizationDecision(decision: ForgeGreenOptimizationDecision): ForgeGreenOptimizationDecision {
  if (decision.finalized) {
    throw new OptimizationDecisionError(`Decision ${decision.decisionId} is already finalized`, ["ALREADY_FINALIZED"]);
  }
  return { ...decision, finalized: true, finalizedAt: new Date().toISOString() };
}

export interface CreateOptimizationReceiptParams {
  decision: ForgeGreenOptimizationDecision;
  beforeSustainabilityReceiptId: string | undefined;
  afterSustainabilityReceiptId: string | undefined;
  resourceDelta: OptimizationResourceDelta;
  verificationEvidenceRef?: string;
  qualityResult: ForgeGreenOptimizationReceipt["qualityResult"];
  survivedValidation: boolean;
  rollbackStatus?: ForgeGreenOptimizationReceipt["rollbackStatus"];
}

/** A receipt may only claim `basis: "measured"` when BOTH before and after are real
 * measurements; a `PROPOSED`/shadow decision can never produce a `measured` receipt. */
export function createOptimizationReceipt(params: CreateOptimizationReceiptParams): ForgeGreenOptimizationReceipt {
  const { decision, resourceDelta } = params;
  if (resourceDelta.basis === "measured" && (params.beforeSustainabilityReceiptId === undefined || params.afterSustainabilityReceiptId === undefined)) {
    throw new OptimizationDecisionError(
      "A 'measured' resource delta requires both a before and an after SustainabilityReceipt reference",
      ["MEASURED_BASIS_MISSING_RECEIPTS"],
    );
  }
  if (decision.status !== "APPLIED" && params.survivedValidation) {
    throw new OptimizationDecisionError(
      `A receipt cannot claim survivedValidation for a decision whose status is "${decision.status}" (only APPLIED decisions produce a validated outcome)`,
      ["SURVIVED_VALIDATION_WITHOUT_APPLIED_DECISION"],
    );
  }

  const receiptId = `fg9-receipt-${hash({
    decisionId: decision.decisionId,
    resourceDelta,
    qualityResult: params.qualityResult,
    survivedValidation: params.survivedValidation,
    marker: "fg9-receipt",
  })}`;

  return {
    receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId,
    decisionId: decision.decisionId,
    runId: decision.runId,
    sessionId: decision.sessionId,
    optimizationKind: decision.kind,
    createdAt: new Date().toISOString(),
    beforeSustainabilityReceiptId: params.beforeSustainabilityReceiptId,
    afterSustainabilityReceiptId: params.afterSustainabilityReceiptId,
    resourceDelta,
    verificationEvidenceRef: params.verificationEvidenceRef,
    qualityResult: params.qualityResult,
    survivedValidation: params.survivedValidation,
    rollbackStatus: params.rollbackStatus ?? "NOT_APPLICABLE",
    finalized: false,
    finalizedAt: undefined,
  };
}

export function finalizeOptimizationReceipt(receipt: ForgeGreenOptimizationReceipt): ForgeGreenOptimizationReceipt {
  if (receipt.finalized) {
    throw new OptimizationDecisionError(`Optimization receipt ${receipt.receiptId} is already finalized`, ["ALREADY_FINALIZED"]);
  }
  return { ...receipt, finalized: true, finalizedAt: new Date().toISOString() };
}
