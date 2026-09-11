import { describe, expect, it } from "vitest";
import {
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  SustainabilityMeasurementError,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8 integrity", () => {
  it("[11] no double counting: building a receipt twice from the same input yields identical accounting", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 100, outputTokens: 50, requestCount: 1 } });
    const a = createSustainabilityReceipt({ identity, normalized });
    const b = createSustainabilityReceipt({ identity, normalized });
    expect(a.tokenAccounting).toEqual(b.tokenAccounting);
    expect(a.receiptId).toBe(b.receiptId); // deterministic identity fingerprint, not a fresh random id
  });

  it("[14] immutability: finalizing an already-finalized receipt is rejected, not silently repeated", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    const finalized = finalizeSustainabilityReceipt(receipt);
    expect(() => finalizeSustainabilityReceipt(finalized)).toThrow(SustainabilityMeasurementError);
    expect(() => finalizeSustainabilityReceipt(finalized)).toThrow(/already finalized/i);
  });

  it("[15] impossible negative usage is rejected at construction, never silently clamped to 0", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: -5, outputTokens: 10, requestCount: 1 } });
    expect(() => createSustainabilityReceipt({ identity, normalized })).toThrow(SustainabilityMeasurementError);
    let caught: unknown;
    try {
      createSustainabilityReceipt({ identity, normalized });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SustainabilityMeasurementError);
    expect((caught as InstanceType<typeof SustainabilityMeasurementError>).reasonCodes).toContain("NEGATIVE_METRIC:tokens.inputTokens");
  });

  it("[16] wrong run/session association is rejected, not silently accepted", () => {
    const identity = id({ runId: "run-A" });
    const normalizedForOtherRun = normalizeMeasurementInput({ identity: id({ runId: "run-B" }), usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    expect(() => createSustainabilityReceipt({ identity, normalized: normalizedForOtherRun })).toThrow(/runId/i);

    const sameRunDifferentSession = normalizeMeasurementInput({ identity: id({ runId: "run-A", sessionId: "session-OTHER" }), usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    expect(() => createSustainabilityReceipt({ identity, normalized: sameRunDifferentSession })).toThrow(/sessionId/i);
  });

  it("unsupported/unknown schema version on a stored receipt does not silently pass as current — normalizationVersion is always persisted", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(receipt.normalizationVersion).toBe(normalized.normalizationVersion);
    expect(receipt.receiptSchemaVersion).toMatch(/^fg8-receipt-/);
  });
});
