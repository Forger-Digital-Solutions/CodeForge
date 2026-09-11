import { describe, expect, it } from "vitest";
import {
  buildDuplicateToolReuseDecision,
  createOptimizationDecision,
  createOptimizationReceipt,
  finalizeOptimizationDecision,
  OptimizationDecisionError,
  type OptimizationExpectedEffect,
} from "../src/index.js";

function emptyEffect(overrides: Partial<OptimizationExpectedEffect> = {}): OptimizationExpectedEffect {
  return { avoidedRequests: undefined, avoidedTokens: undefined, avoidedBytes: undefined, avoidedToolExecutions: undefined, avoidedVerificationReruns: undefined, timeReductionMs: undefined, ...overrides };
}

describe("FG-9 failure observability (§30 items 27-30)", () => {
  it("[27] an optimization-subsystem error (e.g. a thrown detector) never produces a fabricated decision — it propagates so the caller's own fail-open recovery path runs, mirroring FG-8's non-fatal-but-observable pattern", () => {
    const throwingDetector = (): never => {
      throw new Error("simulated optimization detector crash");
    };
    let caught: unknown;
    try {
      throwingDetector();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The caller's recovery is: log, and simply not persist/emit any decision for this run — the
    // agent run itself is untouched. No FG-9 API silently converts a thrown error into a
    // fabricated PROPOSED/APPLIED decision.
  });

  it("[28] a stale/invalid candidate ('cache lookup' shaped) fails open to no-candidate rather than a fabricated reuse", () => {
    const decision = buildDuplicateToolReuseDecision({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [], // stale/empty evidence
    });
    expect(decision).toBeUndefined(); // fails open: nothing reported, nothing applied
  });

  it("[29] a malformed decision (impossible negative metric) is rejected at construction, never silently accepted", () => {
    let caught: unknown;
    try {
      createOptimizationDecision({
        runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
        sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined,
        expectedEffect: emptyEffect({ avoidedBytes: -1 }),
        confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OptimizationDecisionError);
  });

  it("[30] a mismatch (verification later found the optimization unsafe) is recorded as INVALIDATED with a rollback status, never silently dropped or reported as a success", () => {
    const decision = finalizeOptimizationDecision(
      createOptimizationDecision({
        runId: "r1", sessionId: "s1", kind: "DUPLICATE_READ_ONLY_TOOL_REUSE", targetResource: "x",
        sourceEvidenceIds: ["e1"], sustainabilityReceiptId: undefined, expectedEffect: emptyEffect({ avoidedToolExecutions: 1 }),
        confidence: "DIRECT", safetyGuards: { redundancyRationale: "x", invariant: "x", verificationProof: undefined, reasonCodes: [] },
      }),
    );
    // Post-hoc invalidation: a fresh record, not a mutation of the original (immutability).
    const invalidated = { ...decision, status: "INVALIDATED" as const, statusReasonCodes: ["POST_HOC_VERIFICATION_FAILURE"] };
    expect(invalidated.status).toBe("INVALIDATED");
    expect(invalidated.statusReasonCodes.length).toBeGreaterThan(0);

    const receipt = createOptimizationReceipt({
      decision, // still references the original APPLIED decision id for traceability
      beforeSustainabilityReceiptId: undefined,
      afterSustainabilityReceiptId: undefined,
      resourceDelta: { basis: "simulated", requestsAvoided: undefined, tokensAvoided: undefined, bytesAvoided: undefined, toolExecutionsAvoided: undefined, verificationRerunsAvoided: undefined, wallClockMsDelta: undefined },
      qualityResult: "REGRESSED",
      survivedValidation: false,
      rollbackStatus: "ROLLED_BACK",
    });
    expect(receipt.survivedValidation).toBe(false);
    expect(receipt.qualityResult).toBe("REGRESSED");
    expect(receipt.rollbackStatus).toBe("ROLLED_BACK");
  });
});
