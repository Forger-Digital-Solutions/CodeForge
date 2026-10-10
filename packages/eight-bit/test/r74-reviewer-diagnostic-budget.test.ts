import { describe, expect, it } from "vitest";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ChatRequest, StreamEvent } from "@codeforge/providers";
import { REVIEWER_CASES, REVIEWER_PROTOCOL } from "../src/qualification/role-protocols.js";
import { runRoleOnlyQualification } from "../src/qualification/role-suite.js";

const model = createGenericFreeRecord({ providerId: "scripted", modelId: "review-budget", displayName: "Review budget" });
const response = (approved: boolean): StreamEvent => ({ type: "text_delta", delta: JSON.stringify({ verdict: approved ? "pass" : "revision_required", summary: "Reviewed current evidence", findings: approved ? [] : [{ id: "defect", severity: "blocking", category: "correctness", message: "calc.ts multiply, catch swallow, reserve release leak, test assertion, retry.mjs maxAttempts", evidence: "Current code violates its contract" }] }) });

describe("R74 Reviewer diagnostic budget", () => {
  it("does not replay unchanged semantic failures or change V4 acceptance", async () => {
    const requests: ChatRequest[] = [];
    const adapter = { providerId: "scripted", isTestProvider: true, async *streamChat(request: ChatRequest) {
      requests.push(request);
      yield response(true);
      yield { type: "finish", finishReason: "stop" } as StreamEvent;
    } };
    const receipt = await runRoleOnlyQualification(model, adapter, { roles: ["REVIEWER"] });
    expect(requests).toHaveLength(8);
    expect(REVIEWER_PROTOCOL.version).toBe("REVIEWER_PROTOCOL_V4");
    expect(REVIEWER_PROTOCOL.acceptance).toBe(0.75);
    expect(receipt.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
    expect(receipt.roleResults.REVIEWER?.hardFailures).toEqual(["reviewer.one_bug", "reviewer.boundary_regression"]);
    expect(receipt.roleResults.REVIEWER?.testCases.every(caze => caze.retries === 0)).toBe(true);
  });

  it.each(["provider HTTP 503 outage", "R41_BOUND: request budget exhausted"])("retains an observed critical failure through %s", async message => {
    let calls = 0;
    const adapter = { providerId: "scripted", isTestProvider: true, async *streamChat(_request: ChatRequest) {
      calls++;
      if (calls === 1) { yield response(true); yield { type: "finish", finishReason: "stop" } as StreamEvent; }
      else throw new Error(message);
    } };
    const receipt = await runRoleOnlyQualification(model, adapter, { roles: ["REVIEWER"] });
    expect(calls).toBe(2);
    expect(receipt.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
    expect(receipt.roleResults.REVIEWER?.hardFailures).toEqual(["reviewer.one_bug"]);
    expect(receipt.hardFailureRoles).toEqual(["REVIEWER"]);
    expect(receipt.qualificationState).toBe("HARD_FAILURE");
    expect(receipt.metadata).toMatchObject({ transient: true, requests: 2 });
  });

  it("keeps an interrupted otherwise correct review inconclusive", async () => {
    let calls = 0;
    const adapter = { providerId: "scripted", isTestProvider: true, async *streamChat(request: ChatRequest) {
      calls++;
      if (calls === 3) throw new Error("provider HTTP 503 outage");
      const content = request.messages.map(message => message.content).join("\n");
      const caze = REVIEWER_CASES.find(candidate => content.includes(candidate.intent))!;
      yield response(caze.expectApproved);
      yield { type: "finish", finishReason: "stop" } as StreamEvent;
    } };
    const receipt = await runRoleOnlyQualification(model, adapter, { roles: ["REVIEWER"] });
    expect(receipt.roleResults.REVIEWER?.status).toBe("NOT_TESTED");
    expect(receipt.hardFailureRoles).toEqual([]);
    expect(receipt.qualificationState).toBe("NOT_QUALIFIED");
  });
});
