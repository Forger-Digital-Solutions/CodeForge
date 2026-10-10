import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamEvent } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { ModelQualificationReceiptSchema } from "../src/qualification/types.js";
import { runRoleOnlyQualification } from "../src/qualification/role-suite.js";

const model = createGenericFreeRecord({ providerId: "scripted", modelId: "review-only", displayName: "Review only" });

function adapter(mode: "correct" | "approve-everything" | "outage") {
  const requests: ChatRequest[] = [];
  return {
    providerId: "scripted", isTestProvider: true, requests,
    async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (mode === "outage") { yield { type: "error", code: "PROVIDER_ERROR", message: "provider HTTP 503 outage", retryable: true }; return; }
      const input = request.messages.map((message) => message.content).join("\n");
      const buggy = /add\(\)|Record provider failures|fast path|flaky router test/.test(input)
        || input.includes("Current content:\nexport function retryDelays(maxAttempts, baseMs) { const delays = []; for (let attempt = 0; attempt <= maxAttempts;");
      const pass = mode === "approve-everything" || !buggy;
      yield { type: "text_delta", delta: JSON.stringify({ verdict: pass ? "pass" : "revision_required", summary: "Independent change review", findings: pass ? [] : [{ id: "defect", severity: "blocking", category: "correctness", message: "calc.ts multiply; catch swallow; reserve without release; weakened test assertion; retry.mjs inclusive maxAttempts boundary", evidence: "The changed operation does not implement the intent." }] }) };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

describe("independently qualified Reviewer-only receipts", () => {
  it("measures the current Reviewer protocol without granting editing or tool roles", async () => {
    const provider = adapter("correct");
    const receipt = await runRoleOnlyQualification(model, provider, { roles: ["REVIEWER"] });
    expect(ModelQualificationReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt.qualificationState).toBe("QUALIFIED");
    expect(Object.keys(receipt.roleResults)).toEqual(["REVIEWER"]);
    expect(receipt.roleResults.REVIEWER?.testCases).toHaveLength(8);
    expect(receipt.metadata).toMatchObject({ roleOnly: true, requests: 8, transient: false });
    expect(provider.requests.every((request) => request.tools === undefined)).toBe(true);
  });

  it("cannot promote a reviewer approving known defects", async () => {
    const receipt = await runRoleOnlyQualification(model, adapter("approve-everything"), { roles: ["REVIEWER"] });
    expect(receipt.qualificationState).toBe("HARD_FAILURE");
    expect(receipt.hardFailureRoles).toEqual(["REVIEWER"]);
  });

  it("leaves upstream outages inconclusive rather than assigning competence failure", async () => {
    const receipt = await runRoleOnlyQualification(model, adapter("outage"), { roles: ["REVIEWER"] });
    expect(receipt.qualificationState).toBe("NOT_QUALIFIED");
    expect(receipt.roleResults.REVIEWER?.status).toBe("NOT_TESTED");
    expect(receipt.hardFailureRoles).toEqual([]);
    expect(receipt.metadata).toMatchObject({ transient: true, requests: 1 });
  });
});
