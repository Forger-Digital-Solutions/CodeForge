import { describe, expect, it } from "vitest";
import {
  checkCrossReceiptIntegrity,
  createSustainabilityReceipt,
  finalizeSustainabilityReceipt,
  normalizeMeasurementInput,
  type NormalizedIdentity,
} from "../src/index.js";

function id(overrides: Partial<NormalizedIdentity> = {}): NormalizedIdentity {
  return { runId: "run-1", sessionId: "session-1", namespace: "ws-1", ...overrides };
}

/** §15: prove FG-8R does NOT change ForgeAuto/8-Bit/ForgeVerify/Completion Gate authority. FG-8
 * remains observational/advisory — these are "absence of authority" structural assertions over
 * the actual receipt shape, not a claim about code we don't call. */
describe("FG-8R authority regression (§15) — FG-8 carries no routing, verification, approval, or completion authority", () => {
  it("a finalized SustainabilityReceipt carries no permission/approval/verdict/routing-decision/verification-pass field anywhere at the top level", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({
      identity,
      usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 },
    });
    const receipt = finalizeSustainabilityReceipt(
      createSustainabilityReceipt({
        identity,
        normalized,
        live: {
          freeModelRecord: { providerId: "openrouter", modelId: "m1", costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" } },
          decisionReceipts: [{ receiptId: "d1", runId: "run-1", action: "rotate", selected: { providerId: "openrouter", modelId: "m1" } }],
        },
      }),
    );
    const forbidden = /^(permission|approval|verdict|decision|routingDecision|selectedModel|selectedProvider|verificationPass|verificationResult|completion|completed|authorize|authorized|grant)$/i;
    const topLevelKeys = Object.keys(receipt);
    const offending = topLevelKeys.filter((k) => forbidden.test(k));
    expect(offending).toEqual([]);
  });

  it("checkCrossReceiptIntegrity never returns a routing/model SELECTION — only observed identity and a classification of what it saw", () => {
    const check = checkCrossReceiptIntegrity(id(), undefined, undefined, {
      freeModelRecord: { providerId: "openrouter", modelId: "m1", costProfile: { isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "s" } },
    });
    // It reports WHAT it observed (liveModelProviderId/ModelId, routeReceiptId as a mere
    // cross-reference) — it never exposes a field that represents FG-8 itself CHOOSING between
    // candidates (no "selectedX"/"chosenX"/"pickedX"-shaped field — those verbs are the
    // authority's job, not FG-8's; a plain reference id like `routeReceiptId` is fine).
    const keys = Object.keys(check);
    expect(keys.some((k) => /^(selected|chosen|picked)/i.test(k))).toBe(false);
  });

  it("a measurement failure (incomplete/failed status) never blocks or alters the receipt's own construction — FG-8 has no gate of its own to fail closed on, unlike ForgeVerify/Completion Gate", () => {
    const identity = id({ taskId: "task-real" });
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    // A mismatch produces `incomplete`, not a thrown/blocking error — it is advisory information,
    // not a gate. (Compare: ForgeVerify/Completion Gate WOULD throw/block on invalid evidence —
    // FG-8 deliberately does not have that authority.)
    const receipt = createSustainabilityReceipt({
      identity,
      normalized,
      routeReceipt: { receiptId: "r1", taskId: "WRONG" },
    });
    expect(receipt.measurementStatus).toBe("incomplete");
    expect(receipt.receiptId.length).toBeGreaterThan(0); // construction still succeeded
  });

  it("the receipt schema has no field that could satisfy or feed the Completion Gate (no 'sufficient'/'complete'-as-verdict/'pass' fields beyond the receipt's OWN measurementStatus, which is self-referential to measurement quality, not task completion)", () => {
    const identity = id();
    const normalized = normalizeMeasurementInput({ identity, usage: { inputTokens: 1, outputTokens: 1, requestCount: 1 } });
    const receipt = createSustainabilityReceipt({ identity, normalized });
    const serialized = JSON.stringify(receipt);
    // The only "status"-shaped field is measurementStatus itself (complete/incomplete/failed) —
    // confirm no OTHER top-level field name reads as a task/verification completion verdict.
    const suspiciousKeys = Object.keys(receipt).filter((k) => k !== "measurementStatus" && /status|verdict|passed|sufficient/i.test(k));
    expect(suspiciousKeys).toEqual([]);
    expect(serialized).not.toContain("\"taskComplete\"");
    expect(serialized).not.toContain("\"verificationSufficient\"");
  });
});
