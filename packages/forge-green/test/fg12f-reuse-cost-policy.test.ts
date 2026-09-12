import { afterEach, describe, expect, it } from "vitest";
import {
  estimateVerifierReuseBenefit,
  isVerifierReuseCostEligible,
  FG12F_VERIFICATION_REUSE_COST_POLICY,
  FG12F_REUSE_COST_POLICY_VERSION,
  detectReusableVerificationEvidence,
  getGraduationRegistry,
  resolveOptimizationMode,
} from "../src/index.js";

afterEach(() => {
  delete process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION;
});

describe("FG-12F versioned cost policy (spec §5/§9)", () => {
  it("is explicitly versioned and conservative: 250 ms threshold, unknown cost -> fresh, inclusive boundary", () => {
    expect(FG12F_REUSE_COST_POLICY_VERSION).toBe("fg12f-verification-reuse-cost-gated-1");
    expect(FG12F_VERIFICATION_REUSE_COST_POLICY.costThresholdMs).toBe(250);
    expect(FG12F_VERIFICATION_REUSE_COST_POLICY.unknownCostBehavior).toBe("FRESH_VERIFY");
    expect(FG12F_VERIFICATION_REUSE_COST_POLICY.costHistorySource).toBe("verification_evidence_elapsed_ms");
    expect(FG12F_VERIFICATION_REUSE_COST_POLICY.durationIdentityRequirements).toEqual(["verifierId", "verifierVersion", "definitionDigest"]);
    expect(FG12F_VERIFICATION_REUSE_COST_POLICY.killSwitchEnv).toBe("CODEFORGE_FORGEGREEN_OPTIMIZATION");
  });

  it("graduates Candidate D to ACTIVE_SAFE while Candidates B/C remain SHADOW (spec §12/§30)", () => {
    const registry = getGraduationRegistry();
    expect(registry.VERIFICATION_EVIDENCE_REUSE).toBe("ACTIVE_SAFE");
    expect(registry.DUPLICATE_READ_ONLY_TOOL_REUSE).toBe("ACTIVE_SAFE");
    expect(registry.DUPLICATE_CONTEXT_PAGE_TRANSMISSION).toBe("SHADOW");
    expect(registry.OPTIONAL_PREFETCH_SUPPRESSION).toBe("SHADOW");
    expect(resolveOptimizationMode("VERIFICATION_EVIDENCE_REUSE")).toBe("ACTIVE_SAFE");
  });

  it("the existing env ceiling still bounds Candidate D and can force it OFF without restart (spec §10)", () => {
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "SHADOW";
    expect(resolveOptimizationMode("VERIFICATION_EVIDENCE_REUSE")).toBe("SHADOW");
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "OFF";
    expect(resolveOptimizationMode("VERIFICATION_EVIDENCE_REUSE")).toBe("OFF");
  });
});

describe("FG-12F estimateVerifierReuseBenefit (spec §4/§8)", () => {
  it("no trusted samples -> unavailable estimate with NO_DATA confidence", () => {
    const estimate = estimateVerifierReuseBenefit({ priorElapsedMsSamples: [] });
    expect(estimate.costHistorySource).toBe("unavailable");
    expect(estimate.estimatedFreshMs).toBeUndefined();
    expect(estimate.expectedNetBenefitMs).toBeUndefined();
    expect(estimate.confidence).toBe("NO_DATA");
    expect(estimate.sampleCount).toBe(0);
  });

  it("a single prior successful sample is usable at SINGLE_SAMPLE confidence (spec §8)", () => {
    const estimate = estimateVerifierReuseBenefit({ priorElapsedMsSamples: [400] });
    expect(estimate.estimatedFreshMs).toBe(400);
    expect(estimate.confidence).toBe("SINGLE_SAMPLE");
    expect(estimate.sampleCount).toBe(1);
    expect(estimate.expectedNetBenefitMs).toBe(400 - FG12F_VERIFICATION_REUSE_COST_POLICY.estimatedReuseOverheadMs);
  });

  it("uses the median of the most-recent window as a stable conservative statistic", () => {
    // 6 samples, window 5: the oldest (100) is dropped; median of [450, 500, 480, 460, 470] = 470.
    const estimate = estimateVerifierReuseBenefit({ priorElapsedMsSamples: [100, 450, 500, 480, 460, 470] });
    expect(estimate.sampleCount).toBe(5);
    expect(estimate.estimatedFreshMs).toBe(470);
    expect(estimate.confidence).toBe("MULTI_SAMPLE");
  });

  it("ignores non-finite and negative durations as untrusted samples", () => {
    const estimate = estimateVerifierReuseBenefit({ priorElapsedMsSamples: [Number.NaN, -5, 300] });
    expect(estimate.estimatedFreshMs).toBe(300);
    expect(estimate.sampleCount).toBe(1);
  });
});

describe("FG-12F cost eligibility boundary (spec §24)", () => {
  it("inclusive semantics: 249 ms is NOT eligible, exactly 250 ms IS eligible, 251 ms IS eligible", () => {
    expect(isVerifierReuseCostEligible(estimateVerifierReuseBenefit({ priorElapsedMsSamples: [249] }))).toBe(false);
    expect(isVerifierReuseCostEligible(estimateVerifierReuseBenefit({ priorElapsedMsSamples: [250] }))).toBe(true);
    expect(isVerifierReuseCostEligible(estimateVerifierReuseBenefit({ priorElapsedMsSamples: [251] }))).toBe(true);
  });

  it("unknown cost is never eligible — reuse is never justified by 'probably expensive' (spec §6)", () => {
    expect(isVerifierReuseCostEligible(estimateVerifierReuseBenefit({ priorElapsedMsSamples: [] }))).toBe(false);
  });

  it("an even-count median below the threshold keeps cheap verifiers fresh (spec §20)", () => {
    expect(isVerifierReuseCostEligible(estimateVerifierReuseBenefit({ priorElapsedMsSamples: [80, 82] }))).toBe(false);
  });
});

describe("FG-12F cost-gate-aware decision derivation", () => {
  const validCandidate = { evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p1", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: true };

  it("ACTIVE_SAFE + valid + cost-eligible -> APPLIED", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: undefined, sustainabilityReceiptId: undefined,
      candidates: [validCandidate],
      costGate: { costEligibleEvidenceIds: ["ev-1"], costRejectedEvidenceIds: [] },
    });
    expect(decision.status).toBe("APPLIED");
    expect(decision.expectedEffect.avoidedVerificationReruns).toBe(1);
  });

  it("ACTIVE_SAFE + valid but cost-rejected -> REJECTED, never APPLIED (the gate can veto, not authorize)", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: undefined, sustainabilityReceiptId: undefined,
      candidates: [validCandidate],
      costGate: { costEligibleEvidenceIds: [], costRejectedEvidenceIds: ["ev-1"] },
    });
    expect(decision.status).toBe("REJECTED");
    expect(decision.statusReasonCodes).toContain("FG12F_COST_GATE_HELD_EVIDENCE_FRESH");
    expect(decision.expectedEffect.avoidedVerificationReruns).toBeUndefined();
  });

  it("mixed cost outcomes -> APPLIED for the eligible subset with the rejection recorded in reason codes", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: undefined, sustainabilityReceiptId: undefined,
      candidates: [validCandidate, { ...validCandidate, evidenceId: "ev-2" }],
      costGate: { costEligibleEvidenceIds: ["ev-1"], costRejectedEvidenceIds: ["ev-2"] },
    });
    expect(decision.status).toBe("APPLIED");
    expect(decision.statusReasonCodes).toContain("FG12F_COST_GATE_HELD_EVIDENCE_FRESH");
    expect(decision.expectedEffect.avoidedVerificationReruns).toBe(1);
  });

  it("a cost rejection can never raise a SHADOW decision to APPLIED (MODE_STATUS_MISMATCH guard intact)", () => {
    process.env.CODEFORGE_FORGEGREEN_OPTIMIZATION = "SHADOW";
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: undefined, sustainabilityReceiptId: undefined,
      candidates: [validCandidate],
      costGate: { costEligibleEvidenceIds: ["ev-1"], costRejectedEvidenceIds: [] },
    });
    expect(decision.mode).toBe("SHADOW");
    expect(decision.status).toBe("PROPOSED");
  });

  it("without a costGate parameter the FG-11 semantics are preserved (all valid candidates eligible)", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: undefined, sustainabilityReceiptId: undefined,
      candidates: [validCandidate],
    });
    expect(decision.status).toBe("APPLIED");
  });
});
