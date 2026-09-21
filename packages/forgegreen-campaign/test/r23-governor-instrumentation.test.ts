import { describe, expect, it } from "vitest";
import { ProviderCapacityGovernor } from "@codeforge/providers";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamEvent } from "@codeforge/providers";
import { classify, instrumentGovernor } from "../src/r23/run-task.js";

/**
 * R23 harness regression: pacing waits imposed by the capacity governor must be measured as
 * `pacingWaitMs`, including when the runtime paces through `governor.wrapAdapter(provider)`.
 * The Groq qualification rounds of 2026-09-21 recorded `pacingWaitMs: 0` with 60 s gaps between
 * calls because the proxy bound `wrapAdapter` to the raw governor, so the GovernedProviderAdapter
 * called the un-instrumented `acquire`.
 */
class TinyAdapter implements ProviderAdapter {
  readonly providerId = "groq";
  async listModels(): Promise<ProviderModel[]> { return []; }
  async chat(): Promise<ChatResponse> { throw new Error("unused"); }
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "ok" };
    yield { type: "usage", usage: { inputTokens: 3000, outputTokens: 100 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() { return { status: "available" as const }; }
}

describe("R23 instrumented governor", () => {
  it("measures pacing waits taken through wrapAdapter() (the runtime's path)", async () => {
    let clock = 0;
    const slept: number[] = [];
    const governor = new ProviderCapacityGovernor({
      now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms; },
      limits: { groq: { maxTokensPerMinute: 7500, maxRequestsPerMinute: 28, maxConcurrent: 2 } },
    });
    const instrumented = instrumentGovernor(governor, () => clock);
    const governed = instrumented.governor.wrapAdapter(new TinyAdapter());
    const req: ChatRequest = { model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "x".repeat(12_000) }], maxTokens: 4096 };
    const drain = async () => { for await (const _event of governed.streamChat(req)) { /* consume */ } };
    await drain(); // first call admitted immediately: 3 100 actual tokens enter the window
    await drain(); // second call: 3 100 + estimate (≈3 000 + 4 096) > 7 500 → waits for the window
    expect(slept.length).toBeGreaterThan(0);
    expect(instrumented.pacingWaitMs()).toBeGreaterThan(0);
    expect(instrumented.pacingWaitMs()).toBe(slept.reduce((a, b) => a + b, 0));
  });

  it("keeps the proxy transparent for non-acquire methods (this bound to the proxy)", () => {
    const governor = new ProviderCapacityGovernor();
    const instrumented = instrumentGovernor(governor, () => Date.now());
    const wrapped = instrumented.governor.wrapAdapter(new TinyAdapter());
    expect((wrapped as { governor?: unknown }).governor).toBe(instrumented.governor);
    expect(instrumented.governor.getEffectiveLimits("groq").maxTokensPerMinute).toBe(7500);
  });
});

describe("R23 run classification — authority-boundary stops", () => {
  const base = { runtimeStatus: "blocked" as const, stopReason: "error", claimedComplete: false, verifiedComplete: false, completionAuthority: "BLOCKED" as const, forbidden: false, calls: [] as never[], timedOut: false };
  it("labels a TOOL_PERMISSION_DENIED stop security_blocked and states the verifier verdict (four R23 prescreen runs)", () => {
    const verdict = classify({ ...base, verifierPassed: true, runtimeError: "TOOL_PERMISSION_DENIED" });
    expect(verdict.classification).toBe("security_blocked");
    expect(verdict.reason).toContain("TOOL_PERMISSION_DENIED");
    expect(verdict.reason).toContain("hidden verifier passed");
  });
  it("keeps the fall-through for ordinary ended-without-claim runs", () => {
    expect(classify({ ...base, verifierPassed: false, runtimeError: "AGENT_NO_PROGRESS_DETECTED", stopReason: "no_progress_detected" }).classification).toBe("verification_failed");
  });
});
