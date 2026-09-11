import { describe, expect, it } from "vitest";
import {
  checkCrossReceiptIntegrity,
  createSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", taskId: "task-1", namespace: "ws-1", ...overrides };
}

describe("FG-8R live routing/financial wiring (closes gap #1)", () => {
  it("derives financial classification from the LIVE FreeModelRecord when no FinancialReceipt is supplied (the real production path)", () => {
    const identity = id();
    const check = checkCrossReceiptIntegrity(identity, undefined, undefined, {
      freeModelRecord: {
        providerId: "openrouter", modelId: "glm-4.6", accessClass: "VERIFIED_FREE", freeStatus: "verified_free",
        costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "openrouter-live" },
      },
    });
    expect(check.financialClassification).toBe("free");
    expect(check.financialClassificationSource).toBe("live_free_model_record");
    expect(check.liveModelProviderId).toBe("openrouter");
    expect(check.liveModelModelId).toBe("glm-4.6");
    expect(check.liveModelAccessClass).toBe("VERIFIED_FREE");
    expect(check.consistent).toBe(true);
  });

  it("a live paid model is never silently classified free", () => {
    const check = checkCrossReceiptIntegrity(id(), undefined, undefined, {
      freeModelRecord: { providerId: "anthropic", modelId: "claude", costProfile: { isFree: false, paidFallbackPossible: true, paidFallbackDisabled: false, source: "catalog" } },
    });
    expect(check.financialClassification).toBe("paid");
    expect(check.financialClassificationSource).toBe("live_free_model_record");
  });

  it("an explicit FinancialReceipt still takes precedence over the live FreeModelRecord when both are supplied (never a silent override of the richer authority)", () => {
    const check = checkCrossReceiptIntegrity(
      id(),
      undefined,
      { receiptId: "fin-1", taskId: "task-1", pricingEvidence: { isFree: true } },
      { freeModelRecord: { providerId: "x", modelId: "y", costProfile: { isFree: false, paidFallbackPossible: false, paidFallbackDisabled: false, source: "s" } } },
    );
    expect(check.financialClassification).toBe("free");
    expect(check.financialClassificationSource).toBe("financial_receipt");
  });

  it("no live signal and no receipt -> unknown/unavailable, never a guessed classification", () => {
    const check = checkCrossReceiptIntegrity(id(), undefined, undefined, undefined);
    expect(check.financialClassification).toBe("unknown");
    expect(check.financialClassificationSource).toBe("unavailable");
    expect(check.checked).toBe(false);
    expect(check.decisionReceiptIds).toEqual([]);
  });

  it("cross-checks the live FreeModelRecord against the MOST RECENT persisted DecisionReceipt for this run", () => {
    const check = checkCrossReceiptIntegrity(id(), undefined, undefined, {
      freeModelRecord: { providerId: "openrouter", modelId: "glm-4.6", costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" } },
      decisionReceipts: [
        { receiptId: "d1", runId: "run-1", action: "rotate", selected: { providerId: "openrouter", modelId: "old-model" }, createdAt: "2026-01-01T00:00:00.000Z" },
        { receiptId: "d2", runId: "run-1", action: "rotate", selected: { providerId: "openrouter", modelId: "glm-4.6" }, createdAt: "2026-01-01T00:05:00.000Z" },
      ],
    });
    // The latest decision receipt (d2) agrees with the live model -> consistent.
    expect(check.consistent).toBe(true);
    expect(check.decisionReceiptIds).toEqual(["d1", "d2"]);
  });

  it("surfaces a genuine disagreement between the live model and the latest DecisionReceipt as an integrity failure, never silently reconciled", () => {
    const identity = id();
    const check = checkCrossReceiptIntegrity(identity, undefined, undefined, {
      freeModelRecord: { providerId: "openrouter", modelId: "glm-4.6", costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" } },
      decisionReceipts: [
        { receiptId: "d1", runId: "run-1", action: "rotate", selected: { providerId: "openrouter", modelId: "some-other-model" }, createdAt: "2026-01-01T00:05:00.000Z" },
      ],
    });
    expect(check.consistent).toBe(false);
    expect(check.mismatches).toContain("LIVE_DECISION_RECEIPT_MODEL_MISMATCH");

    // And the full receipt reflects this as incomplete measurement, never a silent pass.
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({
      identity, normalized,
      live: {
        freeModelRecord: { providerId: "openrouter", modelId: "glm-4.6", costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" } },
        decisionReceipts: [{ receiptId: "d1", runId: "run-1", action: "rotate", selected: { providerId: "openrouter", modelId: "some-other-model" }, createdAt: "2026-01-01T00:05:00.000Z" }],
      },
    });
    expect(receipt.measurementStatus).toBe("incomplete");
    expect(receipt.measurementFailureReasonCodes).toContain("LIVE_DECISION_RECEIPT_MODEL_MISMATCH");
    // FG-8 never overrides: it still reports the live classification it observed, unchanged.
    expect(receipt.crossReceiptIntegrity.financialClassification).toBe("free");
  });

  it("an empty decisionReceipts array (the common case: no rotation happened this run) never triggers a false mismatch", () => {
    const check = checkCrossReceiptIntegrity(id(), undefined, undefined, {
      freeModelRecord: { providerId: "openrouter", modelId: "glm-4.6", costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" } },
      decisionReceipts: [],
    });
    expect(check.consistent).toBe(true);
    expect(check.mismatches).toEqual([]);
  });
});
