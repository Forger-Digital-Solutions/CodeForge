import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamEvent } from "@codeforge/providers";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { formatUntrustedData, ROLE_PROMPTS, REVIEWER_CLEAN_DIFF_INSTRUCTION } from "@codeforge/agent";
import { REVIEWER_CASES, REVIEWER_PROTOCOL, type ReviewerCase } from "../src/qualification/role-protocols.js";
import { runRoleOnlyQualification } from "../src/qualification/role-suite.js";

const model = createGenericFreeRecord({ providerId: "scripted", modelId: "boundary-reviewer", displayName: "Boundary Reviewer" });
const fixed = REVIEWER_CASES.find((caze) => caze.caseId === "reviewer.boundary_fix")!;
const buggy = REVIEWER_CASES.find((caze) => caze.caseId === "reviewer.boundary_regression")!;

function currentFiles(caze: ReviewerCase): Array<{ path: string; hash: string; bytes: number; content: string }> {
  return [...caze.workspaceSnapshot!.matchAll(/File: "([^"]+)"\nSHA-256: ([a-f0-9]{64})\nUTF-8 bytes: (\d+)\nCurrent content:\n([\s\S]*?)(?=\n\n(?:File:|Verification status:))/g)]
    .map((match) => ({ path: match[1]!, hash: match[2]!, bytes: Number(match[3]), content: match[4]! }));
}

function scripted(mode: "current" | "base" | "approve-regression") {
  const requests: ChatRequest[] = [];
  return {
    providerId: "scripted", isTestProvider: true, requests,
    async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
      requests.push(request);
      const input = request.messages.map((message) => message.content).join("\n");
      const caze = REVIEWER_CASES.find((c) => input.includes(c.workspaceSnapshot ?? `Intent: ${c.intent}\n\nDiff under review:\n${c.diff}`))!;
      const pass = mode === "base" && caze.workspaceSnapshot ? !caze.expectApproved
        : mode === "approve-regression" && caze.caseId === buggy.caseId ? true : caze.expectApproved;
      yield { type: "text_delta", delta: JSON.stringify({ verdict: pass ? "pass" : "revision_required", summary: "Independent change review", findings: pass ? [] : [{ id: "defect", severity: "blocking", category: "correctness", message: "calc.ts multiply; catch swallow; reserve without release; weakened test assertion; retry.mjs includes maxAttempts", evidence: "The proposed operation conflicts with the stated contract." }] }) };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

describe("Reviewer current-source boundary qualification", () => {
  it("keeps complete frozen file hashes and tests truthful for the correct and buggy snapshots", () => {
    for (const caze of [fixed, buggy]) {
      const files = currentFiles(caze);
      expect(files.map((file) => file.path)).toEqual(["package.json", "src/index.mjs", "src/retry.mjs", "test/retry.test.mjs"]);
      for (const file of files) {
        expect(Buffer.byteLength(file.content, "utf8"), file.path).toBe(file.bytes);
        expect(createHash("sha256").update(file.content).digest("hex"), file.path).toBe(file.hash);
      }
      expect(caze.workspaceSnapshot).toContain(`Diff under review:\n${caze.diff}`);
      expect(caze.workspaceSnapshot).toContain("ForgeVerify has not run. Test source is evidence of assertions, not test success.");
      const current = files.find((file) => file.path === "src/retry.mjs")!.content;
      const fn: unknown = runInNewContext(`${current.replace(/^export /, "")}\nretryDelays;`, {}, { timeout: 100 });
      expect(typeof fn).toBe("function");
      const retryDelays = fn as (attempts: number, baseMs: number) => number[];
      const expected = caze.expectApproved ? [[100, 200, 400], [], [7]] : [[100, 200, 400, 800], [100], [7, 14]];
      expect(Array.from(retryDelays(3, 100))).toEqual(expected[0]);
      expect(Array.from(retryDelays(0, 100))).toEqual(expected[1]);
      expect(Array.from(retryDelays(1, 7))).toEqual(expected[2]);
    }
    expect(currentFiles(fixed).find((file) => file.path === "test/retry.test.mjs")!.content)
      .toBe(currentFiles(buggy).find((file) => file.path === "test/retry.test.mjs")!.content);
  });

  it("qualifies current-source decisions using production schema and the existing untrusted-data wrapper", async () => {
    const adapter = scripted("current");
    const receipt = await runRoleOnlyQualification(model, adapter, { roles: ["REVIEWER"] });
    expect(receipt.roleResults.REVIEWER?.status).toBe("QUALIFIED");
    expect(receipt.roleResults.REVIEWER?.testCases).toHaveLength(8);
    expect(receipt.metadata).toMatchObject({ requests: 8, roleProtocolVersions: { REVIEWER: "REVIEWER_PROTOCOL_V4" } });
    for (const caze of [fixed, buggy]) {
      const request = adapter.requests.find((r) => r.messages.some((m) => m.content.includes(caze.workspaceSnapshot!)))!;
      expect(request.messages[0]!.content).toBe(`${ROLE_PROMPTS.reviewer.systemPromptTemplate}\n${REVIEWER_CLEAN_DIFF_INSTRUCTION}`);
      expect(request.messages[1]!.content).toBe(`Goal:\n${caze.intent}\n\n${formatUntrustedData(caze.workspaceSnapshot!, "workspace review snapshot")}`);
      expect(request.tools).toBeUndefined();
    }
  });

  it("does not qualify a reviewer that mistakes the removed base for current source", async () => {
    const receipt = await runRoleOnlyQualification(model, scripted("base"), { roles: ["REVIEWER"] });
    expect(receipt.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
    expect(receipt.roleResults.REVIEWER?.testCases.filter((caze) => caze.caseId.startsWith("reviewer.boundary_")).every((caze) => !caze.passed)).toBe(true);
    expect(receipt.roleResults.REVIEWER?.hardFailures).toContain(buggy.caseId);
  });

  it("keeps both planted bugs disqualifying even when seven of eight cases pass", async () => {
    const receipt = await runRoleOnlyQualification(model, scripted("approve-regression"), { roles: ["REVIEWER"] });
    expect(REVIEWER_PROTOCOL.acceptance).toBe(0.75);
    expect(REVIEWER_PROTOCOL.disqualifyingFailures).toContain("reviewer.one_bug");
    expect(receipt.roleResults.REVIEWER?.testCases.filter((caze) => caze.passed)).toHaveLength(7);
    expect(receipt.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
  });
});
