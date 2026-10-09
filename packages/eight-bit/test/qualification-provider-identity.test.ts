import { describe, expect, it } from "vitest";
import { ProviderError, type ChatRequest, type StreamEvent } from "@codeforge/providers";
import { runCompactQualification, type CompactQualificationAdapter } from "../src/qualification/compact.js";
import { runRoleOnlyQualification } from "../src/qualification/role-suite.js";
import type { FreeModelRecord } from "../src/qualification/types.js";

const model: FreeModelRecord = {
  providerId: "scripted", modelId: "vendor/requested", displayName: "Measured route", freeStatus: "verified_free",
  capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: false, longContext: false },
  isRemote: true, isCloudHosted: true,
  costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "fixture" },
};

function adapter(code: string, mode: "throws" | "event", emptyFirst = false): CompactQualificationAdapter & { calls: ChatRequest[]; isTestProvider: true } {
  const calls: ChatRequest[] = [];
  return { providerId: "scripted", calls, isTestProvider: true,
    async *streamChat(request): AsyncIterable<StreamEvent> {
      calls.push(request);
      if (emptyFirst && calls.length === 1) { yield { type: "finish", finishReason: "stop" }; return; }
      if (mode === "throws") throw new ProviderError("tool dispatch identity rejected", code, true);
      yield { type: "error", code, message: "tool dispatch identity rejected", retryable: true };
    },
  };
}

describe("qualification provider identity isolation", () => {
  it.each(["MODEL_SUBSTITUTED", "SERVED_MODEL_UNVERIFIED", "MODEL_IDENTITY_MISSING"])("keeps %s inconclusive and stops compact dispatch", async code => {
    for (const mode of ["throws", "event"] as const) {
      const provider = adapter(code, mode);
      const receipt = await runCompactQualification(model, provider);
      expect(provider.calls).toHaveLength(1);
      expect(receipt.metadata).toMatchObject({ transient: true, quotaExhausted: false, providerFailureClass: "MODEL_IDENTITY", providerErrorCodes: [code] });
      expect(receipt.hardFailureRoles).toEqual([]);
      expect(Object.values(receipt.roleResults).every(result => result.status === "NOT_TESTED")).toBe(true);
      expect(receipt.qualificationState).not.toBe("QUALIFIED");
    }
  });

  it.each(["MODEL_SUBSTITUTED", "SERVED_MODEL_UNVERIFIED", "MODEL_IDENTITY_MISSING"])("stops Reviewer qualification on structured %s", async code => {
    for (const mode of ["throws", "event"] as const) {
      const provider = adapter(code, mode);
      const receipt = await runRoleOnlyQualification(model, provider, { roles: ["REVIEWER"] });
      expect(provider.calls).toHaveLength(1);
      expect(receipt.metadata).toMatchObject({ transient: true, roleTransientCases: 1, requests: 1, providerFailureClass: "MODEL_IDENTITY", providerErrorCodes: [code] });
      expect(receipt.roleResults.REVIEWER?.status).toBe("NOT_TESTED");
      expect(receipt.hardFailureRoles).toEqual([]);
    }
  });

  it("stops after the real empty-stream then substituted-model sequence", async () => {
    const provider = adapter("MODEL_SUBSTITUTED", "throws", true);
    const receipt = await runCompactQualification(model, provider);
    expect(provider.calls).toHaveLength(2);
    expect(receipt.metadata).toMatchObject({ requests: 2, transient: true });
    expect(receipt.roleResults.CODER?.testCases[0]?.retries).toBe(1);
    expect(receipt.roleResults.CODER?.testCases[1]?.error).toMatch(/^skipped:/);
    expect(receipt.roleResults.ANALYST?.testCases[0]?.error).toMatch(/^skipped:/);
  });

  it("does not infer identity failure from arbitrary error text", async () => {
    const provider = adapter("UNRELATED", "throws");
    const receipt = await runRoleOnlyQualification(model, provider, { roles: ["REVIEWER"] });
    expect(provider.calls.length).toBeGreaterThan(1);
    expect(receipt.metadata?.providerFailureClass).toBeUndefined();
    expect(receipt.metadata?.transient).toBe(false);
  });
});
