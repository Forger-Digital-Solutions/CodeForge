/**
 * FG-12F: versioned cost policy for Candidate D (`VERIFICATION_EVIDENCE_REUSE`) production
 * rollout. ForgeVerify remains the sole authority on evidence VALIDITY; this policy only answers
 * ForgeGreen's own question — "is reusing this already-valid evidence actually worth it?" — from
 * measured historical verifier durations. It can veto a reuse; it can never authorize an
 * otherwise-invalid one.
 *
 * Evidence for the threshold (FG-12E, docs/codeforge-forgegreen-fg12e-performance-trial.json):
 * measured break-even ≈152 ms (IQR 139–184 ms). Gating at the break-even median would sit inside
 * the noise band, so the initial production threshold is 250 ms — above the p75 overhead (184 ms),
 * at the low end of the class FG-12E measured as consistently positive (248–315 ms), and low
 * enough that the cheap `node --check` class (~81 ms) stays fresh.
 */
export const FG12F_REUSE_COST_POLICY_VERSION = "fg12f-verification-reuse-cost-gated-1";

/** Where historical duration samples come from: the `elapsedMs` of prior PASSED verification
 * evidence records for the same verifier identity. No speculative model-based prediction. */
export const FG12F_REUSE_COST_HISTORY_SOURCE = "verification_evidence_elapsed_ms" as const;

export interface VerificationReuseCostPolicy {
  policyVersion: string;
  costHistorySource: typeof FG12F_REUSE_COST_HISTORY_SOURCE;
  /** Inclusive boundary (§24): a verifier is cost-eligible iff `estimatedFreshMs >= costThresholdMs`. */
  costThresholdMs: number;
  /** Unknown/unreliable historical cost always falls back to fresh verification (§6) — never
   * "probably expensive". */
  unknownCostBehavior: "FRESH_VERIFY";
  /** Minimum trusted samples for a cost decision; 1 prior successful sample may be used at lower
   * confidence (§8). */
  minDurationSamples: 1;
  /** Most-recent-N window for the median statistic — bounds both staleness and work (§8/§18). */
  maxDurationSamples: number;
  /** FG-12E p75 reuse overhead, used ONLY for the reported net-benefit estimate — never for the
   * gate itself. The authoritative overhead is re-measured per deployment (spec §28). */
  estimatedReuseOverheadMs: number;
  /** Historical durations are only trusted for a materially identical verifier: same id, same
   * version, same definition digest (§7). */
  durationIdentityRequirements: readonly ("verifierId" | "verifierVersion" | "definitionDigest")[];
  /** Existing ForgeGreen kill switch — must keep working with no restart requirement (§10). */
  killSwitchEnv: "CODEFORGE_FORGEGREEN_OPTIMIZATION";
}

export const FG12F_VERIFICATION_REUSE_COST_POLICY: Readonly<VerificationReuseCostPolicy> = Object.freeze({
  policyVersion: FG12F_REUSE_COST_POLICY_VERSION,
  costHistorySource: FG12F_REUSE_COST_HISTORY_SOURCE,
  costThresholdMs: 250,
  unknownCostBehavior: "FRESH_VERIFY",
  minDurationSamples: 1,
  maxDurationSamples: 5,
  estimatedReuseOverheadMs: 184,
  durationIdentityRequirements: ["verifierId", "verifierVersion", "definitionDigest"] as const,
  killSwitchEnv: "CODEFORGE_FORGEGREEN_OPTIMIZATION",
});

export type ReuseCostConfidence = "NO_DATA" | "SINGLE_SAMPLE" | "MULTI_SAMPLE";

/** Non-authoritative cost estimate (§4). Carries no notion of verification validity. */
export interface VerifierReuseCostEstimate {
  costHistorySource: typeof FG12F_REUSE_COST_HISTORY_SOURCE | "unavailable";
  /** Number of trusted samples actually used (after the most-recent-N window). */
  sampleCount: number;
  /** Conservative median of the trusted recent samples; `undefined` when no trusted sample exists. */
  estimatedFreshMs: number | undefined;
  estimatedReuseOverheadMs: number;
  /** `estimatedFreshMs - estimatedReuseOverheadMs`; reported only, never gating. */
  expectedNetBenefitMs: number | undefined;
  confidence: ReuseCostConfidence;
}

function trustedSamples(samples: readonly number[]): number[] {
  return samples.filter((sample) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Estimates the benefit of reusing valid evidence instead of executing the verifier fresh, from
 * prior successful execution durations. `priorElapsedMsSamples` is chronological (oldest first);
 * only the most recent `policy.maxDurationSamples` are used. With no trusted sample the estimate
 * is `unavailable` and the policy's unknown-cost behavior (fresh verification) applies.
 */
export function estimateVerifierReuseBenefit(
  params: { priorElapsedMsSamples?: readonly number[]; policy?: VerificationReuseCostPolicy } = {},
): VerifierReuseCostEstimate {
  const policy = params.policy ?? FG12F_VERIFICATION_REUSE_COST_POLICY;
  const trusted = trustedSamples(params.priorElapsedMsSamples ?? []);
  if (trusted.length < policy.minDurationSamples) {
    return {
      costHistorySource: "unavailable",
      sampleCount: 0,
      estimatedFreshMs: undefined,
      estimatedReuseOverheadMs: policy.estimatedReuseOverheadMs,
      expectedNetBenefitMs: undefined,
      confidence: "NO_DATA",
    };
  }
  const recent = trusted.slice(-policy.maxDurationSamples);
  const estimatedFreshMs = median(recent);
  return {
    costHistorySource: policy.costHistorySource,
    sampleCount: recent.length,
    estimatedFreshMs,
    estimatedReuseOverheadMs: policy.estimatedReuseOverheadMs,
    expectedNetBenefitMs: estimatedFreshMs - policy.estimatedReuseOverheadMs,
    confidence: recent.length === 1 ? "SINGLE_SAMPLE" : "MULTI_SAMPLE",
  };
}

/** Inclusive threshold semantics (§24): `estimatedFreshMs >= costThresholdMs` is eligible. Unknown
 * cost is never eligible (§6). Floating ambiguity is avoided by comparing integers at the policy
 * boundary; a 250 ms estimate is eligible, 249 ms is not. */
export function isVerifierReuseCostEligible(
  estimate: VerifierReuseCostEstimate,
  policy: VerificationReuseCostPolicy = FG12F_VERIFICATION_REUSE_COST_POLICY,
): boolean {
  if (estimate.estimatedFreshMs === undefined || estimate.sampleCount < policy.minDurationSamples) return false;
  return estimate.estimatedFreshMs >= policy.costThresholdMs;
}
