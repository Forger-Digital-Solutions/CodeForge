import type { ComparisonBasis, SustainabilityConfidence } from "./sustainability-types.js";

/**
 * FG-9: ForgeGreen optimization & efficiency policy (Phase 4). This is the first phase where
 * ForgeGreen may narrowly ACT (not just measure) — and only inside explicitly-approved
 * resource-control surfaces (`docs/codeforge-forgegreen-optimization-policy.md`). It never gains
 * authority over model selection, free/paid classification, 8-Bit qualification, provider
 * safety, security policy, approvals, ForgeVerify verdicts, or Completion Gate verdicts.
 */
export const FORGE_GREEN_OPTIMIZATION_POLICY_VERSION = "fg9-optimization-1";

/** OFF: no candidate detection. SHADOW: candidates are identified and recorded, execution is
 * NEVER altered. ACTIVE_SAFE: a graduated optimization kind may actually take effect. */
export type OptimizationPolicyMode = "OFF" | "SHADOW" | "ACTIVE_SAFE";

export type OptimizationKind =
  | "DUPLICATE_READ_ONLY_TOOL_REUSE"
  | "DUPLICATE_CONTEXT_PAGE_TRANSMISSION"
  | "OPTIONAL_PREFETCH_SUPPRESSION"
  | "VERIFICATION_EVIDENCE_REUSE";

export type OptimizationDecisionStatus =
  | "PROPOSED"
  | "APPLIED"
  | "REJECTED"
  | "SKIPPED_INSUFFICIENT_EVIDENCE"
  | "ROLLED_BACK"
  | "INVALIDATED";

/** Only fields evidence actually supports are populated — never a guessed number. */
export interface OptimizationExpectedEffect {
  avoidedRequests: number | undefined;
  avoidedTokens: number | undefined;
  avoidedBytes: number | undefined;
  avoidedToolExecutions: number | undefined;
  avoidedVerificationReruns: number | undefined;
  timeReductionMs: number | undefined;
}

export interface OptimizationSafetyGuards {
  /** Why this operation is believed redundant/reusable. */
  redundancyRationale: string;
  /** What invariant must remain true for the reuse/suppression to be safe. */
  invariant: string;
  /** What verification proves it was safe (evidence id/description), when applicable. */
  verificationProof: string | undefined;
  reasonCodes: string[];
}

export interface ForgeGreenOptimizationDecision {
  decisionSchemaVersion: string;
  decisionId: string;
  runId: string;
  sessionId: string | undefined;
  policyVersion: string;
  /** The mode actually in effect when this decision was made — a SHADOW decision can never have
   * status `APPLIED`. */
  mode: OptimizationPolicyMode;
  kind: OptimizationKind;
  createdAt: string;
  targetResource: string;
  /** Ids of the ledger events / evidence this decision was built from — never raw content. */
  sourceEvidenceIds: string[];
  sustainabilityReceiptId: string | undefined;
  expectedEffect: OptimizationExpectedEffect;
  confidence: SustainabilityConfidence;
  safetyGuards: OptimizationSafetyGuards;
  status: OptimizationDecisionStatus;
  statusReasonCodes: string[];
  finalized: boolean;
  finalizedAt: string | undefined;
}

export type OptimizationQualityResult = "EQUIVALENT" | "IMPROVED" | "REGRESSED" | "UNKNOWN";
export type OptimizationRollbackStatus = "NOT_APPLICABLE" | "ROLLED_BACK" | "ROLLBACK_FAILED";

/** before -> decision -> after -> verification. Distinguishes `measured` (both before/after are
 * real measurements), `simulated` (a deterministic counterfactual replay), and `projected`
 * (expected-only, no after-measurement exists yet) — matching `ComparisonBasis` from the FG-8
 * baseline framework. Never claims a `measured` delta from `projected` numbers. */
export interface OptimizationResourceDelta {
  basis: ComparisonBasis | "projected";
  requestsAvoided: number | undefined;
  tokensAvoided: number | undefined;
  bytesAvoided: number | undefined;
  toolExecutionsAvoided: number | undefined;
  verificationRerunsAvoided: number | undefined;
  wallClockMsDelta: number | undefined;
}

export interface ForgeGreenOptimizationReceipt {
  receiptSchemaVersion: string;
  receiptId: string;
  decisionId: string;
  runId: string;
  sessionId: string | undefined;
  optimizationKind: OptimizationKind;
  createdAt: string;
  /** Reference only — never an embedded duplicate of the full receipt. */
  beforeSustainabilityReceiptId: string | undefined;
  afterSustainabilityReceiptId: string | undefined;
  resourceDelta: OptimizationResourceDelta;
  verificationEvidenceRef: string | undefined;
  qualityResult: OptimizationQualityResult;
  survivedValidation: boolean;
  rollbackStatus: OptimizationRollbackStatus;
  finalized: boolean;
  finalizedAt: string | undefined;
}

export class OptimizationDecisionError extends Error {
  readonly reasonCodes: string[];
  constructor(message: string, reasonCodes: string[]) {
    super(message);
    this.name = "OptimizationDecisionError";
    this.reasonCodes = reasonCodes;
  }
}
