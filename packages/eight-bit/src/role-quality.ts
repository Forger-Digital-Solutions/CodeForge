import type { ModelQualificationReceipt } from "./qualification/types.js";
import type { EightBitRole } from "./types.js";

/** R41 role evidence is advisory ranking input, never an eligibility override. */
export interface RoleQualityAdvice {
  scoreAdjustment: number;
  confidence: number;
  sampleCount: number;
  observedAt?: string;
  needsRequalification: boolean;
  reasonCodes: string[];
}

export type RoleQualificationTier = "QUALIFIED" | "PROBATION" | "NOT_TESTED";

/**
 * Bare-router ordering: healthy available supply first, then qualified before
 * probation inside that tier. A provider declaring exhausted/critical capacity
 * must not strand work while a healthy probation fallback can admit it.
 */
export function roleRoutePriority(
  qualification: RoleQualificationTier | undefined,
  capacityReasonCodes: readonly string[],
  healthState?: string,
): { availabilityTier: number; qualificationTier: number } {
  const constrained = capacityReasonCodes.some((code) =>
    code === "KNOWN_CAPACITY_EXHAUSTED" || code === "LOW_REQUEST_CAPACITY_CRITICAL" || code === "LOW_TOKEN_CAPACITY_CRITICAL")
    || healthState === "SATURATED" || healthState === "TEMPORARY_CAPACITY";
  return {
    availabilityTier: constrained ? 1 : 0,
    qualificationTier: qualification === "QUALIFIED" ? 0 : qualification === "PROBATION" ? 1 : 2,
  };
}

const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROLE_ADJUSTMENT = 12;

/**
 * Receipt producers the current qualification semantics know how to interpret. A suite or
 * protocol bump that makes old evidence incompatible drops the old version here — those
 * receipts then read as absent at the fabric layer and STALE at the registry, reopening
 * bounded requalification instead of lending trust to an unreadable verdict.
 */
export const SUPPORTED_RECEIPT_SUITE_VERSIONS: ReadonlySet<string> = new Set([
  "R10_FREE_QUALIFICATION_V1",
  "R1_FREE_CLOUD_COMPACT_V1",
  "R41_ROLE_QUALIFICATION_V3",
  "R66_ROLE_QUALIFICATION_V4",
]);

export function receiptSuiteSupported(receipt: ModelQualificationReceipt | undefined): boolean {
  return receipt !== undefined && SUPPORTED_RECEIPT_SUITE_VERSIONS.has(receipt.suiteVersion);
}

/**
 * The role-admission verdict for one route: the current qualification status for this role, or
 * undefined when no *fresh* evidence exists — an expired receipt must not quarantine a route
 * forever, it simply reverts the route to unmeasured (legacy) eligibility. EXPLORER inherits
 * TOOL_AGENT's verdict when it was never measured itself.
 */
export function roleQualificationStatusFor(
  receipt: ModelQualificationReceipt | undefined,
  role: EightBitRole,
  nowMs = Date.now(),
): "QUALIFIED" | "NOT_QUALIFIED" | "HARD_FAILURE" | "NOT_TESTED" | "PROBATION" | undefined {
  if (!receipt) return undefined;
  // A receipt written by an incompatible suite carries no interpretable verdicts.
  if (!receiptSuiteSupported(receipt)) return undefined;
  const verdict = receipt.roleResults[role] ?? (role === "EXPLORER" ? receipt.roleResults.TOOL_AGENT : undefined);
  const at = Date.parse(verdict?.completedAt ?? receipt.completedAt);
  if (!Number.isFinite(at) || nowMs - at >= MAX_EVIDENCE_AGE_MS) return undefined;
  return verdict?.status ?? "NOT_TESTED";
}

/** R41 admission rule: only a current disqualified/unmeasured verdict excludes the route. */
export function roleAdmissionAllowed(receipt: ModelQualificationReceipt | undefined, role: EightBitRole, nowMs = Date.now()): boolean {
  const status = roleQualificationStatusFor(receipt, role, nowMs);
  return status === undefined || status === "QUALIFIED" || status === "PROBATION";
}
const TRANSIENT = /\b429\b|rate.?limit|quota|\b401\b|\b403\b|\b5\d\d\b|timed? ?out|econnreset|fetch failed|no usable completion choices|R41_BOUND/i;

/**
 * A four-sample prior keeps one lucky case from overwhelming a route's health or
 * available capacity. Time decay is linear over 30 days; an expired receipt never
 * contributes to ranking. The role's qualification state remains authoritative
 * for the existing role-admission tier; this value only separates eligible peers.
 */
export function roleQualityAdvice(
  receipt: ModelQualificationReceipt | undefined,
  role: EightBitRole,
  nowMs = Date.now(),
): RoleQualityAdvice {
  const empty = (reason: string, stale = false): RoleQualityAdvice => ({
    scoreAdjustment: 0, confidence: 0, sampleCount: 0,
    needsRequalification: stale, reasonCodes: [reason],
  });
  if (!receipt) return empty("ROLE_EVIDENCE_ABSENT", true);
  if (!receiptSuiteSupported(receipt)) return empty("RECEIPT_SUITE_UNSUPPORTED", true);
  const verdict = receipt.roleResults[role];
  if (!verdict) return empty("ROLE_NOT_MEASURED", true);
  const at = Date.parse(verdict.completedAt);
  if (!Number.isFinite(at)) return empty("ROLE_EVIDENCE_INVALID_DATE", true);
  const age = Math.max(0, nowMs - at);
  if (age >= MAX_EVIDENCE_AGE_MS) return empty("ROLE_EVIDENCE_STALE", true);
  const cases = verdict.testCases.filter((c) => !c.error || !TRANSIENT.test(c.error));
  if (verdict.status === "NOT_TESTED" || cases.length === 0) return empty("ROLE_INCONCLUSIVE", true);
  const passes = cases.filter((c) => c.passed).length;
  const quality = (passes + 1) / (cases.length + 2);
  const confidence = Math.min(1, cases.length / 4) * (1 - age / MAX_EVIDENCE_AGE_MS);
  const raw = Math.round(2 * MAX_ROLE_ADJUSTMENT * (quality - 0.5) * confidence);
  const qualified = verdict.status === "QUALIFIED";
  const failed = verdict.status === "NOT_QUALIFIED" || verdict.status === "HARD_FAILURE";
  const criticalFailure = verdict.status === "HARD_FAILURE" && cases.some((c) => c.hardFailure && !c.passed);
  const adjustment = criticalFailure ? -Math.ceil(MAX_ROLE_ADJUSTMENT * confidence)
    : qualified ? Math.max(0, raw)
      : failed ? Math.min(0, raw)
        : Math.min(0, raw); // probation is a fallback tier, never a quality promotion
  return {
    scoreAdjustment: Math.max(-MAX_ROLE_ADJUSTMENT, Math.min(MAX_ROLE_ADJUSTMENT, adjustment)),
    confidence,
    sampleCount: cases.length,
    observedAt: verdict.completedAt,
    needsRequalification: false,
    reasonCodes: [qualified ? "ROLE_QUALIFIED_EVIDENCE" : criticalFailure ? "ROLE_CRITICAL_FAILURE" : verdict.status === "PROBATION" ? "ROLE_PROBATION_EVIDENCE" : "ROLE_NEGATIVE_EVIDENCE"],
  };
}
