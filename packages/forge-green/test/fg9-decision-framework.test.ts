import { describe, expect, it } from "vitest";
import {
  createOptimizationDecision,
  createOptimizationReceipt,
  finalizeOptimizationDecision,
  finalizeOptimizationReceipt,
  OptimizationDecisionError,
  type OptimizationExpectedEffect,
} from "../src/index.js";

function emptyEffect(overrides: Partial<OptimizationExpectedEffect> = {}): OptimizationExpectedEffect {
  return {
    avoidedRequests: undefined,
    avoidedTokens: undefined,
    avoidedBytes: undefined,
    avoidedToolExecutions: undefined,
    avoidedVerificationReruns: undefined,
    timeReductionMs: undefined,
    ...overrides,
  };
}

describe("FG-9 optimization decision/receipt framework", () => {
  it("a SHADOW-mode kind can never carry status APPLIED — enforced by construction, not caller discipline", () => {
    expect(() =>
      createOptimizationDecision({
        runId: "r1",
        sessionId: "s1",
        kind: "OPTIONAL_PREFETCH_SUPPRESSION", // registered SHADOW
        targetResource: "x",
        sourceEvidenceIds: ["e1"],
        sustainabilityReceiptId: undefined,
        expectedEffect: emptyEffect(),
        confidence: "DIRECT",
        safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
        status: "APPLIED",
      }),
    ).toThrow(OptimizationDecisionError);
  });

  it("defaults: ACTIVE_SAFE kind with evidence -> APPLIED; SHADOW kind with evidence -> PROPOSED; no evidence -> SKIPPED_INSUFFICIENT_EVIDENCE", () => {
    const active = createOptimizationDecision({
      runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
      sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect(),
      confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
    });
    expect(active.status).toBe("APPLIED");
    expect(active.mode).toBe("ACTIVE_SAFE");

    const shadow = createOptimizationDecision({
      runId: "r1", sessionId: "s1", kind: "VERIFICATION_EVIDENCE_REUSE", targetResource: "x",
      sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect(),
      confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
    });
    expect(shadow.status).toBe("PROPOSED");
    expect(shadow.mode).toBe("SHADOW");

    const insufficient = createOptimizationDecision({
      runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
      sourceEvidenceIds: [], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect(),
      confidence: "INSUFFICIENT_DATA", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
    });
    expect(insufficient.status).toBe("SKIPPED_INSUFFICIENT_EVIDENCE");
  });

  it("impossible negative expected-effect values are rejected at construction", () => {
    let caught: unknown;
    try {
      createOptimizationDecision({
        runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
        sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined,
        expectedEffect: emptyEffect({ avoidedToolExecutions: -3 }),
        confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OptimizationDecisionError);
    expect((caught as InstanceType<typeof OptimizationDecisionError>).reasonCodes).toContain("NEGATIVE_METRIC:avoidedToolExecutions");
  });

  it("finalizing an already-finalized decision/receipt is rejected", () => {
    const decision = finalizeOptimizationDecision(
      createOptimizationDecision({
        runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
        sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect(),
        confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
      }),
    );
    expect(() => finalizeOptimizationDecision(decision)).toThrow(/already finalized/i);

    const receipt = finalizeOptimizationReceipt(
      createOptimizationReceipt({
        decision, beforeSustainabilityReceiptId: undefined, afterSustainabilityReceiptId: "recv-1",
        resourceDelta: { basis: "simulated", requestsAvoided: undefined, tokensAvoided: undefined, bytesAvoided: undefined, toolExecutionsAvoided: 1, verificationRerunsAvoided: undefined, wallClockMsDelta: undefined },
        qualityResult: "EQUIVALENT", survivedValidation: true,
      }),
    );
    expect(() => finalizeOptimizationReceipt(receipt)).toThrow(/already finalized/i);
  });

  it("a 'measured' resource delta requires BOTH before and after receipt references", () => {
    const decision = finalizeOptimizationDecision(
      createOptimizationDecision({
        runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
        sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect(),
        confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
      }),
    );
    let caught: unknown;
    try {
      createOptimizationReceipt({
        decision, beforeSustainabilityReceiptId: undefined, afterSustainabilityReceiptId: "recv-1",
        resourceDelta: { basis: "measured", requestsAvoided: undefined, tokensAvoided: undefined, bytesAvoided: undefined, toolExecutionsAvoided: 1, verificationRerunsAvoided: undefined, wallClockMsDelta: undefined },
        qualityResult: "EQUIVALENT", survivedValidation: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OptimizationDecisionError);
    expect((caught as InstanceType<typeof OptimizationDecisionError>).reasonCodes).toContain("MEASURED_BASIS_MISSING_RECEIPTS");
  });

  it("survivedValidation can only be claimed for an APPLIED decision", () => {
    const proposed = finalizeOptimizationDecision(
      createOptimizationDecision({
        runId: "r1", sessionId: "s1", kind: "VERIFICATION_EVIDENCE_REUSE", targetResource: "x",
        sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect(),
        confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
      }),
    );
    expect(proposed.status).toBe("PROPOSED");
    let caught: unknown;
    try {
      createOptimizationReceipt({
        decision: proposed, beforeSustainabilityReceiptId: undefined, afterSustainabilityReceiptId: undefined,
        resourceDelta: { basis: "projected", requestsAvoided: undefined, tokensAvoided: undefined, bytesAvoided: undefined, toolExecutionsAvoided: undefined, verificationRerunsAvoided: 1, wallClockMsDelta: undefined },
        qualityResult: "EQUIVALENT", survivedValidation: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OptimizationDecisionError);
    expect((caught as InstanceType<typeof OptimizationDecisionError>).reasonCodes).toContain("SURVIVED_VALIDATION_WITHOUT_APPLIED_DECISION");
  });
});
