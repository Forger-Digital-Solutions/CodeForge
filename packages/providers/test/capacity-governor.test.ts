import { describe, it, expect, vi } from "vitest";
import {
  ProviderCapacityGovernor,
  ProviderError,
  type ProviderAdapter,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
} from "../src/index.js";

function createMockClock(initialTime = 1_000_000) {
  let currentTime = initialTime;
  const sleepers: Array<{ wakeAt: number; resolve: () => void }> = [];

  const now = () => currentTime;

  const sleep = (ms: number, signal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      const wakeAt = currentTime + ms;
      const entry = { wakeAt, resolve };
      sleepers.push(entry);

      signal?.addEventListener("abort", () => {
        const idx = sleepers.indexOf(entry);
        if (idx !== -1) sleepers.splice(idx, 1);
        reject(signal.reason ?? new Error("Aborted"));
      });
    });
  };

  const advanceTime = async (ms: number) => {
    currentTime += ms;
    // Wake any eligible sleepers in order
    sleepers.sort((a, b) => a.wakeAt - b.wakeAt);
    while (sleepers.length > 0 && sleepers[0]!.wakeAt <= currentTime) {
      const next = sleepers.shift()!;
      next.resolve();
      // Allow microtasks to run
      await new Promise((r) => setImmediate(r));
    }
  };

  return { now, sleep, advanceTime, getCurrentTime: () => currentTime };
}

describe("ProviderCapacityGovernor — evidence-driven capacity control", () => {
  it("uses a conservative OpenRouter fallback below the observed 15 RPM free-route limit", () => {
    const governor = new ProviderCapacityGovernor();

    expect(governor.getEffectiveLimits("openrouter")).toEqual({
      maxTokensPerMinute: 60000,
      maxRequestsPerMinute: 14,
      maxConcurrent: 1,
    });
  });

  it("1. tracks token consumption and prunes history after sliding 60-second window", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: { groq: { maxTokensPerMinute: 7500, maxRequestsPerMinute: 28, maxConcurrent: 2 } },
    });

    const res1 = await governor.acquire("groq", 2000);
    res1.release(2000);

    let report = governor.getCapacityReport("groq");
    expect(report.tpmUsed).toBe(2000);
    expect(report.rpmUsed).toBe(1);

    // Advance 30 seconds: still in window
    await clock.advanceTime(30_000);
    report = governor.getCapacityReport("groq");
    expect(report.tpmUsed).toBe(2000);

    // Advance another 31 seconds (total 61s): pruned
    await clock.advanceTime(31_000);
    report = governor.getCapacityReport("groq");
    expect(report.tpmUsed).toBe(0);
    expect(report.rpmUsed).toBe(0);
  });

  it("2. queues and delays requests when token consumption exceeds TPM limit until window slides", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: { groq: { maxTokensPerMinute: 5000, maxRequestsPerMinute: 10, maxConcurrent: 5 } },
    });

    // Use 4000 tokens out of 5000
    const res1 = await governor.acquire("groq", 4000);
    res1.release(4000);

    // Second request needs 2000 tokens (4000 + 2000 = 6000 > 5000) -> must wait
    let acquired = false;
    const acquirePromise = governor.acquire("groq", 2000).then((res) => {
      acquired = true;
      res.release(2000);
    });

    // Let any immediate promises resolve
    await new Promise((r) => setImmediate(r));
    expect(acquired).toBe(false);

    // Advance clock 61 seconds so res1 falls out of the sliding window
    await clock.advanceTime(61_000);
    await acquirePromise;
    expect(acquired).toBe(true);
  });

  it("3. limits active concurrency and admits queued requests as slots release", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: { groq: { maxTokensPerMinute: 20000, maxRequestsPerMinute: 20, maxConcurrent: 2 } },
    });

    const res1 = await governor.acquire("groq", 1000);
    const res2 = await governor.acquire("groq", 1000);
    expect(governor.getCapacityReport("groq").activeConcurrent).toBe(2);

    let res3Acquired = false;
    let res3Ref: any = null;
    const acquire3 = governor.acquire("groq", 1000).then((res) => {
      res3Acquired = true;
      res3Ref = res;
    });

    await new Promise((r) => setImmediate(r));
    expect(res3Acquired).toBe(false);

    // Release res1 -> frees a slot
    res1.release(1000);
    await clock.advanceTime(60);
    await acquire3;

    expect(res3Acquired).toBe(true);
    expect(governor.getCapacityReport("groq").activeConcurrent).toBe(2);
    res2.release(1000);
    res3Ref.release(1000);
    expect(governor.getCapacityReport("groq").activeConcurrent).toBe(0);
  });

  it("4. enters dynamic cooldown on 429 Retry-After response and pauses subsequent requests", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
    });

    // Upstream returns 429 with Retry-After: 5
    governor.recordResponse("groq", 429, { "retry-after": "5" });

    let report = governor.getCapacityReport("groq");
    expect(report.isCoolingDown).toBe(true);
    expect(report.cooldownRemainingMs).toBe(5000);

    let acquired = false;
    const p = governor.acquire("groq", 1000).then((res) => {
      acquired = true;
      res.release(1000);
    });

    await new Promise((r) => setImmediate(r));
    expect(acquired).toBe(false);

    // Advance 3s (still 2s remaining)
    await clock.advanceTime(3000);
    expect(acquired).toBe(false);

    // Advance another 2.1s -> cooldown over, request proceeds
    await clock.advanceTime(2100);
    await p;
    expect(acquired).toBe(true);
    expect(governor.getCapacityReport("groq").isCoolingDown).toBe(false);
  });

  it("5. parses x-ratelimit-reset-tokens and updates observed quota evidence", () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now });

    governor.recordResponse("groq", 200, {
      "x-ratelimit-remaining-tokens": "3500",
      "x-ratelimit-reset-tokens": "2.5s",
      "x-ratelimit-remaining-requests": "15",
      "x-ratelimit-reset-requests": "12s",
    });

    const report = governor.getCapacityReport("groq");
    expect(report.observedQuota?.remainingTokens).toBe(3500);
    expect(report.observedQuota?.resetTokensMs).toBe(2500);
    expect(report.observedQuota?.remainingRequests).toBe(15);
    expect(report.observedQuota?.resetRequestsMs).toBe(12000);
  });

  it("6. supports AbortSignal cancellation during queue wait without leaking in-flight tokens", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: { groq: { maxTokensPerMinute: 2000, maxRequestsPerMinute: 10, maxConcurrent: 1 } },
    });

    const res1 = await governor.acquire("groq", 1000);
    const controller = new AbortController();

    const queuedPromise = governor.acquire("groq", 1000, controller.signal);
    controller.abort(new Error("Subagent cancelled"));

    await expect(queuedPromise).rejects.toThrow("Subagent cancelled");

    // Governor state should not have phantom in-flight tokens or concurrent requests from aborted acquire
    res1.release(1000);
    const report = governor.getCapacityReport("groq");
    expect(report.activeConcurrent).toBe(0);
    expect(report.inFlightTokens).toBe(0);
  });

  it("7. multi-provider isolation: throttling one provider does not throttle another", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: {
        groq: { maxTokensPerMinute: 2000, maxRequestsPerMinute: 2, maxConcurrent: 1 },
        zai: { maxTokensPerMinute: 50000, maxRequestsPerMinute: 50, maxConcurrent: 4 },
      },
    });

    // Saturate groq
    const groqRes = await governor.acquire("groq", 2000);
    governor.recordResponse("groq", 429, { "retry-after": "10" });

    // Z.AI should proceed immediately without delay
    let zaiAcquired = false;
    const zaiPromise = governor.acquire("zai", 2000).then((res) => {
      zaiAcquired = true;
      res.release(2000);
    });

    await zaiPromise;
    expect(zaiAcquired).toBe(true);

    groqRes.release(2000);
  });

  it("8. reconciles estimated in-flight tokens with actual tokens on release", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now });

    const res = await governor.acquire("groq", 2500);
    expect(governor.getCapacityReport("groq").inFlightTokens).toBe(2500);

    // Actual usage was only 1200 tokens
    res.release(1200);
    const report = governor.getCapacityReport("groq");
    expect(report.inFlightTokens).toBe(0);
    expect(report.tpmUsed).toBe(1200);
  });

  it("9. burst smoothing: paces rapid sequential requests under RPM limits", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: { groq: { maxTokensPerMinute: 50000, maxRequestsPerMinute: 2, maxConcurrent: 5 } },
    });

    const r1 = await governor.acquire("groq", 500);
    r1.release(500);
    const r2 = await governor.acquire("groq", 500);
    r2.release(500);

    // 3rd request reaches RPM limit (2 reqs in window) -> must wait
    let r3Done = false;
    const r3 = governor.acquire("groq", 500).then((res) => {
      r3Done = true;
      res.release(500);
    });

    await new Promise((r) => setImmediate(r));
    expect(r3Done).toBe(false);

    await clock.advanceTime(61_000);
    await r3;
    expect(r3Done).toBe(true);
  });

  it("10. GovernedProviderAdapter decorator paces calls and records token usage transparently", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now });

    const innerAdapter: ProviderAdapter = {
      providerId: "groq",
      listModels: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue({ status: "healthy" }),
      chat: vi.fn().mockResolvedValue({
        id: "chat-1",
        model: "openai/gpt-oss-120b",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finishReason: "stop" }],
        usage: { inputTokens: 400, outputTokens: 50, totalTokens: 450 },
      } as ChatResponse),
      streamChat: vi.fn(),
    };

    const governed = governor.wrapAdapter(innerAdapter);
    expect(governed.providerId).toBe("groq");

    const req: ChatRequest = {
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
    };

    const res = await governed.chat(req);
    expect(res.choices[0]!.message.content).toBe("hello");

    const report = governor.getCapacityReport("groq");
    expect(report.tpmUsed).toBe(450);
    expect(report.rpmUsed).toBe(1);
    expect(report.activeConcurrent).toBe(0);
  });

  it("11. rejects requests with [PROVIDER_CAPACITY_EXCEEDED] when maxQueueDepth is exceeded", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      maxQueueDepth: 1,
      limits: { groq: { maxTokensPerMinute: 50000, maxRequestsPerMinute: 50, maxConcurrent: 1 } },
    });

    // Acquire slot 1
    const res1 = await governor.acquire("groq", 1000);

    // Acquire slot 2: goes into queue (depth 1)
    let res2Acquired = false;
    const p2 = governor.acquire("groq", 1000).then((r) => {
      res2Acquired = true;
      r.release(1000);
    });

    await new Promise((r) => setImmediate(r));
    expect(res2Acquired).toBe(false);
    expect(governor.getCapacityReport("groq").queueDepth).toBe(1);

    // Acquire slot 3: exceeds maxQueueDepth = 1 -> immediately rejected
    await expect(governor.acquire("groq", 1000)).rejects.toThrow(
      /\[PROVIDER_CAPACITY_EXCEEDED\] Provider 'groq' queue depth limit \(1\) exceeded/,
    );

    // When res1 finishes, p2 is admitted and queue depth drops back to 0
    res1.release(1000);
    await clock.advanceTime(60);
    await p2;
    expect(res2Acquired).toBe(true);
    expect(governor.getCapacityReport("groq").queueDepth).toBe(0);
  });

  it("12. tracks queueDepth accurately during queueing, admission, and cancellation", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({
      now: clock.now,
      sleep: clock.sleep,
      limits: { groq: { maxTokensPerMinute: 50000, maxRequestsPerMinute: 50, maxConcurrent: 1 } },
    });

    const res1 = await governor.acquire("groq", 1000);
    const controller = new AbortController();

    // Enqueue 2 requests
    const p2 = governor.acquire("groq", 1000);
    const p3 = governor.acquire("groq", 1000, controller.signal);

    await new Promise((r) => setImmediate(r));
    expect(governor.getCapacityReport("groq").queueDepth).toBe(2);

    // Abort p3 -> queueDepth decrements to 1
    controller.abort(new Error("Canceled"));
    await expect(p3).rejects.toThrow("Canceled");
    expect(governor.getCapacityReport("groq").queueDepth).toBe(1);

    // Release res1 -> p2 admitted, queueDepth becomes 0
    res1.release(1000);
    await clock.advanceTime(60);
    const res2 = await p2;
    expect(governor.getCapacityReport("groq").queueDepth).toBe(0);
    res2.release(1000);
  });

  it("13. reports isCoolingDown correctly during dynamic rate-limit cooldown", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now });

    expect(governor.isCoolingDown("groq")).toBe(false);

    governor.recordResponse("groq", 429, { "retry-after": "10" });
    expect(governor.isCoolingDown("groq")).toBe(true);

    await clock.advanceTime(9900);
    expect(governor.isCoolingDown("groq")).toBe(true);

    await clock.advanceTime(200);
    expect(governor.isCoolingDown("groq")).toBe(false);
  });

  it("preserves an exception-carried retry horizon instead of replacing it with a five-second guess", () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now });
    governor.recordRateLimit("openrouter", clock.getCurrentTime() + 3 * 60 * 60_000);

    expect(governor.getCapacityReport("openrouter").cooldownRemainingMs).toBe(3 * 60 * 60_000);
  });

  it("14. GovernedProviderAdapter.chat records a 429 ProviderError into cooldown (previously silently dropped)", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now, sleep: clock.sleep });

    const innerAdapter: ProviderAdapter = {
      providerId: "openrouter",
      listModels: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue({ status: "healthy" }),
      chat: vi.fn().mockRejectedValue(new ProviderError("rate limited", "RATE_LIMITED", true, { status: 429, retryAfter: clock.getCurrentTime() + 7_000 })),
      streamChat: vi.fn(),
    };

    const governed = governor.wrapAdapter(innerAdapter);
    expect(governor.isCoolingDown("openrouter")).toBe(false);

    await expect(governed.chat({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("rate limited");

    // Before this fix, GovernedProviderAdapter.chat's catch block only released the
    // reservation and rethrew — the governor never learned a 429 happened at all.
    expect(governor.isCoolingDown("openrouter")).toBe(true);
    expect(governor.getCapacityReport("openrouter").cooldownRemainingMs).toBe(7_000);
    // No phantom in-flight state left behind by the failed call.
    expect(governor.getCapacityReport("openrouter").activeConcurrent).toBe(0);
  });

  it("15. GovernedProviderAdapter.streamChat records an in-band 429 error event into cooldown", async () => {
    const clock = createMockClock();
    const governor = new ProviderCapacityGovernor({ now: clock.now, sleep: clock.sleep });

    async function* rateLimitedStream(): AsyncIterable<StreamEvent> {
      yield { type: "error", code: "429", message: "rate limited", retryable: true, status: 429, retryAfter: clock.getCurrentTime() + 9_000 };
    }

    const innerAdapter: ProviderAdapter = {
      providerId: "openrouter",
      listModels: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue({ status: "healthy" }),
      chat: vi.fn(),
      streamChat: vi.fn().mockImplementation(() => rateLimitedStream()),
    };

    const governed = governor.wrapAdapter(innerAdapter);
    const events: StreamEvent[] = [];
    for await (const event of governed.streamChat({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(governor.isCoolingDown("openrouter")).toBe(true);
    expect(governor.getCapacityReport("openrouter").cooldownRemainingMs).toBe(9_000);
  });
});
