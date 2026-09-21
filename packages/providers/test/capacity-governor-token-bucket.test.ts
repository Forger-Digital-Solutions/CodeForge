import { describe, expect, it } from "vitest";
import { ProviderCapacityGovernor, estimatePromptOnlyTokens } from "../src/capacity-governor.js";
import { createGroqAdapter } from "../src/provider-factory.js";
import type { ChatRequest } from "../src/chat-types.js";

/**
 * R23 — evidence-driven pacing. Live measurements on Groq (2026-09-21, gpt-oss-120b, 8 000 TPM):
 *  - the per-minute token bucket refills continuously (`x-ratelimit-reset-tokens` = time to full);
 *  - admission checks that the PROMPT fits the remaining bucket — a 2 566-token prompt sent with
 *    `max_tokens 4096` was accepted at 5 170 remaining (max_tokens is not reserved);
 *  - a 3 253-token request was rejected with 429 by Qwen's tokenizer counting it at 4 700.
 * Before this, the governor used only a 60 s sliding window with a 4 096-token completion
 * reservation: one ~3.3K call per minute, 10–18 minutes per small task.
 */
function governorWith(clock: { t: number }, slept: number[]): ProviderCapacityGovernor {
  return new ProviderCapacityGovernor({
    now: () => clock.t,
    sleep: async (ms) => { slept.push(ms); clock.t += ms; },
    limits: { groq: { maxTokensPerMinute: 7500, maxRequestsPerMinute: 28, maxConcurrent: 2 } },
  });
}

const groqHeaders = (remaining: number, resetSeconds: number) => ({
  "x-ratelimit-limit-tokens": "8000",
  "x-ratelimit-remaining-tokens": String(remaining),
  "x-ratelimit-reset-tokens": `${resetSeconds}s`,
  "x-ratelimit-limit-requests": "1000",
  "x-ratelimit-remaining-requests": "990",
  "x-ratelimit-reset-requests": "14m0s",
});

describe("capacity governor — header-derived token bucket (Groq)", () => {
  it("admits when the prompt fits the projected bucket even though the sliding window is full", async () => {
    const clock = { t: 1_000_000 }; const slept: number[] = [];
    const governor = governorWith(clock, slept);
    // Two 3.3K calls already sit in the 60 s window (6.6K of 7.5K); the old rule would wait ~60 s.
    const a = await governor.acquire("groq", 3300, undefined, { promptTokens: 3000 }); a.release(3300, 3253);
    const b = await governor.acquire("groq", 3300, undefined, { promptTokens: 3000 }); b.release(3300, 3253);
    // Provider says: 5 170 remaining, full again in 21.2 s (the live A→B measurement).
    governor.recordResponse("groq", 200, groqHeaders(5170, 21.225));
    slept.length = 0;
    const c = await governor.acquire("groq", 3300, undefined, { promptTokens: 2566 });
    expect(slept).toEqual([]);
    c.release(2651, 2566);
  });

  it("waits exactly the refill time when the prompt does not fit, never a fixed minute", async () => {
    const clock = { t: 2_000_000 }; const slept: number[] = [];
    const governor = governorWith(clock, slept);
    // 1 098 remaining after two back-to-back calls (live measurement), 8 000 limit, ~52 s to full.
    governor.recordResponse("groq", 200, groqHeaders(1098, 51.8));
    await governor.acquire("groq", 3300, undefined, { promptTokens: 2566 });
    // need = 2566 × 1.15 = 2951; refill ≈ 6902/51.8 s ≈ 133 tok/s → ~14 s, not 60 s.
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(10_000);
    expect(slept[0]).toBeLessThan(20_000);
  });

  it("falls back to the sliding window when headers are stale or absent", async () => {
    const clock = { t: 3_000_000 }; const slept: number[] = [];
    const governor = governorWith(clock, slept);
    governor.recordResponse("groq", 200, groqHeaders(8000, 0));
    clock.t += 120_000; // observation is now stale
    const a = await governor.acquire("groq", 5000, undefined, { promptTokens: 3000 }); a.release(5000, 3000);
    const b = await governor.acquire("groq", 5000, undefined, { promptTokens: 3000 });
    // 5 000 in the window + 5 000 estimate > 7 500 → the legacy window wait (≈ 60 s) applies.
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThanOrEqual(50_000);
    b.release(5000, 3000);
  });

  it("learns the provider's tokenizer ratio from reported prompt tokens and widens the margin", async () => {
    const clock = { t: 4_000_000 }; const slept: number[] = [];
    const governor = governorWith(clock, slept);
    // Qwen on Groq counted a 2 600-estimate prompt as 4 700 tokens (ratio 1.8).
    const a = await governor.acquire("groq", 3300, undefined, { promptTokens: 2600 }); a.release(4726, 4700);
    governor.recordResponse("groq", 200, groqHeaders(3742, 32));
    await governor.acquire("groq", 3300, undefined, { promptTokens: 2600 });
    // need = 2600 × (1.8 × 1.1) ≈ 5 148 > 3 742 projected → must wait; with the constant 1.15
    // margin it would have been admitted straight into the 429 the live probe hit.
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(5_000);
  });

  it("lets an impossible prompt through so the provider's own 4xx is what the caller sees", async () => {
    const clock = { t: 5_000_000 }; const slept: number[] = [];
    const governor = governorWith(clock, slept);
    governor.recordResponse("groq", 200, groqHeaders(8000, 0));
    await governor.acquire("groq", 12_000, undefined, { promptTokens: 10_000 });
    expect(slept).toEqual([]);
  });

  it("estimates the prompt from system, messages, tool-call arguments and tool schemas", () => {
    const req: ChatRequest = {
      model: "m",
      system: "x".repeat(400),
      messages: [
        { role: "user", content: "y".repeat(400) },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a".repeat(80) }) } }] },
        { role: "tool", content: "z".repeat(4000), toolCallId: "c1" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "d".repeat(200), parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    };
    const estimate = estimatePromptOnlyTokens(req);
    expect(estimate).toBeGreaterThan((400 + 400 + 4000 + 200) / 4);
    expect(estimate).toBeLessThan(2000);
  });

  it("factory-built adapters feed their headers to the shared governor (production wiring)", async () => {
    const seen: string[] = [];
    const fetchFn = (async () => new Response(JSON.stringify({ id: "1", model: "openai/gpt-oss-120b", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2566, completion_tokens: 85, total_tokens: 2651 } }), { status: 200, headers: groqHeaders(5170, 21.225) })) as unknown as typeof fetch;
    const adapter = createGroqAdapter({ apiKey: "k", fetchFn, onResponse: (obs) => { seen.push(`${obs.providerId}:${obs.status}`); } });
    await adapter.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });
    expect(seen).toEqual(["groq:200"]);
    const { defaultCapacityGovernor } = await import("../src/capacity-governor.js");
    expect(defaultCapacityGovernor.getCapacityReport("groq").observedQuota?.limitTokens).toBe(8000);
    expect(defaultCapacityGovernor.getCapacityReport("groq").observedQuota?.remainingTokens).toBe(5170);
  });
});
