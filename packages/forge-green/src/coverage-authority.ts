import crypto from "node:crypto";
import path from "node:path";
import type {
  GenericVerificationEvidence,
  VerificationEvidenceKind,
  VerificationObligation,
  VerificationScope,
} from "./verification-policy.js";
import { FORGE_GREEN_VERIFICATION_POLICY_VERSION } from "./verification-policy.js";
import type { EfficiencyLedgerEvent } from "./ledger.js";

/** FG-7 is a coverage authority, not a completion or approval authority. */
export const FORGE_GREEN_COVERAGE_POLICY_VERSION = "fg7-verification-coverage-1";

export type VerificationCoverageOutcome = "SUFFICIENT" | "INSUFFICIENT" | "BLOCKED" | "STALE";
export type VerificationCoverageEntryStatus = "covered" | "missing" | "failed" | "stale" | "incompatible";

export type VerificationCoverageReasonCode =
  | "ALL_REQUIRED_OBLIGATIONS_COVERED"
  | "REQUIRED_OBLIGATION_MISSING"
  | "REQUIRED_EVIDENCE_FAILED"
  | "STALE_INPUT_STATE"
  | "STALE_EXECUTION_REVISION"
  | "POLICY_VERSION_MISMATCH"
  | "WORKSPACE_IDENTITY_MISMATCH"
  | "EVIDENCE_KIND_MISMATCH"
  | "EVIDENCE_SCOPE_MISMATCH"
  | "TARGET_COVERAGE_MISSING"
  | "UNTRUSTED_EVIDENCE_SOURCE"
  | "MISSING_EVIDENCE_IDENTITY"
  | "DUPLICATE_EVIDENCE_SUPPRESSED"
  | "OPTIONAL_OBLIGATION_UNCOVERED"
  | "NO_OBLIGATIONS";

export interface VerificationCoverageMetrics {
  totalRequired: number;
  alreadyCovered: number;
  executed: number;
  skippedValid: number;
  staleReruns: number;
  duplicateObservations: number;
  partialCoverageCount: number;
  restartReuseCount: number;
  avoidedVerifierCalls: number;
  avoidedToolCalls: number;
  invalidationReasons: readonly string[];
}

export interface VerificationCoverageEvidence extends GenericVerificationEvidence {
  /** A producer may make an explicit obligation claim; prose and command output are never claims. */
  obligationIds?: readonly string[];
  targetPackages?: readonly string[];
}

export interface VerificationCoverageEntry {
  obligationId: string;
  status: VerificationCoverageEntryStatus;
  evidenceIds: readonly string[];
  reasonCodes: readonly VerificationCoverageReasonCode[];
}

export interface VerificationCoverageReceipt {
  kind: "verification_coverage_receipt";
  coverageId: string;
  policyVersion: string;
  coveragePolicyVersion: string;
  workspacePath: string;
  inputStateHash: string;
  executionRevision?: number;
  obligationCount: number;
  requiredObligationCount: number;
  coveredObligationCount: number;
  coveredRequiredObligationCount: number;
  missingRequiredObligationIds: readonly string[];
  coveredEvidenceIds: readonly string[];
  entries: readonly VerificationCoverageEntry[];
  outcome: VerificationCoverageOutcome;
  reasonCodes: readonly VerificationCoverageReasonCode[];
  metrics: VerificationCoverageMetrics;
  createdAt: string;
}

export interface VerificationCoverageRequest {
  obligations: readonly VerificationObligation[];
  evidence: readonly VerificationCoverageEvidence[];
  workspacePath: string;
  currentInputStateHash: string;
  currentExecutionRevision?: number;
  policyVersion?: string;
  coveragePolicyVersion?: string;
  trustedVerifierIds?: readonly string[];
  metrics?: Partial<VerificationCoverageMetrics>;
  ledger?: { record(event: EfficiencyLedgerEvent): void };
}

export interface VerificationCoverageResult {
  outcome: VerificationCoverageOutcome;
  isSufficient: boolean;
  coveredObligationIds: readonly string[];
  missingRequiredObligationIds: readonly string[];
  entries: readonly VerificationCoverageEntry[];
  receipt: VerificationCoverageReceipt;
  rationale: string;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

function evidenceText(evidence: VerificationCoverageEvidence): string {
  return [evidence.kind, evidence.category, evidence.verifierId].filter(Boolean).join(" ").toLowerCase();
}

function kindMatches(obligation: VerificationObligation, evidence: VerificationCoverageEvidence): boolean {
  const text = evidenceText(evidence);
  const exact = evidence.kind === obligation.kind;
  if (exact) return true;
  if (obligation.kind === "TYPECHECK") return text.includes("typecheck") || text.includes("type-check");
  if (obligation.kind === "BUILD") return text.includes("build");
  if (["UNIT_TEST", "TARGETED_TEST", "PACKAGE_TEST", "INTEGRATION_TEST", "E2E_TEST"].includes(obligation.kind)) return text.includes("test") || text.includes("integration") || text.includes("e2e");
  if (obligation.kind === "REAL_POSTGRESQL") return text.includes("postgres") || text.includes("database");
  if (obligation.kind === "REAL_GIT") return text.includes("git");
  if (obligation.kind === "REAL_CHILD_PROCESS") return text.includes("child") || text.includes("process") || text.includes("runtime");
  return false;
}

function scopeMatches(obligation: VerificationObligation, evidence: VerificationCoverageEvidence): boolean {
  return evidence.scope === obligation.scope;
}

function targetsMatch(obligation: VerificationObligation, evidence: VerificationCoverageEvidence): boolean {
  if (obligation.targetPaths && obligation.targetPaths.length > 0) {
    const paths = new Set((evidence.targetPaths ?? []).map(normalize));
    if (!obligation.targetPaths.every((target) => paths.has(normalize(target)))) return false;
  }
  if (obligation.targetPackages && obligation.targetPackages.length > 0) {
    const packages = new Set(evidence.targetPackages ?? []);
    if (!obligation.targetPackages.every((target) => packages.has(target))) return false;
  }
  return true;
}

function identityReason(
  evidence: VerificationCoverageEvidence,
  request: VerificationCoverageRequest,
  policyVersion: string,
): VerificationCoverageReasonCode | undefined {
  if (typeof evidence.workspacePath !== "string" || path.resolve(evidence.workspacePath) !== path.resolve(request.workspacePath)) return "WORKSPACE_IDENTITY_MISMATCH";
  if (evidence.inputStateHash !== request.currentInputStateHash) return "STALE_INPUT_STATE";
  if (request.currentExecutionRevision !== undefined && evidence.executionRevision !== request.currentExecutionRevision) return "STALE_EXECUTION_REVISION";
  if (evidence.policyVersion !== policyVersion) return "POLICY_VERSION_MISMATCH";
  return undefined;
}

function evidenceIdentityReason(
  evidence: VerificationCoverageEvidence,
  trustedVerifierIds: readonly string[] | undefined,
): VerificationCoverageReasonCode | undefined {
  if (evidence.authority !== "forgeverify" && evidence.authority !== "trusted_producer") return "UNTRUSTED_EVIDENCE_SOURCE";
  if (!evidence.verifierId || !evidence.evidenceHash) return "MISSING_EVIDENCE_IDENTITY";
  if (evidence.authority === "forgeverify" && (!evidence.verifierVersion || !evidence.definitionDigest || !evidence.planId || !evidence.attemptId)) return "MISSING_EVIDENCE_IDENTITY";
  if (trustedVerifierIds && !trustedVerifierIds.includes(evidence.verifierId)) return "UNTRUSTED_EVIDENCE_SOURCE";
  return undefined;
}

function matchingEvidence(
  obligation: VerificationObligation,
  evidence: readonly VerificationCoverageEvidence[],
  request: VerificationCoverageRequest,
  policyVersion: string,
): { current: VerificationCoverageEvidence[]; failed: VerificationCoverageEvidence[]; stale: VerificationCoverageReasonCode[]; incompatible: VerificationCoverageReasonCode[]; duplicateObservations: number } {
  const current: VerificationCoverageEvidence[] = [];
  const failed: VerificationCoverageEvidence[] = [];
  const stale: VerificationCoverageReasonCode[] = [];
  const incompatible: VerificationCoverageReasonCode[] = [];
  const seen = new Set<string>();
  let duplicateObservations = 0;
  for (const item of evidence) {
    const explicitlyClaimsObligation = item.obligationIds?.includes(obligation.id) === true;
    if (!explicitlyClaimsObligation && !kindMatches(obligation, item)) continue;
    const identityKey = item.evidenceHash ?? item.evidenceId;
    if (seen.has(identityKey)) {
      duplicateObservations += 1;
      continue;
    }
    seen.add(identityKey);
    const authority = evidenceIdentityReason(item, request.trustedVerifierIds);
    if (authority) {
      incompatible.push(authority);
      continue;
    }
    const identity = identityReason(item, request, policyVersion);
    if (identity) {
      stale.push(identity);
      continue;
    }
    if (!scopeMatches(obligation, item)) {
      incompatible.push("EVIDENCE_SCOPE_MISMATCH");
      continue;
    }
    if (!targetsMatch(obligation, item)) {
      incompatible.push("TARGET_COVERAGE_MISSING");
      continue;
    }
    if (item.status !== "passed" || (item.exitCode !== undefined && item.exitCode !== 0)) {
      failed.push(item);
      continue;
    }
    current.push(item);
  }
  return { current, failed, stale, incompatible, duplicateObservations };
}

/**
 * Evaluates whether current, identity-bound evidence covers each hard obligation. This function
 * never interprets a command string, test count, prose, selected-test list, or verifier plan as
 * proof. The returned receipt is evidence metadata only; Completion Gate remains authoritative.
 */
export function evaluateVerificationCoverage(request: VerificationCoverageRequest): VerificationCoverageResult {
  const policyVersion = request.policyVersion ?? FORGE_GREEN_VERIFICATION_POLICY_VERSION;
  const coveragePolicyVersion = request.coveragePolicyVersion ?? FORGE_GREEN_COVERAGE_POLICY_VERSION;
  const entries: VerificationCoverageEntry[] = [];
  const coveredObligationIds: string[] = [];
  const coveredEvidenceIds = new Set<string>();
  const missingRequiredObligationIds: string[] = [];
  const reasonCodes = new Set<VerificationCoverageReasonCode>();
  let duplicateObservations = 0;
  let staleReruns = 0;
  const invalidationReasons = new Set<string>();

  for (const obligation of request.obligations) {
    const match = matchingEvidence(obligation, request.evidence, request, policyVersion);
    duplicateObservations += match.duplicateObservations;
    match.stale.forEach((reason) => invalidationReasons.add(reason));
    const evidenceIds = match.current.map((item) => item.evidenceId);
    if (evidenceIds.length > 0) {
      coveredObligationIds.push(obligation.id);
      evidenceIds.forEach((id) => coveredEvidenceIds.add(id));
      entries.push({ obligationId: obligation.id, status: "covered", evidenceIds, reasonCodes: ["ALL_REQUIRED_OBLIGATIONS_COVERED"] });
      continue;
    }

    const reasons = Array.from(new Set([
      ...match.stale,
      ...match.incompatible,
      ...(match.failed.length > 0 ? ["REQUIRED_EVIDENCE_FAILED" as const] : []),
      ...(match.stale.length === 0 && match.incompatible.length === 0 && match.failed.length === 0 ? ["REQUIRED_OBLIGATION_MISSING" as const] : []),
    ]));
    if (match.duplicateObservations > 0) reasons.push("DUPLICATE_EVIDENCE_SUPPRESSED");
    staleReruns += match.stale.length > 0 && match.current.length === 0 ? 1 : 0;
    const status: VerificationCoverageEntryStatus = match.failed.length > 0 ? "failed" : match.stale.length > 0 ? "stale" : match.incompatible.length > 0 ? "incompatible" : "missing";
    entries.push({ obligationId: obligation.id, status, evidenceIds: match.failed.map((item) => item.evidenceId), reasonCodes: reasons });
    reasons.forEach((reason) => reasonCodes.add(reason));
    if (obligation.required) missingRequiredObligationIds.push(obligation.id);
    else reasonCodes.add("OPTIONAL_OBLIGATION_UNCOVERED");
  }

  if (duplicateObservations > 0) reasonCodes.add("DUPLICATE_EVIDENCE_SUPPRESSED");

  if (request.obligations.length === 0) {
    reasonCodes.add("NO_OBLIGATIONS");
  } else if (missingRequiredObligationIds.length === 0) {
    reasonCodes.add("ALL_REQUIRED_OBLIGATIONS_COVERED");
  }

  const hasStale = entries.some((entry) => entry.status === "stale");
  const hasFailed = entries.some((entry) => entry.status === "failed");
  const outcome: VerificationCoverageOutcome = missingRequiredObligationIds.length === 0
    ? "SUFFICIENT"
    : hasStale && !hasFailed ? "STALE"
      : hasFailed ? "BLOCKED"
        : "INSUFFICIENT";
  const receipt: VerificationCoverageReceipt = Object.freeze({
    kind: "verification_coverage_receipt",
    coverageId: digest({ coveragePolicyVersion, policyVersion, workspacePath: path.resolve(request.workspacePath), inputStateHash: request.currentInputStateHash, executionRevision: request.currentExecutionRevision, obligations: request.obligations.map((obligation) => ({ id: obligation.id, kind: obligation.kind, scope: obligation.scope, required: obligation.required, targetPaths: obligation.targetPaths, targetPackages: obligation.targetPackages })), evidence: request.evidence.map((item) => ({ id: item.evidenceId, status: item.status, kind: item.kind, scope: item.scope, inputStateHash: item.inputStateHash, executionRevision: item.executionRevision, policyVersion: item.policyVersion })) }),
    policyVersion,
    coveragePolicyVersion,
    workspacePath: path.resolve(request.workspacePath),
    inputStateHash: request.currentInputStateHash,
    ...(request.currentExecutionRevision !== undefined ? { executionRevision: request.currentExecutionRevision } : {}),
    obligationCount: request.obligations.length,
    requiredObligationCount: request.obligations.filter((obligation) => obligation.required).length,
    coveredObligationCount: coveredObligationIds.length,
    coveredRequiredObligationCount: request.obligations.filter((obligation) => obligation.required && coveredObligationIds.includes(obligation.id)).length,
    missingRequiredObligationIds: Object.freeze([...missingRequiredObligationIds]),
    coveredEvidenceIds: Object.freeze([...coveredEvidenceIds]),
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry, evidenceIds: Object.freeze([...entry.evidenceIds]), reasonCodes: Object.freeze([...entry.reasonCodes]) }))),
    outcome,
    reasonCodes: Object.freeze(Array.from(reasonCodes)),
    metrics: Object.freeze({
      totalRequired: request.obligations.filter((obligation) => obligation.required).length,
      alreadyCovered: coveredObligationIds.length,
      executed: request.metrics?.executed ?? 0,
      skippedValid: request.metrics?.skippedValid ?? coveredObligationIds.length,
      staleReruns: request.metrics?.staleReruns ?? staleReruns,
      duplicateObservations: request.metrics?.duplicateObservations ?? duplicateObservations,
      partialCoverageCount: request.metrics?.partialCoverageCount ?? (missingRequiredObligationIds.length > 0 && coveredObligationIds.length > 0 ? 1 : 0),
      restartReuseCount: request.metrics?.restartReuseCount ?? 0,
      avoidedVerifierCalls: request.metrics?.avoidedVerifierCalls ?? coveredObligationIds.length,
      avoidedToolCalls: request.metrics?.avoidedToolCalls ?? 0,
      invalidationReasons: Object.freeze([...new Set([...(request.metrics?.invalidationReasons ?? []), ...invalidationReasons])]),
    }),
    createdAt: new Date().toISOString(),
  });
  const coverageMetrics = receipt.metrics;
  request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: 1, unit: "count", reason: "requests_considered" });
  if (coverageMetrics.executed > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.executed, unit: "count", reason: "executions_performed" });
  if (coverageMetrics.skippedValid > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.skippedValid, unit: "count", reason: "skipped_valid" });
  if (coverageMetrics.duplicateObservations > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.duplicateObservations, unit: "count", reason: "duplicate_suppressed" });
  if (coverageMetrics.staleReruns > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.staleReruns, unit: "count", reason: "stale_rejected" });
  if (coverageMetrics.partialCoverageCount > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.partialCoverageCount, unit: "count", reason: "partial_coverage" });
  if (coverageMetrics.restartReuseCount > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.restartReuseCount, unit: "count", reason: "restart_reuse" });
  if (coverageMetrics.avoidedVerifierCalls > 0) request.ledger?.record({ mechanism: "verification_coverage", measurement: "measured", quantity: coverageMetrics.avoidedVerifierCalls, unit: "count", reason: "avoided_verifier_calls" });
  return {
    outcome,
    isSufficient: outcome === "SUFFICIENT",
    coveredObligationIds: Object.freeze(coveredObligationIds),
    missingRequiredObligationIds: Object.freeze(missingRequiredObligationIds),
    entries: receipt.entries,
    receipt,
    rationale: outcome === "SUFFICIENT" ? "All required verification obligations have current, identity-bound coverage." : `Required verification coverage is ${outcome.toLowerCase()}; ${missingRequiredObligationIds.length} required obligation(s) remain uncovered.`,
  };
}

export function isVerificationCoverageSufficient(result: VerificationCoverageResult | VerificationCoverageReceipt): boolean {
  return result.outcome === "SUFFICIENT";
}

export type { VerificationEvidenceKind, VerificationScope };
