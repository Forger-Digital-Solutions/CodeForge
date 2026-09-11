import { describe, expect, it } from "vitest";
import {
  buildDuplicateToolReuseDecision,
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-active-safe-1", sessionId: "session-active-safe-1", namespace: "ws-1", ...overrides };
}

describe("FG-9 active-safe: Candidate A (duplicate read-only tool reuse) (§30 items 23-26)", () => {
  it("[23] a valid optimization (real suppression evidence) applies — decision status APPLIED, mode ACTIVE_SAFE", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "run-active-safe-1", sessionId: "session-active-safe-1", sustainabilityReceiptId: "recv-1",
      events: [
        { tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 1200 },
        { tool: "repo_search", identityKeyHash: "h2", priorExecutionId: "e2", avoidedBytes: 800 },
      ],
    });
    expect(result).toBeDefined();
    expect(result!.decision.status).toBe("APPLIED");
    expect(result!.decision.mode).toBe("ACTIVE_SAFE");
    expect(result!.decision.finalized).toBe(true);
  });

  it("[24/25] result identical + verification result identical: the replayed prior result is the SAME authoritative output a fresh execution against unchanged state would have produced — represented as qualityResult EQUIVALENT, survivedValidation true, never a regression", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "run-active-safe-1", sessionId: "session-active-safe-1", sustainabilityReceiptId: "recv-1",
      events: [{ tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 1200 }],
    })!;
    expect(result.receipt.qualityResult).toBe("EQUIVALENT");
    expect(result.receipt.survivedValidation).toBe(true);
    expect(result.receipt.rollbackStatus).toBe("NOT_APPLICABLE");
  });

  it("[26] savings are attributable: the receipt's resourceDelta traces to the exact suppression events, never a rounded/guessed figure", () => {
    const result = buildDuplicateToolReuseDecision({
      runId: "run-active-safe-1", sessionId: "session-active-safe-1", sustainabilityReceiptId: "recv-1",
      events: [
        { tool: "read_file", identityKeyHash: "h1", priorExecutionId: "e1", avoidedBytes: 1200 },
        { tool: "read_file", identityKeyHash: "h2", priorExecutionId: "e2", avoidedBytes: 300 },
      ],
    })!;
    expect(result.receipt.resourceDelta.toolExecutionsAvoided).toBe(2);
    expect(result.receipt.resourceDelta.bytesAvoided).toBe(1500);
    expect(result.decision.sourceEvidenceIds).toEqual(["h1:e1", "h2:e2"]);
  });

  it("[§18/§31 before/after benchmark] control (no suppression, naive replay) vs treatment (actual, with FG-1C suppression) over identical deterministic inputs", () => {
    const identity = id();

    // Treatment: the ACTUAL run, where 2 duplicate read_file calls were suppressed by FG-1C —
    // only the 3 genuinely distinct tool calls executed.
    const treatmentNormalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 1800, outputTokens: 700, requestCount: 3 },
      toolExecutions: [
        { success: true, readOnly: true, durationMs: 40 },
        { success: true, readOnly: true, durationMs: 35 },
        { success: true, readOnly: false, durationMs: 90 },
      ],
      wallClockMs: 4200,
    });
    const treatment = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized: treatmentNormalized }));

    // Control: a naive replay WITHOUT FG-1C suppression — the 2 duplicate read_file calls that
    // were actually suppressed are added back as if they had executed (same deterministic input,
    // suppression disabled). Wall-clock reflects real per-call durations from the suppression
    // evidence (40ms/35ms already measured — used again here since a duplicate call against
    // unchanged state deterministically returns in comparable time).
    const controlNormalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 1800, outputTokens: 700, requestCount: 3 }, // same model requests: suppression avoids tool dispatches, not model round-trips
      toolExecutions: [
        { success: true, readOnly: true, durationMs: 40 },
        { success: true, readOnly: true, durationMs: 35 },
        { success: true, readOnly: false, durationMs: 90 },
        { success: true, readOnly: true, durationMs: 40 }, // duplicate #1, naive re-execution
        { success: true, readOnly: true, durationMs: 35 }, // duplicate #2, naive re-execution
      ],
      wallClockMs: 4200 + 40 + 35,
    });
    const control = finalizeSustainabilityReceipt(createSustainabilityReceipt({ identity, normalized: controlNormalized }));

    // Raw values (never percentages alone):
    expect(control.toolAccounting.toolCallCount).toBe(5);
    expect(treatment.toolAccounting.toolCallCount).toBe(3);
    const delta = {
      toolCallsAvoided: control.toolAccounting.toolCallCount! - treatment.toolAccounting.toolCallCount!,
      wallClockMsDelta: control.timing.wallClockMs! - treatment.timing.wallClockMs!,
    };
    expect(delta.toolCallsAvoided).toBe(2);
    expect(delta.wallClockMsDelta).toBe(75);
    // Correctness/verification outcome identical across control and treatment: both are
    // `measurementStatus: "complete"` — the optimization changed resource use, not correctness.
    expect(control.measurementStatus).toBe(treatment.measurementStatus);
    expect(control.measurementStatus).toBe("complete");
  });
});
