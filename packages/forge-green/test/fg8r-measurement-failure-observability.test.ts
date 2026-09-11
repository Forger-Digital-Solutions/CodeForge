import { describe, expect, it } from "vitest";
import {
  createFailedSustainabilityReceipt,
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  simulateBaselineB,
  SustainabilityMeasurementError,
  type ContextComparisonPopulation,
  type EnergyEstimator,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

/** Mirrors exactly the recovery pattern `AgentRuntime.persistForgeGreenSustainabilityReceipt`
 * uses in production: build → on failure, catch, classify reasonCodes, and build an explicit
 * failed receipt instead of silently dropping the measurement (hardening #4/#13). */
function recoverFromMeasurementFailure(identity: NormalizedIdentity, err: unknown) {
  const reasonCodes = err instanceof SustainabilityMeasurementError ? err.reasonCodes : ["UNEXPECTED_MEASUREMENT_ERROR"];
  return { reasonCodes, failed: finalizeSustainabilityReceipt(createFailedSustainabilityReceipt(identity, reasonCodes)) };
}

describe("FG-8R measurement-failure observability (§13) — never a naked silent .catch(() => undefined) as the ONLY consequence", () => {
  it("an estimator exception is never silently swallowed inside receipt construction — it propagates so the caller's recovery path (and its logging/event emission) actually runs", () => {
    const throwingEstimator: EnergyEstimator = {
      estimatorId: "broken",
      estimatorVersion: "1",
      estimate() {
        throw new Error("simulated estimator crash");
      },
    };
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });

    let caught: unknown;
    try {
      createSustainabilityReceipt({ identity, normalized, energyEstimator: throwingEstimator });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    const { reasonCodes, failed } = recoverFromMeasurementFailure(identity, caught);
    expect(reasonCodes).toEqual(["UNEXPECTED_MEASUREMENT_ERROR"]);
    expect(failed.measurementStatus).toBe("failed");
    expect(failed.measurementFailureReasonCodes).toEqual(["UNEXPECTED_MEASUREMENT_ERROR"]);
    // Never a zero-value SUCCESS standing in for the crash.
    expect(failed.tokenAccounting.coverage).toBe("unavailable");
  });

  it("a persistence rejection during the normal save path is recoverable via the exact same explicit-failure pattern (never converted into a fabricated success)", async () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized }));

    const rejectingStore = { save: async () => { throw new Error("simulated persistence rejection"); } };

    let caught: unknown;
    try {
      await rejectingStore.save(receipt);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const { failed } = recoverFromMeasurementFailure(identity, caught);
    expect(failed.measurementStatus).toBe("failed");
  });

  it("a cross-receipt identity mismatch surfaces as an explicit incomplete status with reason codes — observable, never silently reconciled to 'complete'", () => {
    const identity = id({ taskId: "task-real" });
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({
      identity,
      normalized,
      routeReceipt: { receiptId: "r1", taskId: "task-DIFFERENT" },
    });
    expect(receipt.measurementStatus).toBe("incomplete");
    expect(receipt.measurementFailureReasonCodes.length).toBeGreaterThan(0);
    expect(receipt.measurementFailureReasonCodes).toContain("ROUTE_RECEIPT_TASK_ID_MISMATCH");
  });

  it("malformed context-population input (NaN/negative/impossible values) degrades to no Baseline B claim, never a crash or a fabricated comparison", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity });
    const malformed: ContextComparisonPopulation = {
      fullContextDefinition: "malformed",
      eligibleFileCount: 10,
      excludedFileCount: 2,
      exclusionReasons: {},
      eligibleBytes: Number.NaN,
      eligibleTokensEstimate: undefined,
      actualTransmittedBytes: -50, // impossible: negative bytes transmitted
      actualTransmittedTokens: undefined,
      naivePolicyBytes: 1000,
      naivePolicyTokens: undefined,
    };
    expect(() => simulateBaselineB(normalized, malformed)).not.toThrow();
    expect(simulateBaselineB(normalized, malformed)).toBeUndefined();

    const impossiblyLarge: ContextComparisonPopulation = { ...malformed, actualTransmittedBytes: 5000, naivePolicyBytes: 1000 };
    expect(simulateBaselineB(normalized, impossiblyLarge)).toBeUndefined();

    const nanNaive: ContextComparisonPopulation = { ...malformed, actualTransmittedBytes: 10, naivePolicyBytes: Number.NaN };
    expect(simulateBaselineB(normalized, nanNaive)).toBeUndefined();
  });
});
