import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamEvent } from "@codeforge/providers";
import { runCompactQualification, type CompactQualificationAdapter } from "../src/qualification/compact.js";
import type { FreeModelRecord } from "../src/qualification/types.js";

const MODEL: FreeModelRecord = {
  providerId: "openrouter",
  modelId: "vendor/model:free",
  displayName: "Model",
  freeStatus: "verified_free",
  capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
  costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "test" },
  isRemote: true,
  isCloudHosted: true,
};

type Script = (req: ChatRequest, call: number) => StreamEvent[] | Error;

function adapter(script: Script): CompactQualificationAdapter & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    providerId: "openrouter",
    calls,
    async *streamChat(req) {
      calls.push(req);
      const out = script(req, calls.length);
      if (out instanceof Error) throw out;
      for (const ev of out) yield ev;
    },
  };
}

const toolCall = (name: string, args: Record<string, unknown>): StreamEvent[] => [
  { type: "tool_call_started", toolCallId: "c1", toolName: name },
  { type: "tool_call_completed", toolCallId: "c1", toolName: name, arguments: JSON.stringify(args) },
  { type: "finish", finishReason: "tool_calls" },
];
const text = (t: string): StreamEvent[] => [{ type: "text_delta", delta: t }, { type: "finish", finishReason: "stop" }];

describe("compact qualification suite", () => {
  it("qualifies a model that reads first, then edits exactly, and answers JSON inside prose", async () => {
    const a = adapter((req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === "user" && /report what it exports/.test(last.content)) return toolCall("read_file", { path: "src/calc.ts" });
      if (last.role === "user" && /has a bug/.test(last.content)) return toolCall("read_file", { path: "src/calc.ts" });
      if (last.role === "tool") return toolCall("edit_file", { path: "src/calc.ts", oldText: "  return a - b;", newText: "  return a + b;" });
      if (/JSON only/.test(req.messages[0]!.content)) return text('Sure, here it is:\n```json\n{"files":["src/calc.ts","test/calc.test.ts"],"verified":true}\n```');
      return text("?");
    });
    const receipt = await runCompactQualification(MODEL, a, { timeoutMs: 1000 });
    expect(receipt.qualificationState).toBe("QUALIFIED");
    expect(receipt.hardFailureRoles).toEqual([]);
    expect(receipt.metadata?.transient).toBe(false);
    // tool probe 1 + edit (read + edit) 2 + structured 1 = 4 requests, no retries.
    expect(a.calls.length).toBe(4);
    expect(receipt.roleResults.CODER?.status).toBe("QUALIFIED");
    expect(receipt.roleResults.ANALYST?.status).toBe("QUALIFIED");
  });

  it("retries a clean miss once and disqualifies after two misses", async () => {
    const a = adapter(() => text("I would open the file but I will not call a tool."));
    const receipt = await runCompactQualification(MODEL, a, { timeoutMs: 1000 });
    expect(receipt.qualificationState).toBe("NOT_QUALIFIED");
    // tool probe: 2 attempts; edit probe: 2 attempts (each 1 call since no tool call); structured: 1.
    expect(a.calls.length).toBe(5);
    expect(receipt.metadata?.transient).toBe(false);
  });

  it("keeps a rate-limited suite inconclusive (transient) instead of scoring the model", async () => {
    const a = adapter(() => new Error("OpenRouter error (429): temporarily rate-limited upstream"));
    const receipt = await runCompactQualification(MODEL, a, { timeoutMs: 1000 });
    expect(receipt.metadata?.transient).toBe(true);
    expect(a.calls.length).toBe(1);
  });

  it("marks a tool-protocol rejection as a hard failure", async () => {
    const a = adapter((req) => (req.tools ? new Error("provider error (400): tools are not supported for this model") : text("{}")));
    const receipt = await runCompactQualification(MODEL, a, { timeoutMs: 1000 });
    expect(receipt.qualificationState).toBe("HARD_FAILURE");
    expect(receipt.hardFailureRoles).toContain("CODER");
  });
});
