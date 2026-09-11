import { describe, expect, it } from "vitest";
import {
  detectDuplicateContextPageTransmission,
  detectOptionalPrefetchSuppression,
  detectReusableVerificationEvidence,
  resolveOptimizationMode,
} from "../src/index.js";

describe("FG-9 shadow mode (§30 items 20-22)", () => {
  it("[20] shadow-mode detection identifies a candidate but never alters anything — the detector functions are pure and return only a decision record, never an executable action", () => {
    expect(resolveOptimizationMode("OPTIONAL_PREFETCH_SUPPRESSION")).toBe("SHADOW");
    const input = { pageId: "opt-1", required: false, alreadyValidlyAvailable: true };
    const decision = detectOptionalPrefetchSuppression({ runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined, candidates: [input] });
    // The candidate object itself is untouched — no mutation, no side effect.
    expect(input).toEqual({ pageId: "opt-1", required: false, alreadyValidlyAvailable: true });
    expect(decision.status).toBe("PROPOSED");
    expect(decision.mode).toBe("SHADOW");
    // A PROPOSED decision carries expected, not measured, effect — never claims a real outcome.
    expect(decision.expectedEffect.avoidedToolExecutions).toBe(1);
  });

  it("[21] a shadow decision's expectedEffect is structurally distinct from a 'measured' resource delta — comparing candidate recommendation against actual execution requires a SEPARATE, explicitly measured receipt, never the expectation itself relabeled", () => {
    const decision = detectReusableVerificationEvidence({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      candidates: [{ evidenceId: "ev-1", workspaceContentHash: "h1", policyRevision: "p1", command: "npm test", dependencyStateHash: "d1", forgeVerifyConfirmedValid: true }],
    });
    expect(decision.status).toBe("PROPOSED");
    // The decision type has no field claiming a measured outcome — only expectedEffect/confidence.
    expect(Object.keys(decision)).not.toContain("measuredEffect");
    expect(Object.keys(decision)).not.toContain("actualEffect");
  });

  it("[22] false-positive candidates are individually measurable: an evidence set mixing valid and invalidated occurrences reports exactly the valid subset, so the false-positive rate (invalidated / total considered) is reconstructable", () => {
    const decision = detectDuplicateContextPageTransmission({
      runId: "r1", sessionId: "s1", sustainabilityReceiptId: undefined,
      events: [
        { pageId: "p1", contentHash: "h1", workspaceRevision: 1, turnIndex: 0 },
        { pageId: "p1", contentHash: "h1", workspaceRevision: 1, turnIndex: 1 }, // valid duplicate
        { pageId: "p2", contentHash: "h2", workspaceRevision: 1, turnIndex: 0 },
        { pageId: "p2", contentHash: "h2-CHANGED", workspaceRevision: 1, turnIndex: 1 }, // false positive: content changed
      ],
    });
    // Exactly 1 genuine candidate out of 2 pages considered -> a 50% false-positive rate is
    // reconstructable by the caller (2 pages had a repeat transmission; only 1 was valid).
    expect(decision.sourceEvidenceIds).toHaveLength(1);
  });
});
