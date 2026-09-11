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

describe("FG-8 financial safety", () => {
  it("[17] free route: FinancialReceipt.pricingEvidence.isFree=true is reflected as free, never recomputed independently", () => {
    const identity = id();
    const check = checkCrossReceiptIntegrity(identity, undefined, {
      receiptId: "fin-1", taskId: "task-1", providerId: "openrouter", modelId: "m1",
      pricingEvidence: { isFree: true },
    });
    expect(check.financialClassification).toBe("free");
    expect(check.consistent).toBe(true);
  });

  it("[18] paid transition is never silently classified free", () => {
    const identity = id();
    const check = checkCrossReceiptIntegrity(identity, undefined, {
      receiptId: "fin-2", taskId: "task-1", providerId: "openrouter", modelId: "m1",
      pricingEvidence: { isFree: false },
    });
    expect(check.financialClassification).toBe("paid");
  });

  it("[19] SustainabilityReceipt never carries an independent monetary/spend field — it only references FinancialReceipt by id", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 },
      financialReceipt: { receiptId: "fin-3", taskId: "task-1", providerId: "openrouter", modelId: "m1", pricingEvidence: { isFree: true } },
    });
    const receipt = createSustainabilityReceipt({
      identity,
      normalized,
      financialReceipt: { receiptId: "fin-3", taskId: "task-1", providerId: "openrouter", modelId: "m1", pricingEvidence: { isFree: true } },
    });
    expect(receipt.routingAccounting.financialReceiptId).toBe("fin-3");
    expect(receipt.crossReceiptIntegrity.financialClassification).toBe("free");
    // No spend/cost/charge/amount field anywhere at the receipt's top level — FG-8 is never the
    // authority for what was actually charged.
    const monetaryKeys = Object.keys(receipt).filter((k) => /spend|cost|charge|amount|price/i.test(k));
    expect(monetaryKeys).toEqual([]);
  });

  it("a route/financial provider mismatch is surfaced as an integrity failure, never silently reconciled", () => {
    const identity = id();
    const check = checkCrossReceiptIntegrity(
      identity,
      { receiptId: "route-1", taskId: "task-1", selectedRoute: { providerId: "openrouter", modelId: "m1" } },
      { receiptId: "fin-4", taskId: "task-1", providerId: "anthropic", modelId: "m1", pricingEvidence: { isFree: true } },
    );
    expect(check.consistent).toBe(false);
    expect(check.mismatches).toContain("ROUTE_FINANCIAL_PROVIDER_MISMATCH");
  });

  it("cross-receipt disagreement marks the receipt's measurementStatus as incomplete, never as a passing complete measurement", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({
      identity,
      normalized,
      routeReceipt: { receiptId: "route-2", taskId: "task-1", selectedRoute: { providerId: "openrouter", modelId: "m1" } },
      financialReceipt: { receiptId: "fin-5", taskId: "task-1", providerId: "anthropic", modelId: "m1", pricingEvidence: { isFree: true } },
    });
    expect(receipt.measurementStatus).toBe("incomplete");
    expect(receipt.measurementFailureReasonCodes).toContain("ROUTE_FINANCIAL_PROVIDER_MISMATCH");
  });
});
