import { describe, expect, it } from "vitest";
import {
  InsufficientDataEstimator,
  ReferenceHeuristicEstimator,
  createSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8 energy estimation", () => {
  it("[20] a known estimator fixture gives a deterministic result", () => {
    const estimator = new ReferenceHeuristicEstimator();
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1000, outputTokens: 500, requestCount: 1 } });
    const receipt1 = createSustainabilityReceipt({ identity, normalized, energyEstimator: estimator });
    const receipt2 = createSustainabilityReceipt({ identity, normalized, energyEstimator: estimator });
    expect(receipt1.energyEstimate.joules).toBe(receipt2.energyEstimate.joules);
    expect(receipt1.energyEstimate.joules).toBeCloseTo(1500 * 0.002, 10);
    expect(receipt1.energyEstimate.confidence).toBe("MODELED_ESTIMATE");
    expect(receipt1.carbonEstimate.gramsCO2e).toBeGreaterThan(0);
  });

  it("[21] unknown hardware / no token data returns INSUFFICIENT_DATA rather than an invented number", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity }); // no usage at all
    const receipt = createSustainabilityReceipt({ identity, normalized, energyEstimator: new ReferenceHeuristicEstimator() });
    expect(receipt.energyEstimate.confidence).toBe("INSUFFICIENT_DATA");
    expect(receipt.energyEstimate.joules).toBeUndefined();
    expect(receipt.energyEstimate.wattHours).toBeUndefined();
    expect(receipt.energyEstimate.kilowattHours).toBeUndefined();

    const defaultReceipt = createSustainabilityReceipt({ identity, normalized });
    expect(defaultReceipt.energyEstimate.estimatorId).toBe("insufficient-data");
    expect(defaultReceipt.energyEstimate.sourceType).toBe("unavailable");
  });

  it("[22] estimated and measured fields cannot be conflated: energy/carbon carry their own sourceType, never inherit token coverage", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 100, outputTokens: 50, requestCount: 1 } }); // tokens.coverage = provider_reported
    const receipt = createSustainabilityReceipt({ identity, normalized, energyEstimator: new ReferenceHeuristicEstimator() });
    expect(receipt.tokenAccounting.coverage).toBe("provider_reported");
    expect(receipt.energyEstimate.sourceType).toBe("estimated"); // never silently promoted to "measured"/"provider_reported"
    expect(receipt.energyEstimate.confidence).not.toBe("DIRECT");
    expect(receipt.energyEstimate.confidence).not.toBe("PROVIDER_REPORTED");
  });

  it("[23] estimator methodology and version are persisted on every receipt", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized, energyEstimator: new InsufficientDataEstimator() });
    expect(receipt.energyEstimate.estimatorId).toBe("insufficient-data");
    expect(receipt.energyEstimate.estimatorVersion).toBe("1");
    expect(receipt.energyEstimate.methodology.length).toBeGreaterThan(0);
    expect(receipt.carbonEstimate.methodology.length).toBeGreaterThan(0);
  });
});
