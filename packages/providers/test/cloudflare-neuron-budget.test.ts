import { describe, expect, it } from "vitest";
import {
  CloudflareNeuronBudgetError,
  CloudflareNeuronBudgetGuard,
  FileCloudflareNeuronBudgetStore,
  InMemoryCloudflareNeuronBudgetStore,
  OpenAICompatibleAdapter,
  StaticCloudflareUsageSource,
  type CloudflareNeuronRate,
} from "../src/index.js";
import type { ChatResponse } from "../src/chat-types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const NOW = new Date("2026-09-16T15:00:00.000Z");
const request = {
  model: "@cf/openai/gpt-oss-20b",
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 1,
};

function response(usage?: ChatResponse["usage"]): Response {
  return new Response(JSON.stringify({
    id: "cf-test",
    model: request.model,
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: usage ? { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens } : undefined,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function testRate(outputNeuronsPerMillion: number): Readonly<Record<string, CloudflareNeuronRate>> {
  return { [request.model]: { inputNeuronsPerMillion: 0, outputNeuronsPerMillion } };
}

describe("Cloudflare Workers AI neuron budget guard", () => {
  it("blocks when account usage is unknown before constructing an inference request", async () => {
    let fetchCalls = 0;
    const adapter = new OpenAICompatibleAdapter({
      providerId: "cloudflare-workers-ai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "token",
      fetchFn: (async () => { fetchCalls++; return response(); }) as typeof fetch,
      cloudflareNeuronGuard: new CloudflareNeuronBudgetGuard({
        store: new InMemoryCloudflareNeuronBudgetStore(),
        usageSource: { read: async () => undefined },
        now: () => NOW,
      }),
    });

    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "CLOUDFLARE_USAGE_UNKNOWN" });
    expect(fetchCalls).toBe(0);
  });

  it("blocks an account already above the conservative 8k ceiling", async () => {
    let fetchCalls = 0;
    const adapter = new OpenAICompatibleAdapter({
      providerId: "cloudflare-workers-ai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "token",
      fetchFn: (async () => { fetchCalls++; return response(); }) as typeof fetch,
      cloudflareNeuronGuard: new CloudflareNeuronBudgetGuard({
        store: new InMemoryCloudflareNeuronBudgetStore(),
        usageSource: new StaticCloudflareUsageSource({ utcDay: "2026-09-16", usedNeurons: 8_470, source: "account-dashboard", observedAt: NOW.toISOString() }),
        now: () => NOW,
      }),
    });

    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "CLOUDFLARE_DAILY_SAFE_BUDGET_EXHAUSTED" });
    expect(fetchCalls).toBe(0);
  });

  it("reserves before send and settles using provider usage", async () => {
    const store = new InMemoryCloudflareNeuronBudgetStore();
    const adapter = new OpenAICompatibleAdapter({
      providerId: "cloudflare-workers-ai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "token",
      fetchFn: (async () => response({ inputTokens: 0, outputTokens: 1 })) as typeof fetch,
      cloudflareNeuronGuard: new CloudflareNeuronBudgetGuard({
        store,
        usageSource: new StaticCloudflareUsageSource({ utcDay: "2026-09-16", usedNeurons: 0, source: "provider-api", observedAt: NOW.toISOString() }),
        now: () => NOW,
        rates: testRate(1_000_000),
      }),
    });

    await adapter.chat(request);
    expect(store.snapshot("2026-09-16")).toMatchObject({ observedUsedNeurons: 0, committedNeurons: 1, reservedNeurons: 0 });
  });

  it("admits only one concurrent request when the remaining ceiling fits one estimate", async () => {
    let fetchCalls = 0;
    const store = new InMemoryCloudflareNeuronBudgetStore();
    const guard = new CloudflareNeuronBudgetGuard({
      store,
      usageSource: new StaticCloudflareUsageSource({ utcDay: "2026-09-16", usedNeurons: 0, source: "provider-api", observedAt: NOW.toISOString() }),
      now: () => NOW,
      safeDailyCeiling: 1,
      rates: testRate(1_000_000),
    });
    const adapter = new OpenAICompatibleAdapter({
      providerId: "cloudflare-workers-ai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "token",
      fetchFn: (async () => { fetchCalls++; return response({ inputTokens: 0, outputTokens: 1 }); }) as typeof fetch,
      cloudflareNeuronGuard: guard,
    });

    const results = await Promise.allSettled([adapter.chat(request), adapter.chat(request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CLOUDFLARE_DAILY_SAFE_BUDGET_EXHAUSTED" } });
    expect(fetchCalls).toBe(1);
  });

  it("starts a fresh budget on the next UTC day", async () => {
    let now = new Date("2026-09-16T23:59:00.000Z");
    const source = { read: async (utcDay: string) => ({ utcDay, usedNeurons: 0, source: "provider-api" as const, observedAt: now.toISOString() }) };
    const store = new InMemoryCloudflareNeuronBudgetStore();
    const guard = new CloudflareNeuronBudgetGuard({ store, usageSource: source, now: () => now, safeDailyCeiling: 1, rates: testRate(1_000_000) });

    const first = await guard.reserve(request);
    await first.settleUsage({ inputTokens: 0, outputTokens: 1 });
    now = new Date("2026-09-17T00:01:00.000Z");
    const second = await guard.reserve(request);
    expect(second.estimatedNeurons).toBe(1);
  });

  it("keeps a file-backed reservation durable across store instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codeforge-cf-budget-"));
    const filePath = path.join(dir, "neurons.json");
    try {
      const first = new FileCloudflareNeuronBudgetStore(filePath);
      const reservation = await first.reserve({ requestId: "request-1", utcDay: "2026-09-16", observedUsedNeurons: 0, estimatedNeurons: 1, ceilingNeurons: 2 });
      await first.settle({ reservationId: reservation.reservationId, actualNeurons: 1 });
      const second = new FileCloudflareNeuronBudgetStore(filePath);
      await expect(second.reserve({ requestId: "request-2", utcDay: "2026-09-16", observedUsedNeurons: 0, estimatedNeurons: 2, ceilingNeurons: 2 })).rejects.toMatchObject({ code: "CLOUDFLARE_DAILY_SAFE_BUDGET_EXHAUSTED" });
      expect(JSON.parse(await readFile(filePath, "utf8")).committedNeurons).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for unknown model pricing and missing output bounds", async () => {
    const guard = new CloudflareNeuronBudgetGuard({
      store: new InMemoryCloudflareNeuronBudgetStore(),
      usageSource: new StaticCloudflareUsageSource({ utcDay: "2026-09-16", usedNeurons: 0, source: "provider-api", observedAt: NOW.toISOString() }),
      now: () => NOW,
    });
    await expect(guard.reserve({ ...request, model: "@cf/unknown/model" })).rejects.toMatchObject({ code: "CLOUDFLARE_NEURON_ESTIMATE_UNKNOWN" });
    await expect(guard.reserve({ ...request, maxTokens: undefined })).rejects.toMatchObject({ code: "CLOUDFLARE_OUTPUT_BOUND_UNKNOWN" });
    expect(guard).toBeInstanceOf(CloudflareNeuronBudgetGuard);
    expect(new CloudflareNeuronBudgetError("CLOUDFLARE_USAGE_UNKNOWN", "test").message).toContain("CLOUDFLARE_USAGE_UNKNOWN");
  });
});
