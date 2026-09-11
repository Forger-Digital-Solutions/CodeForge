import { describe, expect, it } from "vitest";
import { createSustainabilityReceipt, finalizeSustainabilityReceipt, normalizeMeasurementInput, type NormalizedIdentity } from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

describe("FG-8 privacy", () => {
  it("[28] secret-shaped content on raw usage/tool inputs is never persisted into the receipt", () => {
    const identity = id();
    const secret = "sk-live-super-secret-token-should-never-appear";
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 10, outputTokens: 5, requestCount: 1, provider: "openrouter", model: "m1", secretApiKey: secret } as Record<string, unknown>,
      toolExecutions: [{ success: true, readOnly: true, durationMs: 5, output: `Authorization: Bearer ${secret}` } as Record<string, unknown>],
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    const finalized = finalizeSustainabilityReceipt(receipt);
    expect(JSON.stringify(finalized)).not.toContain(secret);
  });

  it("[29] prompt/source file contents are never read by normalization and never appear in the receipt", () => {
    const identity = id();
    const promptText = "Please implement a login form using the user's actual password hunter2";
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 20, outputTokens: 10, requestCount: 1 },
      toolExecutions: [{ success: true, readOnly: false, durationMs: 10, arguments: { content: promptText } } as Record<string, unknown>],
    });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    expect(JSON.stringify(receipt)).not.toContain("hunter2");
    expect(JSON.stringify(receipt)).not.toContain(promptText);
  });

  it("[30] hashes/size/id metadata remain present and usable for attribution", () => {
    const identity = id({ taskId: "task-abc" });
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 },
      routeReceipt: { receiptId: "route-xyz", taskId: "task-abc" },
      financialReceipt: { receiptId: "fin-xyz", taskId: "task-abc", pricingEvidence: { isFree: true } },
    });
    const receipt = createSustainabilityReceipt({
      identity,
      normalized,
      routeReceipt: { receiptId: "route-xyz", taskId: "task-abc" },
      financialReceipt: { receiptId: "fin-xyz", taskId: "task-abc", pricingEvidence: { isFree: true } },
      workspaceIdentityHash: "abc123hash",
    });
    expect(receipt.receiptId).toMatch(/^fg8-/);
    expect(receipt.routingAccounting.routeReceiptId).toBe("route-xyz");
    expect(receipt.routingAccounting.financialReceiptId).toBe("fin-xyz");
    expect(receipt.workspaceIdentityHash).toBe("abc123hash");
    expect(receipt.taskId).toBe("task-abc");
  });
});
