import { describe, expect, it } from "vitest";
import {
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8 sustainability receipt — accounting scenarios", () => {
  it("[1] single successful model request: tokens/requestCount provider-reported, no waste, no baselines", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 500, outputTokens: 200, requestCount: 1, provider: "openrouter", model: "m1" },
      toolExecutions: [{ success: true, readOnly: true, durationMs: 40 }],
      wallClockMs: 900,
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(receipt.measurementStatus).toBe("complete");
    expect(receipt.tokenAccounting.totalTokens).toBe(700);
    expect(receipt.tokenAccounting.coverage).toBe("provider_reported");
    expect(receipt.toolAccounting.toolCallCount).toBe(1);
    expect(receipt.finalized).toBe(false);
  });

  it("[2] multi-turn run: token counts accumulate across a caller-summed usage total", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 4200, outputTokens: 1800, requestCount: 5, provider: "openrouter", model: "m1" },
      toolExecutions: Array.from({ length: 7 }, () => ({ success: true, readOnly: true, durationMs: 30 })),
      wallClockMs: 12000,
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(receipt.tokenAccounting.requestCount).toBe(5);
    expect(receipt.toolAccounting.toolCallCount).toBe(7);
  });

  it("[3] tool-heavy run: tool accounting is directly measured and dominates", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 300, outputTokens: 100, requestCount: 1 },
      toolExecutions: Array.from({ length: 20 }, (_, i) => ({ success: i % 5 !== 0, readOnly: i % 2 === 0, durationMs: 15 })),
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(receipt.toolAccounting.toolCallCount).toBe(20);
    expect(receipt.toolAccounting.toolFailureCount).toBe(4);
    expect(receipt.toolAccounting.coverage).toBe("directly_measured");
    const failedWaste = receipt.wasteBreakdown.find((w) => w.category === "failed_attempt_waste");
    expect(failedWaste?.quantity).toBe(4);
  });

  it("[4] verification-heavy run: verification counters derive from ledger totals, not tool/usage data", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      ledgerRecord: {
        ledgerSchemaVersion: "v1",
        ledgerId: "ledger-1",
        identity: { runId: "run-1", operation: "agent_run", namespace: "ws-1" },
        events: [],
        totals: {
          bytesAvoidedMeasured: 0, tokensAvoidedMeasured: 0, eventsWithUnknownQuantity: 0,
          duplicateActionsSuppressed: 0, noProgressInterruptions: 0, canonicalCacheHits: 0,
          canonicalCacheMisses: 0, canonicalCacheInvalidations: 0, avoidedModelRequests: 0,
          avoidedToolDispatches: 0, fallbackEvents: 0, repositoryFilesReparsed: 0,
          repositoryFilesReused: 0, repositoryParseCacheHits: 0, repositoryInvalidations: 0,
          modelFailoverRotations: 0, modelFailoverBlockedDispatches: 0, contextPagesReused: 0,
          contextPagesPulled: 0, riskAnalyses: 0, riskCacheHits: 0, riskCacheMisses: 0,
          riskRoleEscalations: 0, riskContextExpansions: 0, verificationObligationsGenerated: 5,
          verificationCacheHits: 0, verificationEvidenceReused: 0, verificationTargetedSuitesUsed: 3,
          verificationFullSuitesAvoided: 1, verificationFullSuitesRequired: 1,
          verificationStaleEvidenceRejected: 0, verificationRerunsAvoided: 0,
          verificationBlockedEvents: 0, resolutionObligationsReceived: 0,
          resolutionDuplicatesRemoved: 0, resolutionObligationsSubsumed: 0,
          resolutionEvidenceReused: 0, resolutionProducersScheduled: 0,
          resolutionDispatchesAvoided: 0, resolutionCacheHits: 0, resolutionCacheMisses: 0,
        },
        policyVersion: "p1",
        featureVersion: "f1",
        createdAt: new Date().toISOString(),
      },
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(receipt.verificationAccounting.obligationsGenerated).toBe(5);
    expect(receipt.verificationAccounting.coverage).toBe("derived_from_authoritative_telemetry");
    const overhead = receipt.wasteBreakdown.find((w) => w.category === "verification_overhead");
    expect(overhead?.quantity).toBe(5);
    const baselineD = receipt.baselines.find((b) => b.baselineKind === "D_VERIFICATION_OVERHEAD_COMPARISON");
    expect(baselineD).toBeDefined();
    expect(baselineD?.numerator).toBeUndefined();
  });

  it("[6] model fallback: routing accounting and retry_overhead waste reflect fallbackEvents", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 800, outputTokens: 300, requestCount: 3 },
      ledgerRecord: undefined,
    });
    // Directly construct routing fields since ledgerRecord is the only normalization source for them.
    const withRouting = { ...normalized, routing: { ...normalized.routing, fallbackEvents: 2, modelFailoverRotations: 2, coverage: "derived_from_authoritative_telemetry" as const } };
    const receipt = createSustainabilityReceipt({ identity, normalized: withRouting });
    const retryWaste = receipt.wasteBreakdown.find((w) => w.category === "retry_overhead");
    expect(retryWaste?.quantity).toBe(2);
  });

  it("[7] provider fallback: modelFailoverBlockedDispatches feeds routing_overhead and Baseline C", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { requestCount: 4 } });
    const withRouting = { ...normalized, routing: { ...normalized.routing, modelFailoverBlockedDispatches: 3, coverage: "derived_from_authoritative_telemetry" as const } };
    const receipt = createSustainabilityReceipt({ identity, normalized: withRouting });
    const routingWaste = receipt.wasteBreakdown.find((w) => w.category === "routing_overhead");
    expect(routingWaste?.quantity).toBe(3);
    const baselineC = receipt.baselines.find((b) => b.baselineKind === "C_NAIVE_SEQUENTIAL_RETRY");
    expect(baselineC?.numerator).toBe(3);
    expect(baselineC?.denominator).toBe(7);
  });

  it("[9] cache usage: cachedInputTokens/cacheWriteTokens pass through when the provider reports them", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 1000, outputTokens: 400, cachedTokens: 600, cacheWriteTokens: 200, requestCount: 1 },
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(receipt.tokenAccounting.cachedInputTokens).toBe(600);
    expect(receipt.tokenAccounting.cacheWriteTokens).toBe(200);
  });

  it("[10] context expansion: contextPagesPulled surfaces distinctly from contextPagesReused", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity });
    const withContext = { ...normalized, context: { ...normalized.context, contextPagesReused: 4, contextPagesPulled: 9, coverage: "derived_from_authoritative_telemetry" as const } };
    const receipt = createSustainabilityReceipt({ identity, normalized: withContext });
    expect(receipt.contextAccounting.contextPagesReused).toBe(4);
    expect(receipt.contextAccounting.contextPagesPulled).toBe(9);
  });

  it("finalize sets an immutable, timestamped receipt", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    const finalized = finalizeSustainabilityReceipt(receipt);
    expect(finalized.finalized).toBe(true);
    expect(finalized.finalizedAt).toBeDefined();
  });
});
